import { ColorMode } from "./types";
import type { CellAttrs, StyledLine, StyledSegment } from "./cell-grid";

export interface RenderMarkdownOptions {
  // Fallback fg/bg used when Bun emits cells with default fg/bg. Useful so
  // markdown rendered into a host surface (modal, panel) picks up that
  // surface's background. Only fg/bg/fgMode/bgMode are honored — bold/italic/
  // underline/dim are always controlled by the markdown's own SGR state.
  baseAttrs?: Pick<CellAttrs, "fg" | "bg" | "fgMode" | "bgMode">;
  // OSC 8 hyperlinks. On by default — the parser captures OSC 8 targets onto
  // CellAttrs.link and the renderer re-emits them, so links stay clickable
  // even when wrapped across lines (regex-based URL detection in terminals
  // breaks on wraps; OSC 8 doesn't). Set to false to force inline `text (url)`
  // rendering instead.
  hyperlinks?: boolean;
  // Trim blank lines from the end of the output. On by default.
  trimTrailingBlanks?: boolean;
  // Rewrite `![alt](url)` to `[alt](url)` so images surface as clickable
  // links to the image URL instead of Bun's `[img] alt` placeholder which
  // drops the URL entirely. On by default. Images already nested inside a
  // link (`[![logo](img)](page)`) are left alone — the outer page URL wins.
  linkifyImages?: boolean;
  // Lift flush-left, standalone images out of the prose as their own blocks so
  // a caller can draw them (see renderMarkdownBlocks). Off by default, because
  // only surfaces that can actually paint an image want this — everyone else
  // gets the link rewrite above.
  extractImages?: boolean;
}

function linkifyImages(text: string): string {
  return text.replace(/(\[)?!\[([^\]]*)\]\(([^)\s]+)\)/g, (match, leadingBracket, alt, url) => {
    if (leadingBracket) return match;
    const label = alt.trim() || url;
    return `[${label}](${url})`;
  });
}

interface SgrState {
  fg?: number;
  bg?: number;
  fgMode?: ColorMode;
  bgMode?: ColorMode;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
  link?: string;
}

const ANSI_BASIC_FG: Record<number, number> = {
  30: 0, 31: 1, 32: 2, 33: 3, 34: 4, 35: 5, 36: 6, 37: 7,
  90: 8, 91: 9, 92: 10, 93: 11, 94: 12, 95: 13, 96: 14, 97: 15,
};

const ANSI_BASIC_BG: Record<number, number> = {
  40: 0, 41: 1, 42: 2, 43: 3, 44: 4, 45: 5, 46: 6, 47: 7,
  100: 8, 101: 9, 102: 10, 103: 11, 104: 12, 105: 13, 106: 14, 107: 15,
};

function freshState(): SgrState {
  return { bold: false, dim: false, italic: false, underline: false };
}

function applySgr(state: SgrState, params: number[]): SgrState {
  const next: SgrState = { ...state };
  let i = 0;
  while (i < params.length) {
    const p = params[i];
    if (p === 0) {
      Object.assign(next, freshState());
      next.fg = undefined; next.fgMode = undefined;
      next.bg = undefined; next.bgMode = undefined;
      i++;
      continue;
    }
    if (p === 1) { next.bold = true; i++; continue; }
    if (p === 2) { next.dim = true; i++; continue; }
    if (p === 3) { next.italic = true; i++; continue; }
    if (p === 4) { next.underline = true; i++; continue; }
    // SGR 22 turns off both bold and faint per the spec.
    if (p === 22) { next.bold = false; next.dim = false; i++; continue; }
    if (p === 23) { next.italic = false; i++; continue; }
    if (p === 24) { next.underline = false; i++; continue; }
    if (p === 9 || p === 29) { i++; continue; } // strike — no slot in CellAttrs
    if (p === 39) { next.fg = undefined; next.fgMode = undefined; i++; continue; }
    if (p === 49) { next.bg = undefined; next.bgMode = undefined; i++; continue; }
    if (p in ANSI_BASIC_FG) { next.fg = ANSI_BASIC_FG[p]; next.fgMode = ColorMode.Palette; i++; continue; }
    if (p in ANSI_BASIC_BG) { next.bg = ANSI_BASIC_BG[p]; next.bgMode = ColorMode.Palette; i++; continue; }
    if (p === 38 && params[i + 1] === 5) {
      next.fg = params[i + 2] ?? 0; next.fgMode = ColorMode.Palette;
      i += 3; continue;
    }
    if (p === 48 && params[i + 1] === 5) {
      next.bg = params[i + 2] ?? 0; next.bgMode = ColorMode.Palette;
      i += 3; continue;
    }
    if (p === 38 && params[i + 1] === 2) {
      const r = params[i + 2] ?? 0, g = params[i + 3] ?? 0, b = params[i + 4] ?? 0;
      next.fg = (r << 16) | (g << 8) | b; next.fgMode = ColorMode.RGB;
      i += 5; continue;
    }
    if (p === 48 && params[i + 1] === 2) {
      const r = params[i + 2] ?? 0, g = params[i + 3] ?? 0, b = params[i + 4] ?? 0;
      next.bg = (r << 16) | (g << 8) | b; next.bgMode = ColorMode.RGB;
      i += 5; continue;
    }
    i++;
  }
  return next;
}

