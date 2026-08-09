// The one implementation of "which tmux session belongs to this issue".
//
// This used to exist twice, and the two copies disagreed. The TUI derived a
// session name from the repo's `sessionNameTemplate` and put the worktree at
// `<repoDir>/<session>`; `ctl issue start` derived `<id>-<title-slug>` and put
// the worktree in a `-worktrees` sibling directory. They also kept their links
// in different stores — the TUI in `state.json`, the CLI in the
// `@jmux-linear-issue` tmux option — and neither read the other's. The result
// was that a session an agent started was invisible to the human's sidebar,
// which still offered to start the same work again.
//
// So there is one rule here and both callers use it. Kept pure — every fact
// (config, live sessions, the filesystem) arrives as an argument — so the whole
// decision table unit-tests without tmux, a tracker or a disk.

import { sanitizeTmuxSessionName } from "./config";
import type { Issue, IssueStateType } from "./adapters/types";

export type IssueSessionState = "none" | "worktree" | "session";

/**
 * Workflow position, least advanced first. This is the tracker-agnostic
 * ordering `IssueStateType` already encodes — it exists precisely because
 * status *names* vary per workspace and cannot be ordered.
 */
const STATE_TYPE_RANK: Record<IssueStateType, number> = {
  triage: 0,
  backlog: 1,
  unstarted: 2,
  started: 3,
  completed: 4,
  canceled: 5,
  duplicate: 6,
};

const FINISHED: ReadonlySet<IssueStateType> = new Set(["completed", "canceled", "duplicate"]);

/**
 * Whether the tracker considers this issue done with, in any of the three ways
 * it can be — including `duplicate`, which never appears in a default Linear
 * workflow and is therefore the one everybody forgets.
 *
 * Exported so "finished" has one definition. It had two: {@link drivingIssue}
 * counted all three, while the MR fan-out spelled out `completed`/`canceled`
 * inline — so an issue closed as a duplicate was still moved when the merge
 * request landed, which is precisely the write that filter exists to prevent.
 *
 * An issue with no `stateType` is *not* finished: an adapter that cannot say is
 * not evidence that the work is done.
 */
export function isIssueFinished(issue: Pick<Issue, "stateType">): boolean {
  return issue.stateType !== undefined && FINISHED.has(issue.stateType);
}

/**
 * The issue that represents a session carrying several of them.
 *
 * A session is one row, one stage band and one branch, so N linked issues have
 * to collapse to one answer, and the answer must be a rule rather than an
 * accident. It used to be `issues[0]` — insertion order — which meant the
 * session's stage followed whichever issue happened to be linked first and a
 * finished ticket could hold a session in the Done band while four open ones
 * sat under it.
 *
 * The rule is the *least advanced unfinished* issue: what a session still has
 * to do is what it is doing. It leaves a stage band only when its last ticket
 * does, and when everything is finished it settles on the most complete
 * outcome rather than a cancellation.
 *
 * Precedence, and the middle tier is the load-bearing one:
 *   1. unfinished with a known `stateType` — least advanced wins
 *   2. unknown `stateType` — plausibly unfinished, so it outranks a known
 *      finished issue, but never displaces a known unfinished one. A guess must
 *      not displace a fact.
 *   3. all finished — least advanced again, so `completed` beats `canceled`
 *
 * Ties break on array order throughout, which is what makes an adapter that
 * populates no `stateType` at all behave exactly as `issues[0]` did.
 */
export function drivingIssue<T extends Pick<Issue, "stateType">>(
  issues: readonly T[],
): T | undefined {
  let unfinished: T | undefined;
  let unfinishedRank = Infinity;
  let unknown: T | undefined;
  let finished: T | undefined;
  let finishedRank = Infinity;

  for (const issue of issues) {
    const type = issue.stateType;
    if (type === undefined) {
      unknown ??= issue;
      continue;
    }
    const rank = STATE_TYPE_RANK[type];
    if (FINISHED.has(type)) {
      if (rank < finishedRank) {
        finishedRank = rank;
        finished = issue;
      }
    } else if (rank < unfinishedRank) {
      unfinishedRank = rank;
      unfinished = issue;
    }
  }

  return unfinished ?? unknown ?? finished;
}

export interface IssueSessionInfo {
  state: IssueSessionState;
  /** tmux session name; for "worktree", the name a session would take. */
  sessionName: string;
}

