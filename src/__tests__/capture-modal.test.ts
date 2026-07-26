import { describe, test, expect } from "bun:test";
import { CaptureModal, type CaptureResult } from "../capture-modal";
import type { CellGrid } from "../types";
import { InputRouter } from "../input-router";
import { computeFrameLayout } from "../frame-layout";

const TEAMS = [
  { id: "t-plat", name: "Platform" },
  { id: "t-web", name: "Web" },
];

function modal(preselect: string | null = null): CaptureModal {
  const m = new CaptureModal({ teams: TEAMS, preselectedTeamId: preselect });
  m.open();
  return m;
}

function type(m: CaptureModal, s: string): void {
  for (const ch of s) m.handleInput(ch);
}

function text(grid: CellGrid): string {
  return Array.from({ length: grid.rows }, (_, r) =>
    Array.from({ length: grid.cols }, (_, c) => grid.cells[r][c].char).join("")).join("\n");
}

describe("CaptureModal commit keys", () => {
  // The whole point of the composer: one form, two commit points. Enter files
  // the issue and leaves you where you are; Ctrl-S files it and drops you into
  // a session working on it.
  test("Enter captures without starting", () => {
    const m = modal("t-plat");
    type(m, "Fix auth timeout");
    const action = m.handleInput("\r");
    expect(action.type).toBe("result");
    const r = (action as { value: CaptureResult }).value;
    expect(r).toEqual({ mode: "capture", teamId: "t-plat", title: "Fix auth timeout", description: "" });
  });

  test("Ctrl-S captures and starts", () => {
    const m = modal("t-plat");
    type(m, "Fix auth timeout");
    const action = m.handleInput("\x13");
    expect(action.type).toBe("result");
    expect((action as { value: CaptureResult }).value.mode).toBe("start");
  });

  test("an empty title commits nothing", () => {
    const m = modal("t-plat");
    expect(m.handleInput("\r").type).toBe("consumed");
    expect(m.handleInput("\x13").type).toBe("consumed");
    expect(m.isOpen()).toBe(true);
  });

  test("Escape cancels", () => {
    const m = modal();
    expect(m.handleInput("\x1b").type).toBe("closed");
  });
});

describe("CaptureModal fields", () => {
  test("Tab moves focus title -> team -> description and back", () => {
    const m = modal("t-plat");
    type(m, "abc");
    m.handleInput("\t");
    // On the team field, left/right cycle teams rather than typing.
    m.handleInput("\x1b[C");
    expect(m.currentTeamId()).toBe("t-web");
    m.handleInput("\t");
    type(m, "hello");
    const r = (m.handleInput("\x13") as { value: CaptureResult }).value;
    expect(r).toEqual({ mode: "start", teamId: "t-web", title: "abc", description: "hello" });
  });

  test("Shift-Tab moves focus backwards", () => {
    const m = modal("t-plat");
    m.handleInput("\t");
    m.handleInput("\x1b[Z");
    type(m, "back on title");
    const r = (m.handleInput("\r") as { value: CaptureResult }).value;
    expect(r.title).toBe("back on title");
  });

  test("Enter inserts a newline while editing the description", () => {
    const m = modal("t-plat");
    type(m, "t");
    m.handleInput("\t");
    m.handleInput("\t");
    type(m, "one");
    m.handleInput("\r"); // newline, not a commit
    type(m, "two");
    expect(m.isOpen()).toBe(true);
    const r = (m.handleInput("\x13") as { value: CaptureResult }).value;
    expect(r.description).toBe("one\ntwo");
  });

  test("backspace edits the focused field only", () => {
    const m = modal("t-plat");
    type(m, "abc");
    m.handleInput("\x7f");
    const r = (m.handleInput("\r") as { value: CaptureResult }).value;
    expect(r.title).toBe("ab");
  });
});

describe("CaptureModal prefill and rendering", () => {
  test("prefills the team when one is supplied", () => {
    expect(modal("t-web").currentTeamId()).toBe("t-web");
  });

  test("defaults to the first team when none is supplied", () => {
    expect(modal().currentTeamId()).toBe("t-plat");
  });

  test("prefills a description body when given", () => {
    const m = new CaptureModal({
      teams: TEAMS,
      preselectedTeamId: "t-plat",
      initialDescription: "seen in pane output",
    });
    m.open();
    type(m, "x");
    const r = (m.handleInput("\r") as { value: CaptureResult }).value;
    expect(r.description).toBe("seen in pane output");
  });

  test("renders both commit affordances so the fork is discoverable", () => {
    const t = text(modal("t-plat").getGrid(70));
    expect(t).toContain("capture");
    expect(t).toContain("start");
  });

  test("renders the field labels and current team", () => {
    const t = text(modal("t-web").getGrid(70));
    expect(t).toContain("Title");
    expect(t).toContain("Team");
    expect(t).toContain("Web");
  });
});

