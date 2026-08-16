import { resolve } from "node:path";
import { CliError } from "./context";

interface GitResult {
  ok: boolean;
  stdout: string;
  error: string;
}

function runGit(args: string[]): GitResult {
  const result = Bun.spawnSync(["git", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = result.exitCode ?? 1;
  return {
    ok: exitCode === 0,
    stdout: result.stdout.toString(),
    error: result.stderr.toString().trim() || `git exited with code ${exitCode}`,
  };
}

function gitValue(args: string[], failure: string): string {
  const result = runGit(args);
  if (!result.ok) throw new CliError(`${failure}: ${result.error}`);
  return result.stdout.trim();
}

export interface SessionCleanupPlan {
  /** Absolute root of the linked worktree to remove. */
  worktreePath: string;
  /** Absolute common git directory used to remove it after its session dies. */
  commonGitDir: string;
  /** Whether cleanup is discarding any tracked or untracked work. */
  dirty: boolean;
}

/**
 * Resolve and validate the worktree behind a session before killing anything.
 *
 * The session path may be a subdirectory. Both git directories are requested
 * in absolute form because the session is killed before removal, so no later
 * command may depend on its cwd still existing. A primary checkout is never a
 * cleanup target: removing it is outside the meaning of a disposable session
 * worktree and `git worktree remove` cannot safely do so anyway.
 */
export function planSessionCleanup(sessionPath: string, force: boolean): SessionCleanupPlan {
  const path = sessionPath.trim();
  if (!path) throw new CliError("Session has no working directory to clean up.");

  const rootResult = runGit([
    "-C", path, "rev-parse", "--path-format=absolute", "--show-toplevel",
  ]);
  if (!rootResult.ok) {
    throw new CliError(`Session path "${path}" is not inside a git worktree.`);
  }
  const worktreePath = resolve(rootResult.stdout.trim());

  const gitDir = resolve(gitValue(
    ["-C", worktreePath, "rev-parse", "--path-format=absolute", "--git-dir"],
    "Could not resolve the worktree git directory",
  ));
  const commonGitDir = resolve(gitValue(
    ["-C", worktreePath, "rev-parse", "--path-format=absolute", "--git-common-dir"],
    "Could not resolve the common git directory",
  ));
  if (gitDir === commonGitDir) {
    throw new CliError(
      `Refusing to remove primary checkout "${worktreePath}"; cleanup only removes linked worktrees.`,
    );
  }

  const status = runGit([
    "-C", worktreePath, "status", "--porcelain=v1", "--untracked-files=all",
  ]);
  if (!status.ok) throw new CliError(`Could not inspect worktree changes: ${status.error}`);
  const dirty = status.stdout.trim().length > 0;
  if (dirty && !force) {
    throw new CliError(
      `Worktree "${worktreePath}" has uncommitted changes. Commit or stash them, or use --force to discard them.`,
    );
  }

  return { worktreePath, commonGitDir, dirty };
}

/** Remove a plan that has already passed every non-destructive preflight. */
export function removeSessionWorktree(plan: SessionCleanupPlan, force: boolean): void {
  const args = ["--git-dir", plan.commonGitDir, "worktree", "remove"];
  if (force) args.push("--force");
  args.push(plan.worktreePath);
  const result = runGit(args);
  if (!result.ok) {
    throw new CliError(
      `Session was killed, but worktree "${plan.worktreePath}" could not be removed: ${result.error}`,
    );
  }
}
