import { outranks } from "./agent-state-rollup";
import type { AgentState, AgentStateRecord } from "./types";

/**
 * Structural shape for a stored snapshot agent state. The canonical
 * `SnapshotAgentState` type in `src/snapshot/schema.ts` has this exact
 * shape — structural typing keeps these compatible without a
 * cross-module import.
 *
 * Note: this is intentionally distinct from `AgentStateRecord` in
 * `types.ts`. Snapshots serialise timestamps as ISO strings; the runtime
 * record uses epoch milliseconds.
 */
interface StoredAgentState {
  readonly state: AgentState;
  /** ISO timestamp string. */
  readonly since: string;
}

/**
 * If the snapshot is older than `thresholdMs` and the stored state is
 * `running` or `waiting`, coerce it to `complete` — an agent that was
 * running 10+ minutes ago without any subsequent hook fire is almost
 * certainly dead. Used by the snapshot restore path.
 *
 * A malformed `capturedAt` is treated as stale (safest: we don't want
 * to leave a bogus "RUNNING 4h" on the screen after a long suspend).
 */
export function coerceStaleAgentState(
  stored: StoredAgentState | null,
  capturedAt: string,
  nowMs: number,
  thresholdMs: number,
): StoredAgentState | null {
  if (stored === null) return null;
  if (stored.state === "complete") return stored;

  const capturedMs = Date.parse(capturedAt);
  const age = Number.isFinite(capturedMs)
    ? nowMs - capturedMs
    : Number.POSITIVE_INFINITY;

  if (age <= thresholdMs) return stored;
  return { state: "complete", since: stored.since };
}

// Keep VALID_STATES in sync with the AgentState union: adding/removing a
// member there must change the keys here, otherwise this object becomes a
// type error.
const VALID_STATES_KEYS: Record<AgentState, true> = {
  running: true,
  waiting: true,
  complete: true,
};
const VALID_STATES: ReadonlySet<string> = new Set(Object.keys(VALID_STATES_KEYS));

function isAgentState(v: string): v is AgentState {
  return VALID_STATES.has(v);
}

type ChangeListener = (sessionId: string) => void;

/**
 * Reflects the per-pane @jmux-agent-state / @jmux-agent-state-since tmux user
 * options into a typed in-process map, and rolls those panes up to the
 * per-session view the sidebar renders. Treats tmux as the source of truth —
 * apply() consumes raw string updates and parses/validates them.
 *
 * State is tracked per *pane* rather than per session because a single session
 * can host several agents in split panes, and a session-scoped option would let
 * the last writer clobber its siblings.
 *
 * Note that a pane-context read of `@jmux-agent-state` inherits from the
 * session when the pane has no value of its own. That is deliberate and load
 * bearing: an agent integration that still writes at session scope (or a
 * restored snapshot, which writes session options) is reported by every pane in
 * that session, and the rollup collapses it back to exactly the session-level
 * answer. Migration therefore needs no flag day.
 */
export class AgentStateTracker {
  private records = new Map<string, AgentStateRecord>();
  private paneSession = new Map<string, string>();
  private sessionPanes = new Map<string, Set<string>>();
  private listeners: ChangeListener[] = [];

  constructor(private readonly nowMs: () => number = () => Date.now()) {}

  /** Number of panes with a tracked record. */
  get size(): number {
    return this.records.size;
  }

  /** Rolled-up state for a session, or null if none of its panes report one. */
  getState(sessionId: string): AgentState | null {
    return this.getRecord(sessionId)?.state ?? null;
  }

  /**
   * Rolled-up record for a session: the most urgent state across its panes,
   * timed from the *earliest* pane holding that state. Earliest wins so the
   * row-1 elapsed timer reports the longest-running or longest-blocked agent
   * rather than resetting whenever a sibling pane joins the same state.
   */
  getRecord(sessionId: string): AgentStateRecord | null {
    const panes = this.sessionPanes.get(sessionId);
    if (!panes) return null;

    let best: AgentStateRecord | null = null;
    for (const paneId of panes) {
      const record = this.records.get(paneId);
      if (!record) continue;
      if (outranks(record, best)) best = record;
    }
    return best;
  }

