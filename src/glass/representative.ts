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
  state: AgentState | null;
  since: number | null;
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
    const [paneId, kind, command, pinned, windowActive, paneActive, state, since] =
      splitFields(line);
    if (!paneId) continue;
    out.push({
      paneId,
      kind: kind ?? "",
      command: command ?? "",
      forcedOn: !!pinned,
      sessionActive: windowActive === "1" && paneActive === "1",
      state: VALID_AGENT_STATES.has(state ?? "") ? (state as AgentState) : null,
      since: parseSince(since ?? ""),
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
 * or force-on. Ordered by pane id. Mirrors `detectAgentPanes`'s command-regex
 * handling exactly — an invalid or empty pattern disables that signal, it
 * does not throw or reject the whole row set.
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
 * Precedence: a live `explicitPane` (must appear in `panes`) → the most
 * urgent force-on pane → the most urgent eligible pane. "Most urgent" within
 * each of those two groups falls back to the session-active pane, then the
 * first pane by id, when nothing in the group carries an agent state.
 */
export function electRepresentative(
  panes: readonly PaneRow[],
  explicitPane: string | null,
  commandRegex: string | null,
): string | null {
  if (explicitPane !== null && panes.some((p) => p.paneId === explicitPane)) {
    return explicitPane;
  }

  const eligible = eligiblePanes(panes, commandRegex);
  if (eligible.length === 0) return null;

  const forcedOn = eligible.filter((p) => p.forcedOn);
  const winner = pickWinner(forcedOn.length > 0 ? forcedOn : eligible);
  return winner ? winner.paneId : null;
}
