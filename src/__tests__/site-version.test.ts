import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import pkg from "../../package.json" with { type: "json" };

// The landing page prints a version badge, and it is hand-written HTML — so it
// drifts the moment a release bumps package.json and nobody remembers the site.
// A stale badge is the kind of wrong that erodes trust in everything around it:
// a visitor comparing it against the npm page sees a project that lost track of
// its own release.
describe("site version badge", () => {
  const html = readFileSync(resolve(import.meta.dir, "..", "..", "site", "index.html"), "utf-8");

  test("matches package.json", () => {
    const badge = html.match(/<span class="v">v([^<]+)<\/span>/);
    expect(badge?.[1]).toBe(pkg.version);
  });

  test("there is exactly one badge to keep in step", () => {
    expect(html.match(/<span class="v">/g)?.length).toBe(1);
  });
});
