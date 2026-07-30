/**
 * Homebrew formula rewriting.
 *
 * Pure transforms, so the checksum-pairing rule below is unit-testable without
 * a tap, a release, or a network. `scripts/bump-formula.ts` is the thin CLI
 * that release.sh calls.
 */

/** `<sha>  jmux-<version>-<platform>.tar.gz` → platform → sha */
export function parseSums(text: string, version: string): Map<string, string> {
  const sums = new Map<string, string>();
  for (const line of text.split("\n")) {
    const match = line.trim().match(/^([0-9a-f]{64})\s+jmux-(.+?)-(.+)\.tar\.gz$/);
    if (!match) continue;
    const [, sha, ver, platform] = match;
    if (ver === version) sums.set(platform!, sha!);
  }
  return sums;
}

/**
 * Replace the version and every checksum.
 *
 * Each `sha256` line is tagged with the platform it belongs to in a trailing
 * comment, and matching is done on that tag. A formula has several
 * identical-looking sha256 lines, so positional replacement would silently
 * pair a checksum with the wrong architecture — producing a formula that
 * installs the wrong binary and still passes Homebrew's integrity check.
 *
 * A platform with no tagged line is an error rather than a no-op: quietly
 * skipping it would ship a formula with a placeholder checksum.
 */
export function bumpFormula(source: string, version: string, sums: Map<string, string>): string {
  let out = source.replace(/^(\s*version\s+")[^"]+(")/m, `$1${version}$2`);

  for (const [platform, sha] of sums) {
    const pattern = new RegExp(`(sha256\\s+")[0-9a-f]{64}("\\s*#\\s*${platform}\\b)`, "g");

    // Test for the tag rather than comparing before/after text: re-bumping a
    // formula that is already at this version rewrites each line to exactly
    // what it already said, and a string comparison reads that as "no match".
    if (!pattern.test(out)) {
      throw new Error(
        `no sha256 line tagged "# ${platform}" in the formula — refusing to guess which one it is`,
      );
    }
    pattern.lastIndex = 0;
    out = out.replace(pattern, `$1${sha}$2`);
  }

  return out;
}
