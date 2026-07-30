import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

// TypeScript has no model for Bun's `with { type: "text" }` import attribute:
// it resolves each specifier on disk and types it as whatever that file is (a
// module, for the pi extension) or fails to resolve it at all (.conf, .md).
// Bun honors the attribute and inlines the file's contents at build time —
// which is precisely what makes the compiled binary possible, since
// `import.meta.dir` collapses to `/$bunfs` under `bun build --compile`.
//
// The suppressions below record that mismatch in one place rather than
// scattering casts, and `asText` is where every asset becomes a string.
// @ts-ignore -- text import attribute
import tmuxConf from "../config/tmux.conf" with { type: "text" };
// @ts-ignore -- text import attribute
import defaultsConf from "../config/defaults.conf" with { type: "text" };
// @ts-ignore -- text import attribute
import coreConf from "../config/core.conf" with { type: "text" };
// @ts-ignore -- text import attribute
import piExtension from "./agent-hooks/pi-extension.ts" with { type: "text" };
// @ts-ignore -- text import attribute
import controlSkill from "../skills/jmux-control.md" with { type: "text" };

function asText(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("embedded asset did not load as text — check the build's text loader");
  }
  return value;
}

/**
 * Asset materialization.
 *
 * `bun build --compile` collapses `import.meta.dir` to `/$bunfs`, and **tmux is
 * a separate process** — it cannot read that path under any circumstances. So
 * embedding the configs is not enough; they must be written to a real
 * filesystem path before tmux is spawned, and `$JMUX_DIR` must point at it.
 *
 * There is deliberately no source-mode fast path. Running from source
 * materializes too, so the path that ships is the path exercised every day
 * rather than one only a CI test ever touches.
 */

/** Relative path → contents. The layout mirrors the repo because `$JMUX_DIR` is used as a root. */
const ASSETS: Record<string, string> = {
  "config/tmux.conf": asText(tmuxConf),
  "config/defaults.conf": asText(defaultsConf),
  "config/core.conf": asText(coreConf),
  "agent-hooks/pi-extension.ts": asText(piExtension),
  "skills/jmux-control.md": asText(controlSkill),
};

/** Temp dirs older than this are assumed to be crash debris and swept. */
const STALE_TEMP_MS = 24 * 60 * 60 * 1000;

export class AssetError extends Error {}

/**
 * `$XDG_DATA_HOME`, else `~/.local/share`.
 *
 * Data rather than cache: XDG says cache may be deleted at any moment, and both
 * `--install-agent-hooks` and `--install-skill` read from here. An unset HOME is
 * survivable as long as XDG_DATA_HOME is set — only having neither is fatal.
 */
export function dataHome(env: NodeJS.ProcessEnv = process.env): string {
  const xdg = env.XDG_DATA_HOME;
  if (xdg && xdg.startsWith("/")) return xdg;
  const home = env.HOME || safeHomedir();
  if (!home) {
    throw new AssetError(
      "Cannot determine where to write jmux's tmux config: neither $XDG_DATA_HOME nor $HOME is set.",
    );
  }
  return resolve(home, ".local", "share");
}

function safeHomedir(): string {
  try {
    return homedir();
  } catch {
    return "";
  }
}

/** Stable hash of the whole bundle. Content-addressed, so it self-invalidates. */
export function bundleHash(assets: Record<string, string> = ASSETS): string {
  const h = createHash("sha256");
  for (const key of Object.keys(assets).sort()) {
    h.update(key);
    h.update("\0");
    h.update(assets[key]!);
    h.update("\0");
  }
  return h.digest("hex").slice(0, 16);
}

function expectedSizes(assets: Record<string, string>): Map<string, number> {
  const sizes = new Map<string, number>();
  for (const [rel, body] of Object.entries(assets)) {
    sizes.set(rel, Buffer.byteLength(body, "utf-8"));
  }
  return sizes;
}

/** Every file present at the expected size. The check the race loser runs. */
function isComplete(dir: string, assets: Record<string, string>): boolean {
  for (const [rel, size] of expectedSizes(assets)) {
    const path = resolve(dir, rel);
    try {
      if (statSync(path).size !== size) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * Remove temp dirs left by a crashed run. Best effort: a sweep failure must
 * never stop jmux from starting.
 */
function sweepStaleTemps(parent: string, now: number): void {
  let entries: string[];
  try {
    entries = readdirSync(parent);
  } catch {
    return;
  }
  for (const name of entries) {
    if (!name.startsWith(".tmp-")) continue;
    const path = resolve(parent, name);
    try {
      if (now - statSync(path).mtimeMs > STALE_TEMP_MS) {
        rmSync(path, { recursive: true, force: true });
      }
    } catch {
      // Another instance may be mid-rename. Leave it alone.
    }
  }
}

export interface MaterializeOptions {
  env?: NodeJS.ProcessEnv;
  assets?: Record<string, string>;
  now?: number;
}

/**
 * Materialize the embedded assets and return the directory to use as
 * `$JMUX_DIR`. Idempotent: an already-complete directory is returned untouched.
 *
 * Concurrency: the temp dir is a sibling of the destination (same filesystem,
 * so `rename` is atomic), and **`ENOTEMPTY`/`EEXIST` is success, not failure**.
 * POSIX `rename` cannot replace a non-empty directory, so the loser of a race
 * necessarily fails — it verifies the winner's tree and adopts it. Treating
 * that as an error would make simultaneous starts flaky for no reason.
 */
export function materializeAssets(opts: MaterializeOptions = {}): string {
  const assets = opts.assets ?? ASSETS;
  const env = opts.env ?? process.env;
  const now = opts.now ?? Date.now();

  const parent = resolve(dataHome(env), "jmux", "assets");
  const dest = resolve(parent, bundleHash(assets));

  if (isComplete(dest, assets)) return dest;

  try {
    mkdirSync(parent, { recursive: true, mode: 0o700 });
  } catch (err) {
    throw new AssetError(`Cannot create ${parent}: ${(err as Error).message}`);
  }

  sweepStaleTemps(parent, now);

  const tmp = mkdtempSync(resolve(parent, ".tmp-"));
  try {
    for (const [rel, body] of Object.entries(assets)) {
      const path = resolve(tmp, rel);
      mkdirSync(resolve(path, ".."), { recursive: true, mode: 0o700 });
      writeFileSync(path, body, { mode: 0o600 });
    }

    try {
      renameSync(tmp, dest);
      return dest;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // Lost the race, or a previous run already put a tree here.
      if (code === "ENOTEMPTY" || code === "EEXIST" || code === "EACCES") {
        if (isComplete(dest, assets)) return dest;
        throw new AssetError(
          `${dest} exists but is incomplete or corrupt. Remove it and restart jmux.`,
        );
      }
      throw new AssetError(`Cannot install jmux's tmux config into ${dest}: ${(err as Error).message}`);
    }
  } finally {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  }
}

/** The tmux entry point inside a materialized tree. */
export function configFileIn(jmuxDir: string): string {
  return resolve(jmuxDir, "config", "tmux.conf");
}

/** The pi extension source inside a materialized tree. */
export function piExtensionIn(jmuxDir: string): string {
  return resolve(jmuxDir, "agent-hooks", "pi-extension.ts");
}

/** The agent skill inside a materialized tree. */
export function skillIn(jmuxDir: string): string {
  return resolve(jmuxDir, "skills", "jmux-control.md");
}

export const ASSET_KEYS = Object.keys(ASSETS);
