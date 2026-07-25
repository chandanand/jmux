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
import { createGrid, writeString } from "./cell-grid";
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
    if (this.field === "title") return { row: 2, col: 9 + this.title.length };
    if (this.field === "team") return { row: 3, col: 9 + this.currentTeamName().length };
    const lines = this.description.split("\n");
    return { row: 5 + Math.min(lines.length - 1, DESCRIPTION_ROWS - 1), col: 4 + lines[lines.length - 1]!.length };
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
    const height = 5 + DESCRIPTION_ROWS + 2;
    const grid = createGrid(width, height);
    for (let r = 0; r < height; r++) {
      writeString(grid, r, 0, " ".repeat(width), BG_ATTRS);
    }

    writeString(grid, 0, 2, "New issue", HEADER_ATTRS);

    const fieldRow = (label: string, row: number, value: string, focused: boolean): void => {
      writeString(grid, row, 2, focused ? "▷" : " ", PROMPT_ATTRS);
      writeString(grid, row, 4, label.padEnd(5), focused ? INPUT_ATTRS : SUBHEADER_ATTRS);
      writeString(grid, row, 9, value.slice(0, Math.max(0, width - 11)), focused ? INPUT_ATTRS : SUBHEADER_ATTRS);
    };

    fieldRow("Title", 2, this.title, this.field === "title");
    fieldRow("Team", 3, this.currentTeamName() + (this.field === "team" ? "  ◂ ▸" : ""), this.field === "team");

    writeString(grid, 4, 2, this.field === "description" ? "▷" : " ", PROMPT_ATTRS);
    writeString(grid, 4, 4, "Description", this.field === "description" ? INPUT_ATTRS : SUBHEADER_ATTRS);

    const lines = this.description.split("\n").slice(-DESCRIPTION_ROWS);
    lines.forEach((line, i) => {
      writeString(grid, 5 + i, 4, line.slice(0, Math.max(0, width - 6)), INPUT_ATTRS);
    });

    writeString(
      grid,
      height - 1,
      2,
      "↵ capture  ·  ^S capture & start  ·  tab field  ·  esc cancel",
      DIM_ATTRS,
    );

    return grid;
  }
}
