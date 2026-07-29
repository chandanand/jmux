import { describe, test, expect } from "bun:test";
import { parseViews, DEFAULT_VIEWS, cycleGroupBy, cycleSortBy, toggleSortOrder, matchesIssueFilter, pickUpNext, applyFilterPatch, toggleFilterValue, stateIndexInView, stateAssignments, stageForState, assignStateToView, moveStateInView, unassignState, createView, renameView, moveView, deleteView, parkedStages, toggleParkedState, isParkedState, stageInSidebar, stageShowsUnstarted, toggleViewInSidebar, toggleViewUnstarted, effectiveFilter, suggestLayout, type PanelView } from "../panel-view";
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

describe("stateIndexInView", () => {
  const states = ["QA Failed", "Release Blockers"];

  test("finds a status by position, which is its priority", () => {
    expect(stateIndexInView("QA Failed", states)).toBe(0);
    expect(stateIndexInView("Release Blockers", states)).toBe(1);
  });

  test("matches case- and whitespace-insensitively, like every other comparison", () => {
    expect(stateIndexInView("  qa failed ", states)).toBe(0);
  });

  test("returns -1 for a status the stage does not claim", () => {
    expect(stateIndexInView("Todo", states)).toBe(-1);
    expect(stateIndexInView("Todo", undefined)).toBe(-1);
  });
});

describe("parseViews with a stage's status list", () => {
  const base = {
    id: "urgent", label: "Urgent", source: "issues",
    filter: { scope: "assigned" },
    groupBy: "none", subGroupBy: "none", sortBy: "priority", sortOrder: "asc",
  };

  test("round-trips an ordered status list", () => {
    const [v] = parseViews([{ ...base, states: ["QA Failed", "Release Blockers"] }]);
    expect(v.states).toEqual(["QA Failed", "Release Blockers"]);
  });

  test("drops blanks and non-strings but keeps the good ones", () => {
    const [v] = parseViews([{ ...base, states: ["Good", "", "  ", 7, null] }]);
    expect(v.states).toEqual(["Good"]);
  });

  test("drops a repeated status — it could only ever match once", () => {
    const [v] = parseViews([{ ...base, states: ["A", "a", "B"] }]);
    expect(v.states).toEqual(["A", "B"]);
  });

  test("an empty list is preserved — it means the stage holds nothing", () => {
    // Collapsing [] to "absent" made a stage you had just created fall back to
    // its filter and list every assigned issue. Presence of the key is what
    // makes a view status-driven; the length says how many it holds.
    expect(parseViews([{ ...base, states: [] }])[0].states).toEqual([]);
  });

  test("a missing key still reads as not status-driven", () => {
    expect(parseViews([base])[0].states).toBeUndefined();
    expect(parseViews([{ ...base, states: "nonsense" }])[0].states).toBeUndefined();
  });

  test("a view with no status list stays ungrouped", () => {
    expect(parseViews([base])[0].states).toBeUndefined();
  });
});

// --- State → tab assignment ---
//
// The data model is tab → groups → states, but the question a user actually
// asks is the inverse: "where does this status go?" These helpers present that
// inverse, and by routing every write through assignStateToGroup they also
// enforce one home per state — which is what makes the "first group wins"
// tie-break in sectionIndexForStatus unreachable in practice.

const TABS = (): PanelView[] => parseViews([
  { id: "urgent", label: "Urgent", source: "issues", filter: { scope: "assigned" },
    groupBy: "none", subGroupBy: "none", sortBy: "priority", sortOrder: "asc",
    sections: [{ label: "QA Failed", states: ["QA Failed"] }, { label: "Blockers", states: ["Release Blockers"] }] },
  { id: "todo", label: "To do", source: "issues", filter: { scope: "assigned" },
    groupBy: "none", subGroupBy: "none", sortBy: "priority", sortOrder: "asc",
    sections: [{ label: "To do", states: ["To do"] }] },
]);

