import { describe, expect, test } from "bun:test";
import { readPngSize, sniffFormat } from "../images/png";

/** A PNG header with the given dimensions — enough for sniffing and sizing. */
function pngHeader(w: number, h: number): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13); // IHDR length
  bytes.set([0x49, 0x48, 0x44, 0x52], 12); // "IHDR"
  view.setUint32(16, w);
  view.setUint32(20, h);
  return bytes;
}

describe("sniffFormat", () => {
  test("identifies PNG", () => {
    expect(sniffFormat(pngHeader(1, 1))).toBe("png");
  });

  test("identifies JPEG", () => {
    expect(sniffFormat(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0]))).toBe("jpeg");
  });

  test("identifies GIF", () => {
    expect(sniffFormat(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))).toBe("gif");
  });

  test("identifies WebP by its RIFF container", () => {
    const bytes = new Uint8Array(16);
    bytes.set([0x52, 0x49, 0x46, 0x46], 0);
    bytes.set([0x57, 0x45, 0x42, 0x50], 8);
    expect(sniffFormat(bytes)).toBe("webp");
  });

  test("a RIFF that isn't WebP is not WebP", () => {
    const bytes = new Uint8Array(16);
    bytes.set([0x52, 0x49, 0x46, 0x46], 0);
    bytes.set([0x57, 0x41, 0x56, 0x45], 8); // WAVE
    expect(sniffFormat(bytes)).toBe("unknown");
  });

  test("identifies SVG behind an XML declaration", () => {
    const svg = new TextEncoder().encode(`<?xml version="1.0"?>\n<svg xmlns="x"></svg>`);
    expect(sniffFormat(svg)).toBe("svg");
  });

  test("XML that isn't SVG is not an image", () => {
    expect(sniffFormat(new TextEncoder().encode(`<?xml version="1.0"?><rss/>`))).toBe("unknown");
  });

  test("HTML — the shape of an auth redirect — is not an image", () => {
    expect(sniffFormat(new TextEncoder().encode("<!DOCTYPE html><html>"))).toBe("unknown");
  });

  test("empty input is unknown, not a crash", () => {
    expect(sniffFormat(new Uint8Array(0))).toBe("unknown");
  });
});

describe("readPngSize", () => {
  test("reads width and height from IHDR", () => {
    expect(readPngSize(pngHeader(1920, 1080))).toEqual({ w: 1920, h: 1080 });
  });

  test("rejects non-PNG data", () => {
    expect(readPngSize(new Uint8Array([0xff, 0xd8, 0xff]))).toBeNull();
  });

  test("rejects a PNG signature with a truncated header", () => {
    expect(readPngSize(pngHeader(10, 10).subarray(0, 20))).toBeNull();
  });

  test("rejects a first chunk that isn't IHDR", () => {
    const bytes = pngHeader(10, 10);
    bytes.set([0x49, 0x44, 0x41, 0x54], 12); // IDAT
    expect(readPngSize(bytes)).toBeNull();
  });

  test("rejects zero dimensions", () => {
    expect(readPngSize(pngHeader(0, 10))).toBeNull();
  });

  test("reads from a view with a non-zero byte offset", () => {
    // Uint8Array.subarray shares its buffer, so a DataView built on
    // `bytes.buffer` without honouring byteOffset would read the wrong bytes.
    const padded = new Uint8Array(40);
    padded.set(pngHeader(64, 32), 7);
    expect(readPngSize(padded.subarray(7))).toEqual({ w: 64, h: 32 });
  });
});
