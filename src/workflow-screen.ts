// The workflow screen: the one place the issue pipeline is configured.
//
// It is about defining **your own workflow stages** — Urgent, To do,
// In Progress, Waiting — each sitting on top of one or many of your tracker's
// statuses. A tracker gives you 25 states shared across every team; your own
// ladder has four rungs. A stage renders as a tab in the info panel, but that
// is how it shows up, not what it is.
//
// Every status then has two settings and no more:
//
//     which stage it belongs to  — where it shows in the panel
//     whether it parks           — whether its session leaves the sidebar
//
// Configuring this used to mean holding seven concepts at once — tabs,
// sections, statuses, stages, park-stages, unpark-triggers, transitions.
// Successive rounds removed most of them rather than rearranging them. The
// four lifecycle values (`idea`/`active`/`parked`/`done`) survive internally
// but are never authored: they come from the tracker's own state categories,
// because nothing branches on the distinction between three of them. And there
// is no second "these stages park" switch to confirm the first — that
// tautology, with its own off switch, is how parking came to look configured
// while doing nothing.
//
// The screen is two blocks, because it edits two different kinds of thing and
// interleaving them made every key contextual:
//
//   YOUR WORKFLOW — your stages. Create, rename, reorder, delete, up-next.
//   STATUSES      — a table, one row per tracker status, one row type, a column
//                   per setting. Every row does exactly the same thing.
//
// Two rules hold the rest together:
//
//   * **Subheadings are derived, not configured.** A stage holding more than
//     one status groups its issues under those status names in the panel; a
//     stage holding one draws no subheading at all. There used to be a heading
//     you named by hand — it only ever restated the status inside it.
//   * **Nothing hands off to a Modal.** Pickers, prompts and confirms are
//     painted into this screen's own grid. A full-screen surface consumes every
//     keystroke while open, so a modal opened from one renders nothing and
//     never receives a key — a bug this codebase has hit twice.

import type { CellGrid } from "./types";
import { createGrid, writeString, writeStyledLine, textCols, truncateToCols, type CellAttrs } from "./cell-grid";
import { tokens, space, frame } from "./chrome-tokens";
import { layoutFooter, type FooterSegment } from "./footer";
import { drawSettingRow, type SettingDef } from "./settings-screen";
import {
  assignStateToView, createView, deleteView, moveStateInView, moveView,
  renameView, stateIndexInView, suggestLayout, unassignState, isParkedState,
  stageInSidebar, stageShowsUnstarted, toggleViewInSidebar, toggleViewUnstarted,
  type PanelView,
} from "./panel-view";
import type { WorkStage } from "./repo-settings";
import type { IssueStateType } from "./adapters/types";

// --- Colours ---
//
// Every attr object here is patched in place by rebuildWorkflowColors() so a
// theme change re-tones the screen without re-importing, matching how
// settings-screen.ts and modal.ts handle the same problem.

const TITLE_ATTRS: CellAttrs = {};
const BAND_ATTRS: CellAttrs = {};
const HAIRLINE_ATTRS: CellAttrs = {};
const LABEL_ATTRS: CellAttrs = {};
const LABEL_ACTIVE: CellAttrs = {};
const LABEL_MUTED: CellAttrs = {};
const VALUE_ATTRS: CellAttrs = {};
const DIM_ATTRS: CellAttrs = {};
const PARK_ATTRS: CellAttrs = {};
const ADD_ATTRS: CellAttrs = {};
const CURSOR_ATTRS: CellAttrs = {};
const EXPLAIN_ATTRS: CellAttrs = {};
const WARN_ATTRS: CellAttrs = {};
const EDIT_TEXT: CellAttrs = {};
const EDIT_CURSOR: CellAttrs = {};

export function rebuildWorkflowColors(): void {
  const assign = (target: CellAttrs, src: CellAttrs): void => {
    delete target.bold;
    delete target.dim;
    Object.assign(target, src);
  };
  assign(TITLE_ATTRS, { ...tokens.accent, bold: true });
  assign(BAND_ATTRS, tokens.textSecondary);
  assign(HAIRLINE_ATTRS, tokens.ruleHairline);
  assign(LABEL_ATTRS, tokens.textPrimary);
  assign(LABEL_ACTIVE, { ...tokens.accent, bold: true });
  assign(LABEL_MUTED, tokens.textTertiary);
  assign(VALUE_ATTRS, tokens.textSecondary);
  assign(DIM_ATTRS, tokens.textTertiary);
  assign(PARK_ATTRS, tokens.attention);
  assign(ADD_ATTRS, tokens.accentMuted);
  assign(CURSOR_ATTRS, tokens.accent);
  assign(EXPLAIN_ATTRS, tokens.textSecondary);
  assign(WARN_ATTRS, tokens.failure);
  assign(EDIT_TEXT, { ...tokens.textPrimary, bold: true });
  assign(EDIT_CURSOR, tokens.accent);
}
rebuildWorkflowColors();

// Wider than `space.measure` (64, sized for prose): these rows carry a status
// name, a destination, a meaning and a count, and 64 columns squeezes the
// destination out of tabs with long names.
const MEASURE = 78;
// Row 0 is the title, row 1 a breathing row; content starts at row 2. Shared
// between render() and ensureVisible() so the two can't drift.
const CONTENT_START_ROW = 2;

// --- Inputs ---

export type SettingsTier = "global" | "repo";

/** A titled run of setting rows below the mapping — parking, up-next, writes. */
export interface WorkflowBand {
  label: string;
  settings: SettingDef[];
  /** Shown on the explain line while the band header itself is selected. */
  hint?: string;
}

/**
 * Everything the screen reads and writes, in the same getter/callback dialect
 * as `SettingDef`. Keeping the whole outside world behind this one interface is
 * what lets the screen be unit-tested without tmux, a tracker, or a config file.
 */
