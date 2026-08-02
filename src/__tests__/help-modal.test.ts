import { describe, expect, test } from "bun:test";
import { HelpModal } from "../help-modal";
import { KEYMAP } from "../keymap";
import { textCols } from "../cell-grid";

function opened(rows = 40): HelpModal {
  const modal = new HelpModal();
  modal.setTermRows(rows);
  modal.open();
  return modal;
}

function type(modal: HelpModal, text: string): void {
  for (const ch of text) modal.handleInput(ch);
}

const bindingRows = (modal: HelpModal) => modal.getRows().filter((r) => r.kind === "binding");
const sectionRows = (modal: HelpModal) => modal.getRows().filter((r) => r.kind === "section");

const gridText = (modal: HelpModal, width = 64): string =>
  modal.getGrid(width).cells.map((r) => r.map((c) => c.char).join("")).join("\n");

/** Every glyph painted in the grid, row by row, for overflow assertions. */
function rowText(modal: HelpModal, width: number, row: number): string {
  const grid = modal.getGrid(width);
  return grid.cells[row].map((c) => c.char).join("");
}

describe("HelpModal contents", () => {
  test("unfiltered, it lists every binding in the keymap", () => {
    const modal = opened();
    expect(bindingRows(modal).length).toBe(KEYMAP.length);
  });

  test("unfiltered, it carries a header for every section", () => {
    const modal = opened();
    const sections = new Set(KEYMAP.map((b) => b.section));
    expect(sectionRows(modal).length).toBe(sections.size);
  });

  test("filtering narrows to matching bindings", () => {
    const modal = opened();
    type(modal, "split");
    const labels = bindingRows(modal).map((r) => r.kind === "binding" && r.binding.label);
    expect(labels).toContain("Split pane left / right");
    expect(labels).toContain("Split pane top / bottom");
    expect(bindingRows(modal).length).toBeLessThan(KEYMAP.length);
  });

  test("the split labels never say horizontal or vertical", () => {
    // tmux's `-h` splits side by side; jmux's `split-h` id means the divider
    // is horizontal and splits top/bottom. Both conventions are live in this
    // repo, so the words cannot disambiguate and are kept out of the labels.
    const splits = KEYMAP.filter((b) => b.id.startsWith("split-"));
    expect(splits.length).toBe(2);
    for (const b of splits) {
      expect(b.label.toLowerCase()).not.toContain("horizontal");
      expect(b.label.toLowerCase()).not.toContain("vertical");
    }
  });

  test("filtering drops section headers entirely", () => {
    // A header whose section matched nothing is noise; one that kept a single
    // row spends a line to say less than the row already does.
    const modal = opened();
    type(modal, "split");
    expect(sectionRows(modal)).toEqual([]);
  });

  test("a key spelling finds its binding, in both long and short form", () => {
    const long = opened();
    type(long, "Ctrl-a p");
    expect(bindingRows(long).some((r) => r.kind === "binding" && r.binding.id === "palette")).toBe(true);

    const short = opened();
    type(short, "^a p");
    expect(bindingRows(short).some((r) => r.kind === "binding" && r.binding.id === "palette")).toBe(true);
  });

  test("a query matching nothing reports it rather than rendering an empty box", () => {
    const modal = opened();
    type(modal, "zzzznope");
    expect(bindingRows(modal)).toEqual([]);
    expect(rowText(modal, 60, 3)).toContain("No matching shortcut");
  });

  test("backspacing to empty restores the full list", () => {
    const modal = opened();
    type(modal, "split");
    expect(bindingRows(modal).length).toBeLessThan(KEYMAP.length);
    for (let i = 0; i < "split".length; i++) modal.handleInput("\x7f");
    expect(modal.getQuery()).toBe("");
    expect(bindingRows(modal).length).toBe(KEYMAP.length);
    expect(sectionRows(modal).length).toBeGreaterThan(0);
  });

  test("backspace on an empty query is inert", () => {
    const modal = opened();
    modal.handleInput("\x7f");
    expect(modal.getQuery()).toBe("");
    expect(bindingRows(modal).length).toBe(KEYMAP.length);
  });

  test("Ctrl-U clears the filter outright", () => {
    const modal = opened();
    type(modal, "split");
    modal.handleInput("\x15");
    expect(modal.getQuery()).toBe("");
    expect(bindingRows(modal).length).toBe(KEYMAP.length);
  });
});

