import { describe, expect, test, afterAll } from "bun:test";
import { Terminal } from "bun-pty";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// Does a picture drawn inside a pane actually reach the terminal?
//
// The third integration test in the suite, and it earns the exception for the
// reason the other two do: the wiring lives in `main.ts`, which no unit test
// can import. The pieces either side of this are pure and unit tested — the
// scanner, the placeholder width, the modal blanking — and every one of them
// would keep passing if the scanner were never called, if tmux refused to pass
// the sequence through, or if the headless terminal printed the payload as text
// instead of the compositor carrying the placement.
//
// Three claims, which together are the whole feature:
//   1. the graphics command a pane emits comes back out of jmux's stdout,
//   2. its placement survives compositing as placeholder cells,
//   3. neither leaks into the frame as visible text.
//
// The emitter is synthetic rather than a real browser. terminal-browser is a
// 130MB Electron app with a cold start measured in seconds, and what is under
// test here is jmux's half of the contract — which is a byte pattern, and is
// reproduced exactly below. The real browser is driven by
// `scripts/browser-pane-e2e.ts`, on the same split the diff panel uses between
// hunk-integration.test.ts and its own hand-driven harness.
//
// Skipped rather than failed when tmux is missing: that must never be the
// reason a clean checkout can't run its tests.

const TMUX = Bun.which("tmux");
const SOCKET = `jmux-gfx-int-${process.pid}`;

const IMAGE_ID = 777;
const PLACEHOLDER = String.fromCodePoint(0x10eeee);
/** Row/column diacritics, from the kitty protocol's table. */
const DIACRITICS = ["̅", "̍", "̎", "̐"];
const COLS = 4;
const ROWS = 2;

const scratch: string[] = [];

function killServer(): void {
  if (!TMUX) return;
  try {
    Bun.spawnSync([TMUX, "-L", SOCKET, "kill-server"], { stdout: "ignore", stderr: "ignore" });
  } catch {}
  // Same cleanup boot-smoke does, for the same reason: kill-server leaves the
  // socket file behind, and the name carries this run's pid.
  try {
    rmSync(join(process.env.TMUX_TMPDIR || `/tmp/tmux-${process.getuid?.() ?? 0}`, SOCKET), {
      force: true,
    });
  } catch {}
}

