import { resolve } from "path";
import { homedir, tmpdir } from "os";
import { existsSync, writeFileSync } from "fs";
import { runTmuxDirect } from "./tmux";
import { tmuxOrThrow, CliError, type CliContext } from "./context";
import {
  sanitizeTmuxSessionName,
  buildOtelResourceAttrs,
  loadUserConfig,
  type JmuxConfig,
} from "../config";
import {
  RepoFactsCache,
  resolveForRepo,
  type ResolvedRepoSettings,
} from "../repo-settings";
import {
  resolveIssueSessionName,
  issueWorktreePath,
  linkKey,
  isWritableLinkId,
  parseIssueLinkOption,
  formatIssueLinkOption,
  ISSUE_LINK_OPTION,
} from "../issue-session";
import {
  buildProvisionPlan,
  SETUP_PANE_SIZE,
  PROVISION_ATTENTION_REASON,
} from "../issue-provision";
import { transitionTarget } from "../transitions";
import { INTERNAL_SESSION_FILTER } from "../glass/internal-sessions";
import { LinearAdapter } from "../adapters/linear";
import { buildLinearPrompt } from "../adapters/linear-prompt";
import { US, splitFields } from "../tmux-fields";
import type { Issue } from "../adapters/types";
import type { ParsedCtlArgs } from "../cli";

// --- Tmux-option-backed issue↔session links ----------------------------------
//
// Links live as tmux session user options (spec §8.6): server-side, race-free
// against the running TUI's in-memory SessionState, and discoverable via
// `tmux show-options -t <session> | grep @jmux-`.
//
//   @jmux-linear-issue   the linked issue identifiers, space-separated
//   @jmux-repo-path      the repo the session's worktree belongs to
//
// The link is many-to-one: an issue belongs to at most one session, but a
// session can carry several. A feature that arrives as five tickets is one
// branch, one worktree and one MR, so forcing five sessions would fragment work
// the tracker had already grouped. The half that remains 1:1 is the half
// `resolveIssueSession` depends on — see issue-session.ts.

export interface IssueLinkRow {
  id: string;
  name: string;
  issues: string[];
  path: string;
}

const ISSUE_LINK_FORMAT = [
  "#{session_id}",
  "#{session_name}",
  `#{${ISSUE_LINK_OPTION}}`,
  "#{pane_current_path}",
].join(US);

export function parseIssueLinkRow(line: string): IssueLinkRow | null {
  const p = splitFields(line);
  if (p.length < 4) return null;
  return { id: p[0], name: p[1], issues: parseIssueLinkOption(p[2]), path: p[3] };
}

/**
 * Issue ids are compared case-insensitively throughout: the option stores
 * whatever a human or an agent typed, so `tra-123` and `TRA-123` have to be one
 * issue or the one-session-per-issue invariant below is trivially defeated by a
 * shift key.
 */
function sameIssue(a: string, b: string): boolean {
  return linkKey(a) === linkKey(b);
}

function carriesIssue(row: IssueLinkRow, issueId: string): boolean {
  return row.issues.some((i) => sameIssue(i, issueId));
}

export function findSessionForIssue(
  rows: IssueLinkRow[],
  issueId: string,
): IssueLinkRow | null {
  return rows.find((r) => carriesIssue(r, issueId)) ?? null;
}

export type LinkDecision =
  /** Write `issues` back to the option — the session's links with this one added. */
  | { kind: "ok"; issues: string[] }
  | { kind: "noop" }
  | { kind: "error"; message: string };

/**
 * Pure decision for `issue link`.
 *
 * One invariant survives from when this was strictly 1:1, and it is the one
 * that matters: **an issue belongs to at most one session**. `resolveIssueSession`
 * answers "where does this issue live" with a single session, so a second
 * claimant would make the sidebar, `ctl status` and `workflow board` disagree
 * depending on which they happened to read first.
 *
 * The other half — a session carrying at most one issue — is gone. It was never
 * load-bearing (the TUI's own `state.json` store has always held a list, so the
 * CLI was rejecting a state the human could already create with the link key),
 * and it made the common case of one feature filed as several tickets
 * unrepresentable.
 *
 * Linking is therefore an *append*, and re-linking the same pair stays a no-op.
 */
