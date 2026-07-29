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

import type { CellGrid, ImageMark } from "./types";
import { ColorMode } from "./types";
import { writeString, writeImageRow, textCols, type CellAttrs, type StyledLine } from "./cell-grid";
import type { Issue } from "./adapters/types";
import { renderMarkdownBlocks, renderMarkdownToStyledLines } from "./markdown";
import { getImagePort } from "./images/port";
import { neutralFg } from "./theme";
import { tokens } from "./chrome-tokens";

/**
 * One rendered line. Untagged on purpose — a line is either a single run of
 * uniform text, a pre-styled segment list from the markdown renderer, or one
 * row of an image's reserved cell box, and every consumer discriminates on
 * which key is present.
 *
 * An image being *lines* rather than a block with a height is what keeps it
 * free: scrolling, the max-scroll clamp, clipping at the pane edge and
 * occlusion by a modal are all things that already happen to lines, and an
 * image inherits every one of them without a single call site learning that
 * images exist.
 */
export type DetailLine =
  | { text: string; attrs: CellAttrs; indent?: number }
  | { segments: StyledLine; indent?: number }
  | { imageRow: ImageMark; url: string; indent?: number };

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

/**
 * Markdown prose as detail lines, with standalone images drawn in place when
 * the terminal can draw them.
 *
 * The fallback isn't a separate branch: with no image port, `extractImages` is
 * off and this collapses to the single markdown render it always was. A
 * loading or unusable image falls back to the same `![alt](url)` the whole
 * document would have produced, rendered through the same renderer — so the
 * link a user sees when an image fails is byte-identical to the link they saw
 * before jmux could show images at all.
 */
function markdownDetailLines(text: string, contentWidth: number): DetailLine[] {
  const port = getImagePort();
  const lines: DetailLine[] = [];
  const linkFallback = (url: string, alt: string, note?: string): void => {
    for (const segLine of renderMarkdownToStyledLines(`![${alt}](${url})`, contentWidth, { baseAttrs: DETAIL_VALUE })) {
      lines.push({ segments: segLine });
    }
    if (note) lines.push({ text: note, attrs: DETAIL_DIM });
  };

  for (const block of renderMarkdownBlocks(text, contentWidth, {
    baseAttrs: DETAIL_VALUE,
    extractImages: port !== null,
  })) {
    if (block.kind === "lines") {
      for (const segLine of block.lines) lines.push({ segments: segLine });
      continue;
    }
    if (!port) {
      // Unreachable — extractImages is off without a port, so no image block is
      // produced. Kept as the fallback rather than an assertion because the
      // honest answer to "no port" is the link, at every site that asks.
      linkFallback(block.url, block.alt);
      continue;
    }
    const resolved = port.resolve(block.url, contentWidth);
    if (resolved.kind === "loading") {
      lines.push({ text: `⟳ ${block.alt || "loading image"}…`, attrs: DETAIL_DIM });
      continue;
    }
    if (resolved.kind === "failed") {
      linkFallback(block.url, block.alt, `  (${resolved.reason})`);
      continue;
    }
    lines.push({ text: "", attrs: DETAIL_DIM });
    // One mark object per row, shared by that row's cells — see writeImageRow.
    // The URL rides along so the drawn image stays clickable: showing the
    // picture must not take away the thing the link could do.
    for (let r = 0; r < resolved.rows; r++) {
      lines.push({
        imageRow: { id: resolved.id, tileRow: r, rows: resolved.rows, cols: resolved.cols },
        url: block.url,
      });
    }
    lines.push({ text: "", attrs: DETAIL_DIM });
  }
  return lines;
}

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
    lines.push(...markdownDetailLines(issue.description, contentWidth));
  }

  // Comments
  if (issue.comments && issue.comments.length > 0) {
    lines.push({ text: "", attrs: DETAIL_DIM });
    lines.push({ text: `Comments (${issue.comments.length}):`, attrs: { ...DETAIL_LABEL, bold: true } });
    for (const comment of issue.comments) {
      lines.push({ text: "", attrs: DETAIL_DIM });
      const date = comment.createdAt ? new Date(comment.createdAt).toLocaleDateString() : "";
      lines.push({ text: `${comment.author}  ${date}`, attrs: { ...DETAIL_LABEL, bold: true } });
      lines.push(...markdownDetailLines(comment.body, contentWidth));
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
    if ("imageRow" in line) {
      // A row that doesn't fit is simply not marked, and the image layer's
      // whole-row rule then drops it from the placement — a picture is never
      // half-drawn because the pane got narrow between layout and paint.
      //
      // The link goes on the cells under the picture, which is the whole of
      // "clicking the image opens it": the click path reads URLs off the
      // composited grid, so it needs to know nothing about images.
      writeImageRow(grid, startRow + i, col, line.imageRow, { link: line.url });
      continue;
    }
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
