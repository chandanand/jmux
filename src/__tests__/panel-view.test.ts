import { describe, test, expect } from "bun:test";
import { parseViews, DEFAULT_VIEWS, cycleGroupBy, cycleSortBy, toggleSortOrder, matchesIssueFilter, pickUpNext, applyFilterPatch, toggleFilterValue, sectionIndexForStatus, stateAssignments, assignStateToGroup, unassignState, createView, renameView, moveView, deleteView, createSection, renameSection, moveSection, deleteSection, parkedStages, toggleParkedState, isParkedState, effectiveFilter, suggestLayout, pruneEmptySections, type PanelView } from "../panel-view";
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

describe("sectionIndexForStatus", () => {
  const groups = [
    { label: "QA Failed", states: ["QA Failed"] },
    { label: "Release Blockers", states: ["Release Blockers", "Blocked"] },
  ];

  test("returns the index of the first group claiming the status", () => {
    expect(sectionIndexForStatus("QA Failed", groups)).toBe(0);
    expect(sectionIndexForStatus("Blocked", groups)).toBe(1);
  });

  test("matches case- and whitespace-insensitively", () => {
    expect(sectionIndexForStatus("  qa failed ", groups)).toBe(0);
  });

  test("returns -1 for a status no group claims", () => {
    expect(sectionIndexForStatus("In Progress", groups)).toBe(-1);
  });

  test("first group wins when two claim the same status", () => {
    // Precedence is explicit rather than ambiguous, so a status listed twice
    // still lands somewhere predictable.
    const dupes = [
      { label: "First", states: ["QA Failed"] },
      { label: "Second", states: ["QA Failed"] },
    ];
    expect(sectionIndexForStatus("QA Failed", dupes)).toBe(0);
  });
});

