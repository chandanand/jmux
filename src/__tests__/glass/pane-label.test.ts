import { describe, test, expect } from "bun:test";
import { buildTileLabel, paneIdentity } from "../../glass/pane-label";

describe("paneIdentity", () => {
  test("prefers a non-empty pane title", () => {
    expect(paneIdentity({ paneTitle: "claude", paneCurrentCommand: "node", paneCurrentPath: "/repo/api" }))
      .toBe("claude");
  });

  test("falls back to command · cwd-basename when title is empty", () => {
    expect(paneIdentity({ paneTitle: "", paneCurrentCommand: "node", paneCurrentPath: "/repo/api/server" }))
      .toBe("node · server");
  });

  test("handles a missing path basename gracefully", () => {
    expect(paneIdentity({ paneTitle: "", paneCurrentCommand: "bun", paneCurrentPath: "/" })).toBe("bun");
  });

  test("is exactly the suffix buildTileLabel appends", () => {
    // The two must not drift: the suffix is the only thing on screen naming
    // which of a session's panes a cycled tile is showing.
    const input = { paneTitle: "", paneCurrentCommand: "node", paneCurrentPath: "/repo/api/server" };
    expect(buildTileLabel("api", input, true)).toBe(`api · ${paneIdentity(input)}`);
  });
});

describe("buildTileLabel", () => {
  const pane = { paneTitle: "claude", paneCurrentCommand: "claude", paneCurrentPath: "/repo" };

  test("no suffix when the displayed pane is the session's natural choice", () => {
    expect(buildTileLabel("api TRA-412", pane, false)).toBe("api TRA-412");
  });

  test("appends the pane's own identity when it is not the natural choice", () => {
    // The force-on-pin / live-cycle-override case: nothing else on screen
    // says which pane a tile is showing once it has moved off the election's
    // own answer.
    expect(buildTileLabel("api TRA-412", pane, true)).toBe("api TRA-412 · claude");
  });

  test("no pane data at all falls back to the identity alone, never a bare suffix", () => {
    expect(buildTileLabel("api TRA-412", null, true)).toBe("api TRA-412");
  });

  test("suffix uses the same command · cwd-basename fallback as buildPaneLabel", () => {
    const noTitle = { paneTitle: "", paneCurrentCommand: "node", paneCurrentPath: "/repo/api/server" };
    expect(buildTileLabel("api", noTitle, true)).toBe("api · node · server");
  });
});
