import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { materializeAssets, piExtensionIn } from "../assets";
import type { AgentState } from "../types";
import type { AgentIntegration, InstallKind, InstallOutcomeKind } from "./types";

/**
 * pi's integration surface is an in-process extension bus, not shell hooks, so
 * installing means dropping our extension file somewhere stable and adding its
 * path to pi's `settings.extensions` (the persisted form of `pi -e <path>`).
 */

function piSettingsPath(): string {
  return resolve(homedir(), ".pi", "agent", "settings.json");
}

/** Where the shipped extension is copied to. Stable across jmux upgrades. */
export function piExtensionTarget(): string {
  return resolve(
    process.env.XDG_CONFIG_HOME ?? resolve(homedir(), ".config"),
    "jmux",
    "pi-extension.ts",
  );
}

/**
 * The extension source shipped inside jmux.
 *
 * Read from the materialized asset tree rather than `import.meta.dir`, which
 * collapses to `/$bunfs` under `bun build --compile` — `detect()` would have
 * silently reported "none" and `install()` would have thrown, on every binary
 * install.
 */
function piExtensionSource(): string {
  return piExtensionIn(materializeAssets());
}

interface PiSettings {
  extensions?: string[];
  [k: string]: unknown;
}

function readSettings(): PiSettings {
  const path = piSettingsPath();
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf-8")) as PiSettings;
}

function isRegistered(settings: PiSettings): boolean {
  return (settings.extensions ?? []).includes(piExtensionTarget());
}

export const piIntegration: AgentIntegration = {
  id: "pi",
  label: "pi",
  // No `waiting`: pi exposes no permission-request event to extensions, so that
  // state is unobservable rather than merely unimplemented.
  reports: new Set<AgentState>(["running", "complete"]),
  get configPath(): string {
    return piSettingsPath();
  },

  // pi has no shell hooks, so installing means copying the extension out and
  // then registering that path. Two files, one step.
  writeTargets(): string[] {
    return [piSettingsPath(), piExtensionTarget()];
  },

  isPresent(): boolean {
    return existsSync(dirname(piSettingsPath())) || Bun.which("pi") !== null;
  },

  detect(): InstallKind {
    try {
      const registered = isRegistered(readSettings());
      if (!registered) return "none";
      // Registered but the file is gone, or is an older copy: pi would load
      // nothing, or the wrong thing. Either way it needs rewriting.
      if (!existsSync(piExtensionTarget())) return "partial";
      const shipped = readFileSync(piExtensionSource(), "utf-8");
      const installed = readFileSync(piExtensionTarget(), "utf-8");
      return shipped === installed ? "current" : "partial";
    } catch {
      return "none";
    }
  },

  install(): { kind: InstallOutcomeKind; notes: string[] } {
    if (piIntegration.detect() === "current") return { kind: "noop", notes: [] };

    const target = piExtensionTarget();
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(piExtensionSource(), target);

    const settings = readSettings();
    if (!isRegistered(settings)) {
      settings.extensions = [...(settings.extensions ?? []), target];
      mkdirSync(dirname(piSettingsPath()), { recursive: true });
      writeFileSync(piSettingsPath(), JSON.stringify(settings, null, 2) + "\n");
    }

    return {
      kind: "installed",
      notes: [
        "pi reports RUNNING and COMPLETE only — it exposes no permission event,",
        "so jmux never shows WAITING for a pi pane.",
      ],
    };
  },

  uninstall(): { removed: boolean; paths: string[]; notes: string[] } {
    const target = piExtensionTarget();
    const paths: string[] = [];

    // Deregister first: a settings entry pointing at a deleted file makes pi
    // fail to start, so the order matters if only one of the two succeeds.
    try {
      const settings = readSettings();
      const extensions = settings.extensions ?? [];
      if (extensions.includes(target)) {
        settings.extensions = extensions.filter((e) => e !== target);
        if (settings.extensions.length === 0) delete settings.extensions;
        writeFileSync(piSettingsPath(), JSON.stringify(settings, null, 2) + "\n");
        paths.push(`${piSettingsPath()} (jmux extension entry)`);
      }
    } catch {
      return { removed: false, paths: [], notes: ["could not read pi settings — left alone"] };
    }

    if (existsSync(target)) {
      rmSync(target, { force: true });
      paths.push(target);
    }

    return { removed: paths.length > 0, paths, notes: [] };
  },
};
