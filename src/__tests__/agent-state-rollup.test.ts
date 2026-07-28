import { describe, test, expect } from "bun:test";
import { AGENT_STATE_RANK, outranks } from "../agent-state-rollup";

describe("AGENT_STATE_RANK", () => {
  test("waiting is the most urgent, complete the least", () => {
    expect(AGENT_STATE_RANK.waiting).toBeGreaterThan(AGENT_STATE_RANK.running);
    expect(AGENT_STATE_RANK.running).toBeGreaterThan(AGENT_STATE_RANK.complete);
  });
});

describe("outranks", () => {
  test("anything beats nothing", () => {
    expect(outranks({ state: "complete", since: 1 }, null)).toBe(true);
  });

  test("a more urgent state wins regardless of age", () => {
    expect(outranks({ state: "waiting", since: 999 }, { state: "running", since: 1 })).toBe(true);
    expect(outranks({ state: "running", since: 999 }, { state: "complete", since: 1 })).toBe(true);
  });

  test("a less urgent state never wins", () => {
    expect(outranks({ state: "complete", since: 1 }, { state: "waiting", since: 999 })).toBe(false);
    expect(outranks({ state: "running", since: 1 }, { state: "waiting", since: 999 })).toBe(false);
  });

  test("ties go to the earliest since, so the timer tracks the oldest agent", () => {
    expect(outranks({ state: "running", since: 100 }, { state: "running", since: 500 })).toBe(true);
    expect(outranks({ state: "running", since: 500 }, { state: "running", since: 100 })).toBe(false);
  });

  test("an equal since does not displace the incumbent", () => {
    // Keeps the rollup stable: identical rows must not flap on iteration order.
    expect(outranks({ state: "running", since: 100 }, { state: "running", since: 100 })).toBe(false);
  });

  test("a known since beats an unknown one on a tie", () => {
    expect(outranks({ state: "running", since: 100 }, { state: "running", since: null })).toBe(true);
    expect(outranks({ state: "running", since: null }, { state: "running", since: 100 })).toBe(false);
  });

  test("two unknown sinces do not flap", () => {
    expect(outranks({ state: "running", since: null }, { state: "running", since: null })).toBe(false);
  });
});
