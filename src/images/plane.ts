// src/images/plane.ts
//
// The image plane: the layer that turns image marks left in a composited frame
// into kitty graphics commands, and keeps the terminal's idea of what's on
// screen in step with jmux's.
//
// **Why marks in cells rather than a placement list passed down.** An image
// lives inside a detail pane that scrolls, inside a surface that is blitted
// into a frame at an offset, under a modal that may cover it. Every one of
// those transforms already exists and already works — on cells. Marking cells
// and reading them back off the finished frame means the image is clipped,
// offset and occluded by exactly the same code that clips, offsets and occludes
// the text around it, with no second implementation to keep in agreement.
//
// **Why a whole row of the image must be present to draw it.** Terminal
// graphics are drawn *over* text, not into it, so a picture that a modal is
// half covering would render on top of the modal. Requiring every cell of an
// image row to still carry its mark makes occlusion self-reporting: whatever
// painted over the image erased the marks, and the covered rows silently drop
// out of the placement. The rows that survive are contiguous, so what remains
// is a crop — which is also exactly what a partially scrolled image needs, and
// both cases fall out of the same scan.

import type { CellGrid, ImageMark } from "../types";
import {
  cropForVisibleRows,
  encodeDeleteImage,
  encodeDeletePlacement,
  encodePlace,
  encodeTransmit,
  type Crop,
} from "./kitty";
import type { PixelSize } from "./png";

function marksEqual(a: ImageMark, b: ImageMark): boolean {
  return a.id === b.id && a.tileRow === b.tileRow && a.rows === b.rows && a.cols === b.cols;
}

/** One visible, uninterrupted run of an image's rows. */
export interface VisibleRun {
  id: number;
  /** Screen cell of the run's top-left corner, 0-indexed. */
  row: number;
  col: number;
  cols: number;
  /** The image's full height in cells, needed to crop proportionally. */
  totalRows: number;
  /** First image row in this run, and how many of them are visible. */
  firstTileRow: number;
  visibleRows: number;
}

interface RowHit {
  mark: ImageMark;
  row: number;
  col: number;
}

/**
 * Every fully-present image row in a composited frame, as contiguous runs.
 *
 * Pure: the frame goes in, runs come out. A row whose cells are not all marked
 * with the same mark is skipped — that is the occlusion test — and a gap
 * between rows ends the run rather than merging across it, so an image split by
 * something drawn through its middle yields two runs and each is cropped to
 * what it actually covers.
 */