describe("stateAssignments", () => {
  test("inverts the config into one row per mapped status", () => {
    // The stored model is stage -> statuses because that is what rendering
    // needs; this is the shape a human asks about.
    const views = parseViews([
      { id: "urgent", label: "Urgent", source: "issues", filter: { scope: "assigned" },
        groupBy: "none", subGroupBy: "none", sortBy: "priority", sortOrder: "asc",
        states: ["QA Failed", "Release Blockers"] },
      { id: "todo", label: "To do", source: "issues", filter: { scope: "assigned" },
        groupBy: "none", subGroupBy: "none", sortBy: "priority", sortOrder: "asc",
        states: ["Todo"] },
    ]);
    expect(stateAssignments(views)).toEqual([
      { state: "QA Failed", viewId: "urgent", viewLabel: "Urgent" },
      { state: "Release Blockers", viewId: "urgent", viewLabel: "Urgent" },
      { state: "Todo", viewId: "todo", viewLabel: "To do" },
    ]);
  });

  test("a stage with no statuses contributes nothing", () => {
    expect(stateAssignments(DEFAULT_VIEWS)).toEqual([]);
  });
});

describe("stageForState", () => {
  const views = () => parseViews([
    { id: "todo", label: "To do", source: "issues", filter: { scope: "assigned" },
      states: ["Todo", "Backlog"] },
    { id: "review", label: "In review", source: "issues", filter: { scope: "assigned" },
      states: ["In Review"] },
    { id: "my-mrs", label: "My MRs", source: "mrs", filter: { scope: "authored" } },
  ]);

  test("finds the stage that lists the status", () => {
    expect(stageForState(views(), "In Review")?.id).toBe("review");
    expect(stageForState(views(), "Backlog")?.id).toBe("todo");
  });

  test("matches case- and whitespace-insensitively, like every other state compare", () => {
    expect(stageForState(views(), "  in review  ")?.id).toBe("review");
    expect(stageForState(views(), "TODO")?.id).toBe("todo");
  });

  test("returns null for a status no stage lists", () => {
    expect(stageForState(views(), "Duplicate")).toBeNull();
  });

  test("returns null for a blank status rather than matching an empty entry", () => {
    expect(stageForState(views(), "")).toBeNull();
    expect(stageForState(views(), "   ")).toBeNull();
  });

  test("MR tabs carry no statuses, so they never claim one", () => {
    expect(stageForState(views(), "My MRs")).toBeNull();
    expect(stageForState(DEFAULT_VIEWS, "Todo")).toBeNull();
  });

  test("first stage wins when a status is listed twice — deterministic, not arbitrary", () => {
    // assignStateToView enforces one home per status; this only keeps a
    // hand-edited config resolving the same way every time.
    const dupes = parseViews([
      { id: "a", label: "A", source: "issues", filter: { scope: "assigned" }, states: ["Todo"] },
      { id: "b", label: "B", source: "issues", filter: { scope: "assigned" }, states: ["Todo"] },
    ]);
    expect(stageForState(dupes, "Todo")?.id).toBe("a");
  });
});

describe("assignStateToView", () => {
  const views = () => parseViews([
    { id: "urgent", label: "Urgent", source: "issues", filter: { scope: "assigned" },
      groupBy: "none", subGroupBy: "none", sortBy: "priority", sortOrder: "asc",
      states: ["QA Failed"] },
    { id: "todo", label: "To do", source: "issues", filter: { scope: "assigned" },
      groupBy: "none", subGroupBy: "none", sortBy: "priority", sortOrder: "asc",
      states: ["Todo"] },
    { id: "mrs", label: "MRs", source: "mrs", filter: { scope: "authored" },
      groupBy: "none", subGroupBy: "none", sortBy: "updated", sortOrder: "desc" },
  ]);

  test("appends the status to the target stage", () => {
    expect(assignStateToView(views(), "Backlog", "todo").find((v) => v.id === "todo")!.states)
      .toEqual(["Todo", "Backlog"]);
  });

  test("removes it from wherever it was — one status, one home", () => {
    // Two homes would resolve via stateIndexInView's first-wins scan, which is
    // a safety net, not a feature.
    const next = assignStateToView(views(), "QA Failed", "todo");
    expect(next.find((v) => v.id === "urgent")!.states).toEqual([]);
    expect(next.find((v) => v.id === "todo")!.states).toEqual(["Todo", "QA Failed"]);
  });

  test("refuses an unknown stage, and an MR tab", () => {
    expect(assignStateToView(views(), "Backlog", "nope")).toEqual(views());
    expect(assignStateToView(views(), "Backlog", "mrs")).toEqual(views());
  });

  test("moveStateInView reorders within a stage and clamps at both ends", () => {
    const v = parseViews([{ id: "t", label: "T", source: "issues", filter: { scope: "assigned" },
      groupBy: "none", subGroupBy: "none", sortBy: "priority", sortOrder: "asc",
      states: ["a", "b", "c"] }]);
    expect(moveStateInView(v, "t", "c", -1)[0].states).toEqual(["a", "c", "b"]);
    expect(moveStateInView(v, "t", "a", -1)[0].states).toEqual(["a", "b", "c"]);
    expect(moveStateInView(v, "t", "zz", 1)).toEqual(v);
  });
});

