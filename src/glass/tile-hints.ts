// The focused tile's bottom-border hint — what phase 8 exists for. The grid's
// top border already carries a label chip (`drawBox`'s `label`); this is the
// bottom border's mirror, naming what the focused tile's keys do instead of
// what it is. Only the focused tile draws one, so exactly one hint is ever on
// screen and it moves with attention (see `GlassView`'s caller).

import { textCols } from "../cell-grid";

export interface TileHintsInput {
  /**
   * 1-based position of the tile's currently-displayed face among the
   * session's eligible panes. Meaningless (and unused) when `eligibleCount`
   * is 0 or 1 — there is nothing to cycle to, so the chord that would cycle
   * it is omitted entirely, the same no-op condition `GlassView.cycleFace()`
   * itself refuses to act on.
   */
  eligibleIndex: number;
  /** How many of the session's panes are eligible for the face cycle. */
  eligibleCount: number;
}

const SEP = " · ";

/**
 * Every hint the focused tile can show, in the spec's fixed order — the order
 * `buildTileHints` drops from the tail of as the tile narrows. `⌃Space x` is
 * itself conditional (single-pane sessions have nothing to cycle to), so a
 * one-pane session's hints already read one shorter before width ever enters
 * into it.
 */
function hintList(input: TileHintsInput): string[] {
  const hints = ["⇧↔ focus", "⌃Space↵ open"];
  if (input.eligibleCount > 1) {
    hints.push(`⌃Space x agent ${input.eligibleIndex}/${input.eligibleCount}`);
  }
  hints.push("⌃Space P hide");
  return hints;
}

/**
 * The focused tile's bottom-border hint, sized to fit `width` display
 * columns. Hints drop from the TAIL as the tile narrows — the first hint or
 * nothing, never a truncated one: a cut-off chord reads as a different,
 * wrong key, which is worse than no hint at all.
 *
 * Every glyph used here is width-1 (`⇧ ↔ ⌃ ↵ ·`), verified against
 * `cellWidth` — the same reason the drift marker elsewhere in this codebase
 * is `!` and not `⚠`. This string is measured with `textCols` and written
 * into a `CellGrid` like every other row; a width-2 glyph terminals disagree
 * about would desync every cell after it for the rest of the row.
 */
export function buildTileHints(input: TileHintsInput, width: number): string {
  if (width <= 0) return "";
  const hints = hintList(input);
  for (let n = hints.length; n > 0; n--) {
    const text = hints.slice(0, n).join(SEP);
    if (textCols(text) <= width) return text;
  }
  return "";
}
