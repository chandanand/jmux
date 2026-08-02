import { describe, test, expect } from "bun:test";
import { InfoPanel, type InfoTab } from "../info-panel";

describe("InfoPanel", () => {
  test("starts with diff tab only when no adapters configured", () => {
    const panel = new InfoPanel({ viewIds: [], viewLabels: new Map() });
    expect(panel.tabs).toEqual(["diff"]);
    expect(panel.activeTab).toBe("diff");
  });

  test("shows MR tab when code host configured", () => {
    const panel = new InfoPanel({ viewIds: ["my-mrs"], viewLabels: new Map([["my-mrs", "My MRs"]]) });
    expect(panel.tabs).toEqual(["diff", "my-mrs"]);
  });

  test("shows Issues tab when issue tracker configured", () => {
    const panel = new InfoPanel({ viewIds: ["my-issues"], viewLabels: new Map([["my-issues", "Issues"]]) });
    expect(panel.tabs).toEqual(["diff", "my-issues"]);
  });

  test("shows all tabs when both adapters configured", () => {
    const panel = new InfoPanel({
      viewIds: ["my-issues", "my-mrs", "review"],
      viewLabels: new Map([["my-issues", "Issues"], ["my-mrs", "My MRs"], ["review", "Review"]]),
    });
    expect(panel.tabs).toEqual(["diff", "my-issues", "my-mrs", "review"]);
  });

  test("nextTab cycles forward", () => {
    const panel = new InfoPanel({
      viewIds: ["my-mrs", "my-issues"],
      viewLabels: new Map([["my-mrs", "My MRs"], ["my-issues", "Issues"]]),
    });
    expect(panel.activeTab).toBe("diff");
    panel.nextTab();
    expect(panel.activeTab).toBe("my-mrs");
    panel.nextTab();
    expect(panel.activeTab).toBe("my-issues");
    panel.nextTab();
    expect(panel.activeTab).toBe("diff");
  });

  test("prevTab cycles backward", () => {
    const panel = new InfoPanel({
      viewIds: ["my-mrs", "my-issues"],
      viewLabels: new Map([["my-mrs", "My MRs"], ["my-issues", "Issues"]]),
    });
    panel.prevTab();
    expect(panel.activeTab).toBe("my-issues");
    panel.prevTab();
    expect(panel.activeTab).toBe("my-mrs");
  });

  test("nextTab is no-op with single tab", () => {
    const panel = new InfoPanel({ viewIds: [], viewLabels: new Map() });
    panel.nextTab();
    expect(panel.activeTab).toBe("diff");
  });

  test("setActiveTab works for valid tab", () => {
    const panel = new InfoPanel({
      viewIds: ["my-mrs", "my-issues"],
      viewLabels: new Map([["my-mrs", "My MRs"], ["my-issues", "Issues"]]),
    });
    panel.setActiveTab("my-mrs");
    expect(panel.activeTab).toBe("my-mrs");
  });

  test("setActiveTab ignores invalid tab", () => {
    const panel = new InfoPanel({ viewIds: [], viewLabels: new Map() });
    panel.setActiveTab("my-mrs");
    expect(panel.activeTab).toBe("diff");
  });

  test("getTabBarGrid renders tab labels", () => {
    const panel = new InfoPanel({
      viewIds: ["my-mrs"],
      viewLabels: new Map([["my-mrs", "My MRs"]]),
    });
    const grid = panel.getTabBarGrid(40);
    expect(grid.cols).toBe(40);
    expect(grid.rows).toBe(1);
    const text = grid.cells[0].map((c) => c.char).join("");
    expect(text).toContain("Diff");
    expect(text).toContain("My MRs");
  });

  test("hasMultipleTabs", () => {
    const single = new InfoPanel({ viewIds: [], viewLabels: new Map() });
    expect(single.hasMultipleTabs).toBe(false);

    const multi = new InfoPanel({ viewIds: ["my-mrs"], viewLabels: new Map([["my-mrs", "My MRs"]]) });
    expect(multi.hasMultipleTabs).toBe(true);
  });

  test("updateConfig changes available tabs", () => {
    const panel = new InfoPanel({ viewIds: [], viewLabels: new Map() });
    expect(panel.tabs).toEqual(["diff"]);
    panel.updateConfig({
      viewIds: ["my-mrs", "my-issues"],
      viewLabels: new Map([["my-mrs", "My MRs"], ["my-issues", "Issues"]]),
    });
    expect(panel.tabs).toEqual(["diff", "my-mrs", "my-issues"]);
  });

  test("updateConfig resets active tab if current tab removed", () => {
    const panel = new InfoPanel({
      viewIds: ["my-mrs", "my-issues"],
      viewLabels: new Map([["my-mrs", "My MRs"], ["my-issues", "Issues"]]),
    });
    panel.setActiveTab("my-mrs");
    panel.updateConfig({
      viewIds: ["my-issues"],
      viewLabels: new Map([["my-issues", "Issues"]]),
    });
    expect(panel.activeTab).toBe("diff");
  });
});

