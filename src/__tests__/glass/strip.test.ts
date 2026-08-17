import { describe, test, expect } from "bun:test";
import { layoutStrip, layoutStripActions, renderStrip, STRIP_ROWS, NO_AXES, type StripInput } from "../../glass/strip";
import { chipAtCol } from "../../band-layout";
import type { CommandCenterView } from "../../glass/views";
import { DENSITIES } from "../../glass/density";

const views: CommandCenterView[] = [
  { id: "active", name: "Active", filter: "active", groupBy: "status", sortBy: "status" },
  { id: "backend", name: "Backend", filter: "all", groupBy: "project", sortBy: "name" },
];

const base: StripInput = {
  views,
  activeViewId: "active",
  dirty: false,
  droppedActive: 0,
  axes: NO_AXES,
  width: 80,
};

describe("layoutStrip / chipAtCol", () => {
  test("chips are laid out left to right and hit-test by x", () => {
    const chips = layoutStrip(base);
    expect(chips.length).toBe(2);
    expect(chips[0].id).toBe("active");
    expect(chips[0].x).toBe(0);
    // first chip covers its own columns, second starts after it
    expect(chipAtCol(chips, chips[0].x)).toBe("active");
    expect(chipAtCol(chips, chips[1].x)).toBe("backend");
    expect(chipAtCol(chips, 9999)).toBeNull();
  });
});

describe("renderStrip", () => {
  test("renders one row containing both view names", () => {
    const grid = renderStrip(base);
    expect(grid.rows).toBe(STRIP_ROWS);
    const row = grid.cells[0].map((c) => c.char).join("");
    expect(row).toContain("Active");
    expect(row).toContain("Backend");
  });

  test("the active view's chip carries the dirty marker when dirty, not otherwise", () => {
    const clean = renderStrip(base);
    const cleanRow = clean.cells[0].map((c) => c.char).join("");
    expect(cleanRow).not.toContain("·");

    const dirty = renderStrip({ ...base, dirty: true });
    const dirtyRow = dirty.cells[0].map((c) => c.char).join("");
    expect(dirtyRow).toContain("Active ·");
  });

  test("the dirty marker only decorates the active chip", () => {
    // Backend is not active, so even with dirty:true its chip carries no marker.
    const grid = renderStrip({ ...base, activeViewId: "backend", dirty: true });
    const row = grid.cells[0].map((c) => c.char).join("");
    expect(row).toContain("Backend ·");
    expect(row).not.toContain("Active ·");
  });

  test("renderStrip uses precomputed chips when provided", () => {
    const chips = layoutStrip(base);
    const grid = renderStrip(base, chips);
    const row = grid.cells[0].map((c) => c.char).join("");
    expect(row).toContain("Active");
    expect(row).toContain("Backend");
  });
});

describe("dropped-tile overflow", () => {
  test("reports the count the client cap refused, distinctly from chip overflow", () => {
    const grid = renderStrip({ ...base, droppedActive: 3 });
    const row = grid.cells[0].map((c) => c.char).join("");
    expect(row).toContain("+3 not shown");
  });

  test("silent (no text at all) when nothing was dropped", () => {
    const grid = renderStrip({ ...base, droppedActive: 0 });
    const row = grid.cells[0].map((c) => c.char).join("");
    expect(row).not.toContain("not shown");
  });
});

const many: CommandCenterView[] = [
  { id: "a", name: "Alpha", filter: "all", groupBy: "status", sortBy: "status" },
  { id: "b", name: "Bravo", filter: "all", groupBy: "status", sortBy: "status" },
  { id: "c", name: "Charlie", filter: "all", groupBy: "status", sortBy: "status" },
  { id: "d", name: "Delta", filter: "all", groupBy: "status", sortBy: "status" },
  { id: "e", name: "Echo", filter: "all", groupBy: "status", sortBy: "status" },
  { id: "f", name: "Foxtrot", filter: "all", groupBy: "status", sortBy: "status" },
];

