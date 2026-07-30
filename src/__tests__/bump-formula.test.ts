import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { bumpFormula, formulaPlatforms, parseSums } from "../formula";

const SUMS = `
aaaa000000000000000000000000000000000000000000000000000000000001  jmux-0.26.0-darwin-arm64.tar.gz
aaaa000000000000000000000000000000000000000000000000000000000002  jmux-0.26.0-darwin-x64.tar.gz
aaaa000000000000000000000000000000000000000000000000000000000003  jmux-0.26.0-linux-x64.tar.gz
aaaa000000000000000000000000000000000000000000000000000000000004  jmux-0.26.0-linux-arm64.tar.gz
aaaa000000000000000000000000000000000000000000000000000000000006  jmux-0.26.0-linux-x64-baseline.tar.gz
aaaa000000000000000000000000000000000000000000000000000000000005  jmux-0.25.0-linux-x64.tar.gz
`;

const FORMULA = readFileSync(
  resolve(import.meta.dir, "..", "..", "packaging", "Formula", "jmux.rb"),
  "utf-8",
);

describe("parseSums", () => {
  test("maps platform to checksum for the requested version only", () => {
    const sums = parseSums(SUMS, "0.26.0");
    expect(sums.get("darwin-arm64")).toBe("aaaa000000000000000000000000000000000000000000000000000000000001");
    expect(sums.get("linux-arm64")).toBe("aaaa000000000000000000000000000000000000000000000000000000000004");
    expect(sums.size).toBe(5);
  });

  // A stale line from a previous release sitting in the same file must not be
  // picked up — that would publish a formula pointing at the old binary.
  test("ignores other versions", () => {
    expect(parseSums(SUMS, "0.26.0").get("linux-x64")).not.toBe(
      "aaaa000000000000000000000000000000000000000000000000000000000005",
    );
  });
});

describe("bumpFormula", () => {
  test("updates the version", () => {
    const out = bumpFormula(FORMULA, "0.26.0", parseSums(SUMS, "0.26.0"));
    expect(out).toContain('version "0.26.0"');
    expect(out).not.toContain('version "0.25.0"');
  });

  // The bug this design exists to prevent: a formula has four identical-looking
  // sha256 lines, and pairing one with the wrong architecture installs the
  // wrong binary while still passing Homebrew's integrity check.
  test("pairs each checksum with its own platform", () => {
    const sums = parseSums(SUMS, "0.26.0");
    const out = bumpFormula(FORMULA, "0.26.0", sums);

    // Driven by what the formula references, not by what the release shipped:
    // the release carries a baseline x64 build the formula deliberately does
    // not use.
    for (const platform of formulaPlatforms(out)) {
      expect(out).toContain(`sha256 "${sums.get(platform)}" # ${platform}`);
    }
    expect(formulaPlatforms(out).length).toBeGreaterThan(1);
  });

  // A release may ship more artifacts than the formula uses —
  // linux-x64-baseline exists for pre-AVX2 CPUs, which only the shell
  // installer can select. That must not be an error.
  test("ignores released artifacts the formula does not reference", () => {
    const sums = parseSums(SUMS, "0.26.0");
    sums.set("linux-x64-baseline", "d".repeat(64));
    expect(() => bumpFormula(FORMULA, "0.26.0", sums)).not.toThrow();
  });

  // The dangerous direction: a formula line left holding a placeholder.
  test("refuses when the formula references a platform the release lacks", () => {
    const partial = parseSums(SUMS, "0.26.0");
    partial.delete("darwin-arm64");
    expect(() => bumpFormula(FORMULA, "0.26.0", partial)).toThrow(
      /release has no checksum for it/,
    );
  });

  test("is idempotent", () => {
    const sums = parseSums(SUMS, "0.26.0");
    const once = bumpFormula(FORMULA, "0.26.0", sums);
    expect(bumpFormula(once, "0.26.0", sums)).toBe(once);
  });
});