describe("unassignState", () => {
  test("strips a status from every stage", () => {
    const views = parseViews([
      { id: "a", label: "A", source: "issues", filter: { scope: "assigned" },
        groupBy: "none", subGroupBy: "none", sortBy: "priority", sortOrder: "asc",
        states: ["Shared", "Kept"] },
    ]);
    expect(unassignState(views, "shared")[0].states).toEqual(["Kept"]);
  });
});

// --- Queue CRUD ---
//
// Assigning states covers the thing you do repeatedly; this covers the skeleton
// itself, so a queue layout never has to be built by hand-editing JSON.

const Q = (): PanelView[] => parseViews([
  { id: "urgent", label: "Urgent", source: "issues", filter: { scope: "assigned" },
    groupBy: "none", subGroupBy: "none", sortBy: "priority", sortOrder: "asc",
    sections: [{ label: "A", states: ["s1"] }, { label: "B", states: ["s2"] }] },
  { id: "todo", label: "To do", source: "issues", filter: { scope: "assigned" },
    groupBy: "none", subGroupBy: "none", sortBy: "priority", sortOrder: "asc",
    sections: [{ label: "C", states: ["s3"] }] },
]);

describe("view CRUD", () => {
  test("createView appends a grouped issues view with a slugged id", () => {
    const next = createView(Q(), "Needs Design");
    expect(next).toHaveLength(3);
    expect(next[2].id).toBe("needs-design");
    expect(next[2].label).toBe("Needs Design");
    expect(next[2].states).toEqual([]);
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

// --- Tabs own the stage ---
//
// One mapping instead of two. Before this, a state was classified once for
// display (which tab) and again for behaviour (which stage), and nothing kept
// the two honest — they had already drifted in practice.

describe("parkedStages", () => {
  test("only `parked` is ever populated — the rest come from the tracker", () => {
    // The other three stages used to be authored too: 25 decisions where three
    // of the four possible answers behaved identically. projectStage falls
    // through to the tracker's own category for anything not listed here.
    const st = parkedStages(["In QA", "MR Review"]);
    expect(st.parked).toEqual(["In QA", "MR Review"]);
    expect([st.idea, st.active, st.done]).toEqual([[], [], []]);
  });

  test("nothing parks by default, so an unconfigured jmux hides nothing", () => {
    expect(parkedStages([]).parked).toEqual([]);
  });

  test("every stage key is always present, so callers need no guards", () => {
    expect(Object.keys(parkedStages([])).sort()).toEqual(["active", "done", "idea", "parked"]);
  });

  test("does not alias the caller's array", () => {
    const src = ["In QA"];
    parkedStages(src).parked.push("oops");
    expect(src).toEqual(["In QA"]);
  });
});

describe("toggleParkedState", () => {
  test("adds a status that is not there, keeping order", () => {
    expect(toggleParkedState(["a"], "b")).toEqual(["a", "b"]);
  });

  test("removes one that is, case-insensitively", () => {
    // Tracker state names are matched case-insensitively everywhere else, and
    // a status that could be added twice would park under one spelling only.
    expect(toggleParkedState(["In QA", "b"], "in qa")).toEqual(["b"]);
  });

  test("never mutates the input", () => {
    const src = ["a"];
    toggleParkedState(src, "b");
    expect(src).toEqual(["a"]);
  });

  test("isParkedState matches the same way", () => {
    expect(isParkedState(["In QA"], "in qa")).toBe(true);
    expect(isParkedState(["In QA"], "MR Review")).toBe(false);
  });
});

describe("effectiveFilter", () => {
  const mapped = (states: string[] | undefined): PanelView => ({
    id: "x", label: "X", source: "issues",
    filter: { scope: "assigned", ...(states ? { states } : {}), labels: ["bug"] },
    groupBy: "none", subGroupBy: "none", sortBy: "priority", sortOrder: "asc",
    sessionLinkedFirst: false,
    states: ["Todo"],
  });

  test("drops filter.states when the stage has its own status list", () => {
    // The stage's list drives membership; a states filter set from the panel's
    // F menu would otherwise AND with it and silently hide issues.
    expect(effectiveFilter(mapped(["Doing"]))).toEqual({ scope: "assigned", labels: ["bug"] });
  });

  test("keeps every other axis", () => {
    const view = mapped(undefined);
    view.filter.priorityAtMost = 2;
    expect(effectiveFilter(view)).toEqual({ scope: "assigned", labels: ["bug"], priorityAtMost: 2 });
  });

  test("leaves filter.states alone when the stage maps nothing", () => {
    const view = mapped(["Doing"]);
    delete view.states;
    expect(effectiveFilter(view).states).toEqual(["Doing"]);
  });

  test("an empty status list still counts as mapped", () => {
    // createView() seeds `states: []`. Treating that as unmapped let the
    // filter take over, so a brand-new stage listed everything assigned.
    const view = mapped(["Doing"]);
    view.states = [];
    expect(effectiveFilter(view).states).toBeUndefined();
  });

  test("returns the same object identity when nothing needs stripping", () => {
    const view = mapped(undefined);
    delete view.states;
    expect(effectiveFilter(view)).toBe(view.filter);
  });
});


describe("suggestLayout", () => {
  const states = [
    { name: "Triage", type: "triage" as const },
    { name: "Backlog", type: "backlog" as const },
    { name: "Todo", type: "unstarted" as const },
    { name: "In Progress", type: "started" as const },
    { name: "Done", type: "completed" as const },
    { name: "Canceled", type: "canceled" as const },
    { name: "Duplicate", type: "duplicate" as const },
  ];

  test("builds one tab per lifecycle category, in lifecycle order", () => {
    const views = suggestLayout(states);
    expect(views.map((v) => v.label)).toEqual(["To do", "In progress", "Done"]);
    expect(views.every((v) => v.source === "issues")).toBe(true);
  });

  test("every status lands in exactly one stage", () => {
    const seen = suggestLayout(states).flatMap((v) => v.states!);
    expect(seen.sort()).toEqual([...states.map((s) => s.name)].sort());
  });

  test("a stage is a flat status list in the tracker's own order", () => {
    expect(suggestLayout(states)[0].states).toEqual(["Triage", "Backlog"]);
  });

  test("omits tabs whose category the tracker has no states for", () => {
    const views = suggestLayout([{ name: "Todo", type: "unstarted" as const }]);
    expect(views.map((v) => v.label)).toEqual(["In progress"]);
  });

  test("returns nothing for a tracker that reports no states", () => {
    expect(suggestLayout([])).toEqual([]);
  });

  test("de-duplicates states repeated across teams", () => {
    // listWorkflowStates() unions every team, so the same status name recurs.
    const dupes = [
      { name: "Todo", type: "unstarted" as const, team: "A" },
      { name: "Todo", type: "unstarted" as const, team: "B" },
    ];
    expect(suggestLayout(dupes)[0].states).toEqual(["Todo"]);
  });

  test("output survives a parseViews round-trip unchanged", () => {
    const views = suggestLayout(states);
    expect(parseViews(JSON.parse(JSON.stringify(views)))).toEqual(views);
  });
});

describe("sidebar visibility per stage", () => {
  const views = (): PanelView[] => parseViews([
    { id: "todo", label: "To do", source: "issues", filter: { scope: "assigned" }, states: ["Todo"] },
    { id: "review", label: "Review", source: "issues", filter: { scope: "assigned" }, states: ["In Review"] },
    { id: "mrs", label: "MRs", source: "mrs", filter: { scope: "authored" } },
  ]);
  const byId = (vs: PanelView[], id: string): PanelView => vs.find((v) => v.id === id)!;

  test("both default to on, so an untouched config behaves as before", () => {
    for (const v of views()) {
      expect(stageInSidebar(v)).toBe(true);
      expect(stageShowsUnstarted(v)).toBe(true);
    }
  });

  test("hiding a stage also stops its unstarted rows — there is no band to hold them", () => {
    const v = byId(toggleViewInSidebar(views(), "todo"), "todo");
    expect(stageInSidebar(v)).toBe(false);
    expect(stageShowsUnstarted(v)).toBe(false);
    // …but the stage's own unstarted flag is untouched, so un-hiding restores it.
    expect(v.showUnstarted).toBeUndefined();
    expect(stageShowsUnstarted(byId(toggleViewInSidebar([v], "todo"), "todo"))).toBe(true);
  });

  test("unstarted toggles independently while the stage is shown", () => {
    const off = byId(toggleViewUnstarted(views(), "todo"), "todo");
    expect(stageInSidebar(off)).toBe(true);
    expect(stageShowsUnstarted(off)).toBe(false);
    const on = byId(toggleViewUnstarted([off], "todo"), "todo");
    expect(stageShowsUnstarted(on)).toBe(true);
  });

  test("turning unstarted on for a hidden stage un-hides it, rather than lying", () => {
    const hidden = toggleViewInSidebar(views(), "todo");
    const v = byId(toggleViewUnstarted(hidden, "todo"), "todo");
    expect(stageInSidebar(v)).toBe(true);
    expect(stageShowsUnstarted(v)).toBe(true);
  });

  test("only the non-default value is stored, so defaults add no config noise", () => {
    const on = byId(views(), "todo");
    expect(on.inSidebar).toBeUndefined();
    expect(on.showUnstarted).toBeUndefined();
    const off = byId(toggleViewInSidebar(views(), "todo"), "todo");
    expect(off.inSidebar).toBe(false);
    // Toggling back removes the key rather than writing `true`.
    expect(byId(toggleViewInSidebar([off], "todo"), "todo").inSidebar).toBeUndefined();
  });

  test("the flags survive a config round-trip", () => {
    const edited = toggleViewUnstarted(toggleViewInSidebar(views(), "todo"), "review");
    const reloaded = parseViews(JSON.parse(JSON.stringify(edited)));
    expect(stageInSidebar(byId(reloaded, "todo"))).toBe(false);
    expect(stageShowsUnstarted(byId(reloaded, "review"))).toBe(false);
    expect(stageInSidebar(byId(reloaded, "review"))).toBe(true);
  });

  test("garbage in the config reads as the default rather than throwing", () => {
    const vs = parseViews([
      { id: "a", label: "A", source: "issues", filter: { scope: "assigned" },
        inSidebar: "no", showUnstarted: 0 },
    ]);
    expect(stageInSidebar(vs[0]!)).toBe(true);
    expect(stageShowsUnstarted(vs[0]!)).toBe(true);
  });

  test("MR tabs are not stages, so neither toggle touches them", () => {
    expect(toggleViewInSidebar(views(), "mrs")).toEqual(views());
    expect(toggleViewUnstarted(views(), "mrs")).toEqual(views());
  });

  test("an unknown id changes nothing", () => {
    expect(toggleViewInSidebar(views(), "nope")).toEqual(views());
    expect(toggleViewUnstarted(views(), "nope")).toEqual(views());
  });
});