export function decideIssueLink(
  rows: IssueLinkRow[],
  session: string,
  issueId: string,
): LinkDecision {
  const target = rows.find((r) => r.name === session);
  if (!target) return { kind: "error", message: `session "${session}" not found` };

  if (!isWritableLinkId(issueId)) {
    return {
      kind: "error",
      message: `issue id "${issueId}" contains whitespace, which the link option cannot store`,
    };
  }

  const other = rows.find((r) => r.name !== session && carriesIssue(r, issueId));
  if (other) {
    return {
      kind: "error",
      message: `issue "${issueId}" already linked to session "${other.name}"`,
    };
  }

  if (carriesIssue(target, issueId)) return { kind: "noop" };
  return { kind: "ok", issues: [...target.issues, issueId] };
}

export type StartReuse =
  /** Nothing claims this issue — provision it. */
  | { kind: "none" }
  /** A session already carries this issue's link. */
  | { kind: "linked"; row: IssueLinkRow }
  /** A live session sits on the name — take it and record the link alongside any others. */
  | { kind: "adopt"; row: IssueLinkRow; issues: string[] };

/**
 * Whether `issue start` should provision, or hand back something that exists.
 *
 * Two passes, because the answer improves once the tracker has resolved the
 * issue: the link check needs only the id, so it runs first and a repeat start
 * costs no API call; the name check needs the derived session name, so it runs
 * after. Pass `sessionName: null` for the first.
 *
 * The name pass is what keeps the command idempotent now that the CLI derives
 * the *same* session name as the TUI. Work started in jmux records its link in
 * `state.json` — which a running TUI holds in memory and would clobber if the
 * CLI wrote there — so the CLI cannot see that link and would otherwise fall
 * through to `new-session` and fail on a duplicate name.
 *
 * Adopting used to refuse a session that already carried a *different* issue,
 * on the grounds that overwriting its link would detach somebody's work. That
 * reasoning was about the overwrite, not the sharing: the link is now a list,
 * so adopting appends and detaches nothing. Two issues deriving one session
 * name means the name says they belong together, and the session is the thing
 * the name identifies.
 */
export function decideStartReuse(
  rows: IssueLinkRow[],
  issueId: string,
  sessionName: string | null,
): StartReuse {
  const linked = findSessionForIssue(rows, issueId);
  if (linked) return { kind: "linked", row: linked };
  if (!sessionName) return { kind: "none" };

  const byName = rows.find((r) => r.name === sessionName);
  if (!byName) return { kind: "none" };
  return { kind: "adopt", row: byName, issues: [...byName.issues, issueId] };
}

// --- Pure helpers for `issue start` ------------------------------------------

/**
 * Branch/session/worktree name for an issue — one name for all three, as
 * everywhere else in jmux.
 *
 * Delegates to the shared resolver so the CLI provisions exactly what the TUI
 * would, which is what lets the sidebar recognise a session an agent started.
 * The one case the shared rule can't cover is offline mode: with no tracker
 * configured there is no issue to feed a template, so the bare id is the only
 * name available.
 */
export function startSessionName(
  issueId: string,
  issue: Issue | null,
  sessionNameTemplate: string,
): string {
  return issue
    ? resolveIssueSessionName(issue, sessionNameTemplate)
    : sanitizeTmuxSessionName(issueId);
}

export function expandTilde(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return resolve(homedir(), p.slice(2));
  return p;
}

/**
 * Repo for an issue: explicit `--repo` wins, else `issueWorkflow.teamRepoMap`
 * keyed by the issue's team. Returns null when nothing resolves — the caller
 * turns that into an actionable error rather than guessing.
 */
export function resolveRepoForIssue(
  flags: ParsedCtlArgs["flags"],
  issue: Issue | null,
  config: JmuxConfig,
): string | null {
  if (typeof flags.repo === "string") return expandTilde(flags.repo);
  const team = issue?.team;
  const map = config.issueWorkflow?.teamRepoMap ?? {};
  if (team && map[team]) return expandTilde(map[team]);
  return null;
}

export interface IssueCreateArgs {
  title: string;
  description: string;
  team: string | null;
  start: boolean;
}

/**
 * Validate `ctl issue create` flags.
 *
 * This exists so an agent running inside a jmux session can file an issue the
 * moment it notices something out of scope, without the user context-switching
 * to a browser. That is the whole point: the idea never leaves the tracker.
 */
