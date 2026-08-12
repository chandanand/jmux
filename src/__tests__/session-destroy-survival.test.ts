import { describe, expect, test, afterAll } from "bun:test";
import { Terminal } from "bun-pty";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// Does jmux survive its own session being destroyed?
//
// A jmux-provisioned session is one window holding one pane, so anything that
// closes that pane — `Ctrl-a x`, `Ctrl-d`, typing `exit` — destroys the
// *session*, not a pane. `core.conf` sets `detach-on-destroy off` precisely so
// that tmux then moves the client to another session instead of detaching it;
// with tmux's default (`on`) the client detaches, the pty closes, and jmux
// exits to the shell with the user's other sessions still running.
//
// The gap is that `-f <config>` is honored only when tmux *starts* a server.
// Attach to a server jmux did not start — one left by a previous jmux, or one
// the user started themselves — and `core.conf` never runs, so the setting is
// at tmux's default and closing a pane takes the whole TUI down. That is why
// this boots against a *pre-existing* server: against a fresh one the bug is
// invisible, because there `-f` did apply.
//
// This is an integration test for the same reason `boot-smoke.test.ts` is one:
// the behaviour lives in main.ts's startup wiring, which no unit test can
// reach, and the failure is a process exit rather than a wrong return value.

const TMUX = Bun.which("tmux");
const SOCKET = `jmux-destroy-survival-${process.pid}`;

function tmux(args: string[]): string {
  if (!TMUX) return "";
  const r = Bun.spawnSync([TMUX, "-L", SOCKET, ...args], { stdout: "pipe", stderr: "pipe" });
  return r.stdout.toString().trim();
}

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

afterAll(killServer);

describe("a destroyed session does not take jmux with it", () => {
  test.skipIf(!TMUX)(
    "survives on a server jmux did not start",
    async () => {
      // The server exists first, so jmux attaches rather than starting it and
      // its `-f config/tmux.conf` is ignored — the whole point of the test.
      tmux(["new-session", "-d", "-s", "preexisting"]);

      const home = mkdtempSync(join(tmpdir(), "jmux-destroy-"));
      // A config on disk, or first run opens the setup checklist over the top.
      mkdirSync(join(home, ".config", "jmux"), { recursive: true });
      writeFileSync(join(home, ".config", "jmux", "config.json"), JSON.stringify({}));

      let exitCode: number | null = null;
      const pty = new Terminal(
        process.execPath,
        ["run", join(import.meta.dir, "..", "main.ts"), "--socket", SOCKET],
        {
          name: "xterm-256color",
          cols: 120,
          rows: 40,
          env: { ...process.env, HOME: home, TERM: "xterm-256color", JMUX: "", TMUX: "", TMUX_PANE: "" },
        },
      );
      pty.onData(() => {});
      pty.onExit((e: { exitCode: number }) => { exitCode = e.exitCode; });

      // Boot: config load, tmux attach, control-mode handshake, first frame.
      await Bun.sleep(7000);
      const booted = exitCode === null;

      // Somewhere else for the client to land, so the assertion is about the
      // client being moved rather than about the server having work left.
      tmux(["new-session", "-d", "-s", "elsewhere"]);
      await Bun.sleep(500);

      const setting = tmux(["show-options", "-gv", "detach-on-destroy"]);
      const attached = tmux(["list-clients", "-F", "#{client_session}"]).split("\n")[0] ?? "";

      // Exactly what closing the last pane of a single-pane session does.
      tmux(["kill-session", "-t", attached]);
      await Bun.sleep(3000);
      const survived = exitCode === null;

      try { pty.kill(); } catch {}
      killServer();
      rmSync(home, { recursive: true, force: true });

      expect({ booted, setting, survived, exitCode }).toMatchObject({
        booted: true,
        setting: "off",
        survived: true,
      });
    },
    40_000,
  );
});
