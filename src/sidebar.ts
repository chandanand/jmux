import type { SessionOtelState, CellGrid, SessionInfo, AgentState, AgentStateRecord } from "./types";
import { ColorMode, makeSessionOtelState } from "./types";
import { createGrid, writeString, textCols, truncateToCols, type CellAttrs } from "./cell-grid";
import type { SessionContext } from "./adapters/types";
import {
  buildSessionView,
  buildSessionRow3,
  buildSessionIssueRows,
  type SessionIssueRow,
} from "./session-view";
import { displaySessionName } from "./session-title/display";
import { theme } from "./theme";
import { tokens, frame } from "./chrome-tokens";
import { stateAttrs, type StateColor } from "./state-colors";
import {
  matchesFilter,
  sortIndices,
  cycleGroup,
  cycleSort,
  cycleFilter,
  statusRank,
  statusGroupLabel,
  groupModeShort,
  sortModeShort,
  filterModeShort,
  type GroupMode,
  type SortMode,
  type FilterMode,
  type SessionStatus,
  type SessionSortInfo,
} from "./sidebar-sort";
import type { SessionWorkflow } from "./workflow-drift";
import type { GhostEntry } from "./ghosts";
import type { NavTarget } from "./nav-order";

export interface PinnedPaneEntry {
  paneId: string;
  label: string;
  homeSessionName: string;
  /** Agent state of this pane's session, for the Command Center breakdown. */
  agentState?: AgentState | null;
}

export type SidebarSelection =
  | { type: "overview" }
  | { type: "session"; id: string }
  | { type: "pinnedPane"; paneId: string }
  /** An unstarted issue in the Up next band. Carries only the id: the caller
   * owns the issue data, and the sidebar deliberately knows nothing about
   * trackers (same boundary as `setSessionWorkflow`). */
  | { type: "ghost"; issueId: string }
  /**
   * One issue of a session whose issue list is expanded. Carries the session as
   * well as the issue because the row is a *sub-row* — activating it means "go
   * to this session, and look at this issue of it", which needs both.
   */
  | { type: "sessionIssue"; sessionId: string; issueId: string };

const HEADER_ROWS = 2; // "Sessions" header + separator

const DIM_ATTRS: CellAttrs = { dim: true };
const ACCENT_ATTRS: CellAttrs = {
  fg: 2,
  fgMode: ColorMode.Palette,
};
// Active/hover row highlight backgrounds. These sit on top of the terminal's
// own background, so they track the detected theme (selection/hover tints).
// Under DEFAULT_THEME they equal the original #1e2a35 / #1a1f26 values, so
// terminals that don't answer the OSC 11 query are visually unchanged. Both are
// reassigned by rebuildSidebarColors() once a background is detected.
let ACTIVE_BG = theme.selected;
// The selection rail is the single jmux accent (focus), not a state colour —
// it must read distinctly from a running agent's green dot next to it.
const ACTIVE_MARKER_ATTRS: CellAttrs = {
  fg: tokens.accent.fg,
  fgMode: tokens.accent.fgMode,
  bold: true,
  bg: ACTIVE_BG,
  bgMode: ColorMode.RGB,
};
// "activity" means tmux saw output with no agent-state opinion — it is
// explicitly NOT an agent state, so it takes the neutral/receded tertiary
// tone rather than the running state's green.
const ACTIVITY_ATTRS: CellAttrs = {
  fg: tokens.textTertiary.fg,
  fgMode: tokens.textTertiary.fgMode,
  dim: tokens.textTertiary.dim,
};
// Style emphasis per state is fixed and meaningful (waiting bold = needs you,
// complete dim = receded); only the hue is user-configurable.
const STATE_MODIFIERS: Record<AgentState, { bold?: boolean; dim?: boolean }> = {
  running: {},
  waiting: { bold: true },
  complete: { dim: true },
};
// Bootstrap default, used only until the app calls setStateColors() with the
// configured/resolved colors (main.ts does this immediately after
// construction). Expressed as StateColor so it flows through the same
// stateAttrs() resolver as every other state color.
const DEFAULT_STATE_PALETTE: Record<AgentState, StateColor> = {
  running: { kind: "palette", index: 2 },  // green
  waiting: { kind: "palette", index: 3 },  // yellow
  complete: { kind: "palette", index: 4 }, // blue
};
const STATE_LABEL_TEXT: Record<AgentState, string> = {
  running: "RUNNING",
  waiting: "WAITING",
  complete: "COMPLETE",
};
function buildStateAttrs(colors: Record<AgentState, StateColor>): Record<AgentState, CellAttrs> {
  const make = (state: AgentState): CellAttrs => stateAttrs(colors[state], STATE_MODIFIERS[state]);
  return { running: make("running"), waiting: make("waiting"), complete: make("complete") };
}
const ERROR_ATTRS: CellAttrs = {
  fg: 1,
  fgMode: ColorMode.Palette,
  bold: true,
};
const MCP_DOWN_ATTRS: CellAttrs = {
  fg: 1,
  fgMode: ColorMode.Palette,
  dim: true,
};
const MODE_PLAN_ATTRS: CellAttrs = {
  fg: 6,
  fgMode: ColorMode.Palette,
};
const MODE_ACCEPT_EDITS_ATTRS: CellAttrs = {
  fg: 3,
  fgMode: ColorMode.Palette,
};
const MODE_COMPACTION_ATTRS: CellAttrs = { dim: true };
// The selected row's name is white-bold (textPrimary), not green — green is
// reserved for the running state; a selected running session was previously
// green-on-green with its own indicator dot.
const ACTIVE_NAME_ATTRS: CellAttrs = {
  fg: tokens.textPrimary.fg,
  fgMode: tokens.textPrimary.fgMode,
  bold: true,
  bg: ACTIVE_BG,
  bgMode: ColorMode.RGB,
};
const ACTIVE_DETAIL_ATTRS: CellAttrs = {
  dim: true,
  bg: ACTIVE_BG,
  bgMode: ColorMode.RGB,
};
const INACTIVE_NAME_ATTRS: CellAttrs = {
  fg: 7,
  fgMode: ColorMode.Palette,
};
// Subtle hover background — a gentle lift off the terminal background.
let HOVER_BG = theme.hover;
const HOVER_NAME_ATTRS: CellAttrs = {
  fg: 7,
  fgMode: ColorMode.Palette,
  bg: HOVER_BG,
  bgMode: ColorMode.RGB,
};
const HOVER_DETAIL_ATTRS: CellAttrs = {
  dim: true,
  bg: HOVER_BG,
  bgMode: ColorMode.RGB,
};

// Ghost rows. The identifier is secondary rather than primary text and the
// marker is a hollow ring against the live rows' filled dot — a ghost must read
// as "not running yet" at a glance, or the sidebar stops being a truthful
// picture of what exists.
const GHOST_MARK_ATTRS: CellAttrs = {
  fg: tokens.textTertiary.fg,
  fgMode: tokens.textTertiary.fgMode,
  dim: tokens.textTertiary.dim,
};
const GHOST_ID_ATTRS: CellAttrs = {
  fg: tokens.textSecondary.fg,
  fgMode: tokens.textSecondary.fgMode,
};
const GHOST_TITLE_ATTRS: CellAttrs = { dim: true };

// Disclosed issue rows under an expanded session. Everything here is quieter
// than the session row above it: these are its contents, not peers of it, and a
// five-issue session must not out-shout a one-issue session beside it.
const ISSUE_STEM = "·";
const ISSUE_STEM_ATTRS: CellAttrs = {
  fg: tokens.ruleHairline.fg,
  fgMode: tokens.ruleHairline.fgMode,
  dim: tokens.ruleHairline.dim,
};
const ISSUE_ID_ATTRS: CellAttrs = {
  fg: tokens.textSecondary.fg,
  fgMode: tokens.textSecondary.fgMode,
};
const ISSUE_TITLE_ATTRS: CellAttrs = { dim: true };
const ISSUE_STATUS_ATTRS: CellAttrs = {
  fg: tokens.textTertiary.fg,
  fgMode: tokens.textTertiary.fgMode,
  dim: tokens.textTertiary.dim,
};
// A finished issue stays on the list — it is still something the session
// carries — but recedes, so the open work reads first.
const ISSUE_DONE_ATTRS: CellAttrs = { dim: true };
/** Below this a title is a stub rather than information, so it is dropped. */
const ISSUE_TITLE_MIN_COLS = 6;
// Status shorthand, from the tracker-agnostic stateType rather than the status
// name: names are workspace-defined ("QA Failed", "Ready for review") and no
// abbreviation of them is safe, while these six categories are fixed.
const STATE_TYPE_GLYPH: Record<string, string> = {
  triage: "?",
  backlog: "·",
  unstarted: "○",
  started: "◐",
  completed: "✓",
  canceled: "✗",
  duplicate: "⧉",
  unknown: "·",
};

// The workflow field at the head of a session's detail row: the stage the
// driving issue sits in, or — when that disagrees with what the MR and the
// session already prove — where the workflow says it should be.
const WORKFLOW_ARROW = "→";
// The minimal drift form. Deliberately not "⚠": this sidebar tracks columns
// explicitly and that glyph's width varies between terminals, which is the
// class of drift between the width table and the real terminal that leaves
// ghost gaps. "!" is unambiguously one column and already reads as attention
// here, in column 1.
const WORKFLOW_DRIFT_MARK = "!";
/**
 * Separates the workflow field from the branch — two words on one row. Absent
 * when either is dropped, and narrowed to a plain space when the field has
 * degraded to a marker rather than a word (see `terse` below).
 */
const WORKFLOW_SEP = " · ";
const WORKFLOW_ATTRS: CellAttrs = {
  fg: tokens.textTertiary.fg,
  fgMode: tokens.textTertiary.fgMode,
  dim: tokens.textTertiary.dim,
};

/**
 * What the workflow field says at a given width, longest affordable form first.
 *
 * Under drift the target is the actionable half — it is also exactly what the
 * fix key will write — so the current stage gives way before it does.
 *
 * `stageInHeader` drops the current stage from every form, because the band
 * above the row already names it. Grouped by stage, a row reading "Review"
 * under a "REVIEW" header says nothing and costs the branch six columns to say
 * it. Drift survives that: the header supplies where the ticket *is*, and the
 * disagreement is about where it should be.
 *
 * `terse` marks the last-resort single-character forms. They are markers rather
 * than words, and the caller separates them from the branch with a plain space:
 * `·` is both the `backlog`/`unknown` glyph *and* the character inside the
 * word separator, so `· · feat/x` would put three visual tokens where there are
 * two things being said.
 */
