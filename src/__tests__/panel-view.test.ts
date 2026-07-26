import { describe, test, expect } from "bun:test";
import { parseViews, DEFAULT_VIEWS, cycleGroupBy, cycleSortBy, toggleSortOrder, matchesIssueFilter, pickUpNext, applyFilterPatch, toggleFilterValue, groupIndexForStatus, stateAssignments, assignStateToGroup, unassignState, createView, renameView, moveView, deleteView, createGroup, renameGroup, moveGroup, deleteGroup, stagesFromViews, type PanelView } from "../panel-view";
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

// --- Explicit groups ---
//
// Tabs are a fixed attention model (Urgent / To do / Waiting); what varies per
// workspace is which statuses roll up into each tab, and in what order. So a
// view can carry an explicit ordered group list that drives BOTH membership and
// the section headers, instead of deriving groups from a field.

describe("groupIndexForStatus", () => {
  const groups = [
    { label: "QA Failed", states: ["QA Failed"] },
    { label: "Release Blockers", states: ["Release Blockers", "Blocked"] },
  ];

  test("returns the index of the first group claiming the status", () => {
    expect(groupIndexForStatus("QA Failed", groups)).toBe(0);
    expect(groupIndexForStatus("Blocked", groups)).toBe(1);
  });

  test("matches case- and whitespace-insensitively", () => {
    expect(groupIndexForStatus("  qa failed ", groups)).toBe(0);
  });

  test("returns -1 for a status no group claims", () => {
    expect(groupIndexForStatus("In Progress", groups)).toBe(-1);
  });

  test("first group wins when two claim the same status", () => {
    // Precedence is explicit rather than ambiguous, so a status listed twice
    // still lands somewhere predictable.
    const dupes = [
      { label: "First", states: ["QA Failed"] },
      { label: "Second", states: ["QA Failed"] },
    ];
    expect(groupIndexForStatus("QA Failed", dupes)).toBe(0);
  });
});

describe("parseViews with groups", () => {
  const base = {
    id: "urgent", label: "Urgent", source: "issues",
    filter: { scope: "assigned" },
    groupBy: "none", subGroupBy: "none", sortBy: "priority", sortOrder: "asc",
  };

  test("round-trips an ordered group list", () => {
    const [v] = parseViews([{ ...base, groups: [
      { label: "QA Failed", states: ["QA Failed"] },
      { label: "Blockers", states: ["Release Blockers"] },
    ] }]);
    expect(v.groups).toEqual([
      { label: "QA Failed", states: ["QA Failed"] },
      { label: "Blockers", states: ["Release Blockers"] },
    ]);
  });

  test("drops malformed group entries but keeps the good ones", () => {
    const [v] = parseViews([{ ...base, groups: [
      { label: "Good", states: ["A"] },
      { label: "", states: ["B"] },
      { label: "No states", states: [] },
      "nonsense",
    ] }]);
    expect(v.groups?.map((g) => g.label)).toEqual(["Good"]);
  });

  test("a view with no groups key stays ungrouped", () => {
    expect(parseViews([base])[0].groups).toBeUndefined();
  });
});

// --- State → tab assignment ---
//
// The data model is tab → groups → states, but the question a user actually
// asks is the inverse: "where does this status go?" These helpers present that
// inverse, and by routing every write through assignStateToGroup they also
// enforce one home per state — which is what makes the "first group wins"
// tie-break in groupIndexForStatus unreachable in practice.

const TABS = (): PanelView[] => parseViews([
  { id: "urgent", label: "Urgent", source: "issues", filter: { scope: "assigned" },
    groupBy: "none", subGroupBy: "none", sortBy: "priority", sortOrder: "asc",
    groups: [{ label: "QA Failed", states: ["QA Failed"] }, { label: "Blockers", states: ["Release Blockers"] }] },
  { id: "todo", label: "To do", source: "issues", filter: { scope: "assigned" },
    groupBy: "none", subGroupBy: "none", sortBy: "priority", sortOrder: "asc",
    groups: [{ label: "To do", states: ["To do"] }] },
]);

