import type { CellGrid } from "../types";
import { createGrid, writeString, textCols, truncateToCols, type CellAttrs } from "../cell-grid";
import { tokens, space, frame } from "../chrome-tokens";
import type { OnboardingFlow } from "./flow";
import { INTENT_CHOICES, MAP_STEPS, type PageId } from "./pages";
import type { StepId } from "./status";
import type { InstallReport } from "../agent-hooks/registry";

/**
 * Every glyph this surface paints.
 *
 * Enumerated so a test can assert each is width-1 under `cellWidth`. The lesson
 * is on record from the workflow field: `!` beat `⚠` because `⚠`'s width varies
 * between terminals, and a glyph the column model scores differently from the
 * real cursor shears every cell after it on the row.
 */
export const GLYPHS = ["✓", "▸", "━", "─", "·", "•"] as const;

const CHECK = "✓";
const CURSOR = "▸";
const RAIL_FILLED = "━";
const RAIL_AHEAD = "─";

/** Left inset for everything on the page. */
export const INSET = 3;
/**
 * Rows the hairline and action bar own at the bottom, always.
 *
 * Shared by the painter and anything that clamps content, for the reason the
 * settings screen states: a hint line that moved as the cursor travelled would
 * cost more than the blank row it saved.
 */
export const BOTTOM_RESERVED_ROWS = 2;

const RAIL_COLS = 16;

/** The three keys the finish page teaches. `Ctrl-Space ?` carries every other. */
const WORTH_KNOWING: ReadonlyArray<readonly [string, string]> = [
  ["Ctrl-Space n", "start a new piece of work"],
  ["Ctrl-Space p", "the command palette — everything is in here"],
  ["Ctrl-Space ?", "every key jmux binds"],
];

/**
 * Wrap to the prose measure.
 *
 * Capped at `space.measure` regardless of how wide the surface is: a
 * 200-column paragraph is unreadable however much room exists for it, and long
 * lines are the fastest way to make a terminal read as a log.
 */
export function wrapProse(text: string, cols: number): string[] {
  // The narrower of the two: the measure keeps prose readable on a wide
  // terminal, and `cols` is a hard bound — wrapping wider than the surface can
  // paint would just push text under the clip.
  const measure = Math.max(1, Math.min(cols, space.measure));
  if (text.length === 0) return [""];
  const out: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    if (line.length === 0) { line = word; continue; }
    if (textCols(`${line} ${word}`) > measure) { out.push(line); line = word; }
    else line = `${line} ${word}`;
  }
  if (line.length > 0) out.push(line);
  return out;
}

interface Palette {
  title: CellAttrs; body: CellAttrs; dim: CellAttrs;
  ok: CellAttrs; accent: CellAttrs; ahead: CellAttrs; warn: CellAttrs;
}

function palette(): Palette {
  return {
    title: { ...tokens.accent, bold: true },
    body: { ...tokens.textPrimary },
    dim: { ...tokens.textTertiary },
    ok: { ...tokens.affirmative },
    accent: { ...tokens.accent },
    ahead: { ...tokens.ruleFrame },
    warn: { ...tokens.attention },
  };
}

/** Right-aligned x for `text`, never left of `floor`. */
function rightX(width: number, text: string, floor: number): number {
  return Math.max(floor, width - INSET - textCols(text));
}

function paintActionBar(grid: CellGrid, width: number, height: number, hints: string): void {
  const p = palette();
  const ruleRow = height - BOTTOM_RESERVED_ROWS;
  if (ruleRow >= 0) {
    writeString(grid, ruleRow, INSET, frame.ruleLight.repeat(Math.max(0, width - INSET * 2)), p.ahead);
  }
  writeString(grid, height - 1, INSET, truncateToCols(hints, Math.max(1, width - INSET * 2)), p.dim);
}

/**
 * The progress rail: position only.
 *
 * It deliberately says nothing about *state* — that lives on the map and in
 * each page's own body. A rail that also carried done/not-done would be a
 * second answer to a question the page already answers, which is how a header
 * ends up reading `1/5 done` above eight rows.
 */
