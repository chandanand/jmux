// src/panel-view-renderer.ts
import type { CellGrid } from "./types";
import { ColorMode } from "./types";
import { createGrid, writeString, truncateToCols, textCols, type CellAttrs } from "./cell-grid";
import { packChips, chipAtCol, type PlacedChip } from "./band-layout";
import { stateIndexInView, type PanelView, type GroupByField } from "./panel-view";
import type { Issue, IssueStateType, MergeRequest, PipelineStatus } from "./adapters/types";
import { fuzzyMatch } from "./fuzzy";
import { neutralFg, theme } from "./theme";
import { tokens, frame, space } from "./chrome-tokens";
import {
  buildIssueDetailLines,
  paintDetailLines,
  rebuildIssueDetailColors,
  DETAIL_LABEL,
  DETAIL_VALUE,
  type DetailLine,
} from "./issue-detail";

// Defined where they are resolved, so a renderer import doesn't drag rendering
// into the CLI paths that only need the resolution. Re-exported because this is
// where every existing caller imports them from.
import type { IssueSessionState, IssueSessionInfo } from "./issue-session";
export type { IssueSessionState, IssueSessionInfo };

export interface RenderableItem {
  id: string;
  type: "issue" | "mr";
  primary: string;
  title: string;
  status: string;
  meta: string;
  group: string;
  subGroup: string;
  sessionLinked: boolean;
  priority: number;
  updatedAt: number;
  raw: Issue | MergeRequest;
  issueSessionState?: IssueSessionState;  // only for issues
  // Resolved session name when issueSessionState is "session" or "worktree".
  // Comes from an explicit sessionState link first, falling back to the
  // workflow-derived name. Used by the n-key handler to switch.
  linkedSessionName?: string;
  stateType?: IssueStateType;  // only for issues; stable ordering across status renames
  /** Worst pipeline state across the issue's linked MRs, if any are known. */
  pipeline?: PipelineStatus["state"];
}

/** Worst-first, so one red pipeline is never hidden behind a green one. */
const PIPELINE_RANK: Record<string, number> = {
  failed: 0, running: 1, pending: 2, canceled: 3, passed: 4,
};

export const PIPELINE_GLYPH: Record<string, string> = {
  failed: "\u2717", running: "\u27f3", pending: "\u25cb", canceled: "\u2014", passed: "\u2713",
};

/**
 * Compact relative age, e.g. `3d`. Returns "" for an unknown timestamp rather
 * than dating it to the epoch.
 */
export function formatAge(updatedAt: number, now: number): string {
  if (!updatedAt) return "";
  const secs = Math.max(0, Math.floor((now - updatedAt) / 1000));
  if (secs < 60) return "now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 14) return `${days}d`;
  const weeks = Math.floor(days / 7);
  if (weeks < 9) return `${weeks}w`;
  return `${Math.floor(days / 30)}mo`;
}

export type ViewNode =
  | { kind: "group"; key: string; label: string; count: number; collapsed: boolean; depth: number }
  | { kind: "item"; item: RenderableItem; depth: number };

/**
 * Every item filed under a group header, including through sub-groups.
 *
 * Membership is read back off `buildViewNodes` with nothing collapsed rather
 * than re-derived from `groupBy`, so it *is* the grouping the panel drew — the
 * two cannot disagree about what "this project" contains. That matters because
 * the two grouping mechanisms (a view's `states` sections and the `groupBy`
 * axis) file items by different rules, and a caller acting on a group header
 * should not have to know which one produced it.
 *
 * Works for a sub-group header too: collection runs until the next header at
 * the same depth or shallower.
 */
export function itemsInGroup(
  items: RenderableItem[],
  view: PanelView,
  groupKey: string,
): RenderableItem[] {
  const nodes = buildViewNodes(items, view, new Set());
  const start = nodes.findIndex((n) => n.kind === "group" && n.key === groupKey);
  if (start < 0) return [];
  const depth = nodes[start]!.depth;
  const out: RenderableItem[] = [];
  for (let i = start + 1; i < nodes.length; i++) {
    const node = nodes[i]!;
    if (node.kind === "group" && node.depth <= depth) break;
    if (node.kind === "item") out.push(node.item);
  }
  return out;
}

export interface ViewState {
  selectedIndex: number;
  collapsedGroups: Set<string>;
  scrollOffset: number;
  detailScrollOffset: number;
  filterQuery: string | null;  // null = filter off, "" = bar open but empty, "abc" = filtering
  /**
   * Ticked item ids — the set `n` and `l` act on instead of the highlighted row.
   *
   * Transient and per-view, never persisted: it is a selection, not a
   * preference. It lives here rather than on the view because two tabs showing
   * the same issue are two different places you might be part-way through
   * choosing something.
   *
   * This exists because grouping cannot express the thing it needed to. A tab
   * defined by `states` ignores `groupBy` entirely, so a workflow built out of
   * stages — the configuration jmux steers everyone toward — has only status
   * headers, and "every ticket in To do" is never the set you meant. Ticking is
   * the only selection that works on every tab, including ones with no headers
   * at all, and the only one that can say "these three of those five".
   */
  checkedIds: Set<string>;
  /**
   * The issue the detail pane is pinned to, when the preview strip is driving
   * it rather than the list cursor. `null` means "follow the cursor", which is
   * the behaviour that predates the strip and is still the common case.
   *
   * The preview having its own cursor is what lets the strip show an issue the
   * list cannot: a session's linked issues routinely include ones absent from
   * every queue tab — a finished ticket on an "In Progress" tab, or one
   * assigned to a teammate and so missing from `getMyIssues()` entirely. A
   * strip that could only point at rows would quietly have fewer tabs than the
   * sidebar's `+N` promises.
   *
   * Moving the list cursor clears it. Two cursors are tolerable only while the
   * newer one yields to the older on any deliberate move of the older.
   */
  previewIssueId: string | null;
}

export function createViewState(): ViewState {
  return {
    selectedIndex: 0,
    collapsedGroups: new Set(),
    scrollOffset: 0,
    detailScrollOffset: 0,
    filterQuery: null,
    checkedIds: new Set(),
    previewIssueId: null,
  };
}

