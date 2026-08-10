import { describe, test, expect } from "bun:test";
import { displaySessionName, MANUAL_SIGNATURE } from "../session-title/display";
import { titleSignature, buildTitlePrompt, parseTitle, promptTextFromHook } from "../session-title/prompt";
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
  const BUDGET = 32;

  test("names every issue in the set", () => {
    const p = buildTitlePrompt(issues("TRA-1", "TRA-2"), BUDGET);
    expect(p).toContain("TRA-1");
    expect(p).toContain("TRA-2");
  });

  test("truncates a long description rather than sending the whole thing", () => {
    const p = buildTitlePrompt({
      kind: "issues",
      issues: [{ identifier: "TRA-1", title: "t", description: "x".repeat(5000) }],
    }, BUDGET);
    expect(p.length).toBeLessThan(2000);
  });

  test("asks for one short line and nothing else", () => {
    const p = buildTitlePrompt({ kind: "prompt", text: "add a cache header" }, BUDGET);
    expect(p).toContain("add a cache header");
    expect(p.toLowerCase()).toContain("one line");
  });

  test("git input carries the branch and the commit subjects", () => {
    const p = buildTitlePrompt({
      kind: "git", repo: "jmux", branch: "feat/x", commits: ["fix the parser", "add a test"],
    }, BUDGET);
    expect(p).toContain("feat/x");
    expect(p).toContain("fix the parser");
  });

  // The budget we ask for and the budget we enforce are the same number, so a
  // model that obeys never produces a title `parseTitle` then has to cut. Two
  // numbers here would drift, and the visible symptom would be every title
  // ending in an ellipsis.
  test("states the character budget it was given", () => {
    expect(buildTitlePrompt(issues("TRA-1"), 32)).toContain("32 characters");
    expect(buildTitlePrompt(issues("TRA-1"), 48)).toContain("48 characters");
  });

  test("says why short matters, so the model has the reason and not just the rule", () => {
    const p = buildTitlePrompt(issues("TRA-1"), BUDGET).toLowerCase();
    expect(p).toContain("sidebar");
  });

  // Measured, not guessed. A character budget alone overshot on 4 of 6 samples
  // (37/39/33/35 against 32) because a model counts words far better than it
  // counts characters, so the budget is also stated in words — scaled from the
  // same number, or the two rules fight and the model satisfies the wrong one.
  test("states a word count scaled to the character budget", () => {
    expect(buildTitlePrompt(issues("TRA-1"), 32)).toContain("3 or 4 words");
    expect(buildTitlePrompt(issues("TRA-1"), 60)).toContain("6 or 7 words");
  });

  // Asking the model to reason first improves the answer and, left unqualified,
  // makes it print the reasoning: one sample in six came back as a 274-char
  // think-aloud. `parseTitle` takes the *first* non-empty line, so that lands a
  // paragraph of working in the sidebar rather than a name.
  test("asks for the reasoning to stay unprinted", () => {
    const p = buildTitlePrompt(issues("TRA-1"), BUDGET).toLowerCase();
    expect(p).toContain("silently");
    expect(p).toContain("do not show");
  });

  // The row already carries the identifier one line below the title, so a title
  // that repeats it spends a third of the budget saying nothing new.
  test("forbids repeating what the row already shows", () => {
    const p = buildTitlePrompt(issues("TRA-1"), BUDGET).toLowerCase();
    expect(p).toContain("identifier");
  });
});

