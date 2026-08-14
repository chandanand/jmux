import { describe, expect, test, afterAll } from "bun:test";
import { Terminal } from "bun-pty";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Terminal as Headless } from "@xterm/headless";

// The regression that started this rebuild is invisible to every unit test
// either side of it: `installSkill()` printed with console.log, and on an alt
// screen those lines land on the rendered frame over whatever was there. The
// only place that is observable is a real pty with a real screen model, so
// that is where it is asserted.
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
  write(data: string): void;
  press(data: string): Promise<void>;
  resize(cols: number, rows: number): void;
  frame(): string;
  waitFor(text: string, timeoutMs?: number): Promise<void>;
  dispose(): void;
}

async function boot(cols = 120, rows = 40): Promise<Session> {
  const home = mkdtempSync(join(tmpdir(), "jmux-onboarding-"));
  const screen = new Headless({ cols, rows, allowProposedApi: true });

  const pty = new Terminal(
    process.execPath,
    ["run", join(import.meta.dir, "..", "main.ts"), "--socket", SOCKET],
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

  const frame = (): string => {
    const buf = screen.buffer.active;
    const out: string[] = [];
    for (let y = 0; y < screen.rows; y++) {
      out.push(buf.getLine(y)?.translateToString(true) ?? "");
    }
    return out.join("\n");
  };

  const session: Session = {
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
    dispose: () => {
      try { pty.kill(); } catch {}
      killServer();
      rmSync(home, { recursive: true, force: true });
    },
  };

  return session;
}

describe.skipIf(!TMUX)("onboarding, under a real pty", () => {
  test("first run opens the flow, and no installer output reaches the frame", async () => {
    const session = await boot();
    try {
      // An absent config.json is what triggers first run.
      await session.waitFor("Run several coding agents at once");
      expect(session.frame()).toContain("What do you want to set up?");
      expect(session.frame()).toContain("Just run agents");

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
});