function workflowFieldText(
  wf: Pick<SessionWorkflow, "label" | "stateType" | "drift">,
  maxCols: number,
  stageInHeader = false,
): { text: string; terse: boolean } {
  const candidates: Array<{ text: string; terse: boolean }> = [];
  if (wf.drift) {
    const arrow = `${WORKFLOW_ARROW}${wf.drift}`;
    if (!stageInHeader) candidates.push({ text: `${wf.label}${arrow}`, terse: false });
    candidates.push({ text: arrow, terse: false });
    candidates.push({ text: WORKFLOW_DRIFT_MARK, terse: true });
  } else if (!stageInHeader) {
    candidates.push({ text: wf.label, terse: false });
    candidates.push({
      text: STATE_TYPE_GLYPH[wf.stateType ?? "unknown"] ?? STATE_TYPE_GLYPH.unknown!,
      terse: true,
    });
  }
  for (const candidate of candidates) {
    if (candidate.text && textCols(candidate.text) <= maxCols) return candidate;
  }
  return { text: "", terse: false };
}

/**
 * Re-sync the sidebar's highlight backgrounds from the current theme. Called
 * after a terminal background is detected. The bare consts (ACTIVE_BG/HOVER_BG)
 * are read at render time, but the cached HOVER_* attr objects must be patched
 * in place since they captured HOVER_BG at module load.
 */
export function rebuildSidebarColors(): void {
  ACTIVE_BG = theme.selected;
  HOVER_BG = theme.hover;
  HOVER_NAME_ATTRS.bg = HOVER_BG;
  HOVER_DETAIL_ATTRS.bg = HOVER_BG;
  // The active-row attr objects captured ACTIVE_BG at module load too, so they
  // must be patched in place — otherwise the selected row's marker and text keep
  // the stale dark selection background on a re-themed (e.g. light) terminal.
  ACTIVE_MARKER_ATTRS.bg = ACTIVE_BG;
  ACTIVE_NAME_ATTRS.bg = ACTIVE_BG;
  ACTIVE_DETAIL_ATTRS.bg = ACTIVE_BG;

  // Token-derived colours are likewise captured by value at module load, so
  // they must be re-patched from tokens.* here to track a re-theme (e.g. a
  // light-mode re-detection). tokens.* itself must already be fresh — i.e.
  // rebuildChromeTokens() must run before this — otherwise these read stale
  // values; see the caller in main.ts's OSC 11 re-detection handler.
  ACTIVE_MARKER_ATTRS.fg = tokens.accent.fg;
  ACTIVE_MARKER_ATTRS.fgMode = tokens.accent.fgMode;

  ACTIVE_NAME_ATTRS.fg = tokens.textPrimary.fg;
  ACTIVE_NAME_ATTRS.fgMode = tokens.textPrimary.fgMode;

  ACTIVITY_ATTRS.fg = tokens.textTertiary.fg;
  ACTIVITY_ATTRS.fgMode = tokens.textTertiary.fgMode;
  ACTIVITY_ATTRS.dim = tokens.textTertiary.dim;

  GROUP_HEADER_ATTRS.fg = tokens.textSecondary.fg;
  GROUP_HEADER_ATTRS.fgMode = tokens.textSecondary.fgMode;

  GROUP_HAIRLINE_ATTRS.fg = tokens.ruleHairline.fg;
  GROUP_HAIRLINE_ATTRS.fgMode = tokens.ruleHairline.fgMode;
  GROUP_HAIRLINE_ATTRS.dim = tokens.ruleHairline.dim;

  VERSION_ATTRS.fg = tokens.textTertiary.fg;
  VERSION_ATTRS.fgMode = tokens.textTertiary.fgMode;
  VERSION_ATTRS.dim = tokens.textTertiary.dim;

  UPDATE_AVAILABLE_ATTRS.fg = tokens.attention.fg;
  UPDATE_AVAILABLE_ATTRS.fgMode = tokens.attention.fgMode;

  GHOST_MARK_ATTRS.fg = tokens.textTertiary.fg;
  GHOST_MARK_ATTRS.fgMode = tokens.textTertiary.fgMode;
  GHOST_MARK_ATTRS.dim = tokens.textTertiary.dim;

  GHOST_ID_ATTRS.fg = tokens.textSecondary.fg;
  GHOST_ID_ATTRS.fgMode = tokens.textSecondary.fgMode;
}
// Group-header label tone — textSecondary, not the old bold palette-8. (The
// Command Center header, which shares this const, re-adds bold explicitly at
// its own render site.)
const GROUP_HEADER_ATTRS: CellAttrs = {
  fg: tokens.textSecondary.fg,
  fgMode: tokens.textSecondary.fgMode,
};
// The hairline fill tone that trails a group-header label out to the
// sidebar's inner edge, replacing the old disclosure-triangle form.
const GROUP_HAIRLINE_ATTRS: CellAttrs = {
  fg: tokens.ruleHairline.fg,
  fgMode: tokens.ruleHairline.fgMode,
  dim: tokens.ruleHairline.dim,
};

// Singleton empty OTEL state for promoted sessions that have no OTEL data
// yet. Reused per render frame to avoid allocating a fresh blank object.
// Frozen so accidental mutation is a runtime error rather than a silent bug.
// Note: Object.freeze only freezes direct properties; the failedMcpServers
// Set is readable but never mutated by buildSessionRow3, so shallow freeze suffices.
const EMPTY_OTEL_STATE: SessionOtelState = Object.freeze(makeSessionOtelState()) as SessionOtelState;

// --- Pipeline glyph constants ---
const PIPELINE_GLYPH_MAP: Record<string, string> = {
  passed: "✓", running: "⟳", failed: "✗", pending: "○", canceled: "—",
};
const PIPELINE_GLYPH_COLORS: Record<string, CellAttrs> = {
  passed: { fg: 2, fgMode: ColorMode.Palette },
  running: { fg: 3, fgMode: ColorMode.Palette },
  failed: { fg: 1, fgMode: ColorMode.Palette },
  pending: { fg: 3, fgMode: ColorMode.Palette },
  canceled: { fg: 8, fgMode: ColorMode.Palette, dim: true },
};

// --- Cache timer helpers ---

function cacheTimerAttrs(
  remaining: number,
  isActive: boolean,
  isHovered: boolean,
): CellAttrs {
  const base: CellAttrs = {};
  if (isActive) {
    base.bg = ACTIVE_BG;
    base.bgMode = ColorMode.RGB;
  } else if (isHovered) {
    base.bg = HOVER_BG;
    base.bgMode = ColorMode.RGB;
  }
  if (remaining <= 0) return { ...base, dim: true };
  if (remaining <= 29) return { ...base, fg: 1, fgMode: ColorMode.Palette };
  if (remaining <= 180) return { ...base, fg: 3, fgMode: ColorMode.Palette };
  return { ...base, fg: 2, fgMode: ColorMode.Palette };
}

// --- Grouping logic ---

function getGroupLabel(dir: string): string | null {
  const segments = dir.split("/").filter((s) => s.length > 0);
  // For ~/X/Y/... paths, group by X/Y (fixed depth)
  // ~/X/Y/Z → "X/Y"
  // ~/X/Y   → "X/Y"
  if (segments[0] === "~") {
    if (segments.length < 3) return null; // ~ or ~/Code — too shallow
    return segments[1] + "/" + segments[2];
  }
  // Absolute paths: /X/Y/... → group by X/Y
  if (segments.length < 2) return null;
  return segments[0] + "/" + segments[1];
}

function getSubdirectory(dir: string, groupLabel: string): string | null {
  // dir: "~/X/Y/Z", groupLabel: "X/Y" → "Z"
  // dir: "~/X/Y/Z/sub", groupLabel: "X/Y" → "Z/sub"
  const idx = dir.indexOf(groupLabel);
  if (idx < 0) return null;
  const rest = dir.slice(idx + groupLabel.length);
  // rest is e.g. "/Z" or "/Z/sub/deep"
  const trimmed = rest.replace(/^\/+/, "");
  if (!trimmed) return null;
  // For nested paths, just show the last directory name
  const lastSlash = trimmed.lastIndexOf("/");
  return lastSlash >= 0 ? trimmed.slice(lastSlash + 1) : trimmed;
}

type RenderItem =
  // `key` is the axis-namespaced collapse identity ("pinned", "project:<label>",
  // "status:<status>", "stage:<id>"); `label` is what the header renders. They
  // differ so a project literally named "Running" can't share collapse state
  // with the status group, and collapse memory is kept per axis across mode
  // switches. The stage axis keys on the stage *id* rather than its label, so
  // renaming a stage doesn't silently expand a group the user had collapsed.
  | { type: "group-header"; key: string; label: string; collapsed: boolean; sessionCount: number }
  // `stageInHeader` says the band this row was emitted under already names its
  // workflow stage, so row 2 must not repeat it. Stamped where the row is
  // *placed* rather than re-derived at paint time: a session under group=stage
  // can still land in Pinned or Parked, whose headers name neither, and a rule
  // evaluated twice is a rule that can disagree with itself.
  | { type: "session"; sessionIndex: number; grouped: boolean; groupLabel?: string; pinnedCount?: number; stageInHeader?: boolean }
  // One issue of an expanded session, drawn directly below that session's own
  // rows. A sub-row, not a peer: it is absent from `displayOrder` and from
  // `navOrder`, because both mean "somewhere to go" and this row's session is
  // already a stop on each. Landing on five of them in a row to reach the next
  // session would make Ctrl-Shift-Down useless in exactly the sessions this
  // feature exists for.
  | { type: "session-issue"; sessionIndex: number; issueIndex: number }
  // An issue with no session yet. Drawn with a session row's exact geometry —
  // identifier where the name goes, title where the detail line goes — so the
  // row it becomes on activation is the row it was already standing in for.
  | { type: "ghost"; ghostIndex: number }
  | { type: "spacer" }
  | { type: "overview"; paneCount: number };

const PINNED_GROUP_KEY = "pinned";
const PINNED_GROUP_LABEL = "Pinned";

// The mirror of Pinned: pins float to the top, parked sinks to the bottom.
// Collapsed by default — the whole point is to shrink handed-off work to one
// row without killing the session behind it.
const PARKED_GROUP_KEY = "parked";
const PARKED_GROUP_LABEL = "Parked";

// The other mirror of Parked: parked work has been handed off, up-next work has
// not been picked up. They bracket the live sessions at the bottom of the list.
// Expanded by default — unlike Parked, this band exists to *show* rows, and
// defaulting it collapsed would make enabling the setting look like a no-op.
const GHOST_GROUP_KEY = "upnext";
const GHOST_GROUP_LABEL = "Up next";

