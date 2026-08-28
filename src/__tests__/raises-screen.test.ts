import { describe, test, expect } from "bun:test";
import { watch, mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, basename } from "path";
import { RaisesScreen, raiseJumpTarget, raisesFileTouched, type RaisesPort } from "../raises-screen";
import type { Raise, RaiseScope } from "../raises/types";
import { readRaises, type ReadResult } from "../raises/store";

const SESSION_RAISE: Raise = {
  id: "raise-session-1",
  createdAt: 1000,
  idempotencyKey: "key-1",
  scope: { kind: "session", socket: "default", sessionId: "$3", sessionName: "demo-session", agentPane: "%7" },
  question: "Should the retry limit be 3 or 5?",
  options: [
    { id: "opt-low", text: "3 retries" },
    { id: "opt-high", text: "5 retries" },
  ],
  recommendation: "opt-low",
  why: "Prior incidents cleared within two retries.",
  context: "Retry storm observed twice this week.",
  authority: "developer",
  snapshot: "$ ctl status\nAll clear\n",
  state: "open",
  answer: null,
  resolvedAt: null,
};

const ISSUE_RAISE: Raise = {
  id: "raise-issue-1",
  createdAt: 2000,
  idempotencyKey: "key-2",
  scope: { kind: "issue", identifier: "ENG-777" },
  question: "Which base branch should the migration target?",
  options: [
    { id: "opt-main", text: "main" },
    { id: "opt-release", text: "release/2026.08" },
  ],
  recommendation: "opt-release",
  why: "Release freezes weekly and main is on the wrong cadence.",
  context: "Migration touches billing tables.",
  authority: "product",
  snapshot: null,
  state: "open",
  answer: null,
  resolvedAt: null,
};

interface Calls {
  answered: Array<{ id: string; optionId: string }>;
  jumped: RaiseScope[];
}

function makePort(result: ReadResult, over: Partial<RaisesPort> = {}): { port: RaisesPort; calls: Calls } {
  const calls: Calls = { answered: [], jumped: [] };
  const port: RaisesPort = {
    getResult: () => result,
    // Matches SESSION_RAISE's scope.socket below, so tests that do not care
    // about socket isolation keep seeing it.
    getSocket: () => "default",
    answer: (id, optionId) => { calls.answered.push({ id, optionId }); },
    jump: (scope) => { calls.jumped.push(scope); },
    ...over,
  };
  return { port, calls };
}

function extractText(grid: { cells: Array<Array<{ char: string }>> }): string {
  return grid.cells.map((row) => row.map((c) => c.char).join("").trimEnd()).join("\n");
}

