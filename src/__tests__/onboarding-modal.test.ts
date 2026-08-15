import { describe, expect, test } from "bun:test";
import { deriveStatus, type SetupFacts } from "../onboarding/status";
import { OnboardingModal, type OnboardingPort } from "../onboarding/modal";
import type { InstallReport } from "../agent-hooks/registry";

const facts: SetupFacts = {
  agentsPresent: ["Claude Code"], agentsStale: ["Claude Code"], skillCurrent: false,
  namingConfigured: false, namingDeclined: false, namingAvailable: ["claude"],
  trackerType: "linear", trackerAuthed: false, trackerDeclined: false,
  projectCount: 0, attachedTeamCount: 0, workflowTabCount: 0, hunkInstalled: false,
};

const DOWN = "\x1b[B";
const RIGHT = "\x1b[C";
const LEFT = "\x1b[D";
const ESC = "\x1b";

function makePort(over: Partial<OnboardingPort> = {}) {
  const calls = {
    installAgents: 0, addProjectDir: [] as string[], connectTracker: [] as string[],
    seedWorkflow: 0, finish: 0, changes: 0, setNaming: [] as string[],
  };
  const port: OnboardingPort = {
    getStatus: () => deriveStatus(facts),
    getProjectDirs: () => [],
    agentWriteTargets: () => ["/tmp/claude/settings.json"],
    installAgents: async () => { calls.installAgents += 1; return []; },
    addProjectDir: async (d) => { calls.addProjectDir.push(d); return { ok: true }; },
    suggestedProjectDir: () => "~/Code",
    trackerName: () => "Linear",
    namingOptions: () => [
      { id: "claude", label: "claude", note: "Around 11s." },
      { id: "off", label: "Leave sessions unnamed", note: "the branch name" },
    ],
    namingChosen: () => "off",
    setNaming: (id) => { calls.setNaming.push(id); },
    connectTracker: async (t) => { calls.connectTracker.push(t); return { ok: true }; },
    seedWorkflow: () => { calls.seedWorkflow += 1; },
    finish: () => { calls.finish += 1; },
    achievements: () => [],
    onChange: () => { calls.changes += 1; },
    ...over,
  };
  return { port, calls };
}

/** Open on the projects page of the solo arm. */
function onProjects(over: Partial<OnboardingPort> = {}) {
  const { port, calls } = makePort(over);
  const modal = new OnboardingModal(port);
  modal.open();
  modal.handleInput("\r");   // choose "Just run agents"
  return { modal, calls };
}

describe("OnboardingModal — the Modal contract", () => {
  test("implements every member the renderer and router call", () => {
    const { port } = makePort();
    const modal = new OnboardingModal(port);
    modal.open();
    expect(modal.isOpen()).toBe(true);
    expect(typeof modal.preferredWidth(120)).toBe("number");
    expect(modal.getGrid(80).cols).toBe(80);
    expect(modal.getCursorPosition()).toBeNull();
    modal.close();
    expect(modal.isOpen()).toBe(false);
  });

  // Every other modal is closed by SIGWINCH. This one has steps behind it and
  // possibly a half-typed token, so it opts in to re-laying out instead.
  test("survives resize rather than being closed", () => {
    const { port } = makePort();
    const modal = new OnboardingModal(port);
    modal.open();
    modal.handleInput("\r");
    expect(typeof modal.onResize).toBe("function");
    modal.onResize!(120, 40);
    expect(modal.isOpen()).toBe(true);
    expect(modal.currentPageId()).toBe("projects");
  });

  test("a taller terminal yields a taller grid", () => {
    const { port } = makePort();
    const modal = new OnboardingModal(port);
    modal.open();
    modal.onResize!(80, 20);
    const short = modal.getGrid(80).rows;
    modal.onResize!(80, 44);
    expect(modal.getGrid(80).rows).toBeGreaterThan(short);
  });
});