describe("parseViews with sections", () => {
  const base = {
    id: "urgent", label: "Urgent", source: "issues",
    filter: { scope: "assigned" },
    groupBy: "none", subGroupBy: "none", sortBy: "priority", sortOrder: "asc",
  };

  test("round-trips an ordered group list", () => {
    const [v] = parseViews([{ ...base, sections: [
      { label: "QA Failed", states: ["QA Failed"] },
      { label: "Blockers", states: ["Release Blockers"] },
    ] }]);
    expect(v.sections).toEqual([
      { label: "QA Failed", states: ["QA Failed"] },
      { label: "Blockers", states: ["Release Blockers"] },
    ]);
  });

  test("drops malformed section entries but keeps the good ones", () => {
    const [v] = parseViews([{ ...base, sections: [
      { label: "Good", states: ["A"] },
      { label: "", states: ["B"] },
      "nonsense",
    ] }]);
    expect(v.sections?.map((g) => g.label)).toEqual(["Good"]);
  });

  test("a section with no statuses is dropped — it can never claim an issue", () => {
    // This used to be kept, because the old editor created a section and then
    // asked which statuses it covered, so an empty one was a legitimate
    // intermediate state that had to survive a save. The workflow screen has
    // no such step: a section is created *from* a status, and every path that
    // could empty one runs through pruneEmptySections. What is left is dead
    // config the editor gives you no way to see or remove.
    const [v] = parseViews([{ ...base, sections: [{ label: "New", states: [] }] }]);
    expect(v.sections).toBeUndefined();
  });

  test("a view with no groups key stays ungrouped", () => {
    expect(parseViews([base])[0].sections).toBeUndefined();
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
  test("lists every assigned state with its tab and group", () => {
    expect(stateAssignments(TABS())).toEqual([
      { state: "QA Failed", viewId: "urgent", viewLabel: "Urgent", sectionLabel: "QA Failed" },
      { state: "Release Blockers", viewId: "urgent", viewLabel: "Urgent", sectionLabel: "Blockers" },
      { state: "To do", viewId: "todo", viewLabel: "To do", sectionLabel: "To do" },
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
    expect(next.find((v) => v.id === "todo")!.sections![0].states).toEqual(["To do", "In Progress"]);
  });

  test("moving a state removes it from its old home", () => {
    // One state, one home — otherwise it would appear in two tabs at once.
    const next = assignStateToGroup(TABS(), "QA Failed", "todo", "To do");
    expect(next.find((v) => v.id === "urgent")!.sections![0].states).toEqual([]);
    expect(next.find((v) => v.id === "todo")!.sections![0].states).toEqual(["To do", "QA Failed"]);
  });

  test("matching an existing assignment is case-insensitive", () => {
    const next = assignStateToGroup(TABS(), "qa failed", "todo", "To do");
    expect(next.find((v) => v.id === "urgent")!.sections![0].states).toEqual([]);
  });

  test("an unknown tab or group leaves everything untouched", () => {
    expect(assignStateToGroup(TABS(), "X", "nope", "To do")).toEqual(TABS());
    expect(assignStateToGroup(TABS(), "X", "todo", "nope")).toEqual(TABS());
  });

  test("does not mutate the input", () => {
    const before = TABS();
    assignStateToGroup(before, "In Progress", "todo", "To do");
    expect(before.find((v) => v.id === "todo")!.sections![0].states).toEqual(["To do"]);
  });
});

describe("unassignState", () => {
  test("removes a state from wherever it lives", () => {
    const next = unassignState(TABS(), "Release Blockers");
    expect(next.find((v) => v.id === "urgent")!.sections![1].states).toEqual([]);
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
    expect(next[2].sections).toEqual([]);
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
  test("createSection appends an empty group", () => {
    const next = createSection(Q(), "urgent", "C");
    expect(next[0].sections).toEqual([
      { label: "A", states: ["s1"] }, { label: "B", states: ["s2"] }, { label: "C", states: [] },
    ]);
  });

  test("createSection rejects a duplicate label in the same tab", () => {
    // Labels are the node/collapse key, so duplicates would alias each other.
    expect(createSection(Q(), "urgent", "A")).toEqual(Q());
  });

  test("the same label in a different tab is fine", () => {
    expect(createSection(Q(), "todo", "A")[1].sections).toHaveLength(2);
  });

  test("renameSection keeps its states", () => {
    const next = renameSection(Q(), "urgent", "A", "Alpha");
    expect(next[0].sections![0]).toEqual({ label: "Alpha", states: ["s1"] });
  });

  test("renameSection onto an existing label is rejected", () => {
    expect(renameSection(Q(), "urgent", "A", "B")).toEqual(Q());
  });

  test("moveSection reorders within its tab and clamps", () => {
    expect(moveSection(Q(), "urgent", "B", -1)[0].sections!.map((g) => g.label)).toEqual(["B", "A"]);
    expect(moveSection(Q(), "urgent", "A", -1)[0].sections!.map((g) => g.label)).toEqual(["A", "B"]);
  });

  test("deleteSection drops it and its state assignments", () => {
    const next = deleteSection(Q(), "urgent", "A");
    expect(next[0].sections).toEqual([{ label: "B", states: ["s2"] }]);
  });

  test("CRUD never mutates the input", () => {
    const before = Q();
    createSection(before, "urgent", "Z");
    deleteSection(before, "urgent", "A");
    expect(before[0].sections!.map((g) => g.label)).toEqual(["A", "B"]);
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
  const sectioned = (states: string[] | undefined): PanelView => ({
    id: "x", label: "X", source: "issues",
    filter: { scope: "assigned", ...(states ? { states } : {}), labels: ["bug"] },
    groupBy: "none", subGroupBy: "none", sortBy: "priority", sortOrder: "asc",
    sessionLinkedFirst: false,
    sections: [{ label: "s", states: ["Todo"] }],
  });

  test("drops filter.states when the view has sections", () => {
    // Sections drive membership; a states filter set from the panel's F menu
    // would otherwise AND with them and silently hide issues.
    expect(effectiveFilter(sectioned(["Doing"]))).toEqual({ scope: "assigned", labels: ["bug"] });
  });

  test("keeps every other axis when sections are present", () => {
    const view = sectioned(undefined);
    view.filter.priorityAtMost = 2;
    expect(effectiveFilter(view)).toEqual({ scope: "assigned", labels: ["bug"], priorityAtMost: 2 });
  });

  test("leaves filter.states alone when the view has no sections", () => {
    const view = sectioned(["Doing"]);
    delete view.sections;
    expect(effectiveFilter(view).states).toEqual(["Doing"]);
  });

  test("an empty sections array does not count as sectioned", () => {
    // createView() seeds `sections: []`; until a section exists the tab is
    // still governed by its filter, so a states filter must survive.
    const view = sectioned(["Doing"]);
    view.sections = [];
    expect(effectiveFilter(view).states).toEqual(["Doing"]);
  });

  test("returns the same object identity when nothing needs stripping", () => {
    const view = sectioned(undefined);
    delete view.sections;
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

  test("every status lands in exactly one section", () => {
    const seen = suggestLayout(states).flatMap((v) => v.sections!.flatMap((s) => s.states));
    expect(seen.sort()).toEqual([...states.map((s) => s.name)].sort());
  });

  test("sections carry no stage — the tracker classifies them", () => {
    expect(suggestLayout(states)[0].sections).toEqual([
      { label: "Triage", states: ["Triage"] },
      { label: "Backlog", states: ["Backlog"] },
    ]);
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
    expect(suggestLayout(dupes)[0].sections![0].states).toEqual(["Todo"]);
  });

  test("output survives a parseViews round-trip unchanged", () => {
    const views = suggestLayout(states);
    expect(parseViews(JSON.parse(JSON.stringify(views)))).toEqual(views);
  });
});

describe("pruneEmptySections", () => {
  const withSections = (sections: Array<{ label: string; states: string[] }>): PanelView[] => ([{
    id: "t", label: "T", source: "issues", filter: { scope: "assigned" },
    groupBy: "none", subGroupBy: "none", sortBy: "priority", sortOrder: "asc",
    sessionLinkedFirst: false, sections,
  }]);

  test("drops a section left holding no statuses", () => {
    expect(pruneEmptySections(withSections([
      { label: "Kept", states: ["Todo"] },
      { label: "Emptied", states: [] },
    ]))[0].sections).toEqual([{ label: "Kept", states: ["Todo"] }]);
  });

  test("keeps a section whose statuses simply have no issues right now", () => {
    // "Nothing is blocked" is information — that rule is about issues, not
    // about statuses, and this must not eat it.
    const views = withSections([{ label: "Blocked", states: ["Blocked"] }]);
    expect(pruneEmptySections(views)).toEqual(views);
  });

  test("returns the same objects when there is nothing to prune", () => {
    const views = withSections([{ label: "Kept", states: ["Todo"] }]);
    expect(pruneEmptySections(views)[0]).toBe(views[0]);
  });

  test("leaves a view with no sections alone", () => {
    expect(pruneEmptySections(DEFAULT_VIEWS)).toEqual(DEFAULT_VIEWS);
  });

  test("parseViews drops a zero-status section already written to disk", () => {
    const parsed = parseViews([{
      id: "t", label: "T", source: "issues", filter: { scope: "assigned" },
      groupBy: "none", subGroupBy: "none", sortBy: "priority", sortOrder: "asc",
      sections: [
        { label: "QA Failed", states: [] },
        { label: "Release Blockers", states: ["Release Blockers"] },
      ],
    }]);
    expect(parsed[0].sections).toEqual([
      { label: "Release Blockers", states: ["Release Blockers"] },
    ]);
  });
});