describe("HelpModal input", () => {
  test("escape closes", () => {
    const modal = opened();
    expect(modal.handleInput("\x1b")).toEqual({ type: "closed" });
    expect(modal.isOpen()).toBe(false);
  });

  test("Ctrl-a ? closes, mirroring Ctrl-a p on the palette", () => {
    const modal = opened();
    expect(modal.handleInput("\x01")).toEqual({ type: "consumed" });
    expect(modal.handleInput("?")).toEqual({ type: "closed" });
    expect(modal.isOpen()).toBe(false);
  });

  test("a bare ? filters instead of closing", () => {
    // The regression this pins: treating a bare `?` as "close" would make the
    // one binding spelled `?` the one binding you cannot search for.
    const modal = opened();
    modal.handleInput("?");
    expect(modal.isOpen()).toBe(true);
    expect(modal.getQuery()).toBe("?");
    expect(bindingRows(modal).some((r) => r.kind === "binding" && r.binding.id === "panel-sort-order")).toBe(true);
  });

  test("Ctrl-a followed by anything else is swallowed, not typed", () => {
    const modal = opened();
    modal.handleInput("\x01");
    modal.handleInput("x");
    expect(modal.getQuery()).toBe("");
    expect(modal.isOpen()).toBe(true);
  });

  test("scrolling clamps at both ends", () => {
    const modal = opened(20); // short terminal, so the list overflows
    for (let i = 0; i < 500; i++) modal.handleInput("\x1b[B");
    const grid = modal.getGrid(60);
    expect(grid.rows).toBeGreaterThan(0); // no crash, no negative offset
    for (let i = 0; i < 500; i++) modal.handleInput("\x1b[A");
    expect(rowText(modal, 60, 3).trim().length).toBeGreaterThan(0);
  });
});

describe("HelpModal layout", () => {
  for (const width of [52, 60, 84]) {
    test(`no row overflows the grid at width ${width}`, () => {
      const modal = opened();
      const grid = modal.getGrid(width);
      for (const row of grid.cells) {
        expect(row.length).toBe(width);
      }
    });
  }

  test("it fits the height it claims", () => {
    const modal = opened(30);
    const grid = modal.getGrid(60);
    expect(grid.rows).toBe(modal.getHeight());
  });

  test("a narrow terminal still paints the keys and does not wrap them", () => {
    const modal = opened();
    const grid = modal.getGrid(52);
    for (const row of grid.cells) {
      const text = row.map((c) => c.char).join("");
      expect(textCols(text.trimEnd())).toBeLessThanOrEqual(52);
    }
  });

  test("the title and the shortcut count are painted", () => {
    const modal = opened();
    expect(rowText(modal, 60, 0)).toContain("Keyboard shortcuts");
    expect(rowText(modal, 60, 0)).toContain(`${KEYMAP.length} shortcuts`);
  });

  test("context-scoped bindings say so, so a dead-looking key is explained", () => {
    const modal = opened();
    type(modal, "Approve merge");
    const grid = modal.getGrid(80);
    const text = grid.cells.map((r) => r.map((c) => c.char).join("")).join("\n");
    expect(text).toContain("Issues/MRs tab focused");
  });
});

describe("HelpModal setup pointer", () => {
  test("the unfiltered list opens with a pointer to the checklist", () => {
    // The checklist is the one surface no keybinding reaches, and someone who
    // opened the keyboard help is exactly who wants it. It leads the list
    // because the list is twice the height of the viewport — as a closing line
    // it sat below the fold, unread by precisely the people it is for.
    const modal = opened();
    expect(modal.getRows()[0].kind).toBe("tip");
  });

  test("the pointer is visible without scrolling", () => {
    const modal = opened(24); // a short terminal, where it matters most
    expect(gridText(modal)).toContain("New to jmux");
  });

  test("the tip is dropped while filtering", () => {
    const modal = opened();
    type(modal, "split");
    expect(modal.getRows().some((r) => r.kind === "tip")).toBe(false);
  });

  test("the tip is not counted as a shortcut", () => {
    const modal = opened();
    expect(rowText(modal, 60, 0)).toContain(`${KEYMAP.length} shortcuts`);
  });
});

describe("HelpModal scroll affordance", () => {
  test("the indicator never paints over a row's context qualifier", () => {
    // It did: both want the right edge of the same row, and the indicator won,
    // leaving fragments like "(Issues/MRs tab fo▾ more" in the one surface
    // whose job is to be readable.
    const modal = opened(26);
    for (const scroll of [22, 24, 26, 28]) {
      const m = opened(26);
      for (let i = 0; i < scroll; i++) m.handleInput("\x1b[B");
      const grid = m.getGrid(72);
      const last = grid.cells[grid.rows - 2].map((c) => c.char).join("");
      if (!last.includes("more") && !last.includes("top")) continue;
      // Any context on this row must be present whole, parentheses included.
      const open = last.indexOf("(");
      if (open === -1) continue;
      expect(last.slice(open)).toMatch(/^\([^)]+\)/);
    }
    expect(modal.isOpen()).toBe(true);
  });

  test("no indicator when the whole list fits", () => {
    const modal = opened(200);
    const text = gridText(modal, 72);
    expect(text).not.toContain("▾ more");
    expect(text).not.toContain("▴ top");
  });

  test("the indicator flips to ▴ top at the bottom of the list", () => {
    const modal = opened(26);
    for (let i = 0; i < 500; i++) modal.handleInput("\x1b[B");
    expect(gridText(modal, 72)).toContain("▴ top");
  });
});
