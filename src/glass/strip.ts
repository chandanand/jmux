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

export const STRIP_ROWS = 1;
const GAP = 1; // blank column between chips
const HIDDEN_RESERVE = 5; // cols kept clear at the right for the "+N" hidden-chip indicator
const DROPPED_GAP = 2; // blank columns before the dropped-tile count, when shown

export interface StripInput {
  views: CommandCenterView[];
  activeViewId: string;
  /** The live axes have moved on from the active view's own saved axes. */
  dirty: boolean;
  /** Active tiles the client cap refused this reconcile — never silent. */
  droppedActive: number;
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

export function layoutStrip(input: StripInput): PlacedChip[] {
  const dropped = droppedText(input.droppedActive);
  const droppedReserve = dropped ? textCols(dropped) + DROPPED_GAP : 0;
  const available = Math.max(0, input.width - droppedReserve);

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
  const droppedReserve = dropped ? textCols(dropped) + DROPPED_GAP : 0;
  const available = Math.max(0, input.width - droppedReserve);

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

  // Dropped-tile count: flush right, distinct from the hidden-chip indicator
  // above (which is about the strip running out of room, not the grid).
  if (dropped) {
    const col = input.width - textCols(dropped);
    if (col >= 0) {
      writeString(grid, 0, col, dropped, {
        fgMode: ColorMode.Palette,
        fg: 8,
        dim: true,
      });
    }
  }

  return grid;
}
