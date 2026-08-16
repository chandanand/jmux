import { describe, expect, test, afterAll } from "bun:test";
import { Terminal } from "bun-pty";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Terminal as Headless } from "@xterm/headless";
import { PARK_SESSION } from "../glass/internal-sessions";

// What does jmux do when its attached session is destroyed?
//
// A jmux-provisioned session is one window holding one pane, so anything that
// closes that pane — `Ctrl-Space x`, `Ctrl-d`, typing `exit` — destroys the
// *session*, not a pane. `core.conf` sets `detach-on-destroy off` precisely so
// that tmux then moves the client to another session instead of detaching it;
// with tmux's default (`on`) the client detaches, the pty closes, and jmux
// exits to the shell with the user's other sessions still running. The hidden
// park session gives tmux somewhere safe to move the client; once the last real
// session is gone, jmux must turn that holding state into the genuine empty
// Command Center rather than exposing the park shell with normal chrome.
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

interface JmuxSession {
  exitCode(): number | null;
  frame(): string;
  waitFor(text: string, timeoutMs?: number): Promise<void>;
  waitForCondition(label: string, predicate: () => boolean, timeoutMs?: number): Promise<void>;
  sessionNames(): string[];
  interactiveSession(): string | null;
  write(data: string): void;
  dispose(): void;
}

interface BootOptions {
  /** Positional `jmux SESSION`; lets jmux bootstrap a normally configured server. */
  explicitSession?: string;
  /** Start the server first; exercises the control-channel core-option repair. */
  preexistingSession?: string;
}

async function boot(options: BootOptions): Promise<JmuxSession> {
  killServer();
  if (options.preexistingSession) {
    tmux(["new-session", "-d", "-s", options.preexistingSession]);
  }

  const home = mkdtempSync(join(tmpdir(), "jmux-destroy-"));
  // A config on disk skips first-run onboarding. Returning to the empty
  // Command Center after a destroy must not reopen it either.
  mkdirSync(join(home, ".config", "jmux"), { recursive: true });
  writeFileSync(join(home, ".config", "jmux", "config.json"), JSON.stringify({}));

  const cols = 120;
  const rows = 40;
  const screen = new Headless({ cols, rows, allowProposedApi: true });
  let code: number | null = null;
  const pty = new Terminal(
    process.execPath,
    [
      "run",
      join(import.meta.dir, "..", "main.ts"),
      ...(options.explicitSession ? [options.explicitSession] : []),
      "--socket",
      SOCKET,
    ],
    {
      name: "xterm-256color",
      cols,
      rows,
      env: {
        ...process.env,
        HOME: home,
        XDG_CONFIG_HOME: join(home, ".config"),
        XDG_DATA_HOME: join(home, ".local", "share"),
        // A deterministic interactive shell: host shell hooks can prompt
        // during startup and consume the `exit` meant for the test session.
        SHELL: "/bin/sh",
        TERM: "xterm-256color",
        JMUX: "",
        TMUX: "",
        TMUX_PANE: "",
      },
    },
  );
  pty.onData((data: string) => { screen.write(data); });
  pty.onExit((event: { exitCode: number }) => { code = event.exitCode; });

  const frame = (): string => {
    const buffer = screen.buffer.active;
    const lines: string[] = [];
    for (let row = 0; row < screen.rows; row++) {
      lines.push(buffer.getLine(row)?.translateToString(true) ?? "");
    }
    return lines.join("\n");
  };

  const session: JmuxSession = {
    exitCode: () => code,
    frame,
    waitFor: async (text, timeoutMs = 10_000) => {
      await session.waitForCondition(
        JSON.stringify(text),
        () => frame().includes(text),
        timeoutMs,
      );
    },
    waitForCondition: async (label, predicate, timeoutMs = 10_000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (predicate()) return;
        await Bun.sleep(120);
      }
      throw new Error(`timed out waiting for ${label}\n--- frame ---\n${frame()}`);
    },
    sessionNames: () => {
      const output = tmux(["list-sessions", "-F", "#{session_name}"]);
      return output ? output.split("\n").sort() : [];
    },
    interactiveSession: () => {
      const output = tmux([
        "list-clients",
        "-f", "#{==:#{client_control_mode},0}",
        "-F", "#{client_session}",
      ]);
      return output || null;
    },
    write: (data) => { pty.write(data); },
    dispose: () => {
      try { pty.kill(); } catch {}
      killServer();
      rmSync(home, { recursive: true, force: true });
    },
  };

  // Wait for both startup's first rendered state and the late startupComplete
  // gate used by control-mode events. The option is applied immediately after
  // the control channel starts; the park session is created near the end.
  await session.waitForCondition(
    "jmux startup",
    () => code === null && session.sessionNames().includes(PARK_SESSION),
    15_000,
  );
  await Bun.sleep(1_000);
  return session;
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