describe("strip overflow", () => {
  test("drops chips that don't fit within the width budget", () => {
    const chips = layoutStrip({ ...base, views: many, activeViewId: "a", width: 24 });
    expect(chips.length).toBeLessThan(many.length);
    // Only chips that wholly fit are kept; the first one always fits at x=0.
    expect(chips[0].id).toBe("a");
  });

  test("renders a +N indicator counting the hidden views", () => {
    const input = { ...base, views: many, activeViewId: "a", width: 24 };
    const chips = layoutStrip(input);
    const hidden = many.length - chips.length;
    expect(hidden).toBeGreaterThan(0);
    const grid = renderStrip(input, chips);
    const row = grid.cells[0].map((c) => c.char).join("");
    expect(row).toContain(`+${hidden}`);
  });

  test("no indicator when all views fit", () => {
    const grid = renderStrip(base);
    const row = grid.cells[0].map((c) => c.char).join("");
    expect(row).not.toContain("+");
  });

  test("the hidden-chip indicator and the dropped-tile count can coexist", () => {
    const input = { ...base, views: many, activeViewId: "a", width: 40, droppedActive: 2 };
    const grid = renderStrip(input);
    const row = grid.cells[0].map((c) => c.char).join("");
    expect(row).toContain("+2 not shown");
    // At least one view chip must have been dropped for this width.
    const chips = layoutStrip(input);
    expect(chips.length).toBeLessThan(many.length);
  });
});

describe("density label", () => {
  test("empty label (base fixture) reserves no width and renders nothing", () => {
    const row = renderStrip(base).cells[0].map((c) => c.char).join("");
    expect(row).not.toContain(DENSITIES.fit.label);
    expect(row).not.toContain(DENSITIES.focus.label);
  });

  test("renders flush against the right edge when nothing was dropped", () => {
    const grid = renderStrip({ ...base, axes: { ...NO_AXES, density: DENSITIES.focus.label } });
    const row = grid.cells[0].map((c) => c.char).join("");
    expect(row).toContain("Focus");
    expect(row.trimEnd().endsWith("Focus")).toBe(true);
  });

  test("sits immediately left of the dropped-tile count when both are present, which stays rightmost", () => {
    const grid = renderStrip({ ...base, axes: { ...NO_AXES, density: DENSITIES.fit.label }, droppedActive: 2 });
    const row = grid.cells[0].map((c) => c.char).join("");
    expect(row).toContain("Fit");
    expect(row).toContain("+2 not shown");
    expect(row.indexOf("Fit")).toBeLessThan(row.indexOf("+2 not shown"));
    expect(row.trimEnd().endsWith("+2 not shown")).toBe(true);
  });

  test("reserves its own width ahead of chip packing, distinct from the hidden-chip reserve", () => {
    const withLabel = layoutStrip({ ...base, views: many, activeViewId: "a", width: 40, axes: { ...NO_AXES, density: DENSITIES.focus.label } });
    const withoutLabel = layoutStrip({ ...base, views: many, activeViewId: "a", width: 40, axes: NO_AXES });
    // The same width packs no more chips once room is reserved for the label.
    expect(withLabel.length).toBeLessThanOrEqual(withoutLabel.length);
  });

  test("keeps the active chip on screen by sliding the window, not dropping it as the tail", () => {
    // The exact scenario the finding names: "First, Active" on a strip too
    // narrow for both. Plain prefix packing keeps "First" (index 0) and
    // drops "Active" — the one chip that must never disappear, since it also
    // carries the dirty marker. Mirrors layoutPreviewTabs' widen-from-active
    // window instead.
    const twoViews: CommandCenterView[] = [
      { id: "first", name: "First", filter: "all", groupBy: "status", sortBy: "status" },
      { id: "active", name: "Active", filter: "active", groupBy: "status", sortBy: "status" },
    ];
    const input: StripInput = { ...base, views: twoViews, activeViewId: "active", width: 14 };
    const chips = layoutStrip(input);
    expect(chips.map((c) => c.id)).toEqual(["active"]);

    const row = renderStrip(input, chips).cells[0].map((c) => c.char).join("");
    expect(row).toContain("Active");
    expect(row).not.toContain("First");
    expect(row).toContain("+1");
  });

  test("dirty marker on the active chip survives the same narrow-strip window", () => {
    const twoViews: CommandCenterView[] = [
      { id: "first", name: "First", filter: "all", groupBy: "status", sortBy: "status" },
      { id: "active", name: "Active", filter: "active", groupBy: "status", sortBy: "status" },
    ];
    const input: StripInput = { ...base, views: twoViews, activeViewId: "active", width: 17, dirty: true };
    const row = renderStrip(input).cells[0].map((c) => c.char).join("");
    expect(row).toContain("Active ·");
  });

  test("a window that must drop from both sides keeps the middle active chip", () => {
    const input: StripInput = { ...base, views: many, activeViewId: "d", width: 24 };
    const chips = layoutStrip(input);
    expect(chips.some((c) => c.id === "d")).toBe(true);
  });

  test("does not push the active view chip out of a narrow strip", () => {
    // Narrow enough that the second chip ("Backend") is dropped, but wide
    // enough that the first ("Active") — the active chip — still fits
    // alongside the reserved density label. Regression guard for the label
    // eating into the chip budget aggressively enough to drop the active
    // chip too.
    const input = { ...base, width: 24, axes: { ...NO_AXES, density: DENSITIES.focus.label } };
    const grid = renderStrip(input);
    const row = grid.cells[0].map((c) => c.char).join("");
    expect(row).toContain("Active");
    expect(row).toContain("Focus");
    expect(row).not.toContain("Backend");
    const chips = layoutStrip(input);
    expect(chips.map((c) => c.id)).toEqual(["active"]);
  });
});

