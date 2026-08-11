import { describe, test, expect } from "bun:test";
import {
  PANE_ROW_FORMAT,
  parsePaneRowLines,
  eligiblePanes,
  electRepresentative,
  type PaneRow,
} from "../../glass/representative";

/** Row builder so each test states only the fields it cares about. */
function row(over: Partial<PaneRow> & { paneId: string }): PaneRow {
  return {
    kind: "",
    command: "",
    forcedOn: false,
    sessionActive: false,
    state: null,
    since: null,
    ...over,
  };
}

describe("parsePaneRowLines", () => {
  test("PANE_ROW_FORMAT requests the eight fields, US-separated", () => {
    expect(PANE_ROW_FORMAT).toBe(
      "#{pane_id}\x1f#{@jmux-agent-kind}\x1f#{pane_current_command}\x1f#{@jmux-pinned}\x1f#{window_active}\x1f#{pane_active}\x1f#{@jmux-agent-state}\x1f#{@jmux-agent-state-since}",
    );
  });

  test("splits all eight fields", () => {
    const rows = parsePaneRowLines(["%1\x1fclaude\x1fnode\x1fbackend\x1f1\x1f1\x1fwaiting\x1f100"]);
    expect(rows).toEqual([
      {
        paneId: "%1",
        kind: "claude",
        command: "node",
        forcedOn: true,
        sessionActive: true,
        state: "waiting",
        since: 100,
      },
    ]);
  });

  test("blank/invalid state parses to null rather than a garbage AgentState", () => {
    const rows = parsePaneRowLines(["%1\x1f\x1fzsh\x1f\x1f0\x1f1\x1f\x1f"]);
    expect(rows[0].state).toBeNull();
    expect(rows[0].since).toBeNull();
    expect(rows[0].forcedOn).toBe(false);
    expect(rows[0].sessionActive).toBe(false);
  });

  test("ignores blank lines", () => {
    expect(parsePaneRowLines(["", "%1\x1f\x1f\x1f\x1f0\x1f0\x1f\x1f", ""])).toHaveLength(1);
  });

  test("parses tmux 3.4 output where the separator is octal-escaped (issue #7)", () => {
    const rows = parsePaneRowLines(["%1\\037claude\\037node\\037\\0371\\0371\\037running\\03750"]);
    expect(rows).toEqual([
      {
        paneId: "%1",
        kind: "claude",
        command: "node",
        forcedOn: false,
        sessionActive: true,
        state: "running",
        since: 50,
      },
    ]);
  });
});

describe("eligiblePanes", () => {
  test("unions kinded, regex-matched, and force-on panes", () => {
    const panes = [
      row({ paneId: "%3", kind: "claude" }),
      row({ paneId: "%1", command: "codex" }),
      row({ paneId: "%2", forcedOn: true }),
      row({ paneId: "%4" }), // none of the three signals
    ];
    const got = eligiblePanes(panes, "codex").map((p) => p.paneId);
    expect(got).toEqual(["%1", "%2", "%3"]);
  });

  test("orders by pane id numerically, not lexicographically", () => {
    const panes = [row({ paneId: "%12", kind: "claude" }), row({ paneId: "%3", kind: "codex" })];
    expect(eligiblePanes(panes, null).map((p) => p.paneId)).toEqual(["%3", "%12"]);
  });

  test("empty regex disables the command signal", () => {
    const panes = [row({ paneId: "%1", command: "codex" })];
    expect(eligiblePanes(panes, "")).toEqual([]);
    expect(eligiblePanes(panes, null)).toEqual([]);
  });

  test("invalid regex is ignored, not thrown", () => {
    const panes = [row({ paneId: "%1", kind: "claude" }), row({ paneId: "%2", command: "codex" })];
    expect(() => eligiblePanes(panes, "(")).not.toThrow();
    expect(eligiblePanes(panes, "(").map((p) => p.paneId)).toEqual(["%1"]);
  });

  test("regex is case-insensitive", () => {
    const panes = [row({ paneId: "%1", command: "CODEX" })];
    expect(eligiblePanes(panes, "codex").map((p) => p.paneId)).toEqual(["%1"]);
  });
});

