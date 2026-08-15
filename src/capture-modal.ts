// The capture composer: one form, two commit points.
//
// The old flow was three sequential modals (team → title → description) and
// then a separate hunt for the issue in the panel to press `n` on it. That
// splits one intention ("I just thought of something") across two tools and a
// context switch. Here the fork lives in the commit key instead:
//
//   Enter   — file it and stay where you are   (an idea for later)
//   Ctrl-S  — file it and start working on it  (the common case)
//
// Ctrl-S rather than Shift-Enter because terminals do not reliably distinguish
// Shift-Enter from Enter, and a commit key that silently does the wrong thing
// in some terminals is worse than an unfamiliar one. Both are shown in the
// hint row so the fork is discoverable without documentation.

import type { CellGrid } from "./types";
import { ColorMode } from "./types";
import { createGrid, writeString, type CellAttrs } from "./cell-grid";
import { theme } from "./theme";
import {
  HEADER_ATTRS, SUBHEADER_ATTRS, PROMPT_ATTRS, INPUT_ATTRS, BG_ATTRS, DIM_ATTRS,
  type ModalAction,
} from "./modal";

export interface CaptureResult {
  mode: "capture" | "start";
  teamId: string;
  title: string;
  description: string;
}

export interface CaptureModalConfig {
  teams: Array<{ id: string; name: string }>;
  preselectedTeamId: string | null;
  /** Seed body, e.g. the selected text or last lines of the pane you were in. */
  initialDescription?: string;
}

type Field = "title" | "team" | "description";
const FIELD_ORDER: Field[] = ["title", "team", "description"];

// Six rows rather than four: with wrapping in place the body is where a real
// description actually goes, and four rows scrolled away almost immediately.
const DESCRIPTION_ROWS = 6;

// Row/column geometry, named so getGrid and getCursorPosition cannot drift —
// a caret drawn one column off from the text it follows is exactly the kind of
// bug that makes a working modal look frozen.
const TITLE_ROW = 2;
const TEAM_ROW = 3;
const BODY_LABEL_ROW = 5;
const BODY_ROW = 6;
const LABEL_COL = 2;
/** Values start past the label gutter, so text never abuts its own label. */
const VALUE_COL = 15;
const BODY_COL = 4;
const CARET = "█";

const TITLE_PLACEHOLDER = "What needs doing?";
const BODY_PLACEHOLDER = "Context, links, repro steps…";

/**
 * Soft-wrap text to `width`, preserving explicit newlines.
 *
 * Breaks at the last space that fits, and hard-breaks a single word too long
 * for the field so an unbroken URL or stack frame can't stall the wrap. The
 * break space is consumed (standard for soft wrapping); every other character,
 * including trailing spaces, survives — the caret is positioned from this
 * output, so anything dropped here would desync it from the text.
 */
export function wrapText(text: string, width: number): string[] {
  if (width <= 0) return [text];
  const out: string[] = [];
  for (const paragraph of text.split("\n")) {
    let rest = paragraph;
    while (rest.length > width) {
      let cut = rest.lastIndexOf(" ", width);
      // No space to break on (or it would yield an empty line) — hard break.
      if (cut <= 0) cut = width;
      out.push(rest.slice(0, cut));
      rest = rest.slice(cut === width ? cut : cut + 1);
    }
    out.push(rest);
  }
  return out;
}

export class CaptureModal {
  private _open = false;
  private config: CaptureModalConfig;
  private field: Field = "title";
  private title = "";
  private description = "";
  private teamIndex = 0;
  private lastWidth = 60;

  constructor(config: CaptureModalConfig) {
    this.config = config;
  }

  open(): void {
    this._open = true;
    this.field = "title";
    this.title = "";
    this.description = this.config.initialDescription ?? "";
    const pre = this.config.preselectedTeamId;
    const idx = pre ? this.config.teams.findIndex((t) => t.id === pre) : -1;
    this.teamIndex = idx >= 0 ? idx : 0;
  }

  close(): void { this._open = false; }
  isOpen(): boolean { return this._open; }

  currentTeamId(): string {
    return this.config.teams[this.teamIndex]?.id ?? "";
  }

  private currentTeamName(): string {
    return this.config.teams[this.teamIndex]?.name ?? "(no team)";
  }

  preferredWidth(termCols: number): number {
    return Math.min(Math.max(48, Math.round(termCols * 0.5)), 72);
  }

  /** Interior widths, derived from the modal width in one place. */
  private metrics(width: number): { fieldWidth: number; bodyWidth: number } {
    return {
      fieldWidth: Math.max(1, width - VALUE_COL - 2),
      bodyWidth: Math.max(1, width - BODY_COL - 2),
    };
  }

