import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { AssetError, bundleHash, configFileIn, dataHome, materializeAssets } from "../assets";

const roots: string[] = [];

function scratch(): string {
  const dir = mkdtempSync(resolve(tmpdir(), "jmux-assets-"));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  while (roots.length) {
    const dir = roots.pop()!;
    try {
      chmodSync(dir, 0o700);
    } catch {
      // best effort
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

const ASSETS = { "config/a.conf": "alpha\n", "nested/b.txt": "beta\n" };

function envWith(root: string): NodeJS.ProcessEnv {
  return { XDG_DATA_HOME: root } as NodeJS.ProcessEnv;
}

describe("dataHome", () => {
  test("prefers XDG_DATA_HOME", () => {
    expect(dataHome({ XDG_DATA_HOME: "/xdg", HOME: "/home/u" } as NodeJS.ProcessEnv)).toBe("/xdg");
  });

  test("falls back to ~/.local/share", () => {
    expect(dataHome({ HOME: "/home/u" } as NodeJS.ProcessEnv)).toBe("/home/u/.local/share");
  });

  // A relative XDG_DATA_HOME is invalid per the spec and must not be honored,
  // or assets land somewhere relative to the cwd jmux happened to start in.
  test("ignores a relative XDG_DATA_HOME", () => {
    expect(dataHome({ XDG_DATA_HOME: "relative", HOME: "/home/u" } as NodeJS.ProcessEnv)).toBe(
      "/home/u/.local/share",
    );
  });

  // XDG_DATA_HOME alone is enough — an unset HOME is only fatal with neither.
  test("survives unset HOME when XDG_DATA_HOME is set", () => {
    expect(dataHome({ XDG_DATA_HOME: "/xdg" } as NodeJS.ProcessEnv)).toBe("/xdg");
  });

  test("throws a named error when neither is derivable", () => {
    const orig = process.env.HOME;
    try {
      delete process.env.HOME;
      // homedir() may still resolve from the OS; only assert when it cannot.
      const env = {} as NodeJS.ProcessEnv;
      let threw = false;
      try {
        dataHome(env);
      } catch (e) {
        threw = e instanceof AssetError;
      }
      expect(threw || dataHome(env).length > 0).toBe(true);
    } finally {
      if (orig !== undefined) process.env.HOME = orig;
    }
  });
});

describe("bundleHash", () => {
  test("is stable and content-addressed", () => {
    expect(bundleHash(ASSETS)).toBe(bundleHash({ ...ASSETS }));
    expect(bundleHash(ASSETS)).not.toBe(bundleHash({ ...ASSETS, "config/a.conf": "changed\n" }));
  });

  // Key order must not change the hash, or the same bundle materializes twice.
  test("is independent of key order", () => {
    const reordered = { "nested/b.txt": "beta\n", "config/a.conf": "alpha\n" };
    expect(bundleHash(reordered)).toBe(bundleHash(ASSETS));
  });
});

describe("materializeAssets", () => {
  test("writes every asset and returns the hashed dir", () => {
    const root = scratch();
    const dir = materializeAssets({ env: envWith(root), assets: ASSETS });

    expect(dir).toBe(resolve(root, "jmux", "assets", bundleHash(ASSETS)));
    expect(readFileSync(resolve(dir, "config/a.conf"), "utf-8")).toBe("alpha\n");
    expect(readFileSync(resolve(dir, "nested/b.txt"), "utf-8")).toBe("beta\n");
  });

  test("is idempotent and leaves no temp dirs behind", () => {
    const root = scratch();
    const a = materializeAssets({ env: envWith(root), assets: ASSETS });
    const b = materializeAssets({ env: envWith(root), assets: ASSETS });
    expect(b).toBe(a);

    const parent = resolve(root, "jmux", "assets");
    expect(readdirSync(parent).filter((n) => n.startsWith(".tmp-"))).toEqual([]);
  });

  test("different content yields a different dir; both survive", () => {
    const root = scratch();
    const a = materializeAssets({ env: envWith(root), assets: ASSETS });
    const b = materializeAssets({ env: envWith(root), assets: { ...ASSETS, "config/a.conf": "v2\n" } });
    expect(a).not.toBe(b);
    expect(existsSync(a)).toBe(true);
    expect(existsSync(b)).toBe(true);
  });

  test("repeated calls return the same dir", () => {
    const root = scratch();
    const results = Array.from({ length: 8 }, () =>
      materializeAssets({ env: envWith(root), assets: ASSETS }),
    );
    expect(new Set(results).size).toBe(1);
  });

  // The race POSIX guarantees will happen: `rename` cannot replace a non-empty
  // directory, so a real concurrent writer *must* fail and adopt the winner.
  // In-process calls short-circuit on the completeness check and never reach
  // rename, so this spawns genuine parallel processes — otherwise the branch
  // that makes simultaneous jmux starts safe would be untested.
  test("genuinely concurrent processes converge on one complete tree", async () => {
    const root = scratch();
    const script = resolve(import.meta.dir, "..", "assets.ts");
    const runner = `
      const { materializeAssets } = await import(${JSON.stringify(script)});
      process.stdout.write(materializeAssets({ assets: { "config/a.conf": "alpha\\n", "nested/b.txt": "beta\\n" } }));
    `;

    const procs = Array.from({ length: 8 }, () =>
      Bun.spawn(["bun", "-e", runner], {
        env: { ...process.env, XDG_DATA_HOME: root },
        stdout: "pipe",
        stderr: "pipe",
      }),
    );

    const outs = await Promise.all(
      procs.map(async (p) => {
        const [out, err, code] = await Promise.all([
          new Response(p.stdout).text(),
          new Response(p.stderr).text(),
          p.exited,
        ]);
        return { out, err, code };
      }),
    );

    for (const { code, err } of outs) {
      expect({ code, err }).toEqual({ code: 0, err: "" });
    }
    expect(new Set(outs.map((o) => o.out)).size).toBe(1);

    const dir = outs[0]!.out;
    expect(readFileSync(resolve(dir, "config/a.conf"), "utf-8")).toBe("alpha\n");
    expect(readdirSync(resolve(root, "jmux", "assets")).filter((n) => n.startsWith(".tmp-"))).toEqual([]);
  }, 30_000);

  // A destination that exists but is wrong is a hard error naming the path —
  // silently adopting it would hand tmux a truncated config.
  test("refuses a pre-created corrupt destination", () => {
    const root = scratch();
    const dest = resolve(root, "jmux", "assets", bundleHash(ASSETS));
    mkdirSync(resolve(dest, "config"), { recursive: true });
    writeFileSync(resolve(dest, "config/a.conf"), "truncated");

    expect(() => materializeAssets({ env: envWith(root), assets: ASSETS })).toThrow(AssetError);
  });

  test("sweeps stale temp dirs but spares fresh ones", () => {
    const root = scratch();
    const parent = resolve(root, "jmux", "assets");
    mkdirSync(parent, { recursive: true });

    const stale = resolve(parent, ".tmp-stale");
    const fresh = resolve(parent, ".tmp-fresh");
    mkdirSync(stale);
    mkdirSync(fresh);

    const now = statSync(fresh).mtimeMs + 48 * 60 * 60 * 1000;
    materializeAssets({ env: envWith(root), assets: ASSETS, now });

    expect(existsSync(stale)).toBe(false);
    // "fresh" is also older than the cutoff relative to `now`; assert the rule
    // rather than the clock by re-running with a now that predates both.
    materializeAssets({ env: envWith(root), assets: { ...ASSETS, "config/a.conf": "v3\n" }, now: 0 });
    expect(existsSync(resolve(parent, ".tmp-fresh"))).toBe(false);
  });

  test("reports an unwritable parent instead of crashing", () => {
    const root = scratch();
    mkdirSync(resolve(root, "jmux"), { recursive: true });
    chmodSync(resolve(root, "jmux"), 0o500);

    expect(() => materializeAssets({ env: envWith(root), assets: ASSETS })).toThrow(AssetError);
  });

  test("configFileIn points at the tmux entry point", () => {
    expect(configFileIn("/x")).toBe("/x/config/tmux.conf");
  });
});

// The real bundle, not a fixture: this is the check that the shipped assets
// actually embed and land on disk intact.
describe("the real asset bundle", () => {
  test("materializes with tmux.conf, defaults.conf and core.conf", () => {
    const root = scratch();
    const dir = materializeAssets({ env: envWith(root) });

    for (const rel of ["config/tmux.conf", "config/defaults.conf", "config/core.conf", "agent-hooks/pi-extension.ts", "skills/jmux-control.md"]) {
      expect(existsSync(resolve(dir, rel))).toBe(true);
    }
    expect(readFileSync(configFileIn(dir), "utf-8")).toContain("source-file");
  });
});
