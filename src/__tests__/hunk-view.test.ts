import { describe, test, expect } from "bun:test";
import {
  isUsableRef,
  parseSupportedFlags,
  sameView,
  spawnArgs,
  viewLabel,
  viewRequiredFlag,
  type HunkView,
} from "../hunk/view";

// Every flag jmux knows about. Real hunk help text is exercised separately
// below, against the two versions that differ in the way that matters.
const ALL = new Set(["--watch", "--transparent-bg", "--staged", "--exclude-untracked"]);

const OPTS = { watch: true, transparentBg: true };
const BARE = { watch: false, transparentBg: false };

describe("spawnArgs", () => {
  test("working tree is hunk's own default, untracked files included", () => {
    expect(spawnArgs({ kind: "worktree" }, BARE, ALL)).toEqual(["diff"]);
  });

  test("tracked-only working tree", () => {
    expect(spawnArgs({ kind: "worktree-tracked" }, BARE, ALL)).toEqual(["diff", "--exclude-untracked"]);
  });

  test("staged", () => {
    expect(spawnArgs({ kind: "staged" }, BARE, ALL)).toEqual(["diff", "--staged"]);
  });

  test("a commit", () => {
    expect(spawnArgs({ kind: "commit", ref: "HEAD" }, BARE, ALL)).toEqual(["show", "HEAD"]);
    expect(spawnArgs({ kind: "commit", ref: "06835d6" }, BARE, ALL)).toEqual(["show", "06835d6"]);
  });

  // Two-dot would fold the base branch's own progress into the diff and make a
  // branch nobody has touched look busy.
  test("branch-vs-base uses three-dot so only the branch's own work shows", () => {
    expect(spawnArgs({ kind: "branch", base: "main" }, BARE, ALL)).toEqual(["diff", "main...HEAD"]);
  });

  test("a merge request's two endpoints", () => {
    expect(spawnArgs({ kind: "range", from: "main", to: "feat/x" }, BARE, ALL)).toEqual(["diff", "main...feat/x"]);
  });

  test("flags come after the target, once each", () => {
    expect(spawnArgs({ kind: "worktree" }, OPTS, ALL)).toEqual(["diff", "--watch", "--transparent-bg"]);
    expect(spawnArgs({ kind: "commit", ref: "HEAD" }, OPTS, ALL)).toEqual([
      "show", "HEAD", "--watch", "--transparent-bg",
    ]);
  });

  test("each flag is independently switchable", () => {
    expect(spawnArgs({ kind: "staged" }, { watch: true, transparentBg: false }, ALL)).toEqual([
      "diff", "--staged", "--watch",
    ]);
    expect(spawnArgs({ kind: "staged" }, { watch: false, transparentBg: true }, ALL)).toEqual([
      "diff", "--staged", "--transparent-bg",
    ]);
  });

  // Falling back to the working tree would show the user content they did not
  // ask for, which is the exact failure this module exists to prevent.
  test("an unusable ref returns null rather than quietly showing something else", () => {
    expect(spawnArgs({ kind: "commit", ref: "--version" }, BARE, ALL)).toBeNull();
    expect(spawnArgs({ kind: "branch", base: "" }, BARE, ALL)).toBeNull();
    expect(spawnArgs({ kind: "range", from: "main", to: "has space" }, BARE, ALL)).toBeNull();
    expect(spawnArgs({ kind: "range", from: "-rf", to: "main" }, BARE, ALL)).toBeNull();
  });
});

describe("isUsableRef", () => {
  test("accepts the ref shapes git actually produces", () => {
    for (const ref of ["main", "HEAD", "HEAD~1", "origin/main", "feat/work-pipeline", "06835d6", "v1.2.3"]) {
      expect(isUsableRef(ref)).toBe(true);
    }
  });

  // Not an injection guard — there is no shell — but a leading dash turns a bad
  // branch name into an error about an unknown option.
  test("rejects anything hunk's parser would read as a flag", () => {
    expect(isUsableRef("-x")).toBe(false);
    expect(isUsableRef("--watch")).toBe(false);
  });

  test("rejects empty and whitespace-bearing refs", () => {
    expect(isUsableRef("")).toBe(false);
    expect(isUsableRef("two words")).toBe(false);
    expect(isUsableRef("with\nnewline")).toBe(false);
  });
});