export interface WorkflowPort {
  /** Every tab in panel order, including `mrs` tabs (shown, not editable). */
  getViews(): PanelView[];
  /** Swap in an edited tab list and persist it. */
  setViews(next: PanelView[]): void;
  /** Every status the tracker offers; empty when it is not connected. */
  getStatuses(): ReadonlyArray<{ name: string; type: IssueStateType }>;
  /** Issues sitting in each status right now, keyed by lowercased name. */
  getIssueCounts(): ReadonlyMap<string, number>;
  /** Sessions each status currently parks, keyed by lowercased name. */
  getParkedCounts(): ReadonlyMap<string, number>;
  /** Statuses whose sessions park. */
  getParkedStates(): readonly string[];
  /** Add a status to the parked list, or take it out. */
  toggleParked(state: string): void;
  /** Ordered stage ids in the `Ctrl-a u` rotation. */
  getUpNext(): readonly string[];
  /** Add a tab to the rotation, or drop it. Appending is what sets priority. */
  toggleUpNext(viewId: string): void;
  /** The behaviour bands for the given tier, rebuilt on demand. */
  getBands(tier: SettingsTier): WorkflowBand[];
  /** Display name of the tracker, or null when it is not connected. */
  trackerLabel(): string | null;
  /** Repo whose overrides the `repo` tier edits, or null when there is none. */
  repoLabel(): string | null;
}

// --- Row model ---

export type WorkflowRow =
  | { kind: "seed"; tabs: number; statuses: number }
  | { kind: "band"; label: string; hint?: string }
  /** TABS block: one per tab, plus the row that makes a new one. */
  | {
      kind: "tab"; viewId: string; label: string; source: "issues" | "mrs";
      statuses: number; parks: number; issues: number; upNextRank: number | null;
      /** 1-based position among the issues stages, and how many there are.
       * Carried so `explainRow` can state the thing ⇧↑↓ changes. */
      position: number; stageCount: number;
      /** Sidebar visibility, and whether unstarted work shows under it. */
      inSidebar: boolean; showUnstarted: boolean;
    }
  | { kind: "new-tab" }
  /** STATUSES block: the column headings, then one row per tracker status. */
  | { kind: "columns" }
  | {
      kind: "status"; state: string; viewId: string | null; viewLabel: string | null;
      parks: boolean; issues: number; parked: number; known: boolean;
    }
  | { kind: "setting"; def: SettingDef };

const norm = (s: string): string => s.trim().toLowerCase();

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/**
 * The whole screen as one ordered list of rows: the TABS block, then the
 * STATUSES table, then the behaviour bands.
 *
 * The table lists every status the tracker offers *and* every status the config
 * mentions. A status renamed in Linear must stay visible and fixable rather
 * than silently vanishing into config nobody can see.
 */
export function buildRows(port: WorkflowPort, tier: SettingsTier): WorkflowRow[] {
  const views = port.getViews();
  const statuses = port.getStatuses();
  const issueCounts = port.getIssueCounts();
  const parkedCounts = port.getParkedCounts();
  const parkedStates = port.getParkedStates();
  const upNext = port.getUpNext();
  const known = new Set(statuses.map((s) => norm(s.name)));
  const count = (state: string): number => issueCounts.get(norm(state)) ?? 0;

  const rows: WorkflowRow[] = [];
  const configured = views.some((v) => v.source === "issues" && (v.states?.length ?? 0) > 0);
  if (!configured && statuses.length > 0) {
    rows.push({ kind: "seed", tabs: suggestLayout(statuses).length, statuses: statuses.length });
  }

  rows.push({
    kind: "band", label: "Your workflow",
    // The order is load-bearing — it drives the panel's tab strip and the
    // sidebar's stage bands — but nothing about a static list says it can be
    // rearranged, so the key is named here rather than left to the footer,
    // where it sits fifth in a six-segment run and reads as noise.
    hint: "The stages you work in, top to bottom in priority order — ⇧↑↓ to rearrange. Each is a tab in the info panel.",
  });
  const stageCount = views.filter((v) => v.source === "issues").length;
  let position = 0;
  for (const view of views) {
    const states = view.states ?? [];
    const rank = upNext.indexOf(view.id);
    if (view.source === "issues") position++;
    rows.push({
      kind: "tab", viewId: view.id, label: view.label, source: view.source,
      statuses: states.length,
      parks: states.filter((s) => isParkedState(parkedStates, s)).length,
      issues: states.reduce((n, s) => n + count(s), 0),
      upNextRank: rank >= 0 ? rank : null,
      position, stageCount,
      inSidebar: stageInSidebar(view),
      showUnstarted: stageShowsUnstarted(view),
    });
  }
  rows.push({ kind: "new-tab" });

  // The table, in tab order then config order — which is priority order — with
  // statuses in no tab last, where they read as the remaining to-do list.
  const placed: WorkflowRow[] = [];
  const claimed = new Set<string>();
  for (const view of views) {
    if (view.source !== "issues") continue;
    for (const state of view.states ?? []) {
      claimed.add(norm(state));
      placed.push({
        kind: "status", state, viewId: view.id, viewLabel: view.label,
        parks: isParkedState(parkedStates, state),
        issues: count(state), parked: parkedCounts.get(norm(state)) ?? 0,
        known: known.has(norm(state)),
      });
    }
  }
  for (const s of statuses) {
    if (claimed.has(norm(s.name))) continue;
    placed.push({
      kind: "status", state: s.name, viewId: null, viewLabel: null,
      parks: isParkedState(parkedStates, s.name),
      issues: count(s.name), parked: parkedCounts.get(norm(s.name)) ?? 0,
      known: true,
    });
  }

  rows.push({
    kind: "band", label: "Statuses",
    hint: statuses.length === 0
      ? "Connect an issue tracker under Settings → Integrations to map your statuses."
      : "Two settings each: which stage of your workflow it belongs to, and whether its work parks.",
  });
  if (placed.length > 0) rows.push({ kind: "columns" });
  rows.push(...placed);

  for (const band of port.getBands(tier)) {
    rows.push({ kind: "band", label: band.label, hint: band.hint });
    for (const def of band.settings) rows.push({ kind: "setting", def });
  }

  return rows;
}