function paintRail(grid: CellGrid, width: number, label: string | null): void {
  if (!label) return;
  const p = palette();
  const match = /^Step (\d+) of (\d+)$/.exec(label);
  const labelX = rightX(width, label, INSET);
  writeString(grid, 0, labelX, label, p.dim);
  if (!match) return;

  const at = Number(match[1]);
  const total = Number(match[2]);
  const barX = Math.max(INSET, labelX - RAIL_COLS - 2);
  if (barX + RAIL_COLS >= labelX) return; // no room; the words alone still say it

  const filled = Math.max(1, Math.round((at / total) * RAIL_COLS));
  writeString(grid, 0, barX, RAIL_FILLED.repeat(filled), p.accent);
  writeString(grid, 0, barX + filled, RAIL_AHEAD.repeat(RAIL_COLS - filled), p.ahead);
}

/**
 * The labels the map rows carry. Order comes from `MAP_STEPS`, which the
 * navigator reads too — two orderings is how a cursor ends up on a different
 * row than the one drawn.
 */
const MAP_LABELS: Record<StepId, string> = {
  projects: "Where your code lives",
  agents: "Letting jmux see your agents",
  naming: "Naming your sessions",
  tracker: "Connect an issue tracker",
  team: "Point a project at a team",
  workflow: "How your work moves",
};

const HINTS: Record<PageId | "map", string> = {
  map: "j/k move   ↵ open   esc close",
  welcome: "j/k choose   ↵ start",
  projects: "↵ add a directory   l next   h back   esc overview",
  agents: "↵ set these up   l next   h back   esc overview",
  naming: "↵ choose   l next   h back   esc overview",
  tracker: "↵ paste a token   l next   h back   esc overview",
  team: "l next   h back   esc overview",
  workflow: "↵ use these   l next   h back   esc overview",
  done: "↵ start your first session      esc close",
};

function paintWelcome(grid: CellGrid, flow: OnboardingFlow, width: number, y: number): void {
  const p = palette();
  const selected = flow.getIntentIndex();
  for (let i = 0; i < INTENT_CHOICES.length; i++) {
    const choice = INTENT_CHOICES[i]!;
    const isOn = i === selected;
    if (isOn) writeString(grid, y, INSET, CURSOR, p.accent);
    writeString(grid, y, INSET + 2,
      truncateToCols(choice.label, Math.max(1, width - INSET * 2 - 26)),
      isOn ? p.title : p.body);
    if (choice.cost) {
      writeString(grid, y, rightX(width, choice.cost, INSET + 2), choice.cost, p.dim);
    }
    writeString(grid, y + 1, INSET + 2,
      truncateToCols(choice.blurb, Math.max(1, width - INSET * 2 - 2)), p.dim);
    y += 3;
  }
}

function paintReports(
  grid: CellGrid, reports: InstallReport[], width: number, y: number, height: number,
): number {
  const p = palette();
  for (const report of reports) {
    if (y >= height - BOTTOM_RESERVED_ROWS) break;
    writeString(grid, y, INSET + 2,
      truncateToCols(report.label, Math.max(1, width - INSET * 2 - 24)), p.body);
    const done = report.kind === "installed" || report.kind === "migrated" || report.kind === "noop";
    // The words carry the meaning; the tick only reinforces it. Nothing here
    // needs a legend, which is the whole point.
    const note = report.kind === "failed"
      ? (report.notes[0] ?? "failed")
      : report.kind === "skipped"
        ? (report.notes[0] ?? "skipped")
        : report.kind === "noop"
          ? "already set up"
          : "set up";
    const text = truncateToCols(note, 28);
    const x = rightX(width, text, INSET + 4);
    if (done) writeString(grid, y, x - 2, CHECK, p.ok);
    writeString(grid, y, x, text, done ? p.dim : p.body);
    y += 1;
  }
  return y;
}

