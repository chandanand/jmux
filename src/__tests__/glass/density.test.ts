import { describe, test, expect } from "bun:test";
import { DENSITIES, DEFAULT_DENSITY, cycleDensity, normalizeDensity, type Density } from "../../glass/density";

describe("DENSITIES", () => {
  // The module doc derives these against a 214x49 content area, measured at
  // real agent counts — pin the floors themselves here so a future "tuning"
  // edit that quietly makes a mode unreadable (or reintroduces the dominated
  // third mode the doc's table argues against) fails a test, not just a
  // screenshot.
  test("fit is the default — everything visible, sized to whatever fits", () => {
    expect(DEFAULT_DENSITY).toBe("fit");
    expect(DENSITIES.fit).toEqual({ minTileWidth: 60, minTileHeight: 6, label: "Fit" });
  });

  test("focus is the four-big-tiles floor for reading/typing into one agent", () => {
    expect(DENSITIES.focus).toEqual({ minTileWidth: 100, minTileHeight: 22, label: "Focus" });
  });

  test("focus's floor is strictly larger than fit's on both axes", () => {
    expect(DENSITIES.focus.minTileWidth).toBeGreaterThan(DENSITIES.fit.minTileWidth);
    expect(DENSITIES.focus.minTileHeight).toBeGreaterThan(DENSITIES.fit.minTileHeight);
  });

  test("there are exactly two densities — the whole point of the collapse from three", () => {
    expect(Object.keys(DENSITIES).sort()).toEqual(["fit", "focus"]);
  });
});

describe("cycleDensity", () => {
  // Two values makes this a toggle, not a ring: applying it twice is the
  // identity, unlike the three-mode cycle it replaced.
  test("toggles fit <-> focus", () => {
    expect(cycleDensity("fit")).toBe("focus");
    expect(cycleDensity("focus")).toBe("fit");
  });

  test("is its own inverse — two presses return to the start, for both densities", () => {
    const all: Density[] = ["fit", "focus"];
    for (const d of all) {
      expect(cycleDensity(cycleDensity(d))).toBe(d);
    }
  });
});

describe("normalizeDensity", () => {
  test("passes through each known density", () => {
    expect(normalizeDensity("fit")).toBe("fit");
    expect(normalizeDensity("focus")).toBe("focus");
  });

  test("rejects rubbish and falls back to the default", () => {
    expect(normalizeDensity(undefined)).toBe(DEFAULT_DENSITY);
    expect(normalizeDensity(null)).toBe(DEFAULT_DENSITY);
    expect(normalizeDensity("")).toBe(DEFAULT_DENSITY);
    expect(normalizeDensity("cozy")).toBe(DEFAULT_DENSITY);
    expect(normalizeDensity(42)).toBe(DEFAULT_DENSITY);
    expect(normalizeDensity({ minTileWidth: 90 })).toBe(DEFAULT_DENSITY);
    expect(normalizeDensity(["fit"])).toBe(DEFAULT_DENSITY);
  });

  // The value a config written by the three-mode version of this feature
  // could still carry on disk — must land on the default, not throw or
  // silently pick an arbitrary survivor.
  test("rejects the deleted third density (\"compact\") and the old names", () => {
    expect(normalizeDensity("compact")).toBe(DEFAULT_DENSITY);
    expect(normalizeDensity("comfortable")).toBe(DEFAULT_DENSITY);
    expect(normalizeDensity("overview")).toBe(DEFAULT_DENSITY);
  });
});
