// The codec behind the website's scroll demo (scripts/capture-frames.ts).
//
// The capture itself needs tmux and half a minute, so it can only ever be a
// smoke test — and the parts most able to break quietly are pure: run
// splitting, the delta between two frames, and the key labels the page prints
// beside the window. Those are covered here, at the level the rest of this
// suite works at.
//
// This also covers the one path a real capture cannot reach today: no frame of
// `jmux --demo` contains a URL, so nothing in a captured film exercises OSC 8
// links. Without a test the link support would be code that has never once run.

import { describe, expect, test } from "bun:test";
import { createGrid } from "../cell-grid";
import { ColorMode, type CellGrid } from "../types";
import { describeKeys, encodeFilm, encodeRows, thin } from "../../scripts/capture-frames";

/** A grid with `text` written across row 0, optionally carrying a link. */
function gridWith(text: string, opts: { link?: string; linkFrom?: number; linkTo?: number } = {}): CellGrid {
  const grid = createGrid(text.length + 4, 2);
  for (let x = 0; x < text.length; x++) {
    const cell = grid.cells[0]![x]!;
    cell.char = text[x]!;
    if (opts.link !== undefined && x >= (opts.linkFrom ?? 0) && x < (opts.linkTo ?? text.length)) {
      cell.link = opts.link;
    }
  }
  return grid;
}

const CURSOR = { x: 0, y: 0 };

describe("run encoding", () => {
  test("collapses same-styled cells into one run", () => {
    const rows = encodeRows(gridWith("hello"));
    expect(rows[0]).toEqual([["hello", 0, 0, 0, 0]]);
  });

  test("drops trailing default-styled whitespace", () => {
    const grid = gridWith("hi");
    // The grid is four columns wider than the text; none of that should ship.
    expect(encodeRows(grid)[0]).toHaveLength(1);
    expect(encodeRows(grid)[1]).toEqual([]);
  });

  test("splits a run where a style changes", () => {
    const grid = gridWith("ab");
    grid.cells[0]![1]!.bold = true;
    const runs = encodeRows(grid)[0]!;
    expect(runs.map((r) => r[0])).toEqual(["a", "b"]);
    expect(runs[1]![4]).toBe(1); // bold flag
  });

  test("carries an OSC 8 target as the run's sixth element", () => {
    const runs = encodeRows(gridWith("docs", { link: "https://jmux.build" }))[0]!;
    expect(runs).toHaveLength(1);
    expect(runs[0]![5]).toBe("https://jmux.build");
  });

  test("splits a run at a link boundary even when the style is identical", () => {
    // A run becomes one <span>, and a linked one an <a>. Without link in the
    // sameness test the whole row merges and the anchor swallows text that was
    // never part of the link.
    const runs = encodeRows(gridWith("goHERE", { link: "https://x.test", linkFrom: 2 }))[0]!;
    expect(runs.map((r) => r[0])).toEqual(["go", "HERE"]);
    expect(runs[0]![5]).toBeUndefined();
    expect(runs[1]![5]).toBe("https://x.test");
  });

  test("leaves no width-0 continuation cell behind a wide character", () => {
    const grid = createGrid(4, 1);
    grid.cells[0]![0]! = { ...grid.cells[0]![0]!, char: "字", width: 2 };
    grid.cells[0]![1]! = { ...grid.cells[0]![1]!, char: "", width: 0 };
    grid.cells[0]![2]! = { ...grid.cells[0]![2]!, char: "x", width: 1 };
    expect(encodeRows(grid)[0]!.map((r) => r[0]).join("")).toBe("字x");
  });
});

describe("film deltas", () => {
  const beat = { id: "b", label: "Beat", keys: [], expect: [] };

  test("the first step carries every row, later steps only what changed", () => {
    const a = gridWith("one");
    const b = gridWith("two");
    const film = encodeFilm(
      [
        { grid: a, cursor: CURSOR },
        { grid: b, cursor: CURSOR },
      ],
      beat,
    );

    expect(film.steps[0]!.rows.every((r) => r !== null)).toBe(true);
    // Row 0 changed; row 1 was blank in both and must not be re-sent.
    expect(film.steps[1]!.rows[0]).not.toBeNull();
    expect(film.steps[1]!.rows[1]).toBeNull();
  });

  test("an unchanged frame sends no rows at all", () => {
    const film = encodeFilm(
      [
        { grid: gridWith("same"), cursor: CURSOR },
        { grid: gridWith("same"), cursor: { x: 4, y: 0 } },
      ],
      beat,
    );
    expect(film.steps[1]!.rows.every((r) => r === null)).toBe(true);
    // ...but the cursor still moved, which is the whole reason it is a step.
    expect(film.steps[1]!.cur).toEqual([4, 0]);
  });

  test("records the cursor for every step", () => {
    const film = encodeFilm([{ grid: gridWith("x"), cursor: { x: 7, y: 1 } }], beat);
    expect(film.steps[0]!.cur).toEqual([7, 1]);
  });
});

describe("thinning", () => {
  const shot = (text: string, x = 0) => ({ grid: gridWith(text), cursor: { x, y: 0 } });

  test("drops frames that show nothing new", () => {
    expect(thin([shot("a"), shot("a"), shot("a"), shot("b")])).toHaveLength(2);
  });

  test("keeps a frame whose only change is the cursor", () => {
    expect(thin([shot("a", 0), shot("a", 3)])).toHaveLength(2);
  });

  test("caps a long film and always keeps the last frame", () => {
    const shots = Array.from({ length: 200 }, (_, i) => shot(`f${i}`));
    const kept = thin(shots);
    expect(kept.length).toBeLessThanOrEqual(26);
    // The last frame is the one every assertion ran against and the one the
    // viewer rests on, so it can never be the one downsampling discards.
    expect(kept[kept.length - 1]).toBe(shots[199]!);
  });

  test("never returns nothing, even when the beat changed no pixels", () => {
    expect(thin([shot("a"), shot("a")]).length).toBeGreaterThan(0);
  });
});

describe("key labels", () => {
  test("splits a chord into separate caps", () => {
    expect(describeKeys({ id: "x", label: "", keys: ["\x01", "G"], expect: [] })).toEqual([
      "Ctrl-a",
      "G",
    ]);
  });

  test("keeps typed text as one cap rather than one per letter", () => {
    expect(
      describeKeys({ id: "x", label: "", keys: ["\x01", "p", "auth", "\r"], expect: [] }),
    ).toEqual(["Ctrl-a", "p", "auth", "Enter"]);
  });

  test("names an advance key once, not once per press", () => {
    expect(
      describeKeys({
        id: "x",
        label: "",
        keys: [],
        expect: [],
        advance: { key: "\x1b[1;6B", until: "z", max: 9 },
      }),
    ).toEqual(["Ctrl-Shift-↓"]);
  });
});