export interface RenderExtras {
  /** Result of the agents page's install, once it has run. */
  reports?: InstallReport[];
  /** Directories already configured, for the projects page. */
  projectDirs?: string[];
  /** Files the agents page will write, resolved from installer metadata. */
  writeTargets?: string[];
  /** One line per completed thing, for the finish page. */
  achievements?: string[];
  /** Busy message, shown while an async action runs. */
  busy?: string;
  /** A refusal, drawn on the page that caused it rather than in the toolbar. */
  notice?: string;
  /** Naming commands offered, and which one is in force. */
  namingOptions?: ReadonlyArray<{ id: string; label: string; note: string }>;
  namingChosen?: string;
  /**
   * Which map row the cursor is on.
   *
   * Without it the map's j/k move a cursor nobody can see and ↵ opens a step
   * the user did not knowingly choose — a key with no visible effect being
   * indistinguishable from a key that is broken.
   */
  mapIndex?: number;
}

/**
 * Paint the flow.
 *
 * `height` is honoured exactly: the action bar is bottom-pinned through
 * `BOTTOM_RESERVED_ROWS`, so the hint line never moves as the cursor travels.
 */
export function renderFlow(
  flow: OnboardingFlow,
  width: number,
  height: number,
  extras: RenderExtras = {},
): CellGrid {
  const grid = createGrid(width, height);
  const p = palette();

  if (flow.view() === "map") {
    writeString(grid, 0, INSET, "Set up jmux", p.title);
    writeString(grid, 0, rightX(width, "overview", INSET + 12), "overview", p.dim);

    const status = flow.getStatus();
    const cursor = extras.mapIndex ?? 0;
    let y = 2;
    for (let i = 0; i < MAP_STEPS.length; i++) {
      const id = MAP_STEPS[i]!;
      const label = MAP_LABELS[id];
      if (y >= height - BOTTOM_RESERVED_ROWS) break;
      const step = status.steps[id];
      if (i === cursor) writeString(grid, y, INSET - 2, CURSOR, p.accent);
      // One glyph, one meaning: a tick is done, its absence is not done, and
      // the right-hand column says what that amounts to in words.
      if (step.state === "satisfied") writeString(grid, y, INSET, CHECK, p.ok);
      const summary = truncateToCols(step.summary, 20);
      const sx = rightX(width, summary, INSET + 6);
      writeString(grid, y, INSET + 4,
        truncateToCols(label, Math.max(1, sx - INSET - 5)),
        step.state === "unavailable" ? p.dim : p.body);
      writeString(grid, y, sx, summary, p.dim);
      y += 1;
    }
    paintActionBar(grid, width, height, HINTS.map);
    return grid;
  }

  const page = flow.currentPage();
  const status = flow.getStatus();

  writeString(grid, 0, INSET,
    truncateToCols(page.title, Math.max(1, width - INSET * 2 - RAIL_COLS - 14)), p.title);
  paintRail(grid, width, flow.stepLabel());
  writeString(grid, 1, INSET,
    frame.ruleLight.repeat(Math.min(textCols(page.title), Math.max(0, width - INSET * 2))), p.ahead);

  let y = 3;
  for (const para of page.body(status)) {
    for (const line of wrapProse(para, width - INSET * 2)) {
      if (y >= height - BOTTOM_RESERVED_ROWS) break;
      writeString(grid, y, INSET, line, p.body);
      y += 1;
    }
    y += 1;
  }

  if (page.id === "welcome") {
    paintWelcome(grid, flow, width, y);
  } else if (page.id === "projects") {
    for (const dir of extras.projectDirs ?? []) {
      if (y >= height - BOTTOM_RESERVED_ROWS) break;
      writeString(grid, y, INSET + 2,
        truncateToCols(dir, Math.max(1, width - INSET * 2 - 2)), p.body);
      y += 1;
    }
    if ((extras.projectDirs ?? []).length === 0) {
      writeString(grid, y, INSET + 2, "Nothing yet.", p.dim);
    }
  } else if (page.id === "agents") {
    if (extras.reports && extras.reports.length > 0) {
      y = paintReports(grid, extras.reports, width, y, height);
    } else if (status.facts.agentsPresent.length > 0) {
      for (const label of status.facts.agentsPresent) {
        if (y >= height - BOTTOM_RESERVED_ROWS) break;
        const stale = status.facts.agentsStale.includes(label);
        const note = stale ? "not hooked up yet" : "hooked up";
        const text = truncateToCols(note, 24);
        const x = rightX(width, text, INSET + 4);
        if (!stale) writeString(grid, y, x - 2, CHECK, p.ok);
        writeString(grid, y, INSET + 2,
          truncateToCols(label, Math.max(1, x - INSET - 4)), p.body);
        writeString(grid, y, x, text, p.dim);
        y += 1;
      }
      // Rendered from installer metadata, never hard-coded: every path
      // resolves from the environment, so prose would be wrong on a relocated
      // config — and consent that names the wrong file is not consent.
      const targets = extras.writeTargets ?? [];
      if (targets.length > 0 && y + 1 < height - BOTTOM_RESERVED_ROWS) {
        y += 1;
        writeString(grid, y, INSET, "Will write to", p.dim);
        y += 1;
        for (const target of targets) {
          if (y >= height - BOTTOM_RESERVED_ROWS) break;
          writeString(grid, y, INSET + 2,
            truncateToCols(target, Math.max(1, width - INSET * 2 - 2)), p.dim);
          y += 1;
        }
      }
    }
  } else if (page.id === "naming") {
    for (const option of extras.namingOptions ?? []) {
      if (y >= height - BOTTOM_RESERVED_ROWS) break;
      const chosen = option.id === extras.namingChosen;
      if (chosen) writeString(grid, y, INSET, CHECK, p.ok);
      writeString(grid, y, INSET + 3,
        truncateToCols(option.label, Math.max(1, width - INSET * 2 - 34)),
        chosen ? p.body : p.dim);
      const note = truncateToCols(option.note, 30);
      writeString(grid, y, rightX(width, note, INSET + 6), note, p.dim);
      y += 1;
    }
  } else if (page.id === "done") {
    for (const line of extras.achievements ?? []) {
      if (y >= height - BOTTOM_RESERVED_ROWS) break;
      writeString(grid, y, INSET, CHECK, p.ok);
      writeString(grid, y, INSET + 3,
        truncateToCols(line, Math.max(1, width - INSET * 2 - 3)), p.body);
      y += 1;
    }
    // The keys, because a finish that only ticks boxes has said nothing about
    // what to actually do next — and this is the last moment anyone is
    // reading. Ctrl-Space ? carries the rest, so this stays three.
    if (y + 2 < height - BOTTOM_RESERVED_ROWS) {
      y += 1;
      writeString(grid, y, INSET, "Three things worth knowing", p.dim);
      y += 2;
      for (const [key, what] of WORTH_KNOWING) {
        if (y >= height - BOTTOM_RESERVED_ROWS) break;
        writeString(grid, y, INSET + 3, key, p.accent);
        writeString(grid, y, INSET + 17,
          truncateToCols(what, Math.max(1, width - INSET - 18)), p.body);
        y += 1;
      }
    }
  }

  // A refusal belongs on the page that caused it. Sent to the toolbar's status
  // chip it is transient, far from a centred modal, and reads as nothing
  // having happened at all.
  const footnote = extras.busy ?? extras.notice;
  if (footnote && height - BOTTOM_RESERVED_ROWS - 1 > 0) {
    writeString(grid, height - BOTTOM_RESERVED_ROWS - 1, INSET,
      truncateToCols(footnote, Math.max(1, width - INSET * 2)),
      extras.busy ? p.accent : p.warn);
  }

  // The bar describes what the keys do *now*, never what the page is for in
  // general. "set these up" after installing invites a press that would repeat
  // finished work, and "use these" with no tracker connected advertises an
  // action with nothing to act on — a key that silently does nothing being the
  // failure this codebase names most often.
  const installed = page.id === "agents" && (extras.reports?.length ?? 0) > 0;
  const noAgents = page.id === "agents" && status.facts.agentsPresent.length === 0;
  const nothingToSeed = page.id === "workflow" && !status.facts.trackerAuthed;
  const nothingToName = page.id === "naming" && status.facts.namingAvailable.length === 0;
  const hints = installed || noAgents || nothingToSeed || nothingToName
    ? "l next   h back   esc overview"
    : HINTS[page.id];
  paintActionBar(grid, width, height, hints);
  return grid;
}
