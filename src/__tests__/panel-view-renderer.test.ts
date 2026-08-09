import { describe, test, expect } from "bun:test";
import {
  transformIssues,
  transformMrs,
  buildViewNodes,
  itemsInGroup,
  checkedItems,
  renderView,
  createViewState,
  moveSelection,
  layoutPreviewTabs,
  previewTabAtCol,
  previewTabRow,
  stepPreviewIndex,
  resolveActiveTab,
  pickSessionIndicator,
  formatAge,
  type RenderableItem,
  computeViewLayout,
  splitRatioForSepRow,
  DEFAULT_PANEL_SPLIT_RATIO,
  type PreviewTabs,
} from "../panel-view-renderer";
import type { PanelView } from "../panel-view";
import { theme } from "../theme";
import { tokens, frame } from "../chrome-tokens";
import type { Issue, MergeRequest } from "../adapters/types";

const ISSUE: Issue = {
  id: "i1", identifier: "ENG-1234", title: "Fix auth", status: "In Progress",
  assignee: "jarred", linkedMrUrls: [], webUrl: "",
  team: "Platform", project: "Auth", priority: 1, updatedAt: 1000,
};

const ISSUE2: Issue = {
  id: "i2", identifier: "ENG-1235", title: "Add logging", status: "Todo",
  assignee: "alice", linkedMrUrls: [], webUrl: "",
  team: "Platform", project: "Infra", priority: 3, updatedAt: 2000,
};

const ISSUE3: Issue = {
  id: "i3", identifier: "ENG-1236", title: "Fix CSS", status: "In Progress",
  assignee: "jarred", linkedMrUrls: [], webUrl: "",
  team: "Frontend", priority: 2, updatedAt: 3000,
};

const VIEW: PanelView = {
  id: "test", label: "Test", source: "issues",
  filter: { scope: "assigned" },
  groupBy: "team", subGroupBy: "status",
  sortBy: "priority", sortOrder: "asc",
  sessionLinkedFirst: true,
};

function extractText(grid: { cells: Array<Array<{ char: string }>> }): string {
  return grid.cells.map((row) => row.map((c) => c.char).join("")).join("\n");
}

describe("transformIssues", () => {
  test("transforms with session-linked detection", () => {
    const items = transformIssues([ISSUE, ISSUE2], new Set(["i1"]));
    expect(items).toHaveLength(2);
    expect(items[0].sessionLinked).toBe(true);
    expect(items[1].sessionLinked).toBe(false);
    expect(items[0].primary).toBe("ENG-1234");
  });
});

describe("buildViewNodes", () => {
  test("groups by team with subgroup by status", () => {
    const items = transformIssues([ISSUE, ISSUE2, ISSUE3], new Set());
    const nodes = buildViewNodes(items, VIEW, new Set());
    const groupNodes = nodes.filter((n) => n.kind === "group");
    expect(groupNodes.length).toBeGreaterThanOrEqual(2);
  });

  test("no grouping returns flat list", () => {
    const flatView: PanelView = { ...VIEW, groupBy: "none", subGroupBy: "none" };
    const items = transformIssues([ISSUE, ISSUE2], new Set());
    const nodes = buildViewNodes(items, flatView, new Set());
    expect(nodes.every((n) => n.kind === "item")).toBe(true);
  });

  test("collapsed group hides children", () => {
    const items = transformIssues([ISSUE, ISSUE2], new Set());
    const collapsed = new Set(["Platform"]);
    const nodes = buildViewNodes(items, VIEW, collapsed);
    const platformGroup = nodes.find((n) => n.kind === "group" && n.label === "Platform");
    expect(platformGroup).toBeDefined();
    const platformItems = nodes.filter((n) => n.kind === "item" && (n.item.raw as Issue).team === "Platform");
    expect(platformItems).toHaveLength(0);
  });

  test("session-linked items sorted first", () => {
    const items = transformIssues([ISSUE, ISSUE2, ISSUE3], new Set(["i3"]));
    const flatView: PanelView = { ...VIEW, groupBy: "none", subGroupBy: "none" };
    const nodes = buildViewNodes(items, flatView, new Set());
    const firstItem = nodes.find((n) => n.kind === "item");
    expect(firstItem?.kind === "item" && firstItem.item.id).toBe("i3");
  });

  test("groups are sorted alphabetically, not by item insertion order", () => {
    // Item-level sort is by priority asc → ISSUE (Platform, prio 1) is first,
    // ISSUE3 (Frontend, prio 2) second. Without explicit group sort the
    // groups would appear as [Platform, Frontend]; with it they're [Frontend, Platform].
    const items = transformIssues([ISSUE, ISSUE3, ISSUE2], new Set());
    const nodes = buildViewNodes(items, VIEW, new Set());
    const groupLabels = nodes.filter((n) => n.kind === "group" && n.depth === 0).map((n) => (n as any).label);
    expect(groupLabels).toEqual(["Frontend", "Platform"]);
  });

  test("subgroup order is stable when an item changes status", () => {
    // Two Platform issues: one Todo (unstarted), one In Progress (started).
    // The lower-priority issue is initially Todo so the In Progress subgroup
    // is encountered first under priority-asc sort.
    const before: Issue[] = [
      { ...ISSUE, id: "p1", priority: 1, status: "In Progress", stateType: "started", team: "Platform" },
      { ...ISSUE, id: "p2", priority: 2, status: "Todo", stateType: "unstarted", team: "Platform" },
    ];
    const beforeNodes = buildViewNodes(transformIssues(before, new Set()), VIEW, new Set());
    const beforeSubs = beforeNodes.filter((n) => n.kind === "group" && n.depth === 1).map((n) => (n as any).label);

    // After: change p1 from In Progress → Todo. p1 is now the higher-priority
    // Todo, so under Map-insertion-order subgroups would be [Todo, In Progress].
    // With deterministic ordering they remain in workflow order regardless.
    const after: Issue[] = [
      { ...ISSUE, id: "p1", priority: 1, status: "Todo", stateType: "unstarted", team: "Platform" },
      { ...ISSUE, id: "p2", priority: 2, status: "Todo", stateType: "unstarted", team: "Platform" },
    ];
    const afterNodes = buildViewNodes(transformIssues(after, new Set()), VIEW, new Set());
    const afterSubs = afterNodes.filter((n) => n.kind === "group" && n.depth === 1).map((n) => (n as any).label);

    expect(beforeSubs).toEqual(["Todo", "In Progress"]);
    expect(afterSubs).toEqual(["Todo"]);
    // unstarted < started in workflow order, so Todo is always before In Progress
    // when both are present, regardless of which item moved.
    const mixed: Issue[] = [
      { ...ISSUE, id: "p1", priority: 1, status: "In Progress", stateType: "started", team: "Platform" },
      { ...ISSUE, id: "p2", priority: 2, status: "Todo", stateType: "unstarted", team: "Platform" },
      { ...ISSUE, id: "p3", priority: 3, status: "In Progress", stateType: "started", team: "Platform" },
    ];
    const mixedNodes = buildViewNodes(transformIssues(mixed, new Set()), VIEW, new Set());
    const mixedSubs = mixedNodes.filter((n) => n.kind === "group" && n.depth === 1).map((n) => (n as any).label);
    expect(mixedSubs).toEqual(["Todo", "In Progress"]);
  });

  test("priority groups order: 1=Urgent..4=Low, 0=None last", () => {
    const issues: Issue[] = [
      { ...ISSUE, id: "a", priority: 0, team: "T" },
      { ...ISSUE, id: "b", priority: 4, team: "T" },
      { ...ISSUE, id: "c", priority: 1, team: "T" },
      { ...ISSUE, id: "d", priority: 3, team: "T" },
    ];
    const view: PanelView = { ...VIEW, groupBy: "priority", subGroupBy: "none" };
    const nodes = buildViewNodes(transformIssues(issues, new Set()), view, new Set());
    const labels = nodes.filter((n) => n.kind === "group").map((n) => (n as any).label);
    expect(labels).toEqual(["1", "3", "4", "0"]);
  });
});

