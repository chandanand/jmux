import { describe, test, expect } from "bun:test";
import { displaySessionName, MANUAL_SIGNATURE } from "../session-title/display";

describe("displaySessionName", () => {
  test("prefers the title when there is one", () => {
    expect(displaySessionName({ name: "tra-123", title: "Fix stale cache headers" }))
      .toBe("Fix stale cache headers");
  });

  test("falls back to the real name when the title is absent", () => {
    expect(displaySessionName({ name: "tra-123" })).toBe("tra-123");
  });

  test("falls back when the title is empty or whitespace", () => {
    expect(displaySessionName({ name: "tra-123", title: "" })).toBe("tra-123");
    expect(displaySessionName({ name: "tra-123", title: "   " })).toBe("tra-123");
  });

  test("trims a title that has surrounding whitespace", () => {
    expect(displaySessionName({ name: "tra-123", title: "  Fix cache  " }))
      .toBe("Fix cache");
  });

  test("the manual sentinel is not a plausible hash", () => {
    expect(MANUAL_SIGNATURE).toBe("manual");
  });
});
