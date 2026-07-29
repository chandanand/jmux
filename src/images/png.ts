// src/images/png.ts
//
// Format sniffing and PNG intrinsic size.
//
// The kitty graphics protocol's `f=100` transmission accepts PNG and nothing
// else, so every image jmux shows has to arrive here as PNG bytes — which makes
// "what format is this actually?" a decision the pipeline must make before it
// can decide whether to convert (see convert.ts) or give up and fall back to a
// link.
//
// Sniffing is done on magic bytes rather than the URL extension or the
// Content-Type header: tracker attachment URLs routinely carry neither (Linear
// serves uploads from opaque paths, GitHub's user-attachments redirects), and a
// wrong guess here means transmitting garbage to the terminal.
//
// The size read is deliberately hand-rolled instead of pulling a decoder: the
// layout only needs width and height, and those live in the IHDR chunk which is
// fixed at bytes 16..24 of every conformant PNG. Decoding pixels would be
// pointless work — the terminal does that.

export type ImageFormat = "png" | "jpeg" | "gif" | "webp" | "bmp" | "svg" | "unknown";

export interface PixelSize {
  w: number;
  h: number;
}

function startsWith(bytes: Uint8Array, sig: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + sig.length) return false;
  for (let i = 0; i < sig.length; i++) {
    if (bytes[offset + i] !== sig[i]) return false;
  }
  return true;
}

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const GIF_SIG = [0x47, 0x49, 0x46, 0x38]; // GIF8
const BMP_SIG = [0x42, 0x4d]; // BM
const RIFF_SIG = [0x52, 0x49, 0x46, 0x46]; // RIFF
const WEBP_SIG = [0x57, 0x45, 0x42, 0x50]; // WEBP, at offset 8

/**
 * Identify an image by its magic bytes. `unknown` covers both "not an image"
 * and "an image format nothing downstream can do anything with" — callers treat
 * them the same way, by falling back to a link.
 */
export function sniffFormat(bytes: Uint8Array): ImageFormat {
  if (startsWith(bytes, PNG_SIG)) return "png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  if (startsWith(bytes, GIF_SIG)) return "gif";
  if (startsWith(bytes, BMP_SIG)) return "bmp";
  if (startsWith(bytes, RIFF_SIG) && startsWith(bytes, WEBP_SIG, 8)) return "webp";
  // SVG is text, and may open with an XML declaration, a comment, or the tag
  // itself. Sniffed only so the caller can report "vector, not shown" rather
  // than the misleading "not an image".
  const head = new TextDecoder().decode(bytes.subarray(0, 256)).trimStart();
  if (head.startsWith("<?xml") || head.startsWith("<svg") || head.startsWith("<!--")) {
    if (head.includes("<svg")) return "svg";
  }
  return "unknown";
}

/**
 * Width and height from a PNG's IHDR chunk, or null if the bytes aren't a PNG
 * whose header is intact.
 *
 * The chunk is required by the spec to be first, so its layout is fixed:
 * 8-byte signature, 4-byte length, 4-byte type ("IHDR"), then width and height
 * as big-endian uint32s. Anything that doesn't match that is treated as
 * unreadable rather than guessed at.
 */
export function readPngSize(bytes: Uint8Array): PixelSize | null {
  if (!startsWith(bytes, PNG_SIG)) return null;
  if (bytes.length < 24) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(12) !== 0x49484452) return null; // "IHDR"
  const w = view.getUint32(16);
  const h = view.getUint32(20);
  if (w <= 0 || h <= 0) return null;
  return { w, h };
}