  getPaneState(paneId: string): AgentState | null {
    return this.records.get(paneId)?.state ?? null;
  }

  getPaneRecord(paneId: string): AgentStateRecord | null {
    return this.records.get(paneId) ?? null;
  }

  /**
   * Panes of a session currently reporting `state`. Callers that need to *write*
   * a correction back into tmux need this: now that state is pane-scoped, a
   * session-scoped write would be shadowed by any pane holding its own value.
   */
  findPanesInState(sessionId: string, state: AgentState): string[] {
    const panes = this.sessionPanes.get(sessionId);
    if (!panes) return [];
    return [...panes].filter((paneId) => this.records.get(paneId)?.state === state);
  }

  onChange(fn: ChangeListener): void {
    this.listeners.push(fn);
  }

  /**
   * Apply an update for one pane. rawState comes from @jmux-agent-state;
   * rawSince comes from @jmux-agent-state-since (epoch seconds as a string, the
   * way `date +%s` produces it).
   *
   * - null or empty rawState clears the pane's record.
   * - unknown rawState is ignored (no state change, no emission).
   * - missing/unparseable rawSince falls back to nowMs().
   * - emits only when the owning session's *rolled-up* record changes, so a
   *   non-winning pane flipping state does not churn the sidebar.
   */
  apply(
    paneId: string,
    sessionId: string,
    rawState: string | null,
    rawSince: string | null,
  ): void {
    this.link(paneId, sessionId);
    const before = this.getRecord(sessionId);

    if (rawState === null || rawState === "") {
      if (!this.records.delete(paneId)) return;
      this.emitIfRolledUpChanged(sessionId, before);
      return;
    }

    if (!isAgentState(rawState)) return;

    const sinceMs = this.parseSinceMs(rawSince);
    const previous = this.records.get(paneId);
    if (previous && previous.state === rawState && previous.since === sinceMs) {
      return;
    }
    this.records.set(paneId, { state: rawState, since: sinceMs });
    this.emitIfRolledUpChanged(sessionId, before);
  }

  /** Drop records and mappings for panes that no longer exist. */
  pruneExcept(activePaneIds: string[]): void {
    const active = new Set(activePaneIds);
    // Union of both maps so neither can strand an entry, then snapshot before
    // deleting — iterating while mutating a Map is legal but unidiomatic and
    // trips readers. Pruning is a cleanup pass, not a semantic state change, so
    // we intentionally do not emit.
    const known = new Set([...this.paneSession.keys(), ...this.records.keys()]);
    for (const paneId of known) {
      if (active.has(paneId)) continue;
      this.records.delete(paneId);
      this.unlink(paneId);
    }
  }

  private link(paneId: string, sessionId: string): void {
    const existing = this.paneSession.get(paneId);
    if (existing === sessionId) return;
    // A pane can move between sessions (break-pane, move-pane), so re-linking
    // must detach it from the old session's set or that session keeps reporting
    // a pane it no longer owns.
    if (existing !== undefined) this.unlink(paneId);
    this.paneSession.set(paneId, sessionId);
    let panes = this.sessionPanes.get(sessionId);
    if (!panes) {
      panes = new Set();
      this.sessionPanes.set(sessionId, panes);
    }
    panes.add(paneId);
  }

  private unlink(paneId: string): void {
    const sessionId = this.paneSession.get(paneId);
    if (sessionId === undefined) return;
    this.paneSession.delete(paneId);
    const panes = this.sessionPanes.get(sessionId);
    if (!panes) return;
    panes.delete(paneId);
    if (panes.size === 0) this.sessionPanes.delete(sessionId);
  }

  private emitIfRolledUpChanged(
    sessionId: string,
    before: AgentStateRecord | null,
  ): void {
    const after = this.getRecord(sessionId);
    if (before?.state === after?.state && before?.since === after?.since) return;
    this.emit(sessionId);
  }

  private parseSinceMs(rawSince: string | null): number {
    if (rawSince === null || rawSince === "") return this.nowMs();
    const seconds = Number(rawSince);
    if (!Number.isFinite(seconds) || seconds <= 0) return this.nowMs();
    return Math.floor(seconds * 1000);
  }

  private emit(sessionId: string): void {
    for (const fn of this.listeners) fn(sessionId);
  }
}
