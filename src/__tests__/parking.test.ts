import { describe, test, expect } from "bun:test";
import {
  isParked,
  clearStaleOverride,
  DEFAULT_PARKING,
  type ParkingConfig,
  captureBaseline,
  detectSignals,
  parkingSetupWarning,
  type SessionParkInput,
} from "../parking";

const DAY = 24 * 60 * 60 * 1000;

function cfg(over: Partial<ParkingConfig> = {}): ParkingConfig {
  return { ...DEFAULT_PARKING, ...over };
}

function input(over: Partial<SessionParkInput> = {}): SessionParkInput {
  return {
    name: "s",
    stage: null,
    manual: null,
    attention: false,
    signals: new Set(),
    lastActivity: 0,
    ...over,
  };
}

describe("isParked defaults", () => {
  test("the parked stage parks by default; nothing else does", () => {
    // A tab only declares stage=parked deliberately, so acting on it is the
    // stated intent — but no other stage is ever hidden without being asked.
    expect(isParked(input({ stage: "parked" }), cfg(), 0)).toBe(true);
    for (const stage of ["idea", "active", "done"] as const) {
      expect(isParked(input({ stage }), cfg(), 0)).toBe(false);
    }
  });

  test("clearing parkStages disables parking entirely", () => {
    expect(isParked(input({ stage: "parked" }), cfg({ parkStages: [] }), 0)).toBe(false);
  });
});

describe("isParked derived from stage", () => {
  const c = cfg({ parkStages: ["parked"] });

  test("a session whose issue is in a parked stage parks", () => {
    expect(isParked(input({ stage: "parked" }), c, 0)).toBe(true);
  });

  test("other stages stay visible", () => {
    expect(isParked(input({ stage: "active" }), c, 0)).toBe(false);
    expect(isParked(input({ stage: "done" }), c, 0)).toBe(false);
  });

  test("a session with no linked issue is unaffected by stage rules", () => {
    expect(isParked(input({ stage: null }), c, 0)).toBe(false);
  });
});

describe("isParked manual override", () => {
  const c = cfg({ parkStages: ["parked"] });

  test("manual park parks a session with no issue at all", () => {
    expect(isParked(input({ manual: "park" }), c, 0)).toBe(true);
  });

  test("manual unpark beats a derived park", () => {
    // "Linear says QA but I'm still working on it" — the escape hatch.
    expect(isParked(input({ stage: "parked", manual: "unpark" }), c, 0)).toBe(false);
  });
});

describe("isParked auto-unpark", () => {
  // Parking is only safe if it reverses itself. Every configured signal must
  // beat both a derived park and an explicit manual park.
  const c = cfg({ parkStages: ["parked"], unparkOn: ["state-regression", "mr-activity"] });

  test("a configured signal unparks a derived park", () => {
    expect(isParked(input({ stage: "parked", signals: new Set(["state-regression"]) }), c, 0)).toBe(false);
  });

  test("a configured signal unparks a manual park too", () => {
    expect(isParked(input({ manual: "park", signals: new Set(["mr-activity"]) }), c, 0)).toBe(false);
  });

  test("an unconfigured signal is ignored", () => {
    expect(isParked(input({ stage: "parked", signals: new Set(["issue-comment"]) }), c, 0)).toBe(true);
  });

  test("agent attention unparks only when configured", () => {
    expect(isParked(input({ stage: "parked", attention: true }), c, 0)).toBe(true);
    const withAttention = cfg({ parkStages: ["parked"], unparkOn: ["agent-attention"] });
    expect(isParked(input({ stage: "parked", attention: true }), withAttention, 0)).toBe(false);
  });
});

describe("isParked idle auto-park", () => {
  const c = cfg({ autoParkIdleDays: 7 });

  test("an issueless session idle past the threshold parks", () => {
    expect(isParked(input({ lastActivity: 0 }), c, 8 * DAY)).toBe(true);
  });

  test("a recently active session does not", () => {
    expect(isParked(input({ lastActivity: 0 }), c, 6 * DAY)).toBe(false);
  });

  test("idle parking never overrides an explicit manual unpark", () => {
    expect(isParked(input({ lastActivity: 0, manual: "unpark" }), c, 8 * DAY)).toBe(false);
  });

  test("a session with a live issue stage is governed by stages, not idleness", () => {
    expect(isParked(input({ stage: "active", lastActivity: 0 }), c, 8 * DAY)).toBe(false);
  });
});