export function scanFrameForImages(grid: CellGrid): VisibleRun[] {
  const hits: RowHit[] = [];
  for (let y = 0; y < grid.rows; y++) {
    const row = grid.cells[y];
    for (let x = 0; x < grid.cols; x++) {
      const mark = row[x]?.image;
      if (!mark) continue;
      if (x + mark.cols > grid.cols) { continue; }
      let whole = true;
      for (let i = 1; i < mark.cols; i++) {
        const other = row[x + i]?.image;
        if (!other || !marksEqual(other, mark)) { whole = false; break; }
      }
      if (whole) {
        hits.push({ mark, row: y, col: x });
        x += mark.cols - 1;
      }
    }
  }

  // Group by the placement a row belongs to. Two copies of one image on screen
  // differ in where their box starts, so the origin — the screen row that would
  // hold tile row 0 — separates them without needing an occurrence counter.
  const groups = new Map<string, RowHit[]>();
  for (const hit of hits) {
    const key = `${hit.mark.id}:${hit.col}:${hit.row - hit.mark.tileRow}:${hit.mark.rows}:${hit.mark.cols}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(hit);
    else groups.set(key, [hit]);
  }

  const runs: VisibleRun[] = [];
  for (const bucket of groups.values()) {
    bucket.sort((a, b) => a.mark.tileRow - b.mark.tileRow);
    let start = 0;
    for (let i = 1; i <= bucket.length; i++) {
      const broken =
        i === bucket.length || bucket[i].mark.tileRow !== bucket[i - 1].mark.tileRow + 1;
      if (!broken) continue;
      const head = bucket[start];
      runs.push({
        id: head.mark.id,
        row: head.row,
        col: head.col,
        cols: head.mark.cols,
        totalRows: head.mark.rows,
        firstTileRow: head.mark.tileRow,
        visibleRows: i - start,
      });
      start = i;
    }
  }
  return runs;
}

/** Where an image's bytes and intrinsic size come from at transmit time. */
export type ImageResolver = (id: number) => { png: Uint8Array; px: PixelSize } | null;

interface ActivePlacement {
  placementId: number;
  row: number;
  col: number;
  cols: number;
  rows: number;
  crop: Crop | null;
}

function cropsEqual(a: Crop | null, b: Crop | null): boolean {
  if (a === null || b === null) return a === b;
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}

function runKey(run: VisibleRun): string {
  return `${run.id}:${run.col}:${run.row - run.firstTileRow}`;
}

export class ImagePlane {
  private transmitted = new Set<number>();
  private active = new Map<string, ActivePlacement>();
  private nextPlacementId = 1;

  /**
   * `drainFreed` reports ids the cache has evicted since the last frame. It is
   * a pull, not a push, because the terminal-side delete has to travel in the
   * same write as the rest of the frame — a cache that emitted its own escapes
   * would be a second writer to stdout.
   */
  constructor(
    private readonly resolve: ImageResolver,
    private readonly drainFreed: () => number[] = () => [],
  ) {}

  /**
   * Commands to bring the terminal in line with this frame.
   *
   * Returns a string for the renderer's buffer rather than writing: one writer
   * to stdout stays one writer, and the emitted bytes are the unit under test.
   */
  frame(grid: CellGrid): string {
    const out: string[] = [];

    for (const id of this.drainFreed()) {
      if (!this.transmitted.delete(id)) continue;
      out.push(encodeDeleteImage(id));
      for (const key of [...this.active.keys()]) {
        if (key.startsWith(`${id}:`)) this.active.delete(key);
      }
    }

    const desired = new Map<string, VisibleRun>();
    for (const run of scanFrameForImages(grid)) desired.set(runKey(run), run);

    for (const [key, p] of this.active) {
      if (desired.has(key)) continue;
      out.push(encodeDeletePlacement(Number(key.split(":")[0]), p.placementId));
      this.active.delete(key);
    }

    for (const [key, run] of desired) {
      const source = this.resolve(run.id);
      if (!source) continue;
      if (!this.transmitted.has(run.id)) {
        out.push(encodeTransmit(run.id, source.png));
        this.transmitted.add(run.id);
      }
      const crop = cropForVisibleRows(source.px, run.totalRows, run.firstTileRow, run.visibleRows);
      const existing = this.active.get(key);
      if (
        existing &&
        existing.row === run.row &&
        existing.col === run.col &&
        existing.cols === run.cols &&
        existing.rows === run.visibleRows &&
        cropsEqual(existing.crop, crop)
      ) {
        continue; // unchanged — the terminal is already showing this
      }
      const placementId = existing?.placementId ?? this.allocPlacementId();
      out.push(`\x1b[${run.row + 1};${run.col + 1}H`);
      out.push(
        encodePlace({
          id: run.id,
          placementId,
          cols: run.cols,
          rows: run.visibleRows,
          crop: crop ?? undefined,
        }),
      );
      this.active.set(key, {
        placementId,
        row: run.row,
        col: run.col,
        cols: run.cols,
        rows: run.visibleRows,
        crop,
      });
    }

    return out.join("");
  }

  /**
   * Drop every placement, keeping transmitted data.
   *
   * Used when the frame's coordinate system stops meaning what it did — a
   * resize, or a redraw forced from scratch. Placements are anchored to cells,
   * so stale ones would sit at the old geometry until something happened to
   * overwrite them, which for a picture is never.
   */
  reset(): string {
    const out: string[] = [];
    for (const [key, p] of this.active) {
      out.push(encodeDeletePlacement(Number(key.split(":")[0]), p.placementId));
    }
    this.active.clear();
    return out.join("");
  }

  /** Placements gone and every byte freed. For shutdown. */
  shutdown(): string {
    const out = [this.reset()];
    for (const id of this.transmitted) out.push(encodeDeleteImage(id));
    this.transmitted.clear();
    return out.join("");
  }

  private allocPlacementId(): number {
    // Placement ids share the image's namespace and must stay positive; the
    // wrap point is far past any plausible session.
    if (this.nextPlacementId >= 0x7ffffff0) this.nextPlacementId = 1;
    return this.nextPlacementId++;
  }
}
