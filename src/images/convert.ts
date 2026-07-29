// src/images/convert.ts
//
// Re-encoding non-PNG images to PNG.
//
// The kitty protocol's file-format transmission is PNG-only, and a tracker's
// attachments are whatever people pasted — JPEG photos, GIF recordings, WebP
// from a browser's "copy image". Without this, "jmux renders images" would mean
// "jmux renders some images", with no way for the user to tell which kind they
// were about to get.
//
// Conversion shells out rather than pulling in a decoder: Bun ships no image
// codec, and a pure-TS JPEG/WebP decoder is a large dependency to carry for a
// preview pane. Every candidate here is optional — when none is installed the
// image falls back to a link, exactly as it does on a terminal with no graphics
// support at all.

import { tmpdir } from "os";
import { join } from "path";
import type { ImageFormat } from "./png";

interface Converter {
  bin: string;
  /** Pipe-based converters read stdin and write stdout; sips needs real files. */
  mode: "pipe" | "file";
  args: (input: string, output: string) => string[];
  /** Same, but also constraining the longest edge to `max` pixels. */
  shrinkArgs: (input: string, output: string, max: number) => string[];
}

// Order is preference. ImageMagick first because it handles every format here
// through a pipe; sips is the macOS fallback that is always present but needs
// files on disk. `-delete 1--1` drops every frame after the first, so an
// animated GIF converts to its opening frame instead of a concatenated stream
// of PNGs the terminal would reject.
const CANDIDATES: readonly Converter[] = [
  {
    bin: "magick",
    mode: "pipe",
    args: () => ["-", "-delete", "1--1", "png:-"],
    shrinkArgs: (_i, _o, max) => ["-", "-delete", "1--1", "-resize", `${max}x${max}>`, "png:-"],
  },
  {
    bin: "convert",
    mode: "pipe",
    args: () => ["-", "-delete", "1--1", "png:-"],
    shrinkArgs: (_i, _o, max) => ["-", "-delete", "1--1", "-resize", `${max}x${max}>`, "png:-"],
  },
  {
    bin: "sips",
    mode: "file",
    args: (input, output) => ["-s", "format", "png", input, "--out", output],
    shrinkArgs: (input, output, max) => [
      "-s", "format", "png", "-Z", String(max), input, "--out", output,
    ],
  },
];

let resolved: { converter: Converter; path: string } | null | undefined;

/** The converter this machine has, resolved once. null means none. */
function findConverter(): { converter: Converter; path: string } | null {
  if (resolved !== undefined) return resolved;
  resolved = null;
  for (const c of CANDIDATES) {
    const path = Bun.which(c.bin);
    if (path) {
      resolved = { converter: c, path };
      break;
    }
  }
  return resolved;
}

/** Formats worth handing to a converter. Vector and unknown data are not. */
export function isConvertible(format: ImageFormat): boolean {
  return format === "jpeg" || format === "gif" || format === "webp" || format === "bmp";
}

/**
 * Re-encode to PNG, or null when no converter is installed or it failed.
 *
 * Failure is deliberately quiet and total — the caller's fallback (show the
 * link) is a fine outcome, and a half-written PNG would be a corrupt image on
 * screen, which is worse than no image.
 */
export async function toPng(bytes: Uint8Array, format: ImageFormat): Promise<Uint8Array | null> {
  if (format === "png") return bytes;
  if (!isConvertible(format)) return null;
  return run(bytes, format, null);
}

/**
 * Re-encode a PNG with its longest edge capped at `max` pixels, or null when
 * that isn't possible.
 *
 * Every byte of an image is base64'd and pushed down the terminal's pty, and a
 * picture jmux will draw sixteen rows tall carries nothing useful above a
 * couple of thousand pixels. A retina screenshot is several megabytes of
 * payload for a thumbnail; this is the difference between a frame that stalls
 * and one that doesn't. Optional in exactly the way conversion is — with no
 * converter installed, the original bytes go out unchanged.
 */
export async function shrinkPng(bytes: Uint8Array, max: number): Promise<Uint8Array | null> {
  return run(bytes, "png", max);
}

async function run(
  bytes: Uint8Array,
  format: ImageFormat,
  shrinkTo: number | null,
): Promise<Uint8Array | null> {
  const found = findConverter();
  if (!found) return null;
  const argsFor = (i: string, o: string): string[] =>
    shrinkTo === null
      ? found.converter.args(i, o)
      : found.converter.shrinkArgs(i, o, shrinkTo);

  if (found.converter.mode === "pipe") {
    try {
      const proc = Bun.spawn([found.path, ...argsFor("", "")], {
        stdin: new Blob([bytes as unknown as BlobPart]),
        stdout: "pipe",
        stderr: "ignore",
      });
      const out = new Uint8Array(await new Response(proc.stdout).arrayBuffer());
      const code = await proc.exited;
      if (code !== 0 || out.length === 0) return null;
      return out;
    } catch {
      return null;
    }
  }

  const stamp = `${process.pid}-${Math.random().toString(36).slice(2)}`;
  const input = join(tmpdir(), `jmux-img-${stamp}.${format}`);
  const output = join(tmpdir(), `jmux-img-${stamp}.png`);
  try {
    await Bun.write(input, bytes);
    const proc = Bun.spawn([found.path, ...argsFor(input, output)], {
      stdout: "ignore",
      stderr: "ignore",
    });
    const code = await proc.exited;
    if (code !== 0) return null;
    const file = Bun.file(output);
    if (!(await file.exists())) return null;
    return new Uint8Array(await file.arrayBuffer());
  } catch {
    return null;
  } finally {
    await Promise.all([
      Bun.file(input).unlink().catch(() => {}),
      Bun.file(output).unlink().catch(() => {}),
    ]);
  }
}
