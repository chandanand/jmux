import { describe, test, expect } from "bun:test";
import {
  buildIssueDetailLines,
  paintDetailLines,
  maxDetailScroll,
  DETAIL_LABEL,
  type DetailLine,
} from "../issue-detail";
import { createGrid } from "../cell-grid";
import { setImagePort, type ImagePort } from "../images/port";
import type { Issue } from "../adapters/types";

const ISSUE: Issue = {
  id: "i1", identifier: "ENG-1234", title: "Fix auth", status: "In Progress",
  assignee: "jarred", linkedMrUrls: [], webUrl: "",
  team: "Platform", priority: 1, updatedAt: 1000,
  description: "The token refresh races the retry.",
};

function textOf(line: DetailLine): string {
  if ("segments" in line) return line.segments.map((s) => s.text).join("");
  if ("imageRow" in line) return `[image#${line.imageRow.id}:${line.imageRow.tileRow}]`;
  return line.text;
}

function lineTexts(lines: readonly DetailLine[]): string[] {
  return lines.map(textOf);
}

function extractText(grid: { cells: Array<Array<{ char: string }>> }): string {
  return grid.cells.map((row) => row.map((c) => c.char).join("")).join("\n");
}

describe("buildIssueDetailLines", () => {
  test("emits header, metadata and description in order", () => {
    const texts = lineTexts(buildIssueDetailLines(ISSUE, 60));
    expect(texts[0]).toBe("ENG-1234 Fix auth");
    expect(texts[1]).toBe("Status: In Progress   Priority: P1");
    expect(texts[2]).toBe("Assignee: jarred");
    expect(texts[3]).toBe("Team: Platform");
    expect(texts).toContain("Description:");
  });

  test("omits the team line when the issue has no team", () => {
    const { team, ...noTeam } = ISSUE;
    const texts = lineTexts(buildIssueDetailLines(noTeam as Issue, 60));
    expect(texts.some((t) => t.startsWith("Team:"))).toBe(false);
  });

  test("afterMetadata lands after the metadata block and before the description", () => {
    const injected: DetailLine[] = [
      { text: "", attrs: DETAIL_LABEL },
      { text: "Starting will create", attrs: DETAIL_LABEL },
    ];
    const texts = lineTexts(buildIssueDetailLines(ISSUE, 60, { afterMetadata: injected }));

    const team = texts.indexOf("Team: Platform");
    const injectedAt = texts.indexOf("Starting will create");
    const description = texts.indexOf("Description:");

    expect(team).toBeGreaterThanOrEqual(0);
    expect(injectedAt).toBeGreaterThan(team);
    expect(description).toBeGreaterThan(injectedAt);
  });

  test("passing no options reproduces the un-spliced sequence exactly", () => {
    // The panel relies on this: the seam must be invisible when unused.
    const plain = lineTexts(buildIssueDetailLines(ISSUE, 60));
    const emptyOpts = lineTexts(buildIssueDetailLines(ISSUE, 60, {}));
    const emptyList = lineTexts(buildIssueDetailLines(ISSUE, 60, { afterMetadata: [] }));
    expect(emptyOpts).toEqual(plain);
    expect(emptyList).toEqual(plain);
  });

  test("renders links with their urls indented", () => {
    const withLinks: Issue = {
      ...ISSUE,
      links: [{ type: "mr", title: "MR !42", url: "https://example.test/42" }],
    };
    const texts = lineTexts(buildIssueDetailLines(withLinks, 60));
    expect(texts).toContain("Links:");
    expect(texts).toContain("MR !42");
    expect(texts).toContain("https://example.test/42");
  });

  test("renders a comment count and each comment author", () => {
    const withComments: Issue = {
      ...ISSUE,
      comments: [{ author: "alice", body: "Repro'd on staging.", createdAt: "" }],
    };
    const texts = lineTexts(buildIssueDetailLines(withComments, 60));
    expect(texts).toContain("Comments (1):");
    expect(texts.some((t) => t.startsWith("alice"))).toBe(true);
  });
});

describe("maxDetailScroll", () => {
  test("is zero when everything fits", () => {
    expect(maxDetailScroll(5, 10)).toBe(0);
    expect(maxDetailScroll(10, 10)).toBe(0);
  });

  test("leaves the last line reachable at the top row", () => {
    expect(maxDetailScroll(30, 10)).toBe(20);
  });

  test("treats a zero-row viewport as one row rather than going negative", () => {
    expect(maxDetailScroll(5, 0)).toBe(4);
  });
});

