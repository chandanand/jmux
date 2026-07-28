import { describe, test, expect } from "bun:test";
import { AgentStateTracker, coerceStaleAgentState } from "../agent-state";

describe("AgentStateTracker.apply", () => {
  test("stores a valid (state, since) pair against the pane", () => {
    const t = new AgentStateTracker();
    t.apply("%0", "$1", "running", "1717000000");
    expect(t.getPaneRecord("%0")).toEqual({
      state: "running",
      since: 1_717_000_000_000,
    });
    expect(t.getPaneState("%0")).toBe("running");
  });

  test("rolls a single pane up to its session", () => {
    const t = new AgentStateTracker();
    t.apply("%0", "$1", "running", "1717000000");
    expect(t.getRecord("$1")).toEqual({
      state: "running",
      since: 1_717_000_000_000,
    });
    expect(t.getState("$1")).toBe("running");
  });

  test("clears the record when state is null or empty", () => {
    const t = new AgentStateTracker();
    t.apply("%0", "$1", "running", "1717000000");
    t.apply("%0", "$1", null, null);
    expect(t.getPaneRecord("%0")).toBeNull();
    expect(t.getState("$1")).toBeNull();
  });

  test("treats empty-string raw values as cleared (tmux unset)", () => {
    const t = new AgentStateTracker();
    t.apply("%0", "$1", "running", "1717000000");
    t.apply("%0", "$1", "", "");
    expect(t.getPaneRecord("%0")).toBeNull();
  });

  test("ignores invalid state strings", () => {
    const t = new AgentStateTracker();
    t.apply("%0", "$1", "running", "1717000000");
    t.apply("%0", "$1", "bogus", "1717000010");
    expect(t.getPaneState("%0")).toBe("running");
  });

  test("falls back to nowMs when since is missing or unparseable", () => {
    const t = new AgentStateTracker(() => 1_800_000_000_000);
    t.apply("%0", "$1", "running", null);
    expect(t.getPaneRecord("%0")).toEqual({
      state: "running",
      since: 1_800_000_000_000,
    });
    t.apply("%1", "$1", "running", "not-a-number");
    expect(t.getPaneRecord("%1")?.since).toBe(1_800_000_000_000);
  });

  test("getState returns null for unknown ids", () => {
    const t = new AgentStateTracker();
    expect(t.getState("$missing")).toBeNull();
    expect(t.getRecord("$missing")).toBeNull();
    expect(t.getPaneState("%missing")).toBeNull();
    expect(t.getPaneRecord("%missing")).toBeNull();
  });

  test("default clock uses Date.now() when no nowMs is injected", () => {
    const before = Date.now();
    const t = new AgentStateTracker();
    t.apply("%0", "$1", "running", null);
    const after = Date.now();
    const since = t.getPaneRecord("%0")?.since ?? 0;
    expect(since).toBeGreaterThanOrEqual(before);
    expect(since).toBeLessThanOrEqual(after);
  });
});

describe("AgentStateTracker session rollup", () => {
  test("waiting outranks running, which outranks complete", () => {
    const t = new AgentStateTracker();
    t.apply("%0", "$1", "complete", "1717000000");
    t.apply("%1", "$1", "running", "1717000010");
    expect(t.getState("$1")).toBe("running");

    t.apply("%2", "$1", "waiting", "1717000020");
    expect(t.getState("$1")).toBe("waiting");
  });

  test("ties on state resolve to the earliest since", () => {
    const t = new AgentStateTracker();
    t.apply("%0", "$1", "running", "1717000500");
    t.apply("%1", "$1", "running", "1717000100");
    expect(t.getRecord("$1")).toEqual({
      state: "running",
      since: 1_717_000_100_000,
    });
  });

  test("sessions are independent", () => {
    const t = new AgentStateTracker();
    t.apply("%0", "$1", "waiting", "1717000000");
    t.apply("%1", "$2", "complete", "1717000000");
    expect(t.getState("$1")).toBe("waiting");
    expect(t.getState("$2")).toBe("complete");
  });

  test("clearing the winning pane falls back to the next most urgent", () => {
    const t = new AgentStateTracker();
    t.apply("%0", "$1", "running", "1717000000");
    t.apply("%1", "$1", "waiting", "1717000010");
    expect(t.getState("$1")).toBe("waiting");

    t.apply("%1", "$1", null, null);
    expect(t.getState("$1")).toBe("running");
  });

  test("a pane moved between sessions stops counting toward the old one", () => {
    const t = new AgentStateTracker();
    t.apply("%0", "$1", "waiting", "1717000000");
    expect(t.getState("$1")).toBe("waiting");

    t.apply("%0", "$2", "waiting", "1717000000");
    expect(t.getState("$1")).toBeNull();
    expect(t.getState("$2")).toBe("waiting");
  });
});

