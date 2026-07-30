import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { bumpFormula, parseSums } from "../formula";

const SUMS = `
aaaa000000000000000000000000000000000000000000000000000000000001  jmux-0.26.0-darwin-arm64.tar.gz
aaaa000000000000000000000000000000000000000000000000000000000002  jmux-0.26.0-darwin-x64.tar.gz
aaaa000000000000000000000000000000000000000000000000000000000003  jmux-0.26.0-linux-x64.tar.gz
aaaa000000000000000000000000000000000000000000000000000000000004  jmux-0.26.0-linux-arm64.tar.gz
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
    expect(sums.size).toBe(4);
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
    const out = bumpFormula(FORMULA, "0.26.0", parseSums(SUMS, "0.26.0"));

    for (const [platform, sha] of parseSums(SUMS, "0.26.0")) {
      expect(out).toContain(`sha256 "${sha}" # ${platform}`);
    }
  });

  test("leaves placeholders it was given no checksum for", () => {
    const partial = new Map([["darwin-arm64", "b".repeat(64)]]);
    const out = bumpFormula(FORMULA, "0.26.0", partial);
    expect(out).toContain(`sha256 "${"b".repeat(64)}" # darwin-arm64`);
    expect(out).toContain('sha256 "0000000000000000000000000000000000000000000000000000000000000000" # linux-x64');
  });

  // Silence here would mean shipping a formula with a placeholder checksum.
  test("refuses to guess when a platform tag is missing", () => {
    expect(() => bumpFormula(FORMULA, "0.26.0", new Map([["solaris-sparc", "c".repeat(64)]]))).toThrow(
      /no sha256 line tagged/,
    );
  });

  test("is idempotent", () => {
    const sums = parseSums(SUMS, "0.26.0");
    const once = bumpFormula(FORMULA, "0.26.0", sums);
    expect(bumpFormula(once, "0.26.0", sums)).toBe(once);
  });
});
