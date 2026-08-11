/**
 * Election of a session's *representative pane* — the one pane of a session a
 * Command Center tile mirrors. Pure and stateless: every call recomputes the
 * answer from current urgency, with no memory of what was shown last frame.
 * Stickiness (a tile keeping its pane once chosen) is a different question and
 * lives in `GlassView`, not here.
 */

import type { AgentState } from "../types";
import { outranks, type RankedState } from "../agent-state-rollup";
import { US, splitFields } from "../tmux-fields";

/** Format for `list-panes -F` to read everything the election needs, per session. */
export const PANE_ROW_FORMAT = [
  "#{pane_id}",
  "#{@jmux-agent-kind}",
  "#{pane_current_command}",
  "#{@jmux-pinned}",
  "#{window_active}",
  "#{pane_active}",
  "#{@jmux-agent-state}",
  "#{@jmux-agent-state-since}",
  // Session-scoped, so a pane-context read returns the session's value for
  // every pane — which is exactly what is wanted: it names the agent's pane,
  // and that is a fact about the session. This is the election's first tier,
  // the hooks' own answer, and it outranks every heuristic below it.
  "#{@jmux-agent-pane}",
].join(US);

export interface PaneRow {
  paneId: string;
  /** @jmux-agent-kind, pane-scoped, no inheritance source. */
  kind: string;
  /** pane_current_command, for the regex signal. */
  command: string;
  /** Non-empty @jmux-pinned on this pane. */
  forcedOn: boolean;
  /** window_active && pane_active — see module doc on why not pane_active alone. */
  sessionActive: boolean;
  /**
   * This pane's own agent state, or null.
   *
   * Null for every pane that does not declare a `kind`, even when tmux reported
   * a state for it. `@jmux-agent-state` is written at pane scope by the hooks
   * but **a pane-context format read inherits the session's value**, so in a
   * session where any agent is running, `#{@jmux-agent-state}` is non-empty for
   * the shells, the editors and the log tails too — and `since` inherits with
   * it, so they are not even distinguishable by age. `kind` is the only
   * pane-level identity with no inheritance source, which is what makes it the
   * usable gate.
   */
  state: AgentState | null;
  since: number | null;
  /** `@jmux-agent-pane` — the hooks' own answer, identical on every pane. */
  agentPane: string | null;
}

const VALID_AGENT_STATES: ReadonlySet<string> = new Set(["running", "waiting", "complete"]);

function parseSince(raw: string): number | null {
  const seconds = Number(raw);
  if (!raw || !Number.isFinite(seconds) || seconds <= 0) return null;
  return Math.floor(seconds);
}

/** Parse `list-panes -F PANE_ROW_FORMAT` output into election input. */
export function parsePaneRowLines(lines: string[]): PaneRow[] {
  const out: PaneRow[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const [paneId, kind, command, pinned, windowActive, paneActive, state, since, agentPane] =
      splitFields(line);
    if (!paneId) continue;
    // A state without a kind beside it is the session's, inherited — see the
    // note on `PaneRow.state`. Taking it at face value made every shell in an
    // agent's session look equally urgent *and* equally old, so `outranks` tied
    // on both and the winner fell through to the lowest pane id: a session whose
    // shell happened to be %1 and whose agent was %2 showed the shell.
    const declaresKind = (kind ?? "") !== "";
    out.push({
      paneId,
      kind: kind ?? "",
      command: command ?? "",
      forcedOn: !!pinned,
      sessionActive: windowActive === "1" && paneActive === "1",
      state: declaresKind && VALID_AGENT_STATES.has(state ?? "") ? (state as AgentState) : null,
      since: declaresKind ? parseSince(since ?? "") : null,
      agentPane: agentPane ? agentPane : null,
    });
  }
  return out;
}

/** Numeric-aware compare on tmux pane ids (`%3` before `%12`). */
function comparePaneIds(a: string, b: string): number {
  const na = Number(a.replace(/^%/, ""));
  const nb = Number(b.replace(/^%/, ""));
  if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Panes worth cycling: kinded, regex-matched against `pane_current_command`,
 * or force-on. Ordered by pane id. An invalid or empty command pattern
 * disables that signal; it does not throw or reject the whole row set.
 */
export function eligiblePanes(
  panes: readonly PaneRow[],
  commandRegex: string | null,
): PaneRow[] {
  let re: RegExp | null = null;
  if (commandRegex) {
    try {
      re = new RegExp(commandRegex, "i");
    } catch {
      re = null;
    }
  }
  return panes
    .filter((p) => {
      const kindMatch = p.kind !== "";
      const commandMatch = re !== null && p.command !== "" && re.test(p.command);
      return kindMatch || commandMatch || p.forcedOn;
    })
    .sort((a, b) => comparePaneIds(a.paneId, b.paneId));
}

/**
 * The most urgent pane in `rows` by `outranks()`, or null when none of them
 * carry an agent state at all — a set with no urgency signal defers to the
 * caller's next tier rather than picking an arbitrary member.
 */
function mostUrgent(rows: readonly PaneRow[]): PaneRow | null {
  let best: PaneRow | null = null;
  let bestRanked: RankedState | null = null;
  for (const row of rows) {
    if (row.state === null) continue;
    const candidate: RankedState = { state: row.state, since: row.since };
    if (outranks(candidate, bestRanked)) {
      bestRanked = candidate;
      best = row;
    }
  }
  return best;
}

/** Most urgent by state, else the session-active pane, else the first (by pane id). */
function pickWinner(rows: readonly PaneRow[]): PaneRow | null {
  if (rows.length === 0) return null;
  return mostUrgent(rows) ?? rows.find((p) => p.sessionActive) ?? rows[0];
}

/**
 * The live answer to "which pane represents this session right now".
 * Stateless — recomputed from current urgency every call.
 *
 * Walks four tiers, taking the first with members: a live `explicitPane`
 * (must appear in `panes`) → the force-on panes → the eligible panes →
 * failing all of those, every pane the session has. A session with no
 * eligible pane at all — a dev server, a log tail — still elects one via the
 * last tier, which is what lets it tile without anyone pinning it.
 *
 * Within whichever tier answers: most urgent by state, else that tier's
 * session-active member, else its lowest pane id. `null` comes back only
 * when `panes` itself is empty.
 */
export function electRepresentative(
  panes: readonly PaneRow[],
  explicitPane: string | null,
  commandRegex: string | null,
): string | null {
  if (panes.length === 0) return null;

  if (explicitPane !== null && panes.some((p) => p.paneId === explicitPane)) {
    return explicitPane;
  }

  const eligible = eligiblePanes(panes, commandRegex);
  const forcedOn = eligible.filter((p) => p.forcedOn);

  const tier =
    forcedOn.length > 0
      ? forcedOn
      : eligible.length > 0
        ? eligible
        : [...panes].sort((a, b) => comparePaneIds(a.paneId, b.paneId));

  const winner = pickWinner(tier);
  return winner ? winner.paneId : null;
}