export function validateIssueCreate(
  flags: Record<string, string | boolean>,
): IssueCreateArgs {
  const title = typeof flags.title === "string" ? flags.title.trim() : "";
  if (!title) throw new CliError("issue create requires --title <text>");
  return {
    title,
    description: typeof flags.description === "string" ? flags.description : "",
    team: typeof flags.team === "string" ? flags.team : null,
    start: flags.start === true,
  };
}

/**
 * Match a requested status against the ones the issue can actually move to.
 *
 * Case- and whitespace-insensitive, and it returns the tracker's *canonical*
 * spelling: `LinearAdapter.updateStatus` matches state names exactly and
 * silently does nothing when it can't, so passing through what the caller typed
 * would turn a typo into a successful-looking no-op.
 */
export function matchStatus(input: string, available: readonly string[]): string | null {
  const want = input.trim().toLowerCase();
  return available.find((s) => s.trim().toLowerCase() === want) ?? null;
}

/**
 * Map a user-supplied team (id or name) onto a team id. With exactly one team
 * the flag is optional — most single-team workspaces should never have to
 * think about it.
 */
export function resolveTeamId(
  input: string | null,
  teams: Array<{ id: string; name: string }>,
): string {
  if (!input) {
    if (teams.length === 1) return teams[0]!.id;
    throw new CliError(
      `--team is required when the workspace has ${teams.length} teams`,
    );
  }
  const exact = teams.find((t) => t.id === input);
  if (exact) return exact.id;
  const byName = teams.find((t) => t.name.toLowerCase() === input.toLowerCase());
  if (byName) return byName.id;
  throw new CliError(`unknown team "${input}"`);
}

// --- Handlers ----------------------------------------------------------------

export async function handleIssue(
  ctx: CliContext,
  parsed: ParsedCtlArgs,
): Promise<unknown> {
  const { action } = parsed;
  switch (action) {
    case "get":
      return await issueGet(parsed);
    case "link":
      return issueLink(ctx, parsed);
    case "unlink":
      return issueUnlink(ctx, parsed);
    case "start":
      return await issueStart(ctx, parsed);
    case "create":
      return await issueCreate(ctx, parsed);
    case "move":
      return await issueMove(parsed);
    default:
      throw new CliError(
        `Unknown issue action "${action}". Known actions: get, link, unlink, start, create, move`,
      );
  }
}

/**
 * Move an issue along the workflow — the write that lets an agent hand its own
 * work on when it finishes.
 *
 * This is an *explicit* command, so the per-repo `transitionConfirm` policy does
 * not apply: that governs the transitions jmux performs on its own initiative
 * (see transitions.ts), and its whole point is that jmux never writes to a
 * shared tracker unasked. Here it was asked.
 *
 * The result is read back rather than assumed. `updateStatus` resolves the state
 * name server-side and returns nothing, so reporting success from the absence of
 * a thrown error would be reporting that the request was sent, not that the
 * issue moved.
 */
async function issueMove(parsed: ParsedCtlArgs): Promise<unknown> {
  const issueId = parsed.positional[0];
  const status = parsed.positional[1];
  if (!issueId || !status) {
    throw new CliError("issue move requires <issue-id> <status>");
  }

  const adapter = new LinearAdapter({});
  await adapter.authenticate();
  if (adapter.authState !== "ok") {
    throw new CliError(`issue tracker not authenticated (${adapter.authHint})`);
  }

  const issue = await adapter.getIssueByBranch(issueId);
  if (!issue) throw new CliError(`issue "${issueId}" not found`);

  const available = await adapter.getAvailableStatuses(issue.id);
  const target = matchStatus(status, available);
  if (!target) {
    throw new CliError(
      `"${status}" is not a status ${issue.identifier} can move to. Available: ${available.join(", ")}`,
    );
  }

  const from = issue.status;
  if (target === from) {
    return { issue: issue.identifier, from, to: target, moved: false };
  }

  await adapter.updateStatus(issue.id, target);
  const after = await adapter.pollIssue(issue.id);
  return { issue: issue.identifier, from, to: target, moved: after.status === target, status: after.status };
}