describe("RaisesScreen render", () => {
  test("renders the complete queue grid: badges, question, options, recommendation, reasoning, snapshot", () => {
    const { port } = makePort({ kind: "valid", raises: [SESSION_RAISE, ISSUE_RAISE] });
    const screen = new RaisesScreen();
    screen.open(port);
    const text = extractText(screen.render(100, 24));

    const expected = [
      "  Raises · 2 open",
      "",
      "  > demo-session",
      "    Should the retry limit be 3 or 5?",
      "    1) 3 retries  (recommended)",
      "    2) 5 retries",
      "    Recommended: 3 retries",
      "    Why: Prior incidents cleared within two retries.",
      "    Snapshot:",
      "    │ $ ctl status",
      "    │ All clear",
      "",
      "    [ENG-777]",
      "    Which base branch should the migration target?",
      "    1) main",
      "    2) release/2026.08  (recommended)",
      "    Recommended: release/2026.08",
      "    Why: Release freezes weekly and main is on the wrong cadence.",
      "    Snapshot: (none)",
      "",
    ];
    const lines = text.split("\n");
    for (let i = 0; i < expected.length; i++) {
      expect(lines[i]).toBe(expected[i]);
    }
    expect(lines[23]).toBe("  [↑↓] select   [1-9] answer   [a] jump to session   [Esc] close");
  });

  test("an issue-scoped raise renders its issue badge and no session name", () => {
    const { port } = makePort({ kind: "valid", raises: [ISSUE_RAISE] });
    const screen = new RaisesScreen();
    screen.open(port);
    const text = extractText(screen.render(100, 24));
    expect(text).toContain("[ENG-777]");
    expect(text).not.toContain("demo-session");
  });

  test("a store in the error state renders the error, never an empty queue", () => {
    const { port } = makePort({
      kind: "error",
      why: "raise store at /x/raises.json could not be parsed: Unexpected token",
    });
    const screen = new RaisesScreen();
    screen.open(port);
    const text = extractText(screen.render(100, 24));
    expect(text).toContain("could not be parsed");
    expect(text).not.toContain("No open raises");
  });

  test("a number key answers using the option's id, not its display position", () => {
    const { port, calls } = makePort({ kind: "valid", raises: [SESSION_RAISE] });
    const screen = new RaisesScreen();
    screen.open(port);
    screen.render(100, 24);
    screen.handleInput("2");
    expect(calls.answered).toEqual([{ id: "raise-session-1", optionId: "opt-high" }]);
  });

  test("jumping uses the raise's socket and session id, not its name", () => {
    const { port, calls } = makePort({ kind: "valid", raises: [SESSION_RAISE] });
    const screen = new RaisesScreen();
    screen.open(port);
    screen.render(100, 24);
    screen.handleInput("a");
    expect(calls.jumped).toEqual([SESSION_RAISE.scope]);
  });

  test("answering a non-open raise is refused: no number key handling for it", () => {
    const answered: Raise = { ...SESSION_RAISE, state: "answered", answer: { optionId: "opt-low", note: null, answeredAt: 1500 } };
    const { port, calls } = makePort({ kind: "valid", raises: [answered] });
    const screen = new RaisesScreen();
    screen.open(port);
    screen.render(100, 24);
    screen.handleInput("1");
    expect(calls.answered).toEqual([]);
  });
});

// The design says session raises are filtered by socket: `socket` and
// `sessionId` are on the record precisely because two tmux sockets can hold
// a session with the same name. `queue()` had no socket filter at all —
// verified against a real pair of tmux servers, `ctl -L A raise list
// --session reviewsess` returned socket B's raise. These prove the screen
// side of that same gap: an issue-scoped raise has no socket and stays
// global by design; a session-scoped raise from another socket must not.
describe("RaisesScreen socket isolation", () => {
  test("a session raise from a different socket than the one the port reports does not occupy the queue", () => {
    const onSocketA: Raise = {
      ...SESSION_RAISE,
      id: "raise-on-a",
      scope: { kind: "session", socket: "A", sessionId: "$3", sessionName: "demo-session", agentPane: "%7" },
      question: "question raised on socket A",
    };
    const onSocketB: Raise = {
      ...SESSION_RAISE,
      id: "raise-on-b",
      scope: { kind: "session", socket: "B", sessionId: "$9", sessionName: "demo-session", agentPane: "%2" },
      question: "question raised on socket B",
    };
    const { port } = makePort({ kind: "valid", raises: [onSocketA, onSocketB] }, { getSocket: () => "A" });
    const screen = new RaisesScreen();
    screen.open(port);
    const text = extractText(screen.render(100, 24));

    expect(text).toContain("Raises · 1 open");
    expect(text).toContain("question raised on socket A");
    expect(text).not.toContain("question raised on socket B");
  });

  test("an issue-scoped raise has no socket and appears no matter which socket the port reports", () => {
    const { port } = makePort({ kind: "valid", raises: [ISSUE_RAISE] }, { getSocket: () => "some-other-socket" });
    const screen = new RaisesScreen();
    screen.open(port);
    const text = extractText(screen.render(100, 24));
    expect(text).toContain("[ENG-777]");
  });

  test("a raise from another socket cannot be selected or answered: it is not in the queue at all", () => {
    const onSocketB: Raise = {
      ...SESSION_RAISE,
      scope: { kind: "session", socket: "B", sessionId: "$9", sessionName: "demo-session", agentPane: "%2" },
    };
    const { port, calls } = makePort({ kind: "valid", raises: [onSocketB] }, { getSocket: () => "A" });
    const screen = new RaisesScreen();
    screen.open(port);
    screen.render(100, 24);
    screen.handleInput("1");
    expect(calls.answered).toEqual([]);
  });
});