/** Rows a cursor may land on. Band headers are labels, not targets. */
export function isSelectable(row: WorkflowRow): boolean {
  return row.kind !== "band" && row.kind !== "columns";
}

/**
 * What the selected row means and what it will do — the answer to the question
 * the old settings surface could never answer in one place. Every silent
 * failure this feature shipped with has a sentence here.
 */
export function explainRow(row: WorkflowRow | undefined): string {
  if (!row) return "";

  switch (row.kind) {
    case "seed":
      return `Builds ${row.tabs} tabs from your tracker's own categories. Nothing is set to park.`;

    case "tab": {
      if (row.source === "mrs") return `${row.label} · a merge-request tab, not a workflow stage.`;
      // Position leads: it is what ⇧↑↓ changes, and what the panel's tab order
      // and the sidebar's stage bands both follow.
      const parts = [
        `${row.label} · ${ordinal(row.position)} of ${row.stageCount}`,
        plural(row.statuses, "status", "statuses"),
        plural(row.issues, "issue"),
      ];
      // Said in full rather than by glyph: "hidden" is the one state where the
      // sidebar stops matching this screen, and the reason its sessions have not
      // vanished is not guessable from a marker.
      parts.push(!row.inSidebar
        ? "no band in the sidebar — its sessions fall to the bottom, ungrouped"
        : row.showUnstarted
          ? "shows its unstarted work in the sidebar"
          : "in the sidebar, without its unstarted work");
      if (row.parks > 0) parts.push(`${row.parks} of them park`);
      parts.push(row.upNextRank !== null
        ? `${ordinal(row.upNextRank + 1)} in Up next`
        : "not in Up next");
      return parts.join(" · ");
    }

    case "status": {
      const parts = [row.state, plural(row.issues, "issue")];
      if (!row.known) parts.push("no longer in your tracker");
      parts.push(row.viewLabel === null
        ? "in none of your stages — it never shows in the panel"
        : row.viewLabel);
      parts.push(row.parks
        ? (row.parked > 0 ? `parks its sessions (${row.parked} now)` : "parks its sessions")
        : "its sessions stay in the sidebar");
      return parts.join(" · ");
    }

    case "new-tab":
      return "A stage is one step in your own workflow, covering one or more of your tracker's statuses.";

    case "band":
      return row.hint ?? "";

    case "columns":
      return "";

    case "setting":
      return row.def.describe?.() ?? "";
  }
}

function ordinal(n: number): string {
  const suffix = n % 100 >= 11 && n % 100 <= 13 ? "th"
    : n % 10 === 1 ? "st" : n % 10 === 2 ? "nd" : n % 10 === 3 ? "rd" : "th";
  return `${n}${suffix}`;
}

// --- Destinations ---

export interface Destination {
  id: string;
  label: string;
  annotation?: string;
}

/**
 * Where a status can go: one entry per stage, plus "no stage". There used to be
 * extra entries for named sub-headings inside a stage; the panel derives those
 * from the status names now, so there is nothing further to choose.
 */
export function destinationsFor(views: PanelView[], state: string): Destination[] {
  const out: Destination[] = [];
  for (const view of views) {
    if (view.source !== "issues") continue;
    out.push({
      id: view.id,
      label: view.label,
      annotation: stateIndexInView(state, view.states) >= 0 ? "already here" : "",
    });
  }
  out.push({ id: "\x00none", label: "No stage", annotation: "never shown" });
  return out;
}

/**
 * Apply a chosen destination. Assignment always removes the status from
 * wherever it was, so one status has exactly one home and therefore one place
 * in the panel.
 */
export function applyDestination(views: PanelView[], state: string, destId: string): PanelView[] {
  if (destId === "\x00none") return unassignState(views, state);
  return assignStateToView(views, state, destId);
}

// --- Text entry ---
//
// The prompts and the picker filter take arbitrary text, which means they take
// whatever the terminal hands over: a paste arrives as one multi-character
// chunk, and anything outside the BMP (emoji, and plenty of CJK) arrives as a
// two-unit surrogate pair. Testing `data.length === 1` rejected both, so paste
// silently did nothing and an emoji in a stage name was impossible to type.
//
// Cursor movement then has to step whole code points, not UTF-16 units, or
// backspace and the arrow keys can land inside a surrogate pair and split it —
// leaving half a character in the buffer and rendering a replacement glyph.

/** The typeable text in a raw input chunk: no controls, no escape sequences. */
export function printableText(data: string): string {
  // An escape sequence is a key, not text — and its tail is printable ASCII.
  if (data.startsWith("\x1b")) return "";
  let out = "";
  for (const ch of data) {
    const cp = ch.codePointAt(0)!;
    if (cp >= 32 && cp !== 127) out += ch;
  }
  return out;
}

/** The index one whole code point before `i`. */
export function prevBoundary(s: string, i: number): number {
  if (i <= 0) return 0;
  const cps = Array.from(s.slice(0, i));
  return i - (cps[cps.length - 1]?.length ?? 1);
}

/** The index one whole code point after `i`. */
export function nextBoundary(s: string, i: number): number {
  if (i >= s.length) return s.length;
  return i + String.fromCodePoint(s.codePointAt(i)!).length;
}

// --- Overlays ---

interface PickerItem { id: string; label: string; annotation?: string }

type Overlay =
  | null
  | {
      kind: "picker"; title: string; items: PickerItem[]; filtered: PickerItem[];
      index: number; filter: string; checked: (() => ReadonlySet<string>) | null;
      onPick: (id: string) => void;
    }
  | { kind: "prompt"; title: string; buffer: string; cursor: number; onCommit: (v: string) => void }
  | { kind: "confirm"; message: string; onYes: () => void };

// --- Screen ---

type RenderRow = { kind: "blank" } | { kind: "row"; index: number; row: WorkflowRow };

