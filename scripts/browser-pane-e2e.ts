// End-to-end check of browser panes, against a real terminal-browser.
//
//   bun run scripts/browser-pane-e2e.ts
//
// src/__tests__/graphics-passthrough-integration.test.ts covers jmux's half of
// the contract — that a graphics command emitted in a pane comes back out of
// jmux's stdout, that its placement survives compositing, and that a modal
// withdraws it — using a synthetic emitter, because that half is a byte pattern
// and is deterministic enough to belong in `bun test`.
//
// This runs the actual browser. It is the check that the byte pattern the
// suite asserts against is still the one terminal-browser produces: a version
// that switched transports, changed its placement keys or stopped using virtual
// placements under tmux would sail past the suite and be broken in front of the
// user. It also exercises the reply path — the capability probe terminal-browser
// sends has to travel back through jmux's stdin, the input router, the pty and
// tmux to reach the pane that asked, and nothing in the suite covers that.
//
// It lives here rather than in the suite because it cold-starts a 130MB
// Electron app, and because what it asserts is another project's behaviour.
// Run it by hand when touching src/images/passthrough.ts or browser-pane.ts.
//
// The pty stands in for the terminal and answers graphics queries the way a
// kitty-capable one does. Uses its own tmux socket and a scratch HOME, so it
// cannot touch a real config or session.

import { Terminal } from "bun-pty";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const JMUX = resolve(import.meta.dir, "..");
const SOCKET = `jmux-browser-e2e-${process.pid}`;
const TMUX = Bun.which("tmux");
const BROWSER = Bun.which("terminal-browser");

if (!TMUX) { console.error("tmux not found"); process.exit(1); }
if (!BROWSER) {
  console.error("terminal-browser not found — install it with:");
  console.error("  curl -fsSl https://terminal-browser.sh/install | bash");
  process.exit(1);
}

const home = mkdtempSync(join(tmpdir(), "jmux-browser-e2e-"));
mkdirSync(join(home, ".config", "jmux"), { recursive: true });
// Force graphics on: this pty is not a terminal that would answer jmux's own
// capability probe, and imagesOn() is the switch the relay hangs off.
writeFileSync(
  join(home, ".config", "jmux", "config.json"),
  JSON.stringify({ images: { enabled: true } }),
);

let output = "";
let exitCode: number | null = null;
let answered = 0;
/** Every kitty image id we have seen a frame transmitted under. */
const imageIds = new Set<string>();

const pty = new Terminal(process.execPath, ["run", join(JMUX, "src", "main.ts"), "--socket", SOCKET], {
  name: "xterm-256color",
  cols: 160,
  rows: 44,
  env: {
    ...process.env,
    HOME: home,
    TERM: "xterm-256color",
    JMUX: "",
    TMUX: "",
    TMUX_PANE: "",
  },
});

/** Cell geometry this stand-in terminal claims, chosen to be nothing's default. */
const CELL_W = 9;
const CELL_H = 19;

pty.onData((d: string) => {
  output += d;
  // Answer capability queries like a real terminal. Not scaffolding: without a
  // reply terminal-browser falls all the way back to inline base64, and the
  // shared-memory and file transports — the ones that actually get used — never
  // run through jmux at all.
  for (const m of d.matchAll(/\x1b_G([^\x1b\x07]*?)(?:\x1b\\|\x07)/g)) {
    const keys = m[1].split(";")[0];
    const id = (keys.match(/(?:^|,)i=(\d+)/) ?? [])[1];
    if (/(^|,)a=q(,|$)/.test(keys)) {
      answered++;
      pty.write(`\x1b_Gi=${id ?? "0"};OK\x1b\\`);
    } else if (/(^|,)a=T(,|$)/.test(keys) && id) {
      // Which image each frame belongs to. Two panes sharing one id is the
      // whole of the "every browser pane shows the same page" bug.
      imageIds.add(id);
    }
  }
  // The cell-size query. jmux only publishes geometry to tmux once a real
  // terminal has told it some — an unanswered probe leaves `imageCellPx` at its
  // fallback, and asserting a guess is no better than the guess tmux already
  // has. A harness that stays silent here is not standing in for a terminal.
  if (d.includes("\x1b[16t")) pty.write(`\x1b[6;${CELL_H};${CELL_W}t`);
});
pty.onExit((e: { exitCode: number }) => { exitCode = e.exitCode; });

/** One byte at a time — jmux discards merged input chunks. */
async function send(keys: string) {
  for (const ch of keys) {
    pty.write(ch);
    await Bun.sleep(40);
  }
}

const graphicsApcs = (s: string) => s.match(/\x1b_G[^\x1b\x07]*(?:\x1b\\|\x07)/g) ?? [];
const placeholders = (s: string) => (s.match(/\u{10EEEE}/gu) ?? []).length;

function cleanup() {
  try { pty.kill(); } catch {}
  Bun.spawnSync([TMUX!, "-L", SOCKET, "kill-server"], { stdout: "ignore", stderr: "ignore" });
  rmSync(join(process.env.TMUX_TMPDIR || `/tmp/tmux-${process.getuid?.() ?? 0}`, SOCKET), { force: true });
  rmSync(home, { recursive: true, force: true });
}

const failures: string[] = [];
function check(name: string, ok: boolean, detail: string) {
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(name);
}

console.log("booting jmux…");
await Bun.sleep(7000);
if (exitCode !== null) {
  console.error(`jmux exited early (code ${exitCode})`);
  console.error(output.slice(-2000));
  cleanup();
  process.exit(1);
}

console.log("opening a browser pane (Ctrl-a b)…");
const before = output.length;
await send("\x01b");

