import { describe, test, expect } from "bun:test";
import { buildGridHiddenCommands, parseHiddenList } from "../../cli/session";

describe("buildGridHiddenCommands", () => {
  test("hide sets the session-scoped marker", () => {
    expect(buildGridHiddenCommands("hide", "$3")).toEqual([
      { args: ["set-option", "-t", "$3", "@jmux-grid-hidden", "1"], required: true },
    ]);
  });

  test("unhide clears it — and only it, never @jmux-pinned", () => {
    expect(buildGridHiddenCommands("unhide", "$3")).toEqual([
      { args: ["set-option", "-t", "$3", "-u", "@jmux-grid-hidden"], required: true },
    ]);
  });
});

describe("parseHiddenList", () => {
  test("returns id + name for sessions with any non-empty hidden value", () => {
    const lines = ["$1:alpha:1", "$2:beta:", "$3:gamma:1"];
    expect(parseHiddenList(lines)).toEqual([
      { id: "$1", name: "alpha" },
      { id: "$3", name: "gamma" },
    ]);
  });

  test("ignores blank lines and malformed entries with no second colon", () => {
    expect(parseHiddenList(["", "$1:alpha:1", "no-colons-here", ""])).toEqual([
      { id: "$1", name: "alpha" },
    ]);
  });
});
