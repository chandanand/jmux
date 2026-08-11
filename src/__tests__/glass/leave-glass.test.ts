import { describe, test, expect } from "bun:test";
import { commitLeaveGlass, leaveGlassWithFallback, type LeaveGlassDeps } from "../../glass/leave-glass";

/** A fake switcher: resolves per session id from a table, records calls. */
function fakeDeps(landsOn: Record<string, boolean>): LeaveGlassDeps & {
  switchCalls: string[];
  teardownCalls: number;
} {
  const switchCalls: string[] = [];
  let teardownCalls = 0;
  return {
    switchTo: async (sessionId: string) => {
      switchCalls.push(sessionId);
      return landsOn[sessionId] ?? false;
    },
    teardown: () => { teardownCalls++; },
    switchCalls,
    get teardownCalls() { return teardownCalls; },
  };
}

describe("commitLeaveGlass", () => {
  test("tears down only after the switch is confirmed", async () => {
    const deps = fakeDeps({ "$1": true });
    const landed = await commitLeaveGlass("$1", deps);
    expect(landed).toBe(true);
    expect(deps.switchCalls).toEqual(["$1"]);
    expect(deps.teardownCalls).toBe(1);
  });

  test("a failed switch never tears down — the regression this exists to catch", async () => {
    // This is the exact bug: the old code called exitGlass() unconditionally
    // before attempting the switch, so a target that died left the chrome
    // torn down with the client still parked. Teardown must never fire on a
    // failed switch.
    const deps = fakeDeps({});
    const landed = await commitLeaveGlass("$dead", deps);
    expect(landed).toBe(false);
    expect(deps.switchCalls).toEqual(["$dead"]);
    expect(deps.teardownCalls).toBe(0);
  });
});

describe("leaveGlassWithFallback", () => {
  test("the first live candidate lands and stops the search", async () => {
    const deps = fakeDeps({ "$1": true, "$2": true });
    const landed = await leaveGlassWithFallback(["$1", "$2"], deps);
    expect(landed).toBe(true);
    expect(deps.switchCalls).toEqual(["$1"]);
    expect(deps.teardownCalls).toBe(1);
  });

  test("falls through to the next candidate when the first has died since the caller's snapshot", async () => {
    const deps = fakeDeps({ "$2": true });
    const landed = await leaveGlassWithFallback(["$1", "$2"], deps);
    expect(landed).toBe(true);
    expect(deps.switchCalls).toEqual(["$1", "$2"]);
    expect(deps.teardownCalls).toBe(1);
  });

  test("every candidate dead: no teardown, reports failure", async () => {
    const deps = fakeDeps({});
    const landed = await leaveGlassWithFallback(["$1", "$2"], deps);
    expect(landed).toBe(false);
    expect(deps.switchCalls).toEqual(["$1", "$2"]);
    expect(deps.teardownCalls).toBe(0);
  });

  test("duplicate and null/undefined candidates are skipped, not retried", async () => {
    const deps = fakeDeps({ "$1": true });
    const landed = await leaveGlassWithFallback([null, "$1", "$1", undefined], deps);
    expect(landed).toBe(true);
    expect(deps.switchCalls).toEqual(["$1"]);
  });

  test("an empty candidate list fails without attempting a switch", async () => {
    const deps = fakeDeps({});
    const landed = await leaveGlassWithFallback([], deps);
    expect(landed).toBe(false);
    expect(deps.switchCalls).toEqual([]);
    expect(deps.teardownCalls).toBe(0);
  });
});