describe("OnboardingModal — intent", () => {
  test("Enter on the welcome page commits the highlighted intent", () => {
    const { modal } = onProjects();
    expect(modal.currentPageId()).toBe("projects");
  });

  test("the second intent opens the tracker arm", () => {
    const { port } = makePort();
    const modal = new OnboardingModal(port);
    modal.open();
    modal.handleInput(DOWN);
    modal.handleInput("\r");
    for (let i = 0; i < 3; i++) modal.handleInput(RIGHT);
    expect(modal.currentPageId()).toBe("tracker");
  });

  test("j/k choose an intent and h/l change pages", () => {
    const { port } = makePort();
    const modal = new OnboardingModal(port);
    modal.open();
    modal.handleInput("j");
    modal.handleInput("k");
    modal.handleInput("\r");
    expect(modal.currentPageId()).toBe("projects");
    modal.handleInput("l");
    expect(modal.currentPageId()).not.toBe("projects");
    modal.handleInput("h");
    expect(modal.currentPageId()).toBe("projects");
  });

  test("the third intent lands on the map with nothing configured", () => {
    const { port, calls } = makePort();
    const modal = new OnboardingModal(port);
    modal.open();
    modal.handleInput(DOWN); modal.handleInput(DOWN);
    modal.handleInput("\r");
    expect(modal.view()).toBe("map");
    expect(calls.addProjectDir).toEqual([]);
    expect(calls.installAgents).toBe(0);
  });
});

describe("OnboardingModal — hosted collectors", () => {
  // The capability the composite exists to buy: a step that needs input does
  // not have to destroy the flow to ask for it.
  test("Enter opens a collector, which then receives the keys", () => {
    const { modal } = onProjects();
    modal.handleInput("\r");
    expect(modal.hasChild()).toBe(true);
    for (const ch of "/tmp") modal.handleInput(ch);
    expect(modal.childValue()).toBe("~/Code/tmp");
  });

  // Placeholder text sitting where the value goes reads as a filled field, so
  // Enter looks like it should commit — and an empty commit is refused in
  // silence, so the flow looks hung. The default is a real value instead.
  test("the directory collector opens on a real, committable default", async () => {
    const { modal, calls } = onProjects();
    modal.handleInput("\r");
    expect(modal.childValue()).toBe("~/Code");
    modal.handleInput("\r");
    await Bun.sleep(1);
    expect(calls.addProjectDir).toEqual(["~/Code"]);
  });

  test("the flow is still open underneath, and the grid is the collector's", () => {
    const { modal } = onProjects();
    modal.handleInput("\r");
    expect(modal.isOpen()).toBe(true);
    expect(modal.getCursorPosition()).not.toBeNull();
  });

  test("esc pops the collector, not the flow", () => {
    const { modal } = onProjects();
    modal.handleInput("\r");
    expect(modal.handleInput(ESC)).toEqual({ type: "consumed" });
    expect(modal.hasChild()).toBe(false);
    expect(modal.isOpen()).toBe(true);
    expect(modal.currentPageId()).toBe("projects");
  });

  test("committing a collector delivers the edited value to the port", async () => {
    const { modal, calls } = onProjects();
    modal.handleInput("\r");
    for (let i = 0; i < 6; i++) modal.handleInput("\x7f");   // clear the default
    for (const ch of "/srv") modal.handleInput(ch);
    modal.handleInput("\r");
    await Bun.sleep(1);
    expect(calls.addProjectDir).toEqual(["/srv"]);
  });

  // The bug as reported: the page looked stuck because the refusal was
  // announced in the toolbar's status chip, at the far end of the screen.
  test("a rejected directory says so on the page, not somewhere else", async () => {
    const { modal } = onProjects({
      addProjectDir: async () => ({ ok: false, message: "No such directory: ~/Code" }),
    });
    modal.handleInput("\r");
    modal.handleInput("\r");
    await Bun.sleep(2);
    const text = modal.getGrid(90).cells.map((r) => r.map((c) => c.char).join("")).join("\n");
    expect(text).toContain("No such directory: ~/Code");
  });

  test("moving off the page clears a stale refusal", async () => {
    const { modal } = onProjects({
      addProjectDir: async () => ({ ok: false, message: "No such directory: ~/Code" }),
    });
    modal.handleInput("\r");
    modal.handleInput("\r");
    await Bun.sleep(2);
    modal.handleInput(RIGHT);
    const text = modal.getGrid(90).cells.map((r) => r.map((c) => c.char).join("")).join("\n");
    expect(text).not.toContain("No such directory");
  });

  test("the token collector is masked", () => {
    const { port } = makePort();
    const modal = new OnboardingModal(port);
    modal.open();
    modal.handleInput(DOWN); modal.handleInput("\r");
    for (let i = 0; i < 3; i++) modal.handleInput(RIGHT);
    expect(modal.currentPageId()).toBe("tracker");
    modal.handleInput("\r");
    for (const ch of "lin_secret") modal.handleInput(ch);
    const row = modal.getGrid(60).cells[2]!.map((c) => c.char).join("");
    expect(row).not.toContain("lin_secret");
    expect(row).toContain("••••••••••");
  });
});

