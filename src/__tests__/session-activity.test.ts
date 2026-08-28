import { describe, expect, test } from "bun:test";
import { latestWindowActivity, WINDOW_ACTIVITY_FORMAT } from "../session-activity";
import { US } from "../tmux-fields";

describe("latestWindowActivity", () => {
  test("rolls several windows up to the newest output in their session", () => {
    expect(latestWindowActivity([
      ["$1", "100"].join(US),
      ["$2", "250"].join(US),
      ["$1", "300"].join(US),
      ["$1", "200"].join(US),
    ])).toEqual(new Map([
      ["$1", 300],
      ["$2", 250],
    ]));
  });

  test("drops malformed rows instead of inventing activity", () => {
    expect(latestWindowActivity([
      "",
      "$1",
      ["", "100"].join(US),
      ["$2", "not-a-time"].join(US),
      ["$3", "0"].join(US),
      ["$4", "-1"].join(US),
    ])).toEqual(new Map());
  });

  test("queries the session id and window activity fields", () => {
    expect(WINDOW_ACTIVITY_FORMAT).toContain("#{session_id}");
    expect(WINDOW_ACTIVITY_FORMAT).toContain("#{window_activity}");
    expect(WINDOW_ACTIVITY_FORMAT).not.toContain("#{session_activity}");
  });
});
