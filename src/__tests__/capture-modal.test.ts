import { describe, test, expect } from "bun:test";
import { CaptureModal, wrapText, type CaptureResult } from "../capture-modal";
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

// --- Wrapping ---
//
// The body used to be `line.slice(0, width)` per logical line, so anything past
// the field width simply vanished and the caret ran off the edge — you could
// only ever see the first screenful of the first line you typed.

describe("wrapText", () => {
  test("returns a single line when it fits", () => {
    expect(wrapText("hello", 10)).toEqual(["hello"]);
  });

  test("breaks on the last space before the limit", () => {
    expect(wrapText("the quick brown fox", 10)).toEqual(["the quick", "brown fox"]);
  });

  test("hard-breaks a word longer than the field", () => {
    expect(wrapText("aaaaaaaaaaaa", 5)).toEqual(["aaaaa", "aaaaa", "aa"]);
  });

  test("preserves explicit newlines, including blank lines", () => {
    expect(wrapText("a\n\nb", 10)).toEqual(["a", "", "b"]);
  });

  test("wraps each paragraph independently", () => {
    expect(wrapText("one two\nthree four", 8)).toEqual(["one two", "three", "four"]);
  });

  test("a zero or negative width degrades to the raw text", () => {
    expect(wrapText("abc", 0)).toEqual(["abc"]);
  });
});

describe("CaptureModal body wrapping", () => {
  function withBody(body: string): CaptureModal {
    const m = new CaptureModal({
      teams: TEAMS, preselectedTeamId: "t-plat", initialDescription: body,
    });
    m.open();
    m.handleInput("\t");
    m.handleInput("\t"); // focus the description
    return m;
  }

  test("a long body wraps onto multiple rows instead of being clipped", () => {
    const body = "The auth token expires after ten minutes which breaks every long running job";
    const g = withBody(body).getGrid(60);
    const all = text(g);
    // Words from the far end of the body must be visible somewhere.
    expect(all).toContain("running job");
  });

  test("the caret sits at the end of the wrapped text, inside the field", () => {
    const m = withBody("The auth token expires after ten minutes which breaks jobs");
    const g = m.getGrid(60);
    const caretRow = Array.from({ length: g.rows }, (_, r) =>
      Array.from({ length: g.cols }, (_, c) => g.cells[r][c].char).join(""))
      .findIndex((l) => l.includes("█"));
    expect(caretRow).toBeGreaterThan(-1);
    const pos = m.getCursorPosition()!;
    expect(pos.row).toBe(caretRow);
    expect(pos.col).toBeLessThan(60);
  });

  test("the body scrolls so the newest rows stay visible", () => {
    // Eight wrapped rows in a four-row field: the tail must win.
    const m = withBody("alpha\nbravo\ncharlie\ndelta\necho\nfoxtrot\ngolf\nhotel");
    const all = text(m.getGrid(60));
    expect(all).toContain("hotel");
    expect(all).not.toContain("alpha");
  });
});

describe("CaptureModal title overflow", () => {
  test("a title longer than the field shows its tail, not its head", () => {
    const m = modal("t-plat");
    type(m, "0123456789".repeat(12)); // 120 chars into a ~50-col field
    const row = findRow(m.getGrid(60), "Title");
    expect(row).toContain("6789█");   // the end, where the caret is
    expect(row).not.toMatch(/Title\s+0123456789012/); // not pinned to the head
  });
});

// --- Chunked input and paste ---
//
// A terminal does not deliver one keystroke per read. Fast typing coalesces,
// and a paste arrives as one large chunk wrapped in bracketed-paste markers
// (jmux enables ?2004h at startup). The first version only accepted
// `data.length === 1`, so both were silently dropped — pasting repro steps
// into the description did literally nothing.

describe("CaptureModal chunked input", () => {
  test("a multi-character chunk is accepted, not dropped", () => {
    const m = modal("t-plat");
    m.handleInput("Fix auth timeout");
    expect((m.handleInput("\r") as { value: CaptureResult }).value.title).toBe("Fix auth timeout");
  });

  test("bracketed-paste markers are stripped from the payload", () => {
    const m = modal("t-plat");
    m.handleInput("x");
    m.handleInput("\t");
    m.handleInput("\t");
    m.handleInput("\x1b[200~pasted body\x1b[201~");
    expect((m.handleInput("\x13") as { value: CaptureResult }).value.description).toBe("pasted body");
  });

  test("newlines in a pasted body are kept as newlines", () => {
    const m = modal("t-plat");
    m.handleInput("x");
    m.handleInput("\t");
    m.handleInput("\t");
    m.handleInput("\x1b[200~line one\nline two\x1b[201~");
    expect((m.handleInput("\x13") as { value: CaptureResult }).value.description)
      .toBe("line one\nline two");
  });

  test("newlines pasted into the title collapse to spaces", () => {
    // A title is single-line; embedding a newline would corrupt it.
    const m = modal("t-plat");
    m.handleInput("\x1b[200~one\ntwo\x1b[201~");
    expect((m.handleInput("\r") as { value: CaptureResult }).value.title).toBe("one two");
  });

  test("control bytes inside a chunk are filtered out", () => {
    const m = modal("t-plat");
    m.handleInput("ab\x07cd");
    expect((m.handleInput("\r") as { value: CaptureResult }).value.title).toBe("abcd");
  });

  test("escape sequences are never inserted as text", () => {
    const m = modal("t-plat");
    m.handleInput("hi");
    m.handleInput("\x1b[A");  // an arrow key, not text
    m.handleInput("\x1b[1;5D");
    expect((m.handleInput("\r") as { value: CaptureResult }).value.title).toBe("hi");
  });
});
