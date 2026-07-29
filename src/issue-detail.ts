// src/issue-detail.ts
//
// The detail-line vocabulary: a styled-line model, the attributes those lines
// use, a painter, and the builder that turns an Issue into them.
//
// This lives apart from panel-view-renderer.ts because two surfaces now render
// an issue's detail — the info panel's detail pane, and the ghost preview's
// main-area body. They must not drift, so there is exactly one builder and one
// painter, and the panel's layout logic (which is genuinely panel-specific)
// stays where it was.
//
// The attributes moved here with the builder rather than being left behind and
// imported: `DETAIL_VALUE` and `URL_ATTRS` are *mutated* on theme change, so a
// second copy in another module would silently keep startup colours after the
// terminal background is detected. `rebuildIssueDetailColors()` is the one
// place that re-derives them, and panel-view-renderer's own rebuild calls it.

import type { CellGrid } from "./types";
import { ColorMode } from "./types";
import { writeString, textCols, type CellAttrs, type StyledLine } from "./cell-grid";
import type { Issue } from "./adapters/types";
import { renderMarkdownToStyledLines } from "./markdown";
import { neutralFg } from "./theme";
import { tokens } from "./chrome-tokens";

/**
 * One rendered line. Untagged on purpose — a line is either a single run of
 * uniform text or a pre-styled segment list from the markdown renderer, and
 * every consumer discriminates on `"segments" in line`.
 */
export type DetailLine =
  | { text: string; attrs: CellAttrs; indent?: number }
  | { segments: StyledLine; indent?: number };

export const DETAIL_LABEL: CellAttrs = { fg: 8, fgMode: ColorMode.Palette, dim: true };
export const DETAIL_VALUE: CellAttrs = { fg: 7, fgMode: ColorMode.Palette };
export const DETAIL_DIM: CellAttrs = { fg: 8, fgMode: ColorMode.Palette, dim: true };
export const DETAIL_HINT: CellAttrs = { fg: 8, fgMode: ColorMode.Palette, dim: true };
export const DETAIL_URL: CellAttrs = { fg: tokens.link.fg, fgMode: tokens.link.fgMode, underline: true };

/**
 * Re-derive the theme-dependent attributes. Called by
 * `rebuildPanelViewColors()` so there is still one entry point for the whole
 * panel/detail colour rebuild, rather than a second thing main.ts must
 * remember to call.
 */
export function rebuildIssueDetailColors(): void {
  DETAIL_URL.fg = tokens.link.fg;
  DETAIL_URL.fgMode = tokens.link.fgMode;
  const n = neutralFg(7);
  DETAIL_VALUE.fg = n.fg;
  DETAIL_VALUE.fgMode = n.fgMode;
}
rebuildIssueDetailColors();

export interface IssueDetailOptions {
  /**
   * Lines injected immediately after the metadata block (status / assignee /
   * team) and before links, description and comments.
   *
   * This exists because `DetailLine` carries no section markers, so a caller
   * wanting to splice content into a specific place would otherwise have to
   * pattern-match on rendered strings like `"Description:"`. The ghost preview
   * uses it for its pre-flight block; the info panel passes nothing and gets
   * byte-identical output to before this seam existed.
   */
  afterMetadata?: readonly DetailLine[];
}

const PAD = 2;