describe("pickSessionIndicator", () => {
  test("issue with no session/worktree shows hollow dot", () => {
    const items = transformIssues([ISSUE], new Set(), new Map([["i1", { state: "none", sessionName: "" }]]));
    expect(pickSessionIndicator(items[0]).glyph).toBe("○");
  });

  test("issue with worktree only shows half-circle", () => {
    const items = transformIssues([ISSUE], new Set(), new Map([["i1", { state: "worktree", sessionName: "i1" }]]));
    expect(pickSessionIndicator(items[0]).glyph).toBe("◐");
  });

  test("issue with session shows filled dot", () => {
    const items = transformIssues([ISSUE], new Set(), new Map([["i1", { state: "session", sessionName: "i1" }]]));
    expect(pickSessionIndicator(items[0]).glyph).toBe("●");
  });

  test("issue whose session is current is bold (distinguishable from other-session)", () => {
    const otherItems = transformIssues([ISSUE], new Set(), new Map([["i1", { state: "session", sessionName: "i1" }]]));
    const currentItems = transformIssues([ISSUE], new Set(["i1"]), new Map([["i1", { state: "session", sessionName: "i1" }]]));
    expect(pickSessionIndicator(otherItems[0]).glyphAttrs.bold).toBeFalsy();
    expect(pickSessionIndicator(currentItems[0]).glyphAttrs.bold).toBe(true);
  });

  test("MR falls back to sessionLinked-only behaviour", () => {
    const mr: MergeRequest = {
      id: "m1", title: "x", status: "open", sourceBranch: "f", targetBranch: "main",
      pipeline: null, approvals: { required: 0, current: 0 }, webUrl: "",
    };
    const linked = transformMrs([mr], new Set(["m1"]));
    const unlinked = transformMrs([mr], new Set());
    expect(pickSessionIndicator(linked[0]).glyph).toBe("●");
    expect(pickSessionIndicator(unlinked[0]).glyph).toBe("○");
  });
});

describe("renderView", () => {
  test("renders items into grid", () => {
    const items = transformIssues([ISSUE], new Set());
    const nodes = buildViewNodes(items, { ...VIEW, groupBy: "none", subGroupBy: "none" }, new Set());
    const grid = renderView(nodes, 40, 20, createViewState());
    const text = extractText(grid);
    expect(text).toContain("ENG-1234");
  });

  test("renders detail pane when rows >= 15", () => {
    const items = transformIssues([ISSUE], new Set());
    const nodes = buildViewNodes(items, { ...VIEW, groupBy: "none", subGroupBy: "none" }, new Set());
    const grid = renderView(nodes, 40, 20, createViewState());
    const text = extractText(grid);
    expect(text).toContain("[o]");
    expect(text).toContain("[n]");
  });

  test("no detail pane when rows < 15", () => {
    const items = transformIssues([ISSUE], new Set());
    const nodes = buildViewNodes(items, { ...VIEW, groupBy: "none", subGroupBy: "none" }, new Set());
    const grid = renderView(nodes, 40, 10, createViewState());
    const text = extractText(grid);
    expect(text).toContain("ENG-1234");
    expect(text).not.toContain("[n]");
  });

  test("renders group headers", () => {
    const items = transformIssues([ISSUE, ISSUE3], new Set());
    const nodes = buildViewNodes(items, VIEW, new Set());
    const grid = renderView(nodes, 40, 30, createViewState());
    const text = extractText(grid);
    expect(text).toContain("Platform");
    expect(text).toContain("Frontend");
  });
});