describe("AgentStateTracker.onChange", () => {
  test("fires on real changes, keyed by session", () => {
    const t = new AgentStateTracker();
    const seen: string[] = [];
    t.onChange((id) => seen.push(id));

    t.apply("%0", "$1", "running", "1717000000");
    t.apply("%0", "$1", "waiting", "1717000010");
    expect(seen).toEqual(["$1", "$1"]);
  });

  test("does NOT fire on idempotent (same state, same since) re-apply", () => {
    const t = new AgentStateTracker();
    const seen: string[] = [];
    t.onChange((id) => seen.push(id));

    t.apply("%0", "$1", "running", "1717000000");
    t.apply("%0", "$1", "running", "1717000000");
    expect(seen).toEqual(["$1"]);
  });

  test("DOES fire when only since changes", () => {
    const t = new AgentStateTracker();
    const seen: string[] = [];
    t.onChange((id) => seen.push(id));

    t.apply("%0", "$1", "running", "1717000000");
    t.apply("%0", "$1", "running", "1717000050");
    expect(seen).toEqual(["$1", "$1"]);
  });

  test("fires on clear if there was a prior record", () => {
    const t = new AgentStateTracker();
    const seen: string[] = [];
    t.onChange((id) => seen.push(id));

    t.apply("%0", "$1", "running", "1717000000");
    t.apply("%0", "$1", null, null);
    expect(seen).toEqual(["$1", "$1"]);
  });

  test("does NOT fire on clear if there was no prior record", () => {
    const t = new AgentStateTracker();
    const seen: string[] = [];
    t.onChange((id) => seen.push(id));

    t.apply("%0", "$1", null, null);
    expect(seen).toEqual([]);
  });

  test("does NOT fire when a non-winning pane changes under the rollup", () => {
    const t = new AgentStateTracker();
    t.apply("%0", "$1", "waiting", "1717000000");

    const seen: string[] = [];
    t.onChange((id) => seen.push(id));

    // %1 goes complete -> running, but %0's waiting still wins the session.
    t.apply("%1", "$1", "complete", "1717000010");
    t.apply("%1", "$1", "running", "1717000020");
    expect(seen).toEqual([]);
  });
});

describe("AgentStateTracker.pruneExcept", () => {
  test("removes records for panes not in the active set", () => {
    const t = new AgentStateTracker();
    t.apply("%0", "$1", "running", "1717000000");
    t.apply("%1", "$2", "waiting", "1717000010");
    t.apply("%2", "$3", "complete", "1717000020");

    t.pruneExcept(["%0", "%2"]);
    expect(t.getState("$1")).toBe("running");
    expect(t.getState("$2")).toBeNull();
    expect(t.getState("$3")).toBe("complete");
  });

  test("pruning the last pane of a session clears the session rollup", () => {
    const t = new AgentStateTracker();
    t.apply("%0", "$1", "running", "1717000000");
    t.pruneExcept([]);
    expect(t.getRecord("$1")).toBeNull();
    expect(t.size).toBe(0);
  });

  test("does NOT emit change events for pruned records", () => {
    const t = new AgentStateTracker();
    t.apply("%0", "$1", "running", "1717000000");
    t.apply("%1", "$2", "waiting", "1717000010");

    const seen: string[] = [];
    t.onChange((id) => seen.push(id));

    t.pruneExcept(["%0"]);
    expect(seen).toEqual([]);
  });
});

describe("AgentStateTracker.size", () => {
  test("reflects number of tracked pane records", () => {
    const t = new AgentStateTracker();
    expect(t.size).toBe(0);
    t.apply("%0", "$1", "running", "1717000000");
    expect(t.size).toBe(1);
    t.apply("%1", "$1", "running", "1717000000");
    expect(t.size).toBe(2);
    t.apply("%0", "$1", null, null);
    expect(t.size).toBe(1);
  });
});

const TEN_MIN_MS = 10 * 60 * 1000;

describe("coerceStaleAgentState", () => {
  test("returns null unchanged", () => {
    expect(
      coerceStaleAgentState(null, "2026-05-20T12:00:00Z", Date.parse("2026-05-20T12:05:00Z"), TEN_MIN_MS),
    ).toBeNull();
  });

  test("returns the input unchanged when within the threshold", () => {
    const stored = { state: "running" as const, since: "2026-05-20T11:59:00Z" };
    const out = coerceStaleAgentState(
      stored,
      "2026-05-20T12:00:00Z",
      Date.parse("2026-05-20T12:05:00Z"),
      TEN_MIN_MS,
    );
    expect(out).toEqual(stored);
  });

  test("coerces stale running to complete", () => {
    const stored = { state: "running" as const, since: "2026-05-20T10:00:00Z" };
    const out = coerceStaleAgentState(
      stored,
      "2026-05-20T10:00:00Z",
      Date.parse("2026-05-20T12:00:00Z"),
      TEN_MIN_MS,
    );
    expect(out).toEqual({
      state: "complete",
      since: "2026-05-20T10:00:00Z",
    });
  });

  test("coerces stale waiting to complete", () => {
    const stored = { state: "waiting" as const, since: "2026-05-20T10:00:00Z" };
    const out = coerceStaleAgentState(
      stored,
      "2026-05-20T10:00:00Z",
      Date.parse("2026-05-20T12:00:00Z"),
      TEN_MIN_MS,
    );
    expect(out).toEqual({
      state: "complete",
      since: "2026-05-20T10:00:00Z",
    });
  });

  test("leaves stale complete unchanged", () => {
    const stored = { state: "complete" as const, since: "2026-05-20T10:00:00Z" };
    const out = coerceStaleAgentState(
      stored,
      "2026-05-20T10:00:00Z",
      Date.parse("2026-05-20T12:00:00Z"),
      TEN_MIN_MS,
    );
    expect(out).toEqual(stored);
  });

  test("malformed capturedAt is treated as stale (safest)", () => {
    const stored = { state: "running" as const, since: "2026-05-20T10:00:00Z" };
    const out = coerceStaleAgentState(
      stored,
      "garbage",
      Date.parse("2026-05-20T12:00:00Z"),
      TEN_MIN_MS,
    );
    expect(out?.state).toBe("complete");
  });

  test("age exactly equal to threshold is treated as fresh", () => {
    const capturedAt = "2026-05-20T12:00:00.000Z";
    const stored = { state: "running" as const, since: capturedAt };
    const exactlyTenMinLater = Date.parse(capturedAt) + TEN_MIN_MS;
    const out = coerceStaleAgentState(stored, capturedAt, exactlyTenMinLater, TEN_MIN_MS);
    expect(out).toEqual(stored);
  });
});
