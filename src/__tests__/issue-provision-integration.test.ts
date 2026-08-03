// Integration test for the provisioning shape, against a real tmux server.
//
// The unit tests either side of this glue all passed while `ctl issue start`
// was unusable: it built correct commands and then ran the worktree tool with a
// blocking `Bun.spawnSync` *before* creating the session, so a repo whose setup
// takes a minute produced a minute of total silence with nothing in
// `ctl status` — reported as a hang, and interrupted as one.
//
// What has to hold is a property no pure test can see: the session exists
// almost immediately, while the worktree is still being made. So this drives
// real tmux, with a deliberately slow "worktree tool", and asserts the ordering.

import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  buildProvisionPlan,
  buildSetupCommand,
  PROVISION_ATTENTION_REASON,
  SETUP_PANE_SIZE,
} from "../issue-provision";

const TMUX = Bun.which("tmux");
const SOCKET = `jmux-provision-test-${process.pid}`;

function tmux(...args: string[]): { code: number; out: string } {
  const r = Bun.spawnSync([TMUX!, "-L", SOCKET, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: r.exitCode ?? 1,
    out: (r.stdout.toString() + r.stderr.toString()).trim(),
  };
}

const dirs: string[] = [];
function scratchRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "jmux-prov-"));
  dirs.push(dir);
  return dir;
}

/** Poll a condition rather than sleeping a fixed amount. */
async function until(pred: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await Bun.sleep(25);
  }
  return pred();
}

afterEach(() => {
  tmux("kill-server");
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe.skipIf(!TMUX)("issue provisioning, against a real tmux server", () => {
  test(
    "the session is live while the worktree is still being created",
    async () => {
      const repo = scratchRepo();
      const session = "tra-slow";
      const worktree = join(repo, session);

      const plan = buildProvisionPlan({
        session,
        repoDir: repo,
        worktreePath: worktree,
        baseBranch: "main",
        wtm: false,
        worktreeExists: false,
        agentCommand: null,
        promptFile: null,
      });

      // Stand in for a worktree tool that runs install hooks: two seconds of
      // work before the directory appears. This is the case that made the old
      // CLI look hung.
      const slowSetup = `sleep 2; mkdir -p ${JSON.stringify(worktree)}`;

      const started = Date.now();
      expect(
        tmux("new-session", "-d", "-s", session, "-c", plan.sessionCwd, plan.mainCommand).code,
      ).toBe(0);
      expect(
        tmux("split-window", "-h", "-d", "-l", SETUP_PANE_SIZE, "-t", session, "-c", repo, slowSetup)
          .code,
      ).toBe(0);
      const elapsed = Date.now() - started;

      // The whole point: creating the session did not wait for the worktree.
      expect(elapsed).toBeLessThan(1000);
      expect(existsSync(worktree)).toBe(false);

      // And it is observable to anything that lists sessions, right now —
      // which is what `ctl status` and the human's sidebar read.
      expect(tmux("list-sessions", "-F", "#{session_name}").out.split("\n")).toContain(session);

      // The main pane is parked on the wait loop in the repo, not the worktree.
      expect(await until(() => existsSync(worktree), 6000)).toBe(true);

      // Setup pane exits on success, so the pane count drops back to one —
      // the readiness signal `--wait` and the human both read.
      expect(
        await until(() => tmux("list-panes", "-t", session, "-F", "#{pane_id}").out.split("\n").length === 1, 6000),
      ).toBe(true);
    },
    20000,
  );

  test(
    "the main pane cds into the worktree once it lands",
    async () => {
      const repo = scratchRepo();
      const session = "tra-cd";
      const worktree = join(repo, session);

      const plan = buildProvisionPlan({
        session,
        repoDir: repo,
        worktreePath: worktree,
        baseBranch: "main",
        wtm: false,
        worktreeExists: false,
        agentCommand: null,
        promptFile: null,
      });

      tmux("new-session", "-d", "-s", session, "-c", plan.sessionCwd, plan.mainCommand);
      tmux("split-window", "-h", "-d", "-t", session, "-c", repo, `sleep 1; mkdir -p ${JSON.stringify(worktree)}`);

      const inWorktree = await until(() => {
        const cwd = tmux("display-message", "-t", `${session}.0`, "-p", "#{pane_current_path}").out;
        // macOS reports /private/var for /var, so compare on the leaf.
        return cwd.endsWith(session);
      }, 8000);
      expect(inWorktree).toBe(true);
    },
    20000,
  );

  test(
    "a failed worktree tool flags the session and leaves the error on screen",
    async () => {
      const repo = scratchRepo();
      const session = "tra-fail";

      // buildSetupCommand's real output, with a create step that cannot succeed.
      const real = buildSetupCommand({ session, baseBranch: "main", wtm: false });
      const failing = real.replace(
        /^git worktree add [^|]+/,
        "sh -c 'echo boom-from-the-tool >&2; exit 1' ",
      );
      expect(failing).not.toBe(real);

      tmux("new-session", "-d", "-s", session, "-c", repo, "sleep 30");
      tmux("split-window", "-h", "-d", "-t", session, "-c", repo, failing);

      // The flag is what makes a failure nobody waited for still discoverable.
      const flagged = await until(
        () => tmux("show-option", "-t", session, "-qv", "@jmux-attention").out === "1",
        8000,
      );
      expect(flagged).toBe(true);
      expect(tmux("show-option", "-t", session, "-qv", "@jmux-attention-reason").out).toBe(
        PROVISION_ATTENTION_REASON,
      );

      // The pane survived instead of vanishing, so the tool's own error is readable.
      expect(tmux("list-panes", "-t", session, "-F", "#{pane_id}").out.split("\n")).toHaveLength(2);
      expect(tmux("capture-pane", "-t", `${session}.1`, "-p").out).toContain("boom-from-the-tool");
    },
    20000,
  );

  test(
    "an existing worktree opens directly, with no setup pane",
    async () => {
      const repo = scratchRepo();
      const session = "tra-resume";
      const worktree = join(repo, session);
      Bun.spawnSync(["mkdir", "-p", worktree]);

      const plan = buildProvisionPlan({
        session,
        repoDir: repo,
        worktreePath: worktree,
        baseBranch: "main",
        wtm: false,
        worktreeExists: true,
        agentCommand: null,
        promptFile: null,
      });
      expect(plan.setupCommand).toBeNull();

      tmux("new-session", "-d", "-s", session, "-c", plan.sessionCwd, plan.mainCommand);
      expect(tmux("list-panes", "-t", session, "-F", "#{pane_id}").out.split("\n")).toHaveLength(1);
      expect(
        tmux("display-message", "-t", session, "-p", "#{pane_current_path}").out,
      ).toEndWith(session);
    },
    20000,
  );
});
