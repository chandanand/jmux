import { describe, test, expect } from "bun:test";
import { CaptureModal, type CaptureResult } from "../capture-modal";
import type { CellGrid } from "../types";

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
