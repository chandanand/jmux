// Parking: the back burner for work you've handed off but haven't finished with.
//
// The design constraint that shapes everything here: a back burner you have to
// maintain by hand rots, because you forget to file things into it. So parking
// is *derived* from the state you are already maintaining in your tracker — a
// merged MR moves the issue to QA, and the session leaves your working set
// without you doing anything.
//
// The other half is what makes that safe. You will only trust parking if you
// are certain it un-parks itself, so any configured signal — a state
// regression (QA Failed), a new comment, a failed pipeline, the agent wanting
// you — beats every parking rule, including an explicit manual park.

import type { WorkStage } from "./repo-settings";

/** Signals that can pull a session back out of the parked band. */
export type UnparkTrigger =
  | "state-regression"
  | "issue-comment"
  | "mr-activity"
  | "pipeline-failed"
  | "agent-attention";

export const UNPARK_TRIGGERS: readonly UnparkTrigger[] = [
  "state-regression",
  "issue-comment",
  "mr-activity",
  "pipeline-failed",
  "agent-attention",
];

export const UNPARK_TRIGGER_LABELS: Record<UnparkTrigger, string> = {
  "state-regression": "Issue moved backwards",
  "issue-comment": "New issue comment",
  "mr-activity": "MR activity",
  "pipeline-failed": "Pipeline failed",
  "agent-attention": "Agent needs attention",
};

export interface ParkingConfig {
  /** Stages whose sessions park. Empty by default, so parking is opt-in. */
  parkStages: WorkStage[];
  unparkOn: UnparkTrigger[];
  /** Idle days after which an issueless session parks. null disables. */
  autoParkIdleDays: number | null;
}

export const DEFAULT_PARKING: ParkingConfig = {
  // A tab only declares stage=parked deliberately, so honouring it by default
  // is the user's stated intent rather than a surprise.
  parkStages: ["parked"],
  unparkOn: ["state-regression", "issue-comment", "mr-activity", "pipeline-failed"],
  autoParkIdleDays: null,
};

/** An explicit user decision, remembered against the stage it was made at. */
export interface ParkOverride {
  manual: "park" | "unpark";
  atStage: WorkStage | null;
}

export interface SessionParkInput {
  name: string;
  /** Stage of the session's linked issue; null when it has no issue. */
  stage: WorkStage | null;
  manual: "park" | "unpark" | null;
  attention: boolean;
  signals: Set<UnparkTrigger>;
  lastActivity: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Whether a session belongs in the parked band right now.
 *
 * Precedence, strongest first:
 *   1. a configured unpark signal  — parking must always be reversible
 *   2. a manual unpark             — "I know what Linear says, keep it visible"
 *   3. a manual park               — "get this out of my way"
 *   4. the issue's stage           — the derived, zero-maintenance default
 *   5. idleness, for issueless sessions only
 */
export function isParked(
  input: SessionParkInput,
  config: ParkingConfig,
  now: number,
): boolean {
  for (const trigger of config.unparkOn) {
    if (trigger === "agent-attention" ? input.attention : input.signals.has(trigger)) {
      return false;
    }
  }

  if (input.manual === "unpark") return false;
  if (input.manual === "park") return true;

  if (input.stage) return config.parkStages.includes(input.stage);

  // Issueless sessions have no stage to derive from, so idleness is the only
  // signal available. Sessions that DO have an issue are governed by their
  // stage alone — an idle session on an active issue is still active work.
  if (config.autoParkIdleDays !== null) {
    return now - input.lastActivity > config.autoParkIdleDays * DAY_MS;
  }
  return false;
}

/**
 * Drop a manual override once the situation it answered has moved on.
 * Without this, one manual unpark would suppress parking for that session for
 * the rest of its life, silently defeating the derived rules.
 */
export function clearStaleOverride(
  override: ParkOverride | null,
  currentStage: WorkStage | null,
): ParkOverride | null {
  if (!override) return null;
  return override.atStage === currentStage ? override : null;
}

/** The slice of a session's tracker context that signals are derived from. */
export interface ParkContext {
  stage: WorkStage | null;
  issues: Array<{ comments?: Array<unknown> }>;
  mrs: Array<{ updatedAt?: number; pipeline?: { state?: string } | null }>;
}

/**
 * A snapshot taken when a session parks. Signals are "changed since this",
 * which is why parking has to record a baseline rather than test absolute
 * conditions — an MR that was already red when you parked is not news.
 */
export interface ParkBaseline {
  stage: WorkStage | null;
  issueComments: number;
  mrUpdatedAt: number;
  pipelineFailed: boolean;
}

function countComments(ctx: ParkContext): number {
  return ctx.issues.reduce((n, i) => n + (i.comments?.length ?? 0), 0);
}

function newestMrUpdate(ctx: ParkContext): number {
  return ctx.mrs.reduce((m, mr) => Math.max(m, mr.updatedAt ?? 0), 0);
}

function anyPipelineFailed(ctx: ParkContext): boolean {
  return ctx.mrs.some((mr) => mr.pipeline?.state === "failed");
}

export function captureBaseline(ctx: ParkContext): ParkBaseline {
  return {
    stage: ctx.stage,
    issueComments: countComments(ctx),
    mrUpdatedAt: newestMrUpdate(ctx),
    pipelineFailed: anyPipelineFailed(ctx),
  };
}

/**
 * Which signals have fired since the baseline. Each is an edge, not a level,
 * so a condition that was already true at park time stays quiet.
 */
export function detectSignals(baseline: ParkBaseline, ctx: ParkContext): Set<UnparkTrigger> {
  const fired = new Set<UnparkTrigger>();
  if (ctx.stage !== baseline.stage) fired.add("state-regression");
  if (countComments(ctx) > baseline.issueComments) fired.add("issue-comment");
  if (newestMrUpdate(ctx) > baseline.mrUpdatedAt) fired.add("mr-activity");
  if (anyPipelineFailed(ctx) && !baseline.pipelineFailed) fired.add("pipeline-failed");
  return fired;
}

/**
 * Why parking isn't doing anything, or null when it is wired up.
 *
 * Parking needs two settings that live in two different sections — which
 * stages park (global) and which tracker states mean "parked" (per-repo) — and
 * a half-configured setup is indistinguishable from a broken feature. The
 * Pipeline section reports this so the gap is visible at the point of setup.
 *
 * Only the `parked` stage needs explicit state names: every other stage is
 * populated by the tracker's own stateType fallback, so selecting one of those
 * is always a valid configuration.
 */
export function parkingSetupWarning(
  parkStages: WorkStage[],
  namedStatesByStage: Record<WorkStage, number>,
): string | null {
  if (parkStages.length === 0) return "inactive — no stages selected";
  if (parkStages.includes("parked") && (namedStatesByStage.parked ?? 0) === 0) {
    return "inactive — no states mapped to Parked";
  }
  return null;
}