/**
 * Normalise a link key.
 *
 * The two link stores key on different things: `state.json` holds the tracker's
 * own id (a UUID), the tmux option holds whatever identifier a human typed at
 * `ctl issue link` (`TRA-123`, or `tra-123`). Callers index their map through
 * this and {@link resolveIssueSession} looks up both forms, so neither store has
 * to adopt the other's key.
 */
export function linkKey(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * The tmux session option `jmux ctl` keeps its issue links in.
 *
 * It holds a *list*, space-separated, because a session can carry several
 * issues — a feature that arrives as five tickets is one branch and one MR.
 * The name is unchanged from when it held exactly one, and the single-issue
 * case is just a one-element list, so there is no second encoding to read.
 *
 * Space is safe as the separator only because {@link isWritableLinkId} refuses
 * whitespace at the write. Validating there rather than guessing at the read is
 * what keeps a malformed value from silently becoming two links.
 */
export const ISSUE_LINK_OPTION = "@jmux-linear-issue";

/** Whether an id can be stored in {@link ISSUE_LINK_OPTION} without ambiguity. */
export function isWritableLinkId(raw: string): boolean {
  return raw.trim().length > 0 && !/\s/.test(raw.trim());
}

/**
 * Read the option into ids, deduped through {@link linkKey}. The first spelling
 * of a repeated id wins, so the tracker's own casing survives a caller who
 * typed something else.
 */
export function parseIssueLinkOption(raw: string | undefined): string[] {
  if (!raw) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of raw.trim().split(/\s+/)) {
    const key = linkKey(part);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(part);
  }
  return out;
}

/** Render ids back into the option's wire form. */
export function formatIssueLinkOption(ids: readonly string[]): string {
  return ids.join(" ");
}

/**
 * Every issue a session is linked to, across both stores.
 *
 * The two stores hold different *kinds* of id — `state.json` the tracker's own
 * (a UUID), {@link ISSUE_LINK_OPTION} whatever a human typed at `ctl issue link`
 * (`TRA-123`) — and for a long time only `resolveIssueSession` looked at both.
 * Every other consumer read one, which made an agent-linked issue a half
 * citizen: it suppressed the ghost row and then had no sidebar badge, no stage
 * band, no linked dot and no MR transition, because those all read a context
 * built from `state.json` alone.
 *
 * Deduped through {@link linkKey}, `state.json` first so the tracker's own id
 * wins when both stores name the same issue in different spellings. Callers feed
 * the result to a lookup that accepts either shape.
 */
export function mergeIssueLinkIds(
  stateIds: readonly string[],
  optionIds: readonly string[],
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of [...stateIds, ...optionIds]) {
    const key = linkKey(id);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(id);
  }
  return out;
}

/**
 * Whether a stored link id refers to this issue.
 *
 * Both of the issue's names are tried because the stores key on different
 * things: `state.json` on the tracker's id, {@link ISSUE_LINK_OPTION} on
 * whatever identifier was typed at `ctl issue link`. Testing only the id leaves
 * a `TRA-123` link untouched, and the issue reappears on the next poll — an
 * unlink that reports success and does nothing.
 */
export function isIssueLinkFor(
  storedId: string,
  issue: Pick<Issue, "id" | "identifier">,
): boolean {
  const key = linkKey(storedId);
  return key !== "" && (key === linkKey(issue.id) || key === linkKey(issue.identifier));
}

/** The ids in `stored` that do not refer to `issue`, order preserved. */
export function withoutIssueLink(
  stored: readonly string[],
  issue: Pick<Issue, "id" | "identifier">,
): string[] {
  return stored.filter((id) => !isIssueLinkFor(id, issue));
}

/**
 * A stable signature of a session's link set, for "have the links changed since
 * we resolved this context?".
 *
 * Neither the active poll nor the background sweep re-reads the link *set* —
 * both refresh the issues already in a context, by id. So a link added by
 * `ctl issue link` (which has no IPC to the running TUI, and so cannot use the
 * optimistic mutators the TUI's own key does) would otherwise never appear at
 * all, however many times we polled.
 *
 * Sorted, so re-ordering a link is not a change; keyed, so re-spelling one is
 * not either.
 */
export function issueLinkSignature(ids: readonly string[]): string {
  return [...new Set(ids.map(linkKey))].filter(Boolean).sort().join(" ");
}

/** Longer than this and the branch name stops being readable in a tab strip. */
const TITLE_SLUG_MAX = 40;