/**
 * Column geometry for the STATUSES table, measured from the block's indent.
 *
 * Real columns rather than dot leaders: the eye needs a vertical rule to follow,
 * and "does this one park?" is a question you answer by scanning down a column.
 *
 * Columns are **dropped right to left** as the width shrinks — Issues first,
 * then Parks, then Stage — rather than being allowed to overlap. Overlap was
 * not cosmetic: the header was written at a fixed offset with no truncation
 * while the value beneath it was truncated to a width that had gone negative,
 * so a ~34-column terminal rendered `SParks` as a heading over a column whose
 * data had silently become the empty string. A column that cannot fit is
 * better absent than present and lying.
 *
 * A `null` offset means that column is not drawn at all at this width.
 */
interface TableLayout {
  status: number;
  statusWidth: number;
  stage: number | null;
  stageWidth: number;
  parks: number | null;
  issues: number | null;
}

const ISSUES_W = 6;
const PARKS_W = 8;
const STAGE_MIN = 6;
const STATUS_MIN = 8;
const COL_GAP = 2;

export function tableLayout(rows: WorkflowRow[], width: number): TableLayout {
  const statuses = rows.filter((r): r is Extract<WorkflowRow, { kind: "status" }> => r.kind === "status");
  const longest = Math.max(STATUS_MIN, ...statuses.map((r) => textCols(r.state)));

  const showIssues = width >= STATUS_MIN + COL_GAP + STAGE_MIN + PARKS_W + ISSUES_W;
  const showParks = width >= STATUS_MIN + COL_GAP + STAGE_MIN + PARKS_W;
  const showStage = width >= STATUS_MIN + COL_GAP + STAGE_MIN;

  // Parks and Issues are right-anchored so the two narrow columns line up
  // against the block's right edge whatever the terminal width.
  const issues = showIssues ? width - ISSUES_W : null;
  const parks = showParks ? (issues ?? width) - PARKS_W : null;
  // Where the Stage column has to stop.
  const rightEdge = parks ?? issues ?? width;

  if (!showStage) {
    return { status: 0, statusWidth: width, stage: null, stageWidth: 0, parks, issues };
  }

  // A long status name must not eat the row, and must leave Stage its minimum.
  // The thresholds above guarantee the lower and upper bounds here can't cross.
  const statusWidth = Math.max(
    STATUS_MIN,
    Math.min(longest, Math.floor(width * 0.45), rightEdge - COL_GAP - STAGE_MIN),
  );
  const stage = statusWidth + COL_GAP;
  return {
    status: 0, statusWidth,
    stage, stageWidth: Math.max(0, rightEdge - stage - 1),
    parks, issues,
  };
}

export class WorkflowScreen {
  private port: WorkflowPort | null = null;
  private selectedIndex = 0;
  private scrollOffset = 0;
  private _open = false;
  private lastRenderRows = 24;
  private tier: SettingsTier = "global";
  private overlay: Overlay = null;

  get isOpen(): boolean { return this._open; }

  open(port: WorkflowPort): void {
    this.port = port;
    this.selectedIndex = 0;
    this.scrollOffset = 0;
    this.overlay = null;
    // Start on the tier whose values actually apply where the user is sitting.
    this.tier = port.repoLabel() ? "repo" : "global";
    this._open = true;
    this.clampSelection();
  }

  close(): void {
    this._open = false;
    this.overlay = null;
    this.port = null;
  }

  // --- Input ---

  handleInput(data: string): void {
    if (!this.port) return;
    if (this.overlay) { this.handleOverlayInput(data); return; }

    if (data === "\x1b" || data === "q") { this.close(); return; }
    if (data === "\x1b[A") { this.move(-1); return; }
    if (data === "\x1b[B") { this.move(1); return; }
    if (data === "\x1b[1;2A") { this.reorder(-1); return; }
    if (data === "\x1b[1;2B") { this.reorder(1); return; }

    const row = this.rows()[this.selectedIndex];
    if (!row) return;

    // ◂ ▸ nudge a stepped setting in place. Checked before the row actions so a
    // steppable row consumes them; every other row ignores left/right entirely,
    // which is what they did before this existed.
    if (data === "\x1b[D") { this.step(row, -1); return; }
    if (data === "\x1b[C") { this.step(row, 1); return; }

    if (data === "\r") { this.activate(row); return; }
    // `space` is the toggle key on both row kinds: the status table's parks
    // column, and a stage's unstarted rows. `s` covers the band itself.
    if (data === " ") { this.toggleParks(row); this.toggleUnstarted(row); return; }
    if (data === "s") { this.toggleSidebar(row); return; }
    if (data === "u") { this.toggleUpNext(row); return; }
    if (data === "d" || data === "\x7f") { this.remove(row); return; }
    if (data === "g") { this.switchTier(); return; }
  }

  private handleOverlayInput(data: string): void {
    const overlay = this.overlay;
    if (!overlay) return;

    if (overlay.kind === "confirm") {
      if (data === "y" || data === "Y") { this.overlay = null; overlay.onYes(); }
      else if (data === "n" || data === "N" || data === "\x1b" || data === "\r") this.overlay = null;
      return;
    }

    if (data === "\x1b") { this.overlay = null; return; }

    if (overlay.kind === "prompt") {
      if (data === "\r") {
        this.overlay = null;
        overlay.onCommit(overlay.buffer);
        return;
      }
      if (data === "\x7f" || data === "\b") {
        if (overlay.cursor > 0) {
          const at = prevBoundary(overlay.buffer, overlay.cursor);
          overlay.buffer = overlay.buffer.slice(0, at) + overlay.buffer.slice(overlay.cursor);
          overlay.cursor = at;
        }
        return;
      }
      if (data === "\x1b[D") { overlay.cursor = prevBoundary(overlay.buffer, overlay.cursor); return; }
      if (data === "\x1b[C") { overlay.cursor = nextBoundary(overlay.buffer, overlay.cursor); return; }
      if (data === "\x15") { overlay.buffer = ""; overlay.cursor = 0; return; }
      const typed = printableText(data);
      if (typed) {
        overlay.buffer = overlay.buffer.slice(0, overlay.cursor) + typed + overlay.buffer.slice(overlay.cursor);
        overlay.cursor += typed.length;
      }
      return;
    }

    // Picker
    if (data === "\x1b[A") { overlay.index = Math.max(0, overlay.index - 1); return; }
    if (data === "\x1b[B") { overlay.index = Math.min(overlay.filtered.length - 1, overlay.index + 1); return; }
    if (data === "\r") {
      const item = overlay.filtered[overlay.index];
      if (!item) return;
      // A multi picker stays open — choosing a subset in one visit is the point.
      if (!overlay.checked) this.overlay = null;
      overlay.onPick(item.id);
      return;
    }
    if (data === "\x7f" || data === "\b") {
      overlay.filter = overlay.filter.slice(0, prevBoundary(overlay.filter, overlay.filter.length));
      this.refilter(overlay);
      return;
    }
    const typed = printableText(data);
    if (typed) {
      overlay.filter += typed;
      this.refilter(overlay);
    }
  }

