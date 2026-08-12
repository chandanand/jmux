import { describe, expect, test, afterAll, beforeAll } from "bun:test";
import { Terminal } from "bun-pty";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// Does the *compiled binary* start?
//
// `boot-smoke.test.ts` covers jmux run from source. That is not the same
// program: `bun build --compile` serves the bundle from a virtual filesystem
// where `import.meta.dir` is `/$bunfs`, and tmux — a separate process — cannot
// read a path there. Every asset therefore has to be materialized onto a real
// filesystem before tmux is spawned, and nothing in the source-mode test
// exercises that.
//
// The second case is the one adversarial review caught: `-f <config>` is
// honored only when tmux *starts* a server. Attaching to a server that is
// already running silently ignores it, so an upgraded jmux can keep using the
// previous version's config forever. Booting only against a fresh server would
// never see it.

const TMUX = Bun.which("tmux");
const SOCKET = `jmux-binary-smoke-${process.pid}`;
const BINARY = join(tmpdir(), `jmux-smoke-${process.pid}`);

function killServer(): void {
  if (!TMUX) return;
  try {
    Bun.spawnSync([TMUX, "-L", SOCKET, "kill-server"], { stdout: "ignore", stderr: "ignore" });
  } catch {}
  try {
    rmSync(join(process.env.TMUX_TMPDIR || `/tmp/tmux-${process.getuid?.() ?? 0}`, SOCKET), {
      force: true,
    });
  } catch {}
}

let compiled = false;

beforeAll(() => {
  const result = Bun.spawnSync(
    ["bun", "build", "--compile", join(import.meta.dir, "..", "main.ts"), "--outfile", BINARY],
    { stdout: "pipe", stderr: "pipe" },
  );
  compiled = result.exitCode === 0;
  if (!compiled) {
    console.error("compile failed:", new TextDecoder().decode(result.stderr));
  }
});

afterAll(() => {
  killServer();
  try {
    rmSync(BINARY, { force: true });
  } catch {}
});

/** Boot the compiled binary under a pty and report whether it survived. */
async function boot(home: string, extraEnv: Record<string, string> = {}) {
  let output = "";
  let exitCode: number | null = null;

  const pty = new Terminal(BINARY, ["--socket", SOCKET], {
    name: "xterm-256color",
    cols: 120,
    rows: 40,
    env: {
      ...process.env,
      HOME: home,
      XDG_DATA_HOME: join(home, ".local", "share"),
      TERM: "xterm-256color",
      JMUX: "",
      TMUX: "",
      TMUX_PANE: "",
      ...extraEnv,
    },
  });
  pty.onData((d: string) => {
    output += d;
  });
  pty.onExit((e: { exitCode: number }) => {
    exitCode = e.exitCode;
  });

  await Bun.sleep(6000);
  const alive = exitCode === null;
  try {
    pty.kill();
  } catch {}
  return { alive, exitCode, output };
}

describe("the compiled binary boots", () => {
  test.skipIf(!TMUX)(
    "reports its version without a runtime",
    () => {
      expect(compiled).toBe(true);
      const out = Bun.spawnSync([BINARY, "--version"], { stdout: "pipe" });
      expect(new TextDecoder().decode(out.stdout)).toContain("jmux");
    },
    30_000,
  );

  test.skipIf(!TMUX)(
    "starts under a real pty and tmux sources the materialized config",
    async () => {
      expect(compiled).toBe(true);
      const home = mkdtempSync(join(tmpdir(), "jmux-binbolt-"));
      killServer();

      const { alive, exitCode, output } = await boot(home);

      // `status off` is set by core.conf and by nothing else, so its presence
      // proves tmux read a real file at a real path — the whole point of
      // materialization.
      //
      // This probe used to be `detach-on-destroy off`, until jmux started
      // writing that one over the control channel too (see
      // DETACH_ON_DESTROY_COMMAND). A probe the program under test sets by a
      // second route cannot fail, so it has to be an option only the file can
      // account for.
      const opt = Bun.spawnSync(
        [TMUX!, "-L", SOCKET, "show-options", "-g", "status"],
        { stdout: "pipe", stderr: "pipe" },
      );
      const sourced = new TextDecoder().decode(opt.stdout).trim();

      killServer();
      rmSync(home, { recursive: true, force: true });

      expect({ alive, exitCode, tail: output.slice(-400) }).toMatchObject({ alive: true });
      expect(output).toContain("\x1b[?1049h");
      expect(sourced).toContain("off");
    },
    60_000,
  );

  test.skipIf(!TMUX)(
    "survives attaching to a server started by a different generation",
    async () => {
      expect(compiled).toBe(true);
      const home = mkdtempSync(join(tmpdir(), "jmux-bingen-"));
      killServer();

      // A server that predates this jmux: started by hand, carrying a stamp
      // from some other asset bundle. This is exactly the state an upgrade
      // leaves behind, and jmux must attach to it and stay up.
      Bun.spawnSync([TMUX!, "-L", SOCKET, "new-session", "-d", "-s", "stale"], {
        stdout: "ignore",
        stderr: "ignore",
      });
      Bun.spawnSync(
        [TMUX!, "-L", SOCKET, "set-option", "-g", "@jmux-config-generation", "deadbeefdeadbeef"],
        { stdout: "ignore", stderr: "ignore" },
      );

      const { alive, exitCode, output } = await boot(home);

      // Having noticed, it restamps — so the next attach is quiet.
      const stamp = Bun.spawnSync(
        [TMUX!, "-L", SOCKET, "show-options", "-gqv", "@jmux-config-generation"],
        { stdout: "pipe", stderr: "pipe" },
      );
      const generation = new TextDecoder().decode(stamp.stdout).trim();

      killServer();
      rmSync(home, { recursive: true, force: true });

      expect({ alive, exitCode, tail: output.slice(-400) }).toMatchObject({ alive: true });
      expect(generation).not.toBe("deadbeefdeadbeef");
      expect(generation.length).toBeGreaterThan(0);
    },
    60_000,
  );
});
