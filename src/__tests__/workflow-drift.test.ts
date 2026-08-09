import { describe, test, expect } from "bun:test";
import {
  detectDrift,
  buildSessionWorkflow,
  driftSetupWarning,
  DRIFT_EVENTS,
  type WorkflowInputs,
  type StageRef,
} from "../workflow-drift";
import type { Issue, MergeRequest } from "../adapters/types";

// A stage ladder in the order a user would arrange it in the workflow screen.
const LADDER: Array<{ label: string; states: string[] }> = [
  { label: "Todo", states: ["Backlog", "Todo"] },
  { label: "Doing", states: ["In Progress"] },
  { label: "Review", states: ["In Review", "Awaiting QA"] },
  { label: "Done", states: ["Done", "Released"] },
];

function stageOf(status: string): StageRef | null {
  const want = status.trim().toLowerCase();
  const rank = LADDER.findIndex((s) => s.states.some((n) => n.toLowerCase() === want));
  if (rank < 0) return null;
  const stage = LADDER[rank]!;
  return { id: stage.label.toLowerCase(), label: stage.label, rank, inSidebar: true };
}

/** Targets keyed by team, so a set spanning teams can be given different ones. */
function inputs(
  targets: Record<string, Partial<Record<"session-start" | "mr-open" | "mr-merged", string>>>,
  stage: (status: string) => StageRef | null = stageOf,
): WorkflowInputs {
  return {
    stageOf: stage,
    targetFor: (issue, event) => targets[issue.team ?? ""]?.[event] ?? null,
  };
}

let seq = 0;
function issue(status: string, over: Partial<Issue> = {}): Issue {
  seq += 1;
  return {
    id: `id-${seq}`,
    identifier: `TRA-${seq}`,
    title: "t",
    status,
    stateType: "started",
    assignee: null,
    linkedMrUrls: [],
    webUrl: "",
    team: "Core",
    ...over,
  };
}

function mr(status: MergeRequest["status"]): Pick<MergeRequest, "status"> {
  return { status };
}

const CORE_ALL = {
  Core: { "session-start": "In Progress", "mr-open": "In Review", "mr-merged": "Done" },
};

describe("detectDrift", () => {
  test("a merged MR with the ticket left behind drifts to the configured target", () => {
    const i = issue("In Review");
    const drift = detectDrift([i], [mr("merged")], inputs(CORE_ALL));
    expect(drift?.event).toBe("mr-merged");
    expect(drift?.moves).toEqual([{ issue: i, target: "Done" }]);
  });

  test("merged beats open when both preconditions hold", () => {
    const i = issue("In Progress");
    const drift = detectDrift([i], [mr("open"), mr("merged")], inputs(CORE_ALL));
    expect(drift?.event).toBe("mr-merged");
    expect(drift?.moves[0]!.target).toBe("Done");
  });

  test("open beats session-start when no MR is merged", () => {
    const i = issue("Todo");
    const drift = detectDrift([i], [mr("open")], inputs(CORE_ALL));
    expect(drift?.event).toBe("mr-open");
    expect(drift?.moves[0]!.target).toBe("In Review");
  });

  test("a draft MR satisfies mr-open", () => {
    const drift = detectDrift([issue("Todo")], [mr("draft")], inputs(CORE_ALL));
    expect(drift?.event).toBe("mr-open");
  });

  test("with no MR at all, session-start is the only event left", () => {
    const drift = detectDrift([issue("Backlog")], [], inputs(CORE_ALL));
    expect(drift?.event).toBe("session-start");
    expect(drift?.moves[0]!.target).toBe("In Progress");
  });

  test("a stronger event that produces no move falls through to a weaker one", () => {
    // MR merged, but only session-start has a target configured. Staying silent
    // here would hide a genuine, correctly-configured report.
    const drift = detectDrift(
      [issue("Backlog")],
      [mr("merged")],
      inputs({ Core: { "session-start": "In Progress" } }),
    );
    expect(drift?.event).toBe("session-start");
    expect(drift?.moves[0]!.target).toBe("In Progress");
  });

  test("a ticket already at the target does not drift", () => {
    expect(detectDrift([issue("Done")], [mr("merged")], inputs(CORE_ALL))).toBeNull();
  });

  test("a ticket moved past the target does not drift", () => {
    // "Released" shares the Done stage, so it is not behind it.
    expect(detectDrift([issue("Released")], [mr("merged")], inputs(CORE_ALL))).toBeNull();
  });

  test("no configured target means no drift", () => {
    expect(detectDrift([issue("In Review")], [mr("merged")], inputs({}))).toBeNull();
  });

  test("an issue status claimed by no stage cannot be ordered, so stays silent", () => {
    expect(detectDrift([issue("Blocked")], [mr("merged")], inputs(CORE_ALL))).toBeNull();
  });

  test("a target claimed by no stage cannot be ordered, so stays silent", () => {
    const drift = detectDrift(
      [issue("In Review")],
      [mr("merged")],
      inputs({ Core: { "mr-merged": "Shipped" } }),
    );
    expect(drift).toBeNull();
  });

  test("finished issues are exempt", () => {
    const done = issue("Done", { stateType: "completed" });
    const canceled = issue("Todo", { stateType: "canceled" });
    expect(detectDrift([done, canceled], [mr("merged")], inputs(CORE_ALL))).toBeNull();
  });

  test("targets resolve per issue when a session spans teams", () => {
    const core = issue("In Review", { team: "Core" });
    const infra = issue("In Review", { team: "Infra" });
    const drift = detectDrift([core, infra], [mr("merged")], inputs({
      Core: { "mr-merged": "Done" },
      Infra: { "mr-merged": "Released" },
    }));
    expect(drift?.moves).toEqual([
      { issue: core, target: "Done" },
      { issue: infra, target: "Released" },
    ]);
  });

  test("only the drifting issues of a session appear in the moves", () => {
    const behind = issue("In Progress");
    const arrived = issue("Done", { stateType: "started" });
    const drift = detectDrift([behind, arrived], [mr("merged")], inputs(CORE_ALL));
    expect(drift?.moves.map((m) => m.issue)).toEqual([behind]);
  });

  test("no issues means nothing to report", () => {
    expect(detectDrift([], [mr("merged")], inputs(CORE_ALL))).toBeNull();
  });
});

