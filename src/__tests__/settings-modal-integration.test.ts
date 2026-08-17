import { describe, expect, test, afterAll } from "bun:test";
import { Terminal } from "bun-pty";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Terminal as Headless } from "@xterm/headless";

// The settings screen is a frameless full-screen takeover, and for its whole
// life its render branch passed `null` for the modal overlay while its input
// branch consumed every key ahead of one — "it paints its own pickers and
// prompts". Which was true of `editState`, and not true of the action rows that
// call `openModal`: the code-host token prompt and the remembered-routes
// picker. Both opened invisibly *and* deaf, so the screen looked frozen on a
// keystroke whose hint line said "↵ run".
//
// Nothing either side of that glue can see it. `SettingsScreen.handleInput`
// returns the right action, `InputModal` opens, `openModal` sets the slot — all
// unit-testable and all green while the feature did nothing on screen. It is
// only observable in a real pty with a real screen model, which is where it is
// asserted, exactly as onboarding-integration.test.ts argues.
//
// Skipped rather than failed without tmux: that must never be why a clean
// checkout cannot run its tests.

const TMUX = Bun.which("tmux");
const SOCKET = `jmux-settings-modal-${process.pid}`;

function killServer(): void {
  if (!TMUX) return;
  try {
    Bun.spawnSync([TMUX, "-L", SOCKET, "kill-server"], { stdout: "ignore", stderr: "ignore" });
  } catch {}
}

afterAll(killServer);

async function boot(cols = 150, rows = 45) {
  const home = mkdtempSync(join(tmpdir(), "jmux-settings-modal-"));
  mkdirSync(join(home, ".config", "jmux"), { recursive: true });
  // A code host must be configured, or the row correctly refuses to prompt.
  writeFileSync(
    join(home, ".config", "jmux", "config.json"),
    JSON.stringify({ adapters: { codeHost: { type: "gitlab" } } }),
  );

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
    for (let y = 0; y < screen.rows; y++) out.push(buf.getLine(y)?.translateToString(true) ?? "");
    return out.join("\n");
  };

  return {
    frame,
    // One keypress per write, with a gap. Two writes in quick succession arrive
    // merged as a single read and match no key at all.
    press: async (data: string, ms = 200) => { pty.write(data); await Bun.sleep(ms); },
    waitFor: async (text: string, timeoutMs = 15_000) => {
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
}

describe.skipIf(!TMUX)("a modal opened from the settings screen, under a real pty", () => {
  test("paints over the surface and receives its own keys", async () => {
    const session = await boot();
    try {
      await Bun.sleep(7000);

      // Ctrl-a i, then "All settings…" — two writes, because the soft prefix
      // intercept reads the byte *after* \x01 and a merged chunk matches neither.
      await session.press("\x01");
      await session.press("i", 1200);
      for (const ch of "All settings") await session.press(ch, 70);
      await session.press("\r", 1500);
      await session.waitFor("Integrations");

      // Walked rather than counted: a row added above this one must not turn
      // this test into one that asserts something else entirely.
      for (let i = 0; i < 40 && !session.frame().includes("▸ Code host token"); i++) {
        await session.press("\x1b[B", 90);
      }
      expect(session.frame()).toContain("▸ Code host token");

      // The regression. Before the overlay was composited this frame was
      // indistinguishable from the one above.
      await session.press("\r", 1200);
      expect(session.frame()).toContain("Paste your gitlab token");

      // And the other half: the modal must actually get the keys. The settings
      // screen used to consume them ahead of it, so the prompt sat there empty
      // however much you typed.
      for (const ch of "glpat-abc") await session.press(ch, 70);
      await Bun.sleep(300);
      expect(session.frame()).toContain("•••••••••");

      // esc closes the modal and hands routing back to the surface rather than
      // clearing it — the screen must still be live underneath.
      await session.press("\x1b", 800);
      expect(session.frame()).not.toContain("Paste your gitlab token");
      expect(session.frame()).toContain("Code host token");
      await session.press("\x1b[A", 400);
      expect(session.frame()).toContain("▸ Code host");
    } finally {
      session.dispose();
    }
  }, 60_000);
});
