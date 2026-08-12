// Ghost rows: work you have not started yet, shown in the sidebar as sessions
// that don't exist.
//
// The sidebar is otherwise a truthful mirror of tmux — every row is a real
// session. A ghost is the one deliberate exception, and it earns that by being
// convertible: pressing it runs the same `startWorkOnIssue` flow as `n` in the
// issues panel, and the row it turns into is the row it was already drawn as.
//
// Two decisions shape everything here:
//
//   * **Membership comes from the Up next set, not from "every stage".** A
//     stage like "In review" is full of issues with no session that you cannot
//     start, so "unstarted" alone is the wrong filter. Which stages you *pull
//     new work from* is a question the user has already answered with `u` in
//     the workflow screen, and reusing that answer beats inventing a second
//     switch that would mean the same thing.
//   * **Ordering comes from stage rank, not from the Up next list's own
//     order.** `pipeline.upNext` records the sequence stages were added in,
//     which is a second ordering of the same stages; letting it drive the
//     sidebar would put two contradictory orders on one screen. Rank — the
//     stage's position in the workflow screen — is the order the user actually
//     arranged, so that is the one the band follows.
//
// Ordering *within* a stage is not decided here: the caller passes each queue's
// issues already in panel order (via buildViewNodes), so the top of the band is
// literally the top of the tab.

// --- The cap ---
//
// One value with three shapes: a count, "all", or off. It is stored in config,
// typed into a prompt, stepped with ◂ ▸, and rendered in a row — so every
// conversion between those shapes lives here rather than being re-derived at
// each site with its own idea of what counts as valid.

/** The stored form. `null` (or a non-positive count) is off. */
export type GhostCap = number | "all" | null;

export const GHOST_CAP_OFF = "never";
export const GHOST_CAP_ALL = "all";
/** The largest count the ◂ ▸ ladder steps to; larger values can still be typed. */
export const GHOST_CAP_MAX = 99;

/**
 * The stored value as a plain number: 0 for off, Infinity for "all". Callers
 * then compare against one number instead of branching on the sentinel.
 *
 * Takes `unknown` deliberately — this reads a hand-editable JSON file, so
 * anything unrecognised has to mean off rather than throw.
 */
export function ghostCapValue(raw: unknown): number {
  if (typeof raw === "string") {
    return raw.trim().toLowerCase() === GHOST_CAP_ALL ? Infinity : 0;
  }
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return 0;
  return Math.floor(raw);
}

/**
 * What the row displays. A count says "per stage" outright: it is applied per
 * stage on every placement, and a bare "3 issues" invited exactly the wrong
 * reading when several stages were on screen at once.
 */
export function formatGhostCap(raw: unknown): string {
  const n = ghostCapValue(raw);
  if (n === 0) return GHOST_CAP_OFF;
  if (n === Infinity) return GHOST_CAP_ALL;
  return `${n} per stage`;
}

/** What the prompt opens on — the input form, which is not the display form. */
export function editGhostCap(raw: unknown): string {
  const n = ghostCapValue(raw);
  if (n === 0) return "";
  return n === Infinity ? GHOST_CAP_ALL : String(n);
}

/** Parse what the user typed. Lenient about case, spacing and a trailing unit. */
export function parseGhostCap(input: string): GhostCap {
  const raw = input.trim().toLowerCase();
  if (raw === GHOST_CAP_ALL) return GHOST_CAP_ALL;
  const n = parseInt(raw, 10);
  return isNaN(n) || n <= 0 ? null : n;
}

/**
 * Step one place along the ladder `never → 1 → 2 → … → 99 → all`, wrapping.
 *
 * Monotonic in how much the band shows, so ◂ and ▸ always mean "less" and
 * "more" — and the two ends are adjacent, which is the point of wrapping: `all`
 * is one press left of `never` instead of ninety-nine presses right of it.
 * Typing remains the way to reach a large exact count in one go.
 *
 * A stored count above the ladder's top (typed, not stepped) enters at 99, so
 * stepping from it moves rather than silently snapping back to off.
 */
export function stepGhostCap(raw: unknown, delta: number): GhostCap {
  const RUNGS = GHOST_CAP_MAX + 2; // off, 1..MAX, all
  const n = ghostCapValue(raw);
  const index = n === 0 ? 0
    : n === Infinity ? RUNGS - 1
    : Math.min(n, GHOST_CAP_MAX);

  const next = ((index + delta) % RUNGS + RUNGS) % RUNGS;
  if (next === 0) return null;
  if (next === RUNGS - 1) return GHOST_CAP_ALL;
  return next;
}

