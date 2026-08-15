// `jmux ctl workflow` — the work pipeline, as JSON.
//
// The TUI's pipeline (user-defined stages sitting on top of tracker statuses,
// parking, the `Ctrl-Space u` pull rotation, unstarted work) was previously visible
// only on screen. This is the same model, for an agent.
//
// **Everything is re-derived, not read out of a running TUI.** There is no IPC:
// like every other `ctl` command this reads tmux, the config file and the
// tracker directly, so it answers identically whether or not jmux is running.
// Agreeing with what the human sees is therefore not automatic — it is bought by
// reusing the *same modules* the sidebar and panel use, never by reimplementing
// their rules:
//
//   * membership and ordering — `effectiveFilter`/`matchesIssueFilter`
//     (panel-view.ts) then `transformIssues`/`buildViewNodes`
//     (panel-view-renderer.ts), which is `main.ts`'s `orderedIssuesByView`
//   * which stage claims a status — `stageForState`
//   * issue ↔ session — `resolveIssueSession` (issue-session.ts)
//   * parking — `isParked` (parking.ts)
//   * unstarted work — `selectGhosts` (ghosts.ts)
//
// Two honest gaps, both documented in skills/jmux-control.md:
//
//   * **Parking's four poll-driven unpark signals** (a new comment, MR activity,
//     a red pipeline, a state regression) are edges against a baseline captured
//     when a session parked. That history lives in the running TUI's memory, so
//     a one-shot CLI process cannot see it and passes no signals. The
//     `agent-attention` trigger and idle auto-park *are* readable from tmux and
//     are honoured. The result is a conservative superset: a session the sidebar
//     has already pulled back out may still read as parked here.
//   * **Session → issue** is the inverse of `resolveIssueSession`, i.e. explicit
//     links (both stores) and the derived session name. A session whose issue is
//     reachable only by traversing its branch's MR — which costs an API call per
//     session — lands in `ungrouped`.

import { resolve } from "path";
import { homedir } from "os";
import { existsSync } from "fs";
import { runTmuxDirect } from "./tmux";
import { PROJECT_OPTION, resolveSettingsFor, type ProjectConfig } from "../project";
import { resolveIssueProject } from "../project-routing";
import { CliError, type CliContext } from "./context";
import { loadUserConfig, type JmuxConfig } from "../config";
import { RepoFactsCache } from "../repo-settings";
import { INTERNAL_SESSION_FILTER } from "../glass/internal-sessions";
import { SessionState } from "../session-state";
import { LinearAdapter } from "../adapters/linear";
import { US, splitFields } from "../tmux-fields";
import {
  parseViews,
  effectiveFilter,
  matchesIssueFilter,
  stageForState,
  stageInSidebar,
  stageShowsUnstarted,
  isParkedState,
  parkedStages,
  pickUpNext,
  type PanelView,
} from "../panel-view";
import { transformIssues, buildViewNodes } from "../panel-view-renderer";
import { stageForIssue, type WorkStage } from "../work-stage";
import {
  isParked,
  clearStaleOverride,
  DEFAULT_PARKING,
  type ParkingConfig,
  type ParkOverride,
} from "../parking";
import { selectGhosts, ghostCapValue, type GhostQueue } from "../ghosts";
import {
  linkKey,
  resolveIssueSession,
  ISSUE_LINK_OPTION,
  type IssueSessionInfo,
} from "../issue-session";
import { collapseStatusRows, parseStatusLine, type StatusSessionRow } from "./status";
import { handleIssue } from "./issue";
import type { Issue, WorkflowState } from "../adapters/types";
import type { ParsedCtlArgs } from "../cli";

// --- Output shapes -----------------------------------------------------------

export interface BoardIssue {
  id: string;
  identifier: string;
  title: string;
  status: string;
  priority: number | null;
  team: string | null;
  url: string;
}

export interface BoardSession {
  id: string;
  name: string;
  path: string | null;
  branch: string | null;
  agent: { state: string; since: number | null; ageSeconds: number | null } | null;
  attention: boolean;
  attentionReason: string | null;
  pinned: boolean;
  parked: boolean;
  issue: BoardIssue | null;
  /**
   * Same three answers as `ctl status`: null is a session nobody adopted,
   * `deleted` a dangling stamp. Flattening them would hide a real
   * misconfiguration behind "no project".
   */
  project: { id: string; title: string } | { id: string; state: "deleted" } | null;
}