function stateToAttrs(state: SgrState, base: Pick<CellAttrs, "fg" | "bg" | "fgMode" | "bgMode">): CellAttrs {
  return {
    fg: state.fg !== undefined ? state.fg : base.fg,
    fgMode: state.fgMode !== undefined ? state.fgMode : base.fgMode,
    bg: state.bg !== undefined ? state.bg : base.bg,
    bgMode: state.bgMode !== undefined ? state.bgMode : base.bgMode,
    bold: state.bold,
    italic: state.italic,
    underline: state.underline,
    dim: state.dim,
    link: state.link,
  };
}

function parseAnsi(
  ansi: string,
  base: Pick<CellAttrs, "fg" | "bg" | "fgMode" | "bgMode">,
  trimTrailing: boolean,
): StyledLine[] {
  const lines: StyledLine[] = [];
  let line: StyledSegment[] = [];
  let state = freshState();
  let attrs = stateToAttrs(state, base);
  let segText = "";

  const flushSeg = () => {
    if (segText.length > 0) {
      line.push({ text: segText, attrs });
      segText = "";
    }
  };
  const flushLine = () => {
    flushSeg();
    lines.push(line);
    line = [];
  };

  let i = 0;
  while (i < ansi.length) {
    const ch = ansi[i];
    if (ch === "\n") { flushLine(); i++; continue; }
    if (ch === "\r") { i++; continue; }
    if (ch === "\x1b") {
      if (ansi[i + 1] === "[") {
        // CSI: ESC [ params final
        let end = i + 2;
        while (end < ansi.length) {
          const code = ansi.charCodeAt(end);
          if (code >= 0x40 && code <= 0x7e) break;
          end++;
        }
        const final = ansi[end];
        const paramStr = ansi.slice(i + 2, end);
        if (final === "m") {
          flushSeg();
          const params = paramStr === ""
            ? [0]
            : paramStr.split(";").map((p) => Number(p) || 0);
          state = applySgr(state, params);
          attrs = stateToAttrs(state, base);
        }
        i = end + 1;
        continue;
      }
      if (ansi[i + 1] === "]") {
        // OSC: ESC ] payload ST  (ST = BEL or ESC \)
        let payloadEnd = i + 2;
        let terminatorLen = 0;
        while (payloadEnd < ansi.length) {
          if (ansi[payloadEnd] === "\x07") { terminatorLen = 1; break; }
          if (ansi[payloadEnd] === "\x1b" && ansi[payloadEnd + 1] === "\\") { terminatorLen = 2; break; }
          payloadEnd++;
        }
        const payload = ansi.slice(i + 2, payloadEnd);
        // OSC 8 hyperlink: format `8;params;url`. Empty url = close.
        if (payload.startsWith("8;")) {
          const semi = payload.indexOf(";", 2);
          const url = semi >= 0 ? payload.slice(semi + 1) : "";
          flushSeg();
          state = { ...state, link: url || undefined };
          attrs = stateToAttrs(state, base);
        }
        i = payloadEnd + terminatorLen;
        continue;
      }
      // Unknown escape — skip the introducer + next byte to stay safe.
      i += 2;
      continue;
    }
    segText += ch;
    i++;
  }
  flushLine();

  if (trimTrailing) {
    while (lines.length > 0 && lines[lines.length - 1].every((s) => s.text.trim() === "")) {
      lines.pop();
    }
  }
  return lines;
}

