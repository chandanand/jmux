import { describe, test, expect } from "bun:test";
import {
  AGENT_DETECT_FORMAT,
  parseAgentDetectLines,
  detectAgentPanes,
  type AgentPaneRow,
} from "../../glass/auto-detect";

/** Row builder so each test states only the fields it cares about. */
function row(over: Partial<AgentPaneRow> & { paneId: string }): AgentPaneRow {
  return {
    agentState: "",
    active: false,
    command: "",
    kind: "",
    sessionId: "$1",
    ...over,
  };
}

describe("parseAgentDetectLines", () => {
  test("parses the six US-separated fields", () => {
    const rows = parseAgentDetectLines([
      "%1\x1frunning\x1f1\x1f2.1.177\x1fclaude\x1f$1",
      "%2\x1f\x1f0\x1fzsh\x1f\x1f$1",
    ]);
    expect(rows).toEqual([
      { paneId: "%1", agentState: "running", active: true, command: "2.1.177", kind: "claude", sessionId: "$1" },
      { paneId: "%2", agentState: "", active: false, command: "zsh", kind: "", sessionId: "$1" },
    ]);
  });

  test("AGENT_DETECT_FORMAT requests the six fields", () => {
    expect(AGENT_DETECT_FORMAT).toBe(
      "#{pane_id}\x1f#{@jmux-agent-state}\x1f#{pane_active}\x1f#{pane_current_command}\x1f#{@jmux-agent-kind}\x1f#{session_id}",
    );
  });

  test("parses + detects on tmux 3.4 output where the separator is octal-escaped (issue #7)", () => {
    // The whole-line garble was why auto-pin found nothing on tmux 3.4.
    const rows = parseAgentDetectLines([
      "%1\\037running\\0371\\037claude\\037\\037$1",
      "%2\\037\\0370\\037zsh\\037\\037$1",
    ]);
    expect(rows).toEqual([
      { paneId: "%1", agentState: "running", active: true, command: "claude", kind: "", sessionId: "$1" },
      { paneId: "%2", agentState: "", active: false, command: "zsh", kind: "", sessionId: "$1" },
    ]);
    // The active agent pane is now correctly auto-pinned.
    expect([...detectAgentPanes(rows, "claude|codex")]).toEqual(["%1"]);
  });
});

describe("detectAgentPanes", () => {
  const rows = [
    row({ paneId: "%1", agentState: "running", active: true, command: "2.1.177" }), // legacy Claude (active pane of agent session)
    row({ paneId: "%2", agentState: "running", active: false, command: "zsh" }),     // agent session but not active pane
    row({ paneId: "%3", agentState: "", active: true, command: "codex" }),           // Codex via command match
    row({ paneId: "%4", agentState: "", active: true, command: "vim" }),             // unrelated
  ];

  test("detects active panes of agent sessions + command matches", () => {
    const got = detectAgentPanes(rows, "codex");
    expect([...got].sort()).toEqual(["%1", "%3"]);
  });

  test("non-active pane of an agent session is not auto-detected", () => {
    expect(detectAgentPanes(rows, "codex").has("%2")).toBe(false);
  });

  test("null/empty regex disables the command signal (Claude still detected)", () => {
    expect([...detectAgentPanes(rows, null)]).toEqual(["%1"]);
    expect([...detectAgentPanes(rows, "")]).toEqual(["%1"]);
  });

  test("invalid regex is ignored, not thrown", () => {
    expect(() => detectAgentPanes(rows, "(")).not.toThrow();
    expect([...detectAgentPanes(rows, "(")]).toEqual(["%1"]);
  });

  test("regex is case-insensitive", () => {
    const got = detectAgentPanes([row({ paneId: "%9", active: true, command: "CODEX" })], "codex");
    expect(got.has("%9")).toBe(true);
  });
});

describe("detectAgentPanes / @jmux-agent-kind", () => {
  test("a declared kind is detected on its own, with no command match", () => {
    const got = detectAgentPanes([row({ paneId: "%1", kind: "codex", command: "zsh" })], null);
    expect([...got]).toEqual(["%1"]);
  });

  test("a declared kind is detected even when the pane is not active", () => {
    const got = detectAgentPanes(
      [row({ paneId: "%1", kind: "pi", active: false, agentState: "running" })],
      null,
    );
    expect([...got]).toEqual(["%1"]);
  });

  test("inherited state does NOT drag innocent siblings in once a kind is declared", () => {
    // The load-bearing case: %1 is the agent, %2 is the user's editor. Both read
    // agentState="running" because a pane-context read inherits the session
    // option. Only %1 declares a kind, so only %1 is an agent pane.
    const got = detectAgentPanes(
      [
        row({ paneId: "%1", kind: "claude", agentState: "running", active: false }),
        row({ paneId: "%2", kind: "", agentState: "running", active: true, command: "vim" }),
      ],
      null,
    );
    expect([...got]).toEqual(["%1"]);
  });

  test("suppression is scoped per session, so a legacy session still resolves", () => {
    const got = detectAgentPanes(
      [
        // $1 has migrated: kind declared, inherited state on the sibling ignored.
        row({ paneId: "%1", sessionId: "$1", kind: "codex", agentState: "running" }),
        row({ paneId: "%2", sessionId: "$1", agentState: "running", active: true, command: "vim" }),
        // $2 has not: no kind anywhere, so the active-pane fallback still applies.
        row({ paneId: "%3", sessionId: "$2", agentState: "waiting", active: true, command: "node" }),
      ],
      null,
    );
    expect([...got].sort()).toEqual(["%1", "%3"]);
  });

  test("command match still wins independently of kind suppression", () => {
    const got = detectAgentPanes(
      [
        row({ paneId: "%1", sessionId: "$1", kind: "claude", agentState: "running" }),
        row({ paneId: "%2", sessionId: "$1", agentState: "running", active: true, command: "aider" }),
      ],
      "aider",
    );
    expect([...got].sort()).toEqual(["%1", "%2"]);
  });
});
