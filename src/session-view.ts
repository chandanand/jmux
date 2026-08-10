import type { SessionInfo, SessionOtelState, AgentState, AgentStateRecord } from "./types";
import type { SessionContext, MergeRequest, Issue } from "./adapters/types";
import { drivingIssue, isIssueFinished } from "./issue-session";

const CACHE_TIMER_TTL = 300; // seconds
const COMPACTION_FLASH_MS = 30_000;

export type IndicatorKind =
  | "error"
  | "mcp-down"
  | "agent-running"
  | "agent-waiting"
  | "agent-complete"
  | "activity"
  | null;

export type ModeBadge = "P" | "A" | "compaction" | null;

export interface SessionView {
  sessionId: string;
  sessionName: string;

  hasActivity: boolean;
  indicatorKind: IndicatorKind;

  // Row 1, right-aligned
  modeBadge: ModeBadge;

  /**
   * Row 1: the generated title, unprocessed, or null when the session has
   * none. Deliberately not trimmed or empty-checked here — that decision
   * belongs to `displaySessionName` alone (`session-title/display.ts`), the
   * one place that decides what a session is called. A second trim-and-
   * fallback here would be the same decision living in two places, able to
   * disagree with the first the moment either one changes.
   */
  title: string | null;

  /**
   * The branch row: the session's git branch, or null when it has none.
   *
   * Reinstated after the title took row 1, and removed in the same change that
   * put it there — the branch left the sidebar because row 1's session name
   * already *was* the branch on the wtm flow, and it comes back because row 1
   * stopped saying that. Not a new field; the old one given somewhere to be.
   */
  branch: string | null;

  /**
   * Row 2, left-aligned: the driving issue, suffixed with `+N` when the
   * session carries more. One preformatted string rather than a pair of
   * fields, so the sidebar's right-alignment math stays a single measurement.
   */
  linearId: string | null;

  // Row 2, center-right
  timerText: string | null;
  timerRemaining: number;

  // Row 2, right-aligned
  mrId: string | null;
  pipelineState: string | null;

  agentState: AgentState | null;
  agentStateSince: number | null;
}

