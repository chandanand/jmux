// Which sessions the sidebar shows, and in what order — the membership-and-
// order half of the sidebar's render plan, pulled out as a pure module so a
// second surface (the Command Center grid) can derive its own set from the
// same rules instead of drifting from what the sidebar renders via
// hand-placed pins.
//
// Collapse state, ghosts, issue rows and expansion are emission concerns and
// are deliberately NOT inputs here — they stay in sidebar.ts's
// buildRenderPlan, which is the consumer of this module.

import type { SessionInfo } from "./types";
import {
  matchesFilter,
  sortIndices,
  statusRank,
  statusGroupLabel,
  type GroupMode,
  type SortMode,
  type FilterMode,
  type SessionSortInfo,
} from "./sidebar-sort";
import type { SessionWorkflow } from "./workflow-drift";

export type BandKind = "pinned" | "group" | "ungrouped" | "parked";

export interface SessionBand {
  kind: BandKind;
  /** Axis-namespaced collapse identity: "pinned" | "parked" | "ungrouped" |
   *  "project:<label>" | "status:<status>" | "stage:<id>". */
  key: string;
  /** What a header renders. "" for the ungrouped band, which draws none. */
  label: string;
  /** Group ordering within kind="group"; meaningless for the other kinds. */
  rank: number;
  /** True only for kind="ungrouped" — the flat remainder that is emitted
   *  with no group header, as distinct from a band that draws one. */
  headerless: boolean;
  /** Session indices, sorted by sortMode. */
  indices: number[];
}

export interface OrderSessionsInput {
  sessions: SessionInfo[];
  sortInfos: SessionSortInfo[];
  groupMode: GroupMode;
  sortMode: SortMode;
  filterMode: FilterMode;
  pinnedSessions: ReadonlySet<string>;
  parkedSessions: ReadonlySet<string>;
  workflowByName: ReadonlyMap<string, SessionWorkflow>;
  /**
   * Whether a parked session appears at all. `false` for the Command Center
   * grid, which wants parked (handed-off) work off the board entirely rather
   * than banded under it — this module expresses that as plain exclusion, not
   * as a band with zero members. A session that is both pinned and parked
   * still floats into Pinned either way: pinning is checked first.
   */
  includeParked: boolean;
}

const PINNED_GROUP_KEY = "pinned";
const PINNED_GROUP_LABEL = "Pinned";
const PARKED_GROUP_KEY = "parked";
const PARKED_GROUP_LABEL = "Parked";

// The project bucket a session belongs to: its wtm project name (preferred)
// or a directory-derived label, else null (ungrouped).
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

function projectLabelOf(session: SessionInfo): string | null {
  // The Project first, then the repo. Grouping keys on the Project *id* upstream
  // (see the caller): two Projects may share a title, and merging them into one
  // band would put two teams' work under one header.
  if (session.projectName) return session.projectName;
  if (session.repoName) return session.repoName;
  const dir = session.directory;
  return dir ? getGroupLabel(dir) : null;
}

/**
 * The comparator group bands are sorted by. Exported so a ghost-only band —
 * a stage holding no session, which this module never produces since it
 * takes no ghosts — is ordered by the exact same rule a session-bearing band
 * is, and the two can never disagree about order.
 */
export function compareGroupBands(a: SessionBand, b: SessionBand, groupMode: GroupMode): number {
  // Group-header order is fixed by axis, NOT by sortMode: project →
  // alphabetical, status → status rank (needs-you group on top), stage → the
  // order the user arranged their own workflow in.
  return groupMode === "status" || groupMode === "stage"
    ? a.rank - b.rank
    : a.label.localeCompare(b.label);
}

/**
 * Which sessions to show, and in what order, on a given grouping/sorting/
 * filtering configuration — membership only. Bands come back in emission
 * order: pinned (if any), group bands (sorted), ungrouped (if any), parked
 * (if any and included).
 */
