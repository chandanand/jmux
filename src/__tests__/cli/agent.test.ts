import { describe, test, expect } from "bun:test";
import {
  parseAgentPaneLine,
  rollupAgentRecords,
  diffAgentStates,
  type AgentPaneRow,
  type WatchEntry,
} from "../../cli/agent";
import { US } from "../../tmux-fields";

function line(parts: string[]): string {
  return parts.join(US);
}

/** session_id, session_name, state, since, agent_pane, pane_id, path, active, kind */
const FULL = ["$1", "TRA-123", "running", "1781480000", "%12", "%99", "/repo/wt", "1", "claude"];

describe("parseAgentPaneLine", () => {
  test("parses all nine fields of a pane row", () => {
    expect(parseAgentPaneLine(line(FULL))).toEqual({
      sessionId: "$1",
      session: "TRA-123",
      state: "running",
      since: 1781480000,
      agentPane: "%12",
      paneId: "%99",
      path: "/repo/wt",
      active: true,
      kind: "claude",
    });
  });

  test("maps unset options to null rather than empty strings", () => {
    const row = parseAgentPaneLine(line(["$2", "shell", "", "", "", "%3", "/home", "0", ""]));
    expect(row?.state).toBeNull();
    expect(row?.since).toBeNull();
    expect(row?.agentPane).toBeNull();
    expect(row?.kind).toBeNull();
    expect(row?.active).toBe(false);
  });

  test("rejects an unknown state value", () => {
    const row = parseAgentPaneLine(line(["$2", "s", "bogus", "1781480000", "%9", "%3", "/home", "1", ""]));
    expect(row?.state).toBeNull();
  });

  test("returns null when fields are missing", () => {
    expect(parseAgentPaneLine("$1\x1fonly-two")).toBeNull();
  });

  test("parses tmux 3.4 output where the separator is octal-escaped (issue #7)", () => {
    // tmux 3.4 emits the literal text `\037` in place of the raw 0x1F byte.
    expect(parseAgentPaneLine(FULL.join("\\037"))?.state).toBe("running");
    expect(parseAgentPaneLine(FULL.join("\\037"))?.kind).toBe("claude");
  });
});

describe("rollupAgentRecords", () => {
  const row = (o: Partial<AgentPaneRow> & { sessionId: string }): AgentPaneRow => ({
    session: "s",
    state: null,
    since: null,
    agentPane: null,
    paneId: "%1",
    path: "/p",
    active: false,
    kind: null,
    ...o,
  });

  test("rolls a single agent pane up to its session", () => {
    const [rec] = rollupAgentRecords(
      [row({ sessionId: "$1", session: "TRA-123", state: "running", since: 1781480000, kind: "claude", active: true, paneId: "%9", agentPane: "%9" })],
      1781480123,
    );
    expect(rec).toEqual({
      session: "TRA-123",
      sessionId: "$1",
      state: "running",
      since: 1781480000,
      ageSeconds: 123,
      agentPane: "%9",
      activePane: "%9",
      path: "/p",
      kind: "claude",
    });
  });

  test("the most urgent pane wins, and carries its own kind", () => {
    const [rec] = rollupAgentRecords(
      [
        row({ sessionId: "$1", state: "running", since: 100, kind: "claude" }),
        row({ sessionId: "$1", state: "waiting", since: 200, kind: "codex", paneId: "%2" }),
      ],
      300,
    );
    expect(rec.state).toBe("waiting");
    expect(rec.kind).toBe("codex");
    expect(rec.since).toBe(200);
  });

  test("ties resolve to the earliest since, so the timer tracks the oldest agent", () => {
    const [rec] = rollupAgentRecords(
      [
        row({ sessionId: "$1", state: "running", since: 500 }),
        row({ sessionId: "$1", state: "running", since: 100, paneId: "%2" }),
      ],
      600,
    );
    expect(rec.since).toBe(100);
    expect(rec.ageSeconds).toBe(500);
  });

  test("a session with no agent is still reported, with a null state", () => {
    const [rec] = rollupAgentRecords([row({ sessionId: "$9", session: "shell", active: true })], 100);
    expect(rec.sessionId).toBe("$9");
    expect(rec.state).toBeNull();
    expect(rec.ageSeconds).toBeNull();
  });

  test("path and activePane come from the active pane, not an arbitrary one", () => {
    const [rec] = rollupAgentRecords(
      [
        row({ sessionId: "$1", paneId: "%1", path: "/inactive", active: false, state: "running", since: 1 }),
        row({ sessionId: "$1", paneId: "%2", path: "/active", active: true }),
      ],
      2,
    );
    expect(rec.activePane).toBe("%2");
    expect(rec.path).toBe("/active");
  });

  test("keeps sessions separate", () => {
    const recs = rollupAgentRecords(
      [
        row({ sessionId: "$1", session: "a", state: "waiting", since: 1 }),
        row({ sessionId: "$2", session: "b", state: "complete", since: 1 }),
      ],
      2,
    );
    expect(recs).toHaveLength(2);
    expect(recs.find((r) => r.sessionId === "$1")?.state).toBe("waiting");
    expect(recs.find((r) => r.sessionId === "$2")?.state).toBe("complete");
  });

  test("clamps negative age to zero (clock skew)", () => {
    const [rec] = rollupAgentRecords(
      [row({ sessionId: "$1", state: "waiting", since: 1781480100 })],
      1781480000,
    );
    expect(rec.ageSeconds).toBe(0);
  });
});

describe("diffAgentStates", () => {
  const entry = (
    session: string,
    state: WatchEntry["state"],
    since: number | null,
  ): WatchEntry => ({ session, state, since });

  test("emits a new session only when it has an agent state", () => {
    const prev = new Map<string, WatchEntry>();
    const next = new Map<string, WatchEntry>([
      ["$1", entry("TRA-1", "running", 100)],
      ["$2", entry("shell", null, null)],
    ]);
    const events = diffAgentStates(prev, next);
    expect(events).toEqual([
      { type: "agent_state_changed", session: "TRA-1", state: "running", since: 100 },
    ]);
  });

  test("emits on a state transition", () => {
    const prev = new Map([["$1", entry("TRA-1", "running", 100)]]);
    const next = new Map([["$1", entry("TRA-1", "waiting", 200)]]);
    expect(diffAgentStates(prev, next)).toEqual([
      { type: "agent_state_changed", session: "TRA-1", state: "waiting", since: 200 },
    ]);
  });

  test("emits when only `since` changes (a re-run with the same label)", () => {
    const prev = new Map([["$1", entry("TRA-1", "running", 100)]]);
    const next = new Map([["$1", entry("TRA-1", "running", 150)]]);
    expect(diffAgentStates(prev, next)).toHaveLength(1);
  });

  test("does not emit when nothing changed", () => {
    const prev = new Map([["$1", entry("TRA-1", "running", 100)]]);
    const next = new Map([["$1", entry("TRA-1", "running", 100)]]);
    expect(diffAgentStates(prev, next)).toEqual([]);
  });

  test("emits a terminal null event when a known agent session disappears", () => {
    const prev = new Map([["$1", entry("TRA-1", "complete", 100)]]);
    const next = new Map<string, WatchEntry>();
    expect(diffAgentStates(prev, next)).toEqual([
      { type: "agent_state_changed", session: "TRA-1", state: null, since: null },
    ]);
  });

  test("does not emit when an idle (null-state) session disappears", () => {
    const prev = new Map([["$1", entry("shell", null, null)]]);
    const next = new Map<string, WatchEntry>();
    expect(diffAgentStates(prev, next)).toEqual([]);
  });
});