describe("paintDetailLines", () => {
  const lines: DetailLine[] = Array.from({ length: 30 }, (_, i) => ({
    text: `line-${i}`,
    attrs: DETAIL_LABEL,
  }));

  test("paints from the scroll offset", () => {
    const grid = createGrid(40, 5);
    paintDetailLines(grid, 0, 0, 40, 5, lines, 3);
    const text = extractText(grid);
    expect(text).toContain("line-3");
    expect(text).not.toContain("line-2");
  });

  test("shows both scroll indicators mid-scroll and neither when it all fits", () => {
    const scrolled = createGrid(40, 5);
    paintDetailLines(scrolled, 0, 0, 40, 5, lines, 3);
    expect(extractText(scrolled)).toContain("↑");
    expect(extractText(scrolled)).toContain("↓");

    const short = createGrid(40, 5);
    paintDetailLines(short, 0, 0, 40, 5, lines.slice(0, 3), 0);
    expect(extractText(short)).not.toContain("↑");
    expect(extractText(short)).not.toContain("↓");
  });

  test("honours startCol so a region can be offset from the grid edge", () => {
    const grid = createGrid(40, 3);
    paintDetailLines(grid, 0, 10, 30, 3, lines, 0);
    // pad is 2 inside the region, so the first glyph lands at column 12.
    expect(grid.cells[0]!.slice(0, 12).every((c) => c.char === " ")).toBe(true);
    expect(grid.cells[0]![12]!.char).toBe("l");
  });

  test("paints no line content when the region is too narrow to hold any", () => {
    // The scroll indicator still lands (it is one glyph at a fixed offset);
    // what must not happen is text painted through a negative width.
    const grid = createGrid(4, 2);
    paintDetailLines(grid, 0, 0, 4, 2, lines, 0);
    expect(extractText(grid)).not.toContain("line-");
  });
});

// --- Inline images ----------------------------------------------------------
//
// The port is what the whole feature hangs off: with none installed, images
// linkify exactly as they always did, so these tests assert both halves.

