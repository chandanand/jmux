import { describe, test, expect } from "bun:test";
import {
  buildPreflight,
  buildPreflightLines,
  preflightActionLabel,
  type PreflightInput,
} from "../ghost-preflight";
import type { ResolvedRepoSettings } from "../repo-settings";
import type { DetailLine } from "../issue-detail";

const SETTINGS: ResolvedRepoSettings = {
  defaultBaseBranch: "main",
  wtmIntegration: true,
  autoLaunchAgent: true,
  sessionNameTemplate: "{issue}",
  claudeCommand: "claude",
  onSessionStartState: null,
  onMrOpenState: null,
  onMrMergedState: null,
};

function input(over: Partial<PreflightInput> = {}): PreflightInput {
  return {
    issueState: "none",
    linkedSessionName: undefined,
    repoDir: "/home/j/Code/jmux",
    sessionName: "eng-412-fix-drag",
    team: "Core",
    settings: SETTINGS,
    trackerPresent: true,
    ...over,
  };
}

function textOf(line: DetailLine): string {
  if ("segments" in line) return line.segments.map((s) => s.text).join("");
  if ("imageRow" in line) return `[image#${line.imageRow.id}:${line.imageRow.tileRow}]`;
  return line.text;
}

const joined = (lines: readonly DetailLine[]) => lines.map(textOf).join("\n");

describe("buildPreflight — action", () => {
  test("nothing exists yet → start", () => {
    expect(buildPreflight(input()).action).toBe("start");
  });

  test("worktree on disk but no session → resume", () => {
    expect(buildPreflight(input({ issueState: "worktree" })).action).toBe("resume");
  });

  test("live session claims the issue → switch", () => {
    const pf = buildPreflight(input({ issueState: "session", linkedSessionName: "eng-412" }));
    expect(pf.action).toBe("switch");
    expect(pf.plan).toEqual({ kind: "existing", sessionName: "eng-412" });
  });

  test("session state without a linked name falls through to the repo path", () => {
    // Defensive: the two travel together in practice, but a missing name must
    // not produce a switch to nowhere.
    expect(buildPreflight(input({ issueState: "session" })).action).toBe("start");
  });
});

describe("buildPreflight — plan", () => {
  test("maps the worktree path under the repo dir, named after the session", () => {
    const pf = buildPreflight(input());
    expect(pf.plan).toEqual({
      kind: "automated",
      sessionName: "eng-412-fix-drag",
      worktreePath: "/home/j/Code/jmux/eng-412-fix-drag",
      baseBranch: "main",
      worktreeTool: "wtm",
      agentCommand: "claude",
    });
  });

  test("wtmIntegration false selects the plain git worktree tool", () => {
    const pf = buildPreflight(input({ settings: { ...SETTINGS, wtmIntegration: false } }));
    expect(pf.plan).toMatchObject({ worktreeTool: "git" });
  });

  test("carries the configured base branch", () => {
    const pf = buildPreflight(input({ settings: { ...SETTINGS, defaultBaseBranch: "develop" } }));
    expect(pf.plan).toMatchObject({ baseBranch: "develop" });
  });

  describe("agent command mirrors startWorkOnIssue's shouldLaunchAgent", () => {
    test("launches when auto-launch is on and a tracker is configured", () => {
      expect(buildPreflight(input()).plan).toMatchObject({ agentCommand: "claude" });
    });

    test("no agent when auto-launch is off", () => {
      const pf = buildPreflight(input({ settings: { ...SETTINGS, autoLaunchAgent: false } }));
      expect(pf.plan).toMatchObject({ agentCommand: null });
    });

    test("no agent when no tracker is configured", () => {
      const pf = buildPreflight(input({ trackerPresent: false }));
      expect(pf.plan).toMatchObject({ agentCommand: null });
    });
  });

  describe("unmapped team", () => {
    test("no repo dir → manual", () => {
      const pf = buildPreflight(input({ repoDir: null }));
      expect(pf).toEqual({ action: "start", plan: { kind: "manual", team: "Core" } });
    });

    test("no resolvable session name → manual", () => {
      const pf = buildPreflight(input({ sessionName: null }));
      expect(pf.plan).toEqual({ kind: "manual", team: "Core" });
    });

    test("an explicit link still switches even with no repo mapping", () => {
      // The ordering rule: the existing-session branch is checked before the
      // repo lookup, so an L-key link works for an unmapped team.
      const pf = buildPreflight(
        input({ repoDir: null, issueState: "session", linkedSessionName: "adhoc" }),
      );
      expect(pf).toEqual({ action: "switch", plan: { kind: "existing", sessionName: "adhoc" } });
    });
  });
});

describe("preflightActionLabel", () => {
  test("names each action", () => {
    expect(preflightActionLabel("start")).toBe("Start");
    expect(preflightActionLabel("resume")).toBe("Resume");
    expect(preflightActionLabel("switch")).toBe("Switch");
  });
});

describe("buildPreflightLines", () => {
  test("automated plan states every fact the user is committing to", () => {
    const text = joined(buildPreflightLines(buildPreflight(input()), 80));
    expect(text).toContain("Starting will create");
    expect(text).toContain("eng-412-fix-drag");
    expect(text).toContain("/home/j/Code/jmux/eng-412-fix-drag");
    expect(text).toContain("from main");
    expect(text).toContain("wtm create");
    expect(text).toContain("claude");
  });

  test("resume plan says it is reusing, not creating", () => {
    const text = joined(buildPreflightLines(buildPreflight(input({ issueState: "worktree" })), 80));
    expect(text).toContain("Resuming will use");
    expect(text).not.toContain("Starting will create");
  });

  test("no agent is stated outright rather than omitted", () => {
    const pf = buildPreflight(input({ settings: { ...SETTINGS, autoLaunchAgent: false } }));
    expect(joined(buildPreflightLines(pf, 80))).toContain("none — plain shell");
  });

  test("git worktree tool is named", () => {
    const pf = buildPreflight(input({ settings: { ...SETTINGS, wtmIntegration: false } }));
    expect(joined(buildPreflightLines(pf, 80))).toContain("git worktree add");
  });

  test("manual plan explains where Start will actually go", () => {
    const text = joined(buildPreflightLines(buildPreflight(input({ repoDir: null })), 80));
    expect(text).toContain("No repo mapped for Core");
    expect(text).toContain("session picker");
  });

  test("manual plan with no team still reads as a sentence", () => {
    const pf = buildPreflight(input({ repoDir: null, team: null }));
    expect(joined(buildPreflightLines(pf, 80))).toContain("this issue's team");
  });

  test("existing plan names the session it will switch to", () => {
    const pf = buildPreflight(input({ issueState: "session", linkedSessionName: "eng-412" }));
    const text = joined(buildPreflightLines(pf, 80));
    expect(text).toContain("Already started");
    expect(text).toContain("eng-412");
  });

  test("narrow widths stack label above value instead of padding columns", () => {
    const wide = buildPreflightLines(buildPreflight(input()), 80);
    const narrow = buildPreflightLines(buildPreflight(input()), 30);
    expect(narrow.length).toBeGreaterThan(wide.length);
    expect(joined(narrow)).toContain("session");
    expect(joined(narrow)).toContain("eng-412-fix-drag");
  });
});