describe("computeViewLayout", () => {
  // The bands are [filter bar] | list | separator | detail | action bar. These
  // numbers used to be derived twice — here for painting and again in main.ts
  // for hit-testing — with formulas that disagreed once a filter was active.
  test("the bands tile the panel exactly, with no gaps or overlap", () => {
    for (const rows of [15, 20, 33, 50]) {
      for (const filtering of [false, true]) {
        const l = computeViewLayout(rows, filtering);
        expect(l.showDetail).toBe(true);
        expect(l.listStartRow).toBe(l.filterBarRows);
        expect(l.sepRow).toBe(l.listStartRow + l.listRows);
        expect(l.detailStart).toBe(l.sepRow + 1);
        expect(l.detailStart + l.detailRows).toBe(l.actionBarStart);
        expect(l.actionBarStart).toBe(rows - 2);
        expect(l.detailRows).toBeGreaterThanOrEqual(4);
      }
    }
  });

  test("a filter bar consumes a row from the list, not from the detail", () => {
    // main.ts's old duplicate formula ignored the filter bar entirely, so with
    // a filter active its idea of where the list ended disagreed with the
    // paint and clicks near the boundary mis-routed.
    const plain = computeViewLayout(40, false);
    const filtered = computeViewLayout(40, true);
    expect(filtered.listStartRow).toBe(plain.listStartRow + 1);
    expect(filtered.listRows).toBeLessThanOrEqual(plain.listRows);
    expect(filtered.detailRows).toBe(plain.detailRows);
  });

  test("a short panel collapses to list-only", () => {
    const l = computeViewLayout(14, false);
    expect(l.showDetail).toBe(false);
    expect(l.listRows).toBe(14);
    expect(l.detailRows).toBe(0);
  });

  test("the split ratio moves the separator", () => {
    const small = computeViewLayout(40, false, 0.25);
    const half = computeViewLayout(40, false, DEFAULT_PANEL_SPLIT_RATIO);
    const big = computeViewLayout(40, false, 0.9);
    expect(small.sepRow).toBeLessThan(half.sepRow);
    expect(big.sepRow).toBeGreaterThan(half.sepRow);
  });

  test("extreme ratios still leave both panes usable", () => {
    for (const ratio of [0, 0.01, 0.99, 1]) {
      const l = computeViewLayout(40, false, ratio);
      expect(l.listRows).toBeGreaterThanOrEqual(3);
      expect(l.detailRows).toBeGreaterThanOrEqual(4);
    }
  });

  test("the drag range never inverts, even on the shortest panel with detail", () => {
    for (let rows = 15; rows <= 40; rows++) {
      const l = computeViewLayout(rows, false);
      expect(l.minSepRow).toBeLessThanOrEqual(l.maxSepRow);
    }
  });
});

describe("computeViewLayout robustness", () => {
  // The ratio arrives from a hand-editable config file. A non-numeric value
  // used to make listRows NaN, which reached grid.cells[NaN] and threw a
  // TypeError straight out of the render loop.
  test("a malformed ratio falls back to the default instead of producing NaN", () => {
    const good = computeViewLayout(48, false, DEFAULT_PANEL_SPLIT_RATIO);
    for (const bad of [NaN, Infinity, -Infinity, "0.7", null, undefined, {}]) {
      const l = computeViewLayout(48, false, bad as unknown as number);
      expect(Number.isInteger(l.listRows)).toBe(true);
      expect(Number.isInteger(l.sepRow)).toBe(true);
      // undefined takes the parameter default, which is the same value.
      if (bad !== undefined) expect(l.listRows).toBe(good.listRows);
    }
  });

  test("rendering never throws on a malformed ratio", () => {
    for (const bad of [NaN, "abc", null, -3, 5]) {
      expect(() =>
        renderView([], 60, 48, createViewState(), { splitRatio: bad as unknown as number }),
      ).not.toThrow();
    }
  });

  test("out-of-range ratios clamp rather than escaping the legal range", () => {
    for (const ratio of [-5, 0, 1, 9]) {
      const l = computeViewLayout(48, false, ratio);
      expect(l.sepRow).toBeGreaterThanOrEqual(l.minSepRow);
      expect(l.sepRow).toBeLessThanOrEqual(l.maxSepRow);
    }
  });
});

describe("splitRatioForSepRow", () => {
  // The drag reports a row; the paint consumes a ratio. If the round trip
  // isn't exact the separator drifts away from the pointer as you drag.
  test("round-trips every legal separator row", () => {
    for (const rows of [20, 33, 50]) {
      for (const filtering of [false, true]) {
        const bounds = computeViewLayout(rows, filtering);
        for (let sep = bounds.minSepRow; sep <= bounds.maxSepRow; sep++) {
          const ratio = splitRatioForSepRow(rows, filtering, sep);
          expect(computeViewLayout(rows, filtering, ratio).sepRow).toBe(sep);
        }
      }
    }
  });

  test("stays within 0..1 for out-of-range rows", () => {
    expect(splitRatioForSepRow(40, false, -50)).toBe(0);
    expect(splitRatioForSepRow(40, false, 999)).toBe(1);
  });
});

