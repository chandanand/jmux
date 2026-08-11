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
    agentPane: null,
    title: "",
    currentPath: "",
    ...over,
  };
}

// `@jmux-agent-state` is written at pane scope by the hooks, but a *pane-context
// format read inherits the session's value* — verified against tmux 3.7b:
//   tmux set-option -t <session> @jmux-agent-state running
//   tmux list-panes -a -F '#{pane_id} [#{@jmux-agent-state}]'
//   %0 [running]   %1 [running]
// So in any session where an agent is running, every shell, editor and log tail
// reports that state, and `since` inherits with them — leaving them
// indistinguishable even by age. `kind` has no session-scoped writer, so it is
// the only usable gate.
// `@jmux-agent-pane` is the hooks' own answer to "which pane is the agent", and
// it is the election's first tier. The grid was calling the election with null
// for it, so a session whose agent had declared itself was still resolved by
// heuristics — which is how a plain shell became a session's face.
describe("the hooks' declared agent pane wins outright", () => {
  test("an explicit agent pane beats a kinded pane with a more urgent state", () => {
    const panes = [
      row({ paneId: "%1", kind: "", agentPane: "%2" }),          // the shell
      row({ paneId: "%2", kind: "claude", agentPane: "%2" }),    // the declared agent
      row({ paneId: "%3", kind: "claude", state: "waiting", since: 1, agentPane: "%2" }),
    ];
    const explicit = panes.find((p) => p.agentPane)?.agentPane ?? null;
    expect(electRepresentative(panes, explicit, null)).toBe("%2");
  });

  test("a declared pane that has since died falls through to the tiers below", () => {
    const panes = [
      row({ paneId: "%1", kind: "", agentPane: "%9" }),          // %9 is gone
      row({ paneId: "%2", kind: "claude", agentPane: "%9" }),
    ];
    const explicit = panes.find((p) => p.agentPane)?.agentPane ?? null;
    expect(electRepresentative(panes, explicit, null)).toBe("%2");
  });
});

describe("inherited agent state is not the pane's own", () => {
  const row = (paneId: string, kind: string, state: string, since: string) =>
    [paneId, kind, "zsh", "", "1", paneId === "%1" ? "1" : "0", state, since].join("\x1f");

  test("a pane with no kind reports no state, however loudly tmux says otherwise", () => {
    const [shell] = parsePaneRowLines([row("%1", "", "running", "100")]);
    expect(shell!.state).toBeNull();
    expect(shell!.since).toBeNull();
  });

  test("a pane that declares a kind keeps its state", () => {
    const [agent] = parsePaneRowLines([row("%2", "claude", "running", "100")]);
    expect(agent!.state).toBe("running");
    expect(agent!.since).toBe(100);
  });

  test("the shell at the lower pane id no longer beats the agent", () => {
    // The exact shape of the reported bug: shell %1, agent %2, both carrying the
    // session's inherited `running` at the same `since`. Taken at face value
    // `outranks` tied on state AND on age, so the winner fell through to the
    // lowest pane id — the shell.
    const panes = parsePaneRowLines([
      row("%1", "", "running", "100"),
      row("%2", "claude", "running", "100"),
    ]);
    expect(electRepresentative(panes, null, null)).toBe("%2");
  });

  test("with no agent anywhere, the active pane still wins over the lowest id", () => {
    // The legacy path the old detectAgentPanes called signal 2: a session whose
    // state is set but where nothing declares a kind. Nulling the inherited
    // state is what lets sessionActive answer instead of pane-id order.
    const panes = parsePaneRowLines([
      row("%1", "", "running", "100"),   // sessionActive per `row`
      row("%2", "", "running", "100"),
    ]);
    expect(electRepresentative(panes, null, null)).toBe("%1");
  });
});

describe("parsePaneRowLines", () => {
  test("PANE_ROW_FORMAT requests the ten fields, US-separated", () => {
    expect(PANE_ROW_FORMAT).toBe(
      "#{pane_id}\x1f#{@jmux-agent-kind}\x1f#{pane_current_command}\x1f#{@jmux-pinned}\x1f#{window_active}\x1f#{pane_active}\x1f#{@jmux-agent-state}\x1f#{@jmux-agent-state-since}\x1f#{@jmux-agent-pane}\x1f#{pane_title}\x1f#{pane_current_path}",
    );
  });

  test("splits all ten fields", () => {
    const rows = parsePaneRowLines(["%1\x1fclaude\x1fnode\x1fbackend\x1f1\x1f1\x1fwaiting\x1f100\x1f%1\x1fclaude — chat\x1f/repo/api"]);
    expect(rows).toEqual([
      {
        paneId: "%1",
        kind: "claude",
        command: "node",
        forcedOn: true,
        sessionActive: true,
        state: "waiting",
        since: 100,
        agentPane: "%1",
        title: "claude — chat",
        currentPath: "/repo/api",
      },
    ]);
  });

  test("missing trailing title/currentPath fields default to empty strings", () => {
    const rows = parsePaneRowLines(["%1\x1fclaude\x1fnode\x1fbackend\x1f1\x1f1\x1fwaiting\x1f100\x1f%1"]);
    expect(rows[0].title).toBe("");
    expect(rows[0].currentPath).toBe("");
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
        agentPane: null,
        title: "",
        currentPath: "",
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

  test("genuinely empty panes: null", () => {
    expect(electRepresentative([], null, null)).toBeNull();
  });

  test("no eligible pane: tier 4 still elects one from the whole pane set", () => {
    // A dev server or log-tail session has nothing kinded, regex-matched, or
    // force-on — but it must still tile without anyone pinning it.
    expect(electRepresentative([row({ paneId: "%1" })], null, null)).toBe("%1");
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

  test("an ineligible pane never wins while an eligible one exists", () => {
    const panes = [
      row({ paneId: "%1", state: "waiting", since: 1 }), // no kind, no regex match, not forced
      row({ paneId: "%2", kind: "claude", state: "complete", since: 1 }),
    ];
    expect(electRepresentative(panes, null, null)).toBe("%2");
  });

  test("three panes, none eligible: tier 4 elects the session-active one", () => {
    // No kind, no regex match, no force-on anywhere — same shape as the
    // three-window eligible case, but proving the fallback over the *whole*
    // pane set rather than over an eligible subset.
    const panes = [
      row({ paneId: "%1", sessionActive: false }),
      row({ paneId: "%2", sessionActive: true }),
      row({ paneId: "%3", sessionActive: false }),
    ];
    expect(electRepresentative(panes, null, null)).toBe("%2");
  });
});
