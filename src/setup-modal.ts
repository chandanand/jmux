import type { CellGrid } from "./types";
import { createGrid, writeString, textCols, truncateToCols, type CellAttrs } from "./cell-grid";
import { tokens } from "./chrome-tokens";
import {
  RESULT_ATTRS, SELECTED_RESULT_ATTRS, CATEGORY_ATTRS,
  NO_MATCHES_ATTRS, BG_ATTRS, SELECTED_BG_ATTRS,
  modalContentRect, drawModalChrome, type ModalChrome, type ModalAction,
} from "./modal";

// The first-run checklist — the only thing that opens on first run, and
// reachable forever after from the palette's "Setup".
//
// Every row does its own work in-process. Sending someone to a shell to run
// `jmux --install-agent-hooks` is a strange ask thirty seconds into a terminal
// workspace, and it is the one step a beginner is most likely to skip.
//
// **Every row's state is derived, never stored.** There is no "dismissed" or
// "completed" flag: a row is done when the thing it names is true on this
// machine, re-read whenever that could have changed (on open, and after an
// activation — see getGrid on why not per frame). So the checklist cannot go
// stale and no second source of truth can disagree with it — the same rule
// that makes `showUnstartedInSidebar` the single on-switch for ghost rows.

export type SetupState =
  /** Already true on this machine. */
  | "done"
  /** Not yet, and jmux can do it — Enter runs it. */
  | "todo"
  /** Not yet, and jmux cannot do it for you (see `note`). */
  | "unavailable";

export interface SetupRow {
  id: string;
  label: string;
  /** One line on what this gets you, shown while the row is selected. */
  detail: string;
  state: SetupState;
  /** Right-hand summary: the current value, or what to run yourself. */
  note?: string;
}

export interface SetupProviders {
  /** Called on open and after each activation. Free to touch the filesystem. */
  rows: () => SetupRow[];
  /** Enter on a `todo` row. Never called for `done` or `unavailable`. */
  onActivate: (id: string) => void;
}

const GLYPH: Record<SetupState, string> = {
  done: "✓",
  todo: "○",
  unavailable: "—",
};

export class SetupModal {
  private _open = false;
  private selectedIndex = 0;
  private providers: SetupProviders;
  private cached: SetupRow[] = [];
  private termRows = 30;

  constructor(providers: SetupProviders) {
    this.providers = providers;
  }

  open(): void {
    this._open = true;
    this.selectedIndex = 0;
    this.refresh();
  }

  close(): void {
    this._open = false;
    this.selectedIndex = 0;
    this.cached = [];
  }

  isOpen(): boolean {
    return this._open;
  }

  /** Rows as of the last render or refresh. Exposed for tests. */
  getRows(): SetupRow[] {
    return this.cached;
  }

  getSelectedIndex(): number {
    return this.selectedIndex;
  }

  private refresh(): void {
    this.cached = this.providers.rows();
    if (this.selectedIndex >= this.paintedRows) {
      this.selectedIndex = Math.max(0, this.paintedRows - 1);
    }
  }

  setTermRows(rows: number): void {
    this.termRows = rows;
  }

  /**
   * Rows that fit on screen, after the modal's chrome, border, shadow and
   * margin. The checklist is short and fixed-length, so this is a bound rather
   * than the start of a scrolling list — building scroll machinery for five
   * items would be more moving parts than the screen itself. What it must not
   * do is let the box grow past the terminal, or drop a row without saying so
   * (see `hidden` in getGrid).
   */
  private get maxRows(): number {
    return Math.max(1, this.termRows - 4 - 6);
  }

  preferredWidth(termCols: number): number {
    return Math.min(Math.max(52, Math.round(termCols * 0.6)), 78);
  }

  getCursorPosition(): { row: number; col: number } | null {
    return null;
  }

  handleInput(data: string): ModalAction {
    if (data === "\x1b" || data === "q") {
      this.close();
      return { type: "closed" };
    }

    // Navigation wraps over the *painted* rows, not every row. A cursor on a
    // row the terminal had no room to draw is invisible, describes itself on
    // the detail line, and acts on Enter — three ways to do something the user
    // did not knowingly choose. Rows past the fold are reached by resizing,
    // which is what the notice tells them to do.
    if (data === "\x1b[B" || data === "j") {
      if (this.paintedRows > 0) {
        this.selectedIndex = (this.selectedIndex + 1) % this.paintedRows;
      }
      return { type: "consumed" };
    }

    if (data === "\x1b[A" || data === "k") {
      if (this.paintedRows > 0) {
        this.selectedIndex = (this.selectedIndex - 1 + this.paintedRows) % this.paintedRows;
      }
      return { type: "consumed" };
    }

    if (data === "\r") {
      const row = this.cached[this.selectedIndex];
      // A row that is already done, or that jmux cannot do, is inert. Firing
      // an action anyway would either repeat work invisibly or do nothing at
      // all, and "I pressed Enter and cannot tell whether it worked" is the
      // exact doubt this screen exists to remove.
      if (!row || row.state !== "todo") return { type: "consumed" };
      this.providers.onActivate(row.id);
      // Re-derive immediately: the row the user just actioned should tick over
      // under the cursor, which is the entire feedback for the keypress.
      //
      // Unless the action closed us — rows that hand off to another surface
      // (the settings screen, the project-dirs prompt) do. Every detector here
      // hits the filesystem, and there is no one left to show the result to.
      if (this._open) this.refresh();
      return { type: "consumed" };
    }

    return { type: "consumed" };
  }

