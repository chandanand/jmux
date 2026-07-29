// src/images/store.ts
//
// The image cache: URL in, transmittable PNG out, one fetch per URL per run.
//
// Two things shape this module.
//
// **Lookups happen during render.** `buildIssueDetailLines` runs on every frame
// and has nowhere to await, so `request()` is synchronous, returns whatever
// state the entry is in right now, and kicks off the load on first sight. That
// makes the cache the thing that keeps the render loop honest: it must never
// re-enter a fetch for a URL it has already seen, including one that failed,
// or a preview left open would hammer the tracker at 60fps.
//
// **The terminal is the other half of the cache.** An id here is an id the
// terminal holds data under, so ids are assigned once and never reused, and
// eviction has to tell the terminal to free the data too — which is why
// `evict()` returns the ids it dropped rather than quietly forgetting them.

import { sniffFormat, readPngSize, type ImageFormat, type PixelSize } from "./png";
import { isConvertible, shrinkPng, toPng } from "./convert";
import { authHeadersFor, isFetchableImageUrl, type Env } from "./auth";
import { idBase } from "./kitty";

export type ImageEntry =
  | { state: "loading" }
  | { state: "failed"; reason: string }
  | { state: "ready"; id: number; png: Uint8Array; px: PixelSize };

/** Refuse anything larger — a 50MB PNG is a base64 flood down a pty. */
const MAX_BYTES = 8 * 1024 * 1024;
/**
 * Past this, re-encode smaller before transmitting if a converter is around.
 * Nothing jmux draws is more than a few hundred pixels tall, so the pixels
 * above this cost pty bandwidth and buy nothing.
 */
const SHRINK_ABOVE_BYTES = 512 * 1024;
const SHRINK_LONGEST_EDGE = 1600;
const FETCH_TIMEOUT_MS = 15_000;
/** Images kept resident. Beyond this the least recently drawn are freed. */
const MAX_ENTRIES = 48;

function reasonFor(format: ImageFormat): string {
  if (format === "svg") return "vector images aren't supported";
  if (format === "unknown") return "not a recognised image";
  return "no PNG converter installed";
}

export class ImageStore {
  private entries = new Map<string, ImageEntry>();
  /** Ready entries by terminal-side id — the index the image plane reads. */
  private byId = new Map<number, { png: Uint8Array; px: PixelSize }>();
  /** Insertion/most-recent-touch order, for eviction. */
  private touched: string[] = [];
  private nextId: number;
  private changed: () => void = () => {};

  constructor(
    pid: number,
    private readonly env: Env = process.env as Env,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.nextId = idBase(pid);
  }

  /** Called when an entry reaches a terminal state, so the caller can redraw. */
  onChange(cb: () => void): void {
    this.changed = cb;
  }

  /**
   * The entry for `url`, starting a load if this is the first time it's asked
   * for. Never throws and never blocks — a caller mid-render gets `loading` and
   * a redraw later.
   */
  request(url: string): ImageEntry {
    const existing = this.entries.get(url);
    if (existing) {
      this.touch(url);
      return existing;
    }
    if (!isFetchableImageUrl(url)) {
      const entry: ImageEntry = { state: "failed", reason: "unsupported URL" };
      this.set(url, entry);
      return entry;
    }
    const entry: ImageEntry = { state: "loading" };
    this.set(url, entry);
    void this.load(url);
    return entry;
  }

  /**
   * The bytes and intrinsic size behind an id, for the layer that transmits
   * them. Keyed by id rather than URL because that layer reads its work off a
   * rendered frame, where the id is all a cell carries.
   */
  getById(id: number): { png: Uint8Array; px: PixelSize } | null {
    const entry = this.byId.get(id);
    return entry ? { png: entry.png, px: entry.px } : null;
  }

  private set(url: string, entry: ImageEntry): void {
    this.entries.set(url, entry);
    this.touch(url);
  }

  private touch(url: string): void {
    const at = this.touched.indexOf(url);
    if (at >= 0) this.touched.splice(at, 1);
    this.touched.push(url);
  }

  /**
   * Free the oldest entries past the cap. Returns ids to delete terminal-side.
   *
   * Only ever called from the load path, so an image that is on screen right
   * now can still be evicted if a burst of new ones arrives — the next frame
   * re-requests it, which costs a re-fetch but cannot corrupt anything.
   */
  private evict(): number[] {
    const freed: number[] = [];
    while (this.touched.length > MAX_ENTRIES) {
      const url = this.touched.shift()!;
      const entry = this.entries.get(url);
      if (entry?.state === "ready") {
        freed.push(entry.id);
        this.byId.delete(entry.id);
      }
      this.entries.delete(url);
    }
    return freed;
  }

  /** Ids freed by the most recent eviction, drained by the placement layer. */
  private pendingFrees: number[] = [];

  takeFreedIds(): number[] {
    if (this.pendingFrees.length === 0) return [];
    const out = this.pendingFrees;
    this.pendingFrees = [];
    return out;
  }

  private async load(url: string): Promise<void> {
    let entry: ImageEntry;
    try {
      entry = await this.fetchAndDecode(url);
    } catch (err) {
      entry = { state: "failed", reason: err instanceof Error ? err.message : "fetch failed" };
    }
    // Eviction may have dropped the placeholder while the fetch was in flight;
    // don't resurrect an entry nothing is asking for.
    if (!this.entries.has(url)) return;
    this.entries.set(url, entry);
    if (entry.state === "ready") this.byId.set(entry.id, { png: entry.png, px: entry.px });
    this.pendingFrees.push(...this.evict());
    this.changed();
  }

  private async fetchAndDecode(url: string): Promise<ImageEntry> {
    const resp = await this.fetchImpl(url, {
      headers: { Accept: "image/*", ...authHeadersFor(url, this.env) },
      redirect: "follow",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!resp.ok) return { state: "failed", reason: `HTTP ${resp.status}` };

    const declared = Number(resp.headers.get("content-length") ?? "0");
    if (declared > MAX_BYTES) return { state: "failed", reason: "image too large" };
    const raw = new Uint8Array(await resp.arrayBuffer());
    if (raw.length === 0) return { state: "failed", reason: "empty response" };
    if (raw.length > MAX_BYTES) return { state: "failed", reason: "image too large" };

    const format = sniffFormat(raw);
    if (format !== "png" && !isConvertible(format)) {
      return { state: "failed", reason: reasonFor(format) };
    }
    const converted = format === "png" ? raw : await toPng(raw, format);
    if (!converted) return { state: "failed", reason: reasonFor(format) };

    // Shrinking is best-effort in both directions: no converter, a failed run,
    // or a result whose header won't read all fall back to the bytes that
    // already work rather than losing an image that was fine.
    let png = converted;
    if (png.length > SHRINK_ABOVE_BYTES) {
      const smaller = await shrinkPng(png, SHRINK_LONGEST_EDGE);
      if (smaller && smaller.length > 0 && readPngSize(smaller)) png = smaller;
    }

    const px = readPngSize(png);
    if (!px) return { state: "failed", reason: "unreadable PNG" };

    return { state: "ready", id: this.nextId++, png, px };
  }
}
