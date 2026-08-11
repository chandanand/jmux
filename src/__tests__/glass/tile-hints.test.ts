import { describe, test, expect } from "bun:test";
import { buildTileHints, type TileHintsInput } from "../../glass/tile-hints";
import { cellWidth, textCols } from "../../cell-grid";

const wide: TileHintsInput = { eligibleIndex: 2, eligibleCount: 3 };
const single: TileHintsInput = { eligibleIndex: 1, eligibleCount: 1 };

describe("buildTileHints", () => {
  test("shows every hint, in order, when there is room", () => {
    expect(buildTileHints(wide, 200)).toBe(
      "⇧↔ focus · ⌃a↵ open · ⌃a x agent 2/3 · ⌃a P hide",
    );
  });

  test("⌃a x is omitted below two eligible panes — nothing to cycle to", () => {
    const text = buildTileHints(single, 200);
    expect(text).not.toContain("agent");
    expect(text).toBe("⇧↔ focus · ⌃a↵ open · ⌃a P hide");
  });

  test("eligibleCount 0 also omits the face cycle", () => {
    const text = buildTileHints({ eligibleIndex: 1, eligibleCount: 0 }, 200);
    expect(text).not.toContain("agent");
  });

  test("drops from the tail as the tile narrows — the last hint goes first", () => {
    const full = buildTileHints(wide, 200);
    const noHide = buildTileHints(wide, textCols(full) - 1);
    expect(noHide).toBe("⇧↔ focus · ⌃a↵ open · ⌃a x agent 2/3");

    const noAgent = buildTileHints(wide, textCols(noHide) - 1);
    expect(noAgent).toBe("⇧↔ focus · ⌃a↵ open");

    const focusOnly = buildTileHints(wide, textCols(noAgent) - 1);
    expect(focusOnly).toBe("⇧↔ focus");

    const nothing = buildTileHints(wide, textCols(focusOnly) - 1);
    expect(nothing).toBe("");
  });

  test("never returns a truncated hint — every result is one of the exact fixed strings", () => {
    const possible = new Set([
      "⇧↔ focus · ⌃a↵ open · ⌃a x agent 2/3 · ⌃a P hide",
      "⇧↔ focus · ⌃a↵ open · ⌃a x agent 2/3",
      "⇧↔ focus · ⌃a↵ open",
      "⇧↔ focus",
      "",
    ]);
    for (let width = -5; width <= 60; width++) {
      expect(possible.has(buildTileHints(wide, width))).toBe(true);
    }
  });

  test("width <= 0 yields nothing", () => {
    expect(buildTileHints(wide, 0)).toBe("");
    expect(buildTileHints(wide, -1)).toBe("");
  });

  test("every glyph used is width-1 — a width-2 glyph would desync every cell after it", () => {
    const text = buildTileHints(wide, 200);
    for (const ch of text) {
      expect(cellWidth(ch.codePointAt(0) ?? 0)).toBe(1);
    }
    // textCols must equal the code-point count exactly, for the same reason.
    expect(textCols(text)).toBe([...text].length);
  });
});
