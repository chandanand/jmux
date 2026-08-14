import { describe, test, expect } from "bun:test";
import { InputModal } from "../input-modal";

describe("InputModal secret mode", () => {
  const rowText = (modal: InputModal, row: number, width = 50): string =>
    modal.getGrid(width).cells[row]!.map((c) => c.char).join("");

  // A tracker token is pasted on a terminal that may be shared, recorded, or
  // scrolled back later. Masking is display-only: everything downstream still
  // sees the real value.
  test("masks the rendered value", () => {
    const modal = new InputModal({ header: "Paste your token", secret: true });
    modal.open();
    for (const ch of "lin_api_abc123") modal.handleInput(ch);

    const row = rowText(modal, 1);
    expect(row).toContain("••••••••••••••");
    expect(row).not.toContain("lin_api_abc123");
  });

  test("commits the real value, not the mask", () => {
    const modal = new InputModal({ header: "Token", secret: true });
    modal.open();
    for (const ch of "abc123") modal.handleInput(ch);
    expect(modal.handleInput("\r")).toEqual({ type: "result", value: "abc123" });
  });

  test("the mask is one column per character, so the cursor stays true", () => {
    const modal = new InputModal({ header: "Token", secret: true });
    modal.open();
    for (const ch of "abcd") modal.handleInput(ch);
    expect(modal.getCursorPosition()).toEqual({ row: 1, col: 8 });
  });

  test("backspace shortens the mask", () => {
    const modal = new InputModal({ header: "Token", secret: true });
    modal.open();
    for (const ch of "abc") modal.handleInput(ch);
    modal.handleInput("\x7f");
    expect(rowText(modal, 1)).toContain("••");
    expect(rowText(modal, 1)).not.toContain("•••");
  });

  test("a placeholder is not masked — it is not the user's value", () => {
    const modal = new InputModal({ header: "Token", secret: true, placeholder: "lin_api_…" });
    modal.open();
    expect(rowText(modal, 1)).toContain("lin_api_…");
  });

  test("without the flag the value still renders in clear", () => {
    const modal = new InputModal({ header: "Rename" });
    modal.open();
    for (const ch of "hello") modal.handleInput(ch);
    expect(rowText(modal, 1)).toContain("hello");
  });
});