  /**
   * The body as visual rows, plus the caret's row/column within them. A full
   * final row gets an extra empty row so the caret has somewhere to sit rather
   * than hanging one column past the field edge.
   */
  private bodyLayout(bodyWidth: number): { lines: string[]; caretRow: number; caretCol: number } {
    const wrapped = wrapText(this.description, bodyWidth);
    const last = wrapped[wrapped.length - 1]!;
    const lines = last.length >= bodyWidth ? [...wrapped, ""] : wrapped;
    const visible = lines.slice(-DESCRIPTION_ROWS);
    return {
      lines: visible,
      caretRow: visible.length - 1,
      caretCol: visible[visible.length - 1]!.length,
    };
  }

  /**
   * A window onto a single-line value that keeps its tail visible. Without
   * this a title longer than the field shows only its opening characters, so
   * you cannot see what you are typing.
   */
  private windowed(value: string, fieldWidth: number): string {
    return value.length <= fieldWidth - 1 ? value : value.slice(value.length - (fieldWidth - 1));
  }

  getCursorPosition(): { row: number; col: number } | null {
    // The renderer asks for the cursor without passing a width, so this mirrors
    // the last width getGrid was called with — anything else and the caret
    // desyncs from the wrap it is supposed to follow.
    const { fieldWidth, bodyWidth } = this.metrics(this.lastWidth);
    if (this.field === "title") {
      return { row: TITLE_ROW, col: VALUE_COL + this.windowed(this.title, fieldWidth).length };
    }
    if (this.field === "team") {
      return { row: TEAM_ROW, col: VALUE_COL + this.windowed(this.currentTeamName(), fieldWidth).length };
    }
    const body = this.bodyLayout(bodyWidth);
    return { row: BODY_ROW + body.caretRow, col: BODY_COL + body.caretCol };
  }

