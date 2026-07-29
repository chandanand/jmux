import { describe, expect, test } from "bun:test";
import { createGrid, writeImageRow, writeString } from "../cell-grid";
import { ImagePlane, scanFrameForImages } from "../images/plane";
import type { CellGrid, ImageMark } from "../types";

/** Reserve an id's full cell box at (row, col), the way the painter does. */
function place(grid: CellGrid, id: number, row: number, col: number, cols: number, rows: number, from = 0): void {
  for (let r = 0; r < rows; r++) {
    const mark: ImageMark = { id, tileRow: from + r, rows: from + rows, cols };
    writeImageRow(grid, row + r, col, mark);
  }
}

/** A box whose marks describe a taller image than the rows actually drawn. */
function placeSlice(
  grid: CellGrid,
  id: number,
  row: number,
  col: number,
  cols: number,
  totalRows: number,
  firstTile: number,
  count: number,
): void {
  for (let r = 0; r < count; r++) {
    writeImageRow(grid, row + r, col, { id, tileRow: firstTile + r, rows: totalRows, cols });
  }
}

const RESOLVE = (id: number) => ({ png: new Uint8Array([id]), px: { w: 100, h: 200 } });

describe("scanFrameForImages", () => {
  test("finds a whole image as one run", () => {
    const grid = createGrid(40, 10);
    place(grid, 5, 2, 3, 10, 4);
    expect(scanFrameForImages(grid)).toEqual([
      { id: 5, row: 2, col: 3, cols: 10, totalRows: 4, firstTileRow: 0, visibleRows: 4 },
    ]);
  });

  test("finds nothing in a frame with no marks", () => {
    expect(scanFrameForImages(createGrid(40, 10))).toEqual([]);
  });

  test("a row with text written through it is dropped", () => {
    const grid = createGrid(40, 10);
    place(grid, 5, 0, 0, 10, 4);
    writeString(grid, 2, 4, "x");
    const runs = scanFrameForImages(grid);
    // The occluded row splits the image into the runs above and below it.
    expect(runs.map((r) => [r.firstTileRow, r.visibleRows])).toEqual([
      [0, 2],
      [3, 1],
    ]);
  });

  test("an image covered end to end disappears entirely", () => {
    const grid = createGrid(40, 10);
    place(grid, 5, 0, 0, 10, 3);
    for (let r = 0; r < 3; r++) writeString(grid, r, 0, "██████████");
    expect(scanFrameForImages(grid)).toEqual([]);
  });

  test("a partially scrolled image reports which of its rows are visible", () => {
    const grid = createGrid(40, 10);
    placeSlice(grid, 5, 0, 0, 10, 8, 3, 5);
    expect(scanFrameForImages(grid)).toEqual([
      { id: 5, row: 0, col: 0, cols: 10, totalRows: 8, firstTileRow: 3, visibleRows: 5 },
    ]);
  });

  test("two copies of one image are two runs, not one merged box", () => {
    const grid = createGrid(40, 12);
    place(grid, 5, 0, 0, 8, 3);
    place(grid, 5, 6, 0, 8, 3);
    const runs = scanFrameForImages(grid);
    expect(runs.length).toBe(2);
    expect(runs.map((r) => r.row).sort()).toEqual([0, 6]);
  });

  test("two images side by side on the same rows are both found", () => {
    const grid = createGrid(40, 6);
    place(grid, 1, 0, 0, 8, 3);
    place(grid, 2, 0, 10, 8, 3);
    const runs = scanFrameForImages(grid);
    expect(runs.map((r) => r.id).sort()).toEqual([1, 2]);
  });

  test("a box that runs off the right edge is not drawn", () => {
    const grid = createGrid(10, 4);
    // A mark claiming 20 columns in a 10-column grid can only be half-written.
    writeImageRow(grid, 0, 0, { id: 5, tileRow: 0, rows: 1, cols: 20 });
    expect(scanFrameForImages(grid)).toEqual([]);
  });
});

