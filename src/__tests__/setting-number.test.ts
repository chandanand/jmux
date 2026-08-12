import { describe, test, expect } from "bun:test";
import {
  formatNumber, editNumber, parseNumber, stepNumber, rangeHint,
  numberSetting, type NumberSpec,
} from "../setting-number";

const WIDTH: NumberSpec = { min: 10, max: 60 };
const PANEL: NumberSpec = { min: 20, max: 120, low: { label: "auto", store: undefined } };
const IDLE: NumberSpec = { min: 1, max: 365, unit: "days", low: { label: "never", store: null } };
const CAP: NumberSpec = {
  min: 1, max: 99,
  low: { label: "never", store: null },
  high: { label: "all", store: "all" },
};

describe("formatNumber", () => {
  test("a plain count renders as the number", () => {
    expect(formatNumber(WIDTH, 26)).toBe("26");
  });

  test("a unit rides along with the number", () => {
    expect(formatNumber(IDLE, 3)).toBe("3 days");
  });

  test("the unit agrees with a count of one", () => {
    expect(formatNumber(IDLE, 1)).toBe("1 day");
  });

  test("a sentinel renders as its label, with no unit", () => {
    expect(formatNumber(PANEL, undefined)).toBe("auto");
    expect(formatNumber(IDLE, null)).toBe("never");
    expect(formatNumber(CAP, "all")).toBe("all");
  });

  test("an unreadable stored value falls back to the low sentinel", () => {
    expect(formatNumber(PANEL, "nonsense")).toBe("auto");
  });

  test("with no low sentinel, an unreadable value falls back to the minimum", () => {
    expect(formatNumber(WIDTH, "nonsense")).toBe("10");
  });
});

describe("editNumber", () => {
  // The whole reason this function exists. Seeding the buffer with the display
  // form let a user type a digit onto "auto" and commit "auto55", which parses
  // to nothing — so the panel width could not be set from its own prompt.
  test("a sentinel opens the prompt on an empty buffer, never on its label", () => {
    expect(editNumber(PANEL, undefined)).toBe("");
    expect(editNumber(IDLE, null)).toBe("");
    expect(editNumber(CAP, "all")).toBe("");
  });

  test("a number opens on the bare number, with no unit to type over", () => {
    expect(editNumber(IDLE, 3)).toBe("3");
    expect(editNumber(WIDTH, 26)).toBe("26");
  });
});

describe("parseNumber", () => {
  test("a number in range is taken as itself", () => {
    expect(parseNumber(WIDTH, "26")).toBe(26);
  });

  test("out of range clamps rather than being discarded in silence", () => {
    expect(parseNumber(WIDTH, "9")).toBe(10);
    expect(parseNumber(WIDTH, "600")).toBe(60);
  });

  test("a sentinel label is accepted, case and space insensitively", () => {
    expect(parseNumber(PANEL, "auto")).toBe(undefined);
    expect(parseNumber(PANEL, "  AUTO ")).toBe(undefined);
    expect(parseNumber(CAP, "All")).toBe("all");
  });

  test("empty means the low sentinel where there is one", () => {
    expect(parseNumber(IDLE, "")).toBe(null);
  });

  test("empty means no change where there is no low sentinel", () => {
    expect(parseNumber(WIDTH, "", 26)).toBe(26);
  });

  test("a trailing unit is tolerated", () => {
    expect(parseNumber(IDLE, "5 days")).toBe(5);
  });

  test("below the minimum lands on the low sentinel, not the minimum", () => {
    // 0 days means "off" — clamping it up to 1 would switch a setting ON that
    // the user was turning off.
    expect(parseNumber(IDLE, "0")).toBe(null);
  });
});

