import { describe, test, expect } from "bun:test";
import { buildPaneLabel } from "../../glass/pane-label";

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