  private refilter(overlay: Extract<Overlay, { kind: "picker" }>): void {
    const q = overlay.filter.toLowerCase();
    overlay.filtered = q ? overlay.items.filter((i) => i.label.toLowerCase().includes(q)) : overlay.items;
    overlay.index = Math.min(overlay.index, Math.max(0, overlay.filtered.length - 1));
  }

  // --- Actions ---

  private activate(row: WorkflowRow): void {
    const port = this.port!;
    switch (row.kind) {
      case "seed":
        port.setViews(suggestLayout(port.getStatuses(), port.getViews()));
        return;

      case "tab":
        // Tabs hold no rows here, so Enter renames rather than folding — the
        // one thing you would want to do to a tab from its own row.
        this.rename(row);
        return;

      case "status": {
        const state = row.state;
        this.openPicker(`Which stage is "${state}"?`, destinationsFor(port.getViews(), state), (id) => {
          port.setViews(applyDestination(port.getViews(), state, id));
          this.followState(state);
        });
        return;
      }

      case "new-tab":
        this.openPrompt("Name this stage", "", (label) => {
          port.setViews(createView(port.getViews(), label));
        });
        return;

      case "setting":
        this.editSetting(row.def);
        return;
    }
  }

  /** Walk a stepped setting one place. A no-op on anything else. */
  private step(row: WorkflowRow, delta: number): void {
    if (row.kind !== "setting") return;
    row.def.onStep?.(delta);
  }

  private editSetting(def: SettingDef): void {
    if (def.type === "boolean") { def.onToggle?.(); return; }
    if (def.type === "action") { def.onActivate?.(); return; }

    if (def.type === "text" && def.onTextCommit) {
      const commit = def.onTextCommit;
      // getEditValue, not getValue — see the note on SettingDef. A row whose
      // display form is prose ("never") would otherwise open its prompt on a
      // string that parses back to nothing.
      this.openPrompt(def.label, def.getEditValue?.() ?? def.getValue(), (v) => commit(v));
      return;
    }

    // A list is a filterable picker here, not an inline ◂ ▸ cycle: these rows
    // choose among every tracker state, and cycling 25 of them one at a time
    // is why nobody found them.
    if (def.type === "list" && def.options && def.onOptionSelect) {
      const select = def.onOptionSelect;
      this.openPicker(def.label, def.options.map((o) => ({ id: o, label: o })), (id) => select(id));
      return;
    }

    if (def.type === "multiselect" && def.getOptions && def.onToggleOption) {
      const toggle = def.onToggleOption;
      const selected = def.getSelected ?? ((): string[] => []);
      this.openPicker(
        def.label,
        def.getOptions().map((o) => ({ id: o.id, label: o.label })),
        (id) => toggle(id),
        () => new Set(selected()),
      );
    }
  }

  /**
   * Parking, the only behaviour a status carries — a column in the table rather
   * than a fourth value of a "meaning" nobody could predict from. It is keyed
   * on the status itself, not on the tab, so a status can be work someone else
   * has whether or not you show it anywhere.
   */
  private toggleParks(row: WorkflowRow): void {
    if (row.kind !== "status") return;
    this.port!.toggleParked(row.state);
    this.followState(row.state);
  }

  /**
   * Whether this stage is a band in the sidebar at all. Its sessions are
   * unaffected either way — they fall to the flat remainder when it is off — so
   * this hides a heading, never work.
   */
  private toggleSidebar(row: WorkflowRow): void {
    if (row.kind !== "tab" || row.source !== "issues") return;
    const port = this.port!;
    port.setViews(toggleViewInSidebar(port.getViews(), row.viewId));
    this.followSelection(row);
  }

  /** Whether this stage's unstarted issues show as startable ghost rows. */
  private toggleUnstarted(row: WorkflowRow): void {
    if (row.kind !== "tab" || row.source !== "issues") return;
    const port = this.port!;
    port.setViews(toggleViewUnstarted(port.getViews(), row.viewId));
    this.followSelection(row);
  }

  /**
   * Add or remove this stage from the `Ctrl-a u` rotation. A marker on the row it
   * describes rather than a separate ordered multiselect listing tab names back
   * at you — the order you add them is the order they are checked.
   */
  private toggleUpNext(row: WorkflowRow): void {
    if (row.kind !== "tab" || row.source !== "issues") return;
    this.port!.toggleUpNext(row.viewId);
  }

  /** Reached from Enter on a stage row — stages hold no rows to fold open. */
  private rename(row: WorkflowRow): void {
    const port = this.port!;
    if (row.kind === "tab") {
      if (row.source !== "issues") return;
      const viewId = row.viewId;
      this.openPrompt("Rename stage", row.label, (label) => {
        port.setViews(renameView(port.getViews(), viewId, label));
      });
      return;
    }
  }

  private remove(row: WorkflowRow): void {
    const port = this.port!;
    if (row.kind === "tab") {
      if (row.source !== "issues") return;
      const { viewId, label, statuses } = row;
      this.overlay = {
        kind: "confirm",
        message: `Delete the "${label}" stage and unmap its ${statuses} ${statuses === 1 ? "status" : "statuses"}?`,
        onYes: () => { port.setViews(deleteView(port.getViews(), viewId)); this.clampSelection(); },
      };
      return;
    }
    if (row.kind === "status" && row.viewId) {
      port.setViews(applyDestination(port.getViews(), row.state, "\x00none"));
      this.followState(row.state);
      return;
    }
    if (row.kind === "setting" && row.def.getScope?.() === "override") {
      row.def.onClearOverride?.();
    }
  }

