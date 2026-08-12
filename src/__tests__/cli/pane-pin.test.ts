import { describe, test, expect } from "bun:test";
import {
  buildPinCommands, parsePinnedList,
} from "../../cli/pane";

describe("buildPinCommands", () => {
  test("pin writes the force-on marker '1' — no tab id, there are no tabs", () => {
    expect(buildPinCommands("pin", "%7")).toEqual([
      { args: ["set-option", "-p", "-t", "%7", "@jmux-pinned", "1"], required: true },
    ]);
  });

  test("unpin unsets the per-pane option with -u", () => {
    expect(buildPinCommands("unpin", "%7")).toEqual([
      { args: ["set-option", "-p", "-t", "%7", "-u", "@jmux-pinned"], required: true },
    ]);
  });
});

describe("parsePinnedList", () => {
  test("returns pane ids with any non-empty value — legacy tab ids read as force-on too", () => {
    const lines = ["%1:1", "%2:", "%3:backend"];
    expect(parsePinnedList(lines)).toEqual([{ id: "%1" }, { id: "%3" }]);
  });
  test("ignores blank lines", () => {
    expect(parsePinnedList(["", "%9:1", ""])).toEqual([{ id: "%9" }]);
  });
});
