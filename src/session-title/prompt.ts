/**
 * What we ask the model, what we accept back, and the key that decides whether
 * to ask at all.
 *
 * Pure — every fact arrives as an argument — so the whole decision table tests
 * without a subprocess, a tmux server or a clock.
 */

/**
 * The three things a session can be named from, strongest first.
 *
 * An issue is the most specific statement of intent available. The human's
 * first prompt is next. Branch-local commits are the floor, and deliberately
 * *not* "the last five commits": a fresh worktree has none of its own, and a
 * title generated from the base branch's history would name the session after
 * somebody else's work. No commits of its own means no git input at all.
 */
export type TitleInput =
  | { kind: "issues"; issues: Array<{ identifier: string; title: string; description?: string }> }
  | { kind: "prompt"; text: string }
  | { kind: "git"; repo: string; branch: string; commits: string[] };

/** Longer than this and we are paying to send a model a wall of text. */
const DESCRIPTION_MAX = 400;
const PROMPT_TEXT_MAX = 1200;

const INSTRUCTION =
  "Name this coding session. Reply with one line of at most eight words, " +
  "in plain sentence case, describing the work — no quotes, no punctuation " +
  "at the end, no preamble, no explanation.";

/**
 * The cache key for "have we already asked about this?".
 *
 * Sorted and lower-cased for the issue tier, so re-ordering a link or
 * re-spelling one is not a change — the same rule `issueLinkSignature` follows,
 * and for the same reason. Hashed for the text tiers because the value is
 * stored in a tmux option and read back on the next poll; whitespace in it
 * would break the round trip, which is what the whitespace test pins.
 */
export function titleSignature(input: TitleInput): string {
  switch (input.kind) {
    case "issues": {
      const ids = [...new Set(input.issues.map((i) => i.identifier.trim().toLowerCase()))]
        .filter(Boolean)
        .sort();
      return `i-${ids.join(".")}`;
    }
    case "prompt":
      return `p-${Bun.hash(input.text.trim()).toString(36)}`;
    case "git":
      return `g-${Bun.hash(`${input.branch}\n${input.commits.join("\n")}`).toString(36)}`;
  }
}

/** The prompt sent on the naming command's stdin. */
export function buildTitlePrompt(input: TitleInput): string {
  const body = (() => {
    switch (input.kind) {
      case "issues":
        return input.issues
          .map((i) => {
            const desc = i.description?.trim().slice(0, DESCRIPTION_MAX);
            return desc
              ? `${i.identifier}: ${i.title}\n${desc}`
              : `${i.identifier}: ${i.title}`;
          })
          .join("\n\n");
      case "prompt":
        return `The developer asked:\n${input.text.trim().slice(0, PROMPT_TEXT_MAX)}`;
      case "git":
        return [
          `Repository: ${input.repo}`,
          `Branch: ${input.branch}`,
          `Commits on this branch:`,
          ...input.commits.map((c) => `- ${c}`),
        ].join("\n");
    }
  })();
  return `${INSTRUCTION}\n\n${body}\n`;
}

/**
 * What we will accept as a title.
 *
 * Validated rather than trusted: a model asked for one line will sometimes
 * return three, or wrap the answer in quotes, or open with a markdown heading.
 * Anything left empty after cleaning is rejected and the caller keeps the real
 * session name — the same fallback as never having called, which is what keeps
 * this to one code path.
 */
export function parseTitle(raw: string, maxChars: number): string | null {
  const first = raw.split("\n").map((l) => l.trim()).find((l) => l.length > 0);
  if (!first) return null;

  let text = first
    .replace(/^#+\s*/, "")
    .replace(/^["'`"']+/, "")
    .replace(/["'`"']+$/, "")
    .replace(/[.\s]+$/, "")
    .trim();

  if (text.length === 0) return null;
  if (text.length > maxChars) {
    text = text.slice(0, Math.max(0, maxChars - 1)).trimEnd() + "…";
  }
  return text;
}
