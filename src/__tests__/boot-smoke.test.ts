import { describe, expect, test, afterAll } from "bun:test";
import { Terminal } from "bun-pty";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// Does jmux start?
//
// This is the suite's one integration test, and it earns the exception. Every
// other test here is a pure unit test over a logic module, on purpose — but
// `main.ts` is the one file no unit test can reach: it spawns tmux at import
// time, so nothing can import it, and its ~7000 lines of module-scope wiring
// are therefore covered by nothing at all.
//
// It exists because that gap shipped a bug. A function defined near the top of
// main.ts and *called* at module scope reached a `let` declared 1500 lines
// below it, and died in its temporal dead zone before the first frame. tsc
// can't see it (the access is through a call, not a direct reference), 2300
// unit tests can't see it, and the crash surfaces only as jmux failing to
// start. The assertion is deliberately dumb — after booting, is it still
// alive? — because that is exactly the question no other test asks.
//
// Skipped rather than failed when tmux is missing: this must never be the
// reason a clean checkout can't run its tests.

const TMUX = Bun.which("tmux");
const SOCKET = `jmux-boot-smoke-${process.pid}`;

function killServer(): void {
  if (!TMUX) return;
  try {
    Bun.spawnSync([TMUX, "-L", SOCKET, "kill-server"], { stdout: "ignore", stderr: "ignore" });
  } catch {}
  // kill-server leaves the socket file behind when the server is already gone,
  // and this test runs with a fresh pid-suffixed name every time — so without
  // this the socket directory accumulates one dead entry per run, forever.
  // tmux's default socket directory is `/tmp/tmux-<uid>` — literally /tmp, not
  // $TMPDIR, which on macOS is a per-user path somewhere else entirely.
  try {
    rmSync(join(process.env.TMUX_TMPDIR || `/tmp/tmux-${process.getuid?.() ?? 0}`, SOCKET), {
      force: true,
    });
  } catch {}
}

afterAll(killServer);

describe("jmux boots", () => {
  test.skipIf(!TMUX)(
    "starts under a real pty and stays up",
    async () => {
      const home = mkdtempSync(join(tmpdir(), "jmux-boot-"));
      let output = "";
      let exitCode: number | null = null;

      const pty = new Terminal(
        process.execPath,
        ["run", join(import.meta.dir, "..", "main.ts"), "--socket", SOCKET],
        {
          name: "xterm-256color",
          cols: 120,
          rows: 40,
          env: {
            ...process.env,
            // A scratch HOME so the run can't read the developer's real config
            // or append to their crash log.
            HOME: home,
            TERM: "xterm-256color",
            JMUX: "",
            TMUX: "",
            TMUX_PANE: "",
          },
        },
      );
      pty.onData((d: string) => { output += d; });
      pty.onExit((e: { exitCode: number }) => { exitCode = e.exitCode; });

      // Long enough to clear boot: config load, tmux spawn, control-mode
      // attach, first frame. A module-scope throw lands well inside this.
      await Bun.sleep(6000);

      const alive = exitCode === null;
      try { pty.kill(); } catch {}
      killServer();
      rmSync(home, { recursive: true, force: true });

      // On failure the pty output is the only diagnostic — jmux deliberately
      // keeps crashes off stderr so they can't corrupt the alt screen.
      expect({ alive, exitCode, tail: output.slice(-400) }).toMatchObject({ alive: true });

      // It got far enough to own the terminal.
      expect(output).toContain("\x1b[?1049h");
    },
    20_000,
  );
});

// A corrupt config must stop jmux *before* it reaches the pty. This is the one
// startup behaviour no unit test can assert: ConfigStore's throw is covered in
// config.test.ts, but whether main.ts turns it into a diagnostic and a clean
// exit — rather than an unhandled stack and a half-started terminal — is only
// observable by running the thing.
//
// Deliberately not skipped when tmux is absent: the whole point is that jmux
// exits before it would need tmux at all.
describe("jmux refuses a corrupt config", () => {
  test("exits nonzero with a diagnostic naming the file", () => {
    const dir = mkdtempSync(join(tmpdir(), "jmux-corrupt-boot-"));
    const cfg = join(dir, "config.json");
    writeFileSync(cfg, "{ this is not json");
    try {
      const proc = Bun.spawnSync(
        ["bun", "run", join(import.meta.dir, "..", "main.ts"), "--config", cfg],
        { stdout: "pipe", stderr: "pipe" },
      );
      expect(proc.exitCode).not.toBe(0);
      const err = new TextDecoder().decode(proc.stderr);
      expect(err).toContain("config.json");
      expect(err).toContain("not valid JSON");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
