// src/images/kitty.ts
//
// The kitty graphics protocol, as much of it as jmux needs: the capability
// probe, the cell-geometry probe, and the three commands that put a picture on
// the screen and take it off again.
//
// Everything here is a pure string builder or a pure scan. The escape sequences
// go out through the renderer's frame buffer, not from this module — one writer
// to stdout stays one writer, and it means the placement layer can be unit
// tested by asserting on the bytes it would have emitted.
//
// jmux can speak this protocol at all only because it is the outermost program:
// it composites its own chrome and writes directly to the real terminal, with
// tmux living *inside* a pty it owns. Nothing here goes through tmux, so none of
// the usual `allow-passthrough` wrapping applies. If jmux is itself launched
// inside another multiplexer, the capability probe simply goes unanswered and
// the whole feature stays off — which is the correct outcome, not a special case
// to code around.

/** Terminal cell size in pixels — the unit that turns an image into a layout. */
export interface CellPixels {
  w: number;
  h: number;
}

/**
 * Assumed cell geometry when the terminal won't report its own.
 *
 * A 1:2 cell is the common case across the terminals that implement this
 * protocol, and the consequence of being wrong is a mildly stretched image
 * rather than a broken frame — placements are given an explicit column and row
 * count, so the picture always occupies exactly the space the layout reserved
 * for it whether or not this guess was right.
 */
export const DEFAULT_CELL_PIXELS: CellPixels = { w: 9, h: 18 };

/** Base64 payload bytes per APC chunk. 4096 is the protocol's stated maximum. */
const CHUNK = 4096;

/**
 * Image ids are a terminal-wide namespace shared by every program talking to
 * the same terminal — including a second jmux in another window. Seeding the
 * counter from the pid keeps two instances from transmitting over each other's
 * pictures without needing any coordination between them.
 */
export function idBase(pid: number): number {
  return ((pid & 0x7fff) << 15) + 1;
}

function apc(payload: string): string {
  return `\x1b_G${payload}\x1b\\`;
}

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
}

// --- Probes -----------------------------------------------------------------

/**
 * Capability probe: transmit a single throwaway pixel with `a=q` (query only).
 *
 * A terminal that implements the protocol answers `ESC _G i=<id>;OK ESC \`; one
 * that doesn't is required to swallow the APC string silently. `q=` is
 * deliberately absent — this is the one command whose reply we want.
 */
export const GRAPHICS_PROBE_ID = 31;
export const GRAPHICS_PROBE =
  apc(`i=${GRAPHICS_PROBE_ID},a=q,s=1,v=1,t=d,f=24;AAAA`);

/**
 * Cell-geometry probes, sent as a pair because no single one is universally
 * answered: `CSI 16 t` reports the cell size directly, `CSI 14 t` reports the
 * text area in pixels which divides down to the same thing given the grid size
 * jmux already knows. Whichever arrives first wins; if neither does, layout
 * falls back to DEFAULT_CELL_PIXELS.
 */
export const CELL_SIZE_PROBE = "\x1b[16t\x1b[14t";

export interface ProbeScan {
  /** True/false once the terminal has answered the graphics probe. */
  supported: boolean | null;
  /** Cell geometry, once a size probe has been answered. */
  cellPx: CellPixels | null;
  /** Bytes to pass downstream, replies removed — or null while holding a split reply. */
  forward: string | null;
  /** Carry-over to thread back in on the next chunk. */
  pending: string;
}

