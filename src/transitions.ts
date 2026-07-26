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

import type { ResolvedRepoSettings } from "./repo-settings";

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
  settings: ResolvedRepoSettings,
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
