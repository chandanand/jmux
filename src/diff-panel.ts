import type { CellGrid } from "./types";
import { ColorMode } from "./types";
import { createGrid, writeString, type CellAttrs } from "./cell-grid";

export type DiffPanelState = "off" | "split" | "full";

const HINT_FG: CellAttrs = { fg: 8, fgMode: ColorMode.Palette, dim: true };
const HINT_KEY: CellAttrs = { fg: 2, fgMode: ColorMode.Palette };

const MIN_PANEL_COLS = 20;

export class DiffPanel {
  private _state: DiffPanelState = "off";
  private _hunkExited = false;

  get state(): DiffPanelState {
    return this._state;
  }

  get hunkExited(): boolean {
    return this._hunkExited;
  }

  isActive(): boolean {
    return this._state !== "off";
  }

  toggle(): void {
    if (this._state === "off") {
      this._state = "split";
    } else {
      this._state = "off";
      this._hunkExited = false;
    }
  }

  toggleZoom(): void {
    if (this._state === "split") {
      this._state = "full";
    } else if (this._state === "full") {
      this._state = "split";
    }
  }

  setState(state: DiffPanelState): void {
    this._state = state;
    if (state === "off") {
      this._hunkExited = false;
    }
  }

  setHunkExited(exited: boolean): void {
    this._hunkExited = exited;
  }

  calcPanelCols(availableCols: number, splitRatio: number): number {
    const raw = Math.floor(availableCols * splitRatio);
    return Math.max(MIN_PANEL_COLS, raw);
  }

  /**
   * The panel after hunk has exited — which now only happens when the user
   * quits it with `q`.
   *
   * This used to read "Switch sessions to reload", which described the only
   * mechanism jmux had at the time: content was fixed at spawn, so the way to
   * refresh it was to make jmux respawn. hunk is now launched with `--watch`
   * and follows the working tree on its own, so that line survived only as an
   * instruction to do something pointless. What the user actually needs here is
   * the way back.
   */
  getEmptyGrid(cols: number, rows: number): CellGrid {
    const grid = createGrid(cols, rows);
    const centerRow = Math.floor(rows / 2);
    const line1 = "Diff viewer closed";
    const col1 = Math.max(0, Math.floor((cols - line1.length) / 2));

    writeString(grid, centerRow - 1, col1, line1, HINT_FG);

    // Centred as one unit so the key chip lands where the eye expects it.
    const prefix = "Press ";
    const key = "Enter";
    const suffix = " to reopen";
    const width = prefix.length + key.length + suffix.length;
    const col2 = Math.max(0, Math.floor((cols - width) / 2));
    writeString(grid, centerRow, col2, prefix, HINT_FG);
    writeString(grid, centerRow, col2 + prefix.length, key, HINT_KEY);
    writeString(grid, centerRow, col2 + prefix.length + key.length, suffix, HINT_FG);
    return grid;
  }

  getNotFoundGrid(cols: number, rows: number): CellGrid {
    const grid = createGrid(cols, rows);
    const centerRow = Math.floor(rows / 2);
    const line1 = "hunk not found";
    const line2 = "npm i -g hunkdiff";
    const col1 = Math.max(0, Math.floor((cols - line1.length) / 2));
    const col2 = Math.max(0, Math.floor((cols - line2.length) / 2));

    writeString(grid, centerRow - 1, col1, line1, HINT_FG);
    writeString(grid, centerRow, col2, "Install: ", HINT_FG);
    writeString(grid, centerRow, col2 + 9, line2, HINT_KEY);
    return grid;
  }
}
