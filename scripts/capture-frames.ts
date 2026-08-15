// Capture composited jmux frames as data, for the website's scroll demo.
//
// The site needs a picture of jmux in ten different states. Screenshots drift:
// they are taken once, by hand, and nothing fails when the chrome they show
// stops being the chrome jmux draws. So the frames are *captured from a running
// jmux* instead, and the capture reads the same bytes a real terminal would.
//
// Nothing in src/ is touched to make this work. jmux already writes SGR to
// stdout and already owns the module that turns those bytes back into a
// CellGrid (`ScreenBridge`, which is how it reads tmux's own output). Pointing
// the second at the first is the whole mechanism:
//
//     pty(jmux --demo) → ScreenBridge → CellGrid → run-length JSON → site
//
// Demo mode is not a convenience here, it is the isolation boundary: it stands
// up its own tmux socket, its own config.json and its own seeded repos, so a
// capture can never touch the developer's live jmux or rewrite their real
// config.
//
// Usage: bun run scripts/capture-frames.ts [--out <dir>] [--keep]

import { Terminal } from "bun-pty";
import { ScreenBridge } from "../src/screen-bridge";
import { PREFIX_BYTE, PREFIX_LABEL } from "../src/prefix";
import type { Cell, CellGrid, CursorPosition } from "../src/types";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { hostname, tmpdir, userInfo } from "os";
import { join, resolve } from "path";

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

// Fixed for every frame in a run. The site lays the grid out with one CSS
// `ch`/line-height per cell, so a beat captured at a different size would not
// merely look different — it would not stack with its neighbours, and the
// pinned window would jump on the scroll boundary between them.
const COLS = 100;
const ROWS = 32;

/**
 * The background jmux is told the terminal has — `--bg` from the site's own
 * `.sbm` sidebar mockup, so the captured frames land on the colour the site
 * already draws a terminal on.
 *
 * jmux asks the terminal for its background with an OSC 11 query and derives
 * its whole surface palette from the answer (`deriveTheme`): modal surface,
 * selected row, hover, shadow. In a capture there is no terminal to answer, so
 * it falls back to `DEFAULT_THEME` and every surface comes out a shade the site
 * uses nowhere.
 *
 * Answering the query is not a trick — it is the same mechanism a real terminal
 * uses, so the captured chrome is genuinely what jmux draws for a user whose
 * terminal is this colour. Recolouring the frames on the page afterwards would
 * be the trick, and it would get the derived surfaces wrong.
 */
const TERMINAL_BG = { r: 0x20, g: 0x24, b: 0x2b };

/** An OSC 11 reply in the 16-bit-per-channel form xterm sends. */
function osc11Reply({ r, g, b }: { r: number; g: number; b: number }): string {
  const ch = (n: number) => (n * 257).toString(16).padStart(4, "0");
  return `\x1b]11;rgb:${ch(r)}/${ch(g)}/${ch(b)}\x1b\\`;
}

// ---------------------------------------------------------------------------
// The beats
// ---------------------------------------------------------------------------

const PREFIX = PREFIX_BYTE;
const ENTER = "\r";
const NAV_DOWN = "\x1b[1;6B"; // Ctrl-Shift-Down

/**
 * Display names for the bytes a beat sends.
 *
 * The page shows the keys beside the window, and the prose names them in
 * sentences. Deriving the caption from the sequence actually written to the pty
 * is what stops those two drifting: a beat retimed to press something else
 * relabels itself, rather than illustrating the old key while performing the
 * new one.
 */
const KEY_NAMES: Record<string, string> = {
  [PREFIX]: PREFIX_LABEL,
  [ENTER]: "Enter",
  [NAV_DOWN]: "Ctrl-Shift-↓",
  "\x1b": "Esc",
};

export function describeKeys(beat: Beat): string[] {
  const sent = [...beat.keys];
  // An advance loop presses one key until the screen says to stop. How many
  // times is a fact about demo data, not about the interaction being shown, so
  // it is named once.
  if (beat.advance) sent.push(beat.advance.key);

  const out: string[] = [];
  for (const key of sent) {
    // A chord is written as one string (PREFIX + "G") but read as two caps.
    let rest = key;
    while (rest.length > 0) {
      const named = Object.keys(KEY_NAMES).find((k) => rest.startsWith(k));
      if (named) {
        out.push(KEY_NAMES[named]!);
        rest = rest.slice(named.length);
      } else {
        // Typed text: one cap for the whole word, not one per letter.
        const upTo = Object.keys(KEY_NAMES).reduce((n, k) => {
          const i = rest.indexOf(k, 1);
          return i > 0 ? Math.min(n, i) : n;
        }, rest.length);
        out.push(rest.slice(0, upTo));
        rest = rest.slice(upTo);
      }
    }
  }
  return out;
}