  handleInput(data: string): ModalAction {
    if (data === "\x1b") { this.close(); return { type: "closed" }; }

    if (data === "\t") { this.moveField(1); return { type: "consumed" }; }
    if (data === "\x1b[Z") { this.moveField(-1); return { type: "consumed" }; }

    // Ctrl-S commits and starts from any field.
    if (data === "\x13") return this.commit("start");

    if (this.field === "team") {
      if (data === "\x1b[C" || data === "\x1b[B" || data === "l" || data === "j") {
        this.cycleTeam(1);
        return { type: "consumed" };
      }
      if (data === "\x1b[D" || data === "\x1b[A" || data === "h" || data === "k") {
        this.cycleTeam(-1);
        return { type: "consumed" };
      }
      if (data === "\r") return this.commit("capture");
      return { type: "consumed" };
    }

    if (data === "\r") {
      // In the body, Enter is a newline — committing a multi-line description
      // would otherwise be impossible.
      if (this.field === "description") {
        this.description += "\n";
        return { type: "consumed" };
      }
      return this.commit("capture");
    }

    if (data === "\x7f" || data === "\b") {
      if (this.field === "title") this.title = this.title.slice(0, -1);
      else this.description = this.description.slice(0, -1);
      return { type: "consumed" };
    }

    // Ctrl-U clears the focused field.
    if (data === "\x15") {
      if (this.field === "title") this.title = "";
      else this.description = "";
      return { type: "consumed" };
    }

    // Text input accepts a whole chunk, not just single keys: a terminal
    // coalesces fast typing into one read, and a paste arrives as one large
    // chunk wrapped in bracketed-paste markers (jmux enables ?2004h). Matching
    // only single characters silently drops both.
    const chunk = data.replace(/\x1b\[20[01]~/g, "");
    if (chunk && !chunk.startsWith("\x1b")) {
      let text = "";
      for (const ch of chunk) {
        if (ch === "\n" || ch === "\r") {
          // The title is single-line; a pasted newline becomes a space rather
          // than corrupting it.
          text += this.field === "description" ? "\n" : " ";
        } else if (ch >= " " && ch !== "\x7f") {
          text += ch;
        }
      }
      if (text) {
        if (this.field === "title") this.title += text;
        else this.description += text;
      }
    }

    return { type: "consumed" };
  }

  private moveField(delta: number): void {
    const i = FIELD_ORDER.indexOf(this.field);
    this.field = FIELD_ORDER[(i + delta + FIELD_ORDER.length) % FIELD_ORDER.length]!;
  }

  private cycleTeam(delta: number): void {
    const n = this.config.teams.length;
    if (n === 0) return;
    this.teamIndex = (this.teamIndex + delta + n) % n;
  }

  private commit(mode: "capture" | "start"): ModalAction {
    // A titleless issue is never what the user meant; swallow the key rather
    // than filing a blank row into a shared tracker.
    if (this.title.trim().length === 0) return { type: "consumed" };
    const result: CaptureResult = {
      mode,
      teamId: this.currentTeamId(),
      title: this.title.trim(),
      description: this.description,
    };
    this.close();
    return { type: "result", value: result };
  }

  getGrid(width: number): CellGrid {
    this.lastWidth = width;
    const height = BODY_ROW + DESCRIPTION_ROWS + 2;
    const grid = createGrid(width, height);
    for (let r = 0; r < height; r++) {
      writeString(grid, r, 0, " ".repeat(width), BG_ATTRS);
    }

    // Field surfaces are read from `theme` at render time rather than captured
    // at module load, so a late terminal-background detection re-themes them
    // without a rebuild hook (cf. rebuildModalAttrs).
    const fieldBg: CellAttrs = { bg: theme.hover, bgMode: ColorMode.RGB };
    const fieldText: CellAttrs = { ...INPUT_ATTRS, bg: theme.hover, bgMode: ColorMode.RGB };
    const fieldHint: CellAttrs = { ...SUBHEADER_ATTRS, bg: theme.hover, bgMode: ColorMode.RGB };

    writeString(grid, 0, LABEL_COL, "New issue", HEADER_ATTRS);

    const { fieldWidth, bodyWidth } = this.metrics(width);

    /** One labelled single-line field, with its own input surface. */
    const fieldRow = (
      label: string,
      row: number,
      value: string,
      focused: boolean,
      placeholder = "",
      suffix = "",
    ): void => {
      writeString(grid, row, LABEL_COL, focused ? "▷" : " ", PROMPT_ATTRS);
      writeString(grid, row, LABEL_COL + 2, label, focused ? INPUT_ATTRS : SUBHEADER_ATTRS);
      // The field surface is always painted, so an empty field still looks like
      // somewhere you can type.
      writeString(grid, row, VALUE_COL, " ".repeat(fieldWidth), fieldBg);
      if (value) {
        // Windowed onto the tail so a long value stays readable as you type.
        writeString(grid, row, VALUE_COL, this.windowed(value, fieldWidth), fieldText);
      } else if (placeholder) {
        // An empty focused field still shows its caret, so the placeholder
        // starts past it rather than being clipped by it.
        const at = focused ? VALUE_COL + 2 : VALUE_COL;
        writeString(grid, row, at, placeholder.slice(0, Math.max(0, fieldWidth - (at - VALUE_COL))), fieldHint);
      }
      if (focused) {
        writeString(grid, row, VALUE_COL + this.windowed(value, fieldWidth).length, CARET, fieldText);
      }
      if (suffix) {
        const col = VALUE_COL + fieldWidth - suffix.length;
        if (col > VALUE_COL) writeString(grid, row, col, suffix, fieldHint);
      }
    };

    fieldRow("Title", TITLE_ROW, this.title, this.field === "title", TITLE_PLACEHOLDER);
    fieldRow(
      "Team",
      TEAM_ROW,
      this.currentTeamName(),
      this.field === "team",
      "",
      this.field === "team" ? "h/l" : "",
    );

    const bodyFocused = this.field === "description";
    writeString(grid, BODY_LABEL_ROW, LABEL_COL, bodyFocused ? "▷" : " ", PROMPT_ATTRS);
    writeString(grid, BODY_LABEL_ROW, LABEL_COL + 2, "Description", bodyFocused ? INPUT_ATTRS : SUBHEADER_ATTRS);

    for (let i = 0; i < DESCRIPTION_ROWS; i++) {
      writeString(grid, BODY_ROW + i, BODY_COL, " ".repeat(bodyWidth), fieldBg);
    }
    const body = this.bodyLayout(bodyWidth);
    if (this.description) {
      body.lines.forEach((line, i) => {
        writeString(grid, BODY_ROW + i, BODY_COL, line, fieldText);
      });
    } else {
      const at = bodyFocused ? BODY_COL + 2 : BODY_COL;
      writeString(grid, BODY_ROW, at, BODY_PLACEHOLDER.slice(0, bodyWidth - (at - BODY_COL)), fieldHint);
    }
    if (bodyFocused) {
      writeString(grid, BODY_ROW + body.caretRow, BODY_COL + body.caretCol, CARET, fieldText);
    }

    writeString(
      grid,
      height - 1,
      LABEL_COL,
      "↵ capture  ·  ^S capture & start  ·  tab field  ·  esc cancel",
      DIM_ATTRS,
    );

    return grid;
  }
}