describe("promptTextFromHook", () => {
  const doc = (fields: Record<string, unknown>) => JSON.stringify(fields);

  test("takes the prompt field out of the hook document", () => {
    expect(
      promptTextFromHook(
        doc({
          session_id: "abc",
          transcript_path: "/home/someone/.claude/projects/x/abc.jsonl",
          cwd: "/home/someone/code/jmux",
          hook_event_name: "UserPromptSubmit",
          prompt: "add a cache header",
        }),
      ),
    ).toBe("add a cache header");
  });

  test("survives a prompt containing quotes and newlines", () => {
    expect(promptTextFromHook(doc({ prompt: 'make it say "done"\nthen stop' })))
      .toBe('make it say "done"\nthen stop');
  });

  test("returns null for a document truncated mid-write", () => {
    const full = doc({ prompt: "x".repeat(500) });
    expect(promptTextFromHook(full.slice(0, 200))).toBeNull();
  });

  test("returns null when there is no prompt to take", () => {
    expect(promptTextFromHook(doc({ hook_event_name: "UserPromptSubmit" }))).toBeNull();
    expect(promptTextFromHook(doc({ prompt: "   " }))).toBeNull();
    expect(promptTextFromHook(doc({ prompt: 42 }))).toBeNull();
    expect(promptTextFromHook("not json at all")).toBeNull();
    expect(promptTextFromHook("")).toBeNull();
    expect(promptTextFromHook("null")).toBeNull();
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

  // The naming command is an arbitrary user-configured subprocess and its
  // stdout is not trusted. Anything that survives here is written into a
  // CellGrid cell and emitted to the real terminal verbatim; `cellWidth`
  // scores ESC as one column, so one leaked escape desynchronises the frame's
  // column model from the terminal's cursor for the rest of the frame. US
  // (\x1f) is worse: it is the SESSION_LIST_FORMAT field separator, so a
  // title carrying one shifts @jmux-title-signature out of its column.
  test("strips SGR colour a command wrapped its answer in", () => {
    expect(parseTitle("\x1b[1;32mFix stale cache headers\x1b[0m\n", 48))
      .toBe("Fix stale cache headers");
  });

  test("strips a leading escape-only line rather than taking it as the answer", () => {
    expect(parseTitle("\x1b[2K\x1b[G\nFix cache\n", 48)).toBe("Fix cache");
  });

  test("strips an OSC title-setting sequence", () => {
    expect(parseTitle("\x1b]0;some window title\x07Fix cache", 48)).toBe("Fix cache");
  });

  test("deletes a bare US, which would otherwise shift the session-list fields", () => {
    const out = parseTitle("Fix cache\x1fmanual", 48);
    expect(out).toBe("Fix cachemanual");
    expect(out).not.toContain("\x1f");
  });

  test("no control character survives, whatever the shape", () => {
    const out = parseTitle("\x1b[1mFi\x07x\x1b ca\x00che\x1b[0m\x0d", 48)!;
    expect(out).toBeTruthy();
    expect(/[\x00-\x1f\x7f]/.test(out)).toBe(false);
  });

  test("returns null when the output is nothing but control characters", () => {
    expect(parseTitle("\x1b[31m\x1b[0m\n", 48)).toBeNull();
    expect(parseTitle("\x00\x07\x1f\x7f", 48)).toBeNull();
    expect(parseTitle("\x1b[2J\x1b[H", 48)).toBeNull();
  });

  test("collapses the whitespace runs a stripped sequence leaves behind", () => {
    expect(parseTitle("Fix   \t  stale\x1b[0m  cache", 48)).toBe("Fix stale cache");
  });

  test("a CR is a line break, not a character to delete", () => {
    expect(parseTitle("Fix cache\r\nand more", 48)).toBe("Fix cache");
    expect(parseTitle("first\rsecond", 48)).toBe("first");
  });

  test("strips curly/typographic quotes", () => {
    // U+201C LEFT DOUBLE QUOTATION MARK, U+201D RIGHT DOUBLE QUOTATION MARK
    expect(parseTitle("\u201cFix cache\u201d", 48)).toBe("Fix cache");
    // U+2018 LEFT SINGLE QUOTATION MARK, U+2019 RIGHT SINGLE QUOTATION MARK
    expect(parseTitle("\u2018Fix cache\u2019", 48)).toBe("Fix cache");
  });
});
