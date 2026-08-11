/**
 * Command Center density — the tile-size floor `GlassView`'s grid lays out
 * against (`GlassViewOptions.minTileWidth` / `minTileHeight`), named so the
 * mode the user is in is never a guess.
 *
 * There are only two intents a tile size can serve: read one properly, or
 * watch them all. A single fixed floor — the grid's pre-density behaviour —
 * split the difference and served neither: on a ~50-row terminal with 9
 * running agents it rendered 2x5 tiles at 8 content lines each, too small to
 * read or type into and too large to be a useful list.
 *
 * This shipped once as three modes (comfortable/compact/overview) and was
 * cut back to two after measuring actual tile counts and interior line
 * counts against a real 214-col x 49-row content area — the Command
 * Center's usable area on a roomy but unexceptional terminal — at agent
 * counts from a small team up to a crowded one:
 *
 * ```
 *         N=3          N=6          N=9          N=14
 * Focus   3/3 @ 22ln   4/6 @ 22ln   4/9 @ 22ln   4/14 @ 22ln
 * (was    3/3 @ 22ln   6/6 @ 14ln   8/9 @ 10ln   8/14 @ 10ln)  <- compact, deleted
 * Fit     3/3 @ 47ln   6/6 @ 22ln   9/9 @ 14ln  14/14 @ 7ln
 * ```
 *
 * The deleted middle row ("compact", 80x12) was *dominated* at every N>3: at
 * N=9 it showed 8 of 9 tiles at 10 lines while `fit` showed 9 of 9 at 14 —
 * strictly worse on both axes simultaneously, not merely a worse tradeoff.
 * The cause was structural rather than a bad constant: at 80 columns wide it
 * can never reach a third column on a 214-col area (`floor(214/80) = 2`, same
 * as `focus`'s 100), so it pays `focus`'s extra-row-scrolling penalty
 * without `fit`'s width benefit. Retuning it to close that gap (70x14) makes
 * it *identical* to `fit` at N=3, 6 and 9 — there turned out to be no floor
 * that gives a third mode a job distinct from the two below. If a future
 * change reintroduces a middle density, re-run this table first: the numbers
 * are the argument, not the width/height constants themselves.
 *
 *   fit    60 x 6  -> everything visible, sized to whatever fits. This is
 *          the default: it's what "Command Center" means, and at a crowded
 *          9 agents it's 14 readable lines against the 8 the old fixed floor
 *          gave.
 *   focus  100 x 22 -> four big, legible, typeable tiles; the rest scroll,
 *          and focus keeps the current tile in view. For reading or typing
 *          into one agent at a time.
 */
export type Density = "focus" | "fit";

export interface DensitySpec {
  minTileWidth: number;
  minTileHeight: number;
  label: string;
}

export const DENSITIES: Record<Density, DensitySpec> = {
  fit: { minTileWidth: 60, minTileHeight: 6, label: "Fit" },
  focus: { minTileWidth: 100, minTileHeight: 22, label: "Focus" },
};

export const DEFAULT_DENSITY: Density = "fit";

/**
 * Toggle between the two densities. Two values makes this a swap, not a
 * ring — `cycleDensity(cycleDensity(d)) === d` for both, unlike the old
 * three-mode cycle this replaced.
 */
export function cycleDensity(d: Density): Density {
  return d === "fit" ? "focus" : "fit";
}

/**
 * Defensive: config is hand-editable JSON, and also the landing spot for a
 * value written by an older jmux with a third density that no longer
 * exists. Anything other than the two known values falls back to the
 * default rather than reaching `computeTileLayout` with an undefined spec.
 */
export function normalizeDensity(raw: unknown): Density {
  return raw === "fit" || raw === "focus" ? raw : DEFAULT_DENSITY;
}