describe("InfoPanel tab counts", () => {
  // An attention model only works if you can see where attention is needed
  // without visiting each tab.
  function panel(counts?: Map<string, number>): InfoPanel {
    const p = new InfoPanel({ viewIds: [], viewLabels: new Map() });
    p.updateConfig({
      viewIds: ["urgent", "todo"],
      viewLabels: new Map([["urgent", "Urgent"], ["todo", "To do"]]),
      viewCounts: counts,
    });
    return p;
  }

  test("a non-zero count renders beside the label", () => {
    expect(panel(new Map([["urgent", 3]])).tabLabel("urgent")).toBe(" Urgent 3 ");
  });

  test("a zero count is omitted rather than shown as 0", () => {
    expect(panel(new Map([["urgent", 0]])).tabLabel("urgent")).toBe(" Urgent ");
  });

  test("tabs with no count entry render plain", () => {
    expect(panel(new Map([["urgent", 3]])).tabLabel("todo")).toBe(" To do ");
  });

  test("omitting counts entirely keeps the old rendering", () => {
    expect(panel().tabLabel("urgent")).toBe(" Urgent ");
  });

  test("the diff tab never takes a count", () => {
    expect(panel(new Map([["diff", 9]])).tabLabel("diff")).toBe(" Diff ");
  });
});

describe("InfoPanel — the diff badge", () => {
  const fresh = () => new InfoPanel({ viewIds: [], viewLabels: new Map() });

  test("no badge renders the plain label", () => {
    expect(fresh().tabLabel("diff")).toBe(" Diff ");
  });

  test("a badge renders beside the label", () => {
    const p = fresh();
    p.setDiffBadge("+13 −4");
    expect(p.tabLabel("diff")).toBe(" Diff +13 −4 ");
  });

  test("clearing returns to the plain label", () => {
    const p = fresh();
    p.setDiffBadge("+13 −4");
    p.setDiffBadge(null);
    expect(p.tabLabel("diff")).toBe(" Diff ");
  });

  // The badge is live state from hunk's daemon; a config reload rebuilding the
  // view tabs has nothing to do with it and must not drop it.
  test("survives a config reload", () => {
    const p = fresh();
    p.setDiffBadge("+13 −4 ●2");
    p.updateConfig({ viewIds: ["urgent"], viewLabels: new Map([["urgent", "Urgent"]]) });
    expect(p.tabLabel("diff")).toBe(" Diff +13 −4 ●2 ");
  });

  // The strip is hit-tested from the same layout it is painted from, so a
  // widened label has to move the tabs that follow it.
  test("a badge widens the tab and shifts the ones after it", () => {
    const p = new InfoPanel({ viewIds: ["urgent"], viewLabels: new Map([["urgent", "Urgent"]]) });
    const before = p.getTabRanges();
    p.setDiffBadge("+13 −4");
    const after = p.getTabRanges();
    expect(after[0].endCol).toBeGreaterThan(before[0].endCol);
    expect(after[1].startCol).toBeGreaterThan(before[1].startCol);
  });
});
