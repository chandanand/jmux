import type { CellGrid } from "./types";
import { createGrid, writeString, textCols, truncateToCols } from "./cell-grid";
import { fuzzyMatch, type FuzzyResult } from "./fuzzy";
import { KEYMAP, bindingsBySection, shortKeys, type Binding } from "./keymap";
import {
  HEADER_ATTRS, PROMPT_ATTRS, INPUT_ATTRS, RESULT_ATTRS,
  MATCH_ATTRS, CATEGORY_ATTRS, NO_MATCHES_ATTRS, DIM_ATTRS, BG_ATTRS,
  modalContentRect, drawModalChrome, type ModalChrome, type ModalAction,
} from "./modal";
import { PREFIX_BYTE } from "./prefix";

// The `Ctrl-Space ?` overlay — the in-app keyboard reference. Also what footer.ts's
// `? keys` hint points at, and the toolbar's `?` button.
//
// Deliberately read-only: Enter runs nothing. About half of KEYMAP is tmux
// binds with no palette command behind them, so an Enter that worked on some
// rows and did nothing on the rest would teach the wrong lesson to exactly the
// person who came here unsure. The palette does things; this explains them.

/**
 * Rows the overlay can paint. Section headers and the tip are dropped while
 * filtering — a filtered list answers one question, and neither is part of the
 * answer.
 */
type HelpRow =
  | { kind: "section"; label: string }
  | { kind: "tip"; text: string }
  | { kind: "binding"; binding: Binding; match: FuzzyResult };

/**
 * Opening line of the unfiltered list. Someone who opened the keyboard help is,
 * more often than not, new — and the checklist is the other thing they want and
 * the one thing no keybinding leads to.
 *
 * It leads rather than closes the list because the list is ~60 rows and the
 * viewport is ~30: as a closing line it sat below the fold, where the readers
 * it exists for would never scroll to find it. A pointer nobody sees is not a
 * pointer.
 */
const SETUP_TIP = "New to jmux? Open the command palette and run “Setup”.";

/** Widest the keys gutter may grow before chords start truncating. */
const MAX_KEY_COL = 16;

export class HelpModal {
  private _open = false;
  private query = "";
  private scrollOffset = 0;
  private termRows = 30;
  private rows: HelpRow[] = [];
  private lastWidth = 60;
  private prefixBuffered = false;

  open(): void {
    this._open = true;
    this.query = "";
    this.scrollOffset = 0;
    this.prefixBuffered = false;
    this.rebuild();
  }

  close(): void {
    this._open = false;
    this.query = "";
    this.scrollOffset = 0;
    this.prefixBuffered = false;
    this.rows = [];
  }

  isOpen(): boolean {
    return this._open;
  }

  setTermRows(rows: number): void {
    this.termRows = rows;
  }

  getQuery(): string {
    return this.query;
  }

  /** Visible rows, for tests and for scroll math. */
  getRows(): HelpRow[] {
    return this.rows;
  }

  preferredWidth(termCols: number): number {
    return Math.min(Math.max(52, Math.round(termCols * 0.6)), 84);
  }

  getCursorPosition(): { row: number; col: number } | null {
    return { row: this.getInputRow(), col: 2 + textCols(this.query) };
  }

  private getInputRow(): number {
    const rect = modalContentRect(this.buildChrome(), {
      cols: this.lastWidth,
      rows: this.getHeight(),
    });
    return rect.top - 2; // title(1) + hairline(1) sit between
  }