describe("clearStaleOverride", () => {
  // A manual override answers "for this situation". Once the issue moves on,
  // the answer no longer applies — otherwise one manual unpark would suppress
  // parking for that session forever.
  test("keeps an override while the stage is unchanged", () => {
    expect(clearStaleOverride({ manual: "unpark", atStage: "parked" }, "parked"))
      .toEqual({ manual: "unpark", atStage: "parked" });
  });

  test("drops an override once the stage changes", () => {
    expect(clearStaleOverride({ manual: "unpark", atStage: "parked" }, "active")).toBeNull();
  });

  test("a null override stays null", () => {
    expect(clearStaleOverride(null, "active")).toBeNull();
  });
});

describe("signal detection", () => {
  // A signal is "something changed since this session was parked", so it needs
  // a baseline captured at park time and compared against each poll.
  const base = captureBaseline({
    stage: "parked",
    issues: [{ comments: [{ body: "a" }] }] as any,
    mrs: [{ updatedAt: 1000, pipeline: { state: "passed" } }] as any,
  });

  test("no change yields no signals", () => {
    const s = detectSignals(base, {
      stage: "parked",
      issues: [{ comments: [{ body: "a" }] }] as any,
      mrs: [{ updatedAt: 1000, pipeline: { state: "passed" } }] as any,
    });
    expect([...s]).toEqual([]);
  });

  test("a new issue comment fires issue-comment", () => {
    const s = detectSignals(base, {
      stage: "parked",
      issues: [{ comments: [{ body: "a" }, { body: "QA found a bug" }] }] as any,
      mrs: [{ updatedAt: 1000, pipeline: { state: "passed" } }] as any,
    });
    expect(s.has("issue-comment")).toBe(true);
  });

  test("a stage change fires state-regression", () => {
    const s = detectSignals(base, { stage: "active", issues: [], mrs: [] } as any);
    expect(s.has("state-regression")).toBe(true);
  });

  test("a newer MR updatedAt fires mr-activity", () => {
    const s = detectSignals(base, {
      stage: "parked",
      issues: [{ comments: [{ body: "a" }] }] as any,
      mrs: [{ updatedAt: 2000, pipeline: { state: "passed" } }] as any,
    });
    expect(s.has("mr-activity")).toBe(true);
  });

  test("a pipeline going red fires pipeline-failed", () => {
    const s = detectSignals(base, {
      stage: "parked",
      issues: [{ comments: [{ body: "a" }] }] as any,
      mrs: [{ updatedAt: 1000, pipeline: { state: "failed" } }] as any,
    });
    expect(s.has("pipeline-failed")).toBe(true);
  });

  test("an already-red pipeline at park time does not keep re-firing", () => {
    const red = captureBaseline({
      stage: "parked",
      issues: [] as any,
      mrs: [{ updatedAt: 1, pipeline: { state: "failed" } }] as any,
    });
    const s = detectSignals(red, {
      stage: "parked",
      issues: [] as any,
      mrs: [{ updatedAt: 1, pipeline: { state: "failed" } }] as any,
    });
    expect(s.has("pipeline-failed")).toBe(false);
  });
});

describe("parkingSetupWarning", () => {
  // Parking needs two settings in two different sections to be useful, and the
  // half-configured state looks identical to a broken feature. This is what
  // the Pipeline section reports so the gap is visible rather than mysterious.
  const none = { idea: 0, active: 0, parked: 0, done: 0 };

  test("warns when no stages are selected", () => {
    expect(parkingSetupWarning([], { ...none, parked: 5 }))
      .toMatch(/no stages selected/i);
  });

  test("warns when Parked is selected but no states map to it", () => {
    // Nothing reaches the parked stage via stateType, so an empty list means
    // the stage can never be occupied.
    expect(parkingSetupWarning(["parked"], none)).toMatch(/no states mapped/i);
  });

  test("no warning once both halves are set", () => {
    expect(parkingSetupWarning(["parked"], { ...none, parked: 5 })).toBeNull();
  });

  test("stages other than Parked are populated by the stateType fallback", () => {
    // "done" has members even with no explicit names, so selecting it alone is
    // a valid configuration.
    expect(parkingSetupWarning(["done"], none)).toBeNull();
  });
});