  private reorder(delta: number): void {
    const port = this.port!;
    const row = this.rows()[this.selectedIndex];
    if (!row) return;
    if (row.kind === "tab") {
      // Same guard as rename/delete/up-next: an MR tab is not a stage.
      if (row.source !== "issues") return;
      port.setViews(moveView(port.getViews(), row.viewId, delta));
    } else if (row.kind === "status" && row.viewId) {
      // Order within a stage is priority order.
      port.setViews(moveStateInView(port.getViews(), row.viewId, row.state, delta));
    } else {
      return;
    }
    this.followSelection(row);
  }

  private switchTier(): void {
    if (!this.port?.repoLabel()) return;
    this.tier = this.tier === "global" ? "repo" : "global";
  }

  // --- Overlay constructors ---

  private openPicker(
    title: string,
    items: PickerItem[],
    onPick: (id: string) => void,
    checked?: () => ReadonlySet<string>,
  ): void {
    if (items.length === 0) return;
    this.overlay = {
      kind: "picker", title, items, filtered: items, index: 0, filter: "",
      checked: checked ?? null, onPick,
    };
  }

  private openPrompt(title: string, value: string, onCommit: (v: string) => void): void {
    this.overlay = { kind: "prompt", title, buffer: value, cursor: value.length, onCommit };
  }

  // --- Selection ---

  private rows(): WorkflowRow[] {
    return this.port ? buildRows(this.port, this.tier) : [];
  }

  private move(delta: number): void {
    const rows = this.rows();
    let i = this.selectedIndex + delta;
    while (i >= 0 && i < rows.length && !isSelectable(rows[i]!)) i += delta;
    if (i >= 0 && i < rows.length) this.selectedIndex = i;
    this.ensureVisible();
  }

  /** Keep the cursor on a real row after the row list changes underneath it. */
  private clampSelection(): void {
    const rows = this.rows();
    if (rows.length === 0) { this.selectedIndex = 0; return; }
    this.selectedIndex = Math.min(this.selectedIndex, rows.length - 1);
    while (this.selectedIndex > 0 && !isSelectable(rows[this.selectedIndex]!)) this.selectedIndex--;
    while (this.selectedIndex < rows.length - 1 && !isSelectable(rows[this.selectedIndex]!)) this.selectedIndex++;
    this.ensureVisible();
  }

  /**
   * Keep the cursor on the thing the user just acted on, wherever the edit
   * moved it to. Without this, assigning a status leaves the cursor pointing at
   * whatever slid into that index — so the next keystroke lands on a row nobody
   * chose.
   */
  private followSelection(moved: WorkflowRow): void {
    const at = this.rows().findIndex((r) =>
      moved.kind === "tab" ? r.kind === "tab" && r.viewId === moved.viewId
      : moved.kind === "status" ? r.kind === "status" && r.state === moved.state
      : false);
    if (at >= 0) this.selectedIndex = at;
    this.ensureVisible();
  }

  private followState(state: string): void {
    const at = this.rows().findIndex((r) => r.kind === "status" && r.state === state);
    if (at >= 0) this.selectedIndex = at;
    else this.clampSelection();
    this.ensureVisible();
  }

  // --- Render ---

  render(cols: number, rows: number): CellGrid {
    this.lastRenderRows = rows;
    if (this.overlay?.kind === "picker") return this.renderPicker(cols, rows, this.overlay);
    if (this.overlay?.kind === "prompt") return this.renderPrompt(cols, rows, this.overlay);

    const grid = createGrid(cols, rows);
    const measureWidth = Math.min(cols, MEASURE);
    const left = cols > MEASURE ? Math.floor((cols - MEASURE) / 2) : 0;
    const right = left + measureWidth;
    const bounds = { left, right };

    const model = this.rows();
    const plan = buildRowPlan(model);

    writeString(grid, 0, left, "Workflow", TITLE_ATTRS);
    const summary = this.headerSummary(model);
    if (right - textCols(summary) > left + 10) {
      writeString(grid, 0, right - textCols(summary), summary, DIM_ATTRS);
    }

    const explainRowIdx = rows - 2;
    const hintRowIdx = rows - 1;

    // Once per frame, from the model already in hand. This used to be computed
    // inside renderRow, so every visible status row rebuilt the entire row
    // model — and buildRows walks every global issue, every session and every
    // setting closure. Thirty rows meant thirty full rebuilds per repaint.
    const table = tableLayout(model, bounds.right - bounds.left - 4);

    for (let r = 0; r < plan.length; r++) {
      const screenRow = CONTENT_START_ROW + r - this.scrollOffset;
      if (screenRow < CONTENT_START_ROW || screenRow >= explainRowIdx) continue;
      const entry = plan[r]!;
      if (entry.kind === "blank") continue;
      this.renderRow(grid, screenRow, bounds, entry.row, entry.index === this.selectedIndex, table);
    }

    // The explain line and hints are prose, not `label ···· value` rows, so
    // they run to the edge of the content area rather than stopping at the
    // row measure — a truncated explanation is the one thing this screen
    // exists to avoid.
    const proseRight = cols;
    const explain = truncateToCols(
      explainRow(model[this.selectedIndex]),
      proseRight - left,
    );
    writeString(grid, explainRowIdx, left, explain, EXPLAIN_ATTRS);

    this.renderHint(grid, hintRowIdx, left, proseRight, model[this.selectedIndex]);
    return grid;
  }

  private headerSummary(model: WorkflowRow[]): string {
    const tracker = this.port?.trackerLabel();
    if (!tracker) return "no issue tracker connected";
    const total = this.port?.getStatuses().length ?? 0;
    const free = model.filter((r) => r.kind === "status" && r.viewId === null).length;
    return `${tracker} · ${total} statuses · ${free} unmapped`;
  }

