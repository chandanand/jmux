import type { CellGrid } from "../types";
import { ColorMode } from "../types";
import { createGrid, writeString, textCols } from "../cell-grid";
import { packChips, type PlacedChip } from "../band-layout";
import type { CommandCenterView } from "./views";

// The Command Center's strip — always visible now that it's the only chrome
// that says a view exists, let alone that others are a keystroke away
// (before this it hid below two tabs, which is why nobody discovered tabs
// existed). It shows the view registry as chips, the active one carrying a
// dirty marker when the live axes it drove have since been narrowed away from
// it, and — separately from chip overflow — however many active tiles the
// client cap refused (`GlassView.getDroppedActive()`), because a number that
// bounds coverage and says nothing about it is silent about data loss.
//
// The active density's label rides flush right beside that overflow count
// (`densityLabel`): a mode is only tolerable if the surface it changes also
// says which one is active, and the strip is the one piece of chrome always
// on screen while the grid is.

export const STRIP_ROWS = 1;
const GAP = 1; // blank column between chips, and between right-cluster items
const HIDDEN_RESERVE = 5; // cols kept clear at the right for the "+N" hidden-chip indicator
const DROPPED_GAP = 2; // blank columns before the right cluster (density + dropped count), when shown

export interface StripInput {
  views: CommandCenterView[];
  activeViewId: string;
  /** The live axes have moved on from the active view's own saved axes. */
  dirty: boolean;
  /** Active tiles the client cap refused this reconcile — never silent. */
  droppedActive: number;
  /** The active density's display label (`DENSITIES[d].label`). */
  densityLabel: string;
  width: number;
}

const DIRTY_SUFFIX = " ·";

function chipText(view: CommandCenterView, isActive: boolean, dirty: boolean): string {
  const suffix = isActive && dirty ? DIRTY_SUFFIX : "";
  return ` ${view.name}${suffix} `;
}

/** "+3 not shown" — empty when nothing was dropped, so no width is reserved. */
function droppedText(droppedActive: number): string {
  return droppedActive > 0 ? `+${droppedActive} not shown` : "";
}

/**
 * Columns the right cluster (density label, then dropped-tile count) claims
 * out of the strip's width — reserved ahead of chip packing so a narrow strip
 * drops chips before it drops the mode indicator, the same priority the
 * dropped-tile count already had over chips.
 */
function rightClusterCols(densityLabel: string, dropped: string): number {
  if (!densityLabel && !dropped) return 0;
  const items = [densityLabel, dropped].filter((s) => s.length > 0);
  const itemCols = items.reduce((sum, s) => sum + textCols(s), 0);
  const gaps = (items.length - 1) * GAP;
  return itemCols + gaps + DROPPED_GAP;
}

export function layoutStrip(input: StripInput): PlacedChip[] {
  const dropped = droppedText(input.droppedActive);
  const rightReserve = rightClusterCols(input.densityLabel, dropped);
  const available = Math.max(0, input.width - rightReserve);

  // Natural display width of each chip.
  const widths = input.views.map((v) =>
    textCols(chipText(v, v.id === input.activeViewId, input.dirty)),
  );

  // Total width if every chip were laid out (GAP between adjacent chips).
  let total = 0;
  for (let i = 0; i < widths.length; i++) total += widths[i] + (i > 0 ? GAP : 0);

  // When everything fits, use all the available width; otherwise reserve room
  // for the "+N" hidden-chip indicator and pack whole chips into the rest.
  const fitsAll = total <= available;
  const budget = fitsAll ? available : Math.max(0, available - HIDDEN_RESERVE);

  const items = input.views.map((v, i) => ({ id: v.id, width: widths[i] }));
  return packChips(items, { start: 0, budget, align: "left", gap: GAP });
}

export function renderStrip(
  input: StripInput,
  chips: PlacedChip[] = layoutStrip(input),
): CellGrid {
  const grid = createGrid(input.width, STRIP_ROWS);

  for (const chip of chips) {
    const view = input.views.find((v) => v.id === chip.id)!;
    const isActive = chip.id === input.activeViewId;
    const text = chipText(view, isActive, input.dirty);
    writeString(grid, 0, chip.x, text, {
      fgMode: ColorMode.Palette,
      fg: isActive ? 15 : 8,
      bold: isActive,
      dim: !isActive,
    });
  }

  const dropped = droppedText(input.droppedActive);
  const rightReserve = rightClusterCols(input.densityLabel, dropped);
  const available = Math.max(0, input.width - rightReserve);

  // Hidden-chip indicator: some views didn't fit in the chip band.
  const hidden = input.views.length - chips.length;
  if (hidden > 0) {
    const label = `+${hidden}`;
    const col = available - textCols(label);
    if (col >= 0) {
      writeString(grid, 0, col, label, {
        fgMode: ColorMode.Palette,
        fg: 8,
        dim: true,
      });
    }
  }

  // The right cluster itself: dropped-tile count flush against the right
  // edge, the density label immediately to its left — or flush right on its
  // own when nothing was dropped. Distinct from the hidden-chip indicator
  // above, which is about the strip running out of room, not the grid.
  let rightCol = input.width;
  if (dropped) {
    rightCol -= textCols(dropped);
    if (rightCol >= 0) {
      writeString(grid, 0, rightCol, dropped, {
        fgMode: ColorMode.Palette,
        fg: 8,
        dim: true,
      });
    }
    rightCol -= GAP;
  }
  if (input.densityLabel) {
    rightCol -= textCols(input.densityLabel);
    if (rightCol >= 0) {
      writeString(grid, 0, rightCol, input.densityLabel, {
        fgMode: ColorMode.Palette,
        fg: 8,
        dim: true,
      });
    }
  }

  return grid;
}
