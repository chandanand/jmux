import { describe, test, expect } from "bun:test";
import {
  normalizeViews, normalizeAxes, resolveActiveViewId, axesOf, axesDiffer,
  slugifyViewName, validateViewName, addView, renameView,
  switchView, deleteView, reloadViews,
  DEFAULT_VIEW_SEED_ID, DEFAULT_VIEW_SEED_NAME,
  type CommandCenterView, type CommandCenterAxes,
} from "../../glass/views";

const seed: CommandCenterView = {
  id: DEFAULT_VIEW_SEED_ID, name: DEFAULT_VIEW_SEED_NAME,
  filter: "active", groupBy: "status", sortBy: "status",
};

describe("normalizeViews", () => {
  test("empty/undefined synthesizes the seed default at index 0", () => {
    for (const raw of [undefined, null, [], "bad", {}]) {
      expect(normalizeViews(raw)).toEqual([seed]);
    }
  });

  test("keeps valid entries in order", () => {
    const raw: CommandCenterView[] = [
      seed,
      { id: "review", name: "Review", filter: "all", groupBy: "project", sortBy: "name" },
    ];
    expect(normalizeViews(raw)).toEqual(raw);
  });

  test("drops malformed entries (missing id/name, wrong types)", () => {
    const raw = [
      seed,
      { id: "", name: "Empty", filter: "all", groupBy: "none", sortBy: "name" },
      { name: "NoId", filter: "all", groupBy: "none", sortBy: "name" },
      { id: "x" },
      "nope",
      { id: "review", name: "Review", filter: "all", groupBy: "project", sortBy: "name" },
    ];
    expect(normalizeViews(raw)).toEqual([
      seed,
      { id: "review", name: "Review", filter: "all", groupBy: "project", sortBy: "name" },
    ]);
  });

  test("dedups ids, first occurrence wins", () => {
    const raw = [
      seed,
      { id: "review", name: "Review", filter: "all", groupBy: "project", sortBy: "name" },
      { id: "review", name: "Review Dupe", filter: "all", groupBy: "none", sortBy: "activity" },
    ];
    expect(normalizeViews(raw)).toEqual([
      seed,
      { id: "review", name: "Review", filter: "all", groupBy: "project", sortBy: "name" },
    ]);
  });

  test("clamps an illegal axis to the seed's value", () => {
    const raw = [
      { id: "weird", name: "Weird", filter: "bogus", groupBy: "project", sortBy: 42 },
    ];
    expect(normalizeViews(raw)).toEqual([
      { id: "weird", name: "Weird", filter: seed.filter, groupBy: "project", sortBy: seed.sortBy },
    ]);
  });

  test("if all entries are dropped, falls back to the seed default", () => {
    expect(normalizeViews([{ id: "" }, "x"])).toEqual([seed]);
  });
});

describe("normalizeAxes", () => {
  const fallback: CommandCenterAxes = { filter: "all", groupBy: "project", sortBy: "name" };

  test("keeps a fully legal axes struct", () => {
    const raw: CommandCenterAxes = { filter: "attention", groupBy: "stage", sortBy: "activity" };
    expect(normalizeAxes(raw, fallback)).toEqual(raw);
  });

  test("falls back per-field to the given fallback, not the seed", () => {
    expect(normalizeAxes({ filter: "bogus" }, fallback)).toEqual({
      filter: "all", groupBy: "project", sortBy: "name",
    });
  });

  test("undefined/malformed input falls back entirely", () => {
    expect(normalizeAxes(undefined, fallback)).toEqual(fallback);
    expect(normalizeAxes("nope", fallback)).toEqual(fallback);
  });
});

describe("resolveActiveViewId", () => {
  const views: CommandCenterView[] = [
    seed,
    { id: "review", name: "Review", filter: "all", groupBy: "project", sortBy: "name" },
  ];
  test("known id resolves to itself", () => {
    expect(resolveActiveViewId("review", views)).toBe("review");
  });
  test("unknown id resolves to the first view", () => {
    expect(resolveActiveViewId("ghost", views)).toBe("active");
  });
  test("empty / null / undefined resolves to the first view", () => {
    expect(resolveActiveViewId("", views)).toBe("active");
    expect(resolveActiveViewId(null, views)).toBe("active");
    expect(resolveActiveViewId(undefined, views)).toBe("active");
  });
});

