import type { CellGrid } from "../types";
import { ColorMode } from "../types";
import { tokens } from "../chrome-tokens";
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
// The right cluster is the grid's four axes — group, sort, filter, density —
// as clickable chips beside that overflow count (`axes`, laid out by
// `layoutStripActions`): a mode is only tolerable if the surface it changes
// also says which one is active, and the strip is the one piece of chrome
// always on screen while the grid is. They mirror the sidebar header's
// `⊞ <Group>` / `⇅ <Sort>` chips, and click through to the same actions
// `Ctrl-a G/s/f/D` run in glass, so mouse and keyboard cannot disagree.

export const STRIP_ROWS = 1;
const GAP = 1; // blank column between chips, and between right-cluster items
const HIDDEN_RESERVE = 5; // cols kept clear at the right for the "+N" hidden-chip indicator
const DROPPED_GAP = 2; // blank columns before the right cluster (axis chips + dropped count), when shown
// Columns the active view chip must keep before the axis cluster gives up its
// words: enough for a short name plus the dirty marker. Below this the cluster
// degrades to glyphs alone (still clickable), never the other way round.
const MIN_VIEW_COLS = 12;

/** Short labels for the four axis chips; an empty label omits its chip. */
export interface StripAxes {
  group: string;
  sort: string;
  filter: string;
  density: string;
}
export const NO_AXES: StripAxes = { group: "", sort: "", filter: "", density: "" };
export type StripAxisId = keyof StripAxes;

// One glyph per axis, all width-1 in `cellWidth` — the sidebar header's own
// for group and sort, so the two surfaces read alike.
const AXIS_ORDER: StripAxisId[] = ["group", "sort", "filter", "density"];
const AXIS_GLYPH: Record<StripAxisId, string> = {
  group: "\u229e",   // ⊞
  sort: "\u21c5",    // ⇅
  filter: "\u2207",  // ∇
  density: "\u25a4", // ▤
};

export interface StripInput {
  views: CommandCenterView[];
  activeViewId: string;
  /** The live axes have moved on from the active view's own saved axes. */
  dirty: boolean;
  /** Active tiles the client cap refused this reconcile — never silent. */
  droppedActive: number;
  /** The four axis chips' labels (`groupModeShort` etc.; `DENSITIES[d].label`). */
  axes: StripAxes;
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

function axisChipText(id: StripAxisId, label: string, terse: boolean): string {
  return terse ? AXIS_GLYPH[id] : `${AXIS_GLYPH[id]} ${label}`;
}

interface AxisItem { id: StripAxisId; width: number }

/** The axis chips in reading order, at the given verbosity, with their widths. */
function axisItems(axes: StripAxes, terse: boolean): AxisItem[] {
  return AXIS_ORDER
    .filter((id) => axes[id].length > 0)
    .map((id) => ({ id, width: textCols(axisChipText(id, axes[id], terse)) }));
}

/**
 * Columns the right cluster (axis chips, then dropped-tile count) claims out
 * of the strip's width — reserved ahead of chip packing so a narrow strip
 * drops view chips before it drops the mode indicators, the same priority
 * the dropped-tile count already had over chips.
 */
function rightClusterCols(items: { width: number }[], dropped: string): number {
  const widths = items.map((i) => i.width);
  if (dropped) widths.push(textCols(dropped));
  if (widths.length === 0) return 0;
  const itemCols = widths.reduce((sum, w) => sum + w, 0);
  const gaps = (widths.length - 1) * GAP;
  return itemCols + gaps + DROPPED_GAP;
}

interface ClusterPlan {
  dropped: string;
  /** Chips carry glyphs only, their words given up to keep the active view chip. */
  terse: boolean;
  items: AxisItem[];
  /** Columns the cluster claims out of the strip's width. */
  reserve: number;
}

/**
 * The one answer to "what does the right cluster claim", shared by layout,
 * action placement and paint so the three cannot disagree. The cluster yields
 * *words* before the strip loses the active view chip, and never yields a
 * chip: a glyph alone still names its axis and still cycles it, where a
 * dropped chip is an axis the mouse can no longer reach.
 */
function planCluster(input: StripInput): ClusterPlan {
  const dropped = droppedText(input.droppedActive);
  const full = axisItems(input.axes, false);
  const fullReserve = rightClusterCols(full, dropped);
  const terse = input.width - fullReserve < MIN_VIEW_COLS;
  const items = terse ? axisItems(input.axes, true) : full;
  const reserve = terse ? rightClusterCols(items, dropped) : fullReserve;
  return { dropped, terse, items, reserve };
}

/** A placed axis chip: `PlacedChip` whose id is known to be an axis. */
export type PlacedAxisChip = PlacedChip & { id: StripAxisId };

/**
 * Places the axis chips right-aligned, immediately left of the dropped-tile
 * count. Ids are the axis names, so `chipAtCol` over the result answers
 * "which axis did the click land on". A chip pushed past the left edge is
 * dropped rather than drawn at a negative column.
 */
export function layoutStripActions(input: StripInput): PlacedAxisChip[] {
  const { dropped, items } = planCluster(input);
  let right = input.width - (dropped ? textCols(dropped) + GAP : 0);
  const out: PlacedAxisChip[] = [];
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]!;
    const x = right - item.width;
    if (x < 0) break;
    out.unshift({ id: item.id, x, width: item.width });
    right = x - GAP;
  }
  return out;
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
  const available = Math.max(0, input.width - planCluster(input).reserve);

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
  actions: PlacedAxisChip[] = layoutStripActions(input),
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

  const { dropped, terse, reserve } = planCluster(input);
  const available = Math.max(0, input.width - reserve);

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
  // edge, the axis chips immediately to its left — or flush right on their
  // own when nothing was dropped. Distinct from the hidden-chip indicator
  // above, which is about the strip running out of room, not the grid.
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
  // Same accent-muted chip style as the sidebar header's group/sort chips —
  // the glyph plus the mode name is the affordance there too.
  for (const chip of actions) {
    writeString(grid, 0, chip.x, axisChipText(chip.id, input.axes[chip.id], terse), {
      fg: tokens.accentMuted.fg,
      fgMode: tokens.accentMuted.fgMode,
    });
  }

  return grid;
}
