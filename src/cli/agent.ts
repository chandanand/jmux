import { runTmuxDirect } from "./tmux";
import { INTERNAL_SESSION_FILTER } from "../glass/internal-sessions";
import { CliError, type CliContext } from "./context";
import { US, splitFields } from "../tmux-fields";
import { outranks } from "../agent-state-rollup";
import type { ParsedCtlArgs } from "../cli";

export type CtlAgentState = "running" | "waiting" | "complete";

const VALID_AGENT_STATES: ReadonlySet<string> = new Set([
  "running",
  "waiting",
  "complete",
]);

export interface AgentRecord {
  session: string;
  sessionId: string;
  state: CtlAgentState | null;
  /** Epoch seconds, as written by the agent hooks (`date +%s`). */
  since: number | null;
  ageSeconds: number | null;
  /**
   * The pane actually running Claude, written by the agent hooks
   * (`@jmux-agent-pane`). `null` when hooks predate this option (re-run
   * `jmux --install-agent-hooks`) or no agent has fired yet. Prefer this over
   * `activePane` when targeting the agent — it's correct after splits.
   */
  agentPane: string | null;
  /** The session's currently active pane — a best-effort fallback only. */
  activePane: string | null;
  path: string | null;
  /**
   * Which agent program reported the winning state (`@jmux-agent-kind`), or
   * null when the state came from a session-scoped writer that predates the
   * per-agent integrations.
   */
  kind: string | null;
}

/**
 * One pane's raw contribution. Agent state is a *pane* option now — a session
 * can host several agents in splits — so this reads panes and rolls them up
 * rather than asking tmux for a per-session value that no longer exists.
 */
export interface AgentPaneRow {
  sessionId: string;
  session: string;
  state: CtlAgentState | null;
  since: number | null;
  agentPane: string | null;
  paneId: string | null;
  path: string | null;
  active: boolean;
  kind: string | null;
}

const AGENT_FORMAT = [
  "#{session_id}",
  "#{session_name}",
  "#{@jmux-agent-state}",
  "#{@jmux-agent-state-since}",
  "#{@jmux-agent-pane}",
  "#{pane_id}",
  "#{pane_current_path}",
  "#{pane_active}",
  "#{@jmux-agent-kind}",
].join(US);

/**
 * Parse one `list-panes -F` line. Pure — `nowSeconds` is injected so age
 * computation is deterministic in tests.
 *
 * tmux renders an unset user option as an empty string, so a pane that never
 * fired a hook yields `state: null` rather than a bogus record.
 */
export function parseAgentPaneLine(line: string): AgentPaneRow | null {
  const parts = splitFields(line);
  if (parts.length < 9) return null;

  const rawState = parts[2];
  const rawSince = parts[3];

  let since: number | null = null;
  const seconds = Number(rawSince);
  if (rawSince && Number.isFinite(seconds) && seconds > 0) {
    since = Math.floor(seconds);
  }

  return {
    sessionId: parts[0],
    session: parts[1],
    state: VALID_AGENT_STATES.has(rawState) ? (rawState as CtlAgentState) : null,
    since,
    agentPane: parts[4] || null,
    paneId: parts[5] || null,
    path: parts[6] || null,
    active: parts[7] === "1",
    kind: parts[8] || null,
  };
}

/**
 * Collapse pane rows into one record per session, most urgent pane winning.
 * Sessions with no agent at all are still reported (with `state: null`), which
 * is what `agent watch` relies on to notice a session disappearing.
 */
export function rollupAgentRecords(
  rows: AgentPaneRow[],
  nowSeconds: number,
): AgentRecord[] {
  const bySession = new Map<string, AgentRecord>();
  // Narrowed to the winning state only — storing the whole row would lose the
  // non-null guarantee and force an assertion at the comparison site.
  const winner = new Map<string, { state: CtlAgentState; since: number | null }>();

  for (const row of rows) {
    let record = bySession.get(row.sessionId);
    if (!record) {
      record = {
        session: row.session,
        sessionId: row.sessionId,
        state: null,
        since: null,
        ageSeconds: null,
        agentPane: null,
        activePane: null,
        path: null,
        kind: null,
      };
      bySession.set(row.sessionId, record);
    }

    // `@jmux-agent-pane` is a session option, so any pane reads the same value.
    if (row.agentPane) record.agentPane = row.agentPane;
    // The active pane defines the session's reported path, matching what
    // `list-sessions` used to return.
    if (row.active) {
      record.activePane = row.paneId;
      record.path = row.path;
    }

    if (row.state === null) continue;
    const candidate = { state: row.state, since: row.since };
    if (!outranks(candidate, winner.get(row.sessionId) ?? null)) continue;
    winner.set(row.sessionId, candidate);
    record.state = row.state;
    record.since = row.since;
    record.kind = row.kind;
    record.ageSeconds = row.since !== null ? Math.max(0, nowSeconds - row.since) : null;
  }

  return [...bySession.values()];
}