describe("buildSessionWorkflow", () => {
  test("names the driving issue's stage and bands on it", () => {
    const wf = buildSessionWorkflow([issue("In Review")], [], inputs({}));
    expect(wf?.label).toBe("Review");
    expect(wf?.band).toEqual({ id: "review", label: "Review", rank: 2 });
    expect(wf?.drift).toBeNull();
  });

  test("falls back to the raw status when no stage claims it", () => {
    const wf = buildSessionWorkflow([issue("Blocked")], [], inputs({}));
    expect(wf?.label).toBe("Blocked");
    expect(wf?.band).toBeNull();
  });

  test("a stage hidden from the sidebar still names the row but draws no band", () => {
    const hidden = (status: string) => {
      const s = stageOf(status);
      return s ? { ...s, inSidebar: false } : null;
    };
    const wf = buildSessionWorkflow([issue("In Review")], [], inputs({}, hidden));
    expect(wf?.label).toBe("Review");
    expect(wf?.band).toBeNull();
  });

  test("no issues produces no entry at all", () => {
    expect(buildSessionWorkflow([], [mr("merged")], inputs(CORE_ALL))).toBeNull();
  });

  test("the driving issue's drift is the row-2 field", () => {
    const wf = buildSessionWorkflow([issue("In Review")], [mr("merged")], inputs(CORE_ALL));
    expect(wf?.drift).toBe("Done");
  });

  test("the field and the moves agree on the driving issue", () => {
    // drivingIssue picks the least advanced unfinished ticket, which is the one
    // the badge names — so the field must describe that one, not the first.
    const ahead = issue("In Review", { stateType: "started" });
    const behind = issue("Todo", { stateType: "unstarted" });
    const args = [[ahead, behind], [mr("merged")], inputs(CORE_ALL)] as const;
    const wf = buildSessionWorkflow(...args);
    const drift = detectDrift(...args);
    const driving = drift!.moves.find((m) => m.issue === behind)!;
    expect(wf?.label).toBe("Todo");
    expect(wf?.drift).toBe(driving.target);
  });

  test("driftByIssue is a superset of the field, covering non-driving issues", () => {
    const ahead = issue("In Review", { stateType: "started" });
    const behind = issue("Todo", { stateType: "unstarted" });
    const wf = buildSessionWorkflow([ahead, behind], [mr("merged")], inputs(CORE_ALL));
    expect(wf?.drift).toBe("Done");
    const entries: Array<[string, string]> = [[ahead.id, "Done"], [behind.id, "Done"]];
    expect([...wf!.driftByIssue.entries()].sort()).toEqual(entries.sort());
  });

  test("a drifting non-driving issue is in driftByIssue and absent from the field", () => {
    // The driving ticket's status is claimed by no stage, so it cannot be
    // ordered; the other one can. The row stays blank, the sub-row does not.
    const driving = issue("Blocked", { stateType: "unstarted" });
    const other = issue("In Review", { stateType: "started" });
    const wf = buildSessionWorkflow([driving, other], [mr("merged")], inputs(CORE_ALL));
    expect(wf?.drift).toBeNull();
    expect(wf?.driftByIssue.get(other.id)).toBe("Done");
  });

  test("carries the driving issue's stateType for the narrow fallback", () => {
    const wf = buildSessionWorkflow([issue("In Review", { stateType: "started" })], [], inputs({}));
    expect(wf?.stateType).toBe("started");
  });
});

describe("driftSetupWarning", () => {
  test("reports the inert case rather than letting it look configured", () => {
    expect(driftSetupWarning(false, 3)).toMatch(/no transition targets configured/i);
  });

  test("says nothing once there is something to compare against", () => {
    expect(driftSetupWarning(true, 3)).toBeNull();
  });

  // Naming a cause the user can act on, when the real answer is "nothing to
  // look at yet", is the failure this disclosure exists to prevent: they act on
  // it and the row does not change.
  test("an empty set is reported as such, not as a missing configuration", () => {
    expect(driftSetupWarning(false, 0)).toMatch(/no linked issues/i);
    expect(driftSetupWarning(false, 0)).not.toMatch(/configured/i);
  });

  test("an empty set outranks a configured one — there is still nothing to check", () => {
    expect(driftSetupWarning(true, 0)).toMatch(/no linked issues/i);
  });

  test("the exported event list is what detection actually walks", () => {
    // The diagnostics row asks "is any target configured?" across these, so a
    // list that drifted from the loop would report a feature inert while it was
    // working, or working while it was inert.
    expect([...DRIFT_EVENTS]).toEqual(["mr-merged", "mr-open", "session-start"]);
  });
});
