import { describe, test, expect } from "bun:test";
import { computeTileLayout } from "../../glass/layout";
import { DENSITIES } from "../../glass/density";

const BASE = { minTileWidth: 80, minTileHeight: 10, focusedIndex: 0, scrollRow: 0 };

describe("computeTileLayout", () => {
  test("narrow terminal → single full-width column", () => {
    const l = computeTileLayout({ ...BASE, tileCount: 3, mainWidth: 100, mainHeight: 90 });
    expect(l.columns).toBe(1);
    expect(l.tiles.every((t) => t.width === 100)).toBe(true);
  });

  test("wide terminal → multiple columns, never below the width floor", () => {
    const l = computeTileLayout({ ...BASE, tileCount: 4, mainWidth: 250, mainHeight: 60 });
    expect(l.columns).toBe(3); // floor(250/80)=3
    expect(l.tiles.every((t) => t.width >= 80)).toBe(true);
  });

  test("columns clamp to tile count (no 3 columns for 1 tile)", () => {
    const l = computeTileLayout({ ...BASE, tileCount: 1, mainWidth: 250, mainHeight: 60 });
    expect(l.columns).toBe(1);
  });

  test("rows pack after columns fill", () => {
    const l = computeTileLayout({ ...BASE, tileCount: 5, mainWidth: 250, mainHeight: 60 });
    expect(l.columns).toBe(3);
    expect(l.rows).toBe(2); // ceil(5/3)
  });

  test("overflow scrolls and keeps the focused tile visible", () => {
    // 6 tiles, 1 column, each min height 10, screen height 25 → 2 rows visible.
    const l = computeTileLayout({
      ...BASE,
      tileCount: 6,
      mainWidth: 100,
      mainHeight: 25,
      focusedIndex: 5,
      scrollRow: 0,
    });
    expect(l.columns).toBe(1);
    const focused = l.tiles[5];
    expect(focused.visible).toBe(true); // scrolled into view
    expect(l.tiles[0].visible).toBe(false); // first row scrolled off
  });

  test("tiles fill the height when everything fits (no scroll)", () => {
    const l = computeTileLayout({ ...BASE, tileCount: 2, mainWidth: 100, mainHeight: 40 });
    expect(l.scrollRow).toBe(0);
    expect(l.tiles.every((t) => t.visible)).toBe(true);
  });
});

// The scenario the density feature exists for: a 214x50 content area — the
// Command Center's usable area on a roomy but unexceptional terminal, and
// the exact numbers `glass/density.ts`'s module doc works through. tileCount
// is 30 — comfortably more than any density's on-screen capacity (the
// largest is overview's 3x8=24) — so every test below is asserting the
// floor's capacity, not getting lucky because too few tiles existed to fill
// it. This is the test that would catch someone "tuning" a number and
// quietly making tiles unreadable again.
describe("computeTileLayout at each density (214x50 content area)", () => {
  const AREA = { mainWidth: 214, mainHeight: 50, tileCount: 30, focusedIndex: 0, scrollRow: 0 };

  test("comfortable: 2x2, ~20-line tiles — readable and typeable", () => {
    const spec = DENSITIES.comfortable;
    const l = computeTileLayout({ ...AREA, minTileWidth: spec.minTileWidth, minTileHeight: spec.minTileHeight });
    expect(l.columns).toBe(2);
    const visibleRows = l.tiles.filter((t) => t.visible && t.x === 0).length;
    expect(visibleRows).toBe(2); // floor(50/22) = 2 rows on screen
    const tile = l.tiles[0];
    expect(tile.height).toBe(25); // floor(50/2)
    expect(tile.height - 2).toBeGreaterThanOrEqual(20); // interior content lines
  });

  test("compact: 2x4, ~10-line tiles — today's pre-density behaviour, loosened", () => {
    const spec = DENSITIES.compact;
    const l = computeTileLayout({ ...AREA, minTileWidth: spec.minTileWidth, minTileHeight: spec.minTileHeight });
    expect(l.columns).toBe(2);
    const visibleRows = l.tiles.filter((t) => t.visible && t.x === 0).length;
    expect(visibleRows).toBe(4); // floor(50/12) = 4 rows on screen
    const tile = l.tiles[0];
    expect(tile.height).toBe(12); // floor(50/4)
    expect(tile.height - 2).toBe(10); // interior content lines
  });

  test("overview: 3x8, ~4-line tiles — a bird's-eye of many agents at once", () => {
    const spec = DENSITIES.overview;
    const l = computeTileLayout({ ...AREA, minTileWidth: spec.minTileWidth, minTileHeight: spec.minTileHeight });
    expect(l.columns).toBe(3);
    const visibleRows = l.tiles.filter((t) => t.visible && t.x === 0).length;
    expect(visibleRows).toBe(8); // floor(50/6) = 8 rows on screen
    const tile = l.tiles[0];
    expect(tile.height).toBe(6); // floor(50/8)
    expect(tile.height - 2).toBe(4); // interior content lines
  });

  test("a lower density never yields fewer on-screen tiles than a higher one", () => {
    const rows = (spec: { minTileWidth: number; minTileHeight: number }) => {
      const l = computeTileLayout({ ...AREA, minTileWidth: spec.minTileWidth, minTileHeight: spec.minTileHeight });
      return l.columns * l.tiles.filter((t) => t.visible && t.x === 0).length;
    };
    const comfortable = rows(DENSITIES.comfortable);
    const compact = rows(DENSITIES.compact);
    const overview = rows(DENSITIES.overview);
    expect(compact).toBeGreaterThan(comfortable);
    expect(overview).toBeGreaterThan(compact);
  });
});