describe("OnboardingModal — zoom out", () => {
  test("esc goes to the map, and again closes", () => {
    const { modal } = onProjects();
    expect(modal.handleInput(ESC)).toEqual({ type: "consumed" });
    expect(modal.view()).toBe("map");
    expect(modal.handleInput(ESC)).toEqual({ type: "closed" });
    expect(modal.isOpen()).toBe(false);
  });

  test("Enter on the map reopens that step", () => {
    const { modal } = onProjects();
    modal.handleInput(ESC);
    modal.handleInput(DOWN);
    modal.handleInput("\r");
    expect(modal.view()).toBe("page");
    expect(modal.currentPageId()).toBe("agents");
  });
});

describe("OnboardingModal — async actions", () => {
  test("a duplicate Enter while busy does not run the action twice", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    let started = 0;
    const { modal } = onProjects({
      installAgents: async () => { started += 1; await gate; return []; },
    });
    modal.handleInput(RIGHT);
    expect(modal.currentPageId()).toBe("agents");
    modal.handleInput("\r");
    modal.handleInput("\r");
    modal.handleInput("\r");
    expect(started).toBe(1);
    release();
    await Bun.sleep(1);
  });

  test("navigation is locked while an action runs, then released", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const { modal } = onProjects({
      installAgents: async () => { await gate; return []; },
    });
    modal.handleInput(RIGHT);
    modal.handleInput("\r");
    modal.handleInput(RIGHT);
    expect(modal.currentPageId()).toBe("agents");
    release();
    await Bun.sleep(1);
    modal.handleInput(RIGHT);
    expect(modal.currentPageId()).toBe("naming");
  });

  test("install results are kept and rendered rather than printed", async () => {
    const reports: InstallReport[] = [
      { label: "Claude Code", kind: "installed", notes: [] },
      { label: "hunk-review skill", kind: "skipped", notes: ["hunk not installed"] },
    ];
    const { modal } = onProjects({ installAgents: async () => reports });
    modal.handleInput(RIGHT);
    modal.handleInput("\r");
    await Bun.sleep(1);
    expect(modal.getReports()).toEqual(reports);
    const text = modal.getGrid(90).cells.map((r) => r.map((c) => c.char).join("")).join("\n");
    expect(text).toContain("hunk not installed");
  });

  test("the port is told to repaint when work lands after the keypress", async () => {
    const { modal, calls } = onProjects();
    modal.handleInput(RIGHT);
    modal.handleInput("\r");
    await Bun.sleep(1);
    expect(calls.changes).toBeGreaterThanOrEqual(2);
  });
});

