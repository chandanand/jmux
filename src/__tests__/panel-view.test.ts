import { describe, test, expect } from "bun:test";
import { parseViews, DEFAULT_VIEWS, cycleGroupBy, cycleSortBy, toggleSortOrder, matchesIssueFilter, pickUpNext, applyFilterPatch, toggleFilterValue } from "../panel-view";
import type { WorkStage } from "../repo-settings";

describe("parseViews", () => {
  test("returns defaults for undefined input", () => {
    expect(parseViews(undefined)).toEqual(DEFAULT_VIEWS);
  });

  test("returns defaults for empty array", () => {
    expect(parseViews([])).toEqual(DEFAULT_VIEWS);
  });

  test("parses valid view", () => {
    const views = parseViews([{
      id: "test", label: "Test", source: "issues",
      filter: { scope: "assigned" }, sortBy: "priority", sortOrder: "asc",
    }]);
    expect(views).toHaveLength(1);
    expect(views[0].id).toBe("test");
    expect(views[0].groupBy).toBe("none");
    expect(views[0].sessionLinkedFirst).toBe(true);
  });

  test("rejects invalid source+scope combo", () => {
    const views = parseViews([{
      id: "bad", label: "Bad", source: "issues",
      filter: { scope: "reviewing" },
    }]);
    expect(views).toEqual(DEFAULT_VIEWS);
  });

  test("skips invalid entries but keeps valid ones", () => {
    const views = parseViews([
      { id: "good", label: "Good", source: "mrs", filter: { scope: "authored" }, sortBy: "updated", sortOrder: "desc" },
      { id: "", label: "", source: "bad" },
    ]);
    expect(views).toHaveLength(1);
    expect(views[0].id).toBe("good");
  });
});

describe("view cycling", () => {
  test("cycleGroupBy wraps around", () => {
    expect(cycleGroupBy("team")).toBe("project");
    expect(cycleGroupBy("none")).toBe("team");
  });

  test("cycleSortBy wraps around", () => {
    expect(cycleSortBy("priority")).toBe("updated");
    expect(cycleSortBy("status")).toBe("priority");
  });

  test("toggleSortOrder", () => {
    expect(toggleSortOrder("asc")).toBe("desc");
    expect(toggleSortOrder("desc")).toBe("asc");
  });
});

// --- Queue filters ---
//
// The default views can only express "assigned to me". The daily pull queues
// (Release Blocker, QA Failed, TODO) are state/label/priority slices, so the
// filter needs those axes to name a real queue.

describe("matchesIssueFilter", () => {
  const stageOf = (i: { status: string }): WorkStage => (i.status === "QA" ? "parked" : "active");
  const issue = (o: Partial<{ status: string; labels: Array<{ name: string }>; priority: number }> = {}) => ({
    status: "Todo",
    labels: [],
    priority: 3,
    ...o,
  });

  test("a scope-only filter matches everything", () => {
    expect(matchesIssueFilter(issue(), { scope: "assigned" }, stageOf)).toBe(true);
  });

  test("states match by name, case-insensitively", () => {
    const f = { scope: "assigned" as const, states: ["QA Failed", "todo"] };
    expect(matchesIssueFilter(issue({ status: "Todo" }), f, stageOf)).toBe(true);
    expect(matchesIssueFilter(issue({ status: "qa failed" }), f, stageOf)).toBe(true);
    expect(matchesIssueFilter(issue({ status: "In Progress" }), f, stageOf)).toBe(false);
  });

  test("stages match via the projection, so a queue is portable across trackers", () => {
    const f = { scope: "assigned" as const, stages: ["parked" as const] };
    expect(matchesIssueFilter(issue({ status: "QA" }), f, stageOf)).toBe(true);
    expect(matchesIssueFilter(issue({ status: "Todo" }), f, stageOf)).toBe(false);
  });

  test("labels match any of the listed names", () => {
    const f = { scope: "assigned" as const, labels: ["release blocker"] };
    expect(matchesIssueFilter(issue({ labels: [{ name: "Release Blocker" }] }), f, stageOf)).toBe(true);
    expect(matchesIssueFilter(issue({ labels: [{ name: "chore" }] }), f, stageOf)).toBe(false);
    expect(matchesIssueFilter(issue({ labels: [] }), f, stageOf)).toBe(false);
  });

  test("priorityAtMost keeps issues at least as urgent as the threshold", () => {
    const f = { scope: "assigned" as const, priorityAtMost: 2 };
    expect(matchesIssueFilter(issue({ priority: 1 }), f, stageOf)).toBe(true);  // urgent
    expect(matchesIssueFilter(issue({ priority: 2 }), f, stageOf)).toBe(true);  // high
    expect(matchesIssueFilter(issue({ priority: 3 }), f, stageOf)).toBe(false); // medium
  });

  test("priority 0 means 'no priority', not 'most urgent'", () => {
    // Linear encodes none as 0 while 1 is urgent, so a naive `<=` would rank
    // unprioritised issues above everything.
    const f = { scope: "assigned" as const, priorityAtMost: 2 };
    expect(matchesIssueFilter(issue({ priority: 0 }), f, stageOf)).toBe(false);
    expect(matchesIssueFilter(issue({ priority: undefined }), f, stageOf)).toBe(false);
  });

  test("criteria combine with AND", () => {
    const f = { scope: "assigned" as const, states: ["Todo"], labels: ["bug"] };
    expect(matchesIssueFilter(issue({ status: "Todo", labels: [{ name: "bug" }] }), f, stageOf)).toBe(true);
    expect(matchesIssueFilter(issue({ status: "Todo", labels: [{ name: "chore" }] }), f, stageOf)).toBe(false);
  });
});