/**
 * Turn arbitrary human text into something usable as a branch, a directory and
 * a tmux session all at once — the one-name rule means it has to be all three.
 *
 * This is the rule `sessionNameTemplate` already applies to `{title}`, lifted
 * out so a name that does *not* come from an issue gets it too. A group start
 * takes its name from a tracker project ("Bulk Import / Importer V2"), and `sanitizeTmuxSessionName` alone is not enough: it only rewrites the
 * two characters tmux itself rejects, so spaces and slashes survive. A space is
 * fatal twice over — git branch names cannot contain one, and the worktree
 * command is assembled as a shell string, so the name splits into separate
 * arguments and the tool creates something else entirely.
 */
export function slugifyName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, TITLE_SLUG_MAX)
    .replace(/-+$/g, "");
}

/**
 * Make a user-typed session name safe to use as a branch and a directory,
 * keeping what a human legitimately means by it.
 *
 * Deliberately gentler than {@link slugifyName}: `/` is how branches are
 * namespaced (`feat/bulk-import`, and Linear's own `jarred/tra-1-fix`), so it
 * survives. Everything git forbids in a ref, plus whitespace, becomes a hyphen.
 * Returns "" when nothing usable is left, which callers treat as "cancelled"
 * rather than inventing a name.
 */
export function sanitizeBranchName(raw: string): string {
  const cleaned = raw
    .trim()
    .replace(/\s+/g, "-")
    // Git's own forbidden set for ref components, plus the shell-hostile ones.
    .replace(/[~^:?*[\]\\@{}!$'"`;|<>()&#]/g, "-")
    .replace(/\.\.+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/\/{2,}/g, "/")
    .replace(/^[-./]+|[-./]+$/g, "");
  return sanitizeTmuxSessionName(cleaned);
}

/**
 * The session name — which doubles as the branch name and the worktree
 * directory (the one-name rule; see `sanitizeTmuxSessionName` in config.ts).
 *
 * The tracker's own suggested branch name wins when it has one: it already
 * encodes the team's convention, and using it means the branch jmux creates is
 * the branch the tracker will link back to.
 */
export function resolveIssueSessionName(
  issue: Pick<Issue, "identifier" | "title" | "branchName">,
  sessionNameTemplate: string,
): string {
  const raw = issue.branchName
    ? issue.branchName
    : sessionNameTemplate
        .replace("{identifier}", issue.identifier.toLowerCase())
        .replace(
          "{title}",
          issue.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, TITLE_SLUG_MAX),
        );
  return sanitizeTmuxSessionName(raw);
}

/**
 * Where the worktree lands. Inside the mapped repo directory, under the session
 * name — the same layout `buildWorktreeCommand` produces with either wtm or
 * plain git (see repo-settings.ts).
 */
export function issueWorktreePath(repoDir: string, sessionName: string): string {
  return `${repoDir}/${sessionName}`;
}

export interface IssueSessionInput {
  issue: Pick<Issue, "id" | "identifier" | "title" | "branchName">;
  /** Explicit links, keyed through {@link linkKey} by issue id and/or identifier. */
  links: ReadonlyMap<string, string>;
  /** Names of the tmux sessions that currently exist. */
  liveSessions: ReadonlySet<string>;
  /** Home-expanded repo dir for the issue's team, or null when unmapped. */
  repoDir: string | null;
  sessionNameTemplate: string;
  worktreeExists: (path: string) => boolean;
}

/**
 * How far along the issue is, from the session's point of view.
 *
 * Precedence, strongest first:
 *   1. an explicit link  — checked before the repo lookup, so a hand-linked
 *      session works for a team that maps to no repo at all
 *   2. a live session under the derived name
 *   3. a worktree on disk with no session — an abandoned attempt, resumable
 *
 * `undefined` means unstarted: nothing claims this issue.
 */
export function resolveIssueSession(input: IssueSessionInput): IssueSessionInfo | undefined {
  const { issue, links } = input;
  const explicit = links.get(linkKey(issue.id)) ?? links.get(linkKey(issue.identifier));
  if (explicit) return { state: "session", sessionName: explicit };

  if (!input.repoDir) return undefined;
  const sessionName = resolveIssueSessionName(issue, input.sessionNameTemplate);

  if (input.liveSessions.has(sessionName)) return { state: "session", sessionName };

  return input.worktreeExists(issueWorktreePath(input.repoDir, sessionName))
    ? { state: "worktree", sessionName }
    : undefined;
}
