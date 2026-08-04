import { describe, test, expect } from "bun:test";
import { GhostPreview, type GhostPreviewPort, type StartOutcome } from "../ghost-preview";
import { buildPreflight, type Preflight } from "../ghost-preflight";
import type { Issue } from "../adapters/types";
import type { ResolvedRepoSettings } from "../repo-settings";

const SETTINGS: ResolvedRepoSettings = {
  defaultBaseBranch: "main",
  wtmIntegration: true,
  autoLaunchAgent: true,
  sessionNameTemplate: "{issue}",
  claudeCommand: "claude",
  onSessionStartState: null,
  onMrOpenState: null,
  onMrMergedState: null,
};

const ISSUE: Issue = {
  id: "i1", identifier: "ENG-412", title: "Fix drag throttling",
  status: "Todo", assignee: "jarred", linkedMrUrls: [], webUrl: "",
  team: "Core", priority: 2, updatedAt: 1000,
  description: "The divider drag fires a tmux resize per pointer event.",
};

const PREFLIGHT = buildPreflight({
  issueState: "none",
  linkedSessionName: undefined,
  repoDir: "/home/j/Code/jmux",
  sessionName: "eng-412-fix-drag",
  team: "Core",
  settings: SETTINGS,
  trackerPresent: true,
});

interface Calls {
  start: string[];
  open: string[];
  status: string[];
  attach: string[];
}

function makePort(over: Partial<GhostPreviewPort> = {}): { port: GhostPreviewPort; calls: Calls } {
  const calls: Calls = { start: [], open: [], status: [], attach: [] };
  const port: GhostPreviewPort = {
    getIssue: () => ISSUE,
    getPreflight: () => PREFLIGHT,
    onStart: async (id) => { calls.start.push(id); return "created"; },
    onOpenInBrowser: (id) => { calls.open.push(id); },
    onChangeStatus: (id) => { calls.status.push(id); },
    onAttachToSession: (id) => { calls.attach.push(id); },
    ...over,
  };
  return { port, calls };
}

const TARGET = { id: "i1", identifier: "ENG-412" };

function opened(over: Partial<GhostPreviewPort> = {}) {
  const { port, calls } = makePort(over);
  const screen = new GhostPreview();
  screen.open(port, TARGET);
  return { screen, port, calls };
}

function extractText(grid: { cells: Array<Array<{ char: string }>> }): string {
  return grid.cells.map((row) => row.map((c) => c.char).join("")).join("\n");
}

describe("open/close", () => {
  test("open records the target and close clears it", () => {
    const { screen } = opened();
    expect(screen.isOpen).toBe(true);
    expect(screen.getIssueId()).toBe("i1");
    screen.close();
    expect(screen.isOpen).toBe(false);
    expect(screen.getIssueId()).toBeNull();
  });

  test("Esc and q both close", () => {
    for (const key of ["\x1b", "q"]) {
      const { screen } = opened();
      screen.handleInput(key);
      expect(screen.isOpen).toBe(false);
    }
  });

  test("renders nothing but an empty grid when not open", () => {
    const screen = new GhostPreview();
    expect(extractText(screen.render(40, 10)).trim()).toBe("");
  });
});

describe("actions", () => {
  test("Enter starts, o opens in browser, s changes status — once each", () => {
    const { screen, calls } = opened();
    screen.handleInput("\r");
    screen.handleInput("o");
    screen.handleInput("s");
    expect(calls.start).toEqual(["i1"]);
    expect(calls.open).toEqual(["i1"]);
    expect(calls.status).toEqual(["i1"]);
  });

});

describe("start reentrancy", () => {
  test("ignores a second Enter until the first start settles", async () => {
    const started: string[] = [];
    let release: (o: StartOutcome) => void = () => {};
    const gate = new Promise<StartOutcome>((r) => { release = r; });

    const screen = new GhostPreview();
    screen.open(
      {
        getIssue: () => ISSUE,
        getPreflight: () => PREFLIGHT,
        onStart: (id) => { started.push(id); return gate; },
        onOpenInBrowser: () => {},
        onChangeStatus: () => {},
      onAttachToSession: () => {},
      },
      TARGET,
    );

    screen.handleInput("\r");
    screen.handleInput("\r");
    screen.handleInput("\r");
    expect(started).toEqual(["i1"]);

    release("failed");
    await gate;
    await Promise.resolve();

    screen.handleInput("\r");
    expect(started).toEqual(["i1", "i1"]);
  });

  test("the action bar says Starting… while in flight", () => {
    const screen = new GhostPreview();
    screen.open(
      {
        getIssue: () => ISSUE,
        getPreflight: () => PREFLIGHT,
        onStart: () => new Promise<StartOutcome>(() => {}),
        onOpenInBrowser: () => {},
        onChangeStatus: () => {},
      onAttachToSession: () => {},
      },
      TARGET,
    );
    screen.handleInput("\r");
    expect(extractText(screen.render(80, 20))).toContain("Starting…");
  });
});

