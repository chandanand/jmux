/**
 * Command Center density — the tile-size floor `GlassView`'s grid lays out
 * against (`GlassViewOptions.minTileWidth` / `minTileHeight`), named so the
 * mode the user is in is never a guess.
 *
 * One tile size cannot serve both jobs the grid is asked to do. Triage
 * ("who needs me?") wants many small tiles; driving ("read what an agent
 * said and type back") wants few large ones. A single floor — the grid's
 * pre-density behaviour — split the difference and served neither: on a
 * ~50-row terminal with 9 running agents it rendered 2x5 tiles at 8 content
 * lines each, too small to read or type into and too large to be a useful
 * list. So the floor is now a named mode the user picks, not a "will it
 * fit" constant.
 *
 * The three floors below are chosen against a 214-col x 50-row content area
 * — the Command Center's usable area on a roomy but unexceptional terminal
 * (`computeTileLayout`'s `columns = floor(mainWidth / minTileWidth)`, rows
 * likewise off height):
 *
 *   comfortable  90 x 22 -> floor(214/90)=2 cols, floor(50/22)=2 rows -> 2x2 = 4 tiles,
 *                ~20 interior lines each (tileHeight 25, minus the 2-row
 *                border). Readable and typeable — this is "driving".
 *   compact      80 x 12 -> floor(214/80)=2 cols, floor(50/12)=4 rows -> 2x4 = 8 tiles,
 *                ~10 interior lines. The grid's old fixed floor
 *                (minTileHeight: 10), kept as a middle option rather than
 *                the only one.
 *   overview     60 x 6  -> floor(214/60)=3 cols, floor(50/6)=8 rows -> 3x8 = 24 tiles,
 *                ~4 interior lines. A bird's-eye: enough to see what each
 *                agent is doing right now, nothing more — this is "triage".
 *
 * Default is `comfortable`, deliberately not `compact`: the density this
 * feature exists to move users off of is not inherently useful as a
 * default, only as one option among three.
 */
export type Density = "comfortable" | "compact" | "overview";

export interface DensitySpec {
  minTileWidth: number;
  minTileHeight: number;
  label: string;
}

export const DENSITIES: Record<Density, DensitySpec> = {
  comfortable: { minTileWidth: 90, minTileHeight: 22, label: "Comfortable" },
  compact: { minTileWidth: 80, minTileHeight: 12, label: "Compact" },
  overview: { minTileWidth: 60, minTileHeight: 6, label: "Overview" },
};

export const DEFAULT_DENSITY: Density = "comfortable";

/** Cycle order: most detail first, least detail last, then back around. */
const CYCLE: readonly Density[] = ["comfortable", "compact", "overview"];

/** Step to the next density, wrapping. `Ctrl-a D` in the glass arm. */
export function cycleDensity(d: Density): Density {
  const index = CYCLE.indexOf(d);
  return CYCLE[(index + 1) % CYCLE.length]!;
}

/**
 * Defensive: config is hand-editable JSON. Anything other than the three
 * known values — missing, mistyped, a value from a future jmux — falls back
 * to the default rather than reaching `computeTileLayout` with an undefined
 * spec.
 */
export function normalizeDensity(raw: unknown): Density {
  return raw === "comfortable" || raw === "compact" || raw === "overview" ? raw : DEFAULT_DENSITY;
}
