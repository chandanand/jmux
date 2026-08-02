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
import { RepoFactsCache, resolveForRepo, worktreeCommandArgv } from "../repo-settings";
import { resolveIssueSessionName, issueWorktreePath } from "../issue-session";
import { INTERNAL_SESSION_FILTER } from "../glass/internal-sessions";
import { LinearAdapter } from "../adapters/linear";
import { buildLinearPrompt } from "../adapters/linear-prompt";
import { buildClaudeLaunchCommand } from "./run-claude";
import { US, splitFields } from "../tmux-fields";
import type { Issue } from "../adapters/types";
import type { ParsedCtlArgs } from "../cli";

// --- Tmux-option-backed issue↔session links ----------------------------------
//
// Links live as tmux session user options (spec §8.6): server-side, race-free
// against the running TUI's in-memory SessionState, and discoverable via
// `tmux show-options -t <session> | grep @jmux-`.
//
//   @jmux-linear-issue   the linked issue identifier (e.g. TRA-123)
//   @jmux-repo-path      the repo the session's worktree belongs to

export interface IssueLinkRow {
  id: string;
  name: string;
  issue: string;
  path: string;
}

const ISSUE_LINK_FORMAT = [
  "#{session_id}",
  "#{session_name}",
  "#{@jmux-linear-issue}",
  "#{pane_current_path}",
].join(US);

export function parseIssueLinkRow(line: string): IssueLinkRow | null {
  const p = splitFields(line);
  if (p.length < 4) return null;
  return { id: p[0], name: p[1], issue: p[2], path: p[3] };
}

/**
 * Issue ids are compared case-insensitively throughout: the option stores
 * whatever a human or an agent typed, so `tra-123` and `TRA-123` have to be one
 * issue or the 1:1 invariant below is trivially defeated by a shift key.
 */
function sameIssue(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export function findSessionForIssue(
  rows: IssueLinkRow[],
  issueId: string,
): IssueLinkRow | null {
  return rows.find((r) => r.issue && sameIssue(r.issue, issueId)) ?? null;
}

export type LinkDecision =
  | { kind: "ok" }
  | { kind: "noop" }
  | { kind: "error"; message: string };

/**
 * Pure decision for `issue link`, enforcing the strict 1:1 invariant
 * (spec §2.2 / §8.2):
 * - target session must exist;
 * - the issue must not already be linked to a *different* session;
 * - the session must not already be linked to a *different* issue;
 * - re-linking the same pair is a no-op (idempotent).
 */
export function decideIssueLink(
  rows: IssueLinkRow[],
  session: string,
  issueId: string,
): LinkDecision {
  const target = rows.find((r) => r.name === session);
  if (!target) return { kind: "error", message: `session "${session}" not found` };

  const other = rows.find(
    (r) => r.issue && sameIssue(r.issue, issueId) && r.name !== session,
  );
  if (other) {
    return {
      kind: "error",
      message: `issue "${issueId}" already linked to session "${other.name}"`,
    };
  }

  if (target.issue && !sameIssue(target.issue, issueId)) {
    return {
      kind: "error",
      message: `session "${session}" already linked to issue "${target.issue}"; unlink first`,
    };
  }

  if (target.issue && sameIssue(target.issue, issueId)) return { kind: "noop" };
  return { kind: "ok" };
}

export type StartReuse =
  /** Nothing claims this issue — provision it. */
  | { kind: "none" }
  /** A session already carries this issue's link. */
  | { kind: "linked"; row: IssueLinkRow }
  /** A live session sits on the name, unlinked — take it and record the link. */
  | { kind: "adopt"; row: IssueLinkRow }
  | { kind: "conflict"; message: string };

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
 * Adopting is deliberately limited to an *unlinked* session. Reaching this
 * point means no row carries this issue, so a row that carries a different one
 * is a genuine collision, and overwriting its link would silently detach
 * somebody's work from its issue — the same 1:1 invariant `decideIssueLink`
 * exists to protect.
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
  if (byName.issue) {
    return {
      kind: "conflict",
      message: `session "${sessionName}" is where "${issueId}" would go, but it is already linked to issue "${byName.issue}"; unlink it first`,
    };
  }
  return { kind: "adopt", row: byName };
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

  // ok and noop both (re)assert the option — set-option is idempotent.
  tmuxOrThrow(
    runTmuxDirect(
      ["set-option", "-t", session, "@jmux-linear-issue", issueId],
      ctx.socket,
    ),
  );

  // Best-effort repo discovery from the session's working directory.
  let repoPath: string | null = null;
  const target = rows.find((r) => r.name === session);
  const gitRoot = target ? findGitRoot(target.path) : null;
  if (gitRoot) {
    repoPath = gitRoot;
    runTmuxDirect(
      ["set-option", "-t", session, "@jmux-repo-path", gitRoot],
      ctx.socket,
    );
  }

  return { session, issue: issueId, repo: repoPath, linked: true };
}

function issueUnlink(ctx: CliContext, parsed: ParsedCtlArgs): unknown {
  const session = parsed.positional[0];
  if (!session) throw new CliError("issue unlink requires <session>");

  const rows = listIssueLinkRows(ctx);
  const target = rows.find((r) => r.name === session);
  if (!target) throw new CliError(`session "${session}" not found`);

  // Idempotent: -u on an unset option is a no-op.
  runTmuxDirect(["set-option", "-t", session, "-u", "@jmux-linear-issue"], ctx.socket);
  runTmuxDirect(["set-option", "-t", session, "-u", "@jmux-repo-path"], ctx.socket);

  return { session, unlinked: true };
}