// The project bucket a session belongs to: its wtm project name (preferred) or
// a directory-derived label, else null (ungrouped).
function projectLabelOf(session: SessionInfo): string | null {
  if (session.project) return session.project;
  const dir = session.directory;
  return dir ? getGroupLabel(dir) : null;
}

// A group awaiting emission. `rank` orders status groups (needs-you first) and
// stage groups (the user's own priority order); project groups ignore it and
// order alphabetically by label.
interface GroupBucket {
  key: string;
  label: string;
  rank: number;
  indices: number[];
  /** Ghost rows in this group, emitted below its sessions. Only ever populated
   * on the stage axis — that is the only grouping an issue without a session
   * can be placed on. */
  ghostIndices: number[];
}

function buildRenderPlan(
  sessions: SessionInfo[],
  collapsedGroups: Set<string>,
  pinnedNames: Set<string>,
  pinnedPanes: PinnedPaneEntry[],
  sortInfos: SessionSortInfo[],
  groupMode: GroupMode,
  sortMode: SortMode,
  filterMode: FilterMode,
  parkedNames: Set<string> = new Set(),
  workflowByName: Map<string, SessionWorkflow> = new Map(),
  ghosts: readonly GhostEntry[] = [],
  issueRowsByName: ReadonlyMap<string, readonly SessionIssueRow[]> = new Map(),
  expandedNames: ReadonlySet<string> = new Set(),
): {
  items: RenderItem[];
  displayOrder: number[];
  navOrder: NavTarget[];
} {
  const pinnedIndices: number[] = [];
  const parkedIndices: number[] = [];
  const bucketMap = new Map<string, GroupBucket>();
  const ungrouped: number[] = [];

  // Build a map of homeSessionName → count for pinned panes
  const pinnedPaneCountBySession = new Map<string, number>();
  for (const pane of pinnedPanes) {
    pinnedPaneCountBySession.set(
      pane.homeSessionName,
      (pinnedPaneCountBySession.get(pane.homeSessionName) ?? 0) + 1,
    );
  }

  const bucketFor = (key: string, label: string, rank: number): GroupBucket => {
    let existing = bucketMap.get(key);
    if (!existing) {
      existing = { key, label, rank, indices: [], ghostIndices: [] };
      bucketMap.set(key, existing);
    }
    return existing;
  };

  const bucket = (key: string, label: string, rank: number, i: number): void => {
    bucketFor(key, label, rank).indices.push(i);
  };

  for (let i = 0; i < sessions.length; i++) {
    // Filter first — a filtered-out session never buckets, so empty groups and
    // the Pinned group simply don't emit.
    if (!matchesFilter(sortInfos[i]!.status, filterMode)) continue;

    // Pins always float into the Pinned group, in every mode — pinning is an
    // explicit "keep this up top" signal. Members are ordered by sortMode below,
    // so under sort=status a waiting pin still rises within the group.
    if (pinnedNames.has(sessions[i].name)) {
      pinnedIndices.push(i);
      continue;
    }

    // Checked after pinning so an explicit "keep this up top" always wins over
    // a derived "this is handed off" — the two signals can legitimately both
    // be true, and the user's explicit one should be the visible one.
    if (parkedNames.has(sessions[i].name)) {
      parkedIndices.push(i);
      continue;
    }

    if (groupMode === "none") {
      ungrouped.push(i);
      continue;
    }
    if (groupMode === "project") {
      const label = projectLabelOf(sessions[i]);
      if (!label) {
        ungrouped.push(i);
        continue;
      }
      bucket(`project:${label}`, label, 0, i);
      continue;
    }
    if (groupMode === "stage") {
      // A session has a stage only when it has a linked issue whose status one
      // of the user's stages claims. Everything else — no issue, or a status
      // mapped to no stage — falls to the flat remainder, exactly as a
      // project-less session does under group=project. Making those a "No
      // stage" group would give the sessions you have *not* classified a
      // header of their own, above ones you have. A stage hidden from the
      // sidebar arrives with a null band for the same reason — hiding a stage
      // hides its header, never its sessions.
      const stage = workflowByName.get(sessions[i].name)?.band;
      if (!stage) {
        ungrouped.push(i);
        continue;
      }
      bucket(`stage:${stage.id}`, stage.label, stage.rank, i);
      continue;
    }
    // groupMode === "status" — every session has a status, so none are ungrouped.
    const st = sortInfos[i]!.status;
    bucket(`status:${st}`, statusGroupLabel(st), statusRank(st), i);
  }

  // Ghosts on the stage axis join their own stage's band, below its sessions.
  // A stage holding only ghosts still gets a band — that is the whole point of
  // the placement, and it is why a ghost carries its stage's label and rank:
  // with no session in that stage, there is nothing else to name the header.
  //
  // Only under groupMode "stage". An issue with no session has no project, no
  // agent status and no activity, so there is no honest bucket for it on any
  // other axis; those modes get the flat band emitted further down instead.
  //
  // A filter suppresses ghosts everywhere. Both filters ("needs you", "active")
  // select on agent state, which a ghost has none of — so it can neither match
  // one nor be honestly excluded by it. Leaving them up would answer "show me
  // only the sessions wanting my attention" with a list of work nobody has
  // started.
  const flatGhosts: number[] = [];
  if (filterMode === "all") {
    for (let g = 0; g < ghosts.length; g++) {
      const ghost = ghosts[g]!;
      if (groupMode === "stage" && ghost.stageId !== undefined) {
        bucketFor(`stage:${ghost.stageId}`, ghost.stageLabel ?? ghost.stageId, ghost.rank ?? 0)
          .ghostIndices.push(g);
      } else if (groupMode !== "stage") {
        flatGhosts.push(g);
      }
    }
  }

  const info = (i: number) => sortInfos[i]!;

  // Member order within every bucket + Pinned + the flat list obeys sortMode.
  const sortedPinned = sortIndices(pinnedIndices, info, sortMode);
  const sortedParked = sortIndices(parkedIndices, info, sortMode);
  const sortedUngrouped = sortIndices(ungrouped, info, sortMode);

  // Group-header order is fixed by axis, NOT by sortMode: project → alphabetical,
  // status → status rank (needs-you group on top), stage → the order the user
  // arranged their own workflow in.
  const buckets = [...bucketMap.values()];
  buckets.sort(
    groupMode === "status" || groupMode === "stage"
      ? (a, b) => a.rank - b.rank
      : (a, b) => a.label.localeCompare(b.label),
  );
  for (const b of buckets) b.indices = sortIndices(b.indices, info, sortMode);

  const items: RenderItem[] = [];
  const displayOrder: number[] = [];
  // Ctrl-Shift-Up/Down's stops, in render order. Ghosts belong here now that
  // landing on one previews rather than provisions — see the note on the flat
  // band below for the history.
  const navOrder: NavTarget[] = [];

  /**
   * A session's row, plus its issue rows when it is expanded.
   *
   * The disclosure is offered only above one issue — with a single issue the
   * badge already names it and there is nothing an expansion could add — so a
   * session that drops to one ticket collapses back on its own rather than
   * leaving a chevron that reveals what is already on screen.
   */
  const emitSession = (idx: number, item: RenderItem): void => {
    items.push(item);
    displayOrder.push(idx);
    navOrder.push({ type: "session", sessionId: sessions[idx]!.id });
    items.push({ type: "spacer" });

    const name = sessions[idx]!.name;
    const rows = issueRowsByName.get(name) ?? [];
    if (rows.length < 2 || !expandedNames.has(name)) return;
    for (let r = 0; r < rows.length; r++) {
      items.push({ type: "session-issue", sessionIndex: idx, issueIndex: r });
    }
    items.push({ type: "spacer" });
  };

  // Command Center block first — always present (header + counts only).
  items.push({ type: "overview", paneCount: pinnedPanes.length });
  items.push({ type: "spacer" });

  const emitGroup = (
    key: string,
    label: string,
    indices: number[],
    collapsedByDefault = false,
    ghostIndices: readonly number[] = [],
    stageInHeader = false,
  ): void => {
    // Parked inverts the collapse default: the band exists to hide rows, so an
    // absent entry in `collapsedGroups` means collapsed, and toggling records
    // the expanded state instead.
    const isCollapsed = collapsedByDefault
      ? !collapsedGroups.has(key)
      : collapsedGroups.has(key);
    items.push({
      type: "group-header",
      key,
      label,
      collapsed: isCollapsed,
      // Ghosts count toward the header's tally: collapsed, the number has to
      // account for every row folded away, or a stage holding only ghosts
      // collapses to a header reading "(0)".
      sessionCount: indices.length + ghostIndices.length,
    });
    items.push({ type: "spacer" });
    if (isCollapsed) return;
    for (const idx of indices) {
      emitSession(idx, {
        type: "session",
        sessionIndex: idx,
        grouped: true,
        groupLabel: label,
        pinnedCount: pinnedPaneCountBySession.get(sessions[idx].name),
        stageInHeader,
      });
    }
    // Ghosts last within the band: work someone is on outranks work nobody is.
    for (const g of ghostIndices) {
      items.push({ type: "ghost", ghostIndex: g });
      navOrder.push({ type: "ghost", issueId: ghosts[g]!.issueId });
      items.push({ type: "spacer" });
    }
  };

  // Pinned group, always the top group when any pins exist.
  if (sortedPinned.length > 0) {
    emitGroup(PINNED_GROUP_KEY, PINNED_GROUP_LABEL, sortedPinned);
  }

  // Grouped buckets (none in group=none). On the stage axis — and only there —
  // every bucket is a stage, so its header already carries what row 2 would
  // otherwise say.
  for (const b of buckets) {
    emitGroup(b.key, b.label, b.indices, false, b.ghostIndices, groupMode === "stage");
  }

  // Flat list: group=none, or the project-less remainder in group=project.
  for (const idx of sortedUngrouped) {
    emitSession(idx, {
      type: "session",
      sessionIndex: idx,
      grouped: false,
      pinnedCount: pinnedPaneCountBySession.get(sessions[idx].name),
    });
  }

  // Up next: the fallback placement, for every grouping axis except stage.
  // Below the live sessions and above Parked — work you haven't picked up is
  // secondary to work that's running, but it isn't the back burner either.
  //
  // Emitted directly rather than through emitGroup because its header is not a
  // session bucket — but it contributes nav stops like every other band.
  //
  // Ghosts were once deliberately excluded from keyboard navigation: landing on
  // one used to provision a worktree, so a nav key was a destructive surprise.
  // Selecting a ghost now opens a preview instead, which removed the only
  // justification the exclusion ever had. `displayOrder` stays session-only —
  // it is the *session* cycle, and callers that mean "sessions" still get
  // sessions.
  if (flatGhosts.length > 0) {
    const collapsed = collapsedGroups.has(GHOST_GROUP_KEY);
    items.push({
      type: "group-header",
      key: GHOST_GROUP_KEY,
      label: GHOST_GROUP_LABEL,
      collapsed,
      sessionCount: flatGhosts.length,
    });
    items.push({ type: "spacer" });
    if (!collapsed) {
      for (const g of flatGhosts) {
        items.push({ type: "ghost", ghostIndex: g });
        navOrder.push({ type: "ghost", issueId: ghosts[g]!.issueId });
        items.push({ type: "spacer" });
      }
    }
  }

  // Parked band last, below everything — the back burner, not a headline.
  if (sortedParked.length > 0) {
    emitGroup(PARKED_GROUP_KEY, PARKED_GROUP_LABEL, sortedParked, true);
  }

  return { items, displayOrder, navOrder };
}

