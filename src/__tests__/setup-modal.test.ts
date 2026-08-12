import { describe, expect, test } from "bun:test";
import { SetupModal, type SetupRow } from "../setup-modal";

// Detectors are injected, so nothing here touches ~ or the real filesystem —
// the modal itself owns no knowledge of agents, adapters or config.

function rowsFixture(overrides: Partial<Record<string, SetupRow["state"]>> = {}): SetupRow[] {
  const mk = (id: string, label: string, state: SetupRow["state"], note?: string): SetupRow => ({
    id, label, detail: `what ${id} gets you`, state: overrides[id] ?? state, note,
  });
  return [
    mk("agent-hooks", "Agent status in the sidebar", "todo", "2 to set up"),
    mk("agent-skill", "Teach agents the jmux CLI", "done"),
    mk("tracker", "Connect an issue tracker", "todo", "not connected"),
    mk("hunk", "Install the diff viewer", "unavailable", "npm i -g hunkdiff"),
  ];
}

function build(opts: {
  rows?: SetupRow[];
  onActivate?: (id: string) => void;
  live?: () => SetupRow[];
} = {}) {
  const activated: string[] = [];
  const modal = new SetupModal({
    rows: opts.live ?? (() => opts.rows ?? rowsFixture()),
    onActivate: (id) => {
      activated.push(id);
      opts.onActivate?.(id);
    },
  });
  modal.open();
  return { modal, activated };
}

const gridText = (modal: SetupModal, width = 64): string =>
  modal.getGrid(width).cells.map((r) => r.map((c) => c.char).join("")).join("\n");

describe("SetupModal rows", () => {
  test("reads its rows from the provider", () => {
    const { modal } = build();
    expect(modal.getRows().map((r) => r.id)).toEqual([
      "agent-hooks", "agent-skill", "tracker", "hunk",
    ]);
  });

  test("paints a distinct glyph per state", () => {
    const text = gridText(build().modal);
    expect(text).toContain("✓"); // done
    expect(text).toContain("○"); // todo
    expect(text).toContain("—"); // unavailable
  });

  test("the count reports done out of what is actually actionable", () => {
    // `hunk` is unavailable — jmux cannot install it — so counting it against
    // the user would leave a checklist that can never reach completion.
    const text = gridText(build().modal);
    expect(text).toContain("1/3 done");
  });

  test("notes are painted so a row says what is missing", () => {
    const text = gridText(build().modal);
    expect(text).toContain("not connected");
    expect(text).toContain("npm i -g hunkdiff");
  });

  test("the selected row's detail is shown", () => {
    const { modal } = build();
    expect(gridText(modal)).toContain("what agent-hooks gets you");
    modal.handleInput("\x1b[B");
    expect(gridText(modal)).toContain("what agent-skill gets you");
  });
});

describe("SetupModal activation", () => {
  test("Enter on a todo row runs its action", () => {
    const { modal, activated } = build();
    modal.handleInput("\r");
    expect(activated).toEqual(["agent-hooks"]);
  });

  test("Enter on a done row is inert", () => {
    // Repeating completed work invisibly is worse than doing nothing: the user
    // cannot tell the two apart, which is the doubt this screen removes.
    const { modal, activated } = build();
    modal.handleInput("\x1b[B"); // agent-skill, done
    modal.handleInput("\r");
    expect(activated).toEqual([]);
  });

  test("Enter on an unavailable row is inert", () => {
    const { modal, activated } = build();
    for (let i = 0; i < 3; i++) modal.handleInput("\x1b[B"); // hunk
    modal.handleInput("\r");
    expect(activated).toEqual([]);
  });

  test("a row ticks over under the cursor once its action succeeds", () => {
    // The re-derive after activation is the entire feedback for the keypress.
    let installed = false;
    const { modal } = build({
      live: () => rowsFixture(installed ? { "agent-hooks": "done" } : {}),
      onActivate: () => { installed = true; },
    });
    expect(modal.getRows()[0].state).toBe("todo");
    modal.handleInput("\r");
    expect(modal.getRows()[0].state).toBe("done");
  });

  test("state is never stored — an external change shows up on reopen", () => {
    let connected = false;
    const modal = new SetupModal({
      rows: () => rowsFixture(connected ? { tracker: "done" } : {}),
      onActivate: () => {},
    });
    modal.open();
    expect(modal.getRows().find((r) => r.id === "tracker")!.state).toBe("todo");
    modal.close();
    connected = true; // e.g. a token exported and the tracker connected
    modal.open();
    expect(modal.getRows().find((r) => r.id === "tracker")!.state).toBe("done");
  });
});

