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
import {
  resolveRepoSettings,
  REPO_SETTING_DEFAULTS,
  type RepoFacts,
  type RepoSettings,
  type ResolvedRepoSettings,
  type WorkStage,
} from "./repo-settings";

export type { WorkStage };

/**
 * Lifecycle order, and the tie-break when a state name has been listed under
 * more than one stage. A state belongs in exactly one list; this only keeps
 * a misconfiguration deterministic instead of dependent on key order.
 */
export const STAGE_ORDER: readonly WorkStage[] = ["idea", "active", "parked", "done"];

/** The settings field holding each stage's state names. */
const STAGE_FIELD: Record<WorkStage, keyof ResolvedRepoSettings> = {
  idea: "ideaStates",
  active: "activeStates",
  parked: "parkedStates",
  done: "doneStates",
};

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
  settings: ResolvedRepoSettings,
): WorkStage {
  const status = norm(issue.status ?? "");
  if (status) {
    for (const stage of STAGE_ORDER) {
      const names = settings[STAGE_FIELD[stage]] as string[] | undefined;
      if (names?.some((n) => norm(n) === status)) return stage;
    }
  }
  return stageFromStateType(issue.stateType);
}

/** The config slice stage resolution needs. */
export interface StageConfig {
  repoDefaults?: RepoSettings;
  repos?: Record<string, RepoSettings>;
  issueWorkflow?: { teamRepoMap?: Record<string, string> };
}

/**
 * The repo an issue routes to, via the (global, cross-repo) team→repo index.
 * Returns null when the team is unknown or unmapped — the caller then falls
 * back to global defaults rather than guessing at the current session's repo.
 */
export function resolveIssueRepoDir(
  issue: Pick<Issue, "team">,
  config: StageConfig,
  home: string,
): string | null {
  const dir = config.issueWorkflow?.teamRepoMap?.[issue.team ?? ""];
  if (!dir) return null;
  return dir.startsWith("~") ? home + dir.slice(1) : dir;
}

/**
 * Stage for an issue, resolved against **the issue's own repo**.
 *
 * This is the subtle part: the issues panel is a union across every team and
 * repo, so "the current repo" is the wrong key — it would make an issue's
 * stage depend on which session the user happened to be attached to. The
 * routing index (`teamRepoMap`) is global precisely so this lookup can work
 * for repos the user is not currently inside.
 */
export function stageForIssue(
  issue: Pick<Issue, "status" | "stateType" | "team">,
  config: StageConfig,
  factsFor: (dir: string) => RepoFacts,
  home = "",
): WorkStage {
  const dir = resolveIssueRepoDir(issue, config, home);
  const key = dir ? factsFor(dir).key : null;
  const override = key ? config.repos?.[key] : undefined;
  const settings = resolveRepoSettings(config.repoDefaults, override, REPO_SETTING_DEFAULTS);
  return projectStage(issue, settings);
}
