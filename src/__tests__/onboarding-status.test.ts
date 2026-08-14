import { describe, expect, test } from "bun:test";
import { deriveStatus, type SetupFacts } from "../onboarding/status";

// Derivation is pure over injected facts, so every state below is reachable
// without touching a filesystem, an adapter or a tmux server.

const base: SetupFacts = {
  agentsPresent: [],
  agentsStale: [],
  skillCurrent: false,
  namingConfigured: false,
  namingAvailable: [],
  trackerType: null,
  trackerAuthed: false,
  trackerDeclined: false,
  projectCount: 0,
  attachedTeamCount: 0,
  workflowTabCount: 0,
  hunkInstalled: false,
};

const withAgent = { ...base, agentsPresent: ["Claude Code"], skillCurrent: true };

describe("deriveStatus — projects", () => {
  test("none yet is pending", () => {
    expect(deriveStatus(base).steps.projects.state).toBe("pending");
  });

  test("counts, and reads in the singular for one", () => {
    expect(deriveStatus({ ...base, projectCount: 1 }).steps.projects.summary).toBe("1 project");
    expect(deriveStatus({ ...base, projectCount: 3 }).steps.projects.summary).toBe("3 projects");
  });
});

describe("deriveStatus — agents", () => {
  // An agent that is not installed here is not a gap to nag about. Unavailable
  // rather than pending is what keeps it out of the toolbar dot.
  test("no agents on the machine is unavailable, not pending", () => {
    const s = deriveStatus(base);
    expect(s.steps.agents.state).toBe("unavailable");
    expect(s.steps.agents.summary).toBe("no agents found");
  });

  test("present but with stale hooks is pending", () => {
    const s = deriveStatus({ ...base, agentsPresent: ["Claude Code"], agentsStale: ["Claude Code"] });
    expect(s.steps.agents.state).toBe("pending");
    expect(s.steps.agents.summary).toBe("1 to set up");
  });

  // The skill rides along because it is the same idea and the same keystroke:
  // jmux and your agents seeing each other.
  test("hooks current but the skill missing is still pending", () => {
    const s = deriveStatus({ ...base, agentsPresent: ["Claude Code"], skillCurrent: false });
    expect(s.steps.agents.state).toBe("pending");
  });

  test("hooks current and the skill installed is satisfied, and names them", () => {
    const s = deriveStatus({ ...base, agentsPresent: ["Claude Code", "Codex"], skillCurrent: true });
    expect(s.steps.agents.state).toBe("satisfied");
    expect(s.steps.agents.summary).toBe("Claude Code, Codex");
  });
});

describe("deriveStatus — tracker", () => {
  test("not connected is pending", () => {
    expect(deriveStatus(base).steps.tracker.state).toBe("pending");
  });

  test("connected is satisfied and names the tracker", () => {
    const s = deriveStatus({ ...base, trackerAuthed: true, trackerType: "linear" });
    expect(s.steps.tracker.state).toBe("satisfied");
    expect(s.steps.tracker.summary).toBe("linear");
  });

  // Declared intent is the one thing no filesystem check can discover, and the
  // only thing that stops the step nagging someone who has answered it.
  test("declined is unavailable rather than a permanent todo", () => {
    const s = deriveStatus({ ...base, trackerDeclined: true });
    expect(s.steps.tracker.state).toBe("unavailable");
    expect(s.steps.tracker.summary).toBe("not for me");
  });
});

describe("deriveStatus — the steps that need a tracker first", () => {
  // Neither can be acted on until a tracker answers, so neither may raise the
  // toolbar dot on a machine that has none.
  test("team and workflow are unavailable until the tracker connects", () => {
    const s = deriveStatus(base);
    expect(s.steps.team.state).toBe("unavailable");
    expect(s.steps.team.summary).toBe("needs a tracker");
    expect(s.steps.workflow.state).toBe("unavailable");
  });

  test("they become pending once it does", () => {
    const s = deriveStatus({ ...base, trackerAuthed: true });
    expect(s.steps.team.state).toBe("pending");
    expect(s.steps.workflow.state).toBe("pending");
  });

  test("and satisfied once they are configured", () => {
    const s = deriveStatus({
      ...base, trackerAuthed: true, attachedTeamCount: 2, workflowTabCount: 3,
    });
    expect(s.steps.team.state).toBe("satisfied");
    expect(s.steps.team.summary).toBe("2 teams routed");
    expect(s.steps.workflow.summary).toBe("3 stages");
  });
});

describe("deriveStatus — outstanding", () => {
  test("true while anything actionable is pending", () => {
    expect(deriveStatus(base).outstanding).toBe(true);
  });

  test("an unavailable step never raises it", () => {
    // No agents, tracker declined, one project: nothing left that jmux can do.
    const s = deriveStatus({ ...base, projectCount: 1, trackerDeclined: true });
    expect(s.steps.agents.state).toBe("unavailable");
    expect(s.steps.tracker.state).toBe("unavailable");
    expect(s.outstanding).toBe(false);
  });

  test("false once every actionable step is satisfied", () => {
    const s = deriveStatus({
      ...withAgent,
      projectCount: 1,
      trackerAuthed: true,
      trackerType: "linear",
      attachedTeamCount: 1,
      workflowTabCount: 3,
    });
    expect(s.outstanding).toBe(false);
  });

  test("the facts travel with the status, so a page need not be handed both", () => {
    const s = deriveStatus({ ...base, hunkInstalled: true });
    expect(s.facts.hunkInstalled).toBe(true);
  });
});