/** An issue rendered as detail lines. */
export function buildIssueDetailLines(
  issue: Issue,
  cols: number,
  opts?: IssueDetailOptions,
): DetailLine[] {
  const contentWidth = cols - PAD * 2;
  const lines: DetailLine[] = [];

  // Header
  lines.push({
    text: `${issue.identifier} ${issue.title}`.slice(0, contentWidth),
    attrs: { ...DETAIL_VALUE, bold: true },
  });

  // Metadata
  let statusLine = `Status: ${issue.status}`;
  if (issue.priority != null && issue.priority > 0) statusLine += `   Priority: P${issue.priority}`;
  lines.push({ text: statusLine, attrs: DETAIL_LABEL });
  lines.push({ text: `Assignee: ${issue.assignee ?? "Unassigned"}`, attrs: DETAIL_LABEL });
  if (issue.team) lines.push({ text: `Team: ${issue.team}`, attrs: DETAIL_LABEL });

  // Caller-supplied section. High on the page deliberately: for the preview
  // this is "what pressing Start will do", which outranks the prose.
  if (opts?.afterMetadata && opts.afterMetadata.length > 0) {
    lines.push(...opts.afterMetadata);
  }

  // Links
  if (issue.links && issue.links.length > 0) {
    lines.push({ text: "", attrs: DETAIL_DIM });
    lines.push({ text: "Links:", attrs: { ...DETAIL_LABEL, bold: true } });
    for (const link of issue.links) {
      const label = link.title ?? link.url;
      lines.push({ text: `${label}`.slice(0, contentWidth - 1), attrs: DETAIL_URL, indent: 1 });
      if (link.title) {
        lines.push({ text: link.url.slice(0, contentWidth - 1), attrs: DETAIL_DIM, indent: 1 });
      }
    }
  }

  // Description
  if (issue.description) {
    lines.push({ text: "", attrs: DETAIL_DIM });
    lines.push({ text: "Description:", attrs: { ...DETAIL_LABEL, bold: true } });
    for (const segLine of renderMarkdownToStyledLines(issue.description, contentWidth, { baseAttrs: DETAIL_VALUE })) {
      lines.push({ segments: segLine });
    }
  }

  // Comments
  if (issue.comments && issue.comments.length > 0) {
    lines.push({ text: "", attrs: DETAIL_DIM });
    lines.push({ text: `Comments (${issue.comments.length}):`, attrs: { ...DETAIL_LABEL, bold: true } });
    for (const comment of issue.comments) {
      lines.push({ text: "", attrs: DETAIL_DIM });
      const date = comment.createdAt ? new Date(comment.createdAt).toLocaleDateString() : "";
      lines.push({ text: `${comment.author}  ${date}`, attrs: { ...DETAIL_LABEL, bold: true } });
      for (const segLine of renderMarkdownToStyledLines(comment.body, contentWidth, { baseAttrs: DETAIL_VALUE })) {
        lines.push({ segments: segLine });
      }
    }
  }

  return lines;
}

/**
 * The largest scroll offset that still shows content — i.e. the offset at which
 * the last line sits on the top row.
 *
 * Exposed rather than kept private because line count depends on both width and
 * content: a terminal resize re-wraps the description, and a poll can drop
 * comments. A surface that only clamped on keypress would strand its offset
 * past the end and paint a blank body, so callers clamp on every render.
 */
export function maxDetailScroll(lineCount: number, maxRows: number): number {
  return Math.max(0, lineCount - Math.max(1, maxRows));
}

/**
 * Paint detail lines into a region, with scroll indicators when the content
 * overflows. `startCol`/`cols` describe the region; padding is applied inside
 * it, so a full-width surface and a docked panel share this verbatim.
 */
export function paintDetailLines(
  grid: CellGrid,
  startRow: number,
  startCol: number,
  cols: number,
  maxRows: number,
  lines: readonly DetailLine[],
  scrollOffset: number,
): void {
  const totalLines = lines.length;
  const canScroll = totalLines > maxRows;

  for (let i = 0; i < maxRows; i++) {
    const lineIdx = i + scrollOffset;
    if (lineIdx >= totalLines) break;
    const line = lines[lineIdx]!;
    const indent = (line.indent ?? 0) * 2;
    const col = startCol + PAD + indent;
    const maxWidth = cols - PAD * 2 - indent;
    if (maxWidth <= 0) continue;
    if ("segments" in line) {
      let used = 0;
      for (const seg of line.segments) {
        if (used >= maxWidth) break;
        // writeString clips at the grid edge, so the slice isn't pre-truncated;
        // only the display width is tracked so the next segment lands right.
        writeString(grid, startRow + i, col + used, seg.text, seg.attrs);
        used += textCols(seg.text);
      }
    } else {
      writeString(grid, startRow + i, col, line.text.slice(0, maxWidth), line.attrs);
    }
  }

  if (canScroll) {
    if (scrollOffset > 0) {
      writeString(grid, startRow, startCol + cols - PAD, "↑", DETAIL_HINT);
    }
    if (scrollOffset + maxRows < totalLines) {
      writeString(grid, startRow + maxRows - 1, startCol + cols - PAD, "↓", DETAIL_HINT);
    }
  }
}
