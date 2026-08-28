import { describe, expect, test, afterAll } from "bun:test";
import { Terminal } from "bun-pty";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { basename, join } from "path";
import { Terminal as Headless } from "@xterm/headless";
import { PARK_SESSION } from "../glass/internal-sessions";
import { AUTO_WINDOW_TITLE_OPTION } from "../window-title";

// The startup regressions in this file are invisible to every unit test either
// side of main.ts: the wrong `new-session -A` target fabricates session 0 before
// the control channel exists, and `installSkill()` output on an alt screen lands
// directly over the rendered frame. A real pty with a real tmux server and
// screen model is the only place those boundaries are observable.
//
// Skipped rather than failed without tmux, for the reason boot-smoke states:
// this must never be why a clean checkout cannot run its tests.

const TMUX = Bun.which("tmux");
const SOCKET = `jmux-onboarding-${process.pid}`;

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

interface Session {
  home: string;
  exitCode(): number | null;
  write(data: string): void;
  press(data: string): Promise<void>;
  resize(cols: number, rows: number): void;
  frame(): string;
  waitFor(text: string, timeoutMs?: number): Promise<void>;
  waitForSessionNames(names: string[], timeoutMs?: number): Promise<void>;
  sessionNames(): string[];
  clientRows(): string[];
  dispose(): void;
}

interface BootOptions {
  /** Put config.json on disk so onboarding is skipped. */
  configured?: boolean;
  /** Deterministic command for exercising the New Session launch boundary. */
  agentCommand?: string;
  /** Positional `jmux SESSION`. */
  sessionName?: string;
  /** A durable snapshot to place where this socket will restore it. */
  snapshot?: object;
}

function tmux(args: string[]): string {
  if (!TMUX) return "";
  return Bun.spawnSync([TMUX, "-L", SOCKET, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  }).stdout.toString().trim();
}

async function tmuxAsync(args: string[], timeoutMs = 2_000): Promise<string> {
  if (!TMUX) return "";
  const proc = Bun.spawn([TMUX, "-L", SOCKET, ...args], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  try {
    const output = await new Response(proc.stdout).text();
    await proc.exited;
    return proc.exitCode === 0 ? output.trim() : "";
  } finally {
    clearTimeout(timer);
  }
}

async function boot(cols = 120, rows = 40, options: BootOptions = {}): Promise<Session> {
  const home = mkdtempSync(join(tmpdir(), "jmux-onboarding-"));
  if (options.configured) {
    const configDir = join(home, ".config", "jmux");
    mkdirSync(configDir, { recursive: true });
    const config = options.agentCommand
      ? { projectDefaults: { autoLaunchAgent: true, agentCommand: options.agentCommand } }
      : {};
    writeFileSync(join(configDir, "config.json"), JSON.stringify(config, null, 2) + "\n");
  }
  if (options.snapshot) {
    const snapshotDir = join(home, ".local", "share", "jmux", "snapshot", SOCKET);
    mkdirSync(snapshotDir, { recursive: true });
    writeFileSync(
      join(snapshotDir, "state.json"),
      JSON.stringify(options.snapshot, null, 2) + "\n",
    );
  }
  const screen = new Headless({ cols, rows, allowProposedApi: true });
  let exitCode: number | null = null;

  const pty = new Terminal(
    process.execPath,
    [
      "run",
      join(import.meta.dir, "..", "main.ts"),
      ...(options.sessionName ? [options.sessionName] : []),
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
        TERM: "xterm-256color",
        JMUX: "",
        TMUX: "",
        TMUX_PANE: "",
      },
    },
  );
  pty.onData((d: string) => { screen.write(d); });
  pty.onExit((event: { exitCode: number }) => { exitCode = event.exitCode; });

  const frame = (): string => {
    const buf = screen.buffer.active;
    const out: string[] = [];
    for (let y = 0; y < screen.rows; y++) {
      out.push(buf.getLine(y)?.translateToString(true) ?? "");
    }
    return out.join("\n");
  };

  const session: Session = {
    home,
    exitCode: () => exitCode,
    // Escape sequences go out in a SINGLE write: byte-by-byte makes a lone
    // \x1b read as Escape, which would close the flow instead of moving in it.
    write: (data) => { pty.write(data); },
    // And one keypress per write, with a gap. Two writes in quick succession
    // arrive merged as a single read — `\x1b[B\r` matches neither key — which
    // is the same hazard the mouse path splits chunks to avoid.
    press: async (data) => { pty.write(data); await Bun.sleep(220); },
    resize: (c, r) => { screen.resize(c, r); pty.resize(c, r); },
    frame,
    waitFor: async (text, timeoutMs = 10_000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (frame().includes(text)) return;
        await Bun.sleep(120);
      }
      throw new Error(`timed out waiting for ${JSON.stringify(text)}\n--- frame ---\n${frame()}`);
    },
    waitForSessionNames: async (names, timeoutMs = 10_000) => {
      const expected = [...names].sort();
      const deadline = Date.now() + timeoutMs;
      let actual: string[] = [];
      while (Date.now() < deadline) {
        actual = session.sessionNames();
        if (actual.length === expected.length && actual.every((name, i) => name === expected[i])) {
          return;
        }
        await Bun.sleep(120);
      }
      throw new Error(`timed out waiting for sessions ${JSON.stringify(expected)}; got ${JSON.stringify(actual)}`);
    },
    sessionNames: () => {
      const output = tmux(["list-sessions", "-F", "#{session_name}"]);
      return output ? output.split("\n").sort() : [];
    },
    clientRows: () => {
      const output = tmux([
        "list-clients",
        "-F",
        "#{client_control_mode}:#{client_session}",
      ]);
      return output ? output.split("\n") : [];
    },
    dispose: () => {
      try { pty.kill(); } catch {}
      killServer();
      rmSync(home, { recursive: true, force: true });
    },
  };

  return session;
}