for (let i = 0; i < 40; i++) {
  await Bun.sleep(1000);
  if (graphicsApcs(output.slice(before)).some((a) => a.includes("a=T"))) break;
}
const drawn = output.slice(before);
const apcs = graphicsApcs(drawn);
const transmits = apcs.filter((a) => a.includes("a=T"));

console.log("\nresults:");
check("terminal-browser started and drew", transmits.length > 0, `${transmits.length} transmits`);
check("probe replies reached the pane", answered > 0, `${answered} answered`);
check("placement composited as placeholder cells", placeholders(drawn) > 0, `${placeholders(drawn)} cells`);
check(
  "tmux's passthrough wrapper was stripped",
  !drawn.includes("\x1bPtmux;"),
  "no DCS reached the terminal",
);
check(
  "still using virtual placements",
  transmits.some((a) => /(^|,)U=1(,|$)/.test(a.split(";")[0])),
  "U=1 present",
);
check(
  "payload did not leak into the frame as text",
  !/[A-Za-z0-9+/]{200,}/.test(drawn.replace(/\x1b_G[^\x1b\x07]*(?:\x1b\\|\x07)/g, "")),
  "",
);
const media = [...new Set(apcs.map((a) => (a.match(/(?:^|,)t=([sfd])/) ?? [])[1]).filter(Boolean))];
console.log(`        transport media in use: ${media.join(", ") || "none"}`);

// The placement has to cover the pane exactly. Short of it letterboxes; over it
// overflows into whatever is next door. Both look like "the browser doesn't fit".
const tmux = (args: string[]) =>
  new TextDecoder().decode(Bun.spawnSync([TMUX!, "-L", SOCKET, ...args]).stdout).trim();
const paneRow = tmux(["list-panes", "-a", "-F", "#{pane_current_command}|#{pane_width}|#{pane_height}|#{pane_pid}"])
  .split("\n").find((l) => l.startsWith("terminal-brows"));
const last = transmits[transmits.length - 1] ?? "";
const placed = {
  c: Number((last.match(/(?:^|,)c=(\d+)/) ?? [])[1]),
  r: Number((last.match(/(?:^|,)r=(\d+)/) ?? [])[1]),
};
if (paneRow) {
  const [, w, h, pid] = paneRow.split("|");
  check(
    "placement covers the pane exactly",
    placed.c === Number(w) && placed.r === Number(h),
    `placed ${placed.c}x${placed.r}, pane ${w}x${h}`,
  );
  // The layout knob only works if it survives the split into the pane's
  // environment — tmux's `-e`, not this process's env.
  const paneEnv = new TextDecoder().decode(Bun.spawnSync(["ps", "-p", pid, "-wwE", "-o", "command="]).stdout);
  check(
    "display scale reached the browser process",
    /TERMINAL_BROWSER_DISPLAY_SCALE=\d/.test(paneEnv),
    (paneEnv.match(/TERMINAL_BROWSER_DISPLAY_SCALE=\S+/) ?? ["absent"])[0],
  );
  // Uncapped, terminal-browser renders at the fastest refresh rate among *all*
  // displays — 120 on a machine with one ProMotion panel, whichever screen the
  // terminal is on. Every frame is a whole-canvas blit for the terminal.
  check(
    "frame rate cap reached the browser process",
    /TERMINAL_BROWSER_FPS=\d/.test(paneEnv),
    (paneEnv.match(/TERMINAL_BROWSER_FPS=\S+/) ?? ["absent"])[0],
  );

  // The browser sizes its canvas from the cell geometry tmux reports. 16×32 is
  // tmux's fallback for "nobody told me", and seeing it here means
  // src/pty-pixels.ts is not reaching tmux — the canvas then has an aspect its
  // pane does not.
  const s = Number((last.match(/(?:^|,)s=(\d+)/) ?? [])[1]);
  const v = Number((last.match(/(?:^|,)v=(\d+)/) ?? [])[1]);
  const cellW = s / placed.c, cellH = v / placed.r;
  const tmuxCell = tmux(["display", "-p", "-t", pid, "#{window_cell_width}x#{window_cell_height}"]);
  check(
    "browser sized its canvas from the geometry this terminal reported",
    cellW === CELL_W && cellH === CELL_H,
    `canvas implies ${cellW}x${cellH}, terminal said ${CELL_W}x${CELL_H}, tmux reports ${tmuxCell}`,
  );
} else {
  check("browser pane found in tmux", false, "no pane running terminal-browser");
}

// A second pane. terminal-browser will happily host both as sessions of one
// process and give them the same kitty image id, at which point both panes draw
// the same page — the sessions stay separate underneath, so only the picture is
// wrong, which is why it is so confusing to look at.
console.log("\nopening a second browser pane…");
const idsBefore = new Set(imageIds);
await send("\x01b");
for (let i = 0; i < 40; i++) {
  await Bun.sleep(1000);
  if ([...imageIds].some((id) => !idsBefore.has(id))) break;
}
check(
  "a second browser pane draws its own image, not the first one's",
  imageIds.size >= 2,
  `image ids in play: ${[...imageIds].join(", ") || "none"}`,
);

console.log("\nopening a modal over it (Ctrl-a p)…");
const beforeModal = output.length;
await send("\x01p");
await Bun.sleep(2000);
const withModal = output.slice(beforeModal);
check(
  "a modal withdraws the placement",
  withModal.length > 0 && placeholders(withModal) === 0,
  `${placeholders(withModal)} cells behind the modal`,
);

cleanup();
if (failures.length) {
  console.error(`\n${failures.length} check(s) failed: ${failures.join(", ")}`);
  process.exit(1);
}
console.log("\nall checks passed");
