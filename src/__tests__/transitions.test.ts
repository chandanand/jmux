import { describe, test, expect } from "bun:test";
import {
  detectMrTransitions,
  transitionTarget,
  type MrSnapshot,
} from "../transitions";
import { REPO_SETTING_DEFAULTS } from "../repo-settings";

const mr = (id: string, status: MrSnapshot["status"]): MrSnapshot => ({ id, status });

describe("detectMrTransitions", () => {
  test("an MR appearing for the first time counts as opened", () => {
    expect(detectMrTransitions([], [mr("1", "open")])).toEqual({ opened: true, merged: false });
  });

  test("a draft appearing also counts as opened", () => {
    expect(detectMrTransitions([], [mr("1", "draft")])).toEqual({ opened: true, merged: false });
  });

  test("an unchanged MR fires nothing", () => {
    expect(detectMrTransitions([mr("1", "open")], [mr("1", "open")]))
      .toEqual({ opened: false, merged: false });
  });

  test("open -> merged fires merged", () => {
    expect(detectMrTransitions([mr("1", "open")], [mr("1", "merged")]))
      .toEqual({ opened: false, merged: true });
  });

  test("an MR that is already merged on first sight does not fire merged", () => {
    // Otherwise attaching jmux to an old session would replay history and
    // rewrite tracker state for work that shipped weeks ago.
    expect(detectMrTransitions([], [mr("1", "merged")]))
      .toEqual({ opened: false, merged: false });
  });

  test("a still-merged MR does not re-fire on every poll", () => {
    expect(detectMrTransitions([mr("1", "merged")], [mr("1", "merged")]))
      .toEqual({ opened: false, merged: false });
  });

  test("a closed MR is neither opened nor merged", () => {
    expect(detectMrTransitions([mr("1", "open")], [mr("1", "closed")]))
      .toEqual({ opened: false, merged: false });
  });

  test("merged wins when one MR opens and another merges in the same poll", () => {
    expect(detectMrTransitions([mr("1", "open")], [mr("1", "merged"), mr("2", "open")]))
      .toEqual({ opened: true, merged: true });
  });
});

describe("transitionTarget", () => {
  test("returns null when the event has no configured state", () => {
    expect(transitionTarget("session-start", REPO_SETTING_DEFAULTS)).toBeNull();
    expect(transitionTarget("mr-open", REPO_SETTING_DEFAULTS)).toBeNull();
    expect(transitionTarget("mr-merged", REPO_SETTING_DEFAULTS)).toBeNull();
  });

  test("maps each event onto its configured state", () => {
    const s = {
      ...REPO_SETTING_DEFAULTS,
      onSessionStartState: "In Progress",
      onMrOpenState: "In Review",
      onMrMergedState: "QA",
    };
    expect(transitionTarget("session-start", s)).toBe("In Progress");
    expect(transitionTarget("mr-open", s)).toBe("In Review");
    expect(transitionTarget("mr-merged", s)).toBe("QA");
  });

  test("an explicitly null event stays off even when siblings are set", () => {
    const s = { ...REPO_SETTING_DEFAULTS, onMrOpenState: "In Review", onMrMergedState: null };
    expect(transitionTarget("mr-merged", s)).toBeNull();
  });
});