describe("stateAssignments", () => {
  test("lists every assigned state with its tab and group", () => {
    expect(stateAssignments(TABS())).toEqual([
      { state: "QA Failed", viewId: "urgent", viewLabel: "Urgent", groupLabel: "QA Failed" },
      { state: "Release Blockers", viewId: "urgent", viewLabel: "Urgent", groupLabel: "Blockers" },
      { state: "To do", viewId: "todo", viewLabel: "To do", groupLabel: "To do" },
    ]);
  });

  test("views without groups contribute nothing", () => {
    const plain = parseViews([{ id: "all", label: "All", source: "issues",
      filter: { scope: "assigned" }, groupBy: "none", subGroupBy: "none",
      sortBy: "priority", sortOrder: "asc" }]);
    expect(stateAssignments(plain)).toEqual([]);
  });
});

describe("assignStateToGroup", () => {
  test("adds a previously unassigned state", () => {
    const next = assignStateToGroup(TABS(), "In Progress", "todo", "To do");
    expect(next.find((v) => v.id === "todo")!.groups![0].states).toEqual(["To do", "In Progress"]);
  });

  test("moving a state removes it from its old home", () => {
    // One state, one home — otherwise it would appear in two tabs at once.
    const next = assignStateToGroup(TABS(), "QA Failed", "todo", "To do");
    expect(next.find((v) => v.id === "urgent")!.groups![0].states).toEqual([]);
    expect(next.find((v) => v.id === "todo")!.groups![0].states).toEqual(["To do", "QA Failed"]);
  });

  test("matching an existing assignment is case-insensitive", () => {
    const next = assignStateToGroup(TABS(), "qa failed", "todo", "To do");
    expect(next.find((v) => v.id === "urgent")!.groups![0].states).toEqual([]);
  });

  test("an unknown tab or group leaves everything untouched", () => {
    expect(assignStateToGroup(TABS(), "X", "nope", "To do")).toEqual(TABS());
    expect(assignStateToGroup(TABS(), "X", "todo", "nope")).toEqual(TABS());
  });

  test("does not mutate the input", () => {
    const before = TABS();
    assignStateToGroup(before, "In Progress", "todo", "To do");
    expect(before.find((v) => v.id === "todo")!.groups![0].states).toEqual(["To do"]);
  });
});

describe("unassignState", () => {
  test("removes a state from wherever it lives", () => {
    const next = unassignState(TABS(), "Release Blockers");
    expect(next.find((v) => v.id === "urgent")!.groups![1].states).toEqual([]);
  });

  test("an unknown state is a no-op", () => {
    expect(unassignState(TABS(), "Nonexistent")).toEqual(TABS());
  });
});

// --- Queue CRUD ---
//
// Assigning states covers the thing you do repeatedly; this covers the skeleton
// itself, so a queue layout never has to be built by hand-editing JSON.

const Q = (): PanelView[] => parseViews([
  { id: "urgent", label: "Urgent", source: "issues", filter: { scope: "assigned" },
    groupBy: "none", subGroupBy: "none", sortBy: "priority", sortOrder: "asc",
    groups: [{ label: "A", states: ["s1"] }, { label: "B", states: ["s2"] }] },
  { id: "todo", label: "To do", source: "issues", filter: { scope: "assigned" },
    groupBy: "none", subGroupBy: "none", sortBy: "priority", sortOrder: "asc",
    groups: [{ label: "C", states: ["s3"] }] },
]);

describe("view CRUD", () => {
  test("createView appends a grouped issues view with a slugged id", () => {
    const next = createView(Q(), "Needs Design");
    expect(next).toHaveLength(3);
    expect(next[2].id).toBe("needs-design");
    expect(next[2].label).toBe("Needs Design");
    expect(next[2].groups).toEqual([]);
  });

  test("createView disambiguates a colliding id", () => {
    const next = createView(createView(Q(), "Dup"), "Dup");
    expect(next.map((v) => v.id)).toContain("dup");
    expect(next.map((v) => v.id)).toContain("dup-2");
  });

  test("createView rejects a blank label", () => {
    expect(createView(Q(), "   ")).toEqual(Q());
  });

  test("renameView changes only the label", () => {
    const next = renameView(Q(), "urgent", "Now");
    expect(next[0].label).toBe("Now");
    expect(next[0].id).toBe("urgent");
  });

  test("moveView reorders and clamps at the ends", () => {
    expect(moveView(Q(), "todo", -1).map((v) => v.id)).toEqual(["todo", "urgent"]);
    expect(moveView(Q(), "urgent", -1).map((v) => v.id)).toEqual(["urgent", "todo"]);
    expect(moveView(Q(), "todo", 1).map((v) => v.id)).toEqual(["urgent", "todo"]);
  });

  test("deleteView removes it", () => {
    expect(deleteView(Q(), "urgent").map((v) => v.id)).toEqual(["todo"]);
  });
});