// One malformed record inside an otherwise-valid store used to reach
// `RaisesScreen.render` as a bare `Raise` and throw — `renderFrame` runs in a
// bare `setTimeout`, so nothing caught it, and main.ts's `uncaughtException`
// handler called `process.exit(1)`: opening the inbox exited the whole
// application. This drives the real `readRaises` against a real file on
// disk, not a hand-built `ReadResult`, so it proves the two pieces actually
// fit together: the store's own record validation is what keeps this
// `render()` from ever seeing the malformed record in the first place.
describe("RaisesScreen survives a malformed record in the store", () => {
  test("a store with one malformed record renders the error instead of throwing", () => {
    const dir = mkdtempSync(join(tmpdir(), "jmux-raises-malformed-"));
    const raisesPath = join(dir, "raises.json");
    try {
      // `options: null` reproduces the actual crash: `buildCard` calls
      // `raise.options.forEach(...)` with nothing guarding against a
      // non-array, so without record validation this throws a raw
      // `TypeError` out of `render()` instead of ever reaching a `.error`
      // result.
      writeFileSync(
        raisesPath,
        JSON.stringify({
          version: 1,
          raises: [{ ...ISSUE_RAISE, options: null }],
        }),
      );

      const { port } = makePort(readRaises(raisesPath));
      const screen = new RaisesScreen();
      screen.open(port);

      expect(() => screen.render(100, 24)).not.toThrow();
      const text = extractText(screen.render(100, 24));
      expect(text).toContain("could not be read");
      expect(text).not.toContain("No open raises");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("raiseJumpTarget", () => {
  test("the jump target is the raise's session id, never its display name", () => {
    const scope: Extract<RaiseScope, { kind: "session" }> = {
      kind: "session",
      socket: "default",
      sessionId: "$42-the-real-id",
      sessionName: "totally-different-display-name",
      agentPane: null,
    };
    expect(raiseJumpTarget(scope)).toBe("$42-the-real-id");
    expect(raiseJumpTarget(scope)).not.toBe(scope.sessionName);
  });
});

describe("raisesFileTouched", () => {
  test("an unrelated file in the same directory is not a raises.json change", () => {
    expect(raisesFileTouched("config.json", "raises.json")).toBe(false);
  });

  test("raises.json itself is a raises.json change", () => {
    expect(raisesFileTouched("raises.json", "raises.json")).toBe(true);
  });

  test("a null filename (the OS didn't say what changed) cannot be ruled out", () => {
    expect(raisesFileTouched(null, "raises.json")).toBe(true);
  });

  test("wired into a real directory watcher: an unrelated write is not seen as a raises.json change, and a raises.json write is", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jmux-raises-watch-"));
    const raisesPath = join(dir, "raises.json");
    writeFileSync(raisesPath, JSON.stringify({ version: 1, raises: [] }));
    const raisesBase = basename(raisesPath);

    let touched = 0;
    const w = watch(dir, (_event, filename) => {
      if (raisesFileTouched(filename, raisesBase)) touched++;
    });
    try {
      await wait(300);
      touched = 0;

      writeFileSync(join(dir, "config.json"), "{}");
      await wait(300);
      expect(touched).toBe(0);

      writeFileSync(raisesPath, JSON.stringify({ version: 1, raises: [] }));
      await wait(300);
      expect(touched).toBeGreaterThan(0);
    } finally {
      w.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
