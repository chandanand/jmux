import { resolve } from "path";
import { homedir } from "os";
import { runTmuxDirect } from "./tmux";
import { loadUserConfig } from "../config";
import { INTERNAL_SESSION_FILTER } from "../glass/internal-sessions";
import { SessionState, type SessionLink } from "../session-state";
import { type CtlAgentState } from "./agent";
import { US, splitFields } from "../tmux-fields";
import { PROJECT_OPTION, type ProjectConfig } from "../project";
import { ISSUE_LINK_OPTION, parseIssueLinkOption } from "../issue-session";
import { outranks } from "../agent-state-rollup";
import type { CliContext } from "./context";
import type { ParsedCtlArgs } from "../cli";

const VALID_AGENT_STATES: ReadonlySet<string> = new Set([
  "running",
  "waiting",
  "complete",
]);

export interface StatusSessionRow {
  id: string;
  name: string;
  agentState: string;
  agentSince: string;
  attention: string;
  attentionReason: string;
  /** Every issue the `@jmux-linear-issue` option carries, in stored order. */
  linearIssues: string[];
  path: string;
  /** True for the session's active pane, whose path represents the session. */
  active: boolean;
  /** The `@jmux-project` stamp, or "" when the session carries none. */
  projectId: string;
}

/**
 * Queried per pane, not per session: agent state is a pane option now. Every
 * other field here is a session option (or the active pane's path), and a
 * pane-context read of a session option inherits, so all panes of a session
 * agree on them — {@link collapseStatusRows} keeps whichever it needs.
 */
const STATUS_FORMAT = [
  "#{session_id}",
  "#{session_name}",
  "#{@jmux-agent-state}",
  "#{@jmux-agent-state-since}",
  "#{@jmux-attention}",
  "#{@jmux-attention-reason}",
  `#{${ISSUE_LINK_OPTION}}`,
  "#{pane_current_path}",
  "#{pane_active}",
  `#{${PROJECT_OPTION}}`,
].join(US);

export function parseStatusLine(line: string): StatusSessionRow | null {
  const p = splitFields(line);
  // Nine, not ten: the project field was added after this shipped, and a
  // session-list line from an older server simply carries no stamp.
  if (p.length < 9) return null;
  return {
    id: p[0],
    name: p[1],
    agentState: p[2],
    agentSince: p[3],
    attention: p[4],
    attentionReason: p[5],
    linearIssues: parseIssueLinkOption(p[6]),
    path: p[7],
    active: p[8] === "1",
    projectId: p[9] ?? "",
  };
}

function parseSince(raw: string): number | null {
  const seconds = Number(raw);
  if (!raw || !Number.isFinite(seconds) || seconds <= 0) return null;
  return Math.floor(seconds);
}

/**
 * Collapse pane rows to one row per session, with the most urgent agent state
 * winning and the active pane supplying the session's path.
 */
export function collapseStatusRows(rows: StatusSessionRow[]): StatusSessionRow[] {
  const bySession = new Map<string, StatusSessionRow>();

  for (const row of rows) {
    const existing = bySession.get(row.id);
    if (!existing) {
      // Seed with no agent state; the loop below re-applies this row's own
      // state through the same precedence check as every sibling.
      bySession.set(row.id, { ...row, agentState: "", agentSince: "" });
    } else if (row.active) {
      existing.path = row.path;
      existing.active = true;
    }

    const target = bySession.get(row.id)!;
    if (!VALID_AGENT_STATES.has(row.agentState)) continue;
    const candidate = {
      state: row.agentState as CtlAgentState,
      since: parseSince(row.agentSince),
    };
    const best = VALID_AGENT_STATES.has(target.agentState)
      ? { state: target.agentState as CtlAgentState, since: parseSince(target.agentSince) }
      : null;
    if (!outranks(candidate, best)) continue;
    target.agentState = row.agentState;
    target.agentSince = row.agentSince;
  }

  return [...bySession.values()];
}

export interface StatusLink {
  type: string;
  id: string;
}

export interface StatusSession {
  id: string;
  name: string;
  path: string | null;
  branch: string | null;
  agent: {
    state: CtlAgentState;
    since: number | null;
    ageSeconds: number | null;
  } | null;
  links: StatusLink[];
  /**
   * `null` and `deleted` are deliberately different: the first is a session
   * nobody adopted, the second a dangling reference an agent can report.
   */
  project: { id: string; title: string } | { id: string; state: "deleted" } | null;
  attention: boolean;
  attentionReason: string | null;
  pinned: boolean;
}