describe("start outcomes", () => {
  const cases: Array<[StartOutcome, boolean]> = [
    ["switched", false],
    ["created", false],
    ["handed-off", true],
    ["failed", true],
    ["gone", true],
  ];

  for (const [outcome, staysOpen] of cases) {
    test(`${outcome} ${staysOpen ? "leaves the surface open" : "closes the surface"}`, async () => {
      const screen = new GhostPreview();
      let settle: () => void = () => {};
      const done = new Promise<void>((r) => { settle = r; });
      screen.open(
        {
          getIssue: () => ISSUE,
          getPreflight: () => PREFLIGHT,
          onStart: async () => { queueMicrotask(settle); return outcome; },
          onOpenInBrowser: () => {},
          onChangeStatus: () => {},
      onAttachToSession: () => {},
        },
        TARGET,
      );
      screen.handleInput("\r");
      await done;
      await Promise.resolve();
      expect(screen.isOpen).toBe(staysOpen);
    });
  }

  test("a throwing onStart is treated as failed and leaves the surface open", async () => {
    const screen = new GhostPreview();
    screen.open(
      {
        getIssue: () => ISSUE,
        getPreflight: () => PREFLIGHT,
        onStart: async () => { throw new Error("boom"); },
        onOpenInBrowser: () => {},
        onChangeStatus: () => {},
      onAttachToSession: () => {},
      },
      TARGET,
    );
    screen.handleInput("\r");
    await Promise.resolve();
    await Promise.resolve();
    expect(screen.isOpen).toBe(true);
  });
});

describe("render", () => {
  test("shows the issue, the pre-flight and the action bar", () => {
    const { screen } = opened();
    const text = extractText(screen.render(80, 24));
    expect(text).toContain("ENG-412");
    expect(text).toContain("Fix drag throttling");
    expect(text).toContain("Starting will create");
    expect(text).toContain("eng-412-fix-drag");
    expect(text).toContain("Status");
    expect(text).toContain("Back");
  });

  test("the primary action label follows the pre-flight action", () => {
    const resume: Preflight = { action: "resume", plan: PREFLIGHT.plan };
    const { screen } = opened({ getPreflight: () => resume });
    expect(extractText(screen.render(80, 24))).toContain("Resume");

    const sw: Preflight = { action: "switch", plan: { kind: "existing", sessionName: "eng-412" } };
    const { screen: s2 } = opened({ getPreflight: () => sw });
    expect(extractText(s2.render(80, 24))).toContain("Switch");
  });

  test("renders without the pre-flight block when none resolves", () => {
    const { screen } = opened({ getPreflight: () => null });
    const text = extractText(screen.render(80, 24));
    expect(text).toContain("Fix drag throttling");
    expect(text).not.toContain("Starting will create");
  });
});

describe("gone state", () => {
  test("shows the cached identifier, since the port can no longer supply it", () => {
    const { screen } = opened({ getIssue: () => null });
    const text = extractText(screen.render(80, 24));
    expect(text).toContain("ENG-412");
    expect(text).toContain("no longer available");
  });

  test("offers only Back", () => {
    const { screen } = opened({ getIssue: () => null });
    const text = extractText(screen.render(80, 24));
    expect(text).toContain("Back");
    expect(text).not.toContain("Status");
  });

  test("Enter, o and s are inert; Esc still works", () => {
    const { screen, calls } = opened({ getIssue: () => null });
    screen.handleInput("\r");
    screen.handleInput("o");
    screen.handleInput("s");
    expect(calls.start).toEqual([]);
    expect(calls.open).toEqual([]);
    expect(calls.status).toEqual([]);
    screen.handleInput("\x1b");
    expect(screen.isOpen).toBe(false);
  });
});

describe("scrolling", () => {
  const longIssue: Issue = {
    ...ISSUE,
    description: Array.from({ length: 200 }, (_, i) => `paragraph ${i}`).join("\n\n"),
  };

  test("scrolls down and back up, clamping at the top", () => {
    const { screen } = opened({ getIssue: () => longIssue });
    screen.render(80, 24);
    const top = extractText(screen.render(80, 24));

    screen.handleInput("\x1b[B");
    screen.handleInput("\x1b[B");
    expect(extractText(screen.render(80, 24))).not.toBe(top);

    for (let i = 0; i < 10; i++) screen.handleInput("\x1b[A");
    expect(extractText(screen.render(80, 24))).toBe(top);
  });

  test("page keys move by a screenful", () => {
    const { screen } = opened({ getIssue: () => longIssue });
    screen.render(80, 24);
    screen.handleInput("\x1b[6~");
    const paged = extractText(screen.render(80, 24));
    screen.handleInput("\x1b[5~");
    const back = extractText(screen.render(80, 24));
    expect(paged).not.toBe(back);
  });

  test("still paints content after a resize that shortens the document", () => {
    // The offset that was valid at 40 columns can be past the end at 200,
    // where the description wraps into far fewer lines.
    const { screen } = opened({ getIssue: () => longIssue });
    screen.render(40, 24);
    for (let i = 0; i < 300; i++) screen.handleInput("\x1b[B");
    screen.render(40, 24);

    const wide = extractText(screen.render(200, 24));
    expect(wide.trim()).not.toBe("");
    expect(wide).toContain("paragraph");
  });

  test("open resets the scroll offset", () => {
    const { screen, port } = opened({ getIssue: () => longIssue });
    screen.render(80, 24);
    for (let i = 0; i < 5; i++) screen.handleInput("\x1b[B");
    const scrolled = extractText(screen.render(80, 24));

    screen.open(port, TARGET);
    expect(extractText(screen.render(80, 24))).not.toBe(scrolled);
  });
});