describe("SetupModal input", () => {
  test("escape and q both close", () => {
    for (const key of ["\x1b", "q"]) {
      const { modal } = build();
      expect(modal.handleInput(key)).toEqual({ type: "closed" });
      expect(modal.isOpen()).toBe(false);
    }
  });

  test("selection wraps in both directions", () => {
    const { modal } = build();
    expect(modal.getSelectedIndex()).toBe(0);
    modal.handleInput("\x1b[A");
    expect(modal.getSelectedIndex()).toBe(3);
    modal.handleInput("\x1b[B");
    expect(modal.getSelectedIndex()).toBe(0);
  });

  test("j and k move too", () => {
    const { modal } = build();
    modal.handleInput("j");
    expect(modal.getSelectedIndex()).toBe(1);
    modal.handleInput("k");
    expect(modal.getSelectedIndex()).toBe(0);
  });
});

describe("SetupModal layout", () => {
  test("an empty checklist says so rather than painting a blank box", () => {
    const { modal } = build({ rows: [] });
    expect(gridText(modal)).toContain("Nothing to set up");
  });

  for (const width of [52, 64, 78]) {
    test(`every row fits the grid at width ${width}`, () => {
      const { modal } = build();
      const grid = modal.getGrid(width);
      for (const row of grid.cells) expect(row.length).toBe(width);
    });
  }

  test("a long label never squeezes out the note", () => {
    const { modal } = build({
      rows: [{
        id: "x",
        label: "An extremely long setup row label that would happily run past the edge",
        detail: "d",
        state: "todo",
        note: "not connected",
      }],
    });
    expect(gridText(modal, 52)).toContain("not connected");
  });

  test("the grid is exactly as tall as it claims", () => {
    const { modal } = build();
    expect(modal.getGrid(64).rows).toBe(modal.getHeight());
  });
});

describe("SetupModal in a short terminal", () => {
  const many = (n: number): SetupRow[] =>
    Array.from({ length: n }, (_, i) => ({
      id: `row-${i}`, label: `Setup step ${i}`, detail: `detail ${i}`, state: "todo" as const,
    }));

  test("never grows taller than the terminal", () => {
    for (const termRows of [12, 16, 24, 40]) {
      const modal = new SetupModal({ rows: () => many(20), onActivate: () => {} });
      modal.setTermRows(termRows);
      modal.open();
      expect(modal.getHeight()).toBeLessThanOrEqual(termRows);
    }
  });

  test("says how many rows it could not show, rather than dropping them silently", () => {
    // A setup step the user cannot see is a setup step they will not do.
    const modal = new SetupModal({ rows: () => many(20), onActivate: () => {} });
    modal.setTermRows(14);
    modal.open();
    expect(gridText(modal)).toContain("more");
  });

  test("shows every row when they all fit", () => {
    const modal = new SetupModal({ rows: () => many(4), onActivate: () => {} });
    modal.setTermRows(40);
    modal.open();
    const text = gridText(modal);
    for (let i = 0; i < 4; i++) expect(text).toContain(`Setup step ${i}`);
    expect(text).not.toContain("and 1 more");
  });
});

describe("SetupModal activation that hands off", () => {
  test("does not re-derive rows when the action closed the modal", () => {
    // Every detector hits the filesystem; there is no one left to show it to.
    let derives = 0;
    const modal = new SetupModal({
      rows: () => { derives++; return rowsFixture(); },
      onActivate: () => { modal.close(); },
    });
    modal.open();
    const afterOpen = derives;
    modal.handleInput("\r");
    expect(derives).toBe(afterOpen);
  });
});

describe("SetupModal hidden-row accounting", () => {
  const many = (n: number): SetupRow[] =>
    Array.from({ length: n }, (_, i) => ({
      id: `row-${i}`, label: `Setup step ${i}`, detail: `detail ${i}`, state: "todo" as const,
    }));

  const cramped = (total: number, termRows: number) => {
    const modal = new SetupModal({ rows: () => many(total), onActivate: () => {} });
    modal.setTermRows(termRows);
    modal.open();
    return modal;
  };

  test("the notice counts every row it did not paint", () => {
    // The notice occupies a row slot itself, so counting against the slots
    // rather than the painted rows undercounts by exactly one.
    for (const termRows of [13, 14, 16, 20]) {
      const modal = cramped(20, termRows);
      const text = modal.getGrid(64).cells.map((r) => r.map((c) => c.char).join("")).join("\n");
      const painted = many(20).filter((r) => text.includes(r.label)).length;
      const claimed = Number(/…and (\d+) more/.exec(text)?.[1] ?? -1);
      expect(claimed).toBe(20 - painted);
    }
  });

  test("selection never leaves the rows that were painted", () => {
    const modal = cramped(20, 14);
    const text = () => modal.getGrid(64).cells.map((r) => r.map((c) => c.char).join("")).join("\n");
    const painted = many(20).filter((r) => text().includes(r.label)).length;
    for (let i = 0; i < 40; i++) {
      modal.handleInput("\x1b[B");
      expect(modal.getSelectedIndex()).toBeLessThan(painted);
    }
    for (let i = 0; i < 40; i++) {
      modal.handleInput("\x1b[A");
      expect(modal.getSelectedIndex()).toBeGreaterThanOrEqual(0);
    }
  });

  test("the selected row's detail always describes a visible row", () => {
    const modal = cramped(20, 14);
    for (let i = 0; i < 10; i++) {
      modal.handleInput("\x1b[B");
      const text = modal.getGrid(64).cells.map((r) => r.map((c) => c.char).join("")).join("\n");
      const shown = /detail (\d+)/.exec(text);
      expect(shown).not.toBeNull();
      expect(text).toContain(`Setup step ${shown![1]}`);
    }
  });
});