function listAgentRecords(
  ctx: CliContext,
  sessionFilter: string | null,
  nowSeconds: number,
): AgentRecord[] {
  // tmux takes a single -f; passing two silently drops the first, which used to
  // leak jmux's internal sessions into a name-filtered query.
  const filter = sessionFilter
    ? `#{&&:${INTERNAL_SESSION_FILTER},#{==:#{session_name},${sessionFilter}}}`
    : INTERNAL_SESSION_FILTER;
  const args = ["list-panes", "-a", "-f", filter, "-F", AGENT_FORMAT];
  const result = runTmuxDirect(args, ctx.socket);
  // No sessions → tmux exits non-zero; treat as empty.
  const lines = result.ok ? result.lines : [];
  const rows = lines
    .map(parseAgentPaneLine)
    .filter((r): r is AgentPaneRow => r !== null);
  return rollupAgentRecords(rows, nowSeconds);
}

/**
 * Resolve which sessions a query targets:
 * - `--all` always means every session.
 * - `--session <name>` means just that one.
 * - neither means every session (orchestrator-friendly default).
 */
function resolveAgentFilter(flags: ParsedCtlArgs["flags"]): string | null {
  if (flags.all) return null;
  if (typeof flags.session === "string") return flags.session;
  return null;
}

export async function handleAgent(
  ctx: CliContext,
  parsed: ParsedCtlArgs,
): Promise<unknown> {
  const { action, flags } = parsed;

  switch (action) {
    case "state": {
      const nowSeconds = Math.floor(Date.now() / 1000);
      const filter = resolveAgentFilter(flags);
      const agents = listAgentRecords(ctx, filter, nowSeconds);
      return { agents };
    }

    case "watch":
      // Routed in runCtl before the dispatch switch — it streams JSONL and
      // never returns a single envelope. Reaching here is a programming error.
      throw new CliError("agent watch is handled as a streaming command");

    default:
      throw new CliError(
        `Unknown agent action "${action}". Known actions: state, watch`,
      );
  }
}

export interface AgentWatchEvent {
  type: "agent_state_changed";
  session: string;
  state: CtlAgentState | null;
  since: number | null;
}

export interface WatchEntry {
  session: string;
  state: CtlAgentState | null;
  since: number | null;
}

/**
 * Compute the JSONL events to emit given the previous and current per-session
 * state, keyed by tmux session id. Pure — the polling loop is the only impure
 * part and is intentionally not unit-tested (per the no-tmux-in-tests rule).
 *
 * Emission rules:
 * - A newly seen session emits only if it actually has an agent state (we don't
 *   announce idle shells on the first poll — that would be noise).
 * - A known session emits whenever `state` or `since` changes (a re-run bumps
 *   `since` even if the state label repeats).
 * - A session that disappears (killed) emits a terminal `state: null` event so a
 *   watcher monitoring one session learns it is gone.
 */
export function diffAgentStates(
  prev: Map<string, WatchEntry>,
  next: Map<string, WatchEntry>,
): AgentWatchEvent[] {
  const events: AgentWatchEvent[] = [];

  for (const [id, cur] of next) {
    const before = prev.get(id);
    if (!before) {
      if (cur.state !== null) {
        events.push(toEvent(cur));
      }
    } else if (before.state !== cur.state || before.since !== cur.since) {
      events.push(toEvent(cur));
    }
  }

  for (const [id, before] of prev) {
    if (!next.has(id) && before.state !== null) {
      events.push({
        type: "agent_state_changed",
        session: before.session,
        state: null,
        since: null,
      });
    }
  }

  return events;
}

function toEvent(entry: WatchEntry): AgentWatchEvent {
  return {
    type: "agent_state_changed",
    session: entry.session,
    state: entry.state,
    since: entry.since,
  };
}

const DEFAULT_WATCH_INTERVAL_MS = 1000;
const MIN_WATCH_INTERVAL_MS = 200;

function resolveInterval(flags: ParsedCtlArgs["flags"]): number {
  if (typeof flags.interval === "string") {
    const n = parseInt(flags.interval, 10);
    if (!Number.isNaN(n)) return Math.max(MIN_WATCH_INTERVAL_MS, n);
  }
  return DEFAULT_WATCH_INTERVAL_MS;
}

/**
 * Long-running poller. Emits one JSON line per state transition until the
 * process is interrupted (SIGINT). Internal polling keeps the external contract
 * — JSONL events — independent of how we observe tmux.
 */
export async function runAgentWatch(
  ctx: CliContext,
  parsed: ParsedCtlArgs,
): Promise<void> {
  const intervalMs = resolveInterval(parsed.flags);
  const filter = resolveAgentFilter(parsed.flags);

  let prev = new Map<string, WatchEntry>();
  // eslint-disable-next-line no-constant-condition
  for (;;) {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const records = listAgentRecords(ctx, filter, nowSeconds);
    const next = new Map<string, WatchEntry>();
    for (const r of records) {
      next.set(r.sessionId, {
        session: r.session,
        state: r.state,
        since: r.since,
      });
    }
    for (const event of diffAgentStates(prev, next)) {
      process.stdout.write(JSON.stringify(event) + "\n");
    }
    prev = next;
    await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
  }
}