describe("InputModal", () => {
  test("opens with pre-filled value, grid shows header (bold) and input line with value", () => {
    const modal = new InputModal({ header: "Rename Session", value: "my-session" });
    modal.open();
    expect(modal.isOpen()).toBe(true);

    const grid = modal.getGrid(50);
    // Row 0: header at col 2
    expect(grid.cells[0][2].char).toBe("R");
    expect(grid.cells[0][2].bold).toBe(true);
    // Row 1: prompt then value
    expect(grid.cells[1][2].char).toBe("▷");
    expect(grid.cells[1][4].char).toBe("m");
    expect(grid.cells[1][5].char).toBe("y");
  });

  test("opens with subheader — grid row 1 is subheader (dim), input row moves to row 2", () => {
    const modal = new InputModal({
      header: "Rename Session",
      subheader: "Current: my-session",
      value: "my-session",
    });
    modal.open();

    const grid = modal.getGrid(50);
    // Row 0: header
    expect(grid.cells[0][2].char).toBe("R");
    // Row 1: subheader — first char at col 2, uses palette color 8 (dim gray)
    expect(grid.cells[1][2].char).toBe("C");
    expect(grid.cells[1][2].fg).toBe(8);
    // Row 2: prompt
    expect(grid.cells[2][2].char).toBe("▷");
    // Grid should have 3 rows
    expect(grid.rows).toBe(3);
  });

  test("typing appends characters to value", () => {
    const modal = new InputModal({ header: "Rename Session", value: "" });
    modal.open();

    modal.handleInput("f");
    modal.handleInput("o");
    modal.handleInput("o");

    const grid = modal.getGrid(50);
    expect(grid.cells[1][4].char).toBe("f");
    expect(grid.cells[1][5].char).toBe("o");
    expect(grid.cells[1][6].char).toBe("o");
  });

  test("backspace removes last character", () => {
    const modal = new InputModal({ header: "Rename Session", value: "abc" });
    modal.open();

    modal.handleInput("\x7f"); // backspace
    const grid = modal.getGrid(50);
    // value is now "ab"
    expect(grid.cells[1][4].char).toBe("a");
    expect(grid.cells[1][5].char).toBe("b");
    // col 6 should be space (no char)
    expect(grid.cells[1][6].char).toBe(" ");
  });

  test("alt+backspace clears entire input", () => {
    const modal = new InputModal({ header: "Rename Session", value: "abc" });
    modal.open();

    modal.handleInput("\x1b\x7f"); // alt+backspace
    const grid = modal.getGrid(50);
    // value is now empty — cols 4+ should be spaces
    expect(grid.cells[1][4].char).toBe(" ");
  });

  test("ctrl-u clears entire input", () => {
    const modal = new InputModal({ header: "Rename Session", value: "abc" });
    modal.open();

    modal.handleInput("\x15"); // ctrl-u
    const grid = modal.getGrid(50);
    expect(grid.cells[1][4].char).toBe(" ");
  });

  test("Enter returns { type: 'result', value: 'the-text' }", () => {
    const modal = new InputModal({ header: "Rename Session", value: "hello" });
    modal.open();

    const action = modal.handleInput("\r");
    expect(action.type).toBe("result");
    if (action.type === "result") {
      expect(action.value).toBe("hello");
    }
  });

  test("Enter on empty value returns { type: 'consumed' }", () => {
    const modal = new InputModal({ header: "Rename Session", value: "" });
    modal.open();

    const action = modal.handleInput("\r");
    expect(action.type).toBe("consumed");
  });

  test("Escape returns { type: 'closed' }", () => {
    const modal = new InputModal({ header: "Rename Session", value: "hello" });
    modal.open();

    const action = modal.handleInput("\x1b");
    expect(action.type).toBe("closed");
  });

  test("getCursorPosition returns correct { row, col } without subheader", () => {
    const modal = new InputModal({ header: "Rename Session", value: "abc" });
    modal.open();

    const pos = modal.getCursorPosition();
    expect(pos).not.toBeNull();
    expect(pos!.row).toBe(1);
    expect(pos!.col).toBe(4 + 3); // "  ▷ " prefix (4) + value length (3)
  });

  test("getCursorPosition returns correct { row, col } with subheader", () => {
    const modal = new InputModal({
      header: "Rename Session",
      subheader: "Current: my-session",
      value: "hello",
    });
    modal.open();

    const pos = modal.getCursorPosition();
    expect(pos).not.toBeNull();
    expect(pos!.row).toBe(2);
    expect(pos!.col).toBe(4 + 5); // 4 + "hello".length
  });

  test("preferredWidth returns Math.min(Math.max(40, Math.round(termCols * 0.45)), 60)", () => {
    const modal = new InputModal({ header: "Rename Session" });

    expect(modal.preferredWidth(80)).toBe(Math.min(Math.max(40, Math.round(80 * 0.45)), 60));
    expect(modal.preferredWidth(200)).toBe(60);
    expect(modal.preferredWidth(50)).toBe(Math.min(Math.max(40, Math.round(50 * 0.45)), 60));
    expect(modal.preferredWidth(20)).toBe(40); // clamps to min 40
  });

  test("close() sets isOpen to false", () => {
    const modal = new InputModal({ header: "Rename Session" });
    modal.open();
    expect(modal.isOpen()).toBe(true);
    modal.close();
    expect(modal.isOpen()).toBe(false);
  });
});

describe("InputModal required hint", () => {
  const rowText = (m: InputModal, row: number, w = 60) =>
    m.getGrid(w).cells[row]!.map((c) => c.char).join("");

  // Refusing an empty commit is right; refusing it in silence is the failure —
  // the field sits there looking ready and the key appears dead.
  test("Enter on an empty buffer says why instead of doing nothing", () => {
    const modal = new InputModal({
      header: "Add a directory",
      subheader: "jmux will offer the repositories it finds underneath.",
      requiredHint: "Type a path, or press esc to skip this step.",
    });
    modal.open();
    expect(rowText(modal, 1)).toContain("jmux will offer");
    expect(modal.handleInput("\r")).toEqual({ type: "consumed" });
    expect(rowText(modal, 1)).toContain("Type a path");
  });

  test("typing clears the nag", () => {
    const modal = new InputModal({
      header: "H", subheader: "sub", requiredHint: "required",
    });
    modal.open();
    modal.handleInput("\r");
    expect(rowText(modal, 1)).toContain("required");
    modal.handleInput("x");
    expect(rowText(modal, 1)).toContain("sub");
  });

  test("without the hint, behaviour is exactly as before", () => {
    const modal = new InputModal({ header: "H", subheader: "sub" });
    modal.open();
    expect(modal.handleInput("\r")).toEqual({ type: "consumed" });
    expect(rowText(modal, 1)).toContain("sub");
  });
});