/**
 * Rows a render item occupies.
 *
 * A session's third row carries its context figure and agent-state label, which
 * only exist once the session is promoted (it has an agent state). Before that
 * the row is blank, which is what made a list of un-promoted sessions look
 * ragged — so a non-promoted session collapses to two rows. `hasStateRow` is
 * supplied by the caller because promotion lives on the Sidebar instance, not
 * on the plan item.
 */
function itemHeight(item: RenderItem, hasStateRow: (sessionIndex: number) => boolean): number {
  if (item.type === "session") return hasStateRow(item.sessionIndex) ? 3 : 2;
  // One row per issue, against a session's two or three. Five issues at a
  // session's own height would bury the list this sits inside.
  if (item.type === "session-issue") return 1;
  // Identifier row + title row. Fixed at 2: a ghost has no agent to promote,
  // so it never grows the third row a live session can.
  if (item.type === "ghost") return 2;
  // Command Center: header row + an agent-state breakdown row when panes exist.
  if (item.type === "overview") return item.paneCount > 0 ? 2 : 1;
  return 1; // group-header or spacer
}

// --- Sidebar class ---

// Version indicator on the sidebar's last row. The plain version reads as
// receded chrome (tertiary); an available update is an urgency cue, so it
// gets the attention (yellow) token instead.
const VERSION_ATTRS: CellAttrs = {
  fg: tokens.textTertiary.fg,
  fgMode: tokens.textTertiary.fgMode,
  dim: tokens.textTertiary.dim,
};
const UPDATE_AVAILABLE_ATTRS: CellAttrs = {
  fg: tokens.attention.fg,
  fgMode: tokens.attention.fgMode,
};