// --- Production wiring ---
//
// The unit tests above call modal.handleInput directly. This one goes through
// the real InputRouter exactly as main.ts wires it (setModalOpen + onModalInput
// delegating to the active modal), so a routing regression that leaves the
// modal visible but inert is caught here rather than by hand.

describe("CaptureModal through InputRouter", () => {
  function wired() {
    const m = modal("t-plat");
    const pty: string[] = [];
    const router = new InputRouter(
      {
        onPtyData: (d) => { pty.push(d); },
        onSidebarClick: () => {},
        onModalInput: (d) => { m.handleInput(d); },
      },
      computeFrameLayout({
        termCols: 120, termRows: 40, sidebarWidth: 24, borderWidth: 1,
        toolbarRows: 1, diffState: "off", requestedPanelCols: 0,
        frameRulesEnabled: false, footerEnabled: false,
      }),
    );
    router.setModalOpen(true);
    return { m, router, pty };
  }

  test("typed characters reach the modal and appear in its grid", () => {
    const { m, router, pty } = wired();
    for (const ch of "Fix auth") router.handleInput(ch);
    expect(text(m.getGrid(70))).toContain("Fix auth");
    expect(pty.join("")).toBe(""); // nothing leaked to the pty
  });

  test("Tab moves fields through the router", () => {
    const { m, router } = wired();
    router.handleInput("\t");
    router.handleInput("\x1b[C");
    expect(m.currentTeamId()).toBe("t-web");
  });

  test("Escape closes through the router", () => {
    const { m, router } = wired();
    router.handleInput("\x1b");
    expect(m.isOpen()).toBe(false);
  });
});

// --- Field affordances ---
//
// The first version rendered `TitleHi` — label and value jammed together with
// no gap, no field, and no caret. Typing worked, but nothing on screen said so,
// which is indistinguishable from a frozen modal. These pin the affordances
// that make the composer legible.

function rowText(grid: CellGrid, row: number): string {
  return Array.from({ length: grid.cols }, (_, c) => grid.cells[row][c].char).join("");
}

function findRow(grid: CellGrid, needle: string): string {
  for (let r = 0; r < grid.rows; r++) {
    const line = rowText(grid, r);
    if (line.includes(needle)) return line;
  }
  return "";
}

describe("CaptureModal field affordances", () => {
  test("the value is separated from its label, not jammed against it", () => {
    const m = modal("t-plat");
    type(m, "Hi");
    expect(findRow(m.getGrid(70), "Title")).toMatch(/Title\s{2,}Hi/);
  });

  test("an empty title shows a placeholder", () => {
    expect(findRow(modal("t-plat").getGrid(70), "Title")).toContain("What needs doing?");
  });

  test("the placeholder disappears once you type", () => {
    const m = modal("t-plat");
    type(m, "Hi");
    expect(findRow(m.getGrid(70), "Title")).not.toContain("What needs doing?");
  });

  test("the focused field carries a caret", () => {
    const m = modal("t-plat");
    type(m, "Hi");
    // Caret sits just past the text on the focused row.
    const row = findRow(m.getGrid(70), "Title");
    expect(row).toMatch(/Hi█/);
  });

  test("the caret follows focus to the description", () => {
    const m = modal("t-plat");
    type(m, "t");
    m.handleInput("\t");
    m.handleInput("\t");
    type(m, "body");
    const g = m.getGrid(70);
    expect(findRow(g, "body")).toMatch(/body█/);
    // ...and leaves the title row
    expect(findRow(g, "Title")).not.toContain("█");
  });

  test("the team field shows its cycle affordance only when focused", () => {
    const m = modal("t-plat");
    expect(findRow(m.getGrid(70), "Team")).not.toContain("◂");
    m.handleInput("\t");
    expect(findRow(m.getGrid(70), "Team")).toContain("◂");
  });

  test("an empty description shows a placeholder", () => {
    expect(findRow(modal("t-plat").getGrid(70), "Description"))
      .toBeTruthy();
    const g = modal("t-plat").getGrid(70);
    const all = text(g);
    expect(all).toContain("Context, links, repro steps…");
  });
});