/**
 * Move the list cursor.
 *
 * A function rather than an assignment because two things have to happen with
 * it, and both were previously spread across nine call sites. The detail scroll
 * resets — the pane is about to show a different document, and offset 40 into
 * the last one means nothing in the next. And the preview pin clears, which is
 * the whole contract that makes two cursors tolerable: the newer one yields the
 * moment the user deliberately moves the older.
 */
export function moveSelection(state: ViewState, index: number): void {
  state.selectedIndex = index;
  state.detailScrollOffset = 0;
  state.previewIssueId = null;
}

/**
 * The ticked items, in the order the view draws them.
 *
 * Node order, not tick order: the list has a meaning to its sequence (priority,
 * or the stage's own status order) and the order somebody happened to click in
 * is not new information about it. Ids that no longer appear — filtered away,
 * or gone from the tracker between polls — are dropped rather than carried.
 */
export function checkedItems(nodes: ViewNode[], state: ViewState): RenderableItem[] {
  if (state.checkedIds.size === 0) return [];
  const out: RenderableItem[] = [];
  for (const node of nodes) {
    if (node.kind === "item" && state.checkedIds.has(node.item.id)) out.push(node.item);
  }
  return out;
}

// --- Data Pipeline ---

export function transformIssues(
  issues: Issue[],
  linkedIds: Set<string>,
  sessionStates?: Map<string, IssueSessionInfo>,
  /** MR web URL → MR, so an issue can surface its own pipeline state. */
  mrsByUrl?: Map<string, Pick<MergeRequest, "pipeline">>,
): RenderableItem[] {
  return issues.map((issue) => {
    const info = sessionStates?.get(issue.id);
    let pipeline: PipelineStatus["state"] | undefined;
    for (const url of issue.linkedMrUrls ?? []) {
      const state = mrsByUrl?.get(url)?.pipeline?.state;
      if (!state) continue;
      if (pipeline === undefined || (PIPELINE_RANK[state] ?? 9) < (PIPELINE_RANK[pipeline] ?? 9)) {
        pipeline = state;
      }
    }
    return {
      pipeline,
      id: issue.id,
      type: "issue" as const,
      primary: issue.identifier,
      title: issue.title,
      status: issue.status,
      meta: issue.assignee ?? "",
      group: issue.team ?? "",
      subGroup: issue.status ?? "",
      sessionLinked: linkedIds.has(issue.id),
      priority: issue.priority ?? 0,
      updatedAt: issue.updatedAt ?? 0,
      raw: issue,
      issueSessionState: info?.state ?? "none",
      linkedSessionName: info?.sessionName,
      stateType: issue.stateType,
    };
  });
}

export function transformMrs(mrs: MergeRequest[], linkedIds: Set<string>): RenderableItem[] {
  return mrs.map((mr) => ({
    id: mr.id,
    type: "mr" as const,
    primary: `!${mr.id.split(":")[1] ?? mr.id}`,
    title: mr.title,
    status: mr.status,
    meta: `${mr.sourceBranch} → ${mr.targetBranch}`,
    group: "",
    subGroup: mr.status,
    sessionLinked: linkedIds.has(mr.id),
    priority: 0,
    updatedAt: mr.updatedAt ?? 0,
    raw: mr,
  }));
}