// --- Explicit group buckets ---

describe("buildViewNodes with a stage's status list", () => {
  const view = {
    id: "urgent", label: "Urgent", source: "issues" as const,
    filter: { scope: "assigned" as const },
    groupBy: "none" as const, subGroupBy: "none" as const,
    sortBy: "priority" as const, sortOrder: "asc" as const,
    sessionLinkedFirst: false,
    states: ["QA Failed", "Release Blockers"],
  };

  const item = (id: string, status: string, priority = 3): RenderableItem => ({
    id, type: "issue", primary: id, title: id, status, meta: "",
    group: "", subGroup: status, sessionLinked: false, priority,
    updatedAt: 0, raw: {} as any,
  });

  test("subheadings are the status names, in configured order not alphabetical", () => {
    // "Release Blockers" sorts before "QA Failed" alphabetically; the stage's
    // own order is priority order, so it wins.
    const nodes = buildViewNodes(
      [item("a", "Release Blockers"), item("b", "QA Failed")], view, new Set(),
    );
    const labels = nodes.filter((n) => n.kind === "group").map((n: any) => n.label);
    expect(labels).toEqual(["QA Failed", "Release Blockers"]);
  });

  test("items land under their own status", () => {
    const nodes = buildViewNodes(
      [item("a", "Release Blockers"), item("b", "QA Failed")], view, new Set(),
    );
    const order = nodes.map((n) => n.kind === "group" ? `#${(n as any).label}` : (n as any).item.id);
    expect(order).toEqual(["#QA Failed", "b", "#Release Blockers", "a"]);
  });

  test("a stage holding one status draws no subheading at all", () => {
    // The tab already names it; a heading repeating it would say nothing.
    const solo = { ...view, states: ["QA Failed"] };
    const nodes = buildViewNodes([item("b", "QA Failed")], solo, new Set());
    expect(nodes.filter((n) => n.kind === "group")).toHaveLength(0);
    expect(nodes.filter((n) => n.kind === "item")).toHaveLength(1);
  });

  test("statuses the stage does not list are excluded entirely", () => {
    const nodes = buildViewNodes([item("z", "In Progress")], view, new Set());
    expect(nodes.filter((n) => n.kind === "item")).toHaveLength(0);
  });

  test("a status with no issues still shows its header with a zero count", () => {
    // An empty queue is information, not noise — it says "nothing is blocked"
    // rather than silently disappearing.
    const nodes = buildViewNodes([item("b", "QA Failed")], view, new Set());
    const blockers = nodes.find((n) => n.kind === "group" && (n as any).label === "Release Blockers");
    expect(blockers).toBeDefined();
    expect((blockers as any).count).toBe(0);
  });

  test("collapsing a group hides its items but keeps the header", () => {
    const nodes = buildViewNodes([item("b", "QA Failed")], view, new Set(["QA Failed"]));
    expect(nodes.filter((n) => n.kind === "item")).toHaveLength(0);
    expect(nodes.filter((n) => n.kind === "group")).toHaveLength(2);
  });

  test("sorting still applies within a group", () => {
    const nodes = buildViewNodes(
      [item("low", "QA Failed", 4), item("urgent", "QA Failed", 1)], view, new Set(),
    );
    const ids = nodes.filter((n) => n.kind === "item").map((n: any) => n.item.id);
    expect(ids).toEqual(["urgent", "low"]);
  });
});

describe("issue row extras", () => {
  test("formatAge renders compact relative ages", () => {
    const now = Date.UTC(2026, 0, 30);
    expect(formatAge(now, now)).toBe("now");
    expect(formatAge(now - 5 * 60_000, now)).toBe("5m");
    expect(formatAge(now - 3 * 3600_000, now)).toBe("3h");
    expect(formatAge(now - 3 * 86400_000, now)).toBe("3d");
    expect(formatAge(now - 21 * 86400_000, now)).toBe("3w");
    expect(formatAge(now - 200 * 86400_000, now)).toBe("6mo");
  });

  test("an unknown timestamp renders nothing rather than 1970", () => {
    expect(formatAge(0, Date.UTC(2026, 0, 30))).toBe("");
  });

  test("transformIssues carries the worst pipeline state of the linked MRs", () => {
    // The loop ends in MRs, so "which of these went red" should be visible on
    // the issue row without opening anything.
    const issue = {
      id: "i1", identifier: "TRA-1", title: "t", status: "MR Review",
      assignee: null, linkedMrUrls: ["u1", "u2"], webUrl: "",
    } as any;
    const mrs = new Map([
      ["u1", { pipeline: { state: "passed" } }],
      ["u2", { pipeline: { state: "failed" } }],
    ]) as any;
    const [item] = transformIssues([issue], new Set(), undefined, mrs);
    expect(item.pipeline).toBe("failed");
  });

  test("no linked MRs leaves the pipeline undefined", () => {
    const issue = { id: "i", identifier: "T-1", title: "t", status: "s", assignee: null, linkedMrUrls: [], webUrl: "" } as any;
    expect(transformIssues([issue], new Set(), undefined, new Map()).pop()!.pipeline).toBeUndefined();
  });
});

