import type { AgentState } from "./types";

/**
 * Rollup precedence when several agent panes share a session. A session is as
 * urgent as its most urgent pane: one agent blocked on a permission prompt
 * matters more than a sibling still grinding, which matters more than one that
 * has finished.
 *
 * Shared by the TUI tracker and the `jmux ctl` readers so a session can never
 * be summarised two different ways depending on who asked.
 */
export const AGENT_STATE_RANK: Record<AgentState, number> = {
  waiting: 3,
  running: 2,
  complete: 1,
};

export interface RankedState {
  state: AgentState;
  /** Epoch value; units only need to be consistent within one comparison. */
  since: number | null;
}

/**
 * Whether `candidate` should displace `best` as a session's reported state.
 * Ties on state resolve to the *earliest* `since`, so the reported elapsed time
 * tracks the longest-running or longest-blocked agent rather than resetting
 * each time a sibling pane joins the same state. A null `since` never beats a
 * known one.
 */
export function outranks(candidate: RankedState, best: RankedState | null): boolean {
  if (best === null) return true;
  const delta = AGENT_STATE_RANK[candidate.state] - AGENT_STATE_RANK[best.state];
  if (delta !== 0) return delta > 0;
  if (candidate.since === null) return false;
  if (best.since === null) return true;
  return candidate.since < best.since;
}
