// Work-stage projection: the generic layer between a tracker's own workflow
// states and the four lifecycle stages jmux actually behaves differently for.
//
// The split that makes this work:
//
//   * **Stages drive behaviour.** Parking, sidebar banding, queue defaults and
//     reaping all key off a `WorkStage`, so none of them contain the word "QA"
//     or know that Linear exists.
//   * **Raw state names drive display.** A parked row still reads "In QA",
//     because that is the word the user recognises.
//
// Projection is per-repo (repos differ in workflow vocabulary); what jmux does
// with a stage is global (one sidebar, one set of habits).

import type { Issue, IssueStateType } from "./adapters/types";
import type { WorkStage } from "./repo-settings";

export type { WorkStage };

/**
 * Lifecycle order, and the tie-break when a state name has been listed under
 * more than one stage. A state belongs in exactly one list; this only keeps
 * a misconfiguration deterministic instead of dependent on key order.
 */
export const STAGE_ORDER: readonly WorkStage[] = ["idea", "active", "parked", "done"];

export const STAGE_LABELS: Record<WorkStage, string> = {
  idea: "Idea",
  active: "Active",
  parked: "Parked",
  done: "Done",
};

/**
 * Default projection from the tracker's own stable category. Deliberately
 * never yields "parked": with no configuration jmux must not start hiding
 * sessions, so parking is opt-in and an empty config is inert.
 */
export function stageFromStateType(t: IssueStateType | undefined): WorkStage {
  switch (t) {
    case "triage":
    case "backlog":
      return "idea";
    case "completed":
    case "canceled":
    case "duplicate":
      return "done";
    case "unstarted":
    case "started":
      return "active";
    default:
      return "active";
  }
}

function norm(s: string): string {
  return s.trim().toLowerCase();
}

/**
 * Project one issue onto a stage using already-resolved settings. An explicit
 * state-name listing wins; anything unlisted falls back to `stateType`, so a
 * user only has to name the states where their workflow diverges.
 */
export function projectStage(
  issue: Pick<Issue, "status" | "stateType">,
  stages: Record<WorkStage, string[]>,
): WorkStage {
  const status = norm(issue.status ?? "");
  if (status) {
    for (const stage of STAGE_ORDER) {
      if (stages[stage]?.some((n) => norm(n) === status)) return stage;
    }
  }
  return stageFromStateType(issue.stateType);
}

/** The config slice stage resolution needs. */
export interface StageConfig {
}


/**
 * Stage for an issue. Stage lists are derived from the queue tabs (see
 * `parkedStages`), which are global — so unlike the earlier per-repo model
 * this needs no repo key, and an issue's stage can no longer depend on which
 * session the user happens to be attached to.
 */
export function stageForIssue(
  issue: Pick<Issue, "status" | "stateType" | "team">,
  stages: Record<WorkStage, string[]>,
): WorkStage {
  return projectStage(issue, stages);
}