describe("ImagePlane", () => {
  test("transmits once, then places", () => {
    const plane = new ImagePlane(RESOLVE);
    const grid = createGrid(40, 10);
    place(grid, 5, 2, 3, 10, 4);
    const out = plane.frame(grid);
    expect(out).toContain("a=t,f=100");
    // Cursor moved to the anchor (1-indexed) before the placement.
    expect(out).toContain("\x1b[3;4H");
    expect(out).toContain("a=p,i=5");
    expect(out).toContain("c=10,r=4");
  });

  test("an unchanged frame emits nothing", () => {
    const plane = new ImagePlane(RESOLVE);
    const grid = createGrid(40, 10);
    place(grid, 5, 2, 3, 10, 4);
    plane.frame(grid);
    expect(plane.frame(grid)).toBe("");
  });

  test("re-placing does not re-transmit", () => {
    const plane = new ImagePlane(RESOLVE);
    const a = createGrid(40, 10);
    place(a, 5, 2, 0, 10, 4);
    plane.frame(a);
    const b = createGrid(40, 10);
    place(b, 5, 3, 0, 10, 4);
    const out = plane.frame(b);
    expect(out).not.toContain("a=t,f=100");
    expect(out).toContain("a=p,i=5");
  });

  test("an image that leaves the frame is deleted", () => {
    const plane = new ImagePlane(RESOLVE);
    const grid = createGrid(40, 10);
    place(grid, 5, 2, 3, 10, 4);
    plane.frame(grid);
    const out = plane.frame(createGrid(40, 10));
    expect(out).toContain("a=d,d=i,i=5");
    expect(out).not.toContain("a=p");
  });

  test("a scrolled image is re-placed with a crop", () => {
    const plane = new ImagePlane(RESOLVE);
    const full = createGrid(40, 10);
    placeSlice(full, 5, 0, 0, 10, 8, 0, 8);
    plane.frame(full);
    const scrolled = createGrid(40, 10);
    placeSlice(scrolled, 5, 0, 0, 10, 8, 2, 6);
    const out = plane.frame(scrolled);
    expect(out).toContain("r=6");
    expect(out).toContain("y=50"); // 2/8 of a 200px-tall image
    expect(out).toContain("h=150");
  });

  test("an image the store can't resolve is skipped, not half-drawn", () => {
    const plane = new ImagePlane(() => null);
    const grid = createGrid(40, 10);
    place(grid, 5, 0, 0, 10, 4);
    expect(plane.frame(grid)).toBe("");
  });

  test("reset drops placements without freeing the transmitted data", () => {
    const plane = new ImagePlane(RESOLVE);
    const grid = createGrid(40, 10);
    place(grid, 5, 2, 3, 10, 4);
    plane.frame(grid);
    const out = plane.reset();
    expect(out).toContain("a=d,d=i,i=5");
    expect(out).not.toContain("d=I");
    // The same frame now re-places — and still doesn't re-transmit.
    const again = plane.frame(grid);
    expect(again).toContain("a=p,i=5");
    expect(again).not.toContain("a=t,f=100");
  });

  test("shutdown frees the data as well as the placements", () => {
    const plane = new ImagePlane(RESOLVE);
    const grid = createGrid(40, 10);
    place(grid, 5, 2, 3, 10, 4);
    plane.frame(grid);
    const out = plane.shutdown();
    expect(out).toContain("a=d,d=i,i=5");
    expect(out).toContain("a=d,d=I,i=5");
  });

  test("an evicted image is freed terminal-side and re-transmitted if it returns", () => {
    let freed: number[] = [];
    const plane = new ImagePlane(RESOLVE, () => {
      const out = freed;
      freed = [];
      return out;
    });
    const grid = createGrid(40, 10);
    place(grid, 5, 0, 0, 10, 4);
    plane.frame(grid);

    freed = [5];
    const out = plane.frame(grid);
    expect(out).toContain("a=d,d=I,i=5");
    expect(out).toContain("a=t,f=100"); // re-sent in the same frame
  });

  test("two copies of one image get distinct placement ids", () => {
    const plane = new ImagePlane(RESOLVE);
    const grid = createGrid(40, 12);
    place(grid, 5, 0, 0, 8, 3);
    place(grid, 5, 6, 0, 8, 3);
    const out = plane.frame(grid);
    const ids = [...out.matchAll(/a=p,i=5,p=(\d+)/g)].map((m) => m[1]);
    expect(ids.length).toBe(2);
    expect(new Set(ids).size).toBe(2);
  });
});
