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
//   * **A heading is not a decision.** Several statuses can share a heading in
//     the panel. It carries no behaviour, so the column only exists at all when
//     the config actually has one.
//   * **Nothing hands off to a Modal.** Pickers, prompts and confirms are
//     painted into this screen's own grid. A full-screen surface consumes every
//     keystroke while open, so a modal opened from one renders nothing and
//     never receives a key — a bug this codebase has hit twice.

import type { CellGrid } from "./types";
import { createGrid, writeString, writeStyledLine, textCols, truncateToCols, type CellAttrs } from "./cell-grid";
import { tokens, space, frame } from "./chrome-tokens";
import { layoutFooter, type FooterSegment } from "./footer";
import { drawSettingRow, type SettingDef } from "./settings-screen";
import { stageFromStateType } from "./work-stage";
import {
  assignStateToGroup, createSection, createView, deleteView,
  moveSection, moveView, pruneEmptySections, renameSection, renameView,
  sectionIndexForStatus, suggestLayout, unassignState, isParkedState,
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
    }
  | { kind: "new-tab" }
  /** STATUSES block: the column headings, then one row per tracker status. */
  | { kind: "columns" }
  | {
      kind: "status"; state: string; viewId: string | null; viewLabel: string | null;
      /** Heading it renders under in the panel, when that groups several. */
      heading: string | null;
      parks: boolean; issues: number; parked: number; known: boolean;
      trackerStage: WorkStage;
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
export function buildRows(port: WorkflowPort, tier: SettingsTier, _collapsed: ReadonlySet<string>): WorkflowRow[] {
  const views = port.getViews();
  const statuses = port.getStatuses();
  const issueCounts = port.getIssueCounts();
  const parkedCounts = port.getParkedCounts();
  const parkedStates = port.getParkedStates();
  const upNext = port.getUpNext();
  const known = new Set(statuses.map((s) => norm(s.name)));
  const count = (state: string): number => issueCounts.get(norm(state)) ?? 0;

  const rows: WorkflowRow[] = [];
  const configured = views.some((v) => v.source === "issues" && (v.sections?.length ?? 0) > 0);
  if (!configured && statuses.length > 0) {
    rows.push({ kind: "seed", tabs: suggestLayout(statuses).length, statuses: statuses.length });
  }

  rows.push({
    kind: "band", label: "Your workflow",
    hint: "The stages you work in, top to bottom in priority order. Each is a tab in the info panel.",
  });
  for (const view of views) {
    const states = (view.sections ?? []).flatMap((s) => s.states);
    const rank = upNext.indexOf(view.id);
    rows.push({
      kind: "tab", viewId: view.id, label: view.label, source: view.source,
      statuses: states.length,
      parks: states.filter((s) => isParkedState(parkedStates, s)).length,
      issues: states.reduce((n, s) => n + count(s), 0),
      upNextRank: rank >= 0 ? rank : null,
    });
  }
  rows.push({ kind: "new-tab" });

  // The table, in tab order then config order — which is priority order — with
  // statuses in no tab last, where they read as the remaining to-do list.
  const placed: WorkflowRow[] = [];
  const claimed = new Set<string>();
  for (const view of views) {
    if (view.source !== "issues") continue;
    for (const section of view.sections ?? []) {
      const heading = section.states.length > 1 ? section.label : null;
      for (const state of section.states) {
        claimed.add(norm(state));
        placed.push({
          kind: "status", state, viewId: view.id, viewLabel: view.label, heading,
          parks: isParkedState(parkedStates, state),
          issues: count(state), parked: parkedCounts.get(norm(state)) ?? 0,
          known: known.has(norm(state)), trackerStage: "active",
        });
      }
    }
  }
  for (const s of statuses) {
    if (claimed.has(norm(s.name))) continue;
    placed.push({
      kind: "status", state: s.name, viewId: null, viewLabel: null, heading: null,
      parks: isParkedState(parkedStates, s.name),
      issues: count(s.name), parked: parkedCounts.get(norm(s.name)) ?? 0,
      known: true, trackerStage: stageFromStateType(s.type),
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
      const parts = [row.label, plural(row.statuses, "status", "statuses"), plural(row.issues, "issue")];
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
        : row.heading ? `${row.viewLabel}, under "${row.heading}"` : row.viewLabel);
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
 * Where a status can go. Tabs are always offered — picking one makes a section
 * from the status, which is the common case and the only one most workspaces
 * ever need. A tab's existing *shared* sections are offered alongside it, so
 * the extra choice only appears where shared sections already exist.
 */
export function destinationsFor(views: PanelView[], state: string): Destination[] {
  const out: Destination[] = [];
  for (const view of views) {
    if (view.source !== "issues") continue;
    const holdsIt = sectionIndexForStatus(state, view.sections) >= 0;
    out.push({
      id: `v\x00${view.id}`,
      label: view.label,
      annotation: holdsIt ? "already here" : "",
    });
    for (const section of view.sections ?? []) {
      if (section.states.length < 2) continue;
      out.push({
        id: `s\x00${view.id}\x00${section.label}`,
        label: `${view.label} › ${section.label}`,
        annotation: `${section.states.length} statuses`,
      });
    }
  }
  out.push({ id: "u", label: "No stage", annotation: "never shown" });
  return out;
}

/** The section inside `viewId` that currently holds `state`, if any. */
export function sectionLabelFor(views: PanelView[], viewId: string, state: string): string | null {
  const view = views.find((v) => v.id === viewId);
  const at = sectionIndexForStatus(state, view?.sections);
  return at >= 0 ? view!.sections![at]!.label : null;
}

/** A section label derived from a status, disambiguated within its tab. */
export function uniqueSectionLabel(views: PanelView[], viewId: string, base: string): string {
  const taken = new Set((views.find((v) => v.id === viewId)?.sections ?? []).map((s) => norm(s.label)));
  if (!taken.has(norm(base))) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base} ${n}`;
    if (!taken.has(norm(candidate))) return candidate;
  }
}

/**
 * Apply a chosen destination. Assignment always removes the status from
 * wherever it was (`assignStateToGroup`), so one status has exactly one home
 * and therefore exactly one meaning.
 */
export function applyDestination(views: PanelView[], state: string, destId: string): PanelView[] {
  if (destId === "u") return pruneEmptySections(unassignState(views, state));

  const [kind, viewId, sectionLabel] = destId.split("\x00");
  if (kind === "s" && sectionLabel) {
    return pruneEmptySections(assignStateToGroup(views, state, viewId!, sectionLabel));
  }
  if (kind !== "v" || !viewId) return views;

  // Already in this tab: re-adding would split it into a second section.
  const target = views.find((v) => v.id === viewId);
  if (sectionIndexForStatus(state, target?.sections) >= 0) return views;

  // Nothing to carry across: whether the work parks is the destination tab's
  // property now, so a move says what it does simply by where it lands.
  const label = uniqueSectionLabel(views, viewId, state);
  return pruneEmptySections(
    assignStateToGroup(createSection(views, viewId, label), state, viewId, label));
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
 * Column x-offsets for the STATUSES table, measured from the block's indent.
 *
 * Real columns rather than dot leaders: with four fields per row the eye needs
 * a vertical rule to follow, and "does this one park?" is a question you answer
 * by scanning down a column. The Heading column only exists when the config
 * actually groups something, so a workspace that has never grouped never sees it.
 */
interface TableLayout { status: number; heading: number | null; tab: number; parks: number; issues: number }

export function tableLayout(rows: WorkflowRow[], width: number): TableLayout {
  const statuses = rows.filter((r): r is Extract<WorkflowRow, { kind: "status" }> => r.kind === "status");
  const anyHeading = statuses.some((r) => r.heading !== null);
  const statusCol = 0;
  const nameWidth = Math.min(
    Math.max(6, ...statuses.map((r) => textCols(r.state))),
    Math.max(10, Math.floor(width * 0.4)),
  );
  const headingWidth = anyHeading
    ? Math.min(Math.max(7, ...statuses.map((r) => textCols(r.heading ?? ""))), 18)
    : 0;
  const heading = anyHeading ? statusCol + nameWidth + 2 : null;
  const tab = (heading ?? statusCol + nameWidth) + (anyHeading ? headingWidth + 2 : 2);
  // Parks and Issues are right-anchored so the two numeric-ish columns line up
  // against the block's right edge whatever the terminal width.
  const issues = width - 6;
  const parks = issues - 8;
  return { status: statusCol, heading, tab, parks, issues };
}

export class WorkflowScreen {
  private port: WorkflowPort | null = null;
  private selectedIndex = 0;
  private scrollOffset = 0;
  private _open = false;
  private lastRenderRows = 24;
  private collapsed = new Set<string>();
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

    if (data === "\r") { this.activate(row); return; }
    if (data === " ") { this.toggleParks(row); return; }
    if (data === "u") { this.toggleUpNext(row); return; }
    if (data === "r") { this.rename(row); return; }
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
          overlay.buffer = overlay.buffer.slice(0, overlay.cursor - 1) + overlay.buffer.slice(overlay.cursor);
          overlay.cursor--;
        }
        return;
      }
      if (data === "\x1b[D") { overlay.cursor = Math.max(0, overlay.cursor - 1); return; }
      if (data === "\x1b[C") { overlay.cursor = Math.min(overlay.buffer.length, overlay.cursor + 1); return; }
      if (data === "\x15") { overlay.buffer = ""; overlay.cursor = 0; return; }
      if (data.length === 1 && data.charCodeAt(0) >= 32) {
        overlay.buffer = overlay.buffer.slice(0, overlay.cursor) + data + overlay.buffer.slice(overlay.cursor);
        overlay.cursor++;
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
      overlay.filter = overlay.filter.slice(0, -1);
      this.refilter(overlay);
      return;
    }
    if (data.length === 1 && data.charCodeAt(0) >= 32) {
      overlay.filter += data;
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

  private editSetting(def: SettingDef): void {
    if (def.type === "boolean") { def.onToggle?.(); return; }
    if (def.type === "action") { def.onActivate?.(); return; }

    if (def.type === "text" && def.onTextCommit) {
      const commit = def.onTextCommit;
      this.openPrompt(def.label, def.getValue(), (v) => commit(v));
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
   * Add or remove this stage from the `Ctrl-a u` rotation. A marker on the row it
   * describes rather than a separate ordered multiselect listing tab names back
   * at you — the order you add them is the order they are checked.
   */
  private toggleUpNext(row: WorkflowRow): void {
    if (row.kind !== "tab" || row.source !== "issues") return;
    this.port!.toggleUpNext(row.viewId);
  }

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
    // Grouping: give two statuses the same heading and they render under one
    // in the panel. Purely display — the section carries no behaviour.
    if (row.kind === "status" && row.viewId) {
      const { viewId } = row;
      const section = sectionLabelFor(port.getViews(), viewId, row.state);
      if (!section) return;
      this.openPrompt("Heading this status appears under", section, (label) => {
        const views = port.getViews();
        const existing = (views.find((v) => v.id === viewId)?.sections ?? [])
          .find((s) => norm(s.label) === norm(label) && s.label !== section);
        port.setViews(existing
          ? applyDestination(views, row.state, `s\x00${viewId}\x00${existing.label}`)
          : renameSection(views, viewId, section, label));
        this.followState(row.state);
      });
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
      // pruneEmptySections drops a heading this leaves with nothing under it.
      port.setViews(applyDestination(port.getViews(), row.state, "u"));
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
      port.setViews(moveView(port.getViews(), row.viewId, delta));
    } else if (row.kind === "status" && row.viewId) {
      // Order within a tab is priority order, and a section is the unit that
      // carries it — moving a shared heading moves its statuses together.
      const section = sectionLabelFor(port.getViews(), row.viewId, row.state);
      if (!section) return;
      port.setViews(moveSection(port.getViews(), row.viewId, section, delta));
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
    return this.port ? buildRows(this.port, this.tier, this.collapsed) : [];
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

    for (let r = 0; r < plan.length; r++) {
      const screenRow = CONTENT_START_ROW + r - this.scrollOffset;
      if (screenRow < CONTENT_START_ROW || screenRow >= explainRowIdx) continue;
      const entry = plan[r]!;
      if (entry.kind === "blank") continue;
      this.renderRow(grid, screenRow, bounds, entry.row, entry.index === this.selectedIndex);
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
    model: WorkflowRow, selected: boolean,
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
        const value: Array<{ text: string; attrs: CellAttrs }> = model.source !== "issues"
          ? [{ text: "merge requests · not a stage", attrs: DIM_ATTRS }]
          : [
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
        const t = this.table(bounds);
        const col = left + 4;
        writeString(grid, row, col + t.status, "Status", DIM_ATTRS);
        if (t.heading !== null) writeString(grid, row, col + t.heading, "Heading", DIM_ATTRS);
        writeString(grid, row, col + t.tab, "Stage", DIM_ATTRS);
        writeString(grid, row, col + t.parks, "Parks", DIM_ATTRS);
        writeString(grid, row, col + t.issues - 1, "Issues", DIM_ATTRS);
        return;
      }

      case "status": {
        const t = this.table(bounds);
        const col = left + 4;
        if (selected) writeString(grid, row, col - 2, "▸", CURSOR_ATTRS);

        const nameWidth = (t.heading ?? t.tab) - t.status - 2;
        writeString(grid, row, col + t.status, truncateToCols(model.state, nameWidth),
          selected ? LABEL_ACTIVE : model.known ? LABEL_ATTRS : LABEL_MUTED);

        if (t.heading !== null && model.heading) {
          writeString(grid, row, col + t.heading,
            truncateToCols(model.heading, t.tab - t.heading - 2), DIM_ATTRS);
        }
        writeString(grid, row, col + t.tab,
          truncateToCols(model.viewLabel ?? "—", t.parks - t.tab - 2),
          model.viewLabel ? VALUE_ATTRS : DIM_ATTRS);

        // A glyph, not a checkbox: the column reads as "these ones park", and
        // an empty cell is the answer for most statuses in most workspaces.
        if (model.parks) writeString(grid, row, col + t.parks + 1, "⏸", PARK_ATTRS);
        if (!model.known) writeString(grid, row, col + t.parks - 4, "stale", WARN_ATTRS);

        const issues = String(model.issues);
        writeString(grid, row, col + t.issues + 5 - textCols(issues), issues, DIM_ATTRS);
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
        drawSettingRow(grid, row, bounds, {
          label: model.def.label,
          labelAttrs: selected ? LABEL_ACTIVE : LABEL_ATTRS,
          value: [
            { text: truncateToCols(model.def.getValue(), Math.max(8, Math.floor((right - left) * 0.45))), attrs: VALUE_ATTRS },
            ...(scope ? [{ text: ` (${scope})`, attrs: DIM_ATTRS }] : []),
          ],
          selected,
        });
        return;
      }
    }
  }

  /** Column geometry for the current frame, from the rows actually on screen. */
  private table(bounds: { left: number; right: number }): TableLayout {
    return tableLayout(this.rows(), bounds.right - bounds.left - 4);
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
          segments.push({ key: "r", label: "heading" },
            { key: "d", label: "remove" }, { key: "⇧↑↓", label: "order" });
        }
        break;
      case "tab":
        if (selected.source === "issues") {
          segments.push({ key: "↵", label: "rename" }, { key: "u", label: "up next" },
            { key: "d", label: "delete" }, { key: "⇧↑↓", label: "order" });
        }
        break;
      case "setting":
        segments.push({ key: "↵", label: "edit" },
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
    writeString(grid, 2, pad + 2 + textCols(overlay.buffer.slice(0, overlay.cursor)),
      overlay.buffer[overlay.cursor] ?? " ", EDIT_CURSOR);
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

