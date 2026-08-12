// src/ghost-preflight.ts
//
// What pressing Start on an unstarted issue will actually do, resolved before
// anything is provisioned.
//
// This is the part of the ghost preview that earns the surface. Issue detail is
// already available in the info panel; what nothing in jmux surfaced until now
// is the session name it would pick, where the worktree lands, which base
// branch it forks from, and whether an agent launches. All of it is derivable
// from config plus one filesystem check, so there is no reason to make the user
// find out by committing.
//
// Kept pure — every fact arrives as an argument — so the whole decision table
// unit-tests without tmux, a tracker, or a filesystem.

import type { ResolvedProjectSettings } from "./project";
import type { DetailLine } from "./issue-detail";
import { DETAIL_LABEL, DETAIL_VALUE, DETAIL_DIM } from "./issue-detail";

/**
 * What the primary action will do. These are exactly `startWorkOnIssue`'s three
 * states, so the button label can never disagree with the behaviour behind it.
 */
export type PreviewAction = "start" | "resume" | "switch";

export type PreflightPlan =
  /** Config maps this issue's team to a repo — jmux drives the whole thing. */
  | {
      kind: "automated";
      /** Doubles as the branch name and worktree directory (the one-name rule). */
      sessionName: string;
      worktreePath: string;
      baseBranch: string;
      worktreeTool: "wtm" | "git";
      /** The command that will launch, or null when no agent will run. */
      agentCommand: string | null;
    }
  /** No teamRepoMap entry — Start falls through to the manual session picker. */
  | { kind: "manual"; team: string | null }
  /** A live session already claims this issue; Start just switches to it. */
  | { kind: "existing"; sessionName: string };

export interface Preflight {
  action: PreviewAction;
  plan: PreflightPlan;
}

export interface PreflightInput {
  issueState: "none" | "worktree" | "session";
  linkedSessionName: string | undefined;
  /** Already home-expanded, or null when the issue's team maps to no repo. */
  repoDir: string | null;
  sessionName: string | null;
  team: string | null;
  settings: ResolvedProjectSettings;
  /** Whether an issue tracker is configured — gates the seeded agent prompt. */
  trackerPresent: boolean;
}

/**
 * Resolve the pre-flight. The branch order mirrors `startWorkOnIssue` exactly;
 * if the two ever diverge the preview starts lying about what Start does, which
 * is worse than not showing a pre-flight at all.
 */
export function buildPreflight(input: PreflightInput): Preflight {
  // The existing-session check comes first, before the repo lookup, because an
  // explicit L-key link has to work even for a team with no teamRepoMap entry.
  if (input.issueState === "session" && input.linkedSessionName) {
    return {
      action: "switch",
      plan: { kind: "existing", sessionName: input.linkedSessionName },
    };
  }

  if (!input.repoDir || !input.sessionName) {
    return { action: "start", plan: { kind: "manual", team: input.team } };
  }

  // Mirrors `shouldLaunchAgent` in main.ts's startWorkOnIssue. Keep textually
  // identical to it.
  const agentCommand =
    input.settings.autoLaunchAgent && input.trackerPresent
      ? input.settings.agentCommand
      : null;

  return {
    action: input.issueState === "worktree" ? "resume" : "start",
    plan: {
      kind: "automated",
      sessionName: input.sessionName,
      worktreePath: `${input.repoDir}/${input.sessionName}`,
      baseBranch: input.settings.defaultBaseBranch,
      worktreeTool: input.settings.wtmIntegration ? "wtm" : "git",
      agentCommand,
    },
  };
}

/** The label the primary action carries. */
export function preflightActionLabel(action: PreviewAction): string {
  switch (action) {
    case "resume": return "Resume";
    case "switch": return "Switch";
    default: return "Start";
  }
}

/** Below this the label/value columns stop lining up, so the block stacks. */
const STACK_BELOW_COLS = 40;
const LABEL_WIDTH = 9;

function pair(label: string, value: string, stacked: boolean): DetailLine[] {
  if (stacked) {
    return [
      { text: label, attrs: DETAIL_LABEL, indent: 1 },
      { text: value, attrs: DETAIL_VALUE, indent: 2 },
    ];
  }
  return [
    { text: `${label.padEnd(LABEL_WIDTH)}${value}`, attrs: DETAIL_VALUE, indent: 1 },
  ];
}

/**
 * The pre-flight as detail lines, for splicing into the issue body via
 * `buildIssueDetailLines`' `afterMetadata` seam.
 */
export function buildPreflightLines(pf: Preflight, cols: number): DetailLine[] {
  const stacked = cols < STACK_BELOW_COLS;
  const lines: DetailLine[] = [{ text: "", attrs: DETAIL_DIM }];

  switch (pf.plan.kind) {
    case "existing":
      lines.push({ text: "Already started", attrs: { ...DETAIL_LABEL, bold: true } });
      lines.push(...pair("session", pf.plan.sessionName, stacked));
      return lines;

    case "manual":
      lines.push({ text: "Not mapped to a repo", attrs: { ...DETAIL_LABEL, bold: true } });
      lines.push({
        text: `No repo mapped for ${pf.plan.team ?? "this issue's team"} — Start opens the session picker.`,
        attrs: DETAIL_DIM,
        indent: 1,
      });
      return lines;

    case "automated": {
      const { sessionName, worktreePath, baseBranch, worktreeTool, agentCommand } = pf.plan;
      const heading = pf.action === "resume" ? "Resuming will use" : "Starting will create";
      lines.push({ text: heading, attrs: { ...DETAIL_LABEL, bold: true } });
      lines.push(...pair("session", sessionName, stacked));
      lines.push(...pair("worktree", worktreePath, stacked));
      lines.push(...pair("branch", `${sessionName} (from ${baseBranch})`, stacked));
      lines.push(...pair("tool", worktreeTool === "wtm" ? "wtm create" : "git worktree add", stacked));
      lines.push(...pair("agent", agentCommand ?? "none — plain shell", stacked));
      return lines;
    }
  }
}