describe("axesOf / axesDiffer", () => {
  test("axesOf projects just the three axes", () => {
    expect(axesOf(seed)).toEqual({ filter: "active", groupBy: "status", sortBy: "status" });
  });
  test("axesDiffer is false for identical axes, true on any single field", () => {
    const a: CommandCenterAxes = { filter: "all", groupBy: "none", sortBy: "name" };
    expect(axesDiffer(a, { ...a })).toBe(false);
    expect(axesDiffer(a, { ...a, filter: "active" })).toBe(true);
    expect(axesDiffer(a, { ...a, groupBy: "project" })).toBe(true);
    expect(axesDiffer(a, { ...a, sortBy: "status" })).toBe(true);
  });
});

describe("slugifyViewName", () => {
  test("lowercases and dashes non-alphanumerics", () => {
    expect(slugifyViewName("Code Review!", [])).toBe("code-review");
  });
  test("dedups against existing ids", () => {
    expect(slugifyViewName("Review", ["review"])).toBe("review-2");
    expect(slugifyViewName("Review", ["review", "review-2"])).toBe("review-3");
  });
  test("falls back to 'view' when empty after slugify", () => {
    expect(slugifyViewName("!!!", [])).toBe("view");
    expect(slugifyViewName("!!!", ["view"])).toBe("view-2");
  });
});

describe("validateViewName", () => {
  const views: CommandCenterView[] = [
    seed,
    { id: "review", name: "Review", filter: "all", groupBy: "project", sortBy: "name" },
  ];
  test("trims and accepts a fresh name", () => {
    expect(validateViewName("  Focus  ", views)).toEqual({ ok: true, name: "Focus" });
  });
  test("rejects empty/whitespace", () => {
    expect(validateViewName("   ", views)).toEqual({ ok: false, error: "View name cannot be empty" });
  });
  test("rejects > 24 chars", () => {
    const long = "x".repeat(25);
    expect(validateViewName(long, views)).toEqual({ ok: false, error: "View name too long (max 24)" });
  });
  test("rejects case-insensitive duplicates", () => {
    expect(validateViewName("review", views)).toEqual({
      ok: false, error: 'A view named "review" already exists',
    });
  });
  test("allows renaming a view to its own current name (excludeId)", () => {
    expect(validateViewName("Review", views, { excludeId: "review" })).toEqual({
      ok: true, name: "Review",
    });
  });
});

describe("addView", () => {
  test("appends a validated view with a slug id, carrying the given axes", () => {
    const views: CommandCenterView[] = [seed];
    const axes: CommandCenterAxes = { filter: "all", groupBy: "none", sortBy: "name" };
    const r = addView(views, "Code Review", axes);
    expect(r).toEqual({ ok: true, views: [
      seed,
      { id: "code-review", name: "Code Review", filter: "all", groupBy: "none", sortBy: "name" },
    ]});
  });
  test("propagates validation errors", () => {
    expect(addView([seed], "  ", { filter: "all", groupBy: "none", sortBy: "name" })).toEqual({
      ok: false, error: "View name cannot be empty",
    });
  });
});

describe("renameView", () => {
  const views: CommandCenterView[] = [
    seed,
    { id: "review", name: "Review", filter: "all", groupBy: "project", sortBy: "name" },
  ];
  test("changes only the name, keeps id and axes", () => {
    expect(renameView(views, "review", "Focus")).toEqual({ ok: true, views: [
      seed,
      { id: "review", name: "Focus", filter: "all", groupBy: "project", sortBy: "name" },
    ]});
  });
  test("unknown id errors", () => {
    expect(renameView(views, "ghost", "X")).toEqual({ ok: false, error: "Unknown view" });
  });
});

// ─── The three transitions ────────────────────────────────────────────────

