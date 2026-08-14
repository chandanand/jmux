import type { CellGrid } from "./types";
import { createGrid, writeString } from "./cell-grid";
import {
  HEADER_ATTRS, SUBHEADER_ATTRS, PROMPT_ATTRS, INPUT_ATTRS, BG_ATTRS,
  type ModalAction,
} from "./modal";

export interface InputModalConfig {
  header: string;
  subheader?: string;
  value?: string;
  placeholder?: string;
  /**
   * Render `•` per character instead of the value itself.
   *
   * For a credential: it is pasted onto a terminal that may be shared, screen
   * recorded, or scrolled back to hours later, and a token in the scrollback is
   * a token that has leaked.
   *
   * Display only. The buffer, the committed result and the cursor column are
   * all unchanged, so nothing downstream has to know a field was masked — and
   * `•` is width-1, which is what keeps the caret true without a second
   * calculation that could disagree with the first.
   *
   * The placeholder is deliberately *not* masked: it is jmux's own hint text,
   * not anything the user typed.
   */
  secret?: boolean;
  /**
   * Shown in place of the subheader when Enter is pressed on an empty buffer.
   *
   * Without it that keypress is silently consumed — the field sits there
   * looking ready and the key appears dead, which is indistinguishable from
   * the app having hung. Opt-in, so every existing caller keeps today's
   * behaviour.
   */
  requiredHint?: string;
}

export class InputModal {
  private _open = false;
  private value: string;
  private config: InputModalConfig;
  /** Set when Enter was pressed on an empty buffer; cleared on the next key. */
  private nagging = false;

  constructor(config: InputModalConfig) {
    this.config = config;
    this.value = config.value ?? "";
  }

  open(): void {
    this._open = true;
    this.value = this.config.value ?? "";
    this.nagging = false;
  }

  close(): void { this._open = false; }
  isOpen(): boolean { return this._open; }

  /**
   * The buffer as typed, unmasked.
   *
   * For a modal that hosts this one as a child step and needs to inspect the
   * value without waiting for a commit.
   */
  getValue(): string { return this.value; }

  preferredWidth(termCols: number): number {
    return Math.min(Math.max(40, Math.round(termCols * 0.45)), 60);
  }

  getCursorPosition(): { row: number; col: number } | null {
    const inputRow = this.config.subheader !== undefined ? 2 : 1;
    return { row: inputRow, col: 4 + this.value.length };
  }

  handleInput(data: string): ModalAction {
    if (data === "\x1b") return { type: "closed" };
    if (data === "\r") {
      if (this.value.length === 0) {
        // Refusing an empty commit is right; refusing it in silence is the
        // failure. Say so where the user is already looking.
        if (this.config.requiredHint) this.nagging = true;
        return { type: "consumed" };
      }
      return { type: "result", value: this.value };
    }
    // Alt+Backspace / Cmd+Backspace / Ctrl-U: clear entire input
    if (data === "\x1b\x7f" || data === "\x1b\b" || data === "\x15") {
      this.value = "";
      return { type: "consumed" };
    }
    if (data === "\x7f" || data === "\b") {
      if (this.value.length > 0) this.value = this.value.slice(0, -1);
      return { type: "consumed" };
    }
    if (data.length === 1 && data >= " " && data <= "~") {
      this.value += data;
      this.nagging = false;
      return { type: "consumed" };
    }
    return { type: "consumed" };
  }

  getGrid(width: number): CellGrid {
    const hasSubheader = this.config.subheader !== undefined;
    const height = hasSubheader ? 3 : 2;
    const grid = createGrid(width, height);

    for (let r = 0; r < height; r++) {
      writeString(grid, r, 0, " ".repeat(width), BG_ATTRS);
    }

    writeString(grid, 0, 2, this.config.header, HEADER_ATTRS);

    if (hasSubheader) {
      const line = this.nagging && this.config.requiredHint
        ? this.config.requiredHint
        : this.config.subheader!;
      writeString(grid, 1, 2, line, SUBHEADER_ATTRS);
    }

    const inputRow = hasSubheader ? 2 : 1;
    writeString(grid, inputRow, 2, "\u25b7", PROMPT_ATTRS);
    if (this.value.length > 0) {
      const shown = this.config.secret ? "•".repeat(this.value.length) : this.value;
      writeString(grid, inputRow, 4, shown, INPUT_ATTRS);
    } else if (this.config.placeholder) {
      writeString(grid, inputRow, 4, this.config.placeholder, SUBHEADER_ATTRS);
    }

    return grid;
  }
}
