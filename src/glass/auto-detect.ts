/**
 * Auto-detection of agent panes for the Command Center. When the user enables
 * "Auto-pin agent panes", every agent pane is surfaced on the grid without a
 * manual pin. Detection is best-effort from three signals:
 *
 *  1. The pane has `@jmux-agent-kind` set — written by that agent's own
 *     integration into the *pane* option. This is the authoritative signal.
 *  2. The pane is the **active** pane of a session whose `@jmux-agent-state` is
 *     set but where no pane declares a kind — the legacy path, for an agent
 *     integration that still writes state at session scope.
 *  3. The pane's `pane_current_command` matches a configurable regex — catches
 *     agents with no jmux integration at all.
 *
 * Signal 2 needs the kind guard because `@jmux-agent-state` *inherits*: a
 * pane-context read falls back to the session option, so once any agent in a
 * session sets state, every sibling pane — editors, shells, log tails — reads
 * it back and would otherwise be detected as an agent.
 */

import { US, splitFields } from "../tmux-fields";

/** `list-panes -a -F` format that feeds {@link parseAgentDetectLines}. */
export const AGENT_DETECT_FORMAT = [
  "#{pane_id}",
  "#{@jmux-agent-state}",
  "#{pane_active}",
  "#{pane_current_command}",
  "#{@jmux-agent-kind}",
  "#{session_id}",
].join(US);

export interface AgentPaneRow {
  paneId: string;
  /** `@jmux-agent-state`, inherited from the session when the pane has none. */
  agentState: string;
  active: boolean;
  command: string;
  /**
   * `@jmux-agent-kind` — pane-scoped with no inheritance source, so a non-empty
   * value proves *this* pane hosts an agent.
   */
  kind: string;
  sessionId: string;
}

export function parseAgentDetectLines(lines: string[]): AgentPaneRow[] {
  const out: AgentPaneRow[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const [paneId, agentState, active, command, kind, sessionId] = splitFields(line);
    if (!paneId) continue;
    out.push({
      paneId,
      agentState: agentState ?? "",
      active: active === "1",
      command: command ?? "",
      kind: kind ?? "",
      sessionId: sessionId ?? "",
    });
  }
  return out;
}

/**
 * The set of pane ids that should be auto-surfaced on the Command Center.
 * `commandRegex` is matched case-insensitively against `pane_current_command`;
 * an invalid or empty pattern simply disables the command-match signal.
 */
export function detectAgentPanes(
  rows: AgentPaneRow[],
  commandRegex: string | null,
): Set<string> {
  let re: RegExp | null = null;
  if (commandRegex) {
    try {
      re = new RegExp(commandRegex, "i");
    } catch {
      re = null;
    }
  }
  // Any pane declaring a kind makes the whole inherited-state signal redundant
  // *and* wrong — the declaring agent already identified itself, so falling back
  // to "active pane of a session with state" would only add its innocent
  // siblings. Scope the suppression per session, so a legacy agent in one
  // session still gets detected while a migrated one elsewhere does not.
  const kindDeclared = new Set<string>();
  for (const r of rows) {
    if (r.kind !== "") kindDeclared.add(r.sessionId);
  }

  const out = new Set<string>();
  for (const r of rows) {
    const kindMatch = r.kind !== "";
    const legacySessionActive =
      !kindDeclared.has(r.sessionId) && r.agentState !== "" && r.active;
    const commandMatch = re !== null && r.command !== "" && re.test(r.command);
    if (kindMatch || legacySessionActive || commandMatch) out.add(r.paneId);
  }
  return out;
}
