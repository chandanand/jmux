// The pure provisioning decision for the directory-first New Session wizard.
//
// Issue-driven starts already run through issue-provision.ts, where the agent
// receives a tracker prompt. The generic wizard has no prompt to seed, but it
// still knows the selected Project and therefore its resolved agent settings.
// Keeping that decision here makes all three wizard outcomes agree about
// autoLaunchAgent instead of leaving the command construction buried in
// main.ts's modal callback.

import { sanitizeTmuxSessionName } from "./config";
import { buildAgentFragment, buildProvisionPlan } from "./issue-provision";
import type { NewSessionResult } from "./new-session-modal";
import type { ResolvedProjectSettings } from "./project";

export interface NewSessionPlan {
  session: string;
  sessionCwd: string;
  mainCommand: string;
  /** A fresh worktree is created beside the waiting agent; otherwise null. */
  setupCommand: string | null;
  /** The setup pane starts in the repository root. */
  setupCwd: string | null;
}

/**
 * Turn a completed New Session wizard result into the commands tmux needs.
 *
 * A generic session launches the configured agent without a seeded prompt.
 * The shell tail comes from buildAgentFragment, so exiting the agent never
 * destroys the session. Fresh worktrees reuse the same observable, two-pane
 * provisioning shape as issue-driven starts: the main pane waits in the
 * future worktree and the narrow setup pane creates it.
 */
export function buildNewSessionPlan(
  result: NewSessionResult,
  settings: ResolvedProjectSettings,
): NewSessionPlan {
  const session = sanitizeTmuxSessionName(
    result.type === "existing_worktree" ? result.branch : result.name,
  );
  const agentCommand = settings.autoLaunchAgent ? settings.agentCommand : null;

  if (result.type === "new_worktree") {
    const provision = buildProvisionPlan({
      session,
      repoDir: result.dir,
      worktreePath: `${result.dir}/${session}`,
      baseBranch: result.baseBranch,
      wtm: settings.wtmIntegration,
      worktreeExists: false,
      agentCommand,
      promptFile: null,
    });
    return {
      session,
      sessionCwd: provision.sessionCwd,
      mainCommand: provision.mainCommand,
      setupCommand: provision.setupCommand,
      setupCwd: result.dir,
    };
  }

  return {
    session,
    sessionCwd: result.type === "existing_worktree" ? result.path : result.dir,
    mainCommand: buildAgentFragment(agentCommand, null),
    setupCommand: null,
    setupCwd: null,
  };
}
