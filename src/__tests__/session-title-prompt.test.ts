import { describe, test, expect } from "bun:test";
import { displaySessionName, MANUAL_SIGNATURE } from "../session-title/display";
import { titleSignature, buildTitlePrompt, parseTitle } from "../session-title/prompt";
import type { TitleInput } from "../session-title/prompt";

describe("displaySessionName", () => {
  test("prefers the title when there is one", () => {
    expect(displaySessionName({ name: "tra-123", title: "Fix stale cache headers" }))
      .toBe("Fix stale cache headers");
  });

  test("falls back to the real name when the title is absent", () => {
    expect(displaySessionName({ name: "tra-123" })).toBe("tra-123");
  });

  test("falls back when the title is empty or whitespace", () => {
    expect(displaySessionName({ name: "tra-123", title: "" })).toBe("tra-123");
    expect(displaySessionName({ name: "tra-123", title: "   " })).toBe("tra-123");
  });

  test("trims a title that has surrounding whitespace", () => {
    expect(displaySessionName({ name: "tra-123", title: "  Fix cache  " }))
      .toBe("Fix cache");
  });

  test("the manual sentinel is not a plausible hash", () => {
    expect(MANUAL_SIGNATURE).toBe("manual");
  });
});

const issues = (...ids: string[]): TitleInput => ({
  kind: "issues",
  issues: ids.map((id) => ({ identifier: id, title: `Work on ${id}` })),
});

describe("titleSignature", () => {
  test("is stable across issue order and spelling", () => {
    expect(titleSignature(issues("TRA-1", "TRA-2")))
      .toBe(titleSignature(issues("tra-2", "TRA-1")));
  });

  test("changes when an issue joins the set", () => {
    expect(titleSignature(issues("TRA-1")))
      .not.toBe(titleSignature(issues("TRA-1", "TRA-2")));
  });

  test("distinguishes the three input kinds", () => {
    const a = titleSignature({ kind: "prompt", text: "add a cache header" });
    const b = titleSignature({ kind: "git", repo: "jmux", branch: "feat/x", commits: ["abc add a cache header"] });
    expect(a).not.toBe(b);
    expect(a).not.toBe(titleSignature(issues("TRA-1")));
  });

  test("a different prompt is a different signature", () => {
    expect(titleSignature({ kind: "prompt", text: "one" }))
      .not.toBe(titleSignature({ kind: "prompt", text: "two" }));
  });

  test("never contains whitespace, so it survives a tmux option round trip", () => {
    expect(titleSignature(issues("TRA-1"))).not.toMatch(/\s/);
    expect(titleSignature({ kind: "prompt", text: "a b\nc" })).not.toMatch(/\s/);
  });
});

describe("buildTitlePrompt", () => {
  test("names every issue in the set", () => {
    const p = buildTitlePrompt(issues("TRA-1", "TRA-2"));
    expect(p).toContain("TRA-1");
    expect(p).toContain("TRA-2");
  });

  test("truncates a long description rather than sending the whole thing", () => {
    const p = buildTitlePrompt({
      kind: "issues",
      issues: [{ identifier: "TRA-1", title: "t", description: "x".repeat(5000) }],
    });
    expect(p.length).toBeLessThan(2000);
  });

  test("asks for one short line and nothing else", () => {
    const p = buildTitlePrompt({ kind: "prompt", text: "add a cache header" });
    expect(p).toContain("add a cache header");
    expect(p.toLowerCase()).toContain("one line");
  });

  test("git input carries the branch and the commit subjects", () => {
    const p = buildTitlePrompt({
      kind: "git", repo: "jmux", branch: "feat/x", commits: ["fix the parser", "add a test"],
    });
    expect(p).toContain("feat/x");
    expect(p).toContain("fix the parser");
  });
});

describe("parseTitle", () => {
  test("takes the first non-empty line", () => {
    expect(parseTitle("\n\nFix stale cache headers\nand more\n", 48))
      .toBe("Fix stale cache headers");
  });

  test("strips quotes, backticks and a markdown heading", () => {
    expect(parseTitle('"Fix cache"', 48)).toBe("Fix cache");
    expect(parseTitle("`Fix cache`", 48)).toBe("Fix cache");
    expect(parseTitle("## Fix cache", 48)).toBe("Fix cache");
  });

  test("strips a trailing period", () => {
    expect(parseTitle("Fix the cache.", 48)).toBe("Fix the cache");
  });

  test("truncates to maxChars with an ellipsis", () => {
    const out = parseTitle("a".repeat(80), 10);
    expect(out).toBe("aaaaaaaaa…");
    expect(out!.length).toBe(10);
  });

  test("returns null for output with nothing usable in it", () => {
    expect(parseTitle("", 48)).toBeNull();
    expect(parseTitle("   \n\n  ", 48)).toBeNull();
    expect(parseTitle('""', 48)).toBeNull();
  });
});