export interface StatusInputs {
  rows: StatusSessionRow[];
  /** Links from the existing SessionState store (state.json), keyed by name. */
  linksByName: (name: string) => SessionLink[];
  pinnedNames: ReadonlySet<string>;
  /** Every configured Project, including soft-deleted ones — a dangling stamp
   *  has to be reportable as `deleted` rather than indistinguishable from
   *  a session nobody adopted. */
  projects?: readonly ProjectConfig[];
  branchByPath: (path: string) => string | null;
  nowSeconds: number;
}

/**
 * Merge the TUI-owned SessionState links (issue + MR, auto-detected) with the
 * CLI-owned `@jmux-linear-issue` tmux option, deduped by (type, id). The two
 * stores exist because a running TUI holds SessionState in memory and would
 * clobber any CLI write to state.json, so CLI issue links live in tmux options
 * (see issue.ts) — `status` reads the union.
 */
function mergeLinks(stateLinks: SessionLink[], linearIssues: string[]): StatusLink[] {
  const out: StatusLink[] = [];
  const seen = new Set<string>();
  const add = (type: string, id: string) => {
    const key = `${type}${id}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push({ type, id });
    }
  };
  for (const l of stateLinks) add(l.type, l.id);
  for (const id of linearIssues) add("issue", id);
  return out;
}

export function buildStatusSnapshot(inp: StatusInputs): {
  sessions: StatusSession[];
} {
  const sessions = inp.rows.map((row): StatusSession => {
    const state = VALID_AGENT_STATES.has(row.agentState)
      ? (row.agentState as CtlAgentState)
      : null;

    let since: number | null = null;
    const seconds = Number(row.agentSince);
    if (row.agentSince && Number.isFinite(seconds) && seconds > 0) {
      since = Math.floor(seconds);
    }

    const agent = state
      ? {
          state,
          since,
          ageSeconds: since !== null ? Math.max(0, inp.nowSeconds - since) : null,
        }
      : null;

    const attention = row.attention === "1";
    const attentionReason = attention ? row.attentionReason || null : null;

    return {
      id: row.id,
      name: row.name,
      path: row.path || null,
      branch: row.path ? inp.branchByPath(row.path) : null,
      agent,
      links: mergeLinks(inp.linksByName(row.name), row.linearIssues),
      project: resolveStatusProject(row.projectId, inp.projects ?? []),
      attention,
      attentionReason,
      pinned: inp.pinnedNames.has(row.name),
    };
  });

  return { sessions };
}

/**
 * The Project a status row reports.
 *
 * Three answers, not two. `null` is a session nobody adopted; `deleted` is a
 * stamp naming a Project that has been removed — a dangling reference an agent
 * can act on, and one that must not be silently flattened into "no project".
 */
function resolveStatusProject(
  stampedId: string,
  projects: readonly ProjectConfig[],
): StatusSession["project"] {
  if (!stampedId) return null;
  const match = projects.find((p) => p.id === stampedId);
  if (!match) return null;
  if (match.deletedAt !== undefined) return { id: match.id, state: "deleted" };
  return { id: match.id, title: match.title };
}

function gitBranch(path: string): string | null {
  try {
    const r = Bun.spawnSync(["git", "-C", path, "rev-parse", "--abbrev-ref", "HEAD"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if ((r.exitCode ?? 1) !== 0) return null;
    const branch = r.stdout.toString().trim();
    return branch.length > 0 ? branch : null;
  } catch {
    return null;
  }
}

export function handleStatus(ctx: CliContext, _parsed: ParsedCtlArgs): unknown {
  const result = runTmuxDirect(
    ["list-panes", "-a", "-f", INTERNAL_SESSION_FILTER, "-F", STATUS_FORMAT],
    ctx.socket,
  );
  const lines = result.ok ? result.lines : [];
  const rows = collapseStatusRows(
    lines.map(parseStatusLine).filter((r): r is StatusSessionRow => r !== null),
  );

  const config = loadUserConfig();
  const pinnedNames = new Set(config.pinnedSessions ?? []);

  const statePath = resolve(homedir(), ".config", "jmux", "state.json");
  const sessionState = new SessionState(statePath);

  // One git call per distinct worktree path, cached across sessions.
  const branchCache = new Map<string, string | null>();
  const branchByPath = (path: string): string | null => {
    const cached = branchCache.get(path);
    if (cached !== undefined) return cached;
    const branch = gitBranch(path);
    branchCache.set(path, branch);
    return branch;
  };

  return buildStatusSnapshot({
    rows,
    linksByName: (name) => sessionState.getLinks(name),
    // Soft-deleted ones included on purpose: a stamp naming a removed Project
    // must report `deleted` rather than being indistinguishable from a session
    // nobody adopted.
    projects: config.projects ?? [],
    pinnedNames,
    branchByPath,
    nowSeconds: Math.floor(Date.now() / 1000),
  });
}
