// Workflow drift: reporting the level that `transitions.ts` deliberately
// refuses to act on.
//
// Transitions fire on *edges* — a condition already true when jmux started must
// never replay history into a shared tracker. The price of that correctness is
// that every missed edge (a restart, a session adopted after its MR merged, a
// write that failed, an event with no configured target) leaves a permanent
// silent divergence between the tracker and reality. jmux holds both facts.
//
// So: jmux writes on edges and reads on levels. A drift marker is the level the
// edge missed, and reporting it adds no write jmux performs on its own
// initiative.
//
// Pure, and injected with its two lookups rather than importing them, so it
// stays testable without config, tracker or tmux.

import type { Issue, IssueStateType, MergeRequest } from "./adapters/types";
import type { TransitionEvent } from "./transitions";
import { drivingIssue, isIssueFinished } from "./issue-session";

/** One of the user's own workflow stages, as this module needs to see it. */
export interface StageRef {
  /** Panel-view id — the collapse identity, stable across renames. */
  id: string;
  label: string;
  /** Position in the user's own priority order; the only ordering there is. */
  rank: number;
  /** Whether this stage draws a band in the sidebar. */
  inSidebar: boolean;
}

export interface WorkflowInputs {
  /** The stage claiming a status, or null when none does. */
  stageOf: (status: string) => StageRef | null;
  /**
   * The state configured for an event, per issue. Per issue rather than per
   * session because transitions are configured per repo and a session's
   * hand-linked issues can come from teams that map elsewhere.
   */
  targetFor: (issue: Pick<Issue, "team">, event: TransitionEvent) => string | null;
}

export interface DriftMove {
  issue: Issue;
  target: string;
}

export interface SessionDrift {
  event: TransitionEvent;
  moves: DriftMove[];
}

/** Everything the sidebar needs to say about one session's workflow position. */
export interface SessionWorkflow {
  /**
   * The band this session groups under. Null when no stage claims its status,
   * or the stage is hidden from the sidebar — both fall to the flat remainder.
   */
  band: { id: string; label: string; rank: number } | null;
  /**
   * Row 2's head: the stage label, or the raw status when no stage claims it.
   * Equal to `band.label` whenever a stage claims the status; they differ only
   * in that fallback.
   */
  label: string;
  /** What `label` degrades to when the column runs out. */
  stateType?: IssueStateType;
  /** The driving issue's drift target, or null. What row 2 shows. */
  drift: string | null;
  /**
   * Target per drifting issue id — a superset of `drift`, for the disclosure
   * sub-rows. Redundant with `drift` by construction rather than by accident:
   * both are derived here from one `detectDrift` call, the same way the row-1
   * badge and the sub-rows both come from `orderedSessionIssues`.
   */
  driftByIssue: ReadonlyMap<string, string>;
}

/**
 * Events strongest first. Strength is "how far along the work demonstrably is",
 * so a merged MR outranks an open one, which outranks the mere existence of a
 * session.
 */
export const DRIFT_EVENTS: readonly TransitionEvent[] = ["mr-merged", "mr-open", "session-start"];
const EVENTS = DRIFT_EVENTS;

/**
 * Why drift detection isn't doing anything, or null when it is.
 *
 * With no transition target configured anywhere there is no "should be" to
 * compare against, and the feature looks configured while being inert. The
 * other half of the setup — statuses claimed by no stage, which also can't be
 * ordered — is already reported by the workflow row above this one, and saying
 * it twice would suggest two settings where there is one.
 *
 * `issuesChecked` separates "configured, and no target found" from "nothing to
 * look at". Answering the first when the truth is the second is the exact
 * failure this disclosure exists to prevent: on a fresh install it would name a
 * cause the user can act on, they would act on it, and the row would not
 * change — because the real answer was that no session had a linked issue yet.
 */
export function driftSetupWarning(
  targetsConfigured: boolean,
  issuesChecked: number,
): string | null {
  if (issuesChecked === 0) return "no linked issues to check";
  return targetsConfigured ? null : "inactive — no transition targets configured";
}

function preconditionHolds(
  event: TransitionEvent,
  mrs: readonly Pick<MergeRequest, "status">[],
): boolean {
  switch (event) {
    case "mr-merged":
      return mrs.some((m) => m.status === "merged");
    case "mr-open":
      return mrs.some((m) => m.status === "open" || m.status === "draft");
    case "session-start":
      return true;
  }
}

/**
 * The strongest event whose precondition holds *and* which has something to
 * report, with the issues that are behind its configured target.
 *
 * Falling through an event that produces no moves is deliberate: a merged MR
 * with no `onMrMerged` configured must not mask a correctly-configured
 * `onSessionStart` report sitting underneath it. Still one statement per
 * session — the strongest one that exists.
 *
 * Silent whenever the comparison cannot be made: no configured target, or
 * either status claimed by no stage. Rank is the only ordering there is, so
 * without it a drift claim would be a guess, and a guess must not displace a
 * fact.
 */
export function detectDrift(
  issues: readonly Issue[],
  mrs: readonly Pick<MergeRequest, "status">[],
  inputs: WorkflowInputs,
): SessionDrift | null {
  // The same exemption `checkMrTransitions` applies: re-moving a closed ticket
  // because a later MR merged is a write nobody asked for.
  const live = issues.filter((i) => !isIssueFinished(i));
  if (live.length === 0) return null;

  for (const event of EVENTS) {
    if (!preconditionHolds(event, mrs)) continue;
    const moves: DriftMove[] = [];
    for (const issue of live) {
      const target = inputs.targetFor(issue, event);
      if (!target) continue;
      const from = inputs.stageOf(issue.status);
      const to = inputs.stageOf(target);
      if (!from || !to) continue;
      if (from.rank < to.rank) moves.push({ issue, target });
    }
    if (moves.length > 0) return { event, moves };
  }
  return null;
}

/**
 * The sidebar's view of a session's workflow position, or null when there is no
 * issue to describe — which is also what a context that lost its issues to a
 * failed poll produces, so that case yields no field, no band and no drift
 * rather than a half-populated row.
 */
export function buildSessionWorkflow(
  issues: readonly Issue[],
  mrs: readonly Pick<MergeRequest, "status">[],
  inputs: WorkflowInputs,
): SessionWorkflow | null {
  const driving = drivingIssue(issues);
  if (!driving) return null;

  const stage = inputs.stageOf(driving.status);
  const drift = detectDrift(issues, mrs, inputs);
  const driftByIssue = new Map<string, string>();
  for (const move of drift?.moves ?? []) driftByIssue.set(move.issue.id, move.target);

  return {
    band: stage && stage.inSidebar
      ? { id: stage.id, label: stage.label, rank: stage.rank }
      : null,
    label: stage ? stage.label : driving.status,
    stateType: driving.stateType,
    drift: driftByIssue.get(driving.id) ?? null,
    driftByIssue,
  };
}
