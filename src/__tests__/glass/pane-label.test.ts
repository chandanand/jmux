import { describe, test, expect } from "bun:test";
import { buildPaneLabel, buildTileLabel, paneIdentity } from "../../glass/pane-label";

describe("buildPaneLabel", () => {
  test("prefers a non-empty pane title", () => {
    expect(
      buildPaneLabel({
        sessionName: "api",
        paneTitle: "claude",
        paneCurrentCommand: "node",
        paneCurrentPath: "/repo/api",
      }),
    ).toBe("api › claude");
  });

  test("falls back to command · cwd-basename when title is empty", () => {
    expect(
      buildPaneLabel({
        sessionName: "api",
        paneTitle: "",
        paneCurrentCommand: "node",
        paneCurrentPath: "/repo/api/server",
      }),
    ).toBe("api › node · server");
  });

  test("handles a missing path basename gracefully", () => {
    expect(
      buildPaneLabel({
        sessionName: "web",
        paneTitle: "",
        paneCurrentCommand: "bun",
        paneCurrentPath: "/",
      }),
    ).toBe("web › bun");
  });

  test("uses whatever display name it is handed", () => {
    expect(buildPaneLabel({
      sessionName: "Fix stale cache headers",
      paneTitle: "claude",
      paneCurrentCommand: "claude",
      paneCurrentPath: "/tmp",
    })).toBe("Fix stale cache headers › claude");
  });
});

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

  test("is the same string buildPaneLabel puts after the › separator", () => {
    const input = { paneTitle: "", paneCurrentCommand: "node", paneCurrentPath: "/repo/api/server" };
    expect(buildPaneLabel({ sessionName: "api", ...input })).toBe(`api › ${paneIdentity(input)}`);
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
