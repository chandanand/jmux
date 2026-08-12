// Status transitions: moving an issue along its workflow as a byproduct of
// what you already did, rather than as a thing you remember to type.
//
// This is the only part of jmux that WRITES to a shared team tracker, so the
// bias throughout is toward doing nothing:
//
//   * Every event defaults to null ("never write"), per repo.
//   * Transitions are *edges*, never levels — a condition that was already
//     true when jmux started must not fire, or attaching to an old session
//     would replay months of history into someone's tracker.
//   * The default confirmation policy leaves an undo affordance on screen.

import type { ResolvedProjectSettings } from "./project";

export type TransitionEvent = "session-start" | "mr-open" | "mr-merged";

/** The minimum an MR needs to expose for edge detection. */
export interface MrSnapshot {
  id: string;
  status: "draft" | "open" | "merged" | "closed";
}

export interface MrTransitions {
  opened: boolean;
  merged: boolean;
}

/**
 * Compare two polls of a session's merge requests.
 *
 * `opened` fires for an MR id we have not seen before that is currently
 * draft/open. `merged` fires only for an id we *had* seen in a non-merged
 * state — an MR that is already merged the first time we look is history, not
 * news, and firing on it would rewrite tracker state for shipped work.
 */
export function detectMrTransitions(
  prev: MrSnapshot[],
  next: MrSnapshot[],
): MrTransitions {
  const before = new Map(prev.map((m) => [m.id, m.status]));
  let opened = false;
  let merged = false;

  for (const mr of next) {
    const was = before.get(mr.id);
    if (was === undefined) {
      if (mr.status === "open" || mr.status === "draft") opened = true;
      continue;
    }
    if (mr.status === "merged" && was !== "merged") merged = true;
  }

  return { opened, merged };
}

/** The state name configured for an event, or null when it is switched off. */
export function transitionTarget(
  event: TransitionEvent,
  settings: ResolvedProjectSettings,
): string | null {
  switch (event) {
    case "session-start":
      return settings.onSessionStartState ?? null;
    case "mr-open":
      return settings.onMrOpenState ?? null;
    case "mr-merged":
      return settings.onMrMergedState ?? null;
  }
}

export const TRANSITION_LABELS: Record<TransitionEvent, string> = {
  "session-start": "session started",
  "mr-open": "MR opened",
  "mr-merged": "MR merged",
};

/**
 * The statuses every issue in a set can move to.
 *
 * An intersection, never a union. Statuses are per-team workflow states, so a
 * set spanning two teams can legitimately share none — and offering one that
 * only some of them accept would present it as applying to the set and then
 * fail silently for the rest, leaving the batch half-moved with no report.
 *
 * Matched case-insensitively and on trimmed text, because these are names a
 * human configured in the tracker; reported in the *first* issue's spelling,
 * since that is what its own workflow calls it.
 *
 * `[]` in, `[]` out: an issue whose statuses could not be fetched constrains
 * the set to nothing, which is the honest answer rather than quietly dropping
 * it and offering statuses it may not accept.
 */
export function sharedStatuses(available: readonly (readonly string[])[]): string[] {
  const [first, ...rest] = available;
  if (!first) return [];
  const seen = new Set<string>();
  return first.filter((status) => {
    const key = status.trim().toLowerCase();
    if (key === "" || seen.has(key)) return false;
    seen.add(key);
    return rest.every((list) => list.some((s) => s.trim().toLowerCase() === key));
  });
}
