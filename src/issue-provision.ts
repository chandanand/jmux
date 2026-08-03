// The one implementation of "provision a session for this issue".
//
// This used to exist twice and the two copies had drifted badly. The TUI
// created the session *first* and let a sibling setup pane materialize the
// worktree in the background; `ctl issue start` ran the worktree tool with a
// blocking `Bun.spawnSync` and only created the session afterwards. For a
// wtm-managed repo that runs install hooks, the CLI therefore sat silent for
// minutes with no session, no pane and nothing in `ctl status` — indisting-
// uishable from a hang, and an interrupt left an orphan worktree that the next
// attempt mistook for a finished one.
//
// So the shape of provisioning lives here and both callers use it:
//
//   1. `new-session -d` whose main pane waits for the worktree directory, cds
//      into it and launches the agent.
//   2. `split-window -d -l 30%` running the worktree tool. On success it exits
//      and the pane closes; on failure it flags the session for attention and
//      drops to a shell so the error stays on screen.
//
// The ordering is the point. The session is observable the instant step 1
// returns, so the sidebar, `ctl status` and `workflow board` all see the work
// as started while it is still being set up — and nothing has to block.
//
// Kept pure — every fact arrives as an argument, every function returns a
// string — so the whole command table unit-tests without tmux, a tracker or a
// disk. Callers decide how the strings reach tmux: the TUI wraps them with `tq`
// for the control channel, the CLI passes them as argv.

import { tq } from "./shell-quote";
import { worktreeCommandArgv } from "./repo-settings";

/** How often the main pane checks whether the setup pane is done. */
const WORKTREE_POLL_SECONDS = "0.2";

/** The width of the setup pane, leaving the agent ~70%. */
export const SETUP_PANE_SIZE = "30%";

export const PROVISION_ATTENTION_REASON = "worktree setup failed";

/**
 * The agent's command, or a plain shell when no agent should launch.
 *
 * `exec $SHELL` is the tail in both cases: without it the pane dies when the
 * agent exits and the user is ejected from the session they are sitting in.
 *
 * The prompt is seeded by passing the file's *contents* as a positional
 * argument — the documented interactive-seed form. Note that this is not
 * `claude -p`: that is print mode, which runs headless and exits. `ctl issue
 * start` used to build its command with `-p` via `buildClaudeLaunchCommand`,
 * so an agent-started session got a one-shot non-interactive run where the
 * human got a seeded interactive one.
 */
export function buildAgentFragment(
  agentCommand: string | null,
  promptFile: string | null,
): string {
  if (!agentCommand) return `exec $SHELL`;
  if (!promptFile) return `${agentCommand}; exec $SHELL`;
  return `${agentCommand} "$(cat ${promptFile})"; rm -f ${promptFile}; exec $SHELL`;
}

/**
 * The main pane's command.
 *
 * When the worktree already exists the pane simply starts in it (tmux is given
 * the path as `-c`), so the command is just the agent. When it does not, tmux
 * cannot be given a cwd that is not there yet: the pane opens in the repo root
 * and waits for the sibling setup pane to create the directory before cd'ing.
 *
 * The wait is unbounded on purpose. Its terminating condition is the directory
 * appearing, and the failure path is visible next door — a setup pane sitting
 * on an error with the session flagged for attention. A timeout here would
 * replace that legible state with a dead pane and no explanation.
 */
export function buildMainCommand(o: {
  worktreePath: string;
  agentFragment: string;
  /** False when the worktree is already on disk and tmux can open the pane in it. */
  awaitWorktree: boolean;
}): string {
  if (!o.awaitWorktree) return o.agentFragment;
  const path = tq(o.worktreePath);
  return `while [ ! -d ${path} ]; do sleep ${WORKTREE_POLL_SECONDS}; done; cd ${path}; ${o.agentFragment}`;
}

/**
 * The setup pane's command: create the worktree, or leave the failure legible.
 *
 * On failure it does three things and the order matters. It flags the session
 * for attention *before* dropping to a shell, because `exec` never returns —
 * anything after it would not run. The flag is what makes a failure that
 * nobody is watching still reachable: the sidebar draws the session red and
 * `ctl status` reports the reason, so an agent that did not wait around can
 * still discover that provisioning died. The trailing `exec $SHELL` keeps
 * the tool's own error message on screen; without it the pane closes and the
 * main pane waits forever for a worktree that is never coming.
 *
 * `tmux` is invoked bare rather than with a socket flag: the setup pane is
 * inside the server it needs to talk to, so `$TMUX` resolves it. Failures to
 * set the option are swallowed — a flag we could not write must not turn a
 * worktree error into a different error.
 */
export function buildSetupCommand(o: {
  session: string;
  baseBranch: string;
  wtm: boolean;
}): string {
  const create = worktreeCommandArgv({
    wtm: o.wtm,
    session: o.session,
    baseBranch: o.baseBranch,
    noShell: true,
  }).join(" ");

  const target = tq(o.session);
  const flag =
    `tmux set-option -t ${target} @jmux-attention 1 2>/dev/null; ` +
    `tmux set-option -t ${target} @jmux-attention-reason ${tq(PROVISION_ATTENTION_REASON)} 2>/dev/null`;

  return `${create} || { ${flag}; exec $SHELL; }`;
}

export interface ProvisionInput {
  session: string;
  /** The repo the worktree is created in — also the main pane's cwd while waiting. */
  repoDir: string;
  worktreePath: string;
  baseBranch: string;
  wtm: boolean;
  /** True when the worktree is already on disk (a resumable abandoned attempt). */
  worktreeExists: boolean;
  agentCommand: string | null;
  promptFile: string | null;
}

export interface ProvisionPlan {
  /** Where tmux should open the session: the worktree if it exists, else the repo. */
  sessionCwd: string;
  mainCommand: string;
  /** null when the worktree already exists and no setup pane is needed. */
  setupCommand: string | null;
}

/**
 * The whole provisioning shape for one issue, as commands.
 *
 * Two cases, and they differ only in whether a setup pane is needed:
 * a resumable worktree opens directly, a fresh one gets provisioned beside the
 * agent while the agent waits.
 */
export function buildProvisionPlan(input: ProvisionInput): ProvisionPlan {
  const agentFragment = buildAgentFragment(input.agentCommand, input.promptFile);
  return {
    sessionCwd: input.worktreeExists ? input.worktreePath : input.repoDir,
    mainCommand: buildMainCommand({
      worktreePath: input.worktreePath,
      agentFragment,
      awaitWorktree: !input.worktreeExists,
    }),
    setupCommand: input.worktreeExists
      ? null
      : buildSetupCommand({
          session: input.session,
          baseBranch: input.baseBranch,
          wtm: input.wtm,
        }),
  };
}
