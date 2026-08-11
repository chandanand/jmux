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
  test("returns id + name for sessions whose hidden value is exactly \"1\"", () => {
    const lines = ["$1:alpha:1", "$2:beta:", "$3:gamma:1"];
    expect(parseHiddenList(lines)).toEqual([
      { id: "$1", name: "alpha" },
      { id: "$3", name: "gamma" },
    ]);
  });

  test("\"0\" and \"off\" read as not hidden, not as the legacy any-non-empty-value grammar", () => {
    // @jmux-grid-hidden is new with this design and has no legacy values to
    // grandfather in, unlike @jmux-pinned — so a value someone reached for to
    // mean false must not invert into true.
    const lines = ["$1:alpha:0", "$2:beta:off", "$3:gamma:1"];
    expect(parseHiddenList(lines)).toEqual([
      { id: "$3", name: "gamma" },
    ]);
  });

  test("ignores blank lines and malformed entries with no second colon", () => {
    expect(parseHiddenList(["", "$1:alpha:1", "no-colons-here", ""])).toEqual([
      { id: "$1", name: "alpha" },
    ]);
  });
});
