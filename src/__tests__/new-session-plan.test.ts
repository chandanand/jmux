import { describe, expect, test } from "bun:test";
import { buildNewSessionPlan } from "../new-session-plan";
import type { ResolvedProjectSettings } from "../project";

const SETTINGS: ResolvedProjectSettings = {
  defaultBaseBranch: "main",
  wtmIntegration: true,
  autoLaunchAgent: true,
  sessionNameTemplate: "{identifier}",
  agentCommand: "codex --model gpt-5",
  onSessionStartState: null,
  onMrOpenState: null,
  onMrMergedState: null,
};

describe("buildNewSessionPlan", () => {
  test("launches the configured agent in a standard session", () => {
    const plan = buildNewSessionPlan(
      { type: "standard", dir: "/repo", name: "my.session" },
      SETTINGS,
    );

    expect(plan).toEqual({
      session: "my_session",
      sessionCwd: "/repo",
      mainCommand: "codex --model gpt-5; exec $SHELL",
      setupCommand: null,
      setupCwd: null,
    });
  });

  test("launches the agent in an existing worktree", () => {
    const plan = buildNewSessionPlan(
      {
        type: "existing_worktree",
        dir: "/repo",
        path: "/repo/feature",
        branch: "feature",
      },
      SETTINGS,
    );

    expect(plan.sessionCwd).toBe("/repo/feature");
    expect(plan.mainCommand).toBe("codex --model gpt-5; exec $SHELL");
    expect(plan.setupCommand).toBeNull();
  });

  test("seeds issue context when the wizard was opened from an issue start", () => {
    const plan = buildNewSessionPlan(
      { type: "standard", dir: "/repo", name: "issue" },
      SETTINGS,
      "/tmp/jmux-prompt-1.md",
    );

    expect(plan.mainCommand).toContain(
      `codex --model gpt-5 "$(cat /tmp/jmux-prompt-1.md)"`,
    );
    expect(plan.mainCommand).toContain("rm -f /tmp/jmux-prompt-1.md");
  });

  test("leaves a plain shell when auto-launch is disabled", () => {
    const plan = buildNewSessionPlan(
      { type: "standard", dir: "/repo", name: "shell" },
      { ...SETTINGS, autoLaunchAgent: false },
    );

    expect(plan.mainCommand).toBe("exec $SHELL");
  });

  test("creates a fresh worktree beside the waiting agent", () => {
    const plan = buildNewSessionPlan(
      {
        type: "new_worktree",
        dir: "/repo",
        baseBranch: "develop",
        name: "my.feature",
      },
      SETTINGS,
    );

    expect(plan.session).toBe("my_feature");
    expect(plan.sessionCwd).toBe("/repo");
    expect(plan.mainCommand).toContain("while [ ! -d '/repo/my_feature' ]");
    expect(plan.mainCommand).toContain("cd '/repo/my_feature'; codex --model gpt-5; exec $SHELL");
    expect(plan.setupCommand).toContain("wtm");
    expect(plan.setupCommand).toContain("my_feature");
    expect(plan.setupCommand).toContain("develop");
    expect(plan.setupCwd).toBe("/repo");
  });
});
