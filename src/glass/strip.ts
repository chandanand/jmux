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

/** Trim a chip's text to the columns it was actually given, ellipsising when
 *  it has to cut. Width-1 "…" so the column model and the terminal agree. */
function fitChip(text: string, cols: number, keepTail = ""): string {
  if (cols <= 0) return "";
  if (textCols(text) <= cols) return text;
  // The dirty marker lives at the tail, so a naive truncation removes exactly
  // the thing the strip is obliged to keep: "which view, and is it modified".
  // Reserve the tail, cut the name, and put the tail back.
  const tailCols = textCols(keepTail);
  const budget = Math.max(0, cols - 1 - tailCols);
  let out = "";
  for (const ch of text) {
    if (textCols(out + ch) > budget) break;
    out += ch;
  }
  return out + "\u2026" + keepTail;
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

  if (fitsAll) {
    return packChips(items, { start: 0, budget, align: "left", gap: GAP });
  }

  // Everything doesn't fit — pack a *window* around the active chip rather
  // than the plain prefix packChips would give: prefix packing drops
  // whatever falls after the first overflow, which can be the active chip
  // itself (views "First, Active" on a narrow strip showed "First" and
  // dropped the one chip that must always be on screen). Mirrors
  // `layoutPreviewTabs`' widen-from-active algorithm (panel-view-renderer.ts)
  // — the same "the active item is the one thing a scrollable strip must
  // never truncate away" rule this codebase already has prior art for.
  const activeIndex = Math.max(0, input.views.findIndex((v) => v.id === input.activeViewId));

  // The active chip alone can exceed the budget — a long view name on a narrow
  // strip. Windowing selects it correctly but `packChips` then places nothing,
  // so the strip renders empty and the one thing it exists to say (which view
  // you are in) is the thing missing. Clamp it to the budget and let
  // `renderStrip` truncate the text; a shortened name beats no name.
  if ((widths[activeIndex] ?? 0) > budget) {
    return budget > 0 ? [{ id: input.views[activeIndex]!.id, x: 0, width: budget }] : [];
  }

  let start = activeIndex;
  let end = activeIndex;
  let used = widths[activeIndex] ?? 0;
  for (;;) {
    const nextW = end + 1 < widths.length ? widths[end + 1]! + GAP : 0;
    const prevW = start > 0 ? widths[start - 1]! + GAP : 0;
    const canRight = nextW > 0 && used + nextW <= budget;
    const canLeft = prevW > 0 && used + prevW <= budget;
    if (!canRight && !canLeft) break;
    // Right first when both are open and no wider, so the common case (near
    // the start, or the whole set fits) reads left-to-right as written.
    if (canRight && (!canLeft || nextW <= prevW)) { used += nextW; end++; }
    else { used += prevW; start--; }
  }

  // The window's own total is <= budget by construction (the loop above only
  // ever grows it while that holds), so every chip in [start, end] packs —
  // packChips here can only ever place the whole slice, never a partial
  // prefix of it.
  return packChips(items.slice(start, end + 1), { start: 0, budget, align: "left", gap: GAP });
}

export function renderStrip(
  input: StripInput,
  chips: PlacedChip[] = layoutStrip(input),
): CellGrid {
  const grid = createGrid(input.width, STRIP_ROWS);

  for (const chip of chips) {
    const view = input.views.find((v) => v.id === chip.id)!;
    const isActive = chip.id === input.activeViewId;
    // Honour the width the layout placed, not the chip's natural width: the
    // active chip is clamped rather than dropped when it cannot fit, so this is
    // where that clamp becomes a readable string.
    const dirtyTail = isActive && input.dirty ? DIRTY_SUFFIX : "";
    const text = fitChip(chipText(view, isActive, input.dirty), chip.width, dirtyTail);
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
