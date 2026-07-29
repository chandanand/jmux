import { describe, test, expect } from "bun:test";
import {
  buildIssueDetailLines,
  paintDetailLines,
  maxDetailScroll,
  DETAIL_LABEL,
  type DetailLine,
} from "../issue-detail";
import { createGrid } from "../cell-grid";
import type { Issue } from "../adapters/types";

const ISSUE: Issue = {
  id: "i1", identifier: "ENG-1234", title: "Fix auth", status: "In Progress",
  assignee: "jarred", linkedMrUrls: [], webUrl: "",
  team: "Platform", priority: 1, updatedAt: 1000,
  description: "The token refresh races the retry.",
};

function textOf(line: DetailLine): string {
  return "segments" in line ? line.segments.map((s) => s.text).join("") : line.text;
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