export function renderMarkdownToStyledLines(
  text: string,
  width: number,
  opts: RenderMarkdownOptions = {},
): StyledLine[] {
  if (!text || width <= 0) return [];
  const source = (opts.linkifyImages ?? true) ? linkifyImages(text) : text;
  const ansi = Bun.markdown.ansi(source, {
    columns: width,
    colors: true,
    hyperlinks: opts.hyperlinks ?? true,
  });
  return parseAnsi(ansi, opts.baseAttrs ?? {}, opts.trimTrailingBlanks ?? true);
}

// --- Image blocks -----------------------------------------------------------

/** A run of prose, or one image that stood alone in it. */
export type MarkdownChunk =
  | { kind: "text"; text: string }
  | { kind: "image"; url: string; alt: string };

export type MarkdownBlock =
  | { kind: "lines"; lines: StyledLine[] }
  | { kind: "image"; url: string; alt: string };

/** `![alt](url)` and nothing else — no title argument, no surrounding text. */
const STANDALONE_IMAGE_RE = /^!\[([^\]]*)\]\(([^)\s]+)\)$/;
/** The HTML form GitHub's own editor emits when you paste a screenshot. */
const STANDALONE_IMG_TAG_RE = /^<img\s[^>]*?src=["']([^"']+)["'][^>]*>$/i;
const IMG_TAG_ALT_RE = /\balt=["']([^"']*)["']/i;
/** ``` or ~~~ opening or closing a fenced code block. */
const FENCE_RE = /^(`{3,}|~{3,})/;

/**
 * Split markdown into prose and the images that stood on their own inside it.
 *
 * The rule is deliberately narrow: **a flush-left line containing nothing but
 * one image**. Everything else — an image mid-sentence, a badge wrapped in a
 * link, an image indented into a list item — stays in the prose and is
 * linkified as before.
 *
 * The narrowness is the point. Lifting an image out of the text means cutting
 * the document in two and rendering the halves independently, which silently
 * breaks any construct that spanned the cut: a list loses its numbering, a
 * table loses its header. A flush-left line is the one position where no such
 * construct can be open, so it is the one position where the cut is free.
 * Fenced code is skipped for the same reason in reverse — an image inside a
 * fence isn't an image, it's the text of an example.
 */
export function splitImageChunks(text: string): MarkdownChunk[] {
  const chunks: MarkdownChunk[] = [];
  const lines = text.split("\n");
  let buffer: string[] = [];
  let fence: string | null = null;

  const flush = () => {
    if (buffer.length === 0) return;
    const joined = buffer.join("\n");
    buffer = [];
    if (joined.trim().length > 0) chunks.push({ kind: "text", text: joined });
  };

  for (const line of lines) {
    if (fence !== null) {
      buffer.push(line);
      // A closing fence must be at least as long as the opening one and of the
      // same character; anything shorter is content, not a terminator.
      const close = line.match(FENCE_RE);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) fence = null;
      continue;
    }
    const open = line.match(FENCE_RE);
    if (open) {
      fence = open[1];
      buffer.push(line);
      continue;
    }

    const md = line.match(STANDALONE_IMAGE_RE);
    if (md) {
      flush();
      chunks.push({ kind: "image", alt: md[1].trim(), url: md[2] });
      continue;
    }
    const tag = line.match(STANDALONE_IMG_TAG_RE);
    if (tag) {
      flush();
      chunks.push({ kind: "image", alt: line.match(IMG_TAG_ALT_RE)?.[1].trim() ?? "", url: tag[1] });
      continue;
    }
    buffer.push(line);
  }
  flush();
  return chunks;
}

/**
 * Markdown as alternating rendered prose and image references.
 *
 * The counterpart to `renderMarkdownToStyledLines` for surfaces that can draw a
 * picture. With `extractImages` off it returns exactly one `lines` block whose
 * content is identical to that function's output, so a caller that can't draw
 * needs no second code path — and the two can't drift, because there is only
 * one renderer underneath.
 */
export function renderMarkdownBlocks(
  text: string,
  width: number,
  opts: RenderMarkdownOptions = {},
): MarkdownBlock[] {
  if (!text || width <= 0) return [];
  if (!opts.extractImages) {
    const lines = renderMarkdownToStyledLines(text, width, opts);
    return lines.length > 0 ? [{ kind: "lines", lines }] : [];
  }
  const blocks: MarkdownBlock[] = [];
  for (const chunk of splitImageChunks(text)) {
    if (chunk.kind === "image") {
      blocks.push(chunk);
      continue;
    }
    const lines = renderMarkdownToStyledLines(chunk.text, width, opts);
    if (lines.length > 0) blocks.push({ kind: "lines", lines });
  }
  return blocks;
}