describe("group CRUD", () => {
  test("createGroup appends an empty group", () => {
    const next = createGroup(Q(), "urgent", "C");
    expect(next[0].groups).toEqual([
      { label: "A", states: ["s1"] }, { label: "B", states: ["s2"] }, { label: "C", states: [] },
    ]);
  });

  test("createGroup rejects a duplicate label in the same tab", () => {
    // Labels are the node/collapse key, so duplicates would alias each other.
    expect(createGroup(Q(), "urgent", "A")).toEqual(Q());
  });

  test("the same label in a different tab is fine", () => {
    expect(createGroup(Q(), "todo", "A")[1].groups).toHaveLength(2);
  });

  test("renameGroup keeps its states", () => {
    const next = renameGroup(Q(), "urgent", "A", "Alpha");
    expect(next[0].groups![0]).toEqual({ label: "Alpha", states: ["s1"] });
  });

  test("renameGroup onto an existing label is rejected", () => {
    expect(renameGroup(Q(), "urgent", "A", "B")).toEqual(Q());
  });

  test("moveGroup reorders within its tab and clamps", () => {
    expect(moveGroup(Q(), "urgent", "B", -1)[0].groups!.map((g) => g.label)).toEqual(["B", "A"]);
    expect(moveGroup(Q(), "urgent", "A", -1)[0].groups!.map((g) => g.label)).toEqual(["A", "B"]);
  });

  test("deleteGroup drops it and its state assignments", () => {
    const next = deleteGroup(Q(), "urgent", "A");
    expect(next[0].groups).toEqual([{ label: "B", states: ["s2"] }]);
  });

  test("CRUD never mutates the input", () => {
    const before = Q();
    createGroup(before, "urgent", "Z");
    deleteGroup(before, "urgent", "A");
    expect(before[0].groups!.map((g) => g.label)).toEqual(["A", "B"]);
  });
});

// --- Tabs own the stage ---
//
// One mapping instead of two. Before this, a state was classified once for
// display (which tab) and again for behaviour (which stage), and nothing kept
// the two honest — they had already drifted in practice.

describe("stagesFromViews", () => {
  const V = (over: any = {}) => parseViews([{
    id: "waiting", label: "Waiting", source: "issues", filter: { scope: "assigned" },
    groupBy: "none", subGroupBy: "none", sortBy: "priority", sortOrder: "asc",
    groups: [{ label: "In QA", states: ["QA", "QA2"] }, { label: "In review", states: ["MR Review"] }],
    ...over,
  }]);

  test("a tab's states become its stage's list", () => {
    expect(stagesFromViews(V({ stage: "parked" })).parked).toEqual(["QA", "QA2", "MR Review"]);
  });

  test("tabs with no stage contribute nothing", () => {
    const s = stagesFromViews(V());
    expect(s.parked).toEqual([]);
    expect(s.active).toEqual([]);
  });

  test("several tabs can share one stage", () => {
    const views = parseViews([
      { id: "a", label: "A", source: "issues", filter: { scope: "assigned" }, stage: "active",
        groupBy: "none", subGroupBy: "none", sortBy: "priority", sortOrder: "asc",
        groups: [{ label: "g", states: ["s1"] }] },
      { id: "b", label: "B", source: "issues", filter: { scope: "assigned" }, stage: "active",
        groupBy: "none", subGroupBy: "none", sortBy: "priority", sortOrder: "asc",
        groups: [{ label: "g", states: ["s2"] }] },
    ]);
    expect(stagesFromViews(views).active).toEqual(["s1", "s2"]);
  });

  test("an invalid stage is dropped rather than trusted", () => {
    expect(V({ stage: "nonsense" })[0].stage).toBeUndefined();
  });

  test("every stage key is always present, so callers need no guards", () => {
    expect(Object.keys(stagesFromViews([])).sort()).toEqual(["active", "done", "idea", "parked"]);
  });
});