function formatTimer(remaining: number): string {
  const minutes = Math.floor(remaining / 60);
  const seconds = remaining % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const m = Math.floor(totalSeconds / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h`;
}

/**
 * Format a MergeRequest id into the per-host short label shown in the
 * sidebar. GitHub ids are "owner/repo#N" -> "#N". GitLab ids are
 * "<encoded_project>:<iid>" -> "!<iid>". Discrimination is by id shape
 * rather than adapter type, so this stays pure and out of the adapter
 * surface.
 */
function formatMrId(mr: MergeRequest): string {
  const hashIdx = mr.id.lastIndexOf("#");
  if (hashIdx >= 0) return `#${mr.id.slice(hashIdx + 1)}`;
  const colonIdx = mr.id.lastIndexOf(":");
  return colonIdx >= 0 ? `!${mr.id.slice(colonIdx + 1)}` : `!${mr.id}`;
}

/**
 * A session's issues in the order the sidebar presents them: the driving issue
 * first, then the rest in the order the context resolved them.
 *
 * One rule, two renders. The row-1 badge names the driving issue and the
 * disclosure below lists all of them, and the badge naming one ticket while the
 * first row underneath showed another would make the `+N` read as a different
 * set from the one it expands to. Deriving both from this makes that
 * disagreement unrepresentable rather than merely unlikely.
 *
 * Not sorted beyond that: array order is resolution order, which is stable, and
 * re-sorting by status would move rows around under the cursor every time a
 * ticket advanced.
 */
export function orderedSessionIssues<T extends Pick<Issue, "stateType">>(
  issues: readonly T[],
): T[] {
  const driving = drivingIssue(issues);
  if (!driving) return [];
  return [driving, ...issues.filter((i) => i !== driving)];
}

/**
 * The row-1 issue badge: the driving issue, plus a count of the others.
 *
 * The count is of *other* issues rather than the total, so a one-issue session
 * reads exactly as it always has — the suffix appears only when there is
 * something it could otherwise be hiding.
 */
export function formatIssueBadge(
  issues: readonly Pick<Issue, "identifier" | "stateType">[],
): string | null {
  const [driving] = orderedSessionIssues(issues);
  if (!driving) return null;
  const others = issues.length - 1;
  return others > 0 ? `${driving.identifier} +${others}` : driving.identifier;
}

/** One disclosed issue row under a session. */
export interface SessionIssueRow {
  id: string;
  identifier: string;
  title: string;
  status: string;
  stateType?: Issue["stateType"];
  /** Whether the tracker considers this one dealt with, in any of its ways. */
  finished: boolean;
  /**
   * Where the workflow says this one should be, when that disagrees with where
   * it is. Present on every drifting issue of the session, not just the driving
   * one — the collapsed row can only speak for the issue its badge names, so
   * expanding is how the rest become visible.
   */
  driftTarget?: string;
}

/**
 * The rows the sidebar draws when a session's issue list is expanded.
 *
 * Built here rather than in sidebar.ts so the ordering rule stays beside the
 * badge that has to agree with it, and so the sidebar keeps taking a plain
 * view-model instead of learning what an `Issue` is.
 */
export function buildSessionIssueRows(
  issues: readonly Issue[],
  driftByIssue: ReadonlyMap<string, string> = new Map(),
): SessionIssueRow[] {
  return orderedSessionIssues(issues).map((issue) => ({
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    status: issue.status,
    stateType: issue.stateType,
    finished: isIssueFinished(issue),
    driftTarget: driftByIssue.get(issue.id),
  }));
}

export function buildSessionView(
  session: SessionInfo,
  ctx: SessionContext | undefined,
  timerState: SessionOtelState | undefined,
  activitySet: Set<string>,
  agentStateRecord?: AgentStateRecord | null,
): SessionView {
  const linearId = formatIssueBadge(ctx?.issues ?? []);

  // MR: pick latest by createdAt, fall back to last in array
  let selectedMr = null;
  if (ctx && ctx.mrs.length > 0) {
    const withCreated = ctx.mrs.filter((mr) => mr.createdAt != null);
    if (withCreated.length > 0) {
      selectedMr = withCreated.reduce((latest, mr) =>
        (mr.createdAt! > latest.createdAt!) ? mr : latest
      );
    } else {
      selectedMr = ctx.mrs[ctx.mrs.length - 1];
    }
  }

  const mrId = selectedMr ? formatMrId(selectedMr) : null;
  const pipelineState = selectedMr?.pipeline?.state ?? null;

  // Row-1 unified timer fallback chain (see spec §"Row 1 unified timer"):
  //   1) cache countdown while alive (lastRequestTime within CACHE_TIMER_TTL)
  //   2) promoted session → elapsed since agentStateSince
  //   3) non-promoted with OTEL data → elapsed since latest OTEL event
  //   4) blank
  let timerText: string | null = null;
  let timerRemaining = 0;
  const now = Date.now();
  if (timerState && timerState.lastRequestTime > 0) {
    const elapsedS = Math.floor((now - timerState.lastRequestTime) / 1000);
    timerRemaining = Math.max(0, CACHE_TIMER_TTL - elapsedS);
    if (timerRemaining > 0) {
      timerText = formatTimer(timerRemaining);
    }
  }
  if (timerText === null) {
    if (agentStateRecord) {
      timerText = formatElapsed(now - agentStateRecord.since);
    } else if (timerState) {
      const candidates = [
        timerState.lastRequestTime,
        timerState.lastUserPromptTime ?? 0,
      ].filter((t) => t > 0);
      if (candidates.length > 0) {
        timerText = formatElapsed(now - Math.max(...candidates));
      }
    }
  }

  // Col-1 indicator priority: error > mcp-down > agent-state > activity.
  let indicatorKind: IndicatorKind = null;
  if (timerState?.lastError) indicatorKind = "error";
  else if ((timerState?.failedMcpServers.size ?? 0) > 0) indicatorKind = "mcp-down";
  else if (agentStateRecord?.state === "running") indicatorKind = "agent-running";
  else if (agentStateRecord?.state === "waiting") indicatorKind = "agent-waiting";
  else if (agentStateRecord?.state === "complete") indicatorKind = "agent-complete";
  else if (activitySet.has(session.id)) indicatorKind = "activity";

  // Mode badge: P for plan, A for accept-edits. Compaction marker (⊕) shows
  // for COMPACTION_FLASH_MS after a compaction event, but only when no
  // permission-mode badge is already taking the slot.
  let modeBadge: ModeBadge = null;
  if (timerState?.permissionMode === "plan") {
    modeBadge = "P";
  } else if (timerState?.permissionMode === "accept-edits") {
    modeBadge = "A";
  } else if (
    timerState?.lastCompactionTime !== null &&
    timerState?.lastCompactionTime !== undefined &&
    Date.now() - timerState.lastCompactionTime < COMPACTION_FLASH_MS
  ) {
    modeBadge = "compaction";
  }

  return {
    sessionId: session.id,
    sessionName: session.name,
    hasActivity: activitySet.has(session.id),
    indicatorKind,
    modeBadge,
    branch: session.gitBranch ?? null,
    title: session.title ?? null,
    linearId,
    timerText,
    timerRemaining,
    mrId,
    pipelineState,
    agentState: agentStateRecord?.state ?? null,
    agentStateSince: agentStateRecord?.since ?? null,
  };
}

const ROW3_GAP = "  ";

const STATE_LABEL: Record<AgentState, string> = {
  running: "RUNNING",
  waiting: "WAITING",
  complete: "COMPLETE",
};

export interface SessionRow3Result {
  text: string;
  /** 0-based column offset into `text` where the state label begins, or -1 if no label was rendered. */
  labelCol: number;
}

function formatContext(tokens: number): string {
  if (tokens <= 0) return "";
  const k = Math.round(tokens / 1000);
  if (k >= 1000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  return `${k}k`;
}

export function buildSessionRow3(
  state: SessionOtelState,
  width: number,
  agentState: AgentState | null,
): SessionRow3Result {
  const contextText = formatContext(state.contextTokens);
  const usable = Math.max(0, width);

  // Promoted session: the state label is the right-anchored sentinel and always
  // stays. The context figure is dropped first if it doesn't fit.
  if (agentState !== null) {
    const stateText = STATE_LABEL[agentState];
    const candidates: Array<Array<{ text: string; align: "left" | "right" }>> = [];
    if (contextText) {
      candidates.push([
        { text: contextText, align: "left" },
        { text: stateText, align: "right" },
      ]);
    }
    candidates.push([{ text: stateText, align: "right" }]);

    for (const fields of candidates) {
      const totalLen = fields.reduce((s, f) => s + f.text.length, 0)
        + Math.max(0, fields.length - 1) * ROW3_GAP.length;
      if (totalLen <= usable) {
        const text = layoutRow3(fields, usable);
        const labelCol = text.length >= stateText.length
          ? text.length - stateText.length
          : 0;
        return { text, labelCol };
      }
    }
    const text = stateText.slice(0, usable);
    return { text, labelCol: 0 };
  }

  // Non-promoted session: context figure only, left-aligned. No state label.
  // slice is a no-op when the figure already fits within usable.
  if (contextText) {
    return { text: contextText.slice(0, usable), labelCol: -1 };
  }
  return { text: "", labelCol: -1 };
}

function layoutRow3(
  fields: Array<{ text: string; align: "left" | "right" }>,
  usable: number,
): string {
  if (fields.length === 0) return "";
  const lefts = fields.filter((f) => f.align === "left").map((f) => f.text);
  const rights = fields.filter((f) => f.align === "right").map((f) => f.text);
  const leftPart = lefts.join(ROW3_GAP);
  const rightPart = rights.join(ROW3_GAP);
  if (rightPart === "") return leftPart;
  if (leftPart === "") return " ".repeat(Math.max(0, usable - rightPart.length)) + rightPart;
  const padLen = Math.max(2, usable - leftPart.length - rightPart.length);
  return leftPart + " ".repeat(padLen) + rightPart;
}