describe("buildViewNodes for a stage with no statuses", () => {
  const view = {
    id: "urgent", label: "Urgent", source: "issues" as const,
    filter: { scope: "assigned" as const },
    groupBy: "none" as const, subGroupBy: "none" as const,
    sortBy: "priority" as const, sortOrder: "asc" as const,
    sessionLinkedFirst: false,
    states: [] as string[],
  };
  const item = (id: string, status: string): RenderableItem => ({
    id, type: "issue", primary: id, title: id, status, meta: "",
    group: "", subGroup: status, sessionLinked: false, priority: 3,
    updatedAt: 0, raw: {} as any,
  });

  test("shows nothing, rather than falling through to every assigned issue", () => {
    // `createView` seeds `states: []`, and removing a stage's last status
    // leaves it there. Testing the list's *length* let both cases fall through
    // to the groupBy branch, so a stage you had just made listed everything.
    const nodes = buildViewNodes([item("a", "Anything"), item("b", "Other")], view, new Set());
    expect(nodes).toEqual([]);
  });

  test("a view with no states key at all is still governed by its filter", () => {
    // The default "Issues" tab has no states key and must keep showing
    // everything assigned — that is the distinction being preserved.
    const { states, ...plain } = view;
    const nodes = buildViewNodes([item("a", "Anything")], plain, new Set());
    expect(nodes.filter((n) => n.kind === "item")).toHaveLength(1);
  });
});

describe("itemsInGroup", () => {
  const items = () => transformIssues([ISSUE, ISSUE2, ISSUE3], new Set());

  test("collects a group's items through its sub-groups", () => {
    // VIEW groups by team and sub-groups by status, so Platform's two issues
    // sit under two different sub-headers.
    const found = itemsInGroup(items(), VIEW, "Platform");
    expect(found.map((i) => i.id).sort()).toEqual(["i1", "i2"]);
  });

  test("stops at the next group", () => {
    expect(itemsInGroup(items(), VIEW, "Frontend").map((i) => i.id)).toEqual(["i3"]);
  });

  test("an unknown key selects nothing", () => {
    expect(itemsInGroup(items(), VIEW, "Nope")).toEqual([]);
  });

  // The group a user acts on is the one they can see, which may be collapsed.
  test("a collapsed group still yields its members", () => {
    const collapsed = buildViewNodes(items(), VIEW, new Set(["Platform"]));
    expect(collapsed.some((n) => n.kind === "item" && n.item.id === "i1")).toBe(false);
    expect(itemsInGroup(items(), VIEW, "Platform").map((i) => i.id).sort()).toEqual(["i1", "i2"]);
  });

  test("works on a sub-group header too", () => {
    const found = itemsInGroup(items(), VIEW, "Platform:In Progress");
    expect(found.map((i) => i.id)).toEqual(["i1"]);
  });

  test("finds members of a status-sectioned view", () => {
    const sectioned: PanelView = { ...VIEW, states: ["In Progress", "Todo"] };
    expect(itemsInGroup(items(), sectioned, "Todo").map((i) => i.id)).toEqual(["i2"]);
  });
});

describe("checkedItems", () => {
  const items = () => transformIssues([ISSUE, ISSUE2, ISSUE3], new Set());
  const nodes = () => buildViewNodes(items(), VIEW, new Set());

  test("nothing ticked is an empty set, not the whole list", () => {
    expect(checkedItems(nodes(), createViewState())).toEqual([]);
  });

  // Node order carries meaning (priority, or a stage's own status order); the
  // order rows were ticked in does not.
  test("returns node order, not tick order", () => {
    const st = createViewState();
    st.checkedIds = new Set(["i3", "i1"]);
    const order = nodes().filter((n) => n.kind === "item").map((n: any) => n.item.id);
    const got = checkedItems(nodes(), st).map((i) => i.id);
    expect(got).toEqual(order.filter((id: string) => id === "i1" || id === "i3"));
  });

  // An issue can be ticked and then filtered away by a poll or a search.
  test("ids with no visible row are dropped, not carried", () => {
    const st = createViewState();
    st.checkedIds = new Set(["i1", "does-not-exist"]);
    expect(checkedItems(nodes(), st).map((i) => i.id)).toEqual(["i1"]);
  });

  // The case the whole feature exists for: a stage tab ignores groupBy, so the
  // set has to be expressible without any group header.
  test("works on a sectioned view, which has no groupBy headers at all", () => {
    const sectioned: PanelView = { ...VIEW, states: ["In Progress"] };
    const st = createViewState();
    st.checkedIds = new Set(["i1", "i3"]);
    const n = buildViewNodes(items(), sectioned, new Set());
    expect(n.some((x) => x.kind === "group")).toBe(false);
    expect(checkedItems(n, st).map((i) => i.id).sort()).toEqual(["i1", "i3"]);
  });
});

describe("renderView checkbox column", () => {
  const items = () => transformIssues([ISSUE, ISSUE2, ISSUE3], new Set());

  // Reserving the column permanently would cost four columns of title on a
  // narrow panel for a mode most users are never in.
  test("no checkbox column until something is ticked", () => {
    const st = createViewState();
    const text = extractText(renderView(buildViewNodes(items(), VIEW, new Set()), 60, 30, st) as any);
    expect(text).not.toContain("[ ]");
    expect(text).not.toContain("[x]");
  });

  test("one tick reveals the column for every row", () => {
    const st = createViewState();
    st.checkedIds = new Set(["i1"]);
    const text = extractText(renderView(buildViewNodes(items(), VIEW, new Set()), 60, 30, st) as any);
    expect(text).toContain("[x]");
    expect(text).toContain("[ ]");
  });
});