export interface Beat {
  /** File name stem, and the id the page's scroll sections refer to. */
  id: string;
  /** What the frame is meant to show. Written into the JSON for the site. */
  label: string;
  /** Sent before the frame is taken. */
  keys: string[];
  /**
   * Repeat a key until the screen shows something, instead of pressing it a
   * fixed number of times. A count is a guess about how many rows the sidebar
   * has, which is demo data's business and changes without warning; a
   * predicate is a statement about the state the beat is trying to reach.
   */
  advance?: { key: string; until: string; max: number };
  /**
   * Text the captured frame must contain.
   *
   * This is the assertion that makes the whole approach worth more than
   * screenshots. Without it a mistimed keystroke yields a frame that is
   * perfectly valid, renders beautifully, and shows the wrong thing — which is
   * exactly the silent drift that captured frames exist to eliminate. Cheap to
   * write, and it fails the run rather than the reader.
   */
  expect: string[];
  /**
   * A binary this beat's screen is drawn by.
   *
   * The diff panel spawns `hunk` as a real process, so without it the beat
   * films an empty panel that still looks plausible. Missing means the run
   * fails: a capture that quietly drops a beat would publish a page with a gap
   * in it and report success.
   */
  requires?: string;
  /** Extra quiet time to allow after the keys, on top of the settle wait. */
  settleMs?: number;
}

// A "review" beat (the Diff tab, drawn by hunk) is deliberately absent — see
// docs/site-scroll-demo.md. Driving to that tab from the capture harness is
// unsolved: selecting Diff disables the very keys used to select it, and the
// tab renders hunk's pty output, which the assertion never saw. The `requires`
// field below is kept for it.
const BEATS: Beat[] = [
  {
    id: "fleet",
    label: "Five agents, one screen",
    // Demo mode opens grouped by stage. The page earns that grouping in beat
    // three, so the opener steps off it to a flat list first.
    keys: [PREFIX, "G"],
    // Sidebar names are truncated to the column width, so assertions match what
    // the sidebar can actually fit rather than the session's real name.
    expect: ["Flat", "api-paginati", "chart-perf"],
    settleMs: 500,
  },
  {
    id: "attention",
    label: "The one that stopped to ask",
    // Palette → the waiting session by name. Deliberately not "nav down N
    // times": the sidebar's order is a product decision that is allowed to
    // change, and a capture that counts rows would silently start landing on
    // the wrong session the day it does.
    keys: [PREFIX, "p", "auth", ENTER],
    expect: ["WAITING", "auth-refactor"],
    settleMs: 700,
  },
  {
    id: "ladder",
    label: "Grouped by your workflow stages",
    // Three presses back round to stage today. Driven by the label rather than
    // the count, so adding a grouping axis re-times this instead of breaking it.
    advance: { key: PREFIX + "G", until: "Stage", max: 6 },
    keys: [],
    expect: ["Stage", "In progress"],
    settleMs: 500,
  },
  {
    id: "ghosts",
    label: "Work that has no session yet",
    // Grouping by stage is what places ghost rows under their own stage band,
    // so this beat is the previous one held while the eye moves down.
    keys: [],
    expect: ["Stage", "In progress"],
    settleMs: 300,
  },
  {
    id: "preview",
    label: "A ticket, one keypress from being a session",
    // Ctrl-Shift-Down walks ghost rows as well as sessions; landing on one
    // opens the preview, which is the surface this beat is for.
    advance: { key: NAV_DOWN, until: "Starting will create", max: 14 },
    keys: [],
    expect: ["Starting will create", "worktree"],
    settleMs: 700,
  },
];

// ---------------------------------------------------------------------------
// Frame encoding
// ---------------------------------------------------------------------------