describe("parseViews with queue filters", () => {
  test("round-trips the new filter axes", () => {
    const views = parseViews([{
      id: "qa-failed", label: "QA Failed", source: "issues",
      filter: { scope: "assigned", states: ["QA Failed"], labels: ["bug"], priorityAtMost: 2, stages: ["active"] },
      groupBy: "none", subGroupBy: "none", sortBy: "priority", sortOrder: "asc",
    }]);
    expect(views[0].filter).toEqual({
      scope: "assigned",
      states: ["QA Failed"],
      labels: ["bug"],
      priorityAtMost: 2,
      stages: ["active"],
    });
  });

  test("drops malformed filter extras rather than failing the whole view", () => {
    const views = parseViews([{
      id: "v", label: "V", source: "issues",
      filter: { scope: "assigned", states: "not-an-array", priorityAtMost: "high" },
      groupBy: "none", subGroupBy: "none", sortBy: "priority", sortOrder: "asc",
    }]);
    expect(views[0].filter).toEqual({ scope: "assigned" });
  });
});

// --- Up next ---
//
// The daily ritual is "pull from Release Blocker, then QA Failed, then TODO".
// Expressing that as an ordered list of view ids means the queues themselves
// stay defined in one place (panelViews) rather than duplicated as filter
// syntax in a second setting.

describe("pickUpNext", () => {
  const items = new Map<string, string[]>([
    ["blockers", []],
    ["qa-failed", ["ENG-2", "ENG-3"]],
    ["todo", ["ENG-9"]],
  ]);

  test("returns the first item of the first non-empty queue", () => {
    expect(pickUpNext(["blockers", "qa-failed", "todo"], items))
      .toEqual({ viewId: "qa-failed", item: "ENG-2" });
  });

  test("respects the configured order, not the map order", () => {
    expect(pickUpNext(["todo", "qa-failed"], items))
      .toEqual({ viewId: "todo", item: "ENG-9" });
  });

  test("skips ids with no matching view", () => {
    expect(pickUpNext(["nonexistent", "todo"], items))
      .toEqual({ viewId: "todo", item: "ENG-9" });
  });

  test("returns null when every queue is empty", () => {
    expect(pickUpNext(["blockers"], items)).toBeNull();
    expect(pickUpNext([], items)).toBeNull();
  });
});

describe("filter editing", () => {
  test("toggling adds then removes a value", () => {
    let f = toggleFilterValue({ scope: "assigned" }, "states", "QA Failed");
    expect(f.states).toEqual(["QA Failed"]);
    f = toggleFilterValue(f, "states", "qa failed"); // case-insensitive
    expect(f.states).toBeUndefined();
  });

  test("an emptied axis is removed, not left as []", () => {
    // parseViews drops empty arrays on load, so leaving one would make the
    // running view disagree with the same config after a restart.
    const f = applyFilterPatch({ scope: "assigned", states: ["x"] }, { states: [] });
    expect("states" in f).toBe(false);
  });

  test("what the editor writes survives a parseViews round-trip unchanged", () => {
    const edited = toggleFilterValue(
      applyFilterPatch({ scope: "assigned" }, { priorityAtMost: 2 }),
      "stages", "parked",
    );
    const [view] = parseViews([{
      id: "q", label: "Q", source: "issues", filter: edited,
      groupBy: "none", subGroupBy: "none", sortBy: "priority", sortOrder: "asc",
    }]);
    expect(view.filter).toEqual(edited);
  });

  test("clearing priority removes the key", () => {
    const f = applyFilterPatch({ scope: "assigned", priorityAtMost: 2 }, { priorityAtMost: undefined });
    expect("priorityAtMost" in f).toBe(false);
  });

  test("scope always survives editing", () => {
    const f = toggleFilterValue({ scope: "assigned" }, "labels", "bug");
    expect(f.scope).toBe("assigned");
  });
});