describe("the active chip is never dropped", () => {
  const long = { id: "a", name: "A Very Long View Name Indeed", filter: "active", groupBy: "status", sortBy: "status" } as any;
  const second = { id: "b", name: "Second", filter: "all", groupBy: "none", sortBy: "name" } as any;
  const base = { views: [long, second], activeViewId: "a", dirty: false, droppedActive: 0, axes: { ...NO_AXES, density: "Fit" } } as any;

  // Windowing selects the active chip correctly, but packChips then placed
  // nothing when it alone exceeded the budget — so the strip rendered empty and
  // the one thing it exists to say went missing. A truncated name beats none.
  test("a chip wider than the budget is clamped, not dropped", () => {
    for (const width of [40, 24, 16]) {
      const chips = layoutStrip({ ...base, width });
      expect(chips.length).toBeGreaterThan(0);
      expect(chips[0]!.id).toBe("a");
      expect(chips[0]!.width).toBeLessThanOrEqual(width);
    }
  });

  test("a clamped chip renders as truncated text that fits its cells", () => {
    const input = { ...base, width: 24 };
    const chips = layoutStrip(input);
    const grid = renderStrip(input, chips);
    const row = grid.cells[0]!.map((c) => c.char).join("").trimEnd();
    expect(row.length).toBeGreaterThan(0);
    expect(row).toContain("\u2026");
    expect(grid.cells[0]!.length).toBe(24);
  });
});

describe("truncation keeps the dirty marker", () => {
  // The marker sits at the tail, so a naive truncation removed exactly the
  // thing the always-visible strip is obliged to carry: which view, and
  // whether the live axes have been narrowed away from it.
  const long = { id: "a", name: "A Very Long View Name Indeed", filter: "active", groupBy: "status", sortBy: "status" } as any;
  const base = { views: [long], activeViewId: "a", dirty: true, droppedActive: 0, axes: { ...NO_AXES, density: "Fit" } } as any;

  test("the dirty marker survives at every width, truncated or not", () => {
    for (const width of [80, 40, 24, 18]) {
      const input = { ...base, width };
      const row = renderStrip(input, layoutStrip(input)).cells[0]!.map((c) => c.char).join("");
      expect(row).toContain("\u00b7");
    }
  });

  test("the name is what gets cut, and only once it has to be", () => {
    const wide = renderStrip({ ...base, width: 40 }, layoutStrip({ ...base, width: 40 }))
      .cells[0]!.map((c) => c.char).join("");
    expect(wide).not.toContain("\u2026"); // fits whole — nothing to cut

    const narrow = renderStrip({ ...base, width: 24 }, layoutStrip({ ...base, width: 24 }))
      .cells[0]!.map((c) => c.char).join("");
    expect(narrow).toContain("\u2026");
    expect(narrow).toContain("\u00b7"); // cut the name, kept the marker
  });

  test("a clean view is not given a marker it did not earn", () => {
    const input = { ...base, dirty: false, width: 24 };
    const row = renderStrip(input, layoutStrip(input)).cells[0]!.map((c) => c.char).join("");
    expect(row).not.toContain("\u00b7");
  });
});

