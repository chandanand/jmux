// Inline captured films into the site's scroll demo.
//
// Inlined rather than fetched, for the same reason the rest of the site is
// static: there is no second request that can be slower than the scroll that
// needs it. The films delta-encode against each other, so they gzip to a few KB
// — less than the single screenshot the section used to carry.
//
// This is the only consumer. A standalone prototype page lived beside it for a
// while and was deleted once the section shipped: it carried a second copy of
// the renderer, which is the drift this whole pipeline exists to remove.
//
// Usage: bun run scripts/build-scroll-demo.ts [--frames <dir>]

import { readFileSync, writeFileSync } from "fs";
import { join, resolve } from "path";

const argv = process.argv.slice(2);
const arg = (name: string, fallback: string): string => {
  const i = argv.indexOf(name);
  return resolve(i >= 0 ? argv[i + 1]! : fallback);
};

const framesDir = arg("--frames", "site/frames");

const manifest = JSON.parse(readFileSync(join(framesDir, "manifest.json"), "utf8")) as {
  cols: number;
  rows: number;
  beats: Array<{ id: string; file: string }>;
};

const frames: Record<string, unknown> = {};
for (const beat of manifest.beats) {
  frames[beat.id] = JSON.parse(readFileSync(join(framesDir, beat.file), "utf8"));
}

// `</script>` inside the payload ends the containing script element no matter
// that it is quoted — the HTML tokenizer runs before the JSON is ever parsed.
// Nothing in a terminal frame should contain one, but "should" is how a page
// breaks in a way nobody can read a stack trace for.
const json = JSON.stringify(frames).replace(/<\/script/gi, "<\\/script");

/**
 * Rewrite the body of the frames element, in place.
 *
 * Bounded by the element's own open and close tags rather than by a placeholder
 * comment. That buys two things. It is idempotent by construction — the output
 * is a valid input, so building twice is building once — and the element's
 * contents stay *valid JSON*, which a `/*__FRAMES__*\/` marker left around the
 * payload does not: `JSON.parse` rejects a leading comment, and the page then
 * silently renders nothing.
 *
 * Both targets keep their own markup — the live site owns its section's copy
 * and layout, the template owns the prototype's — and this only ever swaps the
 * data, so re-capturing cannot touch a word anybody wrote.
 */
const OPEN = '<script id="sd-frames" type="application/json">';
const CLOSE = "</script>";

function inject(file: string, payload: string, label: string): void {
  const html = readFileSync(file, "utf8");
  const start = html.indexOf(OPEN);
  if (start < 0) {
    console.error(`${file} has no ${OPEN} element — nothing injected`);
    process.exit(1);
  }
  const from = start + OPEN.length;
  const end = html.indexOf(CLOSE, from);
  if (end < 0) {
    console.error(`${file}: ${OPEN} is never closed`);
    process.exit(1);
  }

  const out = html.slice(0, from) + payload + html.slice(end);
  writeFileSync(file, out);

  console.log(
    `${label.padEnd(28)} ${(Buffer.byteLength(out) / 1024).toFixed(1).padStart(6)} KB  ` +
      `(${(Bun.gzipSync(out).length / 1024).toFixed(1)} KB gzipped)`,
  );
}

inject(resolve("site/index.html"), json, "site/index.html");
console.log(`${manifest.beats.length} films`);