  handleInput(data: string): ModalAction {
    // Ctrl-Space ? toggles closed, mirroring the palette's Ctrl-Space p. The prefix
    // has to be buffered rather than treating a bare `?` as "close": once a
    // modal is open the router forwards *every* byte here, so a bare `?` is a
    // user filtering for the sort-order key, not asking to leave. Collapsing
    // the two would make the one binding spelled `?` the one binding you
    // cannot search for.
    if (this.prefixBuffered) {
      this.prefixBuffered = false;
      if (data === "?") {
        this.close();
        return { type: "closed" };
      }
      return { type: "consumed" }; // discard both bytes, as the palette does
    }
    if (data === PREFIX_BYTE) {
      this.prefixBuffered = true;
      return { type: "consumed" };
    }

    if (data === "\x1b") {
      this.close();
      return { type: "closed" };
    }

    // The help overlay is always filterable, so j/k remain query text and the
    // arrow-free result navigation uses the picker convention: Ctrl-N/P.
    if (data === "\x1b[B" || data === "\x0e") { this.scrollBy(1); return { type: "consumed" }; }
    if (data === "\x1b[A" || data === "\x10") { this.scrollBy(-1); return { type: "consumed" }; }
    if (data === "\x1b[6~") { this.scrollBy(this.contentRows); return { type: "consumed" }; }
    if (data === "\x1b[5~") { this.scrollBy(-this.contentRows); return { type: "consumed" }; }

    // Alt/Cmd-Backspace and Ctrl-U clear the filter outright.
    if (data === "\x1b\x7f" || data === "\x1b\b" || data === "\x15") {
      if (this.query.length > 0) {
        this.query = "";
        this.scrollOffset = 0;
        this.rebuild();
      }
      return { type: "consumed" };
    }

    if (data === "\x7f" || data === "\b") {
      if (this.query.length > 0) {
        this.query = this.query.slice(0, -1);
        this.scrollOffset = 0;
        this.rebuild();
      }
      return { type: "consumed" };
    }

    if (data.length === 1 && data >= " " && data <= "~") {
      this.query += data;
      this.scrollOffset = 0;
      this.rebuild();
      return { type: "consumed" };
    }

    return { type: "consumed" };
  }

  /**
   * Rebuild the row list for the current query.
   *
   * Unfiltered, rows carry their section headers. Filtered, headers are
   * dropped entirely rather than kept for surviving children: a header whose
   * section matched nothing is noise, and one that kept a single row costs a
   * line to say less than the row already does.
   */
  private rebuild(): void {
    if (this.query === "") {
      const rows: HelpRow[] = [{ kind: "tip", text: SETUP_TIP }];
      for (const { section, bindings } of bindingsBySection()) {
        rows.push({ kind: "section", label: section });
        for (const binding of bindings) {
          rows.push({ kind: "binding", binding, match: { score: 0, indices: [] } });
        }
      }
      this.rows = rows;
      return;
    }

    // Match against the label *and* both key spellings, so "split", "^Space |"
    // and "Ctrl-Space |" all find the same row. Only the label's match indices
    // are kept for highlighting — highlighting a key against a query that
    // matched its long form would light up the wrong glyphs in the short one.
    const scored: Array<{ binding: Binding; match: FuzzyResult }> = [];
    for (const binding of KEYMAP) {
      const labelMatch = fuzzyMatch(this.query, binding.label);
      const keyMatch =
        fuzzyMatch(this.query, binding.keys) ?? fuzzyMatch(this.query, shortKeys(binding.keys));
      if (!labelMatch && !keyMatch) continue;
      scored.push({
        binding,
        match: labelMatch ?? { score: keyMatch!.score, indices: [] },
      });
    }
    scored.sort((a, b) => b.match.score - a.match.score);
    this.rows = scored.map(({ binding, match }) => ({ kind: "binding", binding, match }));
  }

  /**
   * Rows the list may occupy: the terminal minus this modal's chrome (title,
   * input, hairline, hint) and its border, shadow and margin — the same
   * reservation ContentModal makes. Every entry in `rows` counts against it,
   * tip and section headers included.
   */
  private get contentRows(): number {
    return Math.max(1, this.termRows - 4 - 6);
  }

  private get maxScroll(): number {
    const visible = this.visibleRows();
    return Math.max(0, this.rows.length - visible);
  }

  private scrollBy(delta: number): void {
    this.scrollOffset = Math.max(0, Math.min(this.scrollOffset + delta, this.maxScroll));
  }

  private visibleRows(): number {
    return Math.min(this.rows.length || 1, this.contentRows);
  }

  private buildChrome(): ModalChrome {
    const n = this.rows.filter((r) => r.kind === "binding").length;
    return {
      title: "Keyboard shortcuts",
      count: `${n} shortcut${n === 1 ? "" : "s"}`,
      hints: [
        { key: "type", label: "filter" },
        { key: "^p/^n", label: "scroll" },
        { key: "esc", label: "close" },
      ],
      hairlineAfterInput: true,
    };
  }

