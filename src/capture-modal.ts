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

const DESCRIPTION_ROWS = 4;

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

export class CaptureModal {
  private _open = false;
  private config: CaptureModalConfig;
  private field: Field = "title";
  private title = "";
  private description = "";
  private teamIndex = 0;

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

  getCursorPosition(): { row: number; col: number } | null {
    if (this.field === "title") return { row: TITLE_ROW, col: VALUE_COL + this.title.length };
    if (this.field === "team") return { row: TEAM_ROW, col: VALUE_COL + this.currentTeamName().length };
    const lines = this.description.split("\n").slice(-DESCRIPTION_ROWS);
    return {
      row: BODY_ROW + lines.length - 1,
      col: BODY_COL + lines[lines.length - 1]!.length,
    };
  }

  handleInput(data: string): ModalAction {
    if (data === "\x1b") { this.close(); return { type: "closed" }; }

    if (data === "\t") { this.moveField(1); return { type: "consumed" }; }
    if (data === "\x1b[Z") { this.moveField(-1); return { type: "consumed" }; }

    // Ctrl-S commits and starts from any field.
    if (data === "\x13") return this.commit("start");

    if (this.field === "team") {
      if (data === "\x1b[C" || data === "\x1b[B") { this.cycleTeam(1); return { type: "consumed" }; }
      if (data === "\x1b[D" || data === "\x1b[A") { this.cycleTeam(-1); return { type: "consumed" }; }
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

    if (data.length === 1 && data >= " " && data <= "~") {
      if (this.field === "title") this.title += data;
      else this.description += data;
      return { type: "consumed" };
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

    const fieldWidth = Math.max(0, width - VALUE_COL - 2);

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
        writeString(grid, row, VALUE_COL, value.slice(0, fieldWidth), fieldText);
      } else if (placeholder) {
        // An empty focused field still shows its caret, so the placeholder
        // starts past it rather than being clipped by it.
        const at = focused ? VALUE_COL + 2 : VALUE_COL;
        writeString(grid, row, at, placeholder.slice(0, Math.max(0, fieldWidth - (at - VALUE_COL))), fieldHint);
      }
      if (focused) {
        const caretCol = VALUE_COL + Math.min(value.length, fieldWidth - 1);
        writeString(grid, row, caretCol, CARET, fieldText);
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
      this.field === "team" ? "◂ ▸" : "",
    );

    const bodyFocused = this.field === "description";
    writeString(grid, BODY_LABEL_ROW, LABEL_COL, bodyFocused ? "▷" : " ", PROMPT_ATTRS);
    writeString(grid, BODY_LABEL_ROW, LABEL_COL + 2, "Description", bodyFocused ? INPUT_ATTRS : SUBHEADER_ATTRS);

    const bodyWidth = Math.max(0, width - BODY_COL - 2);
    for (let i = 0; i < DESCRIPTION_ROWS; i++) {
      writeString(grid, BODY_ROW + i, BODY_COL, " ".repeat(bodyWidth), fieldBg);
    }
    const lines = this.description.split("\n").slice(-DESCRIPTION_ROWS);
    if (this.description) {
      lines.forEach((line, i) => {
        writeString(grid, BODY_ROW + i, BODY_COL, line.slice(0, bodyWidth), fieldText);
      });
    } else {
      writeString(grid, BODY_ROW, BODY_COL, BODY_PLACEHOLDER.slice(0, bodyWidth), fieldHint);
    }
    if (bodyFocused) {
      const last = lines[lines.length - 1] ?? "";
      const caretCol = BODY_COL + Math.min(last.length, bodyWidth - 1);
      writeString(grid, BODY_ROW + lines.length - 1, caretCol, CARET, fieldText);
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