describe("axis chips (right cluster)", () => {
  const axes = { group: "Proj", sort: "Act", filter: "All", density: "Fit" };
  const withAxes: StripInput = { ...base, axes };

  test("renders group, sort, filter and density chips in that order, each glyph + label", () => {
    const row = renderStrip(withAxes).cells[0].map((c) => c.char).join("");
    for (const chip of ["\u229e Proj", "\u21c5 Act", "\u2207 All", "\u25a4 Fit"]) expect(row).toContain(chip);
    expect(row.indexOf("\u229e")).toBeLessThan(row.indexOf("\u21c5"));
    expect(row.indexOf("\u21c5")).toBeLessThan(row.indexOf("\u2207"));
    expect(row.indexOf("\u2207")).toBeLessThan(row.indexOf("\u25a4"));
    expect(row.trimEnd().endsWith("Fit")).toBe(true);
  });

  test("the dropped-tile count stays rightmost, the cluster immediately left of it", () => {
    const row = renderStrip({ ...withAxes, droppedActive: 2 }).cells[0].map((c) => c.char).join("");
    expect(row.trimEnd().endsWith("+2 not shown")).toBe(true);
    expect(row.indexOf("\u25a4 Fit")).toBeLessThan(row.indexOf("+2 not shown"));
  });

  test("each chip is hit-testable by column with its axis id", () => {
    const actions = layoutStripActions(withAxes);
    expect(actions.map((a) => a.id)).toEqual(["group", "sort", "filter", "density"]);
    const row = renderStrip(withAxes, layoutStrip(withAxes), actions).cells[0].map((c) => c.char).join("");
    for (const a of actions) {
      // Every column of the chip resolves to it, and the chip covers its own text.
      expect(chipAtCol(actions, a.x)).toBe(a.id);
      expect(chipAtCol(actions, a.x + a.width - 1)).toBe(a.id);
    }
    const sort = actions.find((a) => a.id === "sort")!;
    expect(row.slice(sort.x, sort.x + sort.width)).toBe("\u21c5 Act");
    // View chips and action chips never overlap.
    const views = layoutStrip(withAxes);
    for (const v of views) for (const a of actions) expect(v.x + v.width <= a.x || a.x + a.width <= v.x).toBe(true);
  });

  test("an empty label omits that chip and reserves nothing for it", () => {
    const actions = layoutStripActions({ ...base, axes: { ...NO_AXES, sort: "Act" } });
    expect(actions.map((a) => a.id)).toEqual(["sort"]);
    expect(layoutStripActions(base)).toEqual([]);
  });

  test("on a narrow strip the words go and the glyphs stay, so every axis is still clickable", () => {
    const input: StripInput = { ...withAxes, width: 30 };
    const actions = layoutStripActions(input);
    expect(actions.map((a) => a.id)).toEqual(["group", "sort", "filter", "density"]);
    const row = renderStrip(input, layoutStrip(input), actions).cells[0].map((c) => c.char).join("");
    expect(row).not.toContain("Proj");
    expect(row).toContain("\u229e");
    expect(row).toContain("\u25a4");
    // The active view chip is still on screen — the cluster yields words before the strip loses its identity.
    expect(row).toContain("Active");
  });

  test("view chips yield to the cluster before the cluster yields anything", () => {
    const withCluster = layoutStrip({ ...base, views: many, activeViewId: "a", width: 60, axes });
    const without = layoutStrip({ ...base, views: many, activeViewId: "a", width: 60 });
    expect(withCluster.length).toBeLessThan(without.length);
    expect(withCluster.some((c) => c.id === "a")).toBe(true);
  });
});