describe.skipIf(!TMUX)("onboarding, under a real pty", () => {
  test("a configured cold start is an empty Command Center with no session 0", async () => {
    const session = await boot(120, 40, { configured: true });
    try {
      await session.waitFor("No sessions yet");
      expect(session.frame()).toContain("Ctrl-Space n  new session");
      expect(session.sessionNames()).toEqual([PARK_SESSION]);
      expect(session.sessionNames()).not.toContain("0");
    } finally {
      session.dispose();
    }
  }, 60_000);

  test("a generic first session launches the configured agent and names its window", async () => {
    const marker = ".jmux-agent-launched";
    const session = await boot(120, 40, {
      configured: true,
      // Keep the launched process alive so pane_current_command has a stable
      // post-launch value for the automatic window classifier to observe.
      agentCommand: `touch "$HOME/${marker}"; exec sleep 30`,
    });
    try {
      await session.waitFor("No sessions yet");
      await session.press("\x00");
      await session.press("n");
      await session.waitFor("Pick a directory");
      await session.press("\r"); // scratch HOME, the cold-start fallback
      await Bun.sleep(300);
      await session.press("\r"); // accept its basename as the session name

      const markerPath = join(session.home, marker);
      const deadline = Date.now() + 10_000;
      while (!existsSync(markerPath) && Date.now() < deadline) {
        await Bun.sleep(120);
      }
      expect(existsSync(markerPath)).toBe(true);

      let windowRow = "";
      while (Date.now() < deadline) {
        windowRow = tmux([
          "list-windows",
          "-t",
          basename(session.home),
          "-F",
          `#{window_name}:#{${AUTO_WINDOW_TITLE_OPTION}}:#{pane_current_command}`,
        ]);
        if (windowRow === "sleep:sleep:sleep") break;
        await Bun.sleep(120);
      }
      expect(windowRow).toBe("sleep:sleep:sleep");
    } finally {
      session.dispose();
    }
  }, 60_000);

  test("first run opens the flow, and no installer output reaches the frame", async () => {
    const session = await boot();
    try {
      // An absent config.json is what triggers first run.
      await session.waitFor("Run several coding agents at once");
      expect(session.frame()).toContain("What do you want to set up?");
      expect(session.frame()).toContain("Just run agents");
      // The modal is hosted over the same park-backed Command Center as a
      // configured empty start. No disposable user session was made beneath it.
      expect(session.sessionNames()).toEqual([PARK_SESSION]);
      expect(session.sessionNames()).not.toContain("0");

      await session.press("\r");
      await session.waitFor("Where your code lives");
      expect(session.frame()).toContain("Step 1 of 3");

      await session.press("\x1b[C");
      await session.waitFor("Letting jmux see your agents");

      // The install. Every string below is text that landed raw on the frame
      // before this rebuild.
      await session.press("\r");
      await Bun.sleep(3000);

      const frame = session.frame();
      for (const leak of [
        "jmux-control skill:",
        "hunk-review skill:",
        "hunk not found",
        "Agents running inside jmux can now discover",
        "installed to /",
        "already up to date",
      ]) {
        expect({ leak, frame }).toMatchObject({ frame: expect.not.stringContaining(leak) });
      }
    } finally {
      session.dispose();
    }
  }, 60_000);

  test("a resize mid-token keeps the flow and the collector", async () => {
    const session = await boot();
    try {
      await session.waitFor("Run several coding agents at once");
      // Second intent: the tracker arm.
      await session.press("\x1b[B");
      await session.press("\r");
      await session.waitFor("Where your code lives");
      await session.press("\x1b[C");
      await session.press("\x1b[C");
      await session.press("\x1b[C");
      await session.waitFor("Connect your issue tracker");

      await session.press("\r");
      await session.waitFor("API key");
      session.write("abc123");
      await Bun.sleep(300);

      // The token must never be legible on screen.
      expect(session.frame()).not.toContain("abc123");

      // Every other modal is closed by SIGWINCH. This one re-lays out, so the
      // collector and its draft survive a window drag.
      session.resize(100, 32);
      await Bun.sleep(1500);
      expect(session.frame()).toContain("API key");
    } finally {
      session.dispose();
    }
  }, 60_000);

  test("esc zooms out to the map, and again closes", async () => {
    const session = await boot();
    try {
      await session.waitFor("Run several coding agents at once");
      await session.press("\r");
      await session.waitFor("Where your code lives");

      await session.press("\x1b");
      await session.waitFor("Set up jmux");
      expect(session.frame()).toContain("Letting jmux see your agents");

      await session.press("\x1b");
      await Bun.sleep(800);
      expect(session.frame()).not.toContain("Where your code lives");
    } finally {
      session.dispose();
    }
  }, 60_000);

  test("finishing onboarding hands the existing New Session flow to the first real session", async () => {
    const session = await boot();
    try {
      await session.waitFor("Run several coding agents at once");
      await session.press("\r"); // Just run agents
      await session.waitFor("Where your code lives");
      await session.press("\x1b[C"); // agents
      await session.press("\x1b[C"); // naming
      await session.press("\x1b[C"); // done
      await session.waitFor("You're set up");

      await session.press("\r");
      await session.waitFor("Pick a directory");
      await session.press("\r"); // scratch HOME, the cold-start fallback
      await Bun.sleep(300);
      await session.press("\r"); // accept its basename as the session name

      const expected = basename(session.home);
      await session.waitFor(expected);
      expect(session.sessionNames()).toEqual([PARK_SESSION, expected].sort());
      expect(session.sessionNames()).not.toContain("0");
      expect(session.clientRows()).toContain(`0:${expected}`);
      expect(session.frame()).not.toContain("No sessions yet");
    } finally {
      session.dispose();
    }
  }, 60_000);

  test("an explicit cold-start name bypasses Command Center", async () => {
    const session = await boot(120, 40, {
      configured: true,
      sessionName: "named-cold-start",
    });
    try {
      await session.waitFor("named-cold-start");
      await session.waitForSessionNames([PARK_SESSION, "named-cold-start"]);
      expect(session.sessionNames()).toEqual([PARK_SESSION, "named-cold-start"].sort());
      expect(session.sessionNames()).not.toContain("0");
      expect(session.clientRows()).toContain("0:named-cold-start");
      expect(session.frame()).not.toContain("No sessions yet");
    } finally {
      session.dispose();
    }
  }, 60_000);

  test("automatic window names follow the foreground command and a manual name wins", async () => {
    const sessionName = "window-title";
    const session = await boot(120, 40, {
      configured: true,
      sessionName,
    });
    const waitForWindowName = async (target: string, expected: string, timeoutMs = 10_000) => {
      const deadline = Date.now() + timeoutMs;
      let lastState = "window unavailable";
      while (Date.now() < deadline) {
        if (session.exitCode() !== null) {
          throw new Error(`jmux exited with ${session.exitCode()} while waiting for ${expected}`);
        }
        lastState = await tmuxAsync([
          "display-message",
          "-p",
          "-t",
          target,
          `#{window_name}\t#{pane_current_command}\t#{automatic-rename}\t#{${AUTO_WINDOW_TITLE_OPTION}}`,
        ]);
        if (lastState.split("\t", 1)[0] === expected) return;
        await Bun.sleep(120);
      }
      throw new Error(`timed out waiting for window name ${expected}; last state: ${lastState}`);
    };

    try {
      await session.waitFor(sessionName);
      // An explicit command avoids depending on the developer's interactive
      // shell startup (which may itself be waiting on a trust/setup prompt).
      await tmuxAsync(["set-option", "-g", "default-shell", "/bin/sh"]);
      const windowId = await tmuxAsync([
        "new-window",
        "-dP",
        "-F",
        "#{window_id}",
        "-t",
        `${sessionName}:`,
        "--",
        "sleep 30",
      ]);
      expect(windowId).toStartWith("@");
      await waitForWindowName(windowId, "sleep");

      // tmux disables automatic-rename for this window. jmux observes that,
      // retires its derived option, and never overwrites the human's choice.
      await tmuxAsync(["rename-window", "-t", windowId, "hand-written"]);
      await waitForWindowName(windowId, "hand-written");
      await Bun.sleep(1_500);

      expect(await tmuxAsync(["display-message", "-p", "-t", windowId, "#{window_name}"]))
        .toBe("hand-written");
      expect(await tmuxAsync(["show-option", "-wqv", "-t", windowId, "automatic-rename"]))
        .toBe("off");
      expect(await tmuxAsync(["show-option", "-wqv", "-t", windowId, AUTO_WINDOW_TITLE_OPTION]))
        .toBe("");
    } finally {
      session.dispose();
    }
  }, 60_000);

  test("a restorable snapshot still wins over the empty Command Center path", async () => {
    const home = mkdtempSync(join(tmpdir(), "jmux-snapshot-cwd-"));
    const capturedAt = "2026-08-15T12:00:00.000Z";
    const snapshot = {
      formatVersion: 1,
      jmuxVersion: "test",
      capturedAt,
      tmuxSocket: SOCKET,
      lastFocusedSession: "remembered",
      sessions: [{
        name: "remembered",
        cwd: home,
        worktreePath: null,
        projectGroup: null,
        projectId: "payments",
        pinned: false,
        permissionMode: null,
        otel: null,
        links: [],
        windows: [{
          index: 1,
          name: "shell",
          layout: "even-horizontal",
          active: true,
          panes: [{
            index: 1,
            cwd: home,
            command: process.env.SHELL ?? "/bin/sh",
            kind: "shell",
            scrollbackFile: null,
          }],
        }],
      }],
    };
    const session = await boot(120, 40, { configured: true, snapshot });
    try {
      await session.waitFor("remembered");
      expect(session.sessionNames()).toEqual([PARK_SESSION, "remembered"].sort());
      expect(session.sessionNames()).not.toContain("0");
      expect(session.clientRows()).toContain("0:remembered");
      expect(tmux(["show-option", "-qv", "-t", "remembered", "@jmux-project"]))
        .toBe("payments");
      expect(session.frame()).not.toContain("No sessions yet");
    } finally {
      session.dispose();
      rmSync(home, { recursive: true, force: true });
    }
  }, 60_000);
});