/**
 * The Project a board row reports. Same three answers as `ctl status`, and the
 * same reason: a dangling stamp is a real misconfiguration an agent can act on,
 * and must not read as "no project".
 */
function resolveBoardProject(
  stampedId: string,
  projects: readonly ProjectConfig[],
): BoardSession["project"] {
  if (!stampedId) return null;
  const match = projects.find((p) => p.id === stampedId);
  if (!match) return null;
  if (match.deletedAt !== undefined) return { id: match.id, state: "deleted" };
  return { id: match.id, title: match.title };
}

export interface BoardStage {
  id: string;
  label: string;
  /** Position in the workflow screen — the user's own priority order. */
  rank: number;
  statuses: string[];
  /** Draws a band in the sidebar (`s` in the workflow screen). */
  inSidebar: boolean;
  /** Contributes unstarted rows to the sidebar (`space` there). */
  showsUnstarted: boolean;
  /** Position in the `Ctrl-Space u` rotation, or null when not in it. */
  upNextRank: number | null;
  counts: { issues: number; sessions: number; parked: number; unstarted: number };
  sessions: BoardSession[];
  unstarted: BoardIssue[];
}

export interface Board {
  stages: BoardStage[];
  /** Sessions with no issue, or whose status no stage claims — the sidebar's
   * flat remainder below the bands. */
  ungrouped: BoardSession[];
  upNext: { stageId: string; stageLabel: string; issue: BoardIssue } | null;
  /**
   * `pipeline.showUnstartedInSidebar`: how many unstarted rows *the sidebar*
   * shows per stage (0 = none, `"all"` = every one). Reported, not applied —
   * `unstarted` below is always the full list, and this is what an agent needs
   * to reconcile it with what the human is looking at.
   */
  unstartedCap: number | "all";
}

// --- Pure builders -----------------------------------------------------------

export function toBoardIssue(issue: Issue): BoardIssue {
  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    status: issue.status,
    priority: issue.priority ?? null,
    team: issue.team ?? null,
    url: issue.webUrl,
  };
}

/**
 * Every issues queue's contents, in the order its own tab renders them.
 *
 * A transcription of `main.ts`'s `orderedIssuesByView` onto injected arguments.
 * Reusing `buildViewNodes` is what makes "the top of the list" mean the same
 * thing to `workflow next` and to `Ctrl-Space u`; a second sort here would drift.
 */
export function orderedIssuesByView(
  views: PanelView[],
  issues: Issue[],
  sessionStates: Map<string, IssueSessionInfo>,
  stageOf: (issue: { status: string }) => WorkStage,
): Map<string, Issue[]> {
  const byView = new Map<string, Issue[]>();
  for (const view of views) {
    if (view.source !== "issues") continue;
    const mine = issues.filter((i) => matchesIssueFilter(i, effectiveFilter(view), stageOf));
    // No MR map: it only decorates a row with its pipeline colour, which no
    // sort axis reads, and building it would cost an extra tracker round-trip.
    const items = transformIssues(mine, new Set(), sessionStates, new Map());
    byView.set(
      view.id,
      buildViewNodes(items, view, new Set())
        .filter((n) => n.kind === "item" && n.item.type === "issue")
        .map((n) => (n as Extract<typeof n, { kind: "item" }>).item.raw as Issue),
    );
  }
  return byView;
}

export interface BoardSessionInput {
  id: string;
  name: string;
  path: string | null;
  branch: string | null;
  agent: BoardSession["agent"];
  attention: boolean;
  attentionReason: string | null;
  pinned: boolean;
  /** `session_activity`, epoch ms — feeds `parking.autoParkIdleDays`. */
  lastActivity: number;
  /** The `@jmux-project` stamp, or "" when the session carries none. */
  projectId?: string;
}

export interface BoardInputs {
  views: PanelView[];
  /** `pipeline.upNext` — the ordered stage ids `Ctrl-Space u` walks. */
  upNextOrder: string[];
  /** `pipeline.parkedStates` — the statuses whose sessions park. */
  parkedStates: string[];
  /** Including soft-deleted, so a dangling stamp is reportable. */
  projects?: readonly ProjectConfig[];
  parking: ParkingConfig;
  unstartedCap: number | "all";
  sessions: BoardSessionInput[];
  issuesByView: Map<string, Issue[]>;
  /** Issue id → the session that claims it, from `resolveIssueSession`. */
  issueSessionStates: Map<string, IssueSessionInfo>;
  /** All issues, for the session → issue inversion. */
  issues: Issue[];
  /** The user's stored manual park decision, with the stage it was made at. */
  parkOverride: (sessionName: string) => ParkOverride | null;
  nowMs: number;
}