// The preview strip: one tab per issue in the current set, at the top of the
// detail pane. It exists because a session's `+N` badge says how many issues it
// carries and nothing said which — and because the panel's detail pane could
// only ever show a row that was in the list.
describe("preview tabs", () => {
  const NODES = buildViewNodes(
    transformIssues([ISSUE, ISSUE2, ISSUE3], new Set()),
    { ...VIEW, groupBy: "none", subGroupBy: "none" },
    new Set(),
  );
  const ITEMS = transformIssues([ISSUE, ISSUE2, ISSUE3], new Set());

  const render = (tabs: PreviewTabs | undefined, rows = 30, cols = 60) =>
    extractText(renderView(NODES, cols, rows, createViewState(), { previewTabs: tabs }));

  /**
   * The strip row, identified by carrying more than one identifier — every
   * other row in the panel names at most one issue. Looking for an identifier
   * alone would match the list, which of course names all three.
   */
  const stripRowOf = (text: string): string | undefined =>
    text.split("\n").find(
      (r) => ["ENG-1234", "ENG-1235", "ENG-1236"].filter((id) => r.includes(id)).length > 1,
    );

  test("no strip without a set", () => {
    expect(stripRowOf(render(undefined))).toBeUndefined();
  });

  test("a single-item set draws no strip — there is nothing to move between", () => {
    expect(stripRowOf(render({ items: [ITEMS[0]!], activeId: ITEMS[0]!.id }))).toBeUndefined();
  });

  test("two or more draws a tab per issue", () => {
    const strip = stripRowOf(render({ items: ITEMS, activeId: ITEMS[0]!.id }));
    expect(strip).toBeDefined();
    for (const id of ["ENG-1234", "ENG-1235", "ENG-1236"]) expect(strip).toContain(id);
  });

  test("the strip sits at the top of the detail pane, above its body", () => {
    const rows = render({ items: ITEMS, activeId: "i1" }).split("\n");
    const stripIdx = rows.findIndex((r) => r === stripRowOf(rows.join("\n")));
    const bodyIdx = rows.findIndex((r) => r.includes("Status: In Progress"));
    expect(stripIdx).toBeGreaterThan(0);
    expect(bodyIdx).toBeGreaterThan(stripIdx);
  });

  test("the active tab's issue fills the pane, not the list cursor's", () => {
    // The cursor is on index 0 (ENG-1234); the strip is pinned to ENG-1235.
    const out = render({ items: ITEMS, activeId: "i2" });
    expect(out).toContain("Add logging");
    expect(out).not.toContain("Assignee: jarred");
  });

  test("with no active tab the pane follows the list cursor", () => {
    const out = render({ items: ITEMS, activeId: null });
    expect(out).toContain("Assignee: jarred");
  });

  // The bar sits under the detail and describes what the keys will do; the keys
  // act on what you are reading.
  test("the action bar follows the preview, not the cursor", () => {
    const out = render({ items: ITEMS, activeId: "i2" });
    expect(out).toContain("[o]");
  });

  // The strip lives inside the detail pane, so a panel with no detail pane has
  // nowhere to put it. This is the reachable half of the floor; the row-count
  // guard above it is a backstop that MIN_DETAIL_ROWS keeps unreachable.
  test("no detail pane means no strip", () => {
    const short = renderView(NODES, 60, 10, createViewState(), {
      previewTabs: { items: ITEMS, activeId: "i1" },
    });
    expect(stripRowOf(extractText(short))).toBeUndefined();
    expect(previewTabRow(10, createViewState(), { items: ITEMS, activeId: "i1" })).toBeNull();
  });

  // The strip is styled as the *toolbar's* window tabs are (see the tab block
  // in renderer.ts and `tabUnderlineGlyphAndAttrs`), not as the panel's own
  // queue-tab bar: a fill on the active tab only, a two-column gutter instead
  // of a separator glyph, and a heavy accent rule along the active tab's edge.
  describe("tab chrome", () => {
    const DONE = { ...ISSUE, id: "d1", identifier: "ENG-9000", stateType: "completed" as const };
    const withDone = transformIssues([ISSUE, ISSUE2, DONE], new Set());

    const strip = (tabs: PreviewTabs, rows = 30, cols = 60) => {
      const grid = renderView(NODES, cols, rows, createViewState(), { previewTabs: tabs });
      const row = previewTabRow(rows, createViewState(), tabs);
      expect(row).not.toBeNull();
      return {
        cells: grid.cells[row!]!,
        // The rule is the strip's own row, directly under the labels.
        rule: grid.cells[row! + 1]!,
        margin: grid.cells[row! + 2]!,
        separator: grid.cells[computeViewLayout(rows, false).sepRow]!,
        body: grid.cells[row! + 3]!,
        text: grid.cells[row!]!.map((c) => c.char).join(""),
      };
    };

    test("labels are padded into chips", () => {
      expect(strip({ items: ITEMS, activeId: "i1" }).text).toContain(" ENG-1234 ");
    });

    // The toolbar draws no divider: the gutter plus the rule below already
    // delimit tabs, and a glyph on top of both is a third divider saying the
    // same thing.
    test("tabs are separated by a gutter, not a glyph", () => {
      const { text } = strip({ items: ITEMS, activeId: "i1" });
      expect(text).not.toContain("│");
      expect(text).toContain("  ENG-1235");
    });

    test("only the active tab is filled; the rest sit on the terminal", () => {
      const { cells, text } = strip({ items: ITEMS, activeId: "i2" });
      const activeAt = text.indexOf("ENG-1235");
      const otherAt = text.indexOf("ENG-1234");
      expect(cells[activeAt]!.bg).toBe(theme.selected);
      expect(cells[activeAt]!.bold).toBe(true);
      expect(cells[activeAt]!.fg).toBe(tokens.accent.fg!);
      expect(cells[otherAt]!.bg).toBeFalsy();
      expect(cells[otherAt]!.bold).toBeFalsy();
      expect(cells[otherAt]!.fg).toBe(8);
    });

    // Weight signals active, exactly as the toolbar's own tab rule does.
    test("a heavy accent rule runs under the active tab, light under the rest", () => {
      const { rule, text } = strip({ items: ITEMS, activeId: "i2" });
      const activeAt = text.indexOf("ENG-1235");
      const otherAt = text.indexOf("ENG-1234");
      expect(rule[activeAt]!.char).toBe(frame.ruleHeavy);
      expect(rule[activeAt]!.fg).toBe(tokens.accent.fg!);
      expect(rule[otherAt]!.char).toBe(frame.ruleLight);
    });

    test("the rule follows the active tab as it moves", () => {
      const a = strip({ items: ITEMS, activeId: "i1" });
      const b = strip({ items: ITEMS, activeId: "i2" });
      const heavy = (r: typeof a.rule) => r.map((c) => c.char).join("").indexOf(frame.ruleHeavy);
      expect(heavy(a.rule)).toBeGreaterThanOrEqual(0);
      expect(heavy(b.rule)).toBeGreaterThan(heavy(a.rule));
    });

    // A tab sits on top of its content with the rule between the two. Above the
    // labels the same glyphs read as an overline on a heading, and the pane
    // separator — which is also the split's drag handle — is not the strip's to
    // repurpose.
    test("the pane separator is left alone; the rule is the strip's own row", () => {
      const { separator, rule } = strip({ items: ITEMS, activeId: "i1" });
      expect(separator.map((c) => c.char).join("")).not.toContain(frame.ruleHeavy);
      expect(rule.map((c) => c.char).join("")).toContain(frame.ruleHeavy);
    });

    test("a blank margin separates the bar from the issue body", () => {
      const { margin, body } = strip({ items: ITEMS, activeId: "i1" });
      expect(margin.map((c) => c.char).join("").trim()).toBe("");
      expect(body.map((c) => c.char).join("")).toContain("ENG-1234");
    });

    // The strip's tones are all spoken for, so done-ness goes in the label,
    // where it also survives a terminal that renders dim as no change at all.
    test("a finished issue is marked in the label, not by colour alone", () => {
      const { text } = strip({ items: withDone, activeId: "i1" });
      expect(text).toContain("✓ ENG-9000");
      expect(text).not.toContain("✓ ENG-1234");
    });

    test("overflow arrows sit at the strip's edges", () => {
      const many = transformIssues(
        Array.from({ length: 10 }, (_, i) => ({
          ...ISSUE, id: `w${i}`, identifier: `ENG-80${i}`, title: `Issue ${i}`,
        })),
        new Set(),
      );
      const { cells } = strip({ items: many, activeId: "w5" }, 30, 44);
      expect(cells[0]!.char).toBe("‹");
      expect(cells[43]!.char).toBe("›");
    });
  });

  describe("windowing", () => {
    const many = transformIssues(
      Array.from({ length: 12 }, (_, i) => ({
        ...ISSUE, id: `m${i}`, identifier: `ENG-90${i}`, title: `Issue ${i}`,
      })),
      new Set(),
    );

    // packChips drops what does not fit from the end, which would hide the very
    // tab the strip exists to show whenever it sat past the budget.
    test("the active tab is always in the window, even at the far end", () => {
      const { chips } = layoutPreviewTabs({ items: many, activeId: "m11" }, 40);
      expect(chips.some((c) => c.id === "m11")).toBe(true);
    });

    test("and at the near end", () => {
      const { chips } = layoutPreviewTabs({ items: many, activeId: "m0" }, 40);
      expect(chips.some((c) => c.id === "m0")).toBe(true);
    });

    test("overflow is reported on the side that has more", () => {
      const start = layoutPreviewTabs({ items: many, activeId: "m0" }, 40);
      expect(start.overflowLeft).toBe(false);
      expect(start.overflowRight).toBe(true);

      const end = layoutPreviewTabs({ items: many, activeId: "m11" }, 40);
      expect(end.overflowLeft).toBe(true);
      expect(end.overflowRight).toBe(false);
    });

    test("a set that fits reports no overflow", () => {
      const { chips, overflowLeft, overflowRight } =
        layoutPreviewTabs({ items: ITEMS, activeId: "i1" }, 60);
      expect(chips.length).toBe(3);
      expect(overflowLeft).toBe(false);
      expect(overflowRight).toBe(false);
    });

    // The bound that matters is not the grid width — it is the arrows' own
    // columns. A flat "reserve two columns" budget under-counted the left
    // arrow, which also pushes the chips one column right, so the last chip
    // could land exactly on the right arrow and paint over it. Chips are drawn
    // after arrows, so the strip then claimed there was nothing further right
    // while hiding tabs. Swept rather than spot-checked: the collision needed a
    // specific width/count/active-index combination to appear at all.
    test("no chip ever lands on an arrow's column, at any size", () => {
      for (let cols = 8; cols <= 90; cols++) {
        for (let w = 2; w <= 14; w++) {
          const items = transformIssues(
            Array.from({ length: 8 }, (_, i) => ({
              ...ISSUE, id: `s${i}`, identifier: "T".repeat(w), title: `Issue ${i}`,
            })),
            new Set(),
          );
          for (const active of items) {
            const r = layoutPreviewTabs({ items, activeId: active.id }, cols);
            const last = r.chips[r.chips.length - 1];
            if (r.overflowRight && last) {
              expect(last.x + last.width - 1).toBeLessThan(cols - 1);
            }
            if (r.overflowLeft) {
              for (const c of r.chips) expect(c.x).toBeGreaterThan(0);
            }
          }
        }
      }
    });

    // Widening outward from the active tab is the whole point; a budget change
    // that made packChips drop the tail could silently drop it.
    test("the active tab survives whenever anything is drawn, at any size", () => {
      for (let cols = 8; cols <= 90; cols++) {
        for (let n = 2; n <= 12; n++) {
          const items = transformIssues(
            Array.from({ length: n }, (_, i) => ({
              ...ISSUE, id: `a${i}`, identifier: `ENG-90${i}`, title: `Issue ${i}`,
            })),
            new Set(),
          );
          for (const active of items) {
            const { chips } = layoutPreviewTabs({ items, activeId: active.id }, cols);
            if (chips.length > 0) {
              expect(chips.some((c) => c.id === active.id)).toBe(true);
            }
          }
        }
      }
    });
  });

  describe("click routing", () => {
    test("a column on a tab resolves to that tab", () => {
      const tabs = { items: ITEMS, activeId: "i1" };
      const { chips } = layoutPreviewTabs(tabs, 60);
      const second = chips[1]!;
      expect(previewTabAtCol(tabs, 60, second.x)).toBe(ITEMS[1]!.id);
    });

    test("a column in the gap between tabs resolves to nothing", () => {
      const tabs = { items: ITEMS, activeId: "i1" };
      const { chips } = layoutPreviewTabs(tabs, 60);
      const gap = chips[0]!.x + chips[0]!.width;
      expect(previewTabAtCol(tabs, 60, gap)).toBeNull();
    });

    // Routing has to agree with the render exactly, so it asks the same layout
    // rather than re-deriving the row — the mistake that mis-routed list clicks
    // for the whole time a filter bar was open.
    test("the strip row is the detail pane's first row, filter bar or not", () => {
      const tabs = { items: ITEMS, activeId: "i1" };
      for (const filterQuery of [null, "x"]) {
        const state = { ...createViewState(), filterQuery };
        expect(previewTabRow(30, state, tabs))
          .toBe(computeViewLayout(30, filterQuery !== null).detailStart);
      }
    });

    test("no set means no row to route to", () => {
      expect(previewTabRow(30, createViewState(), undefined)).toBeNull();
      expect(previewTabRow(30, createViewState(), { items: [ITEMS[0]!], activeId: "i1" })).toBeNull();
    });
  });
});