describe("inline images", () => {
  const WITH_IMAGE: Issue = {
    ...ISSUE,
    description: "Before\n\n![a shot](https://x/y.png)\n\nAfter",
  };

  function withPort<T>(port: ImagePort | null, fn: () => T): T {
    setImagePort(port);
    try {
      return fn();
    } finally {
      setImagePort(null);
    }
  }

  const readyPort = (rows: number, cols: number): ImagePort => ({
    resolve: () => ({ kind: "ready", id: 42, cols, rows }),
  });

  test("with no port the image is a link, as it was before images existed", () => {
    const texts = lineTexts(buildIssueDetailLines(WITH_IMAGE, 60)).join("\n");
    expect(texts).toContain("a shot");
    expect(texts).not.toContain("[image#");
  });

  test("a ready image reserves one detail line per row of its box", () => {
    const lines = withPort(readyPort(5, 20), () => buildIssueDetailLines(WITH_IMAGE, 60));
    const rows = lines.filter((l) => "imageRow" in l);
    expect(rows.length).toBe(5);
    expect(rows.map((l) => (l as { imageRow: { tileRow: number } }).imageRow.tileRow)).toEqual([0, 1, 2, 3, 4]);
    for (const l of rows) {
      expect((l as { imageRow: { rows: number; cols: number; id: number } }).imageRow).toMatchObject({
        id: 42, rows: 5, cols: 20,
      });
    }
  });

  test("prose on both sides of the image survives the split", () => {
    const texts = withPort(readyPort(2, 10), () => lineTexts(buildIssueDetailLines(WITH_IMAGE, 60))).join("\n");
    expect(texts).toContain("Before");
    expect(texts).toContain("After");
  });

  test("a loading image reserves a single line and says so", () => {
    const port: ImagePort = { resolve: () => ({ kind: "loading" }) };
    const texts = withPort(port, () => lineTexts(buildIssueDetailLines(WITH_IMAGE, 60)));
    expect(texts.some((t) => t.includes("a shot") && t.includes("⟳"))).toBe(true);
    expect(texts.some((t) => t.startsWith("[image#"))).toBe(false);
  });

  test("a failed image falls back to the link and names the reason", () => {
    const port: ImagePort = { resolve: () => ({ kind: "failed", reason: "HTTP 403" }) };
    const texts = withPort(port, () => lineTexts(buildIssueDetailLines(WITH_IMAGE, 60))).join("\n");
    expect(texts).toContain("a shot");
    expect(texts).toContain("HTTP 403");
    expect(texts).not.toContain("[image#");
  });

  test("images in comments are drawn too", () => {
    const issue: Issue = {
      ...ISSUE,
      description: undefined,
      comments: [{ author: "sam", body: "![](https://x/y.png)", createdAt: "2026-01-01" }],
    };
    const lines = withPort(readyPort(3, 12), () => buildIssueDetailLines(issue, 60));
    expect(lines.filter((l) => "imageRow" in l).length).toBe(3);
  });

  test("painting an image line marks every cell of its row", () => {
    const lines = withPort(readyPort(2, 6), () => buildIssueDetailLines(WITH_IMAGE, 60));
    const grid = createGrid(60, lines.length);
    paintDetailLines(grid, 0, 0, 60, lines.length, lines, 0);
    const row = grid.cells.find((r) => r.some((c) => c.image));
    expect(row).toBeDefined();
    const marked = row!.filter((c) => c.image);
    expect(marked.length).toBe(6);
    expect(marked.every((c) => c.char === " ")).toBe(true);
  });

  test("an image wider than the region is left unmarked rather than clipped", () => {
    const lines = withPort(readyPort(2, 50), () => buildIssueDetailLines(WITH_IMAGE, 60));
    const grid = createGrid(20, lines.length);
    paintDetailLines(grid, 0, 0, 20, lines.length, lines, 0);
    expect(grid.cells.some((r) => r.some((c) => c.image))).toBe(false);
  });

  test("scrolling past an image drops its earlier rows from the frame", () => {
    const lines = withPort(readyPort(6, 8), () => buildIssueDetailLines(WITH_IMAGE, 60));
    const firstImageAt = lines.findIndex((l) => "imageRow" in l);
    const grid = createGrid(60, 4);
    paintDetailLines(grid, 0, 0, 60, 4, lines, firstImageAt + 2);
    const tiles = grid.cells
      .flatMap((r) => r.filter((c) => c.image))
      .map((c) => c.image!.tileRow);
    expect(Math.min(...tiles)).toBe(2);
  });
});

describe("clicking a drawn image", () => {
  const WITH_IMAGE: Issue = {
    ...ISSUE,
    description: "Before\n\n![a shot](https://x/y.png)\n\nAfter",
  };

  function build(): DetailLine[] {
    setImagePort({ resolve: () => ({ kind: "ready", id: 42, cols: 8, rows: 3 }) });
    try {
      return buildIssueDetailLines(WITH_IMAGE, 60);
    } finally {
      setImagePort(null);
    }
  }

  test("every cell under the picture carries the image URL", () => {
    // Drawing the image must not take away what the link could already do:
    // jmux's click path reads URLs off the composited grid, so the cells the
    // picture covers are what make it clickable.
    const lines = build();
    const grid = createGrid(60, lines.length);
    paintDetailLines(grid, 0, 0, 60, lines.length, lines, 0);
    const marked = grid.cells.flatMap((r) => r.filter((c) => c.image));
    expect(marked.length).toBe(8 * 3);
    expect(marked.every((c) => c.link === "https://x/y.png")).toBe(true);
  });

  test("cells beside the picture carry no link", () => {
    const lines = build();
    const grid = createGrid(60, lines.length);
    paintDetailLines(grid, 0, 0, 60, lines.length, lines, 0);
    const row = grid.cells.find((r) => r.some((c) => c.image))!;
    expect(row[0].link).toBeUndefined();
    expect(row[59].link).toBeUndefined();
  });

  test("a partly scrolled image is still clickable on the rows that show", () => {
    const lines = build();
    const firstImageAt = lines.findIndex((l) => "imageRow" in l);
    const grid = createGrid(60, 2);
    paintDetailLines(grid, 0, 0, 60, 2, lines, firstImageAt + 1);
    const marked = grid.cells.flatMap((r) => r.filter((c) => c.image));
    expect(marked.length).toBeGreaterThan(0);
    expect(marked.every((c) => c.link === "https://x/y.png")).toBe(true);
  });
});