describe("electRepresentative", () => {
  test("a live explicit pane wins outright", () => {
    const panes = [
      row({ paneId: "%1", kind: "claude", state: "waiting", since: 1 }),
      row({ paneId: "%2", kind: "claude", state: "complete", since: 2 }),
    ];
    expect(electRepresentative(panes, "%2", null)).toBe("%2");
  });

  test("a stale explicit pane (not in panes) is ignored", () => {
    const panes = [row({ paneId: "%1", kind: "claude", state: "running", since: 1 })];
    expect(electRepresentative(panes, "%9", null)).toBe("%1");
  });

  test("no explicit pane, no eligible panes: null", () => {
    expect(electRepresentative([row({ paneId: "%1" })], null, null)).toBeNull();
  });

  test("most urgent eligible pane wins: waiting beats running beats complete", () => {
    const panes = [
      row({ paneId: "%1", kind: "claude", state: "running", since: 10 }),
      row({ paneId: "%2", kind: "claude", state: "waiting", since: 20 }),
      row({ paneId: "%3", kind: "claude", state: "complete", since: 5 }),
    ];
    expect(electRepresentative(panes, null, null)).toBe("%2");
  });

  test("ties on state resolve to the earliest since", () => {
    const panes = [
      row({ paneId: "%1", kind: "claude", state: "running", since: 200 }),
      row({ paneId: "%2", kind: "claude", state: "running", since: 100 }),
    ];
    expect(electRepresentative(panes, null, null)).toBe("%2");
  });

  test("a force-on pane wins over a more urgent non-forced pane", () => {
    const panes = [
      row({ paneId: "%1", kind: "claude", state: "waiting", since: 1 }),
      row({ paneId: "%2", kind: "claude", forcedOn: true, state: "complete", since: 1 }),
    ];
    expect(electRepresentative(panes, null, null)).toBe("%2");
  });

  test("most urgent among several force-on panes wins", () => {
    const panes = [
      row({ paneId: "%1", kind: "claude", forcedOn: true, state: "complete", since: 1 }),
      row({ paneId: "%2", kind: "claude", forcedOn: true, state: "waiting", since: 1 }),
      row({ paneId: "%3", kind: "claude", state: "waiting", since: 1 }),
    ];
    expect(electRepresentative(panes, null, null)).toBe("%2");
  });

  test("a force-on pane with no state still wins over an urgent non-forced pane", () => {
    // The pinned-dev-server case: the pin names the pane the user cares about,
    // even though it has no agent state to rank.
    const panes = [
      row({ paneId: "%1", kind: "claude", state: "waiting", since: 1 }),
      row({ paneId: "%2", forcedOn: true, command: "vite" }),
    ];
    expect(electRepresentative(panes, null, "codex")).toBe("%2");
  });

  test("no pane in the winning group carries state: falls back to the session-active pane", () => {
    const panes = [
      row({ paneId: "%1", kind: "claude", sessionActive: false }),
      row({ paneId: "%2", kind: "claude", sessionActive: true }),
      row({ paneId: "%3", kind: "claude", sessionActive: false }),
    ];
    expect(electRepresentative(panes, null, null)).toBe("%2");
  });

  test("three-window session: sessionActive picks the single window_active && pane_active pane", () => {
    // Three windows, each with its own "active pane" (pane_active=1), but only
    // one window is the session's current window (window_active=1). A fallback
    // keyed on pane_active alone would pick arbitrarily among the three.
    const panes = [
      row({ paneId: "%1", kind: "claude", sessionActive: false }), // pane_active in window A, not the active window
      row({ paneId: "%2", kind: "claude", sessionActive: false }), // pane_active in window B, not the active window
      row({ paneId: "%3", kind: "claude", sessionActive: true }), // pane_active in window C, the active window
    ];
    expect(electRepresentative(panes, null, null)).toBe("%3");
  });

  test("nothing discriminates: first pane by id", () => {
    const panes = [
      row({ paneId: "%2", kind: "claude" }),
      row({ paneId: "%1", kind: "claude" }),
    ];
    expect(electRepresentative(panes, null, null)).toBe("%1");
  });

  test("an ineligible pane never wins even if it would rank highest", () => {
    const panes = [
      row({ paneId: "%1", state: "waiting", since: 1 }), // no kind, no regex match, not forced
      row({ paneId: "%2", kind: "claude", state: "complete", since: 1 }),
    ];
    expect(electRepresentative(panes, null, null)).toBe("%2");
  });
});
