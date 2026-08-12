import { describe, test, expect } from "bun:test";
import { resolveCcViews } from "../../cli/cc";
import { DEFAULT_VIEW_SEED_ID, DEFAULT_VIEW_SEED_NAME } from "../../glass/views";

describe("resolveCcViews", () => {
  test("returns the normalized view registry, not counts", () => {
    const views = [
      { id: "active", name: "Active", filter: "active" as const, groupBy: "status" as const, sortBy: "status" as const },
      { id: "backend", name: "Backend", filter: "all" as const, groupBy: "project" as const, sortBy: "name" as const },
    ];
    const result = resolveCcViews({ commandCenterViews: views });
    expect(result).toEqual(views);
    // No member/count field anywhere — deriving one here would be a second
    // reading of live tmux state the CLI has no business producing.
    for (const v of result) expect(v).not.toHaveProperty("count");
  });

  test("seeds the default view when the config has none", () => {
    const views = resolveCcViews({});
    expect(views).toHaveLength(1);
    expect(views[0]).toEqual({
      id: DEFAULT_VIEW_SEED_ID, name: DEFAULT_VIEW_SEED_NAME,
      filter: "active", groupBy: "status", sortBy: "status",
    });
  });

  test("drops a malformed entry rather than surfacing it", () => {
    const views = resolveCcViews({
      commandCenterViews: [{ id: "", name: "Nameless" } as any],
    });
    expect(views).toHaveLength(1);
    expect(views[0].id).toBe(DEFAULT_VIEW_SEED_ID);
  });
});