// The pin is what makes two cursors tolerable: the newer yields the moment the
// older is deliberately moved.
describe("moveSelection", () => {
  test("clears the preview pin", () => {
    const state = createViewState();
    state.previewIssueId = "i2";
    moveSelection(state, 3);
    expect(state.previewIssueId).toBeNull();
    expect(state.selectedIndex).toBe(3);
  });

  test("resets the detail scroll — the pane is about to show a different document", () => {
    const state = createViewState();
    state.detailScrollOffset = 40;
    moveSelection(state, 1);
    expect(state.detailScrollOffset).toBe(0);
  });
});

// Which tab is lit. The cursor clause is the one that was missing: the pin is
// null until `{`/`}` is pressed, so the strip opened with nothing highlighted
// while the pane below was plainly showing one of the tabs.
describe("resolveActiveTab", () => {
  const items = transformIssues([ISSUE, ISSUE2, ISSUE3], new Set());

  test("nothing pinned lights the tab the cursor is on", () => {
    expect(resolveActiveTab(items, null, "i2")).toBe("i2");
  });

  test("a pin outranks the cursor", () => {
    expect(resolveActiveTab(items, "i3", "i1")).toBe("i3");
  });

  // A poll dropping a link, or a different group being ticked, must not leave a
  // tab lit that the strip no longer offers.
  test("an id outside the set is ignored, whichever it is", () => {
    expect(resolveActiveTab(items, "gone", "i1")).toBe("i1");
    expect(resolveActiveTab(items, null, "gone")).toBeNull();
    expect(resolveActiveTab(items, "gone", "gone")).toBeNull();
  });

  // The honest "no tab applies" case: only a tick-sourced strip can reach it,
  // since the session-sourced one is gated on the cursor being on a member.
  test("a cursor off the set lights nothing", () => {
    expect(resolveActiveTab(items, null, null)).toBeNull();
  });

  test("an empty set lights nothing", () => {
    expect(resolveActiveTab([], "i1", "i1")).toBeNull();
  });
});

// The strip's anchor is the pinned tab when there is one, else the list cursor
// — which is free to wander off the set entirely.
describe("stepPreviewIndex", () => {
  test("steps forward and back from an anchor inside the set", () => {
    expect(stepPreviewIndex(4, 1, 1)).toBe(2);
    expect(stepPreviewIndex(4, 1, -1)).toBe(0);
  });

  test("wraps at both ends", () => {
    expect(stepPreviewIndex(3, 2, 1)).toBe(0);
    expect(stepPreviewIndex(3, 0, -1)).toBe(2);
  });

  // A cursor sitting outside the set gives no anchor. One press should still
  // land somewhere sensible rather than doing nothing or picking arbitrarily.
  test("an absent anchor enters from the end the step comes from", () => {
    expect(stepPreviewIndex(4, -1, 1)).toBe(0);
    expect(stepPreviewIndex(4, -1, -1)).toBe(3);
  });

  test("a one-item set always lands on it", () => {
    expect(stepPreviewIndex(1, 0, 1)).toBe(0);
    expect(stepPreviewIndex(1, -1, -1)).toBe(0);
  });

  test("an empty set has nowhere to go", () => {
    expect(stepPreviewIndex(0, -1, 1)).toBe(-1);
  });
});