/** Any APC reply from the graphics protocol, `OK` or an error code. */
const GRAPHICS_REPLY_RE = /\x1b_G[^\x1b\x07]*(?:\x1b\\|\x07)/;
/** `CSI 6 ; height ; width t` — the reply to `CSI 16 t`. */
const CELL_SIZE_REPLY_RE = /\x1b\[6;(\d+);(\d+)t/;
/** `CSI 4 ; height ; width t` — the reply to `CSI 14 t`, in text-area pixels. */
const TEXT_AREA_REPLY_RE = /\x1b\[4;(\d+);(\d+)t/;

/**
 * Peel probe replies out of a stdin chunk.
 *
 * Stateless in the same shape as `scanForOsc11`: the caller threads `pending`
 * between calls. Only an APC reply is ever held for continuation — a CSI reply
 * that splits across reads is simply missed, because holding on a partial
 * `ESC [` would swallow a lone Escape keypress, and losing the cell geometry
 * costs an aspect-ratio guess while losing the Escape key costs the user their
 * way out of a screen.
 */
export function scanForImageProbe(
  pending: string,
  chunk: string,
  grid: { cols: number; rows: number },
): ProbeScan {
  let s = pending + chunk;
  let supported: boolean | null = null;
  let cellPx: CellPixels | null = null;

  const g = s.match(GRAPHICS_REPLY_RE);
  if (g) {
    supported = /;OK(?:\x1b\\|\x07)$/.test(g[0]);
    s = s.slice(0, g.index) + s.slice(g.index! + g[0].length);
  } else if (s.includes("\x1b_G") && s.length < 512) {
    // A reply has started but not terminated — hold the whole chunk. Bounded so
    // a terminal that emits a stray APC introducer can't swallow real input.
    return { supported: null, cellPx: null, forward: null, pending: s };
  }

  const cs = s.match(CELL_SIZE_REPLY_RE);
  if (cs) {
    const h = Number(cs[1]);
    const w = Number(cs[2]);
    if (w > 0 && h > 0) cellPx = { w, h };
    s = s.slice(0, cs.index) + s.slice(cs.index! + cs[0].length);
  }

  const ta = s.match(TEXT_AREA_REPLY_RE);
  if (ta) {
    const h = Number(ta[1]);
    const w = Number(ta[2]);
    if (!cellPx && w > 0 && h > 0 && grid.cols > 0 && grid.rows > 0) {
      const cw = Math.round(w / grid.cols);
      const ch = Math.round(h / grid.rows);
      if (cw > 0 && ch > 0) cellPx = { w: cw, h: ch };
    }
    s = s.slice(0, ta.index) + s.slice(ta.index! + ta[0].length);
  }

  return { supported, cellPx, forward: s, pending: "" };
}

// --- Commands ---------------------------------------------------------------

/**
 * Transmit PNG data under `id`, chunked. The terminal keeps the data until it
 * is explicitly freed, so this runs once per image no matter how many times or
 * places it is subsequently drawn.
 *
 * `q=2` suppresses the terminal's acknowledgement. That matters more than it
 * looks: every reply would land on jmux's stdin, where it would have to be
 * peeled back off before the rest of the chunk reaches tmux.
 */
export function encodeTransmit(id: number, png: Uint8Array): string {
  const b64 = toBase64(png);
  if (b64.length <= CHUNK) {
    return apc(`a=t,f=100,t=d,i=${id},q=2;${b64}`);
  }
  const parts: string[] = [];
  for (let off = 0; off < b64.length; off += CHUNK) {
    const piece = b64.slice(off, off + CHUNK);
    const more = off + CHUNK < b64.length ? 1 : 0;
    parts.push(
      off === 0
        ? apc(`a=t,f=100,t=d,i=${id},q=2,m=1;${piece}`)
        : apc(`m=${more};${piece}`),
    );
  }
  return parts.join("");
}

/** Source rectangle, in image pixels, for a partially scrolled placement. */
export interface Crop {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PlacementSpec {
  id: number;
  placementId: number;
  cols: number;
  rows: number;
  crop?: Crop;
}

/**
 * Draw a transmitted image at the cursor, scaled into exactly `cols`×`rows`
 * cells.
 *
 * `C=1` keeps the cursor where it was. Without it the terminal advances past
 * the image, which at the bottom of the screen scrolls the whole frame — and
 * jmux's frame is absolutely positioned, so a scroll is not a cosmetic problem
 * but a corrupted screen.
 */
export function encodePlace(p: PlacementSpec): string {
  const keys = [
    "a=p",
    `i=${p.id}`,
    `p=${p.placementId}`,
    `c=${p.cols}`,
    `r=${p.rows}`,
    "C=1",
    "q=2",
  ];
  if (p.crop) {
    keys.push(`x=${p.crop.x}`, `y=${p.crop.y}`, `w=${p.crop.w}`, `h=${p.crop.h}`);
  }
  return apc(keys.join(","));
}

/**
 * Remove one placement, leaving the transmitted data in place — lowercase `d=i`
 * deletes placements only, where `d=I` would also free the image and force a
 * re-transmit the next time it scrolls back into view.
 */
export function encodeDeletePlacement(id: number, placementId: number): string {
  return apc(`a=d,d=i,i=${id},p=${placementId},q=2`);
}

/** Remove an image and free its data. Used at shutdown. */
export function encodeDeleteImage(id: number): string {
  return apc(`a=d,d=I,i=${id},q=2`);
}

// --- Layout math ------------------------------------------------------------

export interface CellBox {
  cols: number;
  rows: number;
}

/**
 * The cell box an image should occupy: its natural size at the terminal's cell
 * geometry, shrunk to fit the available box, never enlarged.
 *
 * Not enlarging is a deliberate choice — an upscaled screenshot is blurry and
 * an upscaled icon is absurd, and the reserved rows are cheap for a small
 * image but expensive for a large one.
 */
export function fitImage(
  px: { w: number; h: number },
  cell: CellPixels,
  maxCols: number,
  maxRows: number,
): CellBox {
  if (px.w <= 0 || px.h <= 0 || maxCols <= 0 || maxRows <= 0) return { cols: 0, rows: 0 };
  const naturalCols = px.w / cell.w;
  const naturalRows = px.h / cell.h;
  const scale = Math.min(1, maxCols / naturalCols, maxRows / naturalRows);
  return {
    cols: Math.max(1, Math.min(maxCols, Math.round(naturalCols * scale))),
    rows: Math.max(1, Math.min(maxRows, Math.round(naturalRows * scale))),
  };
}

/**
 * The source rectangle to draw when only part of an image's rows are on screen.
 *
 * Scrolling is by whole cells, so the crop is proportional: the fraction of
 * rows hidden above is the fraction of pixels skipped. Returns null when the
 * whole image is visible, so the common case emits no crop keys at all.
 */
export function cropForVisibleRows(
  px: { w: number; h: number },
  totalRows: number,
  firstVisibleRow: number,
  visibleRows: number,
): Crop | null {
  if (firstVisibleRow <= 0 && visibleRows >= totalRows) return null;
  const top = Math.max(0, Math.min(totalRows, firstVisibleRow));
  const count = Math.max(0, Math.min(totalRows - top, visibleRows));
  const y = Math.round((top / totalRows) * px.h);
  const yEnd = Math.round(((top + count) / totalRows) * px.h);
  return { x: 0, y, w: px.w, h: Math.max(1, yEnd - y) };
}