export function buildBoard(inp: BoardInputs): Board {
  const stages = parkedStages(inp.parkedStates);
  const categoryOf = (issue: Pick<Issue, "status" | "stateType" | "team">) =>
    stageForIssue(issue, stages);

  // Session → issue is the inverse of the issue → session resolution. Only a
  // resolved *session* counts; an issue with a worktree and no session has not
  // been started, and claiming a session for it would invent one.
  const issueBySession = new Map<string, Issue>();
  for (const issue of inp.issues) {
    const info = inp.issueSessionStates.get(issue.id);
    if (info?.state !== "session") continue;
    if (!issueBySession.has(info.sessionName)) issueBySession.set(info.sessionName, issue);
  }

  const rows: Array<{ session: BoardSession; stageId: string | null }> = inp.sessions.map((s) => {
    const issue = issueBySession.get(s.name) ?? null;
    const category = issue ? categoryOf(issue) : null;
    // Read-only application of the same staleness rule the TUI applies on
    // write: an override answers "for this situation", and once the issue has
    // moved on it no longer applies.
    const override = clearStaleOverride(inp.parkOverride(s.name), category);
    const parked = isParked(
      {
        name: s.name,
        stage: category,
        manual: override?.manual ?? null,
        // The rolled-up agent state and nothing else, matching
        // `recomputeSessionBands`. The orchestrator-set `@jmux-attention` flag
        // is arguably also "something wants you", but the TUI's parking does
        // not consult it, and a CLI that unparked on a signal the sidebar
        // ignores would put the agent and the human on different boards — the
        // exact failure this command exists to avoid. Changing that is a
        // TUI-side decision, not one to make here unilaterally.
        attention: s.agent?.state === "waiting",
        // Empty by construction — see the header note on poll-driven signals.
        signals: new Set(),
        lastActivity: s.lastActivity,
      },
      inp.parking,
      inp.nowMs,
    );

    // A stage claims a session through its issue's *status*, exactly as
    // `recomputeSessionBands` does. A hidden stage still claims here: the
    // sidebar drops the band, but the stage is still where the work is.
    const stageView = issue ? stageForState(inp.views, issue.status) : null;

    return {
      stageId: stageView?.id ?? null,
      session: {
        id: s.id,
        name: s.name,
        path: s.path,
        branch: s.branch,
        agent: s.agent,
        attention: s.attention,
        attentionReason: s.attentionReason,
        pinned: s.pinned,
        parked,
        issue: issue ? toBoardIssue(issue) : null,
        project: resolveBoardProject(s.projectId ?? "", inp.projects ?? []),
      },
    };
  });

  const unstartedByStage = groupUnstarted(inp, categoryOf);

  const issueViews = inp.views.filter((v) => v.source === "issues");
  const stageRows: BoardStage[] = issueViews.map((view) => {
    const sessions = rows.filter((r) => r.stageId === view.id).map((r) => r.session);
    const unstarted = unstartedByStage.get(view.id) ?? [];
    const upNextRank = inp.upNextOrder.indexOf(view.id);
    return {
      id: view.id,
      label: view.label,
      rank: inp.views.indexOf(view),
      statuses: view.states ?? [],
      inSidebar: stageInSidebar(view),
      showsUnstarted: stageShowsUnstarted(view),
      upNextRank: upNextRank < 0 ? null : upNextRank,
      counts: {
        issues: inp.issuesByView.get(view.id)?.length ?? 0,
        sessions: sessions.length,
        parked: sessions.filter((s) => s.parked).length,
        unstarted: unstarted.length,
      },
      sessions,
      unstarted,
    };
  });

  const picked = pickUpNext(inp.upNextOrder, inp.issuesByView);
  const upNextView = picked ? inp.views.find((v) => v.id === picked.viewId) : null;

  return {
    stages: stageRows,
    ungrouped: rows.filter((r) => r.stageId === null).map((r) => r.session),
    upNext: picked
      ? {
          stageId: picked.viewId,
          stageLabel: upNextView?.label ?? picked.viewId,
          issue: toBoardIssue(picked.item),
        }
      : null,
    unstartedCap: inp.unstartedCap,
  };
}

/**
 * Unstarted work per stage, through the sidebar's own selector so "unstarted"
 * means one thing: no session, and not lifecycle-dead (a completed or parked
 * issue would otherwise sit in the list forever, since nothing ever gives it a
 * session). Uncapped — the cap is a sidebar display budget, reported separately.
 */