describe("viewLabel", () => {
  test("names each view", () => {
    expect(viewLabel({ kind: "worktree" })).toBe("Working tree");
    expect(viewLabel({ kind: "worktree-tracked" })).toBe("Working tree (tracked)");
    expect(viewLabel({ kind: "staged" })).toBe("Staged");
    expect(viewLabel({ kind: "branch", base: "main" })).toBe("Branch vs main");
    expect(viewLabel({ kind: "range", from: "main", to: "feat/x" })).toBe("main…feat/x");
  });

  test("HEAD reads as the last commit rather than a ref", () => {
    expect(viewLabel({ kind: "commit", ref: "HEAD" })).toBe("Last commit");
    expect(viewLabel({ kind: "commit", ref: "abc1234" })).toBe("Commit abc1234");
  });
});

describe("sameView", () => {
  test("same kind and same parameters", () => {
    expect(sameView({ kind: "worktree" }, { kind: "worktree" })).toBe(true);
    expect(sameView({ kind: "branch", base: "main" }, { kind: "branch", base: "main" })).toBe(true);
  });

  test("same kind, different target is a different view", () => {
    expect(sameView({ kind: "branch", base: "main" }, { kind: "branch", base: "develop" })).toBe(false);
    expect(sameView({ kind: "commit", ref: "HEAD" }, { kind: "commit", ref: "HEAD~1" })).toBe(false);
    const a: HunkView = { kind: "range", from: "main", to: "x" };
    expect(sameView(a, { kind: "range", from: "main", to: "y" })).toBe(false);
  });

  test("the two working-tree views are not interchangeable", () => {
    expect(sameView({ kind: "worktree" }, { kind: "worktree-tracked" })).toBe(false);
  });
});

// The bug this whole mechanism exists for: jmux passed --transparent-bg to a
// hunk that has never had it, hunk exited with "unknown option" before drawing
// a frame, and the panel showed nothing but its own "Diff viewer closed" state.
describe("flags a given hunk actually accepts", () => {
  // Verbatim from `hunk diff --help` on each version.
  const HUNK_017 = `Usage: diff [options] [targets...]
  --mode <mode>           layout mode: auto, split, stack
  --theme <theme>         named theme override
  --line-numbers          show line numbers
  --transparent-bg        let terminal background show through Hunk surfaces
  --no-transparent-bg     paint Hunk surfaces with the active theme
  --watch                 auto-reload when the current diff input changes
  --staged                show staged changes instead of the working tree
  --exclude-untracked     exclude untracked files from working tree reviews`;

  const HUNK_09 = `Usage: diff [options] [targets...]
  --mode <mode>           layout mode: auto, split, stack
  --theme <theme>         named theme override
  --line-numbers          show line numbers
  --watch                 auto-reload when the current diff input changes
  --staged                show staged changes instead of the working tree
  --exclude-untracked     exclude untracked files from working tree reviews`;

  const newer = parseSupportedFlags(HUNK_017);
  const older = parseSupportedFlags(HUNK_09);

  test("reads the long options out of help text", () => {
    expect(newer.has("--transparent-bg")).toBe(true);
    expect(newer.has("--watch")).toBe(true);
    expect(older.has("--watch")).toBe(true);
  });

  test("the flag that differs between the two is seen as differing", () => {
    expect(older.has("--transparent-bg")).toBe(false);
  });

  test("an older hunk is launched without the flag that would kill it", () => {
    expect(spawnArgs({ kind: "worktree" }, OPTS, older)).toEqual(["diff", "--watch"]);
    expect(spawnArgs({ kind: "worktree" }, OPTS, newer)).toEqual(["diff", "--watch", "--transparent-bg"]);
  });

  // A binary that couldn't be probed gets the one form every hunk has taken.
  test("an unprobeable binary gets the bare command", () => {
    expect(spawnArgs({ kind: "worktree" }, OPTS, new Set())).toEqual(["diff"]);
    expect(parseSupportedFlags("")).toEqual(new Set());
  });

  // Presentation degrades silently; content must not. Showing the working tree
  // to someone who asked for the staged diff is the failure being avoided.
  test("a view whose content flag is missing is refused, not substituted", () => {
    expect(spawnArgs({ kind: "staged" }, OPTS, new Set(["--watch"]))).toBeNull();
    expect(spawnArgs({ kind: "worktree-tracked" }, OPTS, new Set(["--watch"]))).toBeNull();
    expect(spawnArgs({ kind: "worktree" }, OPTS, new Set(["--watch"]))).toEqual(["diff", "--watch"]);
  });

  test("viewRequiredFlag names only the views built out of a flag", () => {
    expect(viewRequiredFlag({ kind: "staged" })).toBe("--staged");
    expect(viewRequiredFlag({ kind: "worktree-tracked" })).toBe("--exclude-untracked");
    expect(viewRequiredFlag({ kind: "worktree" })).toBeNull();
    expect(viewRequiredFlag({ kind: "commit", ref: "HEAD" })).toBeNull();
    expect(viewRequiredFlag({ kind: "branch", base: "main" })).toBeNull();
  });
});