describe("switchView (transition 1: dirty axes are discarded)", () => {
  const views: CommandCenterView[] = [
    seed,
    { id: "review", name: "Review", filter: "all", groupBy: "project", sortBy: "name" },
  ];

  test("switching adopts the incoming view's axes, discarding whatever was live", () => {
    const dirtyAxes: CommandCenterAxes = { filter: "attention", groupBy: "stage", sortBy: "activity" };
    // Sanity: the dirty axes really do differ from what "review" will produce.
    expect(axesDiffer(dirtyAxes, axesOf(views[1]))).toBe(true);
    const result = switchView(views, "active", "review");
    expect(result).toEqual({ views, activeViewId: "review", axes: axesOf(views[1]) });
  });

  test("unknown id is a no-op, echoing the current active view", () => {
    const result = switchView(views, "active", "ghost");
    expect(result).toEqual({ views, activeViewId: "active", axes: axesOf(seed) });
  });
});

describe("deleteView (transition 2)", () => {
  const views: CommandCenterView[] = [
    seed,
    { id: "a", name: "A", filter: "all", groupBy: "none", sortBy: "name" },
    { id: "b", name: "B", filter: "attention", groupBy: "project", sortBy: "activity" },
  ];

  test("deleting the active view at a middle index adopts the previous view's axes", () => {
    const result = deleteView(views, "a", "a");
    expect(result.views).toEqual([seed, views[2]]);
    expect(result.activeViewId).toBe(DEFAULT_VIEW_SEED_ID);
    expect(result.axes).toEqual(axesOf(seed));
  });

  test("deleting the active view at index 0 falls to the new first view", () => {
    const result = deleteView(views, "active", "active");
    expect(result.views).toEqual([views[1], views[2]]);
    expect(result.activeViewId).toBe("a");
    expect(result.axes).toEqual(axesOf(views[1]));
  });

  test("deleting a non-active view leaves the active selection untouched", () => {
    const result = deleteView(views, "b", "a");
    expect(result.views).toEqual([seed, views[2]]);
    expect(result.activeViewId).toBe("b");
    expect(result.axes).toEqual(axesOf(views[2]));
  });

  test("deleting the last remaining view re-seeds the default and adopts it", () => {
    const result = deleteView([seed], "active", "active");
    expect(result.views).toEqual([seed]);
    expect(result.activeViewId).toBe(DEFAULT_VIEW_SEED_ID);
    expect(result.axes).toEqual(axesOf(seed));
  });

  test("unknown id is a no-op, echoing the current active view", () => {
    const result = deleteView(views, "a", "ghost");
    expect(result).toEqual({ views, activeViewId: "a", axes: axesOf(views[1]) });
  });
});

describe("reloadViews (transition 3: hot reload)", () => {
  const dirtyAxes: CommandCenterAxes = { filter: "attention", groupBy: "stage", sortBy: "activity" };

  test("a surviving active id stays active and dirty axes stay dirty", () => {
    const raw = [
      seed,
      { id: "review", name: "Review Renamed", filter: "all", groupBy: "project", sortBy: "name" },
    ];
    const result = reloadViews(raw, "review", dirtyAxes);
    expect(result.activeViewId).toBe("review");
    expect(result.axes).toEqual(dirtyAxes); // untouched, even though it differs from the view
    expect(result.views).toEqual(normalizeViews(raw));
  });

  test("a vanished active id falls to index 0 and adopts its axes", () => {
    const raw = [
      { id: "only", name: "Only", filter: "all", groupBy: "none", sortBy: "name" },
    ];
    const result = reloadViews(raw, "review", dirtyAxes);
    expect(result.activeViewId).toBe("only");
    expect(result.axes).toEqual({ filter: "all", groupBy: "none", sortBy: "name" });
  });

  test("a malformed raw registry reloads to the seed and adopts its axes", () => {
    const result = reloadViews("garbage", "review", dirtyAxes);
    expect(result.views).toEqual([seed]);
    expect(result.activeViewId).toBe(DEFAULT_VIEW_SEED_ID);
    expect(result.axes).toEqual(axesOf(seed));
  });
});
