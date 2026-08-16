import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TMUX = Bun.which("tmux");
const SOCKET = join(tmpdir(), `jmux-cleanup-${process.pid}.sock`);
const scratch: string[] = [];

function run(argv: string[], cwd?: string): { code: number; out: string; err: string } {
  const result = Bun.spawnSync(argv, { cwd, stdout: "pipe", stderr: "pipe" });
  return {
    code: result.exitCode ?? 1,
    out: result.stdout.toString().trim(),
    err: result.stderr.toString().trim(),
  };
}

function git(args: string[], cwd: string): void {
  const result = run(["git", ...args], cwd);
  if (result.code !== 0) throw new Error(result.err);
}

function tmux(...args: string[]): { code: number; out: string; err: string } {
  return run([TMUX!, "-f", "/dev/null", "-S", SOCKET, ...args]);
}

function setup(): { root: string; worktree: string } {
  const container = realpathSync(mkdtempSync(join(tmpdir(), "jmux-cleanup-int-")));
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
  expect(tmux("new-session", "-d", "-s", "caller", "-c", root, "sleep 30").code).toBe(0);
  expect(tmux("new-session", "-d", "-s", "feature", "-c", worktree, "sleep 30").code).toBe(0);
  expect(tmux("list-sessions", "-F", "#{session_name}").out.split("\n").sort()).toEqual([
    "caller",
    "feature",
  ]);
  return { root, worktree };
}

function cleanupCommand(
  force = false,
  sessionOverride?: string,
): { code: number; out: string; err: string } {
  return run([
    process.execPath,
    "run",
    join(import.meta.dir, "..", "..", "main.ts"),
    "ctl",
    ...(sessionOverride ? ["--session", sessionOverride] : []),
    "--socket",
    SOCKET,
    "session",
    "cleanup",
    "--target",
    "feature",
    ...(force ? ["--force"] : []),
  ]);
}

afterEach(() => {
  tmux("kill-server");
  rmSync(SOCKET, { force: true });
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!TMUX)("ctl session cleanup", () => {
  test("kills the session and removes its clean linked worktree", () => {
    const { worktree } = setup();

    const result = cleanupCommand();

    expect(result).toMatchObject({ code: 0, err: "" });
    expect(JSON.parse(result.out)).toMatchObject({ cleaned: "feature", worktree });
    expect(tmux("has-session", "-t", "feature").code).not.toBe(0);
    expect(existsSync(worktree)).toBe(false);
  });

  test("dirty preflight leaves both the session and worktree intact", () => {
    const { worktree } = setup();
    writeFileSync(join(worktree, "uncommitted.txt"), "keep me\n");

    const result = cleanupCommand();

    expect(result.code).not.toBe(0);
    expect(JSON.parse(result.err).error).toMatch(/uncommitted changes/i);
    expect(tmux("has-session", "-t", "feature").code).toBe(0);
    expect(existsSync(worktree)).toBe(true);
  });

  test("force discards dirty work and completes cleanup", () => {
    const { worktree } = setup();
    writeFileSync(join(worktree, "uncommitted.txt"), "discard me\n");

    const result = cleanupCommand(true);

    expect(result.code).toBe(0);
    expect(JSON.parse(result.out)).toMatchObject({
      cleaned: "feature",
      worktree,
      discardedChanges: true,
    });
    expect(tmux("has-session", "-t", "feature").code).not.toBe(0);
    expect(existsSync(worktree)).toBe(false);
  });

  test("refuses to kill the session the cleanup process belongs to", () => {
    const { worktree } = setup();

    const result = cleanupCommand(true, "feature");

    expect(result.code).not.toBe(0);
    expect(JSON.parse(result.err).error).toMatch(/another session or an external shell/i);
    expect(tmux("has-session", "-t", "feature").code).toBe(0);
    expect(existsSync(worktree)).toBe(true);
  });
});
