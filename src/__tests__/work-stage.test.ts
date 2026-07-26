import { describe, test, expect } from "bun:test";
import {
  stageFromStateType,
  projectStage,
  resolveIssueRepoDir,
  stageForIssue,
  STAGE_ORDER,
  type StageConfig,
} from "../work-stage";
import type { WorkStage } from "../repo-settings";

const NO_STAGES: Record<WorkStage, string[]> = { idea: [], active: [], parked: [], done: [] };
const stages = (o: Partial<Record<WorkStage, string[]>>) => ({ ...NO_STAGES, ...o });
import type { Issue } from "../adapters/types";

function issue(over: Partial<Issue> = {}): Issue {
  return {
    id: "i1",
    identifier: "ENG-1",
    title: "t",
    status: "Todo",
    assignee: null,
    linkedMrUrls: [],
    webUrl: "",
    ...over,
  };
}

describe("stageFromStateType", () => {
  test("maps the tracker's own categories onto stages", () => {
    expect(stageFromStateType("triage")).toBe("idea");
    expect(stageFromStateType("backlog")).toBe("idea");
    expect(stageFromStateType("unstarted")).toBe("active");
    expect(stageFromStateType("started")).toBe("active");
    expect(stageFromStateType("completed")).toBe("done");
    expect(stageFromStateType("canceled")).toBe("done");
  });

  test("nothing maps to parked — parking is opt-in only", () => {
    for (const t of ["triage", "backlog", "unstarted", "started", "completed", "canceled"] as const) {
      expect(stageFromStateType(t)).not.toBe("parked");
    }
  });

  test("an unknown or missing category is treated as active", () => {
    expect(stageFromStateType(undefined)).toBe("active");
  });
});

describe("projectStage", () => {
  const settings = stages({ parked: ["In Review", "QA"] });

  test("an explicitly listed state beats the stateType fallback", () => {
    // Linear reports "QA" as `started`; the user says it means parked.
    const s = projectStage(issue({ status: "QA", stateType: "started" }), settings);
    expect(s).toBe("parked");
  });

  test("matching is case- and whitespace-insensitive", () => {
    expect(projectStage(issue({ status: "  qa  ", stateType: "started" }), settings)).toBe("parked");
  });

  test("an unlisted state falls back to its stateType", () => {
    expect(projectStage(issue({ status: "In Progress", stateType: "started" }), settings)).toBe("active");
    expect(projectStage(issue({ status: "Done", stateType: "completed" }), settings)).toBe("done");
  });

  test("with no lists configured nothing is ever parked", () => {
    const bare = NO_STAGES;
    for (const t of ["triage", "backlog", "unstarted", "started", "completed", "canceled"] as const) {
      expect(projectStage(issue({ status: "whatever", stateType: t }), bare)).not.toBe("parked");
    }
  });

  test("a state listed under several stages resolves in documented order", () => {
    const messy = stages({ active: ["QA"], parked: ["QA"], done: ["QA"] });
    // STAGE_ORDER is the tie-break, so the result is deterministic rather
    // than dependent on object key order: the earliest listed stage wins.
    const expected = STAGE_ORDER.filter((s) => s === "active" || s === "parked" || s === "done")[0];
    expect(projectStage(issue({ status: "QA" }), messy)).toBe(expected!);
  });
});

describe("resolveIssueRepoDir", () => {
  const config: StageConfig = {
    issueWorkflow: { teamRepoMap: { Platform: "~/code/backend", Web: "/code/web" } },
  };
  const home = "/Users/dev";

  test("routes an issue to its team's repo", () => {
    expect(resolveIssueRepoDir(issue({ team: "Web" }), config, home)).toBe("/code/web");
  });

  test("expands a leading ~ in the mapping", () => {
    expect(resolveIssueRepoDir(issue({ team: "Platform" }), config, home)).toBe("/Users/dev/code/backend");
  });

  test("returns null for an unmapped or missing team", () => {
    expect(resolveIssueRepoDir(issue({ team: "Mobile" }), config, home)).toBeNull();
    expect(resolveIssueRepoDir(issue(), config, home)).toBeNull();
  });
});

describe("stageForIssue", () => {
  // Stage lists now come from the queue tabs, which are global — so an issue's
  // stage no longer depends on which repo or session you happen to be in.
  const s = stages({ parked: ["QA"], active: ["In Progress"] });

  test("an explicitly mapped state wins", () => {
    expect(stageForIssue(issue({ status: "QA", stateType: "started" }), s)).toBe("parked");
  });

  test("an unmapped state falls back to the tracker category", () => {
    expect(stageForIssue(issue({ status: "Whatever", stateType: "started" }), s)).toBe("active");
    expect(stageForIssue(issue({ status: "Whatever", stateType: "completed" }), s)).toBe("done");
  });

  test("team no longer influences the answer", () => {
    for (const team of ["Core Product", "Core Engineering", undefined]) {
      expect(stageForIssue(issue({ status: "QA", stateType: "started", team }), s)).toBe("parked");
    }
  });
});

describe("stageFromStateType — duplicate", () => {
  // Linear reports a `duplicate` category that jmux's union originally missed,
  // so those issues arrived with stateType undefined and fell through to
  // "active" — a closed-as-duplicate issue sat in the working set forever.
  test("duplicate is a finished state, not an active one", () => {
    expect(stageFromStateType("duplicate")).toBe("done");
  });
});
