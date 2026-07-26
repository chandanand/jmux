import { describe, test, expect } from "bun:test";
import {
  transformIssues,
  transformMrs,
  buildViewNodes,
  renderView,
  createViewState,
  pickSessionIndicator,
  formatAge,
  type RenderableItem,
  computeViewLayout,
  splitRatioForSepRow,
  DEFAULT_PANEL_SPLIT_RATIO,
} from "../panel-view-renderer";
import type { PanelView } from "../panel-view";
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

describe("buildViewNodes with explicit groups", () => {
  const view = {
    id: "urgent", label: "Urgent", source: "issues" as const,
    filter: { scope: "assigned" as const },
    groupBy: "none" as const, subGroupBy: "none" as const,
    sortBy: "priority" as const, sortOrder: "asc" as const,
    sessionLinkedFirst: false,
    groups: [
      { label: "QA Failed", states: ["QA Failed"] },
      { label: "Blockers", states: ["Release Blockers"] },
    ],
  };

  const item = (id: string, status: string, priority = 3): RenderableItem => ({
    id, type: "issue", primary: id, title: id, status, meta: "",
    group: "", subGroup: status, sessionLinked: false, priority,
    updatedAt: 0, raw: {} as any,
  });

  test("emits configured groups in configured order, not alphabetically", () => {
    // "Blockers" sorts before "QA Failed" alphabetically; config order wins.
    const nodes = buildViewNodes(
      [item("a", "Release Blockers"), item("b", "QA Failed")], view, new Set(),
    );
    const labels = nodes.filter((n) => n.kind === "group").map((n: any) => n.label);
    expect(labels).toEqual(["QA Failed", "Blockers"]);
  });

  test("items land under the group that claims their status", () => {
    const nodes = buildViewNodes(
      [item("a", "Release Blockers"), item("b", "QA Failed")], view, new Set(),
    );
    const order = nodes.map((n) => n.kind === "group" ? `#${(n as any).label}` : (n as any).item.id);
    expect(order).toEqual(["#QA Failed", "b", "#Blockers", "a"]);
  });

  test("statuses no group claims are excluded entirely", () => {
    const nodes = buildViewNodes([item("z", "In Progress")], view, new Set());
    expect(nodes.filter((n) => n.kind === "item")).toHaveLength(0);
  });

  test("an empty group still shows its header with a zero count", () => {
    // A queue that is empty is information, not noise — it says "nothing is
    // blocked" rather than silently disappearing.
    const nodes = buildViewNodes([item("b", "QA Failed")], view, new Set());
    const blockers = nodes.find((n) => n.kind === "group" && (n as any).label === "Blockers");
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
