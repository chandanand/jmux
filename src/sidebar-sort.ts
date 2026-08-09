// Sidebar group / sort / filter policy — pure, so it is unit-testable without
// the Sidebar, the grid, or tmux. Grouping and sorting are two independent
// axes: `GroupMode` decides how sessions bucket into headers, `SortMode` decides
// the order of members WITHIN a bucket (and the flat list when group=none).
// The Sidebar derives a SessionSortInfo per session from its own state maps and
// hands arrays of indices here; this module decides order and membership only.

import type { AgentState } from "./types";

export type GroupMode = "none" | "project" | "status" | "stage";
export type SortMode = "name" | "activity" | "status";
export type FilterMode = "all" | "attention" | "active";

// The stage a session bands under used to live here as `StageBucket`. It is now
// one field of `SessionWorkflow` (workflow-drift.ts), which is built in the same
// pass as the row-2 stage word and the drift marker — three answers about one
// session's workflow position, from one resolution.

// A session's status for ordering/filtering: the three promoted agent states,
// plus "activity" (tmux saw output but no promoted state) and "idle" (nothing).
// This is exactly the distinction the row dots and the header rollup make, so
// all three agree on what a session "is".
export type SessionStatus = AgentState | "activity" | "idle";

export interface SessionSortInfo {
  name: string;
  status: SessionStatus;
  /** Newest signal of life (agent-state change, OTEL request, tmux activity). */
  lastActivity: number;
}

export const GROUP_MODES: readonly GroupMode[] = ["none", "project", "status", "stage"];
export const SORT_MODES: readonly SortMode[] = ["name", "activity", "status"];
export const FILTER_MODES: readonly FilterMode[] = ["all", "attention", "active"];

// Priority order: "needs you" first, "done" and idle last. Drives both the
// status member-sort tie-break and the header order of status groups.
const STATUS_RANK: Record<SessionStatus, number> = {
  waiting: 0,
  running: 1,
  activity: 2,
  complete: 3,
  idle: 4,
};

export function statusRank(s: SessionStatus): number {
  return STATUS_RANK[s];
}

function cycle<T>(list: readonly T[], current: T): T {
  const i = list.indexOf(current);
  return list[(i + 1) % list.length]!;
}

export function cycleGroup(m: GroupMode): GroupMode {
  return cycle(GROUP_MODES, m);
}
export function cycleSort(m: SortMode): SortMode {
  return cycle(SORT_MODES, m);
}
export function cycleFilter(f: FilterMode): FilterMode {
  return cycle(FILTER_MODES, f);
}

const GROUP_LABELS: Record<GroupMode, string> = {
  none: "no grouping",
  project: "by project",
  status: "by status",
  stage: "by workflow stage",
};
const SORT_LABELS: Record<SortMode, string> = {
  name: "by name",
  activity: "by activity",
  status: "by status",
};
const FILTER_LABELS: Record<FilterMode, string> = {
  all: "all",
  attention: "needs you",
  active: "active",
};

export function groupModeLabel(m: GroupMode): string {
  return GROUP_LABELS[m];
}
export function sortModeLabel(m: SortMode): string {
  return SORT_LABELS[m];
}
export function filterModeLabel(f: FilterMode): string {
  return FILTER_LABELS[f];
}

// Short, capitalised names for the compact header chips ("Project", "Name", …).
const GROUP_SHORT: Record<GroupMode, string> = {
  none: "Flat",
  project: "Project",
  status: "Status",
  stage: "Stage",
};
const SORT_SHORT: Record<SortMode, string> = {
  name: "Name",
  activity: "Activity",
  status: "Status",
};
const FILTER_SHORT: Record<FilterMode, string> = {
  all: "All",
  attention: "Needs you",
  active: "Active",
};
export function groupModeShort(m: GroupMode): string {
  return GROUP_SHORT[m];
}
export function sortModeShort(m: SortMode): string {
  return SORT_SHORT[m];
}
export function filterModeShort(f: FilterMode): string {
  return FILTER_SHORT[f];
}

// Header label a status carries when it heads a group in group=status mode.
const STATUS_GROUP_LABELS: Record<SessionStatus, string> = {
  waiting: "Needs you",
  running: "Running",
  activity: "Active",
  complete: "Done",
  idle: "Idle",
};
export function statusGroupLabel(s: SessionStatus): string {
  return STATUS_GROUP_LABELS[s];
}

export function matchesFilter(status: SessionStatus, filter: FilterMode): boolean {
  switch (filter) {
    case "all":
      return true;
    case "attention":
      return status === "waiting";
    case "active":
      return status === "waiting" || status === "running";
  }
}

// The single-axis value persisted before group and sort split into two controls.
// Kept only to migrate an existing config forward; never written again.
export type LegacySortMode = "project" | "status" | "activity" | "name";

/** Map a legacy `sidebarSort` value onto the split (groupBy, sortBy) axes. */
export function migrateLegacySort(
  legacy: LegacySortMode,
): { groupBy: GroupMode; sortBy: SortMode } {
  switch (legacy) {
    case "project":
      return { groupBy: "project", sortBy: "name" };
    case "status":
      return { groupBy: "none", sortBy: "status" };
    case "activity":
      return { groupBy: "none", sortBy: "activity" };
    case "name":
      return { groupBy: "none", sortBy: "name" };
  }
}

/**
 * Order `indices` by member-sort mode. This orders sessions WITHIN a group and
 * the flat list when group=none; group-header order is a separate concern owned
 * by buildRenderPlan. Never mutates the input.
 */
export function sortIndices(
  indices: number[],
  info: (i: number) => SessionSortInfo,
  mode: SortMode,
): number[] {
  const byName = (a: number, b: number) => info(a).name.localeCompare(info(b).name);
  const byRecency = (a: number, b: number) => info(b).lastActivity - info(a).lastActivity;

  let cmp: (a: number, b: number) => number;
  switch (mode) {
    case "status":
      cmp = (a, b) =>
        (STATUS_RANK[info(a).status] - STATUS_RANK[info(b).status]) ||
        byRecency(a, b) ||
        byName(a, b);
      break;
    case "activity":
      cmp = (a, b) => byRecency(a, b) || byName(a, b);
      break;
    case "name":
      cmp = byName;
      break;
  }
  return [...indices].sort(cmp);
}