  private buildChrome(): ModalChrome {
    const done = this.cached.filter((r) => r.state === "done").length;
    const actionable = this.cached.filter((r) => r.state !== "unavailable").length;
    return {
      title: "Set up jmux",
      count: `${done}/${actionable} done`,
      hints: [
        { key: "↑↓", label: "move" },
        { key: "↵", label: "set up" },
        { key: "esc", label: "close" },
      ],
      hairlineAfterInput: false,
    };
  }

  /** Row slots the box reserves — every row, unless the terminal is too short. */
  private get rowSlots(): number {
    return Math.min(Math.max(1, this.cached.length), this.maxRows);
  }

  /**
   * Rows actually painted, and the one number navigation and rendering both
   * read. When rows are cut, the "…and N more" line takes a slot of its own,
   * so this is one less than `rowSlots` — counting against `rowSlots` instead
   * made the notice undercount by exactly the row it was occupying.
   */
  private get paintedRows(): number {
    const slots = this.rowSlots;
    if (this.cached.length <= slots) return this.cached.length;
    return slots >= 2 ? slots - 1 : slots; // no room for the notice at 1 slot
  }

  /** Rows there was no room for. Zero whenever everything fits. */
  private get hiddenRows(): number {
    return Math.max(0, this.cached.length - this.paintedRows);
  }

  getHeight(): number {
    // title(1) + rows + blank(1) + detail(1) + hint(1)
    return 4 + this.rowSlots;
  }

  getGrid(width: number): CellGrid {
    // Deliberately does *not* re-derive. Every row's detector touches the
    // filesystem (agent config files, the skill, `which hunk`), and getGrid
    // runs on every frame — re-deriving here would stat half a dozen paths at
    // the render loop's ~60fps for as long as the modal stayed open. The state
    // it reads only changes when the user acts, so refresh() runs on open and
    // after an activation that leaves this modal open — exactly those moments.
    const height = this.getHeight();
    const grid = createGrid(width, height);

    for (let r = 0; r < height; r++) {
      writeString(grid, r, 0, " ".repeat(width), BG_ATTRS);
    }

    const chrome = this.buildChrome();
    const rect = modalContentRect(chrome, { cols: width, rows: height });

    if (this.cached.length === 0) {
      writeString(grid, rect.top, 3, "Nothing to set up", NO_MATCHES_ATTRS);
      drawModalChrome(grid, chrome);
      return grid;
    }

    const doneAttrs: CellAttrs = { ...tokens.accent };
    const todoAttrs: CellAttrs = { ...tokens.textPrimary };
    const inertAttrs: CellAttrs = { ...tokens.textSecondary, dim: true };

    // A row that doesn't fit is *said*, never silently dropped: a setup step
    // the user cannot see is a setup step they will not do, and a checklist
    // that quietly hides items is worse than one that admits it is cramped.
    const rowCount = this.paintedRows;
    const hidden = this.hiddenRows;

    for (let i = 0; i < rowCount; i++) {
      const row = this.cached[i];
      const y = rect.top + i;
      const isSelected = i === this.selectedIndex;

      if (isSelected) writeString(grid, y, 0, " ".repeat(width), SELECTED_BG_ATTRS);

      const glyphAttrs =
        row.state === "done" ? doneAttrs : row.state === "todo" ? todoAttrs : inertAttrs;
      writeString(grid, y, 2, GLYPH[row.state], glyphAttrs);

      // The note owns the right edge and is reserved before the label, so a
      // long label can never squeeze out the bit that says what to do next.
      const note = row.note ?? "";
      const noteCols = note ? textCols(note) + 2 : 0;
      const labelStart = 4;
      const labelRoom = Math.max(1, width - labelStart - noteCols - 1);
      const label = truncateToCols(row.label, labelRoom);
      writeString(grid, y, labelStart, label,
        row.state === "unavailable"
          ? inertAttrs
          : isSelected ? SELECTED_RESULT_ATTRS : RESULT_ATTRS);

      if (note) {
        const noteX = width - 1 - textCols(note);
        if (noteX > labelStart + textCols(label)) {
          writeString(grid, y, noteX, note, CATEGORY_ATTRS);
        }
      }
    }

    if (hidden > 0) {
      writeString(grid, rect.top + rowCount, 4,
        truncateToCols(`…and ${hidden} more — resize the terminal to see ${hidden === 1 ? "it" : "them"}`,
          Math.max(1, width - 6)),
        NO_MATCHES_ATTRS);
    }

    // Explain line for the selected row. One shared line rather than a second
    // row per item: the detail is only ever needed for the row you are on, and
    // doubling the list's height to pre-answer questions nobody asked is how a
    // five-item checklist starts feeling like a form.
    const selected = this.cached[this.selectedIndex];
    if (selected && rect.rows >= 2) {
      const detailRow = rect.top + rect.rows - 1;
      writeString(grid, detailRow, 2,
        truncateToCols(selected.detail, Math.max(1, width - 4)), NO_MATCHES_ATTRS);
    }

    drawModalChrome(grid, chrome);
    return grid;
  }
}