/**
 * A row as runs of same-styled text, rather than one record per cell.
 *
 * Terminal rows are overwhelmingly long stretches of one style — a 120-column
 * row of sidebar is typically under ten runs — so this is roughly a 15×
 * reduction over per-cell records, and it is also the shape the page wants:
 * one `<span>` per run is exactly what gets appended to the DOM.
 *
 * Tuple rather than an object because the field names would otherwise be
 * repeated for every run in every frame, and they compress worse than they
 * read.
 */
export type Run = [
  text: string,
  fg: number,
  bg: number,
  /** fgMode | bgMode << 2 */
  modes: number,
  /** bold 1 | italic 2 | underline 4 | dim 8 */
  flags: number,
  /** OSC 8 target. Present only on linked runs — most rows carry none. */
  link?: string,
];

/** One row's runs, or `null` for "unchanged since the previous frame". */
type DeltaRow = Run[] | null;

interface EncodedStep {
  /**
   * Every row on the first step of a film; only the rows that changed on the
   * rest, with `null` standing for "same as before".
   *
   * Consecutive frames of a terminal share almost everything — a keystroke
   * repaints a band of the sidebar and leaves the other twenty-five rows
   * exactly as they were. Storing those rows again, eight times per beat, is
   * most of what a film would otherwise cost.
   */
  rows: DeltaRow[];
  /** Terminal cursor, [col, row]. */
  cur: [number, number];
}

export interface EncodedFilm {
  id: string;
  label: string;
  cols: number;
  rows: number;
  /** Display forms of the keys this beat pressed, e.g. ["Ctrl-Space", "G"]. */
  keys: string[];
  steps: EncodedStep[];
}

/**
 * Paths that must not reach a committed frame.
 *
 * Demo mode roots its worktrees at `/tmp/jmux-demo-<pid>`, so the pre-flight
 * block renders a different string on every run — every capture would show a
 * diff, and the one thing worth noticing in that diff (the chrome changed)
 * would be buried under the one thing that never matters. The repo is public,
 * so a capture run with a real HOME must not be able to publish it either.
 *
 * Replacements are padded to the original's length. The grid is a fixed number
 * of columns and the site lays it out as one; a shorter string here would slide
 * everything after it left by the difference.
 */
