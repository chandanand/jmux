/**
 * Point a Homebrew formula at a new release.
 *
 * Called by release.sh as its final step, with the SHA256SUMS it just
 * generated — so the checksums written into the formula are the ones from the
 * artifacts actually uploaded, not re-derived from a second download.
 *
 * Usage: bun run scripts/bump-formula.ts <formula.rb> <version> <SHA256SUMS>
 */

import { readFileSync, writeFileSync } from "node:fs";
import { bumpFormula, parseSums } from "../src/formula";

const [formulaPath, version, sumsPath] = process.argv.slice(2);

if (!formulaPath || !version || !sumsPath) {
  console.error("usage: bump-formula.ts <formula.rb> <version> <SHA256SUMS>");
  process.exit(1);
}

const sums = parseSums(readFileSync(sumsPath, "utf-8"), version);
if (sums.size === 0) {
  console.error(`no checksums for version ${version} in ${sumsPath}`);
  process.exit(1);
}

writeFileSync(formulaPath, bumpFormula(readFileSync(formulaPath, "utf-8"), version, sums));
console.log(`formula bumped to ${version} (${sums.size} platforms)`);
