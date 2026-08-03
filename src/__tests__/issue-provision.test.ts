import { describe, test, expect } from "bun:test";
import {
  buildAgentFragment,
  buildMainCommand,
  buildSetupCommand,
  buildProvisionPlan,
  PROVISION_ATTENTION_REASON,
} from "../issue-provision";

const BASE = {
  session: "tra-123",
  repoDir: "/repo",
  worktreePath: "/repo/tra-123",
  baseBranch: "main",
  wtm: true,
  worktreeExists: false,
  agentCommand: "claude",
  promptFile: "/tmp/jmux-prompt-1",
};

describe("buildAgentFragment", () => {
  test("seeds the prompt as a positional argument, not print mode", () => {
    const f = buildAgentFragment("claude", "/tmp/p");
    expect(f).toContain(`claude "$(cat /tmp/p)"`);
    // `claude -p` is print mode: it runs headless and exits. The CLI used to
    // build its command that way, so an agent-started session behaved nothing
    // like the human's seeded interactive one.
    expect(f).not.toContain("-p ");
  });

  test("removes the prompt file after the agent consumes it", () => {
    expect(buildAgentFragment("claude", "/tmp/p")).toContain("rm -f /tmp/p");
  });

  test("every form keeps the pane alive after the agent exits", () => {
    for (const f of [
      buildAgentFragment("claude", "/tmp/p"),
      buildAgentFragment("claude", null),
      buildAgentFragment(null, null),
    ]) {
      expect(f).toContain("exec $SHELL");
    }
  });

  test("no agent means a plain shell", () => {
    expect(buildAgentFragment(null, "/tmp/p")).toBe("exec $SHELL");
  });
});

describe("buildMainCommand", () => {
  test("waits for the worktree, then cds into it", () => {
    const cmd = buildMainCommand({
      worktreePath: "/repo/tra-123",
      agentFragment: "claude; exec $SHELL",
      awaitWorktree: true,
    });
    expect(cmd).toBe(
      `while [ ! -d '/repo/tra-123' ]; do sleep 0.2; done; cd '/repo/tra-123'; claude; exec $SHELL`,
    );
  });

  test("an existing worktree needs no wait — tmux opens the pane in it", () => {
    expect(
      buildMainCommand({
        worktreePath: "/repo/tra-123",
        agentFragment: "claude; exec $SHELL",
        awaitWorktree: false,
      }),
    ).toBe("claude; exec $SHELL");
  });

  test("quotes a path with a single quote in it", () => {
    const cmd = buildMainCommand({
      worktreePath: "/repo/it's",
      agentFragment: "x",
      awaitWorktree: true,
    });
    expect(cmd).toContain(`'/repo/it'\\''s'`);
  });
});

describe("buildSetupCommand", () => {
  test("wtm repo uses wtm create --no-shell", () => {
    const cmd = buildSetupCommand({ session: "tra-123", baseBranch: "main", wtm: true });
    expect(cmd).toStartWith("wtm create tra-123 --from main --no-shell ||");
  });

  test("non-wtm repo uses git worktree add", () => {
    const cmd = buildSetupCommand({ session: "tra-123", baseBranch: "dev", wtm: false });
    expect(cmd).toStartWith("git worktree add ./tra-123 -b tra-123 dev ||");
  });

  test("failure raises the attention flag before dropping to a shell", () => {
    const cmd = buildSetupCommand({ session: "tra-123", baseBranch: "main", wtm: true });
    const flagAt = cmd.indexOf("@jmux-attention 1");
    const reasonAt = cmd.indexOf(PROVISION_ATTENTION_REASON);
    const execAt = cmd.indexOf("exec $SHELL");
    // `exec` never returns, so anything after it would not run.
    expect(flagAt).toBeGreaterThan(-1);
    expect(flagAt).toBeLessThan(execAt);
    expect(reasonAt).toBeLessThan(execAt);
  });

  test("failure keeps the pane open so the tool's error stays readable", () => {
    expect(
      buildSetupCommand({ session: "s", baseBranch: "main", wtm: true }),
    ).toContain("exec $SHELL");
  });

  test("a failed flag write cannot mask the worktree error", () => {
    const cmd = buildSetupCommand({ session: "s", baseBranch: "main", wtm: true });
    expect(cmd.match(/2>\/dev\/null/g)).toHaveLength(2);
  });

  test("success exits without a shell, so the pane closes itself", () => {
    const cmd = buildSetupCommand({ session: "s", baseBranch: "main", wtm: true });
    // The shell is reachable only through the `||` failure branch.
    expect(cmd.indexOf("exec $SHELL")).toBeGreaterThan(cmd.indexOf("||"));
  });
});

describe("buildProvisionPlan", () => {
  test("fresh issue: session opens in the repo, setup pane creates the worktree", () => {
    const plan = buildProvisionPlan(BASE);
    expect(plan.sessionCwd).toBe("/repo");
    expect(plan.mainCommand).toContain("while [ ! -d '/repo/tra-123' ]");
    expect(plan.setupCommand).toContain("wtm create tra-123");
  });

  test("resumable worktree: session opens in it, no setup pane", () => {
    const plan = buildProvisionPlan({ ...BASE, worktreeExists: true });
    expect(plan.sessionCwd).toBe("/repo/tra-123");
    expect(plan.setupCommand).toBeNull();
    expect(plan.mainCommand).not.toContain("while");
  });

  test("the agent is launched from the worktree, never the repo root", () => {
    const plan = buildProvisionPlan(BASE);
    const cd = plan.mainCommand.indexOf(`cd '/repo/tra-123'`);
    const agent = plan.mainCommand.indexOf("claude ");
    expect(cd).toBeGreaterThan(-1);
    expect(cd).toBeLessThan(agent);
  });

  test("no agent still produces a usable session", () => {
    const plan = buildProvisionPlan({ ...BASE, agentCommand: null, promptFile: null });
    expect(plan.mainCommand).toEndWith("exec $SHELL");
    expect(plan.setupCommand).not.toBeNull();
  });
});
