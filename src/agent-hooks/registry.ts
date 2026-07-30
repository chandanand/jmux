import type { AgentKind, AgentState } from "../types";
import { claudeIntegration } from "./claude";
import { codexIntegration } from "./codex";
import { piIntegration } from "./pi";
import type { AgentIntegration } from "./types";

/**
 * Every agent jmux knows how to install a state emitter into. Order is the
 * order the installer reports them in.
 */
export const AGENT_INTEGRATIONS: readonly AgentIntegration[] = [
  claudeIntegration,
  codexIntegration,
  piIntegration,
];

export function integrationFor(kind: AgentKind): AgentIntegration | null {
  return AGENT_INTEGRATIONS.find((a) => a.id === kind) ?? null;
}

/** Whether an agent's own integration can observe and report a given state. */
export function agentReports(kind: string, state: AgentState): boolean {
  const integration = AGENT_INTEGRATIONS.find((a) => a.id === kind);
  return integration ? integration.reports.has(state) : false;
}

/**
 * Whether the screen-signature tier is allowed to write `state` onto a pane
 * whose `@jmux-agent-kind` is `kind` (empty when no agent has claimed it).
 *
 * A guess must never overwrite a fact. So the tier owns unclaimed panes
 * outright, and on a claimed pane it may only fill states that agent is
 * structurally incapable of reporting — today that is pi's WAITING, which its
 * extension API never surfaces. The moment someone contributes a pi signature,
 * that gap closes with no change here.
 */
export function screenTierMayWrite(kind: string, state: AgentState): boolean {
  if (kind === "") return true;
  return !agentReports(kind, state);
}

export interface InstallReport {
  label: string;
  kind: "installed" | "migrated" | "noop" | "skipped" | "failed";
  notes: string[];
}

/**
 * Install emitters for every agent present on this machine. Absent agents are
 * skipped rather than having config directories conjured for them.
 */
export function installAllAgents(): InstallReport[] {
  const reports: InstallReport[] = [];
  for (const integration of AGENT_INTEGRATIONS) {
    if (!integration.isPresent()) {
      reports.push({ label: integration.label, kind: "skipped", notes: [] });
      continue;
    }
    try {
      const { kind, notes } = integration.install();
      reports.push({ label: integration.label, kind, notes });
    } catch (err) {
      reports.push({
        label: integration.label,
        kind: "failed",
        notes: [err instanceof Error ? err.message : String(err)],
      });
    }
  }
  return reports;
}

export interface UninstallReport {
  label: string;
  removed: boolean;
  paths: string[];
  notes: string[];
}

/**
 * Reverse every agent integration jmux installed.
 *
 * Unlike install, this does not skip absent agents: an agent uninstalled from
 * the machine after jmux wrote into its config still has jmux's entries on
 * disk, and those are exactly the leftovers this exists to clear.
 */
export function uninstallAllAgents(): UninstallReport[] {
  const reports: UninstallReport[] = [];
  for (const integration of AGENT_INTEGRATIONS) {
    try {
      const { removed, paths, notes } = integration.uninstall();
      reports.push({ label: integration.label, removed, paths, notes });
    } catch (err) {
      reports.push({
        label: integration.label,
        removed: false,
        paths: [],
        notes: [err instanceof Error ? err.message : String(err)],
      });
    }
  }
  return reports;
}