async function issueCreate(
  ctx: CliContext,
  parsed: ParsedCtlArgs,
): Promise<unknown> {
  const args = validateIssueCreate(parsed.flags);

  const adapter = new LinearAdapter({});
  await adapter.authenticate();
  if (adapter.authState !== "ok") {
    throw new CliError(`issue tracker not authenticated (${adapter.authHint})`);
  }

  const teamId = resolveTeamId(args.team, await adapter.getTeams());
  const issue = await adapter.createIssue(teamId, args.title, args.description);

  // Capture and start are one flow with two commit points: file it and move
  // on, or file it and be working on it a keystroke later.
  if (!args.start) {
    return { created: true, identifier: issue.identifier, id: issue.id, url: issue.webUrl, started: false };
  }

  const started = await issueStart(ctx, {
    ...parsed,
    positional: [issue.identifier],
  });
  return { created: true, identifier: issue.identifier, id: issue.id, url: issue.webUrl, started };
}

async function fetchIssue(issueId: string): Promise<Issue | null> {
  const adapter = new LinearAdapter({});
  await adapter.authenticate();
  if (adapter.authState !== "ok") {
    throw new CliError(
      "Linear is not configured: set LINEAR_API_KEY or LINEAR_TOKEN",
    );
  }
  // getIssueByBranch extracts the identifier from the string and resolves it.
  return await adapter.getIssueByBranch(issueId);
}

async function issueGet(parsed: ParsedCtlArgs): Promise<unknown> {
  const issueId = parsed.positional[0];
  if (!issueId) throw new CliError("issue get requires an <issue-id>");
  const issue = await fetchIssue(issueId);
  if (!issue) throw new CliError(`issue "${issueId}" not found`);
  return { issue };
}

function listIssueLinkRows(ctx: CliContext): IssueLinkRow[] {
  const result = runTmuxDirect(
    ["list-sessions", "-f", INTERNAL_SESSION_FILTER, "-F", ISSUE_LINK_FORMAT],
    ctx.socket,
  );
  const lines = result.ok ? result.lines : [];
  return lines
    .map(parseIssueLinkRow)
    .filter((r): r is IssueLinkRow => r !== null);
}

