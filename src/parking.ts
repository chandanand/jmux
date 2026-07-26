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

/** Phrased to read as a list mid-sentence, which is where they mostly appear. */
export const UNPARK_TRIGGER_LABELS: Record<UnparkTrigger, string> = {
  "state-regression": "the issue moves",
  "issue-comment": "someone comments",
  "mr-activity": "the MR is touched",
  "pipeline-failed": "a pipeline goes red",
  "agent-attention": "the agent wants you",
};

/**
 * Short forms for summarising a selection on one row. Naming the signals beats
 * a count — "5 signals" tells you how many things you can't see.
 */
export const UNPARK_TRIGGER_SHORT: Record<UnparkTrigger, string> = {
  "state-regression": "issue moves",
  "issue-comment": "comment",
  "mr-activity": "MR",
  "pipeline-failed": "pipeline",
  "agent-attention": "agent",
};

export interface ParkingConfig {
  unparkOn: UnparkTrigger[];
  /** Idle days after which an issueless session parks. null disables. */
  autoParkIdleDays: number | null;
}

export const DEFAULT_PARKING: ParkingConfig = {
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

  // `parked` is reached only by a tab the user flagged as parking, so there is
  // nothing further to consult. There used to be a second setting listing the
  // stages that park — "the stages that mean parked should park" — which could
  // be switched off independently, leaving parking silently doing nothing while
  // looking configured. One switch, in one place.
  if (input.stage) return input.stage === "parked";

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
 * Why parking isn't doing anything, or null when it is.
 *
 * Now a single condition — no tab is flagged to park — because there is a
 * single switch. This used to report a half-configured setup, where parking
 * needed two settings in two different settings categories and having only one
 * of them was indistinguishable from a broken feature.
 */
export function parkingSetupWarning(parkedStateCount: number): string | null {
  return parkedStateCount === 0 ? "inactive — no tab is set to park" : null;
}