export class Sidebar {
  private width: number;
  private height: number;
  private sessions: SessionInfo[] = [];
  private activeSessionId: string | null = null;
  /** Issue id of the ghost the preview surface is showing, if any. */
  private focusedGhostId: string | null = null;
  private navOrder: NavTarget[] = [];
  private overviewActive = false;
  private items: RenderItem[] = [];
  private displayOrder: number[] = [];
  private rowToSessionIndex = new Map<number, number>();
  private rowToGroupKey = new Map<number, string>();
  private activitySet = new Set<string>();
  private scrollOffset = 0;
  private hoveredRow: number | null = null;
  private collapsedGroups = new Set<string>();
  private pinnedSessions = new Set<string>();
  private parkedSessions = new Set<string>();
  private sessionWorkflow = new Map<string, SessionWorkflow>();
  private ghosts: GhostEntry[] = [];
  private pinnedPanes: PinnedPaneEntry[] = [];
  private rowToSelection = new Map<number, SidebarSelection>();
  /** Per row, the badge's clickable columns and the session it discloses. */
  private rowToDisclosure = new Map<
    number,
    { sessionName: string; startCol: number; endCol: number }
  >();
  private currentVersion: string = "";
  private latestVersion: string | null = null;
  private otelStates = new Map<string, SessionOtelState>();
  private agentStateRecords = new Map<string, AgentStateRecord>();
  cacheTimersEnabled: boolean = true;
  private sessionContexts = new Map<string, SessionContext>();
  /**
   * Sessions whose issue list is disclosed, by name.
   *
   * Default collapsed and never persisted, exactly like `collapsedGroups`: it
   * is a view state, and a sidebar that came back from a restart already
   * expanded would be a surprise about work you had since finished.
   */
  private expandedSessions = new Set<string>();
  /**
   * Per session, the issue rows to draw when expanded — rebuilt with the plan
   * rather than read at paint time, so the row count the layout was computed
   * from and the rows actually painted cannot disagree. The contexts map is
   * mutated in place by the poll coordinator, which makes that a real risk
   * rather than a theoretical one.
   */
  private sessionIssueRows = new Map<string, SessionIssueRow[]>();
  private stateAttrs: Record<AgentState, CellAttrs> = buildStateAttrs(DEFAULT_STATE_PALETTE);

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
  }

  /** Set the per-state indicator colors. Emphasis (bold/dim per state) is fixed. */
  setStateColors(colors: Record<AgentState, StateColor>): void {
    this.stateAttrs = buildStateAttrs(colors);
  }

  updateSessions(sessions: SessionInfo[]): void {
    this.sessions = sessions;
    // Prune otelStates and agentStateRecords for sessions that no longer exist
    const activeIds = new Set(sessions.map((s) => s.id));
    for (const id of this.otelStates.keys()) {
      if (!activeIds.has(id)) this.otelStates.delete(id);
    }
    for (const id of this.agentStateRecords.keys()) {
      if (!activeIds.has(id)) this.agentStateRecords.delete(id);
    }
    // Expansion is keyed by name, so a dead session's entry would silently
    // apply to a later session that reused the name.
    const activeNames = new Set(sessions.map((s) => s.name));
    for (const name of this.expandedSessions) {
      if (!activeNames.has(name)) this.expandedSessions.delete(name);
    }
    this.rebuildPlan();
  }

  setActiveSession(id: string): void {
    if (this.activeSessionId === id) return;
    this.activeSessionId = id;
  }

  /** Mark the Command Center (Overview) as the active selection. */
  setOverviewActive(active: boolean): void {
    this.overviewActive = active;
  }

  /**
   * Mark a ghost row as the active selection, or clear it with null.
   *
   * The rail marks the row the main area is showing. A ghost can own it because
   * the preview surface shows a ghost's content — the same reason Overview owns
   * it in the Command Center.
   */
  setFocusedGhost(issueId: string | null): void {
    if (this.focusedGhostId === issueId) return;
    this.focusedGhostId = issueId;
  }

  toggleGroup(label: string): void {
    if (this.collapsedGroups.has(label)) {
      this.collapsedGroups.delete(label);
    } else {
      this.collapsedGroups.add(label);
    }
    this.rebuildPlan();
  }

  setPinnedSessions(names: Set<string>): void {
    this.pinnedSessions = new Set(names);
    this.rebuildPlan();
  }

  /** Sessions handed off and collapsed into the bottom Parked band. */
  setParkedSessions(names: Set<string>): void {
    this.parkedSessions = new Set(names);
    this.rebuildPlan();
  }

  isParked(sessionName: string): boolean {
    return this.parkedSessions.has(sessionName);
  }

  /**
   * Each session's workflow position: the band it groups under, the word row 2
   * leads with, and where the workflow says its issues should be. Resolved by
   * the caller from the linked issues + the user's stage definitions; sessions
   * absent from the map have no issue to describe, so they say nothing and stay
   * in the flat remainder.
   */
  setSessionWorkflow(workflow: Map<string, SessionWorkflow>): void {
    this.sessionWorkflow = new Map(workflow);
    this.rebuildPlan();
  }

  /**
   * Unstarted issues for the Up next band, already selected, ordered and capped
   * by the caller. Same boundary as `setSessionWorkflow`: which issues qualify
   * depends on the tracker, the stage config and the live session list, none of
   * which the sidebar knows about.
   */
  setGhostSessions(ghosts: readonly GhostEntry[]): void {
    this.ghosts = [...ghosts];
    this.rebuildPlan();
  }

  /**
   * Derived status + last-activity for one session. Exposed so parking policy
   * can reuse the sidebar's single definition of "waiting" and "last signal of
   * life" rather than growing a second, drifting copy elsewhere.
   */
  getSortInfo(sessionName: string): SessionSortInfo | null {
    const s = this.sessions.find((x) => x.name === sessionName);
    if (!s) return null;
    return { name: s.name, status: this.statusOf(s), lastActivity: this.lastActivityOf(s) };
  }

  setPinnedPanes(panes: PinnedPaneEntry[]): void {
    this.pinnedPanes = panes;
    this.rebuildPlan();
  }

  private groupMode: GroupMode = "project";
  private sortMode: SortMode = "name";
  private filterMode: FilterMode = "all";

  /** A session's status for ordering/filtering — the same distinction the row
   * dots make: a promoted agent state, else "activity" if tmux saw output,
   * else "idle". */
  private statusOf(session: SessionInfo): SessionStatus {
    const rec = this.agentStateRecords.get(session.id);
    if (rec) return rec.state;
    if (this.activitySet.has(session.id)) return "activity";
    return "idle";
  }

  /** Newest signal of life across the sources we track, for activity sort and
   * the status tie-break. */
  private lastActivityOf(session: SessionInfo): number {
    const rec = this.agentStateRecords.get(session.id);
    const otel = this.otelStates.get(session.id);
    return Math.max(
      rec?.since ?? 0,
      otel?.lastRequestTime ?? 0,
      session.activity ?? 0,
    );
  }

  private buildSortInfos(): SessionSortInfo[] {
    return this.sessions.map((s) => ({
      // Sort on what the row shows, not the tmux name underneath it — the same
      // rule `sectionedViewNotice` enforces elsewhere: a visible list ordered
      // by a hidden key reads as broken, not merely different.
      name: displaySessionName(s),
      status: this.statusOf(s),
      lastActivity: this.lastActivityOf(s),
    }));
  }

  getGroupMode(): GroupMode { return this.groupMode; }
  getSortMode(): SortMode { return this.sortMode; }
  getFilterMode(): FilterMode { return this.filterMode; }

  setGroupMode(mode: GroupMode): void {
    if (mode === this.groupMode) return; // no-op — avoids a redundant rebuild
    this.groupMode = mode;
    // Show the TOP of the re-grouped list — regrouping changes what's on top.
    this.scrollOffset = 0;
    this.rebuildPlan();
  }
  setSortMode(mode: SortMode): void {
    if (mode === this.sortMode) return; // no-op — avoids a redundant rebuild
    this.sortMode = mode;
    // Show the TOP of the re-ordered list — the whole point of sorting by
    // status is to see what rose to the top, not to chase the active session.
    this.scrollOffset = 0;
    this.rebuildPlan();
  }
  setFilterMode(mode: FilterMode): void {
    if (mode === this.filterMode) return;
    this.filterMode = mode;
    this.scrollOffset = 0;
    this.rebuildPlan();
  }

  /** Cycle group/sort/filter and return the new mode (so the caller can persist/report it). */
  cycleGroupMode(): GroupMode {
    this.setGroupMode(cycleGroup(this.groupMode));
    return this.groupMode;
  }
  cycleSortMode(): SortMode {
    this.setSortMode(cycleSort(this.sortMode));
    return this.sortMode;
  }
  cycleFilterMode(): FilterMode {
    this.setFilterMode(cycleFilter(this.filterMode));
    return this.filterMode;
  }

  private rebuildPlan(): void {
    this.sessionIssueRows.clear();
    for (const session of this.sessions) {
      const issues = this.sessionContexts.get(session.name)?.issues;
      if (issues && issues.length > 0) {
        this.sessionIssueRows.set(
          session.name,
          buildSessionIssueRows(issues, this.sessionWorkflow.get(session.name)?.driftByIssue),
        );
      }
    }
    const { items, displayOrder, navOrder } = buildRenderPlan(
      this.sessions,
      this.collapsedGroups,
      this.pinnedSessions,
      this.pinnedPanes,
      this.buildSortInfos(),
      this.groupMode,
      this.sortMode,
      this.filterMode,
      this.parkedSessions,
      this.sessionWorkflow,
      this.ghosts,
      this.sessionIssueRows,
      this.expandedSessions,
    );
    this.items = items;
    this.displayOrder = displayOrder;
    this.navOrder = navOrder;
    this.clampScroll();
  }

  isPinned(sessionName: string): boolean {
    return this.pinnedSessions.has(sessionName);
  }

  setActivity(sessionId: string, active: boolean): void {
    if (active) {
      this.activitySet.add(sessionId);
    } else {
      this.activitySet.delete(sessionId);
    }
  }

  setSessionOtelState(sessionId: string, state: SessionOtelState | null): void {
    if (state === null) {
      this.otelStates.delete(sessionId);
    } else {
      this.otelStates.set(sessionId, state);
    }
  }

  /** Test-only: number of otelStates entries currently held. */
  _otelStateCount(): number {
    return this.otelStates.size;
  }

  setAgentStateRecord(
    sessionId: string,
    record: AgentStateRecord | null,
  ): void {
    const had = this.agentStateRecords.has(sessionId);
    if (record === null) this.agentStateRecords.delete(sessionId);
    else this.agentStateRecords.set(sessionId, record);

    // Promotion (or de-promotion) changes this session's row count, which
    // shifts every item below it — so the scroll offset can fall out of range.
    // Re-clamp, and keep the active session on screen so a promotion elsewhere
    // in the list can't scroll the row you're looking at out of view.
    if (had !== this.agentStateRecords.has(sessionId)) {
      this.clampScroll();
      this.scrollToActive();
    }
  }

  setSessionContexts(contexts: Map<string, SessionContext>): void {
    this.sessionContexts = contexts;
    // A full rebuild, not just a re-clamp: an expanded session's issue count is
    // part of the layout now, so a poll that adds or removes a link changes how
    // many rows the plan has to allocate.
    this.rebuildPlan();
  }

  /**
   * The issues a session carries, in the order they are disclosed. Empty when
   * the context has not resolved yet, which reads the same as "none".
   */
  getSessionIssues(sessionName: string): readonly SessionIssueRow[] {
    return this.sessionIssueRows.get(sessionName) ?? [];
  }

  /**
   * Whether a session's issue list can be disclosed at all.
   *
   * One issue is not expandable: the badge already names it, so a chevron would
   * promise a reveal and then show the same identifier a row lower.
   */
  canExpandSession(sessionName: string): boolean {
    return this.getSessionIssues(sessionName).length > 1;
  }

  isSessionExpanded(sessionName: string): boolean {
    return this.expandedSessions.has(sessionName);
  }

  /**
   * Toggle a session's issue disclosure. Returns the new state, or null when
   * the session has nothing to disclose — so a caller can report that rather
   * than silently doing nothing.
   */
  toggleSessionIssues(sessionName: string): boolean | null {
    if (!this.canExpandSession(sessionName)) return null;
    const next = !this.expandedSessions.has(sessionName);
    if (next) this.expandedSessions.add(sessionName);
    else this.expandedSessions.delete(sessionName);
    this.rebuildPlan();
    return next;
  }

  hasActivity(sessionId: string): boolean {
    return this.activitySet.has(sessionId);
  }

  getDisplayOrderIds(): string[] {
    return this.displayOrder
      .map((idx) => this.sessions[idx]?.id)
      .filter(Boolean) as string[];
  }

  /**
   * Every row Ctrl-Shift-Up/Down can land on, in render order — sessions and
   * ghosts interleaved exactly as drawn. Rows inside a collapsed band, or
   * removed by a filter, are absent because they were never emitted.
   */
  getNavOrder(): readonly NavTarget[] {
    return this.navOrder;
  }

  setVersion(current: string, latest?: string): void {
    this.currentVersion = current;
    this.latestVersion = latest ?? null;
  }

  hasUpdate(): boolean {
    return this.latestVersion !== null && this.latestVersion !== this.currentVersion;
  }

  /** The current jmux version — data the footer reads to build its version
   * segment. Rendering moved off the sidebar's last row to the footer. */
  getVersion(): string {
    return this.currentVersion;
  }

  /** The latest known release, or null when no update check has completed
   * (or none is available). Only meaningful together with hasUpdate(). */
  getLatestVersion(): string | null {
    return this.latestVersion;
  }

  isVersionRow(row: number): boolean {
    return this.currentVersion !== "" && row === this.height - 1;
  }

  getSessionByRow(row: number): SessionInfo | null {
    const sessionIdx = this.rowToSessionIndex.get(row);
    if (sessionIdx === undefined) return null;
    return this.sessions[sessionIdx] ?? null;
  }

  /** The axis-namespaced collapse key of the group header on `row`, for toggling. */
  getGroupKeyByRow(row: number): string | null {
    return this.rowToGroupKey.get(row) ?? null;
  }

  getSelectionByRow(row: number): SidebarSelection | null {
    return this.rowToSelection.get(row) ?? null;
  }

  /**
   * The session whose issue disclosure a click at (row, col) toggles, or null.
   *
   * Checked before the row's own selection, exactly as the header's chip
   * hit-tests are: this is a region *inside* a row that already means something
   * else, so the narrower target has to be asked first.
   */
  disclosureHit(row: number, col: number): string | null {
    const hit = this.rowToDisclosure.get(row);
    if (!hit || col < hit.startCol || col > hit.endCol) return null;
    return hit.sessionName;
  }

  getGroups(): { key: string; label: string; collapsed: boolean }[] {
    const groups: { key: string; label: string; collapsed: boolean }[] = [];
    const seen = new Set<string>();
    for (const item of this.items) {
      if (item.type === "group-header" && !seen.has(item.key)) {
        seen.add(item.key);
        groups.push({ key: item.key, label: item.label, collapsed: item.collapsed });
      }
    }
    return groups;
  }

  setHoveredRow(row: number | null): void {
    if (this.hoveredRow === row) return;
    this.hoveredRow = row;
  }

  getHoveredRow(): number | null {
    return this.hoveredRow;
  }

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    this.clampScroll();
  }

  scrollBy(delta: number): void {
    this.scrollOffset += delta;
    this.clampScroll();
  }

  /**
   * Bring whatever currently owns the rail into view — the attached session, or
   * a focused ghost when the preview owns the surface.
   *
   * A focused ghost that isn't emitted at all (filtered out, inside a collapsed
   * band, or no longer a ghost) is a no-op rather than an error: the preview
   * deliberately outlives its row.
   */
  scrollToActive(): void {
    if (!this.activeSessionId && !this.focusedGhostId) return;
    const viewportHeight = this.viewportHeight();
    let vRow = 0;
    for (const item of this.items) {
      const h = this.heightOf(item);
      const isTarget =
        item.type === "session"
          ? this.sessions[item.sessionIndex]?.id === this.activeSessionId
          : item.type === "ghost"
            ? this.ghosts[item.ghostIndex]?.issueId === this.focusedGhostId
            : false;
      if (isTarget) {
        if (vRow < this.scrollOffset) {
          this.scrollOffset = vRow;
        } else if (vRow + h > this.scrollOffset + viewportHeight) {
          this.scrollOffset = vRow + h - viewportHeight;
        }
        this.clampScroll();
        return;
      }
      vRow += h;
    }
  }

  /** Column ranges (inclusive, 0-indexed) of the clickable "⊞ <Group>" and
   * "⇅ <Sort>" chips on the header row, recomputed each render; [-1,-1] when a
   * chip isn't drawn. */
  private groupToggleStart = -1;
  private groupToggleEnd = -1;
  private sortToggleStart = -1;
  private sortToggleEnd = -1;

  /**
   * Header row: two clickable chips — `⊞ <Group>` then `⇅ <Sort>` — naming the
   * current grouping and member-sort, then (when filtered) a dim `· <Filter>`
   * suffix, then the right-aligned state rollup. The "Sessions" word is dropped:
   * the sidebar is unambiguously the session list and the chips need the room.
   * Clicking a chip cycles that axis (headerGroupToggleHit / headerSortToggleHit);
   * the glyph plus the accent-muted mode name are the affordance.
   */
  private renderHeader(grid: CellGrid): void {
    const chipAttrs: CellAttrs = {
      fg: tokens.accentMuted.fg,
      fgMode: tokens.accentMuted.fgMode,
    };

    const groupChip = `⊞ ${groupModeShort(this.groupMode)}`;
    const groupCol = 1;
    this.groupToggleStart = groupCol;
    this.groupToggleEnd = groupCol + textCols(groupChip) - 1;
    writeString(grid, 0, groupCol, groupChip, chipAttrs);

    const sortChip = `⇅ ${sortModeShort(this.sortMode)}`;
    const sortCol = groupCol + textCols(groupChip) + 2; // 2-col gap between chips
    this.sortToggleStart = sortCol;
    this.sortToggleEnd = sortCol + textCols(sortChip) - 1;
    writeString(grid, 0, sortCol, sortChip, chipAttrs);

    let after = sortCol + textCols(sortChip);
    if (this.filterMode !== "all") {
      const suffix = ` · ${filterModeShort(this.filterMode)}`;
      if (after + textCols(suffix) < this.width - 1) {
        writeString(grid, 0, after, suffix, { ...DIM_ATTRS });
        after += textCols(suffix);
      }
    }
    // Rollup fills the right, yielding to the header-left it must not overprint.
    this.renderHeaderRollup(grid, after);
  }

  /** True when a click at (row, col) lands on the header group-toggle chip. */
  headerGroupToggleHit(row: number, col: number): boolean {
    return row === 0 && col >= this.groupToggleStart && col <= this.groupToggleEnd;
  }

  /** True when a click at (row, col) lands on the header sort-toggle chip. */
  headerSortToggleHit(row: number, col: number): boolean {
    return row === 0 && col >= this.sortToggleStart && col <= this.sortToggleEnd;
  }

  /**
   * Right-aligned agent-state tally on the header row: `3⏵ 2! 1✓`, one segment
   * per state that has at least one session, in the row indicators' own glyphs
   * and colours (running green, waiting yellow-bold, complete dim-neutral). Only
   * promoted sessions carry a state, so this counts exactly what the dots below
   * would show. `leftEnd` is the last column the header-left content occupies;
   * the rollup is dropped rather than overprint it.
   */
  private renderHeaderRollup(grid: CellGrid, leftEnd: number): void {
    const counts: Record<AgentState, number> = { running: 0, waiting: 0, complete: 0 };
    for (const rec of this.agentStateRecords.values()) counts[rec.state]++;

    const GLYPH: Record<AgentState, string> = { running: "⏵", waiting: "!", complete: "✓" };
    const order: AgentState[] = ["running", "waiting", "complete"];
    const seg = (s: AgentState) => ({ text: `${counts[s]}${GLYPH[s]}`, attrs: this.stateAttrs[s] });
    const full = order.filter((s) => counts[s] > 0).map(seg);
    if (full.length === 0) return;

    const width = (segs: { text: string }[]) =>
      segs.reduce((w, s) => w + textCols(s.text), 0) + Math.max(0, segs.length - 1);
    // `leftEnd` is the first free column past the header-left content; the
    // rollup needs its start column strictly beyond it (a ≥1-column gap).
    const fits = (segs: { text: string }[]) => this.width - 1 - width(segs) > leftEnd;

    // Prefer the full tally; when the sort control leaves no room, fall back to
    // just the waiting count — the one that actually demands action — before
    // giving up entirely. So a narrow sidebar still shows "2!" if not "2⏵ 2! 1✓".
    const segments = fits(full)
      ? full
      : counts.waiting > 0 && fits([seg("waiting")])
        ? [seg("waiting")]
        : null;
    if (!segments) return;

    let col = this.width - 1 - width(segments);
    for (const s of segments) {
      writeString(grid, 0, col, s.text, s.attrs);
      col += textCols(s.text) + 1;
    }
  }

  private footerRows(): number {
    return this.currentVersion ? 1 : 0;
  }

  private viewportHeight(): number {
    return this.height - HEADER_ROWS - this.footerRows();
  }

  /**
   * True when a session renders its third row (context + agent-state label).
   * Promotion is what creates that row; before it the row would be blank.
   */
  private sessionHasStateRow = (sessionIndex: number): boolean => {
    const session = this.sessions[sessionIndex];
    return session !== undefined && this.agentStateRecords.has(session.id);
  };

  private heightOf(item: RenderItem): number {
    return itemHeight(item, this.sessionHasStateRow);
  }

  private clampScroll(): void {
    const totalRows = this.items.reduce((sum, item) => sum + this.heightOf(item), 0);
    const maxOffset = Math.max(0, totalRows - this.viewportHeight());
    this.scrollOffset = Math.max(0, Math.min(maxOffset, this.scrollOffset));
  }

  getGrid(): CellGrid {
    const grid = createGrid(this.width, this.height);
    this.rowToSessionIndex.clear();
    this.rowToGroupKey.clear();
    this.rowToSelection.clear();
    this.rowToDisclosure.clear();

    // Header \u2014 a title on the left, a live agent-state rollup on the right so
    // "how many agents need me" is legible even when the list is scrolled. The
    // title names the active sort/filter when either is non-default, so the
    // list order/membership is never a mystery: "Sessions" by default,
    // "By status" when sorted, with " \u00b7 needs you" appended when filtered.
    this.renderHeader(grid);
    writeString(grid, 1, 0, "\u2500".repeat(this.width), DIM_ATTRS);

    const vpHeight = this.viewportHeight();
    const contentBottom = HEADER_ROWS + vpHeight;
    let vRow = 0;
    let totalRows = 0;

    for (const item of this.items) {
      const h = this.heightOf(item);
      const screenRow = HEADER_ROWS + vRow - this.scrollOffset;

      // Skip items entirely above viewport
      if (screenRow + h <= HEADER_ROWS) {
        vRow += h;
        totalRows += h;
        continue;
      }
      // Track total rows even after viewport
      if (screenRow >= contentBottom) {
        vRow += h;
        totalRows += h;
        continue;
      }

      if (item.type === "overview") {
        // Selected chrome (ACTIVE_BG fill + \u258e marker) when the glass is the
        // active view \u2014 same treatment as the active session row.
        const active = this.overviewActive;
        const bgPatch: CellAttrs = active ? { bg: ACTIVE_BG, bgMode: ColorMode.RGB } : {};
        this.paintRowChrome(grid, screenRow, active, false);

        // Header row: "\u2318 Command Center \u00b7 N" (bold).
        const headerAttrs: CellAttrs = { ...GROUP_HEADER_ATTRS, bold: true, ...bgPatch };
        const headerText = item.paneCount > 0
          ? `\u2318 Command Center \u00b7 ${item.paneCount}`
          : "\u2318 Command Center";
        const maxHeaderLen = this.width - 2;
        const headerDisplay = headerText.length > maxHeaderLen
          ? headerText.slice(0, maxHeaderLen - 1) + "\u2026"
          : headerText;
        writeString(grid, screenRow, 1, headerDisplay, headerAttrs);
        this.rowToSelection.set(screenRow, { type: "overview" });

        // Breakdown row: colored "n RUN  n WAIT  n DONE" for non-zero states.
        if (item.paneCount > 0) {
          const breakdownRow = screenRow + 1;
          const tally = { running: 0, waiting: 0, complete: 0 };
          for (const p of this.pinnedPanes) {
            if (p.agentState === "running") tally.running++;
            else if (p.agentState === "waiting") tally.waiting++;
            else if (p.agentState === "complete") tally.complete++;
          }
          const segs: { text: string; attrs: CellAttrs }[] = [];
          if (tally.running > 0) segs.push({ text: `${tally.running} RUN`, attrs: this.stateAttrs.running });
          if (tally.waiting > 0) segs.push({ text: `${tally.waiting} WAIT`, attrs: this.stateAttrs.waiting });
          if (tally.complete > 0) segs.push({ text: `${tally.complete} DONE`, attrs: this.stateAttrs.complete });
          if (breakdownRow < contentBottom) {
            this.paintRowChrome(grid, breakdownRow, active, false);
            let col = 3;
            for (const seg of segs) {
              if (col + seg.text.length > this.width) break;
              writeString(grid, breakdownRow, col, seg.text, { ...seg.attrs, ...bgPatch });
              col += seg.text.length + 2; // two-space gap
            }
            this.rowToSelection.set(breakdownRow, { type: "overview" });
          }
        }
      } else if (item.type === "group-header") {
        // "label ────": the label in textSecondary, then a hairline fill in
        // ruleHairline out to the sidebar's inner edge — replaces the old
        // "\u25be label" disclosure form. Collapse behaviour is unchanged
        // (rebuildPlan/toggleGroup); a collapsed group shows a small
        // right-aligned count cue overlaid on the hairline's tail instead of
        // a right-pointing chevron.
        const isHovered = this.hoveredRow === screenRow;
        const bgPatch: CellAttrs = isHovered ? { bg: HOVER_BG, bgMode: ColorMode.RGB } : {};
        if (isHovered) {
          writeString(grid, screenRow, 0, " ".repeat(this.width), bgPatch);
        }
        const labelAttrs: CellAttrs = { ...GROUP_HEADER_ATTRS, ...bgPatch };
        const hairlineAttrs: CellAttrs = { ...GROUP_HAIRLINE_ATTRS, ...bgPatch };
        const countAttrs: CellAttrs = { ...DIM_ATTRS, ...bgPatch };

        const labelStart = 1;
        const innerEdge = this.width - 1; // last usable column (matches the right margin used elsewhere, e.g. linearIdCol)
        // Reserve the label + a 1-space gap + at least 1 hairline char.
        const maxLabelLen = innerEdge - labelStart + 1 - 2;
        let label = item.label;
        if (label.length > maxLabelLen) {
          label = label.slice(0, Math.max(0, maxLabelLen - 1)) + "\u2026";
        }
        writeString(grid, screenRow, labelStart, label, labelAttrs);

        const fillStart = labelStart + label.length + 1; // one blank column gap before the fill
        if (fillStart <= innerEdge) {
          writeString(
            grid,
            screenRow,
            fillStart,
            frame.ruleLight.repeat(innerEdge - fillStart + 1),
            hairlineAttrs,
          );
        }

        if (item.collapsed) {
          const countSuffix = ` (${item.sessionCount})`;
          const countCol = innerEdge - countSuffix.length + 1;
          if (countCol > fillStart) {
            writeString(grid, screenRow, countCol, countSuffix, countAttrs);
          }
        }
        this.rowToGroupKey.set(screenRow, item.key);
      } else if (item.type === "spacer") {
        // nothing to render
      } else if (item.type === "session-issue") {
        this.renderSessionIssue(grid, screenRow, item);
      } else if (item.type === "ghost") {
        this.renderGhost(grid, screenRow, item);
      } else {
        this.renderSession(grid, screenRow, item);
      }

      vRow += h;
      totalRows += h;
    }

    // Scroll indicators
    if (this.scrollOffset > 0) {
      writeString(grid, HEADER_ROWS, this.width - 1, "\u25b2", DIM_ATTRS);
    }
    if (this.scrollOffset + vpHeight < totalRows) {
      const scrollRow = this.footerRows() ? contentBottom - 1 : this.height - 1;
      writeString(grid, scrollRow, this.width - 1, "\u25bc", DIM_ATTRS);
    }

    // Version footer
    if (this.currentVersion) {
      const footerRow = this.height - 1;
      const versionText = `v${this.currentVersion}`;
      if (this.hasUpdate()) {
        const updateText = `v${this.latestVersion} avail`;
        const maxLen = this.width - 2;
        const display = updateText.length <= maxLen ? updateText : `v${this.latestVersion}`;
        writeString(grid, footerRow, 1, display, UPDATE_AVAILABLE_ATTRS);
      } else {
        writeString(grid, footerRow, 1, versionText, VERSION_ATTRS);
      }
    }

    return grid;
  }

  private paintRowChrome(
    grid: CellGrid,
    row: number,
    isActive: boolean,
    isHovered: boolean,
  ): void {
    if (row >= this.height) return;
    if (isActive || isHovered) {
      const bg = isActive ? ACTIVE_BG : HOVER_BG;
      writeString(grid, row, 0, " ".repeat(this.width), { bg, bgMode: ColorMode.RGB });
    }
    if (isActive) {
      writeString(grid, row, 0, "▎", ACTIVE_MARKER_ATTRS);
    }
  }

  /**
   * An unstarted issue, in a live session row's geometry: marker in column 1,
   * identifier at the name column, title on the detail row. Both rows map to the
   * same selection, exactly as a session's two rows do, so a click anywhere on
   * the pair activates it.
   *
   * Painted as active when the preview surface is showing this issue. A ghost
   * has no session to be attached to, but the rail does not mark attachment —
   * it marks the row whose content fills the main area, which is exactly what a
   * ghost preview puts there. (Before the preview existed a ghost could never
   * be active, because clicking one provisioned immediately and the row became
   * a real session in the same gesture.)
   */
  private renderGhost(
    grid: CellGrid,
    idRow: number,
    item: Extract<RenderItem, { type: "ghost" }>,
  ): void {
    const ghost = this.ghosts[item.ghostIndex];
    if (!ghost) return;

    const titleRow = idRow + 1;
    const isActive = this.focusedGhostId !== null && ghost.issueId === this.focusedGhostId;
    const isHovered = !isActive && this.hoveredRow !== null &&
      (this.hoveredRow === idRow || this.hoveredRow === titleRow);
    const bgAttrs: CellAttrs = isActive
      ? { bg: ACTIVE_BG, bgMode: ColorMode.RGB }
      : isHovered
        ? { bg: HOVER_BG, bgMode: ColorMode.RGB }
        : {};

    this.rowToSelection.set(idRow, { type: "ghost", issueId: ghost.issueId });
    if (titleRow < this.height) {
      this.rowToSelection.set(titleRow, { type: "ghost", issueId: ghost.issueId });
    }

    this.paintRowChrome(grid, idRow, isActive, isHovered);
    this.paintRowChrome(grid, titleRow, isActive, isHovered);

    // A hollow ring where a live row carries its filled activity dot.
    writeString(grid, idRow, 1, "○", { ...GHOST_MARK_ATTRS, ...bgAttrs });

    const textStart = 3;
    const maxCols = this.width - textStart - 1;
    if (maxCols <= 0) return;

    writeString(grid, idRow, textStart, truncateToCols(ghost.identifier, maxCols),
      { ...GHOST_ID_ATTRS, ...bgAttrs });

    if (titleRow >= this.height) return;
    writeString(grid, titleRow, textStart, truncateToCols(ghost.title, maxCols),
      { ...GHOST_TITLE_ATTRS, ...bgAttrs });
  }

  /**
   * One issue of an expanded session: a tree stem, the identifier, the title,
   * and the status right-aligned.
   *
   * Fields drop right-to-left as the sidebar narrows, the same way row 2's
   * branch/timer/MR cluster does — status text first, then the title, leaving
   * the identifier and a state glyph, which is the least that still says
   * something. The glyph comes from `stateType` rather than the status name
   * because status names are workspace-defined and cannot be abbreviated
   * safely, while `stateType` is the tracker-agnostic axis jmux already orders
   * work on.
   *
   * A finished issue is dimmed rather than hidden. The list is what the session
   * carries, and dropping the done ones would make `+4` expand to three rows.
   */
  private renderSessionIssue(
    grid: CellGrid,
    row: number,
    item: Extract<RenderItem, { type: "session-issue" }>,
  ): void {
    const session = this.sessions[item.sessionIndex];
    if (!session) return;
    const issue = this.sessionIssueRows.get(session.name)?.[item.issueIndex];
    if (!issue) return;

    const isHovered = this.hoveredRow === row;
    const bgAttrs: CellAttrs = isHovered
      ? { bg: HOVER_BG, bgMode: ColorMode.RGB }
      : {};

    this.rowToSelection.set(row, {
      type: "sessionIssue",
      sessionId: session.id,
      issueId: issue.id,
    });
    // Also a session row for hit-testing, so the drag/hover paths that ask
    // "which session is under the cursor" get the owning session rather than
    // nothing at all.
    this.rowToSessionIndex.set(row, item.sessionIndex);
    this.paintRowChrome(grid, row, false, isHovered);

    const stemCol = 3;
    writeString(grid, row, stemCol, ISSUE_STEM, { ...ISSUE_STEM_ATTRS, ...bgAttrs });

    const textStart = stemCol + 2;
    const innerEdge = this.width - 1;
    let rightEdge = innerEdge;

    // Status, right-aligned: the full name when it fits, else a single glyph.
    // Both are dropped before the identifier is, which is the one field that
    // makes the row identifiable at all.
    //
    // A drifting issue puts its target in front of that chain. Naming both is
    // affordable here — a sub-row has no branch, timer or MR competing for the
    // width — and the raw status is the reason to expand in the first place, so
    // the target is what drops next, leaving the plain chain the row already
    // had.
    const glyph = STATE_TYPE_GLYPH[issue.stateType ?? "unknown"] ?? STATE_TYPE_GLYPH.unknown;
    const drifting = issue.driftTarget !== undefined;
    const statusAttrs: CellAttrs = {
      ...(drifting
        ? this.stateAttrs.waiting
        : issue.finished ? ISSUE_DONE_ATTRS : ISSUE_STATUS_ATTRS),
      ...bgAttrs,
    };
    const idCols = textCols(issue.identifier);
    // The identifier, one space, and the field — below that the field is what
    // gives way, since a row with no identifier names nothing.
    const roomFor = (text: string) => textStart + idCols + 1 + textCols(text) - 1 <= innerEdge;
    const candidates: string[] = [];
    if (issue.driftTarget !== undefined) {
      const arrow = `${WORKFLOW_ARROW}${issue.driftTarget}`;
      candidates.push(`${issue.status}${arrow}`, arrow);
    }
    candidates.push(issue.status, glyph);
    const statusText = candidates.find((t) => t && roomFor(t)) ?? "";
    if (statusText) {
      const col = innerEdge - textCols(statusText) + 1;
      writeString(grid, row, col, statusText, statusAttrs);
      rightEdge = col - 2; // one blank column before the status
    }

    const idAttrs: CellAttrs = {
      ...(issue.finished ? ISSUE_DONE_ATTRS : ISSUE_ID_ATTRS),
      ...bgAttrs,
    };
    const maxCols = rightEdge - textStart + 1;
    if (maxCols <= 0) return;
    writeString(grid, row, textStart, truncateToCols(issue.identifier, maxCols), idAttrs);

    // Title in whatever is left, and only when there is enough left to be worth
    // reading — a two-column stub of a title is noise, not information.
    const titleStart = textStart + idCols + 1;
    const titleCols = rightEdge - titleStart + 1;
    if (titleCols >= ISSUE_TITLE_MIN_COLS) {
      writeString(grid, row, titleStart, truncateToCols(issue.title, titleCols),
        { ...(issue.finished ? ISSUE_DONE_ATTRS : ISSUE_TITLE_ATTRS), ...bgAttrs });
    }
  }

  private renderSession(
    grid: CellGrid,
    nameRow: number,
    item: Extract<RenderItem, { type: "session" }>,
  ): void {
    const sessionIdx = item.sessionIndex;
    const session = this.sessions[sessionIdx];
    if (!session) return;

    const detailRow = nameRow + 1;
    const row3 = nameRow + 2;
    const isActive = session.id === this.activeSessionId;
    const isHovered = !isActive && this.hoveredRow !== null &&
      (this.hoveredRow === nameRow || this.hoveredRow === detailRow || this.hoveredRow === row3);

    // Build the view
    const ctx = this.sessionContexts.get(session.name);
    const timerState = this.cacheTimersEnabled ? this.otelStates.get(session.id) ?? undefined : undefined;
    const agentStateRecord = this.agentStateRecords.get(session.id) ?? null;
    const view = buildSessionView(session, ctx, timerState, this.activitySet, agentStateRecord);

    // Map rows to session for click handling
    this.rowToSessionIndex.set(nameRow, sessionIdx);
    if (detailRow < this.height) {
      this.rowToSessionIndex.set(detailRow, sessionIdx);
    }

    // Map rows to SidebarSelection for the unified selection API
    this.rowToSelection.set(nameRow, { type: "session", id: session.id });
    if (detailRow < this.height) {
      this.rowToSelection.set(detailRow, { type: "session", id: session.id });
    }

    // Paint background + active marker bar across name + detail rows
    this.paintRowChrome(grid, nameRow, isActive, isHovered);
    this.paintRowChrome(grid, detailRow, isActive, isHovered);

    // Indicator (col 1)
    switch (view.indicatorKind) {
      case "error":
        writeString(grid, nameRow, 1, "\u2A2F", ERROR_ATTRS);
        break;
      case "mcp-down":
        writeString(grid, nameRow, 1, "\u2298", MCP_DOWN_ATTRS);
        break;
      case "agent-running":
        writeString(grid, nameRow, 1, "\u23F5", this.stateAttrs.running);
        break;
      case "agent-waiting":
        writeString(grid, nameRow, 1, "!", this.stateAttrs.waiting);
        break;
      case "agent-complete":
        writeString(grid, nameRow, 1, "\u2713", this.stateAttrs.complete);
        break;
      case "activity":
        writeString(grid, nameRow, 1, "\u25CF", ACTIVITY_ATTRS);
        break;
    }

    const bgAttrs: CellAttrs = isActive
      ? { bg: ACTIVE_BG, bgMode: ColorMode.RGB }
      : isHovered
        ? { bg: HOVER_BG, bgMode: ColorMode.RGB }
        : {};

    // --- Row 1: the session's display name (left) + mode badge (right) ---
    //
    // The name is the generated title when there is one and the real tmux name
    // when there is not — `displaySessionName` is the only place that decides,
    // so no surface can disagree with another about what a session is called.
    // The mode badge takes the right-hand slot the issue badge used to hold;
    // that badge is now row 2's identity field.
    const nameStart = 3;
    const hasBadge = view.modeBadge !== null;
    const reserveRight = this.width - 1 - (hasBadge ? 2 : 0);
    const nameMaxCols = reserveRight - nameStart;
    const displayName = truncateToCols(
      displaySessionName({ name: view.sessionName, title: view.title ?? undefined }),
      Math.max(0, nameMaxCols),
    );

    const nameAttrs: CellAttrs = isActive
      ? { ...ACTIVE_NAME_ATTRS }
      : isHovered
        ? { ...HOVER_NAME_ATTRS }
        : { ...INACTIVE_NAME_ATTRS };
    writeString(grid, nameRow, nameStart, displayName, nameAttrs);

    if (hasBadge) {
      const badgeCol = this.width - 2;
      let glyph: string;
      let badgeAttrs: CellAttrs;
      if (view.modeBadge === "P") {
        glyph = "P";
        badgeAttrs = MODE_PLAN_ATTRS;
      } else if (view.modeBadge === "A") {
        glyph = "A";
        badgeAttrs = MODE_ACCEPT_EDITS_ATTRS;
      } else {
        glyph = "⊕";
        badgeAttrs = MODE_COMPACTION_ATTRS;
      }
      writeString(grid, nameRow, badgeCol, glyph, { ...badgeAttrs, ...bgAttrs });
    }

    // --- Row 2: issue badge (left) · workflow field · timer · MR · glyph ---
    //
    // The badge moved down from row 1, which the title now fills. It leads the
    // row and never drops: it is the row's identity, and a row that has dropped
    // it says nothing about which work it is. The branch used to sit here and no
    // longer appears at all — it was only ever visible *as* row 1's name, and at
    // a 26-column default keeping it would truncate it to a stub while
    // displacing the timer, which is what says an agent has been stuck.
    if (detailRow >= this.height) return;

    const detailAttrs: CellAttrs = isActive
      ? ACTIVE_DETAIL_ATTRS
      : isHovered
        ? HOVER_DETAIL_ATTRS
        : DIM_ATTRS;

    // Compute right-side content and its column positions (right to left)
    let rightEdge = this.width - 1; // rightmost column available

    // Pipeline glyph (rightmost). Unconditional — no floor check, matching
    // the row's long-standing priority: it is one or two columns at the very
    // edge and has always been drawn before anything else on this row claims
    // space.
    let glyphStr: string | null = null;
    let glyphAttrs: CellAttrs | null = null;
    if (view.pipelineState) {
      glyphStr = PIPELINE_GLYPH_MAP[view.pipelineState] ?? null;
      glyphAttrs = PIPELINE_GLYPH_COLORS[view.pipelineState] ?? null;
    }
    if (glyphStr && glyphAttrs) {
      writeString(grid, detailRow, rightEdge, glyphStr, { ...glyphAttrs, ...bgAttrs });
      rightEdge -= 2; // glyph + 1 space before it
    }

    // Issue badge (left). Computed here — before MR id, timer, the context
    // figure and the pinned count — so it claims its space first: the badge
    // never drops, so nothing to its right may encroach on what it needs.
    // Drop order is timer → stage word → stage glyph → drift marker → MR id,
    // with the badge last of all, which only holds if the badge is laid out
    // before anything it's supposed to outlast, not after.
    //
    // The badge carries a disclosure chevron when the session holds more than
    // one issue, and clicking it expands the list in place. Prepended into the
    // badge string rather than placed in its own column so the right-alignment
    // stays a single measurement — the same reason `linearId` is one
    // preformatted string and not a pair of fields.
    const detailStart = 3;
    let leftCol = detailStart;
    const expandable = this.canExpandSession(session.name);
    const badgeText = view.linearId ?? "";
    const linearIdStr = badgeText && expandable
      ? `${this.expandedSessions.has(session.name) ? "▾" : "▸"} ${badgeText}`
      : badgeText;
    if (linearIdStr) {
      const cols = Math.min(textCols(linearIdStr), rightEdge - leftCol + 1);
      if (cols > 0) {
        writeString(grid, detailRow, leftCol, truncateToCols(linearIdStr, cols),
          { ...DIM_ATTRS, ...bgAttrs });
        // The whole badge is the disclosure target, not just the chevron: a
        // one-column hit box on a 26-column sidebar is a dare, not an
        // affordance. Recorded on the row the badge is actually drawn on.
        if (expandable) {
          this.rowToDisclosure.set(detailRow, {
            sessionName: session.name,
            startCol: leftCol,
            endCol: leftCol + cols - 1,
          });
        }
        leftCol += cols;
      }
    }

    // MR ID (before glyph). Floored on `leftCol`, not the row's own margin —
    // it yields to the badge, so it drops before the badge ever would.
    if (view.mrId) {
      const mrCol = rightEdge - view.mrId.length + 1;
      if (mrCol > leftCol) {
        writeString(grid, detailRow, mrCol, view.mrId, { ...DIM_ATTRS, ...bgAttrs });
        rightEdge = mrCol - 2; // 1 space gap before MR ID
      }
    }

    // Timer (before MR ID). Same floor — and the first of this cluster to
    // drop, per the same priority order.
    if (view.timerText) {
      const timerAttrs = cacheTimerAttrs(view.timerRemaining, isActive, isHovered);
      const timerCol = rightEdge - view.timerText.length + 1;
      if (timerCol > leftCol) {
        writeString(grid, detailRow, timerCol, view.timerText, timerAttrs);
        rightEdge = timerCol - 2;
      }
    }

    // Context figure (before the timer) — only for a NON-promoted session,
    // which has no row 3 to carry it. A promoted session leaves it on row 3
    // beside its state label. Dropped first when the cluster runs out of room,
    // since it is the least urgent field here.
    if (!agentStateRecord) {
      const otelForRow2 = this.otelStates.get(session.id);
      const contextText = otelForRow2 ? buildSessionRow3(otelForRow2, this.width - 3, null).text.trim() : "";
      if (contextText) {
        const ctxCol = rightEdge - contextText.length + 1;
        if (ctxCol > leftCol) {
          writeString(grid, detailRow, ctxCol, contextText, { ...DIM_ATTRS, ...bgAttrs });
          rightEdge = ctxCol - 2;
        }
      }
    }

    // Pinned pane count (right side, before the badge/workflow cluster)
    if (item.pinnedCount && item.pinnedCount > 0) {
      const pinnedStr = `(${item.pinnedCount} pinned)`;
      const pinnedCol = rightEdge - pinnedStr.length + 1;
      if (pinnedCol > leftCol) {
        writeString(grid, detailRow, pinnedCol, pinnedStr, { ...DIM_ATTRS, ...bgAttrs });
        rightEdge = pinnedCol - 2;
      }
    }

    // Workflow field, after the badge and the right cluster have both staked
    // their columns.
    //
    // No `fieldTerse` state variable any more — it used to be set once and
    // read later; here the same idea has to be resolved locally, because the
    // separator's width depends on whether the field turns out terse, and the
    // field's own budget depends on the separator's width. `·` is both the
    // backlog/unknown glyph and the character inside the separator, so an
    // unconditional full separator ahead of a terse field renders "· ·" —
    // the exact collision the old `fieldTerse` existed to avoid, just on the
    // other side of the field now that the badge leads instead of the branch
    // trailing.
    //
    // Resolved by measuring once against the widest possible budget (as if
    // the separator were the narrow one-space form) to learn the field's
    // shape. A non-terse result there calls for the wider three-character
    // separator, which costs back the two columns the first pass assumed it
    // had — so it is re-measured against what that separator actually
    // leaves. In the two-column-wide band where a label fits the wide budget
    // but not the tight one, that re-measurement can fall all the way to
    // terse, disagreeing with the separator already chosen on its behalf —
    // the same collision this whole resolution exists to prevent, just
    // reached by a different path. Rather than trust a result that disagrees
    // with the separator it would be paired with, that case falls back to
    // the first measurement, which is self-consistent by construction: it
    // was measured against the budget its own separator choice implies.
    const wf = this.sessionWorkflow.get(session.name);
    if (wf) {
      const hasBadge = leftCol !== detailStart;
      const narrowSep = hasBadge ? " " : "";
      const wideBudget = Math.max(0, rightEdge - (leftCol + textCols(narrowSep)) + 1);
      const fieldWide = workflowFieldText(wf, wideBudget, item.stageInHeader);
      let sep = hasBadge ? (fieldWide.terse ? " " : WORKFLOW_SEP) : "";
      let field = fieldWide;
      if (sep !== narrowSep) {
        const tightBudget = Math.max(0, rightEdge - (leftCol + textCols(sep)) + 1);
        const fieldTight = workflowFieldText(wf, tightBudget, item.stageInHeader);
        if (fieldTight.terse) {
          sep = narrowSep; // fall back to the self-consistent pairing above
        } else {
          field = fieldTight;
        }
      }
      const budget = rightEdge - (leftCol + textCols(sep)) + 1;
      if (field.text && textCols(field.text) <= budget) {
        if (sep) writeString(grid, detailRow, leftCol, sep, detailAttrs);
        const fieldCol = leftCol + textCols(sep);
        // Drift keeps the attention colour in every state — that is what it is
        // for. Otherwise the field follows the row it sits on.
        writeString(grid, detailRow, fieldCol, field.text, wf.drift
          ? { ...this.stateAttrs.waiting, ...bgAttrs }
          : isActive || isHovered
            ? detailAttrs
            : { ...WORKFLOW_ATTRS, ...bgAttrs });
      }
    }

    // Row 3: context tokens (left) / agent state label (right). Only a promoted
    // session has this row at all — see itemHeight. A non-promoted session
    // stops at row 2 (its context figure moved into that row's right cluster
    // above), so rendering here would paint over the NEXT item.
    if (agentStateRecord && row3 < this.height) {
      this.paintRowChrome(grid, row3, isActive, isHovered);
      this.rowToSessionIndex.set(row3, sessionIdx);

      const otel = this.otelStates.get(session.id) ?? (agentStateRecord ? EMPTY_OTEL_STATE : undefined);
      if (otel) {
        // Pass the budget that buildSessionRow3 will treat as its full usable
        // width. We start writing at col 3, so usable budget = this.width - 3.
        const result = buildSessionRow3(otel, this.width - 3, agentStateRecord?.state ?? null);
        if (result.text.length > 0) {
          const row3Attrs: CellAttrs = isActive
            ? ACTIVE_DETAIL_ATTRS
            : isHovered
              ? HOVER_DETAIL_ATTRS
              : DIM_ATTRS;
          writeString(grid, row3, 3, result.text, row3Attrs);

          // Repaint the state label in its specific color so it stands out
          // from the dim row-3 background attrs.
          if (agentStateRecord && result.labelCol >= 0) {
            const labelDef = {
              text: STATE_LABEL_TEXT[agentStateRecord.state],
              attrs: this.stateAttrs[agentStateRecord.state],
            };
            const col = 3 + result.labelCol;
            const bgAttrs: CellAttrs = isActive
              ? { bg: ACTIVE_BG, bgMode: ColorMode.RGB }
              : isHovered
                ? { bg: HOVER_BG, bgMode: ColorMode.RGB }
                : {};
            writeString(grid, row3, col, labelDef.text, { ...labelDef.attrs, ...bgAttrs });
          }
        }
      }
    }
  }
}
