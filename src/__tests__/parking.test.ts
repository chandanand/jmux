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
  test("the parked stage parks; nothing else does", () => {
    // A status only reaches `parked` through a tab the user flagged, so acting
    // on it is their stated intent — and no other stage is ever hidden.
    expect(isParked(input({ stage: "parked" }), cfg(), 0)).toBe(true);
    for (const stage of ["idea", "active", "done"] as const) {
      expect(isParked(input({ stage }), cfg(), 0)).toBe(false);
    }
  });

  test("parking is off precisely when no tab parks — there is no second switch", () => {
    // There used to be a `parkStages` list here saying which stages park, so
    // "this status parks" and "parked stages park" could disagree; the half-set
    // state looked exactly like a broken feature. `parkedStages` now yields a
    // parked state only for a status you ticked, so an empty list *is* off.
    expect(isParked(input({ stage: null }), cfg(), 0)).toBe(false);
  });
});

describe("isParked derived from stage", () => {
  const c = cfg();

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
  const c = cfg();

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
  const c = cfg({ unparkOn: ["state-regression", "mr-activity"] });

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
    const withAttention = cfg({ unparkOn: ["agent-attention"] });
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
  // One condition now, because there is one switch. This used to report the
  // half-configured state that arose from needing two settings in two different
  // settings categories to agree.
  test("warns when no tab parks, so nothing can ever reach the parked stage", () => {
    expect(parkingSetupWarning(0)).toMatch(/no tab is set to park/i);
  });

  test("no warning once a tab parks", () => {
    expect(parkingSetupWarning(6)).toBeNull();
  });
});
