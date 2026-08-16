import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { planSessionCleanup, removeSessionWorktree } from "../../cli/session-cleanup";

const scratch: string[] = [];

function git(args: string[], cwd?: string): string {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

function repoWithWorktree(): { root: string; worktree: string } {
  const container = realpathSync(mkdtempSync(join(tmpdir(), "jmux-cleanup-")));
  scratch.push(container);
  const root = join(container, "repo");
  const worktree = join(container, "feature");
  mkdirSync(root);
  git(["init", "-q", "-b", "main"], root);
  git(["config", "user.email", "t@example.com"], root);
  git(["config", "user.name", "t"], root);
  git(["config", "commit.gpgsign", "false"], root);
  writeFileSync(join(root, "tracked.txt"), "base\n");
  git(["add", "tracked.txt"], root);
  git(["commit", "-qm", "base"], root);
  git(["worktree", "add", "-q", "-b", "feature", worktree], root);
  return { root, worktree };
}

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("session cleanup worktree safety", () => {
  test("resolves a pane subdirectory to its linked worktree root", () => {
    const { root, worktree } = repoWithWorktree();
    const subdir = join(worktree, "src");
    mkdirSync(subdir);

    const plan = planSessionCleanup(subdir, false);

    expect(plan.worktreePath).toBe(worktree);
    expect(plan.commonGitDir).toBe(join(root, ".git"));
    expect(plan.dirty).toBe(false);
  });

  test("refuses a dirty worktree without changing it", () => {
    const { worktree } = repoWithWorktree();
    writeFileSync(join(worktree, "uncommitted.txt"), "keep me\n");

    expect(() => planSessionCleanup(worktree, false)).toThrow(/uncommitted changes/i);
    expect(existsSync(join(worktree, "uncommitted.txt"))).toBe(true);
  });

  test("force permits dirty work and removes the linked worktree", () => {
    const { root, worktree } = repoWithWorktree();
    writeFileSync(join(worktree, "uncommitted.txt"), "discard me\n");

    const plan = planSessionCleanup(worktree, true);
    expect(plan.dirty).toBe(true);
    removeSessionWorktree(plan, true);

    expect(existsSync(worktree)).toBe(false);
    expect(git(["worktree", "list", "--porcelain"], root)).not.toContain(worktree);
    expect(git(["branch", "--list", "feature"], root)).toContain("feature");
  });

  test("refuses the repository's primary checkout", () => {
    const { root } = repoWithWorktree();
    expect(() => planSessionCleanup(root, true)).toThrow(/primary checkout/i);
  });

  test("refuses a directory that is not a git worktree", () => {
    const dir = mkdtempSync(join(tmpdir(), "jmux-cleanup-plain-"));
    scratch.push(dir);
    expect(() => planSessionCleanup(dir, false)).toThrow(/not inside a git worktree/i);
  });
});
