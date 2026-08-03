// Virtual image placements written by a program *inside* a pane.
//
// These tests pin the one assumption the whole passthrough feature rests on:
// that a U+10EEEE placeholder grid survives the trip through xterm.js and the
// compositor byte-for-byte. The image data is relayed out of band
// (src/images/passthrough.ts), so if these cells are widened, re-coloured or
// stripped of their diacritics on the way through, the picture lands in the
// wrong place or does not resolve at all — and nothing else in the pipeline
// would report a problem.
import { describe, test, expect } from "bun:test";
import { ScreenBridge } from "../screen-bridge";
import { createGrid, cellWidth, isImagePlaceholder, IMAGE_PLACEHOLDER_CP } from "../cell-grid";
import { ColorMode } from "../types";

const PLACEHOLDER = String.fromCodePoint(IMAGE_PLACEHOLDER_CP);
/** First four entries of the kitty row/column diacritic table. */
const DIACRITICS = ["̅", "̍", "̎", "̐"];

/** The bytes terminal-browser writes to position a `cols`×`rows` placement. */
function placeholderGrid(imageId: number, cols: number, rows: number): string {
  const r = (imageId >> 16) & 0xff;
  const g = (imageId >> 8) & 0xff;
  const b = imageId & 0xff;
  let out = `\x1b[38;2;${r};${g};${b}m`;
  for (let row = 0; row < rows; row++) {
    out += `\x1b[${row + 1};1H`;
    for (let col = 0; col < cols; col++) {
      out += PLACEHOLDER + DIACRITICS[row] + DIACRITICS[col];
    }
  }
  return out + "\x1b[39m";
}

describe("placeholder cells", () => {
  test("measure one column, not two", () => {
    // U+10EEEE sits above 0x1F000, where the emoji catch-all would claim it as
    // wide. One column too many per cell shears the image it positions.
    expect(cellWidth(IMAGE_PLACEHOLDER_CP)).toBe(1);
  });

  test("are recognised by isImagePlaceholder, and ordinary text is not", () => {
    const grid = createGrid(2, 1);
    grid.cells[0][0].char = PLACEHOLDER + DIACRITICS[0] + DIACRITICS[1];
    grid.cells[0][1].char = "x";
    expect(isImagePlaceholder(grid.cells[0][0])).toBe(true);
    expect(isImagePlaceholder(grid.cells[0][1])).toBe(false);
  });

  describe("round-tripping through xterm.js", () => {
    test("keeps the base character one cell wide", async () => {
      const bridge = new ScreenBridge(10, 3);
      await bridge.write(placeholderGrid(0x4207, 4, 2));
      const grid = bridge.getGrid();

      for (let x = 0; x < 4; x++) {
        expect(grid.cells[0][x].width).toBe(1);
        expect(grid.cells[0][x].char.codePointAt(0)).toBe(IMAGE_PLACEHOLDER_CP);
      }
      // Cell 4 is past the placement — it must be untouched, which it would not
      // be if the four before it had each consumed two columns.
      expect(grid.cells[0][4].char).toBe(" ");
    });

    test("keeps the row and column diacritics attached", async () => {
      const bridge = new ScreenBridge(10, 3);
      await bridge.write(placeholderGrid(0x4207, 3, 2));
      const grid = bridge.getGrid();

      // Row 1, column 2 must carry the second row diacritic and the third
      // column one — that pair is the only thing telling the terminal which
      // part of the image this cell shows.
      expect(grid.cells[1][2].char).toBe(PLACEHOLDER + DIACRITICS[1] + DIACRITICS[2]);
    });

    test("preserves the image id carried in the truecolor foreground", async () => {
      const id = 0x4207;
      const bridge = new ScreenBridge(10, 3);
      await bridge.write(placeholderGrid(id, 2, 1));
      const grid = bridge.getGrid();

      const cell = grid.cells[0][0];
      expect(cell.fgMode).toBe(ColorMode.RGB);
      expect(cell.fg & 0xffffff).toBe(id);
    });
  });
});