/** One candidate issue, flattened to what a ghost row needs plus its filters. */
export interface GhostIssue {
  id: string;
  identifier: string;
  title: string;
  /**
   * A live session already exists for this issue. Note this is specifically
   * *session*, not "has a worktree": an issue whose worktree exists but whose
   * session doesn't is still unstarted from the sidebar's point of view, and
   * `startWorkOnIssue` has a dedicated path for exactly that case.
   */
  hasSession: boolean;
  /**
   * Lifecycle-dead for pull purposes — the issue's `WorkStage` is `done` or
   * `parked`. Both would otherwise fill the band permanently: nothing ever
   * gives a completed issue a session, so it would never age out.
   */
  inactive: boolean;
  /**
   * Which Project this issue would start in, as far as routing can tell.
   *
   * `orphaned` cannot occur here: a ghost has no session by definition, and
   * that outcome only exists to describe one. Carried on the row so the sidebar
   * can file it under the Project it will join *after* Start — the row's whole
   * claim is that starting it changes only the state.
   */
  project?: GhostProject;
}

export type GhostProject =
  | { kind: "resolved"; id: string; title: string }
  | { kind: "unclaimed" }
  | { kind: "ambiguous" };

/** One stage's issues, in the order its own tab shows them. */
export interface GhostQueue {
  viewId: string;
  /** The stage's display name, for the band a per-stage ghost lands in. */
  label: string;
  /** The stage's position in the workflow screen. Lower sorts first. */
  rank: number;
  issues: readonly GhostIssue[];
}

export interface GhostEntry {
  issueId: string;
  identifier: string;
  title: string;
  /**
   * The stage this issue sits in. Present only for the per-stage placement,
   * where it says which band the row belongs to — and, when a stage holds
   * ghosts but no sessions, is the only thing that can name that band.
   */
  stageId?: string;
  stageLabel?: string;
  rank?: number;
  /** See `GhostIssue.project`. Absent when routing was not consulted. */
  project?: GhostProject;
}

/** An issue is a ghost when nobody is on it and it is still live work. */
function eligible(issue: GhostIssue): boolean {
  return !issue.hasSession && !issue.inactive;
}

function entryOf(issue: GhostIssue): GhostEntry {
  return {
    issueId: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    ...(issue.project ? { project: issue.project } : {}),
  };
}

/**
 * The ghost rows to draw: stages in priority order, **capped per stage**.
 *
 * The cap is per stage on every placement, not per stage in one and per total in
 * the other. It briefly was the latter, and that made one setting mean two
 * things — "3 issues" read as three altogether when grouped by project and three
 * *each* when grouped by stage, with nothing on screen to say which. Per stage
 * is also the only defensible reading for the banded placement, where a global
 * budget would let a busy first stage starve every stage below it.
 *
 * Every row is tagged with its stage. The banded placement files rows by that
 * tag; the flat one ignores it, so tagging unconditionally costs nothing and
 * spares the caller a decision it would only get wrong.
 *
 * Deduplicates by issue id. One status has exactly one home stage, but a queue
 * whose view carries no `states` falls back to its plain filter — which can be
 * "every assigned issue" — so the same issue can legitimately surface in two
 * queues. First (highest-ranked) queue wins, which is also the queue the user
 * would say it belongs to.
 *
 * A cap of zero returns nothing: it is the master switch, and the caller checks
 * it before doing any of this work.
 */
export function selectGhosts(queues: readonly GhostQueue[], cap: number): GhostEntry[] {
  if (cap <= 0) return [];

  const ordered = [...queues].sort((a, b) => a.rank - b.rank);
  const out: GhostEntry[] = [];
  const seen = new Set<string>();

  for (const queue of ordered) {
    let taken = 0;
    for (const issue of queue.issues) {
      if (taken >= cap) break;
      if (!eligible(issue) || seen.has(issue.id)) continue;
      seen.add(issue.id);
      taken++;
      out.push({
        ...entryOf(issue),
        stageId: queue.viewId,
        stageLabel: queue.label,
        rank: queue.rank,
      });
    }
  }
  return out;
}

/**
 * Which band a ghost belongs to on the **project** grouping axis.
 *
 * Rows that cannot be routed collect under one "Unassigned" band rather than
 * disappearing. Hiding them would make a misconfigured team map silently
 * shorten the ghost list — the original reported failure wearing a new costume,
 * and invisible in exactly the way that made it hard to diagnose.
 */
export const UNASSIGNED_GHOST_BAND = "Unassigned";

export function ghostProjectBand(entry: GhostEntry): string {
  const p = entry.project;
  return p && p.kind === "resolved" ? p.title : UNASSIGNED_GHOST_BAND;
}