function groupUnstarted(
  inp: BoardInputs,
  categoryOf: (issue: Pick<Issue, "status" | "stateType" | "team">) => WorkStage,
): Map<string, BoardIssue[]> {
  const byId = new Map(inp.issues.map((i) => [i.id, i]));
  const queues: GhostQueue[] = [];
  for (const view of inp.views) {
    if (view.source !== "issues") continue;
    queues.push({
      viewId: view.id,
      label: view.label,
      rank: inp.views.indexOf(view),
      issues: (inp.issuesByView.get(view.id) ?? []).map((issue) => {
        const category = categoryOf(issue);
        return {
          id: issue.id,
          identifier: issue.identifier,
          title: issue.title,
          hasSession: inp.issueSessionStates.get(issue.id)?.state === "session",
          inactive: category === "done" || category === "parked",
        };
      }),
    });
  }

  const out = new Map<string, BoardIssue[]>();
  for (const entry of selectGhosts(queues, Infinity)) {
    const issue = byId.get(entry.issueId);
    if (!issue || !entry.stageId) continue;
    const list = out.get(entry.stageId) ?? [];
    list.push(toBoardIssue(issue));
    out.set(entry.stageId, list);
  }
  return out;
}

export interface BoardSummary {
  stages: Array<Omit<BoardStage, "sessions" | "unstarted">>;
  /** A count here, where the board carries the rows. */
  ungrouped: number;
  upNext: Board["upNext"];
  unstartedCap: Board["unstartedCap"];
}

/**
 * The board without its item arrays.
 *
 * A projection rather than a second query: the counts a caller reads here are
 * literally the ones on the rows it would have got, so `stages` and `board` can
 * never disagree about how much work is where.
 */
export function summarizeBoard(board: Board): BoardSummary {
  return {
    stages: board.stages.map(({ sessions: _s, unstarted: _u, ...rest }) => rest),
    ungrouped: board.ungrouped.length,
    upNext: board.upNext,
    unstartedCap: board.unstartedCap,
  };
}

export interface StatusRow {
  name: string;
  type: string;
  stage: { id: string; label: string } | null;
  parks: boolean;
  issues: number;
}

/**
 * Every tracker status with what jmux does about it — the workflow screen's
 * second block. This is what an agent reads before `issue move`: the names it
 * may move an issue to, and where each one will land it.
 */