function findGitRoot(path: string): string | null {
  if (!path) return null;
  try {
    const r = Bun.spawnSync(["git", "-C", path, "rev-parse", "--show-toplevel"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if ((r.exitCode ?? 1) !== 0) return null;
    const root = r.stdout.toString().trim();
    return root.length > 0 ? root : null;
  } catch {
    return null;
  }
}

function issueLink(ctx: CliContext, parsed: ParsedCtlArgs): unknown {
  const session = parsed.positional[0];
  const issueId = parsed.positional[1];
  if (!session || !issueId) {
    throw new CliError("issue link requires <session> <issue-id>");
  }

  const rows = listIssueLinkRows(ctx);
  const decision = decideIssueLink(rows, session, issueId);
  if (decision.kind === "error") throw new CliError(decision.message);

  // A noop must not rewrite the option: the id it would write is whatever the
  // caller typed, and re-asserting it would let `tra-1` overwrite the tracker's
  // own `TRA-1` spelling for no gain.
  const target = rows.find((r) => r.name === session)!;
  const issues = decision.kind === "ok" ? decision.issues : target.issues;
  if (decision.kind === "ok") {
    tmuxOrThrow(
      runTmuxDirect(
        ["set-option", "-t", session, ISSUE_LINK_OPTION, formatIssueLinkOption(issues)],
        ctx.socket,
      ),
    );
  }

  // Best-effort repo discovery from the session's working directory.
  let repoPath: string | null = null;
  const gitRoot = findGitRoot(target.path);
  if (gitRoot) {
    repoPath = gitRoot;
    runTmuxDirect(
      ["set-option", "-t", session, "@jmux-repo-path", gitRoot],
      ctx.socket,
    );
  }

  return { session, issue: issueId, issues, repo: repoPath, linked: true };
}

/**
 * `issue unlink <session> [issue-id]`.
 *
 * With an id, exactly that link goes; without one, every link on the session
 * does. Deleting by id matters now that a session can carry several: dropping
 * one ticket from a five-ticket session must not detach the other four, and a
 * caller who means "all of them" still has the bare form to say so.
 *
 * `@jmux-repo-path` is only unset when the last issue leaves, since it
 * describes the session rather than any one link.
 */
function issueUnlink(ctx: CliContext, parsed: ParsedCtlArgs): unknown {
  const session = parsed.positional[0];
  const issueId = parsed.positional[1];
  if (!session) throw new CliError("issue unlink requires <session> [issue-id]");

  const rows = listIssueLinkRows(ctx);
  const target = rows.find((r) => r.name === session);
  if (!target) throw new CliError(`session "${session}" not found`);

  const remaining = issueId
    ? target.issues.filter((i) => !sameIssue(i, issueId))
    : [];
  if (issueId && remaining.length === target.issues.length) {
    throw new CliError(`session "${session}" is not linked to issue "${issueId}"`);
  }

  if (remaining.length > 0) {
    tmuxOrThrow(
      runTmuxDirect(
        ["set-option", "-t", session, ISSUE_LINK_OPTION, formatIssueLinkOption(remaining)],
        ctx.socket,
      ),
    );
  } else {
    // Idempotent: -u on an unset option is a no-op.
    runTmuxDirect(["set-option", "-t", session, "-u", ISSUE_LINK_OPTION], ctx.socket);
    runTmuxDirect(["set-option", "-t", session, "-u", "@jmux-repo-path"], ctx.socket);
  }

  // Always a list, even for the one-id form: a field whose type depends on
  // which arguments were passed makes every consumer branch before it can read
  // it.
  const unlinked = issueId ? target.issues.filter((i) => sameIssue(i, issueId)) : target.issues;
  return { session, unlinked, issues: remaining };
}

function activePane(ctx: CliContext, session: string): string | null {
  const r = runTmuxDirect(
    ["display-message", "-t", session, "-p", "#{pane_id}"],
    ctx.socket,
  );
  return r.ok && r.lines.length > 0 ? r.lines[0] : null;
}

/**
 * How far a `--wait` poll gets between checks. Provisioning takes seconds at
 * best (a bare `git worktree add`) and minutes at worst (wtm running install
 * hooks), so there is nothing to gain from a tighter loop.
 */
const WAIT_POLL_MS = 500;

/** `--wait` with no value: long enough for a dependency install, still bounded. */
const WAIT_DEFAULT_SECONDS = 300;

export interface WaitSpec {
  wait: boolean;
  seconds: number;
}

/**
 * Parse `--wait` / `--wait <seconds>`.
 *
 * Waiting is opt-in and always bounded. The command this replaces blocked for
 * however long the worktree tool took, with no output and no ceiling, which is
 * indistinguishable from a hang to anything watching it — so a caller that
 * genuinely needs the worktree on disk gets to say so *and* gets a definite
 * answer either way, rather than an open-ended block by default.
 */
export function parseWaitFlag(raw: string | boolean | undefined): WaitSpec {
  if (raw === undefined || raw === false) return { wait: false, seconds: 0 };
  if (raw === true) return { wait: true, seconds: WAIT_DEFAULT_SECONDS };
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new CliError(`--wait expects a positive number of seconds, got "${raw}"`);
  }
  return { wait: true, seconds: n };
}

/**
 * Whether provisioning has finished, from the two facts the human reads off
 * their own screen: the worktree directory is there, and the setup pane that
 * was creating it has exited.
 *
 * Both are needed. The directory appears the moment the worktree tool creates
 * it, which is *before* any install hooks run — so a directory alone means
 * "started", not "ready". The setup pane closing is what means the tool exited
 * 0, because the failure path replaces the exit with a shell.
 */
export function provisioningDone(o: {
  worktreeExists: boolean;
  setupPaneAlive: boolean;
}): boolean {
  return o.worktreeExists && !o.setupPaneAlive;
}

/**
 * How the worktree is coming along, as reported to the caller.
 *
 * Optional fields rather than a discriminated union: this is a JSON payload,
 * and modelling absent keys as absent keys keeps the type and the wire shape
 * the same thing.
 */
export interface ProvisioningStatus {
  ready: boolean;
  /** The setup pane, or null once there is nothing left to watch. */
  pane: string | null;
  worktree: string;
  /** Set when `--wait` saw it through. */
  waited?: boolean;
  /** Set when the setup pane reported its own failure. */
  failed?: boolean;
  /** Set when `--wait` hit its deadline with setup still running. */
  timedOut?: boolean;
  reason?: string;
  note?: string;
}

/** The `session-start` tracker move, reported rather than assumed. */
export interface TransitionResult {
  moved: boolean;
  reason?: string;
  from?: string;
  to?: string;
  status?: string;
}

export interface IssueStartResult {
  session: string;
  pane: string | null;
  /** Where the worktree is — or *will* be, until `provisioning.ready`. */
  cwd: string | null;
  issue: string;
  reused: boolean;
  /** Absent on the reuse paths: nothing was started, so nothing moved. */
  transition?: TransitionResult;
  provisioning?: ProvisioningStatus;
}

function paneAlive(ctx: CliContext, session: string, paneId: string): boolean {
  // Scoped to the session rather than `-a`: the setup pane is in it by
  // construction, and this runs twice a second for up to five minutes.
  const r = runTmuxDirect(["list-panes", "-t", session, "-F", "#{pane_id}"], ctx.socket);
  return r.ok && r.lines.includes(paneId);
}

/**
 * Whether the setup pane reported *its own* failure.
 *
 * Matched against the exact reason the setup pane writes, not merely "the
 * session has an attention flag". A session can be flagged by an agent hook or
 * by a human running `ctl session attention set`, and treating either as
 * evidence that provisioning died would abandon a healthy wait and tell the
 * caller its start had failed.
 */
function provisioningFailed(ctx: CliContext, session: string): boolean {
  const r = runTmuxDirect(
    ["show-option", "-t", session, "-qv", "@jmux-attention-reason"],
    ctx.socket,
  );
  const value = r.ok && r.lines.length > 0 ? r.lines[0].trim() : "";
  return value === PROVISION_ATTENTION_REASON;
}

async function issueStart(
  ctx: CliContext,
  parsed: ParsedCtlArgs,
): Promise<IssueStartResult> {
  const issueId = parsed.positional[0];
  if (!issueId) throw new CliError("issue start requires an <issue-id>");
  // Validated here, not only in `decideIssueLink`: this command writes the link
  // option itself. With a tracker configured a malformed id would be rejected
  // by the lookup below, but offline mode (`--repo`, no tracker) passes argv
  // straight through — and an id containing a space becomes two links on the
  // next read.
  if (!isWritableLinkId(issueId)) {
    throw new CliError(
      `issue id "${issueId}" contains whitespace, which the link option cannot store`,
    );
  }
  const { flags } = parsed;
  // Validated before any lookup or side effect. Deferring it meant a typo cost
  // a tracker round-trip first, and was skipped entirely on the reuse paths —
  // validation that only fires sometimes is validation nobody can rely on.
  const waitSpec = parseWaitFlag(flags.wait);

  const rows = listIssueLinkRows(ctx);
  const reuse = (row: IssueLinkRow, id: string): IssueStartResult => ({
    session: row.name,
    pane: activePane(ctx, row.name),
    cwd: row.path || null,
    issue: id,
    reused: true,
  });

  const firstPass = decideStartReuse(rows, issueId, null);
  if (firstPass.kind === "linked") return reuse(firstPass.row, issueId);

  const config = loadUserConfig();

  // Fetch issue when Linear is configured — needed for the team→repo mapping,
  // the branch name, and the launch prompt. Tolerate an unconfigured tracker as
  // long as --repo is supplied.
  let issue: Issue | null = null;
  const adapter = new LinearAdapter({});
  await adapter.authenticate();
  if (adapter.authState === "ok") {
    issue = await adapter.getIssueByBranch(issueId);
    // Tracker is configured but the id resolves to nothing — almost certainly a
    // typo. Refuse rather than silently create a worktree + launch Claude with
    // no prompt for a nonexistent issue. Offline mode (no tracker configured)
    // is the only path that proceeds without a resolved issue, and it requires
    // an explicit --repo.
    if (!issue) {
      throw new CliError(
        `issue "${issueId}" not found in Linear — refusing to start work for an unknown issue`,
      );
    }
  }

  const repo = resolveRepoForIssue(flags, issue, config);
  if (!repo) {
    throw new CliError(
      `could not resolve a repo for "${issueId}". Pass --repo <path> or configure issueWorkflow.teamRepoMap.`,
    );
  }
  if (!existsSync(repo)) {
    throw new CliError(`repo path does not exist: ${repo}`);
  }

  // Settings resolve against the repo this issue routes to, not the CLI's cwd.
  const repoSettings = resolveForRepo(config, new RepoFactsCache().get(repo));
  const sessionName = startSessionName(issueId, issue, repoSettings.sessionNameTemplate);

  const reused = decideStartReuse(rows, issueId, sessionName);
  if (reused.kind === "adopt") {
    // Record the link the TUI never wrote, so the *next* lookup — here and in
    // `workflow board` — resolves without depending on the name. Appended to
    // whatever the session already carries: adopting must not detach the
    // issues that got there first.
    const linkId = issue?.identifier ?? issueId;
    runTmuxDirect(
      [
        "set-option", "-t", sessionName, ISSUE_LINK_OPTION,
        formatIssueLinkOption([...reused.row.issues, linkId]),
      ],
      ctx.socket,
    );
    return reuse(reused.row, linkId);
  }

  const baseBranch =
    typeof flags["base-branch"] === "string"
      ? flags["base-branch"]
      : repoSettings.defaultBaseBranch;
  const worktreePath = issueWorktreePath(repo, sessionName);

  // A worktree already on disk with no session is an abandoned attempt, and
  // resuming into it is exactly what the TUI's "worktree" state does. Note this
  // is the *only* thing the directory's existence is allowed to decide: it used
  // to double as "the worktree is finished", which meant an interrupted setup
  // left a half-installed tree that the next `issue start` happily launched an
  // agent inside. Readiness is now the setup pane's business.
  const worktreeExists = existsSync(worktreePath);

  // Seed the agent's first message from the issue, the same way the TUI does.
  const launchAgent = !flags["no-launch-agent"] && repoSettings.autoLaunchAgent;
  let promptFile: string | null = null;
  if (launchAgent && issue) {
    const rand = Math.random().toString(36).slice(2);
    promptFile = resolve(tmpdir(), `jmux-prompt-${Date.now()}-${rand}`);
    writeFileSync(promptFile, buildLinearPrompt(issue), "utf-8");
  }

  const plan = buildProvisionPlan({
    session: sessionName,
    repoDir: repo,
    worktreePath,
    baseBranch,
    wtm: repoSettings.wtmIntegration,
    worktreeExists,
    agentCommand: launchAgent ? repoSettings.claudeCommand : null,
    promptFile,
  });

  // The session comes first and the worktree is provisioned into it, so the
  // work is visible to `ctl status`, `workflow board` and the human's sidebar
  // from here on — including while a slow `wtm create` is still running its
  // install hooks.
  const otel = buildOtelResourceAttrs(sessionName);
  tmuxOrThrow(
    runTmuxDirect(
      [
        "new-session",
        "-d",
        "-e",
        `OTEL_RESOURCE_ATTRIBUTES=${otel}`,
        "-s",
        sessionName,
        "-c",
        plan.sessionCwd,
        plan.mainCommand,
      ],
      ctx.socket,
    ),
  );

  // Link the new session to the issue, under the tracker's own identifier when
  // we have it — the option is what the TUI reads, so a predictable key there
  // beats whatever casing the caller happened to type.
  const linkId = issue?.identifier ?? issueId;
  runTmuxDirect(
    ["set-option", "-t", sessionName, ISSUE_LINK_OPTION, linkId],
    ctx.socket,
  );
  runTmuxDirect(
    ["set-option", "-t", sessionName, "@jmux-repo-path", repo],
    ctx.socket,
  );

  const setupPane = plan.setupCommand
    ? openSetupPane(ctx, { session: sessionName, repo, command: plan.setupCommand })
    : null;

  // The tracker move the human's `n` key fires. An explicit CLI invocation is
  // explicit consent, so the `transitionConfirm` policy does not apply here for
  // the same reason it does not apply to `issue move`: that policy governs the
  // writes jmux performs on its own initiative, and this one was asked for.
  // The already-authenticated adapter is reused — a second `authenticate()` is
  // a network round-trip added to the path whose whole point is returning fast.
  const transition = await applySessionStartTransition(adapter, issue, repoSettings);

  const result: IssueStartResult = {
    session: sessionName,
    pane: activePane(ctx, sessionName),
    cwd: worktreePath,
    issue: linkId,
    reused: false,
    transition,
  };

  // Narrowing on the pane rather than on `plan.setupCommand` is what lets the
  // wait path take a non-nullable pane id: the two are null together, and only
  // this one carries the fact into the type.
  if (setupPane === null) {
    result.provisioning = { ready: true, pane: null, worktree: worktreePath };
    return result;
  }

  result.provisioning = waitSpec.wait
    ? await waitForProvisioning(ctx, {
        session: sessionName,
        worktreePath,
        setupPane,
        seconds: waitSpec.seconds,
      })
    : {
        ready: false,
        pane: setupPane,
        worktree: worktreePath,
        // Deliberately does not suggest re-running with --wait. A re-run finds
        // the link this command just wrote, returns `reused: true` and does not
        // wait for anything — advice that looks like it worked and does nothing
        // is the failure this whole change exists to stop shipping.
        note: "worktree is being created in the setup pane; cwd does not exist yet. Poll `jmux ctl status` — the session reports attention with reason \"worktree setup failed\" if setup dies. Do not re-run this command to wait; it will return the session as already started.",
      };

  return result;
}

/**
 * Split the setup pane and return its id.
 *
 * The id is required, not best-effort. `-P -F` prints it whenever the split
 * succeeds, so a success with no id is a broken assumption rather than a case
 * to degrade through — and degrading would make the pane look already-exited to
 * `waitForProvisioning`, which would then call a bare directory "ready". That
 * is exactly the bug this change exists to remove.
 */
function openSetupPane(
  ctx: CliContext,
  o: { session: string; repo: string; command: string },
): string {
  const split = runTmuxDirect(
    [
      "split-window",
      "-h",
      "-d",
      "-l",
      SETUP_PANE_SIZE,
      "-t",
      o.session,
      "-c",
      o.repo,
      "-P",
      "-F",
      "#{pane_id}",
      o.command,
    ],
    ctx.socket,
  );
  tmuxOrThrow(split);
  const pane = split.lines[0];
  if (!pane) {
    throw new CliError(
      `tmux created the setup pane for "${o.session}" but reported no pane id`,
    );
  }
  return pane;
}

/**
 * Fire the `session-start` transition, honouring the repo's configured target.
 *
 * Reported rather than assumed, exactly as `issue move` does: `updateStatus`
 * resolves the state name server-side and returns nothing, so treating "no
 * exception" as "the issue moved" would report that a request was sent.
 *
 * A failure here is deliberately not fatal. The session exists and the worktree
 * is being built; throwing away a successful start because a tracker write
 * failed would be the CLI's most destructive possible response to its least
 * important step.
 */
async function applySessionStartTransition(
  adapter: LinearAdapter,
  issue: Issue | null,
  settings: ResolvedRepoSettings,
): Promise<TransitionResult> {
  const target = transitionTarget("session-start", settings);
  // `issue` is only non-null when the adapter authenticated, so reaching the
  // write below already implies a usable tracker.
  if (!issue) return { moved: false, reason: "no tracker" };
  if (!target) return { moved: false, reason: "not configured" };
  if (issue.status === target) return { moved: false, reason: "already there", status: target };

  try {
    await adapter.updateStatus(issue.id, target);
    const after = await adapter.pollIssue(issue.id);
    return { moved: after.status === target, from: issue.status, to: target, status: after.status };
  } catch (err) {
    return { moved: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Block until the setup pane finishes, up to a bounded deadline.
 *
 * Returns rather than throws on timeout. A slow install is not an error, and a
 * caller that asked to wait 60s for something that takes 90s should get back a
 * session it can keep polling, not an exception that implies the start failed.
 */
async function waitForProvisioning(
  ctx: CliContext,
  o: { session: string; worktreePath: string; setupPane: string; seconds: number },
): Promise<ProvisioningStatus> {
  const deadline = Date.now() + o.seconds * 1000;
  for (;;) {
    const done = provisioningDone({
      worktreeExists: existsSync(o.worktreePath),
      setupPaneAlive: paneAlive(ctx, o.session, o.setupPane),
    });
    if (done) {
      return { ready: true, pane: null, worktree: o.worktreePath, waited: true };
    }

    // The setup pane raises this before dropping to a shell, so a failure is
    // reported as a failure instead of running out the clock.
    if (provisioningFailed(ctx, o.session)) {
      return {
        ready: false,
        failed: true,
        pane: o.setupPane,
        worktree: o.worktreePath,
        reason: PROVISION_ATTENTION_REASON,
        note: `the setup pane ${o.setupPane} is sitting on the error; \`jmux ctl pane capture --target ${o.setupPane}\` shows it`,
      };
    }

    if (Date.now() >= deadline) {
      return {
        ready: false,
        timedOut: true,
        pane: o.setupPane,
        worktree: o.worktreePath,
        note: `still provisioning after ${o.seconds}s — the session is live and will start the agent when the worktree lands`,
      };
    }
    await Bun.sleep(WAIT_POLL_MS);
  }
}
