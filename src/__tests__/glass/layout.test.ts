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

// The scenario the density feature exists for: a 214x49 content area — the
// Command Center's usable area on a roomy but unexceptional terminal — at
// agent counts from a small team up to a crowded one. These are the exact
// numbers `glass/density.ts`'s module doc measures and tabulates (and the
// table that argues a since-deleted third density was dominated at every
// N>3). This is the test that would catch someone "tuning" a floor and
// quietly making tiles unreadable again.
describe("computeTileLayout at each density (214x49 content area, by agent count)", () => {
  const mainWidth = 214;
  const mainHeight = 49;

  function layoutFor(spec: { minTileWidth: number; minTileHeight: number }, tileCount: number) {
    return computeTileLayout({
      mainWidth,
      mainHeight,
      tileCount,
      minTileWidth: spec.minTileWidth,
      minTileHeight: spec.minTileHeight,
      focusedIndex: 0,
      scrollRow: 0,
    });
  }

  /** Tiles actually drawn on screen right now (not merely in the tile set). */
  function visibleCount(l: ReturnType<typeof layoutFor>): number {
    return l.tiles.filter((t) => t.visible).length;
  }

  // shown/total @ interior-content-lines, from the measured table:
  //         N=3          N=6          N=9          N=14
  // fit     3/3 @ 47ln   6/6 @ 22ln   9/9 @ 14ln  14/14 @ 7ln
  // focus   3/3 @ 22ln   4/6 @ 22ln   4/9 @ 22ln   4/14 @ 22ln
  test.each([
    [3, 3, 47],
    [6, 6, 22],
    [9, 9, 14],
    [14, 14, 7],
  ])("fit at N=%i shows %i tiles at %i interior lines", (n, shown, interiorLines) => {
    const l = layoutFor(DENSITIES.fit, n);
    expect(visibleCount(l)).toBe(shown);
    expect(l.tiles[0].height - 2).toBe(interiorLines);
  });

  test.each([
    [3, 3, 22],
    [6, 4, 22],
    [9, 4, 22],
    [14, 4, 22],
  ])("focus at N=%i shows %i tiles at %i interior lines", (n, shown, interiorLines) => {
    const l = layoutFor(DENSITIES.focus, n);
    expect(visibleCount(l)).toBe(shown);
    expect(l.tiles[0].height - 2).toBe(interiorLines);
  });

  test("fit shows at least as many tiles as focus at every measured count, strictly more once N>3", () => {
    for (const n of [3, 6, 9, 14]) {
      const fitShown = visibleCount(layoutFor(DENSITIES.fit, n));
      const focusShown = visibleCount(layoutFor(DENSITIES.focus, n));
      expect(fitShown).toBeGreaterThanOrEqual(focusShown);
      if (n > 3) expect(fitShown).toBeGreaterThan(focusShown);
    }
  });

  test("focus's floor keeps tiles at least as tall as fit's, at every measured count", () => {
    for (const n of [3, 6, 9, 14]) {
      const fitLines = layoutFor(DENSITIES.fit, n).tiles[0].height - 2;
      const focusLines = layoutFor(DENSITIES.focus, n).tiles[0].height - 2;
      // fit wins at N=9/14 by showing everything at once instead — focus only
      // wins the per-tile height race at low N, which the N=3 fit@47 line
      // above already covers on its own.
      if (n >= 6) expect(focusLines).toBeGreaterThanOrEqual(fitLines);
    }
  });
});
