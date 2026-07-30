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
/** Every platform the formula has a tagged `sha256` line for. */
export function formulaPlatforms(source: string): string[] {
  return [...source.matchAll(/sha256\s+"[0-9a-f]{64}"\s*#\s*(\S+)/g)].map((m) => m[1]!);
}

export function bumpFormula(source: string, version: string, sums: Map<string, string>): string {
  let out = source.replace(/^(\s*version\s+")[^"]+(")/m, `$1${version}$2`);

  // Driven by the formula, not by the release. A release may legitimately ship
  // artifacts the formula does not reference — `linux-x64-baseline` exists for
  // pre-AVX2 CPUs, which the shell installer selects per-CPU and Homebrew
  // cannot branch on. The dangerous direction is the other one: a formula line
  // left holding a placeholder checksum.
  for (const platform of formulaPlatforms(out)) {
    const sha = sums.get(platform);
    if (!sha) {
      throw new Error(
        `formula references "# ${platform}" but the release has no checksum for it`,
      );
    }
    const pattern = new RegExp(`(sha256\\s+")[0-9a-f]{64}("\\s*#\\s*${platform}\\b)`, "g");
    out = out.replace(pattern, `$1${sha}$2`);
  }

  return out;
}