  private renderRow(
    grid: CellGrid, row: number, bounds: { left: number; right: number },
    model: WorkflowRow, selected: boolean, t: TableLayout,
  ): void {
    const { left, right } = bounds;

    switch (model.kind) {
      case "seed":
        drawSettingRow(grid, row, bounds, {
          label: "⚑ Suggest a starting layout",
          labelAttrs: selected ? LABEL_ACTIVE : ADD_ATTRS,
          value: [{ text: `${model.tabs} tabs · ${model.statuses} statuses`, attrs: DIM_ATTRS }],
          selected,
        });
        return;

      case "band":
        this.renderBand(grid, row, bounds, model.label);
        return;

      case "tab": {
        // Sidebar state speaks only when it is off its default, the same way the
        // parks count does — both settings are on for most stages, and a row
        // that restated "yes, normal" for every one of them would be noise.
        const sidebarState: Array<{ text: string; attrs: CellAttrs }> =
          !model.inSidebar ? [{ text: "hidden  ", attrs: WARN_ATTRS }]
          : !model.showUnstarted ? [{ text: "no unstarted  ", attrs: DIM_ATTRS }]
          : [];
        const value: Array<{ text: string; attrs: CellAttrs }> = model.source !== "issues"
          ? [{ text: "merge requests · not a stage", attrs: DIM_ATTRS }]
          : [
              ...sidebarState,
              ...(model.upNextRank !== null
                ? [{ text: `${ordinal(model.upNextRank + 1)} up next  `, attrs: VALUE_ATTRS }]
                : []),
              ...(model.parks > 0 ? [{ text: `⏸ ${model.parks}  `, attrs: PARK_ATTRS }] : []),
              { text: plural(model.statuses, "status", "statuses"), attrs: DIM_ATTRS },
            ];
        drawSettingRow(grid, row, bounds, {
          label: model.label,
          labelAttrs: selected ? LABEL_ACTIVE : model.source === "issues" ? LABEL_ATTRS : LABEL_MUTED,
          value,
          selected,
          indent: 4,
        });
        return;
      }

      case "columns": {
        const col = left + 4;
        writeString(grid, row, col + t.status, truncateToCols("Status", t.statusWidth), DIM_ATTRS);
        if (t.stage !== null) {
          writeString(grid, row, col + t.stage, truncateToCols("Stage", t.stageWidth), DIM_ATTRS);
        }
        if (t.parks !== null) writeString(grid, row, col + t.parks, "Parks", DIM_ATTRS);
        if (t.issues !== null) writeString(grid, row, col + t.issues - 1, "Issues", DIM_ATTRS);
        return;
      }

      case "status": {
        const col = left + 4;
        if (selected) writeString(grid, row, col - 2, "▸", CURSOR_ATTRS);

        writeString(grid, row, col + t.status, truncateToCols(model.state, t.statusWidth),
          selected ? LABEL_ACTIVE : model.known ? LABEL_ATTRS : LABEL_MUTED);
        if (t.stage !== null) {
          writeString(grid, row, col + t.stage, truncateToCols(model.viewLabel ?? "—", t.stageWidth),
            model.viewLabel ? VALUE_ATTRS : DIM_ATTRS);
        }

        // A glyph, not a checkbox: the column reads as "these ones park", and
        // an empty cell is the answer for most statuses in most workspaces.
        if (t.parks !== null) {
          if (model.parks) writeString(grid, row, col + t.parks + 1, "⏸", PARK_ATTRS);
          if (!model.known) writeString(grid, row, col + t.parks - 4, "stale", WARN_ATTRS);
        }
        if (t.issues !== null) {
          const issues = String(model.issues);
          writeString(grid, row, col + t.issues + 5 - textCols(issues), issues, DIM_ATTRS);
        }
        return;
      }

      case "new-tab":
        drawSettingRow(grid, row, bounds, {
          label: "+ New stage",
          labelAttrs: selected ? LABEL_ACTIVE : ADD_ATTRS,
          value: [],
          selected,
          indent: 4,
          leader: false,
        });
        return;

      case "setting": {
        const scope = model.def.getScope?.();
        // A steppable row wears its ◂ ▸ brackets, so the keys are visible on the
        // row itself rather than only in the footer. Shown on the selected row
        // only: on every row at once they read as decoration and add a column of
        // noise to rows that don't step.
        const stepped = selected && !!model.def.onStep;
        drawSettingRow(grid, row, bounds, {
          label: model.def.label,
          labelAttrs: selected ? LABEL_ACTIVE : LABEL_ATTRS,
          value: [
            ...(stepped ? [{ text: "◂ ", attrs: ADD_ATTRS }] : []),
            { text: truncateToCols(model.def.getValue(), Math.max(8, Math.floor((right - left) * 0.45))), attrs: VALUE_ATTRS },
            ...(stepped ? [{ text: " ▸", attrs: ADD_ATTRS }] : []),
            ...(scope ? [{ text: ` (${scope})`, attrs: DIM_ATTRS }] : []),
          ],
          selected,
        });
        return;
      }
    }
  }

  private renderBand(grid: CellGrid, row: number, bounds: { left: number; right: number }, label: string): void {
    const { left, right } = bounds;
    writeString(grid, row, left, label, BAND_ATTRS);
    const start = left + textCols(label) + 1;
    // The transitions band names the tier its values come from, so an
    // (override) marker below it has something to be an override *of*.
    const tail = label === TRANSITIONS_BAND ? this.tierLabel() : "";
    const end = tail ? right - textCols(tail) - 1 : right;
    if (end > start) writeString(grid, row, start, frame.ruleLight.repeat(end - start), HAIRLINE_ATTRS);
    if (tail && right - textCols(tail) >= start) writeString(grid, row, right - textCols(tail), tail, BAND_ATTRS);
  }

  private tierLabel(): string {
    const repo = this.port?.repoLabel();
    if (!repo) return "global defaults";
    return this.tier === "repo" ? `this repo · ${repo}   [g] globals` : `global defaults   [g] ${repo}`;
  }