export function orderSessions(input: OrderSessionsInput): SessionBand[] {
  const {
    sessions,
    sortInfos,
    groupMode,
    sortMode,
    filterMode,
    pinnedSessions,
    parkedSessions,
    workflowByName,
    includeParked,
  } = input;

  const pinnedIndices: number[] = [];
  const parkedIndices: number[] = [];
  const bucketMap = new Map<string, SessionBand>();
  const ungrouped: number[] = [];

  const bucketFor = (key: string, label: string, rank: number): SessionBand => {
    let existing = bucketMap.get(key);
    if (!existing) {
      existing = { kind: "group", key, label, rank, headerless: false, indices: [] };
      bucketMap.set(key, existing);
    }
    return existing;
  };

  for (let i = 0; i < sessions.length; i++) {
    // Filter first — a filtered-out session never buckets, so empty groups
    // and the Pinned band simply don't appear.
    if (!matchesFilter(sortInfos[i]!.status, filterMode)) continue;

    // Pins always float into the Pinned band, in every mode — pinning is an
    // explicit "keep this up top" signal. Members are ordered by sortMode
    // below, so under sort=status a waiting pin still rises within the band.
    if (pinnedSessions.has(sessions[i]!.name)) {
      pinnedIndices.push(i);
      continue;
    }

    // Checked after pinning so an explicit "keep this up top" always wins
    // over a derived "this is handed off" — the two signals can legitimately
    // both be true, and the user's explicit one should be the visible one.
    // `includeParked: false` drops a parked session outright rather than
    // reassigning it to a group or the ungrouped remainder — the Command
    // Center wants handed-off work off the board, not relabelled.
    if (parkedSessions.has(sessions[i]!.name)) {
      if (includeParked) parkedIndices.push(i);
      continue;
    }

    if (groupMode === "none") {
      ungrouped.push(i);
      continue;
    }
    if (groupMode === "project") {
      const label = projectLabelOf(sessions[i]!);
      if (!label) {
        ungrouped.push(i);
        continue;
      }
      // Keyed on the Project *id* where the session carries one: two Projects
      // may share a title, and keying on the label would merge two teams' work
      // under one header. Sessions with no Project fall back to the label,
      // which is the repo — the same bucket they had before Projects existed.
      // Sessions with no Project keep the label key they have always had, so a
      // persisted collapse state survives this change untouched.
      const key = sessions[i]!.projectId
        ? `project:id:${sessions[i]!.projectId}`
        : `project:${label}`;
      bucketFor(key, label, 0).indices.push(i);
      continue;
    }
    if (groupMode === "stage") {
      // A session has a stage only when it has a linked issue whose status
      // one of the user's stages claims. Everything else — no issue, or a
      // status mapped to no stage — falls to the flat remainder, exactly as
      // a project-less session does under group=project.
      const stage = workflowByName.get(sessions[i]!.name)?.band;
      if (!stage) {
        ungrouped.push(i);
        continue;
      }
      bucketFor(`stage:${stage.id}`, stage.label, stage.rank).indices.push(i);
      continue;
    }
    // groupMode === "status" — every session has a status, so none are ungrouped.
    const st = sortInfos[i]!.status;
    bucketFor(`status:${st}`, statusGroupLabel(st), statusRank(st)).indices.push(i);
  }

  const info = (i: number) => sortInfos[i]!;

  const bands: SessionBand[] = [];

  if (pinnedIndices.length > 0) {
    bands.push({
      kind: "pinned",
      key: PINNED_GROUP_KEY,
      label: PINNED_GROUP_LABEL,
      rank: 0,
      headerless: false,
      indices: sortIndices(pinnedIndices, info, sortMode),
    });
  }

  const groupBands = [...bucketMap.values()];
  groupBands.sort((a, b) => compareGroupBands(a, b, groupMode));
  for (const b of groupBands) b.indices = sortIndices(b.indices, info, sortMode);
  bands.push(...groupBands);

  if (ungrouped.length > 0) {
    bands.push({
      kind: "ungrouped",
      key: "ungrouped",
      label: "",
      rank: 0,
      headerless: true,
      indices: sortIndices(ungrouped, info, sortMode),
    });
  }

  if (includeParked && parkedIndices.length > 0) {
    bands.push({
      kind: "parked",
      key: PARKED_GROUP_KEY,
      label: PARKED_GROUP_LABEL,
      rank: 0,
      headerless: false,
      indices: sortIndices(parkedIndices, info, sortMode),
    });
  }

  return bands;
}