export function filterItems(items: RenderableItem[], query: string | null): RenderableItem[] {
  if (!query) return items;
  const scored: { item: RenderableItem; score: number }[] = [];
  for (const item of items) {
    const haystack = `${item.primary} ${item.title}`;
    const result = fuzzyMatch(query, haystack);
    if (result) scored.push({ item, score: result.score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.item);
}

function getField(item: RenderableItem, field: string): string {
  switch (field) {
    case "team": return item.type === "issue" ? (item.raw as Issue).team ?? "" : "";
    case "project": return item.type === "issue" ? (item.raw as Issue).project ?? "" : "";
    case "status": return item.status;
    case "priority": return String(item.priority);
    default: return "";
  }
}

export function buildViewNodes(
  items: RenderableItem[],
  view: PanelView,
  collapsedGroups: Set<string>,
): ViewNode[] {
  // Partition: session-linked first, sorting within each partition separately
  let ordered = items;
  if (view.sessionLinkedFirst) {
    const linked = sortItems(items.filter((i) => i.sessionLinked), view.sortBy, view.sortOrder);
    const unlinked = sortItems(items.filter((i) => !i.sessionLinked), view.sortBy, view.sortOrder);
    ordered = [...linked, ...unlinked];
  } else {
    ordered = sortItems(items, view.sortBy, view.sortOrder);
  }

  // A stage's own status list drives membership: an item belongs if its status
  // is on the list, and anything unlisted is not in this stage at all. Config
  // order is priority order, so it is preserved verbatim rather than sorted.
  //
  // Subheadings are the status names themselves, and only when the stage holds
  // more than one — a single-status stage is already named by its tab, so a
  // heading repeating it would be a row that says nothing. There used to be a
  // separate heading you named by hand; it only ever restated the status.
  //
  // Presence of the list, not its length, is what makes a view status-driven:
  // a stage holding no statuses shows no issues. Testing the length let a
  // freshly created stage fall through to `groupBy` and list everything.
  if (view.states !== undefined) {
    if (view.states.length === 1) {
      return ordered
        .filter((item) => stateIndexInView(item.status, view.states) >= 0)
        .map((item) => ({ kind: "item" as const, item, depth: 0 }));
    }
    const buckets: RenderableItem[][] = view.states.map(() => []);
    for (const item of ordered) {
      const idx = stateIndexInView(item.status, view.states);
      if (idx >= 0) buckets[idx]!.push(item);
    }
    const nodes: ViewNode[] = [];
    view.states.forEach((state, i) => {
      const members = buckets[i]!;
      const collapsed = collapsedGroups.has(state);
      nodes.push({ kind: "group", key: state, label: state, count: members.length, collapsed, depth: 0 });
      if (collapsed) return;
      for (const item of members) nodes.push({ kind: "item", item, depth: 1 });
    });
    return nodes;
  }

  if (view.groupBy === "none") {
    return ordered.map((item) => ({ kind: "item" as const, item, depth: 0 }));
  }

  // Derived grouping (groupBy) — only reached when a view defines no sections.
  const derived = new Map<string, RenderableItem[]>();
  for (const item of ordered) {
    const key = getField(item, view.groupBy);
    const list = derived.get(key) ?? [];
    list.push(item);
    derived.set(key, list);
  }
  const sortedGroups = sortGroupEntries([...derived.entries()], view.groupBy);

  const nodes: ViewNode[] = [];
  for (const [label, groupItems] of sortedGroups) {
    const groupKey = label;
    const collapsed = collapsedGroups.has(groupKey);
    nodes.push({ kind: "group", key: groupKey, label: label || "(none)", count: groupItems.length, collapsed, depth: 0 });

    if (collapsed) continue;

    if (view.subGroupBy !== "none") {
      const subGroups = new Map<string, RenderableItem[]>();
      for (const item of groupItems) {
        const subKey = getField(item, view.subGroupBy);
        const list = subGroups.get(subKey) ?? [];
        list.push(item);
        subGroups.set(subKey, list);
      }
      const sortedSubGroups = sortGroupEntries([...subGroups.entries()], view.subGroupBy);
      for (const [subLabel, subItems] of sortedSubGroups) {
        const subKey = `${groupKey}:${subLabel}`;
        const subCollapsed = collapsedGroups.has(subKey);
        nodes.push({ kind: "group", key: subKey, label: subLabel || "(none)", count: subItems.length, collapsed: subCollapsed, depth: 1 });
        if (!subCollapsed) {
          for (const item of subItems) {
            nodes.push({ kind: "item", item, depth: 2 });
          }
        }
      }
    } else {
      for (const item of groupItems) {
        nodes.push({ kind: "item", item, depth: 1 });
      }
    }
  }

  return nodes;
}

// Linear's workflow position. Status display names ("Todo", "In Review", etc.)
// are workspace-customizable, but stateType is the stable enum.
const STATE_TYPE_RANK: Record<IssueStateType, number> = {
  triage: 0,
  backlog: 1,
  unstarted: 2,
  started: 3,
  completed: 4,
  canceled: 5,
  duplicate: 6,
};

// Order group keys by an intrinsic property of the field (alphabetical for
// teams/projects, workflow position for status, numeric for priority) so the
// group ordering stays stable when an item's status, priority, or team
// changes. Without this, groups are emitted in Map-insertion order, which
// reflects whichever group's first item happened to come first under the
// current item-level sort — and that shifts whenever an item moves.
function sortGroupEntries(
  entries: Array<[string, RenderableItem[]]>,
  field: GroupByField,
): Array<[string, RenderableItem[]]> {
  const compare = (a: [string, RenderableItem[]], b: [string, RenderableItem[]]): number => {
    const [aKey, aItems] = a;
    const [bKey, bItems] = b;
    switch (field) {
      case "status": {
        const aRank = aItems[0]?.stateType ? STATE_TYPE_RANK[aItems[0].stateType] : 99;
        const bRank = bItems[0]?.stateType ? STATE_TYPE_RANK[bItems[0].stateType] : 99;
        if (aRank !== bRank) return aRank - bRank;
        return aKey.localeCompare(bKey);
      }
      case "priority": {
        // Priority 0 means "no priority" in Linear — sort it last, then 1=Urgent..4=Low
        const aN = parseInt(aKey, 10);
        const bN = parseInt(bKey, 10);
        const aRank = !aN ? 99 : aN;
        const bRank = !bN ? 99 : bN;
        return aRank - bRank;
      }
      case "team":
      case "project": {
        // Empty key ("(none)") sorts last
        if (aKey === "" && bKey !== "") return 1;
        if (aKey !== "" && bKey === "") return -1;
        return aKey.localeCompare(bKey);
      }
      default:
        return aKey.localeCompare(bKey);
    }
  };
  return [...entries].sort(compare);
}

function sortItems(items: RenderableItem[], sortBy: string, order: "asc" | "desc"): RenderableItem[] {
  const sorted = [...items].sort((a, b) => {
    let cmp = 0;
    switch (sortBy) {
      case "priority": cmp = (a.priority || 99) - (b.priority || 99); break;
      case "updated": cmp = b.updatedAt - a.updatedAt; break;
      case "created": cmp = a.updatedAt - b.updatedAt; break;
      case "status": cmp = a.status.localeCompare(b.status); break;
    }
    return order === "desc" ? -cmp : cmp;
  });
  return sorted;
}

// --- Rendering ---

// Colours come from chrome-tokens (rebuilt in place on theme detection), so the
// panel shares the chrome's single accent rather than keeping its own peach.
// Priority 2 previously had a third orange of its own (#FF8C00); under the
// colour inventory only one accent may exist, so priority is now carried by
// weight (bold) on the neutral ramp instead of a hue.
const CURSOR_ATTRS: CellAttrs = { fg: tokens.accent.fg, fgMode: tokens.accent.fgMode };
const LINKED_ATTRS: CellAttrs = { fg: 2, fgMode: ColorMode.Palette };
const SESSION_CURRENT_ATTRS: CellAttrs = { fg: 2, fgMode: ColorMode.Palette, bold: true };
const WORKTREE_ATTRS: CellAttrs = { fg: 2, fgMode: ColorMode.Palette, dim: true };
const UNLINKED_ATTRS: CellAttrs = { fg: 8, fgMode: ColorMode.Palette, dim: true };
const TITLE_ATTRS: CellAttrs = { fg: 7, fgMode: ColorMode.Palette };
const GROUP_ATTRS: CellAttrs = { fg: 8, fgMode: ColorMode.Palette, bold: true };
const GROUP_SELECTED_ATTRS: CellAttrs = { fg: tokens.accent.fg, fgMode: tokens.accent.fgMode, bold: true };
const PRIORITY_ATTRS: Record<number, CellAttrs> = {
  1: { fg: 1, fgMode: ColorMode.Palette, bold: true },
  // Weight, not a third orange — see the note above.
  2: { fg: tokens.textPrimary.fg, fgMode: tokens.textPrimary.fgMode, bold: true },
  3: { fg: 3, fgMode: ColorMode.Palette },
  4: { fg: 8, fgMode: ColorMode.Palette, dim: true },
};
const DIM_ATTRS: CellAttrs = { fg: 8, fgMode: ColorMode.Palette, dim: true };
// Same palette the sidebar uses for pipeline glyphs, so a red MR reads the same
// in both places.
const PIPELINE_ATTRS: Record<string, CellAttrs> = {
  failed: { fg: 1, fgMode: ColorMode.Palette },
  running: { fg: 3, fgMode: ColorMode.Palette },
  pending: { fg: 8, fgMode: ColorMode.Palette, dim: true },
  canceled: { fg: 8, fgMode: ColorMode.Palette, dim: true },
  passed: { fg: 2, fgMode: ColorMode.Palette },
};

/** Injectable clock so row rendering stays deterministic under test. */
let nowMs: () => number = () => Date.now();
export function setPanelClock(fn: () => number): void { nowMs = fn; }
// DETAIL_LABEL / DETAIL_VALUE live in issue-detail.ts alongside the builder
// that is their main consumer; the MR builder and action bar below import them
// so both detail flavours stay visually identical.
const DETAIL_KEY: CellAttrs = { fg: 2, fgMode: ColorMode.Palette };
// Preview-strip tabs, in the toolbar's window-tab idiom (see the tab block in
// `renderer.ts` and `tabUnderlineGlyphAndAttrs`): a filled background on the
// active tab only, accent-bold on it and plain palette-8 on the rest, a
// two-column gutter instead of a separator glyph, and a state rule along the
// tab's own edge. Deliberately the toolbar's look rather than the info panel's
// — these are tabs over a content pane, which is what the top bar's are.
const PREVIEW_TAB_ACTIVE_ATTRS: CellAttrs = {
  fg: tokens.accent.fg,
  fgMode: tokens.accent.fgMode,
  bold: true,
  bg: theme.selected,
  bgMode: ColorMode.RGB,
};
// No background and no dim: an inactive toolbar tab is plain palette-8 against
// the terminal, which is what keeps the active tab's fill reading as the
// selection rather than as one shade among several.
const PREVIEW_TAB_ATTRS: CellAttrs = { fg: 8, fgMode: ColorMode.Palette };
const SEPARATOR_ATTRS: CellAttrs = { fg: 8, fgMode: ColorMode.Palette, dim: true };
// Accent for the split separator while it's hovered as a drag handle. Filled
// in by rebuildPanelViewColors so it tracks the terminal theme.
const SEPARATOR_HOVER_ATTRS: CellAttrs = { fg: 8, fgMode: ColorMode.Palette };

export function rebuildPanelViewColors(): void {
  // chrome-tokens is rebuilt first (see main.ts's onBackground handler), so the
  // token reads below are already adapted to the detected background.
  for (const a of [CURSOR_ATTRS, GROUP_SELECTED_ATTRS, PREVIEW_TAB_ACTIVE_ATTRS]) {
    a.fg = tokens.accent.fg;
    a.fgMode = tokens.accent.fgMode;
  }
  PREVIEW_TAB_ACTIVE_ATTRS.bg = theme.selected;
  PRIORITY_ATTRS[2]!.fg = tokens.textPrimary.fg;
  PRIORITY_ATTRS[2]!.fgMode = tokens.textPrimary.fgMode;
  SEPARATOR_HOVER_ATTRS.fg = tokens.accent.fg;
  SEPARATOR_HOVER_ATTRS.fgMode = tokens.accent.fgMode;
  const n = neutralFg(7);
  TITLE_ATTRS.fg = n.fg;
  TITLE_ATTRS.fgMode = n.fgMode;
  // The detail attributes moved out with their builder, but the rebuild stays
  // a single entry point so main.ts's onBackground handler has one thing to call.
  rebuildIssueDetailColors();
}
rebuildPanelViewColors();

const ACTION_BAR_ROWS = 2;
const MIN_ROWS_FOR_DETAIL = 15;
const MIN_LIST_ROWS = 3;
const MIN_DETAIL_ROWS = 4;

/** Where the split sits when the user hasn't dragged it. */
export const DEFAULT_PANEL_SPLIT_RATIO = 0.5;

/**
 * Row geometry of a panel view: `[filter bar] | list | separator | detail |
 * action bar`, all 0-indexed rows within the panel's own grid.
 *
 * This is the single source of truth for that layout. It exists because the
 * numbers were previously derived twice — once here for painting, and again
 * in main.ts for hit-testing wheel/click positions — using two *different*
 * formulas: main.ts's omitted both the filter-bar row and the max-list clamp,
 * so with a filter active its idea of where the list ended was a row off from
 * what was actually drawn, and clicks near the boundary mis-routed.
 */
export interface PanelViewLayout {
  /** False on a short panel: no separator, no detail, no action bar. */
  showDetail: boolean;
  filterBarRows: number;
  listStartRow: number;
  listRows: number;
  /** Row the `─` separator is drawn on; `rows` (off-grid) when !showDetail. */
  sepRow: number;
  detailStart: number;
  detailRows: number;
  actionBarStart: number;
  /** Legal range for `sepRow`, i.e. how far a split drag may travel. */
  minSepRow: number;
  maxSepRow: number;
}

export function computeViewLayout(
  rows: number,
  filterBarActive: boolean,
  splitRatio: number = DEFAULT_PANEL_SPLIT_RATIO,
): PanelViewLayout {
  // Total for any input. The ratio reaches here from a hand-editable config
  // file, and a non-numeric one used to propagate NaN through listRows into
  // `grid.cells[NaN]` — a thrown TypeError out of the render loop. Clamping
  // out-of-range values is free once we're checking anyway.
  const ratio = Number.isFinite(splitRatio)
    ? Math.max(0, Math.min(1, splitRatio))
    : DEFAULT_PANEL_SPLIT_RATIO;
  const showDetail = rows >= MIN_ROWS_FOR_DETAIL;
  const filterBarRows = filterBarActive ? 1 : 0;
  const listStartRow = filterBarRows;
  const actionBarStart = showDetail ? rows - ACTION_BAR_ROWS : rows;

  // The pool the list and detail share — everything except the filter bar,
  // the separator row itself, and the action bar.
  const splittable = rows - ACTION_BAR_ROWS - 1 - filterBarRows;
  const maxListRows = showDetail
    ? rows - MIN_DETAIL_ROWS - 1 - ACTION_BAR_ROWS - filterBarRows
    : rows - filterBarRows;

  // Round, not floor: splitRatioForSepRow is the exact inverse of this, and
  // floor loses the round trip to float error (splittable * (n/splittable)
  // can land a hair under n), which would make a dragged separator settle one
  // row above the pointer.
  const listRows = showDetail
    ? Math.min(maxListRows, Math.max(MIN_LIST_ROWS, Math.round(splittable * ratio)))
    : rows - filterBarRows;

  const sepRow = showDetail ? listStartRow + listRows : rows;
  const detailStart = sepRow + 1;
  const detailRows = showDetail ? actionBarStart - detailStart : 0;

  return {
    showDetail,
    filterBarRows,
    listStartRow,
    listRows,
    sepRow,
    detailStart,
    detailRows,
    actionBarStart,
    // Math.min guards a panel just tall enough for a detail pane, where
    // maxListRows can fall below MIN_LIST_ROWS — the range must never invert.
    minSepRow: listStartRow + Math.min(MIN_LIST_ROWS, maxListRows),
    maxSepRow: listStartRow + maxListRows,
  };
}

/**
 * The split ratio that puts the separator on `sepRow` — the inverse of the
 * `listRows` calculation above, so a drag and the paint that follows it agree.
 * Callers clamp `sepRow` to [minSepRow, maxSepRow] first.
 */
export function splitRatioForSepRow(rows: number, filterBarActive: boolean, sepRow: number): number {
  const filterBarRows = filterBarActive ? 1 : 0;
  const splittable = rows - ACTION_BAR_ROWS - 1 - filterBarRows;
  if (splittable <= 0) return DEFAULT_PANEL_SPLIT_RATIO;
  return Math.max(0, Math.min(1, (sepRow - filterBarRows) / splittable));
}

/**
 * The preview strip: one tab per issue in the current set, drawn at the top of
 * the detail pane.
 *
 * Resolved by main.ts rather than derived here, the same boundary as the
 * sidebar's `setSessionWorkflow`: which issues form the set depends on the ticks,
 * the focused session's links and the tracker's own issue objects, none of
 * which a renderer should know how to reach.
 */
export interface PreviewTabs {
  /** In display order. Fewer than two and the strip is not drawn at all. */
  items: RenderableItem[];
  /** The item whose detail fills the pane, and the tab drawn as active. */
  activeId: string | null;
}

/**
 * The strip's three rows: labels, the rule beneath them, and a blank margin
 * before the issue body.
 *
 * The rule is its *own* row rather than an overlay on the pane separator above.
 * A tab sits on top of its content with the underline between the two — put the
 * rule above the labels and the same glyphs read as an overline on a heading.
 * The margin is what stops the body looking welded to the bar.
 */
const PREVIEW_STRIP_ROWS = 3;

/**
 * A floor, not a tuning knob: the strip must never take the pane's last usable
 * rows. `MIN_DETAIL_ROWS` keeps `detailRows` at 5 or more whenever a detail pane
 * exists at all, so at its very shortest the strip leaves two rows of issue
 * body — thin, but the tabs are how you reach the rest.
 */
const MIN_ROWS_FOR_PREVIEW_TABS = PREVIEW_STRIP_ROWS + 2;

const OVERFLOW_LEFT = "‹";
const OVERFLOW_RIGHT = "›";
/**
 * Two blank columns between tabs, and no separator glyph — the toolbar's rule
 * exactly (`space.groupGutter`). The gap plus the state rule below each tab
 * already delimits them; a `│` on top of both is a third divider saying the
 * same thing.
 */
const PREVIEW_TAB_GUTTER = space.groupGutter;

/**
 * Which tabs to draw, and where.
 *
 * Windowed rather than truncated: `packChips` drops what does not fit from the
 * end, which would silently hide the active tab whenever it sat past the
 * budget — a strip whose whole job is showing you where you are. So the window
 * slides to keep the active tab in it, and overflow arrows say the rest are
 * still there.
 *
 * Exported for the click hit-test, which must resolve a column against exactly
 * the chips that were drawn.
 */
export function layoutPreviewTabs(
  tabs: PreviewTabs,
  cols: number,
): { chips: PlacedChip[]; overflowLeft: boolean; overflowRight: boolean } {
  const labels = tabs.items.map((i) => ({ id: i.id, width: textCols(previewTabLabel(i)) }));
  const activeIdx = Math.max(0, tabs.items.findIndex((i) => i.id === tabs.activeId));

  /**
   * The column chips start at for a window beginning at `s`. A left arrow does
   * not merely occupy column 0 — it also pushes the chips one column right, so
   * a flat "reserve two columns" budget under-counts it by one and lets the
   * last chip land on the column the right arrow needs.
   */
  const chipStart = (s: number) => (s > 0 ? 2 : 1);
  /** Columns available to chips for the window `[s, e]`, arrows included. */
  const room = (s: number, e: number) =>
    cols - chipStart(s) - (e < labels.length - 1 ? 1 : 0);

  // Widen from the active tab outwards. Every test is against the window that
  // would *result* — extending changes which arrows are needed, so a fit
  // measured against the current window is measuring the wrong thing.
  let start = activeIdx;
  let end = activeIdx;
  let used = labels[activeIdx]?.width ?? 0;
  for (;;) {
    // `+ PREVIEW_TAB_GUTTER`, matching what packChips will actually insert. A
    // window measured against a narrower gap than the pack uses overflows the
    // budget, and packChips drops from the end — which can drop the active tab,
    // the one thing the window exists to keep.
    const nextW = end + 1 < labels.length ? labels[end + 1]!.width + PREVIEW_TAB_GUTTER : 0;
    const prevW = start > 0 ? labels[start - 1]!.width + PREVIEW_TAB_GUTTER : 0;
    const canRight = nextW > 0 && used + nextW <= room(start, end + 1);
    const canLeft = prevW > 0 && used + prevW <= room(start - 1, end);
    if (!canRight && !canLeft) break;
    // Right first when both are open and the right tab is no wider, so the
    // common case (near the start, or the whole set fits) reads left-to-right
    // in the order it was written.
    if (canRight && (!canLeft || nextW <= prevW)) { used += nextW; end++; }
    else { used += prevW; start--; }
  }

  const overflowRight = end < labels.length - 1;
  const chips = packChips(labels.slice(start, end + 1), {
    start: chipStart(start),
    // Exclusive end, so a chip can never be placed on the right arrow's column.
    budget: cols - (overflowRight ? 1 : 0),
    align: "left",
    sepWidth: PREVIEW_TAB_GUTTER,
  });
  return { chips, overflowLeft: start > 0, overflowRight };
}

/**
 * A tab's text, padded into a chip the way the panel's own tab bar pads its
 * labels — the padding is what gives a chip a body once it has a background
 * behind it.
 *
 * A finished issue is marked in the *label* rather than by colour. The strip
 * has three tones and they are all spoken for (accent-bold active, receded
 * inactive, and the separator), so a fourth "more receded than dim" does not
 * exist; and a glyph survives any palette, including a terminal that renders
 * dim as no change at all.
 */
function previewTabLabel(item: RenderableItem): string {
  const done = item.stateType !== undefined
    && (item.stateType === "completed" || item.stateType === "canceled" || item.stateType === "duplicate");
  return done ? ` ✓ ${item.primary} ` : ` ${item.primary} `;
}

/**
 * The index `delta` steps to, from whatever the strip is currently anchored on.
 *
 * `anchorId` is the pinned tab when there is one, else the list cursor's item —
 * which is often *not* in the set, because the cursor is free to wander off it.
 * An absent anchor enters from the end the step is coming from, so one press
 * lands on the first tab going forward and the last going back, rather than
 * silently doing nothing or jumping to an arbitrary index.
 *
 * Wraps, like every other tab strip here. Returns -1 for an empty set.
 */
export function stepPreviewIndex(
  count: number,
  anchorIndex: number,
  delta: number,
): number {
  if (count <= 0) return -1;
  const from = anchorIndex >= 0 ? anchorIndex : (delta > 0 ? -1 : 0);
  return (((from + delta) % count) + count) % count;
}

/**
 * Which tab is lit: the pin, else the list cursor, else nothing.
 *
 * The cursor clause is the one that is easy to leave out, and leaving it out is
 * invisible in code review — the pin is null until `{`/`}` is actually pressed,
 * so a strip resolving only the pin opens with nothing lit and stays that way
 * until you move it, while the pane below is quite plainly showing one of the
 * tabs. The two cursors agree far more often than they differ; when they agree,
 * the strip has to say so.
 *
 * `null` is reserved for when they genuinely cannot agree: the list cursor has
 * wandered off the set entirely. Either id is ignored once it leaves `items`,
 * so a poll dropping a link cannot leave a tab lit that is no longer there.
 */
export function resolveActiveTab(
  items: readonly RenderableItem[],
  pinnedId: string | null,
  cursorId: string | null,
): string | null {
  const inSet = (id: string | null) => id !== null && items.some((i) => i.id === id);
  if (inSet(pinnedId)) return pinnedId;
  if (inSet(cursorId)) return cursorId;
  return null;
}

/** The tab a click at `col` on the strip row lands on, or null. */
export function previewTabAtCol(
  tabs: PreviewTabs,
  cols: number,
  col: number,
): string | null {
  return chipAtCol(layoutPreviewTabs(tabs, cols).chips, col);
}

/**
 * The strip's row within the panel, or null when no strip is drawn.
 *
 * Exported because click routing in main.ts has to know the row *before* it can
 * ask which tab was hit, and it must agree with the render exactly — this is
 * the same reason `computeViewLayout` is the single source of truth for the
 * pane bands rather than a formula re-derived at the call site.
 */
export function previewTabRow(
  rows: number,
  state: ViewState,
  tabs: PreviewTabs | undefined,
  splitRatio?: number,
): number | null {
  if (!tabs || tabs.items.length < 2) return null;
  const layout = computeViewLayout(rows, state.filterQuery !== null, splitRatio);
  if (!layout.showDetail || layout.detailRows < MIN_ROWS_FOR_PREVIEW_TABS) return null;
  return layout.detailStart;
}

/**
 * Draw the strip: labels on `row`, their rule on the row below.
 *
 * The rule is drawn per chip rather than across the panel, which is the one
 * place this departs from the toolbar. The toolbar's tab rule is the terminal's
 * own frame line, already spanning the width for its own reasons; the panel
 * already has such a line — the pane separator two rows up — and a second
 * full-width rule right under it would read as a doubled pane border rather
 * than as tab chrome.
 *
 * Finished issues stay on the strip rather than disappearing — the set is what
 * the session carries, and a tab vanishing when a ticket closed would renumber
 * the strip under the user's cursor mid-read.
 */
function renderPreviewTabs(
  grid: CellGrid,
  row: number,
  cols: number,
  tabs: PreviewTabs,
): void {
  const ruleRow = row + 1;
  const { chips, overflowLeft, overflowRight } = layoutPreviewTabs(tabs, cols);
  if (overflowLeft) writeString(grid, row, 0, OVERFLOW_LEFT, PREVIEW_TAB_ATTRS);
  if (overflowRight) writeString(grid, row, cols - 1, OVERFLOW_RIGHT, PREVIEW_TAB_ATTRS);

  for (const chip of chips) {
    const item = tabs.items.find((it) => it.id === chip.id);
    if (!item) continue;
    const isActive = item.id === tabs.activeId;
    writeString(
      grid, row, chip.x, previewTabLabel(item),
      isActive ? PREVIEW_TAB_ACTIVE_ATTRS : PREVIEW_TAB_ATTRS,
    );

    // Heavy accent under the active tab, light frame rule under the rest —
    // `tabUnderlineGlyphAndAttrs`' table, minus the bell and hover states the
    // strip has no equivalent of. Weight signals active, hue reinforces it.
    const glyph = isActive ? frame.ruleHeavy : frame.ruleLight;
    const attrs = isActive ? { ...tokens.accent, dim: false } : tokens.ruleFrame;
    for (let i = 0; i < chip.width; i++) {
      writeString(grid, ruleRow, chip.x + i, glyph, attrs);
    }
  }
}

export function renderView(
  nodes: ViewNode[],
  cols: number,
  rows: number,
  state: ViewState,
  opts: { splitRatio?: number; splitHovered?: boolean; previewTabs?: PreviewTabs } = {},
): CellGrid {
  const grid = createGrid(cols, rows);

  // Filter bar: null = off, "" = bar visible but empty, "abc" = filtering
  const filterBarActive = state.filterQuery !== null;

  // Layout: [filter bar] | list | separator | detail content | action bar
  const {
    showDetail, listStartRow, listRows,
    sepRow, detailStart, detailRows, actionBarStart,
  } = computeViewLayout(rows, filterBarActive, opts.splitRatio);

  // Render filter bar
  if (filterBarActive) {
    writeString(grid, 0, 1, "/", DETAIL_KEY);
    if (state.filterQuery) {
      writeString(grid, 0, 3, state.filterQuery.slice(0, cols - 4), TITLE_ATTRS);
    }
  }

  // Render list
  if (nodes.length === 0 && filterBarActive) {
    // Empty state
    const msg = "No matches";
    const msgCol = Math.max(0, Math.floor((cols - msg.length) / 2));
    writeString(grid, listStartRow + Math.floor(listRows / 2), msgCol, msg, DIM_ATTRS);
  } else {
    // The checkbox column appears only once something is ticked. Reserving it
    // permanently would cost every user four columns of title on a panel that
    // is already narrow, for a mode most of them are not in — and the first
    // press revealing the boxes is what teaches the mode exists.
    const checkMark = state.checkedIds.size > 0
      ? (item: RenderableItem) => state.checkedIds.has(item.id)
      : null;
    let visibleIdx = 0;
    for (let i = 0; i < nodes.length && visibleIdx < listRows + state.scrollOffset; i++) {
      if (visibleIdx < state.scrollOffset) { visibleIdx++; continue; }
      const row = listStartRow + visibleIdx - state.scrollOffset;
      if (row >= listStartRow + listRows) break;
      const node = nodes[i];
      const isSelected = i === state.selectedIndex;

      if (node.kind === "group") {
        renderGroupHeader(grid, row, cols, node, isSelected);
      } else {
        renderItem(grid, row, cols, node.item, node.depth, isSelected, checkMark);
      }
      visibleIdx++;
    }
  }

  // Render detail pane
  if (showDetail) {
    // Separator — doubles as the drag handle that moves the split, so it
    // accents on hover the same way the sidebar/panel edges do.
    writeString(
      grid, sepRow, 0, "─".repeat(cols),
      opts.splitHovered ? SEPARATOR_HOVER_ATTRS : SEPARATOR_ATTRS,
    );

    // The preview strip, when there is a set to show and room to show it. It
    // takes a row off the top of the detail pane rather than out of the layout,
    // so the separator stays where the user dragged it and the list keeps the
    // height they chose.
    const tabs = opts.previewTabs;
    const showTabs = tabs !== undefined
      && tabs.items.length >= 2
      && detailRows >= MIN_ROWS_FOR_PREVIEW_TABS;
    if (showTabs) renderPreviewTabs(grid, detailStart, cols, tabs);
    const bodyStart = showTabs ? detailStart + PREVIEW_STRIP_ROWS : detailStart;
    const bodyRows = showTabs ? detailRows - PREVIEW_STRIP_ROWS : detailRows;

    // Detail content (scrollable). The pinned preview outranks the cursor: it
    // is the newer of the two pointing gestures, and the one the strip above is
    // reporting. main.ts clears the pin whenever the cursor moves, so this can
    // only win while the user's last move was on the strip.
    const selectedNode = nodes[state.selectedIndex];
    const pinned = tabs?.items.find((i) => i.id === tabs.activeId) ?? null;
    const detailItem = pinned ?? (selectedNode?.kind === "item" ? selectedNode.item : null);
    if (detailItem) {
      renderDetail(grid, bodyStart, cols, bodyRows, detailItem, state.detailScrollOffset);
    } else if (selectedNode?.kind === "group") {
      writeString(grid, bodyStart, 2, `${selectedNode.label} — ${selectedNode.count} items`, GROUP_ATTRS);
    }

    // Action bar — always at the bottom
    const actionSepRow = actionBarStart - 1;
    if (actionSepRow > detailStart) {
      writeString(grid, actionSepRow, 0, "─".repeat(cols), SEPARATOR_ATTRS);
    }
    // The bar sits under the detail pane and describes what the keys will do,
    // and the keys act on what you are reading — so it follows the preview, not
    // the cursor, whenever the two differ.
    renderActionBar(grid, actionBarStart, cols, detailItem);
  }

  return grid;
}

function renderGroupHeader(grid: CellGrid, row: number, cols: number, node: Extract<ViewNode, { kind: "group" }>, selected: boolean): void {
  const indent = node.depth * 2;
  let col = indent;
  if (selected) {
    writeString(grid, row, col, node.collapsed ? "▸" : "▾", CURSOR_ATTRS);
  } else {
    writeString(grid, row, col, node.collapsed ? "▸" : "▾", DIM_ATTRS);
  }
  col += 2;
  const label = `${node.label} (${node.count})`;
  writeString(grid, row, col, label, selected ? GROUP_SELECTED_ATTRS : GROUP_ATTRS);
}

export function pickSessionIndicator(item: RenderableItem): { glyph: string; glyphAttrs: CellAttrs } {
  if (item.type === "issue") {
    const state = item.issueSessionState ?? "none";
    if (state === "session") {
      return { glyph: "●", glyphAttrs: item.sessionLinked ? SESSION_CURRENT_ATTRS : LINKED_ATTRS };
    }
    if (state === "worktree") {
      return { glyph: "◐", glyphAttrs: WORKTREE_ATTRS };
    }
    return { glyph: "○", glyphAttrs: UNLINKED_ATTRS };
  }
  // MR: no session-state model, fall back to "linked to current session" dot
  return item.sessionLinked
    ? { glyph: "●", glyphAttrs: LINKED_ATTRS }
    : { glyph: "○", glyphAttrs: UNLINKED_ATTRS };
}

function renderItem(
  grid: CellGrid,
  row: number,
  cols: number,
  item: RenderableItem,
  depth: number,
  selected: boolean,
  /** null when nothing is ticked anywhere in the view — no column is drawn. */
  checkMark: ((item: RenderableItem) => boolean) | null,
): void {
  const indent = depth * 2;
  let col = indent;

  // Cursor
  if (selected) {
    writeString(grid, row, col, "▸", CURSOR_ATTRS);
    col += 2;
  } else {
    col += 2;
  }

  if (checkMark) {
    writeString(grid, row, col, checkMark(item) ? "[x]" : "[ ]", selected ? CURSOR_ATTRS : DIM_ATTRS);
    col += 4;
  }

  // Session indicator
  //   ●  bold green  — issue has a session AND that session is the one currently focused
  //   ●  green       — issue has a session somewhere (not the current one)
  //   ◐  dim green   — issue has a worktree but no live session
  //   ○  dim grey    — issue has nothing
  // For MRs (no issueSessionState), retain the original sessionLinked-driven dot.
  const { glyph, glyphAttrs } = pickSessionIndicator(item);
  writeString(grid, row, col, glyph, glyphAttrs);
  col += 2;

  // Right-hand gutter, packed right-to-left: age, then pipeline, then priority.
  // Each is optional, so the title reclaims whatever they don't use.
  let right = cols;

  const age = formatAge(item.updatedAt, nowMs());
  if (age) {
    right -= age.length + 1;
    writeString(grid, row, right + 1, age, DIM_ATTRS);
  }

  const pipeGlyph = item.pipeline ? PIPELINE_GLYPH[item.pipeline] : "";
  if (pipeGlyph) {
    right -= 2;
    writeString(grid, row, right + 1, pipeGlyph, PIPELINE_ATTRS[item.pipeline!] ?? DIM_ATTRS);
  }

  const priBadge = item.priority > 0 && item.priority <= 4 ? `P${item.priority}` : "";
  if (priBadge) {
    right -= priBadge.length + 1;
    writeString(grid, row, right + 1, priBadge, PRIORITY_ATTRS[item.priority] ?? DIM_ATTRS);
  }

  // Primary + title fills whatever is left of the gutter.
  const maxTextLen = right - col - 1;
  const text = truncateToCols(`${item.primary} ${item.title}`, maxTextLen);
  writeString(grid, row, col, text, selected ? { ...TITLE_ATTRS, bold: true } : TITLE_ATTRS);
}

function buildMrDetailLines(item: RenderableItem, cols: number): DetailLine[] {
  const mr = item.raw as MergeRequest;
  const pad = 2;
  const contentWidth = cols - pad * 2;
  const lines: DetailLine[] = [];

  lines.push({ text: `${item.primary} ${mr.title}`.slice(0, contentWidth), attrs: { ...DETAIL_VALUE, bold: true } });

  const statusLabel = mr.status.charAt(0).toUpperCase() + mr.status.slice(1);
  lines.push({ text: `${statusLabel}  ${mr.sourceBranch} → ${mr.targetBranch}`.slice(0, contentWidth), attrs: DETAIL_LABEL });

  if (mr.pipeline) {
    const glyphs: Record<string, string> = { passed: "✓", running: "⟳", failed: "✗", pending: "○", canceled: "—" };
    lines.push({ text: `${glyphs[mr.pipeline.state] ?? "?"} Pipeline ${mr.pipeline.state}`, attrs: DETAIL_VALUE });
  }

  lines.push({ text: `Approvals: ${mr.approvals.current}/${mr.approvals.required}`, attrs: DETAIL_VALUE });
  if (mr.author) lines.push({ text: `Author: ${mr.author}`, attrs: DETAIL_LABEL });
  if (mr.reviewers && mr.reviewers.length > 0) {
    lines.push({ text: `Reviewers: ${mr.reviewers.join(", ")}`, attrs: DETAIL_LABEL });
  }

  return lines;
}

function renderDetail(grid: CellGrid, startRow: number, cols: number, maxRows: number, item: RenderableItem, scrollOffset: number): void {
  const lines = item.type === "issue"
    ? buildIssueDetailLines(item.raw as Issue, cols)
    : buildMrDetailLines(item, cols);
  paintDetailLines(grid, startRow, 0, cols, maxRows, lines, scrollOffset);
}

function writeAction(grid: CellGrid, row: number, col: number, key: string, label: string): number {
  writeString(grid, row, col, key, DETAIL_KEY);
  col += key.length;
  writeString(grid, row, col, label, DETAIL_LABEL);
  col += label.length;
  return col;
}

function renderActionBar(grid: CellGrid, startRow: number, cols: number, item: RenderableItem | null): void {
  const pad = 2;

  // Row 2: utility actions (always shown, even when no item selected)
  let utilCol = pad;
  utilCol = writeAction(grid, startRow + 1, utilCol, "[/]", " Search  ");
  utilCol = writeAction(grid, startRow + 1, utilCol, "[r]", " Refresh  ");

  if (!item) return;

  if (item.type === "issue") {
    const nLabel = item.issueSessionState === "session" ? "Switch"
      : item.issueSessionState === "worktree" ? "Resume"
      : "Start";
    let col = pad;
    col = writeAction(grid, startRow, col, "[o]", " Open  ");
    col = writeAction(grid, startRow, col, "[n]", ` ${nLabel}  `);
    col = writeAction(grid, startRow, col, "[l]", " Link  ");
    col = writeAction(grid, startRow, col, "[s]", " Status  ");
    col = writeAction(grid, startRow, col, "[c]", " Copy  ");
    col = writeAction(grid, startRow, col, "[C]", " Create  ");
  } else {
    let col = pad;
    col = writeAction(grid, startRow, col, "[o]", " Open  ");
    col = writeAction(grid, startRow, col, "[l]", " Link  ");
    col = writeAction(grid, startRow, col, "[a]", " Approve  ");
  }
}