const SCRUB: Array<[RegExp, string]> = [
  [/\/tmp\/jmux-demo-\d+\/repos/g, "~/code"],
  [/\/private\/var\/folders\/[^\s"]*?\/jmux-[A-Za-z0-9]+/g, "~/.local/share/jmux"],
  [new RegExp(escapeRe(process.env.HOME ?? "\0"), "g"), "~"],
  // The shell prompt renders whoever ran the capture — `jarred@jarred` on the
  // machine this was written on. Demo mode isolates config and repos but not
  // the OS, and the prompt is on screen in four of five beats.
  [new RegExp(escapeRe(`${userInfo().username}@${hostname().split(".")[0]}`), "g"), "dev@jmux"],
];

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function scrub(text: string): string {
  let out = text;
  for (const [pattern, replacement] of SCRUB) out = out.replace(pattern, replacement);
  if (out === text) return text;
  // Take the width back at the end of the run rather than at the match, so the
  // rest of the path stays joined to what it belongs to. A run's tail is
  // trailing space in every case this fires on.
  return out.length < text.length ? out.padEnd(text.length, " ") : out;
}

function flagsOf(cell: Cell): number {
  return (
    (cell.bold ? 1 : 0) | (cell.italic ? 2 : 0) | (cell.underline ? 4 : 0) | (cell.dim ? 8 : 0)
  );
}

function sameStyle(a: Cell, b: Cell): boolean {
  return (
    a.fg === b.fg &&
    a.bg === b.bg &&
    a.fgMode === b.fgMode &&
    a.bgMode === b.bgMode &&
    // A run is one `<span>`, and a linked span is an `<a>` — so a run that
    // straddled a link boundary would either lose the link or extend it over
    // text that never had one.
    a.link === b.link &&
    flagsOf(a) === flagsOf(b)
  );
}

/** One grid as rows of runs. The unit both the full frame and the delta use. */
export function encodeRows(grid: CellGrid): Run[][] {
  const lines: Run[][] = [];

  for (let y = 0; y < grid.rows; y++) {
    const runs: Run[] = [];
    let open: { cell: Cell; text: string } | null = null;

    for (let x = 0; x < grid.cols; x++) {
      const cell = grid.cells[y]![x]!;

      // Width-0 cells are the continuation half of a wide character. The
      // character itself is already in the run; emitting anything for the
      // continuation would double its width on a page that measures text in
      // `ch` units and knows nothing about East Asian width.
      if (cell.width === 0) continue;

      if (open && sameStyle(open.cell, cell)) {
        open.text += cell.char;
      } else {
        if (open) runs.push(toRun(open));
        open = { cell, text: cell.char };
      }
    }
    if (open) runs.push(toRun(open));

    // Trailing default-styled whitespace paints nothing, and dropping it is most
    // of the size win on a screen that is mostly empty main pane.
    //
    // Trimming *inside* the last run matters as much as dropping whole blank
    // ones: a row of text is followed by padding in the same default style, so
    // it encodes as one run of "text" plus sixty spaces rather than as a run
    // that can simply be popped. Only the final run is touched, and only when
    // nothing about it is visible — a background colour or an underline makes
    // trailing spaces something you can see.
    const paintsNothing = (run: Run): boolean =>
      run[2] === 0 && run[3] === 0 && run[4] === 0 && run[5] === undefined;

    while (runs.length > 0) {
      const last = runs[runs.length - 1]!;
      if (!paintsNothing(last)) break;
      last[0] = last[0].replace(/\s+$/, "");
      if (last[0] === "") runs.pop();
      else break;
    }

    lines.push(runs);
  }

  return lines;
}

function toRun(open: { cell: Cell; text: string }): Run {
  const c = open.cell;
  const run: Run = [scrub(open.text), c.fg, c.bg, c.fgMode | (c.bgMode << 2), flagsOf(c)];
  if (c.link) run.push(c.link);
  return run;
}

/**
 * A film as one full frame followed by deltas.
 *
 * Rows are compared by their encoded JSON rather than cell by cell, because the
 * encoded form is exactly what the page compares too — anything the encoder
 * flattens away (a colour that only differs on a blank cell, say) is not a
 * change the page could show, and re-sending the row for it would be a delta
 * carrying no information.
 */
export function encodeFilm(grids: Array<{ grid: CellGrid; cursor: CursorPosition }>, beat: Beat): EncodedFilm {
  const steps: EncodedStep[] = [];
  let previous: string[] | null = null;

  for (const { grid, cursor } of grids) {
    const lines = encodeRows(grid);
    const keys = lines.map((runs) => JSON.stringify(runs));
    const rows: DeltaRow[] =
      previous === null ? lines : lines.map((runs, y) => (keys[y] === previous![y] ? null : runs));
    steps.push({ rows, cur: [cursor.x, cursor.y] });
    previous = keys;
  }

  const first = grids[0]!.grid;
  return {
    id: beat.id,
    label: beat.label,
    cols: first.cols,
    rows: first.rows,
    keys: describeKeys(beat),
    steps,
  };
}

/**
 * Did anything survive scrubbing?
 *
 * Scrubbing runs per style run, so a path split across two runs by a colour
 * change would be rewritten only in part. Rather than reason about which
 * strings the renderer happens to style as one, the encoded film is read back
 * and checked — the failure mode being guarded against is a real path shipped
 * to a public site, which is not worth being clever about.
 */
function leaks(film: EncodedFilm): string[] {
  const text = film.steps
    .flatMap((step) => step.rows.map((runs) => (runs ?? []).map((r) => r[0]).join("")))
    .join("\n");
  const found = new Set<string>();
  for (const [pattern] of SCRUB) {
    for (const m of text.matchAll(new RegExp(pattern.source, "g"))) found.add(m[0]);
  }
  return [...found];
}

// ---------------------------------------------------------------------------
// Driving jmux
// ---------------------------------------------------------------------------

/**
 * Send one key.
 *
 * The two halves of this are opposite rules, and getting them the wrong way
 * round produces a frame that is valid and wrong:
 *
 * - An **escape sequence** must arrive as one read. `InputRouter` matches
 *   `Ctrl-Shift-Down` against a single anchored `\x1b[1;6B`; dribbled a byte at
 *   a time it never matches, and the bytes fall through to the pty, where they
 *   land on screen as a literal `[1;6B` next to the shell prompt.
 * - **Typed text** goes a byte at a time, because a chunk of several keystrokes
 *   is what the router discards.
 *
 * So: escape sequences whole, everything else split.
 */
async function sendKey(pty: Terminal, key: string): Promise<void> {
  if (key.length > 1 && key.startsWith("\x1b")) {
    pty.write(key);
  } else {
    for (const byte of key) {
      pty.write(byte);
      await Bun.sleep(28);
    }
  }
  // Let the router recognise this key as complete before the next one starts,
  // or two keys read as one sequence it has no binding for.
  await Bun.sleep(160);
}

async function typeKeys(pty: Terminal, keys: string[]): Promise<void> {
  for (const key of keys) await sendKey(pty, key);
}

/** Everything on screen, as plain text — the substrate for a beat's assertions. */
function frameText(grid: CellGrid): string {
  return grid.cells.map((row) => row.map((c) => c.char).join("")).join("\n");
}

/** One moment of the screen. */
interface Shot {
  grid: CellGrid;
  cursor: CursorPosition;
}

/**
 * How often the screen is read while a beat plays out.
 *
 * Fast enough that a repaint is not skipped over, slow enough that a beat is a
 * dozen frames rather than a hundred. The page interpolates nothing — it steps
 * from one captured frame to the next — so this is the demo's real frame rate.
 */
const SAMPLE_MS = 45;

/**
 * How long the pty must have been silent before a sample counts as a whole
 * frame. Long enough to sit past the gaps *within* one repaint's chunks, short
 * enough that a fast sequence still yields several frames.
 */
const FRAME_QUIET_MS = 30;

/**
 * Upper bound on a film's length, and the cost of exceeding it.
 *
 * An `advance` beat presses a key until the screen says stop, so its length is
 * set by demo data rather than by the interaction. Beyond the cap the film is
 * evenly downsampled — first and last always kept, since the last is the frame
 * every assertion ran against and the one the viewer rests on.
 */
const MAX_STEPS = 26;

/**
 * Drop frames that show nothing new, then cap the length.
 *
 * Most samples during a beat are identical: the screen is static between
 * keystrokes and while a settle is waited out. They compress to almost nothing
 * as deltas, but they are not free on the page — each is a step the scroll has
 * to travel through, so a film padded with twenty still frames plays as a
 * stutter followed by a jump.
 */
export function thin(shots: Shot[]): Shot[] {
  const distinct: Shot[] = [];
  let previous: string | null = null;
  for (const shot of shots) {
    const key = frameText(shot.grid) + `\x00${shot.cursor.x},${shot.cursor.y}`;
    if (key !== previous) distinct.push(shot);
    previous = key;
  }
  // A beat whose keys changed nothing on screen is still a beat — the page
  // needs one frame to show.
  if (distinct.length === 0) distinct.push(shots[shots.length - 1]!);
  if (distinct.length <= MAX_STEPS) return distinct;

  const kept: Shot[] = [];
  for (let i = 0; i < MAX_STEPS - 1; i++) {
    kept.push(distinct[Math.round((i * (distinct.length - 1)) / (MAX_STEPS - 1))]!);
  }
  kept.push(distinct[distinct.length - 1]!);
  return kept;
}

/** Resolve once the pty has produced no output for `quietMs`. */
function settle(state: { lastData: number }, quietMs: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((done) => {
    const tick = setInterval(() => {
      if (Date.now() - state.lastData >= quietMs || Date.now() > deadline) {
        clearInterval(tick);
        done();
      }
    }, 50);
  });
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const outIdx = argv.indexOf("--out");
  const outDir = resolve(outIdx >= 0 ? argv[outIdx + 1]! : "site/frames");
  const keep = argv.includes("--keep");

  if (!Bun.which("tmux")) {
    console.error("tmux is required to capture frames.");
    process.exit(1);
  }

  // Checked up front rather than per beat, so a missing tool is a message
  // before a minute of work rather than after it.
  const missingTools = [...new Set(BEATS.map((b) => b.requires).filter(Boolean))].filter(
    (tool) => !Bun.which(tool as string),
  );
  if (missingTools.length > 0) {
    console.error(
      `missing ${missingTools.join(", ")} — beats that draw with it cannot be captured.\n` +
        `install it, or the site would ship a section with a hole in it.`,
    );
    process.exit(1);
  }

  mkdirSync(outDir, { recursive: true });

  // A scratch HOME, for the same reason demo mode has its own config: the
  // capture must not read the developer's ~/.tmux.conf either, or the frames
  // carry whatever they happen to have bound that week.
  const home = mkdtempSync(join(tmpdir(), "jmux-capture-"));
  const bridge = new ScreenBridge(COLS, ROWS);
  const state = { lastData: Date.now() };
  const writes: Promise<void>[] = [];

  const pty = new Terminal(
    process.execPath,
    ["run", resolve(import.meta.dir, "..", "src", "main.ts"), "--demo"],
    {
      name: "xterm-256color",
      cols: COLS,
      rows: ROWS,
      env: {
        ...process.env,
        HOME: home,
        TERM: "xterm-256color",
        // Inherited from the developer's own jmux, and they would make jmux
        // think it is nested inside itself.
        JMUX: "",
        TMUX: "",
        TMUX_PANE: "",
      },
    },
  );

  // jmux probes for the background more than once (startup, and again after the
  // first resize), and takes the fallback theme if nothing answers — so this
  // answers every time it asks rather than only the first.
  let backgroundReplies = 0;
  pty.onData((data: string) => {
    state.lastData = Date.now();
    if (data.includes("\x1b]11;?")) {
      pty.write(osc11Reply(TERMINAL_BG));
      backgroundReplies++;
    }
    writes.push(bridge.write(data));
  });

  let exited = false;
  pty.onExit(() => {
    exited = true;
  });

  console.log(`capturing ${BEATS.length} beats at ${COLS}×${ROWS}`);

  // Demo mode seeds git repos and stands up a tmux server before the first
  // frame, which is seconds of work, so the boot wait is generous and quiet-
  // based rather than a fixed sleep.
  await settle(state, 2500, 90_000);

  if (exited) {
    console.error("jmux exited before the first frame — nothing to capture.");
    rmSync(home, { recursive: true, force: true });
    process.exit(1);
  }

  const manifest: Array<{
    id: string;
    label: string;
    file: string;
    bytes: number;
    steps: number;
  }> = [];
  const failures: string[] = [];

  /** Read the screen once everything in flight has landed. */
  const readShot = async (): Promise<Shot> => {
    await settle(state, 400, 10_000);
    // Every write() the bridge has been handed must have resolved before the
    // grid is read, or the frame is torn: the same reason main.ts gates
    // rendering on `writesPending`.
    await Promise.all(writes.splice(0));
    return { grid: bridge.getGrid(), cursor: bridge.getCursor() };
  };

  /** The screen right now, without waiting for it to settle. */
  const sample = async (): Promise<Shot> => {
    await Promise.all(writes.splice(0));
    return { grid: bridge.getGrid(), cursor: bridge.getCursor() };
  };

  // Put a real jmux surface in the main area, once, before any beat.
  //
  // This replaces a per-beat cleanup whose whole job was erasing debris the
  // driver itself caused: a prefix chord reaches a shell pane as `^A`, an
  // unbound sequence as its literal bytes. Erasing afterwards stops working the
  // moment a beat is filmed rather than photographed — the debris is on screen
  // for the frames in between, which is exactly what the film shows.
  //
  // `stty -echo` looks like the fix and is not: bash's readline sets its own
  // terminal modes at every prompt, so the echo is back before the next key
  // lands. The thing that actually works is having no shell reading input at
  // all. Opening the info panel does that, and it is also what the frames
  // wanted anyway — the main area stops being an empty prompt and starts being
  // the issue queue these beats keep talking about.
  await typeKeys(pty, [PREFIX, "g"]);
  await settle(state, 800, 10_000);

  // Start on the first session so the sidebar is scrolled to the top.
  //
  // Demo mode opens on a session far enough down the list that the rail is
  // scrolled, and a scrolled sidebar draws its clipped top row *into row 1* —
  // the header rule — producing `─○─DASH-330───┼─` across the separator. That
  // is a jmux rendering bug rather than a capture artifact (it survives a fully
  // settled read), and it is filed separately; this keeps it off the website in
  // the meantime by never opening in the state that triggers it.
  await typeKeys(pty, [PREFIX, "p", "api", ENTER]);
  await settle(state, 700, 10_000);

  for (const beat of BEATS) {
    // The film opens on the state the previous beat left, so the first thing it
    // shows is where the viewer already was.
    // Settled, not merely current: this one is read before the sampler starts,
    // so it is the one shot that would otherwise skip the quiet gate below —
    // and being step 0 it is the frame the beat opens on and rests at while the
    // reader arrives.
    const shots: Shot[] = [await readShot()];
    let sampling = true;
    const sampler = (async () => {
      while (sampling) {
        await Bun.sleep(SAMPLE_MS);
        // Only read the screen when the pty has gone briefly quiet.
        //
        // Awaiting the writes already handed to the bridge is not enough: a
        // single jmux repaint arrives as several pty chunks, so a sample taken
        // between them reads a half-applied frame — a band separator with a
        // row drawn through it, a sidebar that is partly the old grouping and
        // partly the new. It survives `thin()` (it is genuinely distinct from
        // its neighbours) and lands on the page as a glitch.
        if (Date.now() - state.lastData < FRAME_QUIET_MS) continue;
        shots.push(await sample());
      }
    })();

    await typeKeys(pty, beat.keys);

    if (beat.advance) {
      const { key, until, max } = beat.advance;
      let found = false;
      for (let i = 0; i < max; i++) {
        if (frameText((await sample()).grid).includes(until)) {
          found = true;
          break;
        }
        await sendKey(pty, key);
        // A beat's own settle time, not a fixed one: the diff tab spawns hunk
        // as a process and takes seconds to draw, so a 300ms look would step
        // past the very tab it was walking towards and report never finding it.
        await settle(state, 300, 5_000);
        if (beat.settleMs) await Bun.sleep(beat.settleMs);
      }
      if (!found && !frameText((await sample()).grid).includes(until)) {
        failures.push(`${beat.id}: never reached "${until}" in ${max} presses`);
      }
    }

    await settle(state, 600, 15_000);
    if (beat.settleMs) await Bun.sleep(beat.settleMs);

    sampling = false;
    await sampler;
    shots.push(await readShot());

    const grid = shots[shots.length - 1]!.grid;
    const text = frameText(grid);
    const missing = beat.expect.filter((want) => !text.includes(want));
    if (missing.length > 0) {
      failures.push(`${beat.id}: frame is missing ${missing.map((m) => `"${m}"`).join(", ")}`);
    }

    const film = encodeFilm(thin(shots), beat);
    const leaked = leaks(film);
    if (leaked.length > 0) {
      failures.push(`${beat.id}: unscrubbed path in frame — ${leaked.join(", ")}`);
    }

    const json = JSON.stringify(film);
    const file = `${beat.id}.json`;
    writeFileSync(join(outDir, file), json + "\n");
    manifest.push({
      id: beat.id,
      label: beat.label,
      file,
      bytes: json.length,
      steps: film.steps.length,
    });
    const mark = missing.length > 0 ? "✗" : "✓";
    console.log(
      `  ${mark} ${beat.id.padEnd(10)} ${(json.length / 1024).toFixed(1).padStart(5)} KB  ${beat.label}`,
    );
  }

  writeFileSync(
    join(outDir, "manifest.json"),
    JSON.stringify({ cols: COLS, rows: ROWS, beats: manifest }, null, 2) + "\n",
  );

  pty.kill();
  if (!keep) rmSync(home, { recursive: true, force: true });

  const total = manifest.reduce((n, m) => n + m.bytes, 0);
  console.log(`\n${manifest.length} frames → ${outDir}  (${(total / 1024).toFixed(1)} KB raw)`);

  // Silence here means jmux took its cold fallback theme and every frame is the
  // wrong colour — which reads as a styling choice on the page rather than as a
  // capture that failed, so it has to be said out loud.
  if (backgroundReplies === 0) {
    failures.push("jmux never asked for the terminal background — frames use the fallback theme");
  } else {
    console.log(`answered ${backgroundReplies} background probe(s) with #20242b`);
  }

  // The frames are written either way — a wrong frame is far easier to diagnose
  // by looking at it than by reading about it — but the run fails, so a capture
  // wired into a build can never quietly publish a screen nobody meant.
  if (failures.length > 0) {
    console.error(`\n${failures.length} beat(s) did not land:`);
    for (const f of failures) console.error(`  ✗ ${f}`);
    process.exit(1);
  }
}

// Guarded so the pure encoders above can be imported by a test without this
// spawning tmux on the importer's machine.
if (import.meta.main) await main();