  private renderHint(
    grid: CellGrid, row: number, left: number, right: number, selected: WorkflowRow | undefined,
  ): void {
    if (this.overlay?.kind === "confirm") {
      const msg = truncateToCols(`${this.overlay.message}  [y/n]`, right - left);
      writeString(grid, row, left, msg, WARN_ATTRS);
      return;
    }
    const segments: FooterSegment[] = [{ key: "↑↓", label: "move" }];
    switch (selected?.kind) {
      case "status":
        // Every row in the table takes the same two keys; the rest only apply
        // once a status is actually in a tab.
        segments.push({ key: "↵", label: "stage" }, { key: "space", label: "parks" });
        if (selected.viewId !== null) {
          segments.push({ key: "d", label: "remove" }, { key: "⇧↑↓", label: "order" });
        }
        break;
      case "tab":
        if (selected.source === "issues") {
          // `⇧↑↓ order` sits second, right beside the ↑↓ it varies: the footer
          // drops segments from the back, so the least discoverable key was also
          // the first to disappear on a narrow terminal.
          segments.push({ key: "⇧↑↓", label: "order" }, { key: "↵", label: "rename" },
            { key: "s", label: selected.inSidebar ? "hide" : "show" },
            { key: "space", label: "unstarted" },
            { key: "u", label: "up next" }, { key: "d", label: "delete" });
        }
        break;
      case "setting":
        segments.push(
          ...(selected.def.onStep ? [{ key: "◂▸", label: "change" }] : []),
          { key: "↵", label: "edit" },
          ...(selected.def.getScope?.() === "override" ? [{ key: "d", label: "clear" }] : []));
        break;
      default:
        segments.push({ key: "↵", label: "select" });
    }
    segments.push({ key: "esc", label: "close" });
    const layout = layoutFooter({ left: segments, right: [] }, right - left);
    writeStyledLine(grid, row, left, layout.cells, right - left);
  }

  private renderPicker(cols: number, rows: number, overlay: Extract<Overlay, { kind: "picker" }>): CellGrid {
    const grid = createGrid(cols, rows);
    const pad = space.modalInset;

    writeString(grid, 0, pad, truncateToCols(overlay.title, cols - pad * 2), TITLE_ATTRS);
    writeString(grid, 1, pad, "Filter: ", DIM_ATTRS);
    writeString(grid, 1, pad + 8, overlay.filter, EDIT_TEXT);
    writeString(grid, 1, pad + 8 + textCols(overlay.filter), " ", EDIT_CURSOR);

    const startRow = 3;
    const maxVisible = Math.max(1, rows - startRow - 1);
    const scroll = Math.max(0, overlay.index - maxVisible + 1);
    // Re-read on every frame rather than snapshotting, so a toggle in a multi
    // picker shows up immediately.
    const checked = overlay.checked?.() ?? null;

    for (let i = 0; i < overlay.filtered.length; i++) {
      const row = startRow + i - scroll;
      if (row < startRow || row >= rows - 1) continue;
      const item = overlay.filtered[i]!;
      const isSelected = i === overlay.index;
      if (isSelected) writeString(grid, row, pad, "▸", CURSOR_ATTRS);
      const box = checked ? `[${checked.has(item.id) ? "x" : " "}] ` : "";
      writeString(grid, row, pad + 2, box + item.label, isSelected ? LABEL_ACTIVE : LABEL_ATTRS);
      if (item.annotation) {
        const col = cols - pad - textCols(item.annotation);
        if (col > pad + 2 + textCols(box + item.label) + 1) {
          writeString(grid, row, col, item.annotation, DIM_ATTRS);
        }
      }
    }
    if (overlay.filtered.length === 0) writeString(grid, startRow, pad + 2, "No matches", DIM_ATTRS);

    writeString(grid, rows - 1, pad, checked
      ? "↑↓ select  ·  ↵ toggle  ·  esc done  ·  type to filter"
      : "↑↓ select  ·  ↵ choose  ·  esc cancel  ·  type to filter", DIM_ATTRS);
    return grid;
  }

  private renderPrompt(cols: number, rows: number, overlay: Extract<Overlay, { kind: "prompt" }>): CellGrid {
    const grid = createGrid(cols, rows);
    const pad = space.modalInset;
    writeString(grid, 0, pad, truncateToCols(overlay.title, cols - pad * 2), TITLE_ATTRS);
    writeString(grid, 2, pad, "▷ ", CURSOR_ATTRS);
    writeString(grid, 2, pad + 2, overlay.buffer, EDIT_TEXT);
    // The character under the caret, taken whole — indexing by UTF-16 unit
    // would paint half a surrogate pair.
    const under = overlay.cursor < overlay.buffer.length
      ? String.fromCodePoint(overlay.buffer.codePointAt(overlay.cursor)!)
      : " ";
    writeString(grid, 2, pad + 2 + textCols(overlay.buffer.slice(0, overlay.cursor)),
      under, EDIT_CURSOR);
    writeString(grid, rows - 1, pad, "↵ confirm  ·  esc cancel", DIM_ATTRS);
    return grid;
  }

  /**
   * Scroll is measured in row-plan positions, not row indices — the plan's
   * blank spacers consume screen space too. Selection only ever addresses real
   * rows, so the offset can never land on a spacer.
   */
  private ensureVisible(): void {
    const plan = buildRowPlan(this.rows());
    const pos = plan.findIndex((p) => p.kind === "row" && p.index === this.selectedIndex);
    if (pos < 0) return;
    const visible = Math.max(1, this.lastRenderRows - CONTENT_START_ROW - 2);
    if (pos - this.scrollOffset < 0) this.scrollOffset = pos;
    else if (pos - this.scrollOffset >= visible) this.scrollOffset = pos - visible + 1;
  }
}

/** Blank spacer before each band header, purely for breathing room. */
export function buildRowPlan(rows: WorkflowRow[]): RenderRow[] {
  const plan: RenderRow[] = [];
  rows.forEach((row, index) => {
    if (row.kind === "band" && plan.length > 0) plan.push({ kind: "blank" });
    plan.push({ kind: "row", index, row });
  });
  return plan;
}

export const TRANSITIONS_BAND = "Writes to your tracker";