  getHeight(): number {
    // title(1) + input(1) + hairline(1) + hint(1) + rows.
    return 4 + this.visibleRows();
  }

  getGrid(width: number): CellGrid {
    this.lastWidth = width;
    const height = this.getHeight();
    const grid = createGrid(width, height);

    for (let r = 0; r < height; r++) {
      writeString(grid, r, 0, " ".repeat(width), BG_ATTRS);
    }

    const chrome = this.buildChrome();
    const rect = modalContentRect(chrome, { cols: width, rows: height });
    const inputRow = rect.top - 2;

    writeString(grid, inputRow, 0, "▷", PROMPT_ATTRS);
    if (this.query.length > 0) {
      writeString(grid, inputRow, 2, this.query, INPUT_ATTRS);
    } else {
      writeString(grid, inputRow, 2, "type to filter", NO_MATCHES_ATTRS);
    }

    // One keys column for the whole list, so keys line up into a scannable
    // gutter instead of ragging against variable-length labels.
    const keyCol = Math.min(
      MAX_KEY_COL,
      this.rows.reduce(
        (w, row) => (row.kind === "binding" ? Math.max(w, textCols(row.binding.keys)) : w),
        0,
      ),
    );
    const labelStart = 3 + keyCol + 2;

    if (this.rows.length === 0) {
      writeString(grid, rect.top, 3, "No matching shortcut", NO_MATCHES_ATTRS);
      drawModalChrome(grid, chrome);
      return grid;
    }

    const visible = Math.min(this.rows.length, rect.rows);
    // The scroll affordance shares its row with that row's context qualifier,
    // and both want the right edge. Reserve its columns up front so the
    // qualifier truncates around it — painted after, it overwrote the middle
    // of the qualifier and left a fragment ("(Issues/MRs tab fo▾ more").
    const more = this.maxScroll === 0
      ? null
      : this.scrollOffset < this.maxScroll ? "▾ more" : "▴ top";
    const moreRow = more ? visible - 1 : -1;

    for (let vi = 0; vi < visible; vi++) {
      const row = this.rows[this.scrollOffset + vi];
      if (!row) break;
      const y = rect.top + vi;
      const rightReserved = vi === moreRow ? textCols(more!) + 2 : 0;

      if (row.kind === "section") {
        writeString(grid, y, 2, truncateToCols(row.label, width - 4), HEADER_ATTRS);
        continue;
      }

      if (row.kind === "tip") {
        writeString(grid, y, 2, truncateToCols(row.text, width - 4), NO_MATCHES_ATTRS);
        continue;
      }

      const { binding, match } = row;
      // Keys right-aligned within the gutter — the modifier prefixes line up
      // and the differing tail is what the eye lands on.
      const keys = truncateToCols(binding.keys, keyCol);
      const keyX = 3 + keyCol - textCols(keys);
      writeString(grid, y, keyX, keys, MATCH_ATTRS);

      const room = width - labelStart - 1 - rightReserved;
      if (room <= 0) continue;

      // The context qualifier is reserved *before* the label so a long label
      // can never squeeze out the one piece of text that explains why the key
      // appears to do nothing elsewhere.
      const context = binding.context ? `(${binding.context})` : "";
      const contextCols = context ? textCols(context) + 2 : 0;
      const labelRoom = Math.max(1, room - contextCols);
      const label = truncateToCols(binding.label, labelRoom);

      const matchIndices = new Set(match.indices);
      let col = labelStart;
      for (let ci = 0; ci < label.length && col < width; ci++) {
        writeString(grid, y, col, label[ci], matchIndices.has(ci) ? MATCH_ATTRS : RESULT_ATTRS);
        col += textCols(label[ci]);
      }

      if (context && contextCols <= room) {
        const contextX = width - 1 - rightReserved - textCols(context);
        if (contextX > col) writeString(grid, y, contextX, context, CATEGORY_ATTRS);
      }
    }

    // Scroll affordance: without it a list that continues below the fold looks
    // like the whole keymap, which is the specific wrong belief this overlay
    // exists to prevent.
    if (more) {
      const x = width - 1 - textCols(more);
      if (x > 0) writeString(grid, rect.top + moreRow, x, more, DIM_ATTRS);
    }

    drawModalChrome(grid, chrome);
    return grid;
  }
}
