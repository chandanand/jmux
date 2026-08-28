import { describe, test, expect } from "bun:test";
import { parseCtlArgs } from "../../cli";

describe("parseCtlArgs — cc group", () => {
  test("cc views parses as group=cc action=views", () => {
    expect(parseCtlArgs(["cc", "views"])).toEqual({
      group: "cc", action: "views", flags: {}, positional: [], repeated: {},
    });
  });

  // There are no tabs any more, so `--tab` is no longer a recognized value
  // flag — it falls through the parser's permissive "unknown flag → boolean"
  // branch, and what used to be its value spills into positional instead.
  // Kept as a regression guard: a `--tab` reintroduced by accident (e.g. a
  // stray reference surviving the phase 9 cleanup) would silently swallow
  // the next argument as a value again, which this pins against.
  test("--tab is not a recognized flag", () => {
    const parsed = parseCtlArgs(["pane", "pin", "--tab", "backend", "--target", "%7"]);
    expect(parsed.group).toBe("pane");
    expect(parsed.action).toBe("pin");
    expect(parsed.flags.tab).toBe(true);
    expect(parsed.flags.target).toBe("%7");
    expect(parsed.positional).toEqual(["backend"]);
  });
});