function expectEmptyCommandCenter(session: JmuxSession): void {
  expect(session.exitCode()).toBeNull();
  expect(session.sessionNames()).toEqual([PARK_SESSION]);
  expect(session.interactiveSession()).toBe(PARK_SESSION);
  expect(session.frame()).toContain("No sessions yet");
  expect(session.frame()).toContain("Ctrl-Space n  new session");
  expect(session.frame()).not.toContain("What do you want to set up?");
}

describe("destroyed-session lifecycle, under a real pty", () => {
  test.skipIf(!TMUX)(
    "survives on a server jmux did not start",
    async () => {
      const session = await boot({ preexistingSession: "preexisting" });
      try {
        // Somewhere else for tmux to move the client. This remains the
        // original regression: a pre-existing server never read core.conf, so
        // startup must repair detach-on-destroy over the control channel.
        tmux(["new-session", "-d", "-s", "elsewhere"]);
        await Bun.sleep(500);

        const setting = tmux(["show-options", "-gv", "detach-on-destroy"]);
        const attached = session.interactiveSession();
        expect(attached).not.toBeNull();
        tmux(["kill-session", "-t", attached!]);
        await session.waitForCondition(
          "jmux to survive the attached session being destroyed",
          () => session.exitCode() === null && session.interactiveSession() === "elsewhere",
        );

        expect(setting).toBe("off");
        expect(session.exitCode()).toBeNull();
      } finally {
        session.dispose();
      }
    },
    40_000,
  );

  test.skipIf(!TMUX)(
    "exiting the final session parks the client in the empty Command Center",
    async () => {
      const session = await boot({ explicitSession: "final-exit" });
      try {
        expect(tmux(["show-options", "-gv", "detach-on-destroy"])).toBe("off");
        expect(session.interactiveSession()).toBe("final-exit");
        expect(session.frame()).not.toContain("tmux configuration is incomplete");

        session.write("exit\r");
        await session.waitFor("No sessions yet");

        expectEmptyCommandCenter(session);
      } finally {
        session.dispose();
      }
    },
    40_000,
  );

  test.skipIf(!TMUX)(
    "killing the final session parks the client in the empty Command Center",
    async () => {
      const session = await boot({ explicitSession: "final-kill" });
      try {
        expect(session.interactiveSession()).toBe("final-kill");
        expect(session.frame()).not.toContain("tmux configuration is incomplete");

        tmux(["kill-session", "-t", "final-kill"]);
        await session.waitFor("No sessions yet");

        expectEmptyCommandCenter(session);
      } finally {
        session.dispose();
      }
    },
    40_000,
  );

  test.skipIf(!TMUX)(
    "destroying one session lands on the remaining real session",
    async () => {
      const session = await boot({ explicitSession: "first" });
      try {
        const attached = session.interactiveSession();
        expect(attached).toBe("first");

        // Created after the park session, so tmux's normal
        // detach-on-destroy=off selection makes this the landing target.
        tmux(["new-session", "-d", "-s", "remaining"]);
        await session.waitForCondition(
          "remaining session to appear",
          () => session.sessionNames().includes("remaining") && session.frame().includes("remaining"),
        );

        tmux(["kill-session", "-t", attached!]);
        await session.waitForCondition(
          "interactive client on remaining",
          () => session.interactiveSession() === "remaining",
        );
        await Bun.sleep(500);

        expect(session.exitCode()).toBeNull();
        expect(session.sessionNames()).toEqual([PARK_SESSION, "remaining"].sort());
        expect(session.frame()).not.toContain("No sessions yet");
      } finally {
        session.dispose();
      }
    },
    40_000,
  );
});
