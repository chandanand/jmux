// src/hunk/view.ts
//
// What the diff panel is showing, and the argv that produces it.
//
// jmux changes the panel's content by respawning hunk with different arguments
// rather than by calling `hunk session reload`. That looks like the cruder
// option and isn't: `--watch` stops firing once a reload retargets a live
// session, so a reloaded panel goes quietly stale while an agent keeps editing
// — and a diff panel that lies about the working tree is worse than one that
// blinks. Respawning also keeps one mechanism for every content change instead
// of one for session switches and another for view switches.
//
// Pure. The argv table is the whole point of the module, so it tests without
// spawning anything.

/** The changeset the panel is pointed at. */
export type HunkView =
  /** Uncommitted work, untracked files included — hunk's own default. */
  | { kind: "worktree" }
  /** Uncommitted work in tracked files only. */
  | { kind: "worktree-tracked" }
  /** What `git commit` would record right now. */
  | { kind: "staged" }
  /** A single commit. `ref` defaults to HEAD at the call site. */
  | { kind: "commit"; ref: string }
  /** Everything this branch adds since it forked — the whole of an agent's work. */
  | { kind: "branch"; base: string }
  /** An arbitrary two-point comparison, which is what a merge request is. */
  | { kind: "range"; from: string; to: string };

export const DEFAULT_VIEW: HunkView = { kind: "worktree" };

export interface SpawnOptions {
  /**
   * Auto-reload when the diff input changes. On by default and rarely worth
   * turning off: without it the panel is a snapshot from whenever it opened,
   * which is the staleness this integration exists to fix.
   */
  watch: boolean;
  /**
   * Let jmux's own background show through hunk's surfaces, so the panel reads
   * as part of the frame rather than a rectangle pasted onto it.
   */
  transparentBg: boolean;
}

/**
 * The long options a hunk binary lists in `hunk diff --help`.
 *
 * jmux supports whatever hunk the user has, and they do not all take the same
 * flags — hunk 0.9 has `--watch` but not `--transparent-bg`, and passing it one
 * makes it exit before drawing a frame. So jmux asks rather than assumes: every
 * optional flag below is gated on appearing in this set.
 *
 * An empty set is the safe answer for a binary that could not be probed. It
 * yields the bare command, which every hunk has always accepted.
 */
export function parseSupportedFlags(help: string): Set<string> {
  const flags = new Set<string>();
  for (const match of help.matchAll(/(--[a-z][a-z0-9-]*)/g)) flags.add(match[1]);
  return flags;
}

/**
 * The flag a view cannot be rendered without, or null when the bare `diff` /
 * `show` command is enough.
 *
 * This is the line between the two kinds of flag, and it decides what happens
 * when hunk is too old for one. A missing *presentation* flag costs polish, so
 * it is dropped silently. A missing *content* flag would change which
 * changeset you are looking at, so the view is refused instead — showing the
 * working tree to someone who asked for the staged diff is the failure this
 * whole module is built to avoid.
 */
export function viewRequiredFlag(view: HunkView): string | null {
  switch (view.kind) {
    case "worktree-tracked":
      return "--exclude-untracked";
    case "staged":
      return "--staged";
    default:
      return null;
  }
}

/**
 * A ref that is safe to pass as a positional argument.
 *
 * There is no shell here — argv goes straight to the process — so this is not
 * about injection. It is about a ref that begins with `-` being read by hunk's
 * own parser as a flag, which turns a bad branch name into a confusing error
 * about an unknown option. Refs are also rejected for whitespace, which no
 * valid git ref contains.
 */
export function isUsableRef(ref: string): boolean {
  if (ref.length === 0) return false;
  if (ref.startsWith("-")) return false;
  return !/\s/.test(ref);
}

/**
 * The argv for a view, or null when this hunk can't render it — either a ref it
 * depends on is unusable, or the binary lacks the flag the view is made of.
 *
 * Returning null rather than falling back to the working tree is deliberate:
 * silently showing different content than the user picked is the failure this
 * whole module is trying to avoid.
 *
 * `supported` is the flag set from `parseSupportedFlags`. Pass an empty set
 * when the binary could not be probed — that yields a bare command, which is
 * the one form every hunk accepts.
 */
export function spawnArgs(view: HunkView, opts: SpawnOptions, supported: Set<string>): string[] | null {
  const required = viewRequiredFlag(view);
  if (required !== null && !supported.has(required)) return null;

  const flags: string[] = [];
  if (opts.watch && supported.has("--watch")) flags.push("--watch");
  if (opts.transparentBg && supported.has("--transparent-bg")) flags.push("--transparent-bg");

  switch (view.kind) {
    case "worktree":
      return ["diff", ...flags];
    case "worktree-tracked":
      return ["diff", "--exclude-untracked", ...flags];
    case "staged":
      return ["diff", "--staged", ...flags];
    case "commit":
      return isUsableRef(view.ref) ? ["show", view.ref, ...flags] : null;
    case "branch":
      // Three-dot: what the branch added, ignoring anything that landed on the
      // base since the fork. Two-dot would fold the base's own progress into
      // the agent's diff and make an untouched branch look busy.
      return isUsableRef(view.base) ? ["diff", `${view.base}...HEAD`, ...flags] : null;
    case "range":
      return isUsableRef(view.from) && isUsableRef(view.to)
        ? ["diff", `${view.from}...${view.to}`, ...flags]
        : null;
  }
}

/** Short label for the tab strip and the view picker's current-selection mark. */
export function viewLabel(view: HunkView): string {
  switch (view.kind) {
    case "worktree":
      return "Working tree";
    case "worktree-tracked":
      return "Working tree (tracked)";
    case "staged":
      return "Staged";
    case "commit":
      return view.ref === "HEAD" ? "Last commit" : `Commit ${view.ref}`;
    case "branch":
      return `Branch vs ${view.base}`;
    case "range":
      return `${view.from}…${view.to}`;
  }
}

/** Whether two views point at the same content, for marking the picker. */
export function sameView(a: HunkView, b: HunkView): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "commit" && b.kind === "commit") return a.ref === b.ref;
  if (a.kind === "branch" && b.kind === "branch") return a.base === b.base;
  if (a.kind === "range" && b.kind === "range") return a.from === b.from && a.to === b.to;
  return true;
}