describe("stepNumber", () => {
  test("steps one rung in each direction", () => {
    expect(stepNumber(WIDTH, 26, 1)).toBe(27);
    expect(stepNumber(WIDTH, 26, -1)).toBe(25);
  });

  test("clamps at both ends rather than wrapping", () => {
    // Unlike stepGhostCap, whose two sentinels are semantically adjacent. A
    // bare range is not a loop, and 60 -> 10 under a held key is a surprise.
    expect(stepNumber(WIDTH, 60, 1)).toBe(60);
    expect(stepNumber(WIDTH, 10, -1)).toBe(10);
  });

  test("stepping down off the minimum lands on the low sentinel", () => {
    expect(stepNumber(PANEL, 20, -1)).toBe(undefined);
  });

  test("stepping up off the maximum lands on the high sentinel", () => {
    expect(stepNumber(CAP, 99, 1)).toBe("all");
  });

  test("stepping up from the low sentinel enters at the minimum", () => {
    expect(stepNumber(PANEL, undefined, 1)).toBe(20);
    expect(stepNumber(CAP, null, 1)).toBe(1);
  });

  test("stepping down from the high sentinel enters at the maximum", () => {
    expect(stepNumber(CAP, "all", -1)).toBe(99);
  });

  test("the sentinels do not run into each other", () => {
    expect(stepNumber(CAP, null, -1)).toBe(null);
    expect(stepNumber(CAP, "all", 1)).toBe("all");
  });

  test("a stored value above the ladder enters at the maximum rather than snapping to off", () => {
    expect(stepNumber(WIDTH, 500, -1)).toBe(59);
  });

  test("honours a step larger than one", () => {
    expect(stepNumber({ min: 0, max: 100, step: 5 }, 25, 1)).toBe(30);
  });
});

describe("round trip", () => {
  const cases: Array<[string, NumberSpec, unknown[]]> = [
    ["width", WIDTH, [10, 26, 60]],
    ["panel", PANEL, [undefined, 20, 75, 120]],
    ["idle", IDLE, [null, 1, 30, 365]],
    ["cap", CAP, [null, 1, 50, 99, "all"]],
  ];

  for (const [name, spec, values] of cases) {
    test(`${name}: what a row shows for editing parses back to what it stored`, () => {
      for (const stored of values) {
        expect(parseNumber(spec, editNumber(spec, stored), stored)).toBe(stored as never);
      }
    });

    test(`${name}: stepping never produces a value the row cannot render`, () => {
      let cur: unknown = values[0];
      for (let i = 0; i < 500; i++) {
        cur = stepNumber(spec, cur, 1);
        expect(formatNumber(spec, cur)).not.toBe("");
        expect(parseNumber(spec, editNumber(spec, cur), cur)).toBe(cur as never);
      }
    });
  }

  // The exact sequence that shipped broken: the panel width row displayed
  // "auto", seeded its prompt with "auto", and a typed digit produced "auto55".
  test("a digit typed onto a sentinel-valued row cannot produce a mixed buffer", () => {
    const buffer = editNumber(PANEL, undefined) + "55";
    expect(buffer).toBe("55");
    expect(parseNumber(PANEL, buffer)).toBe(55);
  });
});

describe("rangeHint", () => {
  test("a bare range reads as its bounds", () => {
    expect(rangeHint(WIDTH)).toBe("(10–60)");
  });

  test("sentinels are named alongside the bounds", () => {
    expect(rangeHint(PANEL)).toBe("(auto, 20–120)");
    expect(rangeHint(CAP)).toBe("(never, 1–99, all)");
  });

  test("a unit is named once", () => {
    expect(rangeHint(IDLE)).toBe("(never, 1–365 days)");
  });
});

describe("numberSetting", () => {
  const make = (spec: NumberSpec, initial: unknown) => {
    let stored = initial;
    const def = numberSetting({
      id: "x", label: "X", spec,
      read: () => stored,
      write: (v) => { stored = v; },
    });
    return { def, get: () => stored };
  };

  test("builds a number row whose four forms all come from the one spec", () => {
    const { def } = make(PANEL, undefined);
    expect(def.type).toBe("number");
    expect(def.getValue()).toBe("auto");
    expect(def.getEditValue!()).toBe("");
    expect(def.rangeHint!()).toBe("(auto, 20–120)");
  });

  test("onStep writes the stepped value", () => {
    const { def, get } = make(WIDTH, 26);
    def.onStep!(1);
    expect(get()).toBe(27);
    def.onStep!(-1);
    expect(get()).toBe(26);
  });

  test("onTextCommit writes the parsed value", () => {
    const { def, get } = make(PANEL, undefined);
    def.onTextCommit!("55");
    expect(get()).toBe(55);
    def.onTextCommit!("auto");
    expect(get()).toBe(undefined);
  });

  test("a commit that parses to nothing leaves the stored value alone", () => {
    const { def, get } = make(WIDTH, 26);
    def.onTextCommit!("nonsense");
    expect(get()).toBe(26);
  });
});