// --- Sequencing ---
//
// A flat checklist gives every step the same weight, so "Connect an issue
// tracker" and "Attach a team" look equally available when the second cannot
// be done until the first is. `blocked` names what has to come first.

function sequencedRows(): SetupRow[] {
  return [
    { id: "tracker", label: "Connect an issue tracker", detail: "d", state: "todo" },
    { id: "team", label: "Attach a team", detail: "d", state: "blocked", dependsOn: ["tracker"] },
    { id: "workflow", label: "Your workflow", detail: "d", state: "blocked", dependsOn: ["tracker"] },
    { id: "hunk", label: "Install the diff viewer", detail: "d", state: "unavailable" },
  ];
}

describe("SetupModal blocked steps", () => {
  test("a blocked row is not counted as actionable", () => {
    const { modal } = build({ rows: sequencedRows() });
    modal.open();
    const grid = modal.getGrid(60);
    const text = grid.cells.map((r) => r.map((c) => c.char).join("")).join("\n");
    // One actionable step (tracker); blocked and unavailable are both inert.
    expect(text).toContain("0/1 done");
  });

  test("Enter on a blocked row does nothing", () => {
    const { modal, activated } = build({ rows: sequencedRows() });
    modal.open();
    modal.handleInput("\x1b[B");        // onto "Attach a team"
    modal.handleInput("\r");
    expect(activated).toEqual([]);
  });

  test("Enter on a todo row still activates", () => {
    const { modal, activated } = build({ rows: sequencedRows() });
    modal.open();
    modal.handleInput("\r");
    expect(activated).toEqual(["tracker"]);
  });

  test("a blocked row names what must come first", () => {
    const { modal } = build({ rows: sequencedRows() });
    modal.open();
    modal.handleInput("\x1b[B");
    const grid = modal.getGrid(60);
    const text = grid.cells.map((r) => r.map((c) => c.char).join("")).join("\n");
    expect(text).toContain("Connect an issue tracker");
  });

  test("blocked and unavailable render differently from each other", () => {
    const { modal } = build({ rows: sequencedRows() });
    modal.open();
    const grid = modal.getGrid(60);
    const rows = grid.cells.map((r) => r.map((c) => c.char).join(""));
    const blocked = rows.find((r) => r.includes("Attach a team"))!;
    const unavailable = rows.find((r) => r.includes("Install the diff viewer"))!;
    expect(blocked.trimStart()[0]).not.toBe(unavailable.trimStart()[0]);
  });
});

// --- Async activation ---
//
// onActivate was synchronous `void`, so anything that finishes later — a
// credential write, an auth round-trip — could never tick its own row over.
// The wizard's most important step would appear to do nothing.
describe("SetupModal async activation", () => {
  test("refreshes after an activation that resolves later", async () => {
    let done = false;
    const modal = new SetupModal({
      rows: () => [{
        id: "tracker",
        label: "Connect an issue tracker",
        detail: "d",
        state: done ? "done" : "todo",
      }],
      onActivate: async () => {
        await new Promise((r) => setTimeout(r, 5));
        done = true;
      },
    });
    modal.open();
    expect(modal.getRows()[0].state).toBe("todo");
    modal.handleInput("\r");
    // Not yet — the work has not finished.
    expect(modal.getRows()[0].state).toBe("todo");
    await new Promise((r) => setTimeout(r, 25));
    expect(modal.getRows()[0].state).toBe("done");
  });

  test("a synchronous activation still refreshes immediately", () => {
    let done = false;
    const modal = new SetupModal({
      rows: () => [{ id: "x", label: "X", detail: "d", state: done ? "done" : "todo" }],
      onActivate: () => { done = true; },
    });
    modal.open();
    modal.handleInput("\r");
    expect(modal.getRows()[0].state).toBe("done");
  });

  test("an activation that rejects does not throw out of handleInput", async () => {
    const modal = new SetupModal({
      rows: () => [{ id: "x", label: "X", detail: "d", state: "todo" }],
      onActivate: async () => { throw new Error("boom"); },
    });
    modal.open();
    expect(() => modal.handleInput("\r")).not.toThrow();
    await new Promise((r) => setTimeout(r, 10));
  });

  test("a late activation does not refresh a closed modal", async () => {
    let calls = 0;
    const modal = new SetupModal({
      rows: () => { calls++; return [{ id: "x", label: "X", detail: "d", state: "todo" }]; },
      onActivate: async () => { await new Promise((r) => setTimeout(r, 5)); },
    });
    modal.open();
    modal.handleInput("\r");
    modal.close();
    const after = calls;
    await new Promise((r) => setTimeout(r, 25));
    expect(calls).toBe(after);
  });
});
