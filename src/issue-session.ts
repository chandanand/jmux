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
import type { Issue } from "./adapters/types";

export type IssueSessionState = "none" | "worktree" | "session";

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

/** Longer than this and the branch name stops being readable in a tab strip. */
const TITLE_SLUG_MAX = 40;

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
