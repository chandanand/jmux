import { describe, test, expect } from "bun:test";
import { layoutStrip, renderStrip, STRIP_ROWS, type StripInput } from "../../glass/strip";
import { chipAtCol } from "../../band-layout";
import type { CommandCenterView } from "../../glass/views";

const views: CommandCenterView[] = [
  { id: "active", name: "Active", filter: "active", groupBy: "status", sortBy: "status" },
  { id: "backend", name: "Backend", filter: "all", groupBy: "project", sortBy: "name" },
];

const base: StripInput = {
  views,
  activeViewId: "active",
  dirty: false,
  droppedActive: 0,
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

describe("strip overflow", () => {
  const many: CommandCenterView[] = [
    { id: "a", name: "Alpha", filter: "all", groupBy: "status", sortBy: "status" },
    { id: "b", name: "Bravo", filter: "all", groupBy: "status", sortBy: "status" },
    { id: "c", name: "Charlie", filter: "all", groupBy: "status", sortBy: "status" },
    { id: "d", name: "Delta", filter: "all", groupBy: "status", sortBy: "status" },
    { id: "e", name: "Echo", filter: "all", groupBy: "status", sortBy: "status" },
    { id: "f", name: "Foxtrot", filter: "all", groupBy: "status", sortBy: "status" },
  ];

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