describe("OnboardingModal — the painter never asks the world", () => {
  // getGrid runs on every frame. agentWriteTargets stats each agent's config
  // and achievements re-reads the skill file and probes PATH, so asking the
  // port from inside the painter put all of that on the render loop's cadence
  // — the exact cost the checklist this replaced documented avoiding.
  test("repainting does not re-ask the port", () => {
    let asks = 0;
    const { port } = makePort({
      agentWriteTargets: () => { asks += 1; return []; },
      achievements: () => { asks += 1; return []; },
      getProjectDirs: () => { asks += 1; return []; },
    });
    const modal = new OnboardingModal(port);
    modal.open();
    const afterOpen = asks;

    for (let i = 0; i < 60; i++) modal.getGrid(90);
    expect(asks).toBe(afterOpen);
  });

  test("but an action resolving does", async () => {
    let asks = 0;
    const { port } = makePort({ achievements: () => { asks += 1; return []; } });
    const modal = new OnboardingModal(port);
    modal.open();
    modal.handleInput("\r");
    const before = asks;
    modal.handleInput("\x1b[C");
    modal.handleInput("\r");
    await Bun.sleep(2);
    expect(asks).toBeGreaterThan(before);
  });

  // It is constructed on every boot; most boots never open it.
  test("constructing asks the port for nothing at all", () => {
    let asks = 0;
    const { port } = makePort({
      getStatus: () => { asks += 1; return deriveStatus(facts); },
      agentWriteTargets: () => { asks += 1; return []; },
      achievements: () => { asks += 1; return []; },
      getProjectDirs: () => { asks += 1; return []; },
    });
    new OnboardingModal(port);
    expect(asks).toBe(0);
  });
});

describe("OnboardingModal — naming", () => {
  test("Enter opens the picker and the choice reaches the port", () => {
    const { modal, calls } = onProjects();
    modal.handleInput(RIGHT); modal.handleInput(RIGHT);
    expect(modal.currentPageId()).toBe("naming");
    modal.handleInput("\r");
    expect(modal.hasChild()).toBe(true);
    modal.handleInput("\r");
    expect(calls.setNaming).toEqual(["claude"]);
    expect(modal.hasChild()).toBe(false);
  });

  test("esc leaves the picker without choosing", () => {
    const { modal, calls } = onProjects();
    modal.handleInput(RIGHT); modal.handleInput(RIGHT);
    modal.handleInput("\r");
    modal.handleInput(ESC);
    expect(modal.hasChild()).toBe(false);
    expect(calls.setNaming).toEqual([]);
    expect(modal.isOpen()).toBe(true);
  });

  // A hand-written command has no preset row, so nothing ticked and picking a
  // preset replaced it without a word.
  test("a custom command is listed, so it can be seen and kept", () => {
    const { modal, calls } = onProjects({
      namingOptions: () => [
        { id: "custom", label: "my-namer --fast", note: "your own command — keep it" },
        { id: "claude", label: "claude", note: "Around 11s." },
        { id: "off", label: "Leave sessions unnamed", note: "the branch name" },
      ],
      namingChosen: () => "custom",
    });
    modal.handleInput(RIGHT); modal.handleInput(RIGHT);
    const text = modal.getGrid(90).cells.map((r) => r.map((c) => c.char).join("")).join("\n");
    expect(text).toContain("my-namer --fast");

    modal.handleInput("\r");
    modal.handleInput("\r");
    expect(calls.setNaming).toEqual(["custom"]);
  });

  test("no available command means no picker at all", () => {
    const { modal, calls } = onProjects({ namingOptions: () => [] });
    modal.handleInput(RIGHT); modal.handleInput(RIGHT);
    modal.handleInput("\r");
    expect(modal.hasChild()).toBe(false);
    expect(calls.setNaming).toEqual([]);
  });
});

describe("OnboardingModal — finish", () => {
  test("Enter on the done page hands off and closes", () => {
    const { modal, calls } = onProjects();
    for (let i = 0; i < 10; i++) modal.handleInput(RIGHT);
    expect(modal.currentPageId()).toBe("done");
    expect(modal.handleInput("\r")).toEqual({ type: "consumed" });
    expect(calls.finish).toBe(1);
    expect(modal.isOpen()).toBe(false);
  });

  test("back from done returns to the last step", () => {
    const { modal } = onProjects();
    for (let i = 0; i < 10; i++) modal.handleInput(RIGHT);
    modal.handleInput(LEFT);
    expect(modal.currentPageId()).toBe("naming");
  });
});
