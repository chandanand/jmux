// src/images/port.ts
//
// The seam between "there is an image at this URL" and "reserve this many cells
// for it".
//
// The detail builder must not know about caches, terminal capabilities or cell
// geometry — it lays out lines. The store must not know about layout. This is
// the one place that holds both, and it is deliberately the only thing either
// side has to be given.
//
// It is module-level, singleton state with a setter, in the same shape as
// `theme` and `chrome-tokens`. That's a considered choice rather than
// convenience: an image port describes the *terminal*, of which there is
// exactly one per process, and it is read at render time by two surfaces whose
// call chains would otherwise both have to grow a parameter that could only
// ever hold the same value. The rule that keeps it honest is the same one the
// theme follows — nothing here is ever read at import time, only during a
// render, so the value that gets used is always the current one.

import type { ImageStore } from "./store";
import { fitImage, type CellPixels } from "./kitty";

/** What the layout should do about one image URL, right now. */
export type ImageResolution =
  | { kind: "loading" }
  | { kind: "failed"; reason: string }
  | { kind: "ready"; id: number; cols: number; rows: number };

export interface ImagePort {
  /** Resolve an image into a cell box no wider than `maxCols`. */
  resolve(url: string, maxCols: number): ImageResolution;
}

export interface ImagePortDeps {
  /** Live cell geometry — re-probed on resize, so read per call, not captured. */
  cellPx: () => CellPixels;
  /** Tallest box an image may claim, in rows. */
  maxRows: () => number;
}

export class StoreImagePort implements ImagePort {
  constructor(
    private readonly store: ImageStore,
    private readonly deps: ImagePortDeps,
  ) {}

  resolve(url: string, maxCols: number): ImageResolution {
    const entry = this.store.request(url);
    if (entry.state === "loading") return { kind: "loading" };
    if (entry.state === "failed") return { kind: "failed", reason: entry.reason };
    const box = fitImage(entry.px, this.deps.cellPx(), maxCols, this.deps.maxRows());
    if (box.cols <= 0 || box.rows <= 0) return { kind: "failed", reason: "no room" };
    return { kind: "ready", id: entry.id, cols: box.cols, rows: box.rows };
  }
}

let active: ImagePort | null = null;

/**
 * Install (or, with null, remove) the port every issue-detail render will use.
 * Null is the state on a terminal with no graphics support, and it is what
 * makes the fallback path the *same* path rather than a parallel one: with no
 * port, images are linkified exactly as they were before any of this existed.
 */
export function setImagePort(port: ImagePort | null): void {
  active = port;
}

export function getImagePort(): ImagePort | null {
  return active;
}