export function buildStatusTable(
  states: readonly WorkflowState[],
  views: PanelView[],
  parkedStates: readonly string[],
  issues: readonly Issue[],
): StatusRow[] {
  const counts = new Map<string, number>();
  for (const issue of issues) {
    const key = (issue.status ?? "").trim().toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  // listWorkflowStates unions every team, so the same name recurs.
  const seen = new Set<string>();
  const rows: StatusRow[] = [];
  for (const state of states) {
    const key = state.name.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const stage = stageForState(views, state.name);
    rows.push({
      name: state.name,
      type: state.type,
      stage: stage ? { id: stage.id, label: stage.label } : null,
      parks: isParkedState(parkedStates, state.name),
      issues: counts.get(key) ?? 0,
    });
  }
  return rows;
}

// --- Gathering ---------------------------------------------------------------

const SESSION_ACTIVITY_FORMAT = ["#{session_id}", "#{session_activity}"].join(US);

function readSessionActivity(ctx: CliContext): Map<string, number> {
  const result = runTmuxDirect(
    ["list-sessions", "-f", INTERNAL_SESSION_FILTER, "-F", SESSION_ACTIVITY_FORMAT],
    ctx.socket,
  );
  const out = new Map<string, number>();
  if (!result.ok) return out;
  for (const line of result.lines) {
    const [id, activity] = splitFields(line);
    const seconds = Number(activity);
    if (id && Number.isFinite(seconds)) out.set(id, seconds * 1000);
  }
  return out;
}

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

function readSessionRows(ctx: CliContext): StatusSessionRow[] {
  const result = runTmuxDirect(
    ["list-panes", "-a", "-f", INTERNAL_SESSION_FILTER, "-F", STATUS_FORMAT],
    ctx.socket,
  );
  const lines = result.ok ? result.lines : [];
  return collapseStatusRows(
    lines.map(parseStatusLine).filter((r): r is StatusSessionRow => r !== null),
  );
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

function parkingConfig(config: JmuxConfig): ParkingConfig {
  return {
    unparkOn: config.pipeline?.unparkOn ?? DEFAULT_PARKING.unparkOn,
    autoParkIdleDays: config.pipeline?.autoParkIdleDays ?? DEFAULT_PARKING.autoParkIdleDays,
  };
}

async function authenticatedTracker(): Promise<LinearAdapter> {
  const adapter = new LinearAdapter({});
  await adapter.authenticate();
  if (adapter.authState !== "ok") {
    throw new CliError(
      `issue tracker not authenticated (${adapter.authHint}) — the work pipeline needs one`,
    );
  }
  return adapter;
}

/** Read config + tmux + tracker and reduce them to the board. */
async function gatherBoard(ctx: CliContext): Promise<Board> {
  const config = loadUserConfig();
  const views = parseViews(config.panelViews);
  const adapter = await authenticatedTracker();
  // The same call the TUI's global poll makes, so the issue universe matches.
  const issues = await adapter.getMyIssues();

  const rows = readSessionRows(ctx);
  const activity = readSessionActivity(ctx);
  const sessionState = new SessionState(
    resolve(homedir(), ".config", "jmux", "state.json"),
  );

  // Explicit links from both stores, keyed for `resolveIssueSession` — see
  // `linkKey`. state.json holds the tracker's id, the tmux option an identifier.
  const links = new Map<string, string>();
  const addLink = (raw: string, session: string) => {
    const key = linkKey(raw);
    if (key && !links.has(key)) links.set(key, session);
  };
  for (const row of rows) {
    for (const id of sessionState.getLinkedIssueIds(row.name)) addLink(id, row.name);
    for (const id of row.linearIssues) addLink(id, row.name);
  }

  const liveSessions = new Set(rows.map((r) => r.name));
  const repoFacts = new RepoFactsCache();
  // Through Projects. resolveForRepo reads config.repos, which the migration
  // deletes — so this silently returned the built-in template and ignored
  // whatever the user had configured.
  const templateFor = (repoDir: string) =>
    resolveSettingsFor(config, { dir: repoDir, bare: repoFacts.get(repoDir).bare })
      .sessionNameTemplate;
  // Same router as the TUI: a board that resolved repos differently from the
  // sidebar is the disagreement the shared-module rule exists to prevent.
  const repoDirFor = (issue: Issue): string | null => {
    const outcome = resolveIssueProject(
      {
        id: issue.id,
        teamId: issue.teamId,
        teamName: issue.team ?? undefined,
        linearProjectId: issue.linearProjectId,
      },
      config.projects ?? [],
      config.routes ?? {},
    );
    return outcome.kind === "resolved" ? outcome.project.dir : null;
  };

  const issueSessionStates = new Map<string, IssueSessionInfo>();
  for (const issue of issues) {
    const repoDir = repoDirFor(issue);
    const info = resolveIssueSession({
      issue,
      links,
      liveSessions,
      repoDir,
      sessionNameTemplate: repoDir ? templateFor(repoDir) : "",
      worktreeExists: existsSync,
    });
    if (info) issueSessionStates.set(issue.id, info);
  }

  const parked = config.pipeline?.parkedStates ?? [];
  const categoryStages = parkedStages(parked);
  const issuesByView = orderedIssuesByView(views, issues, issueSessionStates, (issue) =>
    stageForIssue(issue as Issue, categoryStages),
  );

  const branchCache = new Map<string, string | null>();
  const branchByPath = (path: string): string | null => {
    const hit = branchCache.get(path);
    if (hit !== undefined) return hit;
    const branch = gitBranch(path);
    branchCache.set(path, branch);
    return branch;
  };

  const nowSeconds = Math.floor(Date.now() / 1000);
  const pinned = new Set(config.pinnedSessions ?? []);
  return buildBoard({
    views,
    upNextOrder: config.pipeline?.upNext ?? [],
    parkedStates: parked,
    // Soft-deleted included, so a dangling stamp reports `deleted` rather than
    // being indistinguishable from a session nobody adopted.
    projects: config.projects ?? [],
    parking: parkingConfig(config),
    unstartedCap: capValue(config),
    issues,
    issuesByView,
    issueSessionStates,
    parkOverride: (name) => sessionState.getParkOverride(name),
    nowMs: Date.now(),
    sessions: rows.map((row) => {
      const since = Number(row.agentSince);
      const validSince = row.agentSince && Number.isFinite(since) && since > 0
        ? Math.floor(since)
        : null;
      const hasState = ["running", "waiting", "complete"].includes(row.agentState);
      return {
        id: row.id,
        name: row.name,
        path: row.path || null,
        branch: row.path ? branchByPath(row.path) : null,
        agent: hasState
          ? {
              state: row.agentState,
              since: validSince,
              ageSeconds: validSince !== null ? Math.max(0, nowSeconds - validSince) : null,
            }
          : null,
        attention: row.attention === "1",
        attentionReason: row.attention === "1" ? row.attentionReason || null : null,
        pinned: pinned.has(row.name),
        lastActivity: activity.get(row.id) ?? Date.now(),
        projectId: row.projectId,
      };
    }),
  });
}

/** The stored cap in the shape the response reports: a count, or `"all"`. */
function capValue(config: JmuxConfig): number | "all" {
  const n = ghostCapValue(config.pipeline?.showUnstartedInSidebar ?? null);
  return n === Infinity ? "all" : n;
}

/**
 * The board's sessions re-bucketed by Project.
 *
 * Keyed on the Project *id*, never its title — two Projects may share one, and
 * merging them would put two teams' work under one heading. A session with no
 * `@jmux-project` stamp is reported under a null id rather than dropped: an
 * unadopted session is a fact an agent needs, and silently omitting it makes
 * the board disagree with `ctl session list`.
 */
export interface BoardProjectGroup {
  id: string | null;
  title: string | null;
  sessions: unknown[];
}

function groupBoardByProject(board: Awaited<ReturnType<typeof gatherBoard>>): unknown {
  const groups = new Map<string | null, BoardProjectGroup>();
  const every = [...board.stages.flatMap((st) => st.sessions), ...board.ungrouped];
  for (const session of every) {
    const project = (session as { project?: { id?: string; title?: string } | null }).project ?? null;
    const id = project?.id ?? null;
    let group = groups.get(id);
    if (!group) {
      group = { id, title: project?.title ?? null, sessions: [] };
      groups.set(id, group);
    }
    group.sessions.push(session);
  }
  // Unadopted last: it is the residue, not a peer.
  const ordered = [...groups.values()].sort((a, b) =>
    a.id === null ? 1 : b.id === null ? -1 : a.id.localeCompare(b.id));
  return {
    groupedBy: "project",
    projects: ordered,
    upNext: board.upNext,
    unstartedCap: board.unstartedCap,
  };
}

function narrowToStage(board: Board, stageId: string): Board {
  const stage = board.stages.find((s) => s.id === stageId);
  if (!stage) {
    throw new CliError(
      `unknown stage "${stageId}". Known stages: ${board.stages.map((s) => s.id).join(", ") || "none"}`,
    );
  }
  return { ...board, stages: [stage] };
}

// --- Handler -----------------------------------------------------------------

export async function handleWorkflow(
  ctx: CliContext,
  parsed: ParsedCtlArgs,
): Promise<unknown> {
  switch (parsed.action) {
    case "stages": {
      const board = await gatherBoard(ctx);
      return summarizeBoard(board);
    }

    case "board": {
      const board = await gatherBoard(ctx);
      const stage = typeof parsed.flags.stage === "string" ? parsed.flags.stage : null;
      const narrowed = stage ? narrowToStage(board, stage) : board;
      // `--group project` re-buckets the same sessions the stage view already
      // resolved, rather than re-deriving membership: an agent grouping one way
      // and a human reading the other must not see different sets.
      return parsed.flags.group === "project" ? groupBoardByProject(narrowed) : narrowed;
    }

    case "next": {
      const board = await gatherBoard(ctx);
      if (!board.upNext) {
        // Not an error: an empty rotation and an empty queue are both ordinary
        // states, and a caller polling for work must be able to see "nothing".
        return { upNext: null, started: null };
      }
      if (parsed.flags.start !== true) return { upNext: board.upNext, started: null };
      // Same flow as `issue start`, so there is one implementation of starting.
      const started = await handleIssue(ctx, {
        ...parsed,
        group: "issue",
        action: "start",
        positional: [board.upNext.issue.identifier],
      });
      return { upNext: board.upNext, started };
    }

    case "statuses": {
      const config = loadUserConfig();
      const views = parseViews(config.panelViews);
      const adapter = await authenticatedTracker();
      const [states, issues] = await Promise.all([
        adapter.listWorkflowStates(),
        adapter.getMyIssues(),
      ]);
      return {
        statuses: buildStatusTable(states, views, config.pipeline?.parkedStates ?? [], issues),
      };
    }

    default:
      throw new CliError(
        `Unknown workflow action "${parsed.action}". Known actions: stages, board, next, statuses`,
      );
  }
}