afterAll(() => {
  killServer();
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

/**
 * A pane program that draws an image exactly the way one does under tmux:
 * the payload wrapped in tmux's passthrough DCS, the placement written as
 * ordinary placeholder text. Written as a script rather than a `printf` so the
 * escaping is owned here instead of by three layers of shell quoting.
 */
function emitterScript(): string {
  const rgba = Buffer.alloc(COLS * ROWS * 4, 0xff).toString("base64");
  const apc =
    `\\x1b_Ga=T,f=32,s=${COLS},v=${ROWS},t=d,i=${IMAGE_ID},U=1,` +
    `c=${COLS},r=${ROWS},q=2;${rgba}\\x1b\\\\`;
  return [
    "const APC = `" + apc + "`;",
    // tmux passthrough: wrap in DCS and double every ESC inside.
    'const wrapped = "\\x1bPtmux;" + APC.replaceAll("\\x1b", "\\x1b\\x1b") + "\\x1b\\\\";',
    `const P = ${JSON.stringify(PLACEHOLDER)};`,
    `const D = ${JSON.stringify(DIACRITICS)};`,
    `const fg = "\\x1b[38;2;${(IMAGE_ID >> 16) & 0xff};${(IMAGE_ID >> 8) & 0xff};${IMAGE_ID & 0xff}m";`,
    "let grid = fg;",
    `for (let r = 0; r < ${ROWS}; r++) {`,
    '  grid += `\\x1b[${r + 1};1H`;',
    `  for (let c = 0; c < ${COLS}; c++) grid += P + D[r] + D[c];`,
    "}",
    'grid += "\\x1b[39m";',
    // Redraw on a timer rather than writing once. tmux forwards a passthrough
    // sequence only while the pane is visible and drops it otherwise, so a
    // single write races the client's switch to this window — and a real
    // graphical program is repainting continuously anyway.
    "for (let i = 0; i < 300; i++) {",
    "  process.stdout.write(wrapped + grid);",
    "  await Bun.sleep(200);",
    "}",
  ].join("\n");
}

/** Count U+10EEEE cells in a chunk of jmux's output. */
function countPlaceholders(s: string): number {
  return (s.match(new RegExp(PLACEHOLDER, "gu")) ?? []).length;
}

/** The graphics APCs jmux relayed to its stdout. */
function graphicsApcs(s: string): string[] {
  return s.match(/\x1b_G[^\x1b\x07]*(?:\x1b\\|\x07)/g) ?? [];
}

describe("graphics drawn inside a pane", () => {
  test.skipIf(!TMUX)(
    "reach the terminal, and their placement survives compositing",
    async () => {
      const home = mkdtempSync(join(tmpdir(), "jmux-gfx-"));
      scratch.push(home);
      mkdirSync(join(home, ".config", "jmux"), { recursive: true });
      // Force graphics on. The harness pty is not a terminal that answers the
      // capability probe, and imagesOn() is the one switch the relay hangs off
      // — the same switch a user with a capable terminal gets from detection.
      writeFileSync(
        join(home, ".config", "jmux", "config.json"),
        JSON.stringify({ images: { enabled: true } }),
      );
      const emitter = join(home, "emit.ts");
      writeFileSync(emitter, emitterScript());

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

      try {
        // Boot: config load, tmux spawn, control attach, first frame.
        await Bun.sleep(7000);
        expect(exitCode).toBeNull();

        const before = output.length;
        // Target the pty client by name, exactly as openBrowserPane does. tmux
        // forwards a passthrough sequence only for a pane the client can
        // currently see, and an untargeted split lands in whichever session
        // tmux last touched — which, with jmux's parking session on the server,
        // is reliably not the one on screen.
        const clients = Bun.spawnSync([TMUX!, "-L", SOCKET, "list-clients", "-F", "#{client_name}"]);
        const ptyClient = new TextDecoder()
          .decode(clients.stdout)
          .split("\n")
          .find((name) => name.startsWith("/dev/"));
        expect(ptyClient).toBeTruthy();
        Bun.spawnSync(
          [TMUX!, "-L", SOCKET, "split-window", "-h", "-t", ptyClient!,
           `${process.execPath} run ${emitter}`],
          { stdout: "ignore", stderr: "ignore" },
        );

        for (let i = 0; i < 30 && !graphicsApcs(output.slice(before)).length; i++) {
          await Bun.sleep(500);
        }
        const drawn = output.slice(before);

        // 1. The payload came back out, addressed to the same image.
        const apcs = graphicsApcs(drawn);
        expect(apcs.length).toBeGreaterThan(0);
        expect(apcs.join("")).toContain(`i=${IMAGE_ID}`);

        // It must arrive unwrapped: tmux strips its own DCS, and a jmux that
        // relayed the wrapper instead would send the outer terminal a sequence
        // addressed to a multiplexer that isn't there.
        expect(drawn).not.toContain("\x1bPtmux;");

        // 2. The placement survived the compositor as placeholder cells. Every
        // cell of the image is there — a count short of this is the width bug
        // (each placeholder measured as two columns) shearing the row.
        expect(countPlaceholders(drawn)).toBeGreaterThanOrEqual(COLS * ROWS);

        // 3. Nothing leaked as text. The base64 payload rendered into the grid
        // is what happens if the screen model parses the APC instead of jmux
        // lifting it out — and it is unmistakable, being the only long run of
        // base64 anywhere in a frame.
        const visible = drawn.replace(/\x1b_G[^\x1b\x07]*(?:\x1b\\|\x07)/g, "");
        expect(visible).not.toMatch(/[A-Za-z0-9+/]{120,}/);

        // 4. A modal withdraws the placement rather than dimming it. The image
        // id lives in the cell's foreground colour, so a dimmed placeholder
        // still names an image and the terminal would draw it over the modal.
        //
        // Measured only from frames painted *after* the modal is up. Slicing
        // from before the keystroke also catches the repaint `\x01` triggers on
        // its own — a legitimate pre-modal frame, with its placeholders intact —
        // and counting that as a failure made this pass or fail on how quickly
        // the machine got between the two bytes.
        for (const ch of "\x01p") { // Ctrl-a p — command palette
          pty.write(ch);
          await Bun.sleep(60);
        }
        await Bun.sleep(1500);

        // The emitter repaints on a timer, so jmux keeps painting with the
        // modal open; anything in this window is a settled modal frame.
        const beforeModal = output.length;
        await Bun.sleep(1500);
        const withModal = output.slice(beforeModal);
        expect(withModal.length).toBeGreaterThan(0); // it did repaint
        expect(countPlaceholders(withModal)).toBe(0);
      } finally {
        try { pty.kill(); } catch {}
        killServer();
      }
    },
    60_000,
  );
});
