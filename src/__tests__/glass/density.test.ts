import { describe, test, expect } from "bun:test";
import { DENSITIES, DEFAULT_DENSITY, cycleDensity, normalizeDensity, type Density } from "../../glass/density";

describe("DENSITIES", () => {
  // The module doc computes these against a 214x50 content area; pin the
  // floors themselves here so a future "tuning" edit that quietly makes a
  // mode unreadable fails a test, not just a screenshot.
  test("comfortable is the default and the most spacious floor", () => {
    expect(DEFAULT_DENSITY).toBe("comfortable");
    expect(DENSITIES.comfortable).toEqual({ minTileWidth: 90, minTileHeight: 22, label: "Comfortable" });
  });

  test("compact matches the grid's pre-density floor, loosened slightly", () => {
    expect(DENSITIES.compact).toEqual({ minTileWidth: 80, minTileHeight: 12, label: "Compact" });
  });

  test("overview is the smallest floor — a bird's-eye of many tiles", () => {
    expect(DENSITIES.overview).toEqual({ minTileWidth: 60, minTileHeight: 6, label: "Overview" });
  });

  test("floors strictly shrink from comfortable to compact to overview", () => {
    expect(DENSITIES.comfortable.minTileWidth).toBeGreaterThan(DENSITIES.compact.minTileWidth);
    expect(DENSITIES.compact.minTileWidth).toBeGreaterThan(DENSITIES.overview.minTileWidth);
    expect(DENSITIES.comfortable.minTileHeight).toBeGreaterThan(DENSITIES.compact.minTileHeight);
    expect(DENSITIES.compact.minTileHeight).toBeGreaterThan(DENSITIES.overview.minTileHeight);
  });
});

describe("cycleDensity", () => {
  test("steps comfortable -> compact -> overview -> comfortable", () => {
    expect(cycleDensity("comfortable")).toBe("compact");
    expect(cycleDensity("compact")).toBe("overview");
    expect(cycleDensity("overview")).toBe("comfortable");
  });

  test("is a closed cycle over every density with no dead end", () => {
    const all: Density[] = ["comfortable", "compact", "overview"];
    for (const d of all) {
      let cur = d;
      const seen = new Set<Density>();
      for (let i = 0; i < all.length; i++) {
        seen.add(cur);
        cur = cycleDensity(cur);
      }
      expect(seen.size).toBe(all.length); // visited every density exactly once
      expect(cur).toBe(d); // and landed back where it started
    }
  });
});

describe("normalizeDensity", () => {
  test("passes through each known density", () => {
    expect(normalizeDensity("comfortable")).toBe("comfortable");
    expect(normalizeDensity("compact")).toBe("compact");
    expect(normalizeDensity("overview")).toBe("overview");
  });

  test("rejects rubbish and falls back to the default", () => {
    expect(normalizeDensity(undefined)).toBe(DEFAULT_DENSITY);
    expect(normalizeDensity(null)).toBe(DEFAULT_DENSITY);
    expect(normalizeDensity("")).toBe(DEFAULT_DENSITY);
    expect(normalizeDensity("cozy")).toBe(DEFAULT_DENSITY);
    expect(normalizeDensity(42)).toBe(DEFAULT_DENSITY);
    expect(normalizeDensity({ minTileWidth: 90 })).toBe(DEFAULT_DENSITY);
    expect(normalizeDensity(["comfortable"])).toBe(DEFAULT_DENSITY);
  });
});