function activePane(ctx: CliContext, session: string): string | null {
  const r = runTmuxDirect(
    ["display-message", "-t", session, "-p", "#{pane_id}"],
    ctx.socket,
  );
  return r.ok && r.lines.length > 0 ? r.lines[0] : null;
}

function branchExists(repo: string, branch: string): boolean {
  const r = Bun.spawnSync(
    ["git", "-C", repo, "rev-parse", "--verify", "--quiet", branch],
    { stdout: "ignore", stderr: "ignore" },
  );
  return (r.exitCode ?? 1) === 0;
}

/**
 * Create the issue's worktree under the repo directory, with the same tool the
 * TUI would use — `wtm` for a wtm-managed repo, plain git otherwise.
 *
 * Two departures from `worktreeCommandArgv`, both because this is a scripted
 * API rather than a pane a human is watching:
 *
 *   * an existing worktree directory is reused rather than being an error, so a
 *     retry is a no-op;
 *   * an existing *branch* is checked out rather than re-created, so a second
 *     `issue start` after a session was killed resumes the work. wtm resolves
 *     that case itself, so only the git path needs the distinction.
 */
function createWorktree(o: {
  repo: string;
  worktreePath: string;
  session: string;
  baseBranch: string;
  wtm: boolean;
}): void {
  if (existsSync(o.worktreePath)) return;

  const argv =
    !o.wtm && branchExists(o.repo, o.session)
      ? ["git", "worktree", "add", `./${o.session}`, o.session]
      : worktreeCommandArgv({
          wtm: o.wtm,
          session: o.session,
          baseBranch: o.baseBranch,
          noShell: true,
        });

  const r = Bun.spawnSync(argv, { cwd: o.repo, stdout: "pipe", stderr: "pipe" });
  if ((r.exitCode ?? 1) !== 0) {
    const detail = r.stderr.toString().trim() || r.stdout.toString().trim();
    throw new CliError(`${argv[0]} failed to create the worktree: ${detail}`);
  }
}

async function issueStart(
  ctx: CliContext,
  parsed: ParsedCtlArgs,
): Promise<unknown> {
  const issueId = parsed.positional[0];
  if (!issueId) throw new CliError("issue start requires an <issue-id>");
  const { flags } = parsed;

  const rows = listIssueLinkRows(ctx);
  const reuse = (row: IssueLinkRow, id: string) => ({
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
  if (reused.kind === "conflict") throw new CliError(reused.message);
  if (reused.kind === "adopt") {
    // Record the link the TUI never wrote, so the *next* lookup — here and in
    // `workflow board` — resolves without depending on the name.
    const linkId = issue?.identifier ?? issueId;
    runTmuxDirect(
      ["set-option", "-t", sessionName, "@jmux-linear-issue", linkId],
      ctx.socket,
    );
    return reuse(reused.row, linkId);
  }

  const baseBranch =
    typeof flags["base-branch"] === "string"
      ? flags["base-branch"]
      : repoSettings.defaultBaseBranch;
  const worktreePath = issueWorktreePath(repo, sessionName);

  createWorktree({
    repo,
    worktreePath,
    session: sessionName,
    baseBranch,
    wtm: repoSettings.wtmIntegration,
  });

  // Build the (optional) Claude launch command.
  const launchAgent = !flags["no-launch-agent"];
  let launchCmd: string | null = null;
  if (launchAgent) {
    const claudeCmd = repoSettings.claudeCommand;
    const shell = process.env.SHELL ?? "/bin/sh";
    let promptFile: string | null = null;
    if (issue) {
      const prompt = buildLinearPrompt(issue);
      const rand = Math.random().toString(36).slice(2);
      promptFile = resolve(tmpdir(), `jmux-prompt-${Date.now()}-${rand}`);
      writeFileSync(promptFile, prompt, "utf-8");
    }
    launchCmd = buildClaudeLaunchCommand(claudeCmd, promptFile, shell);
  }

  const otel = buildOtelResourceAttrs(sessionName);
  const createArgs = [
    "new-session",
    "-d",
    "-e",
    `OTEL_RESOURCE_ATTRIBUTES=${otel}`,
    "-s",
    sessionName,
    "-c",
    worktreePath,
  ];
  if (launchCmd) createArgs.push(launchCmd);
  tmuxOrThrow(runTmuxDirect(createArgs, ctx.socket));

  // Link the new session to the issue, under the tracker's own identifier when
  // we have it — the option is what the TUI reads, so a predictable key there
  // beats whatever casing the caller happened to type.
  const linkId = issue?.identifier ?? issueId;
  runTmuxDirect(
    ["set-option", "-t", sessionName, "@jmux-linear-issue", linkId],
    ctx.socket,
  );
  runTmuxDirect(
    ["set-option", "-t", sessionName, "@jmux-repo-path", repo],
    ctx.socket,
  );

  return {
    session: sessionName,
    pane: activePane(ctx, sessionName),
    cwd: worktreePath,
    issue: linkId,
    reused: false,
  };
}
