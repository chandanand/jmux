export interface PipelineStatus {
  state: "running" | "passed" | "failed" | "pending" | "canceled";
  webUrl: string;
}

export interface MergeRequest {
  id: string;
  title: string;
  status: "draft" | "open" | "merged" | "closed";
  sourceBranch: string;
  targetBranch: string;
  pipeline: PipelineStatus | null;
  approvals: { required: number; current: number };
  webUrl: string;
  author?: string;
  reviewers?: string[];
  createdAt?: number;  // epoch ms
  updatedAt?: number;  // epoch ms
}

/**
 * Stable workflow position. Mirrors Linear's own state categories — including
 * `duplicate`, which is easy to miss because it never appears in a default
 * workflow but is returned for closed-as-duplicate issues.
 */
export type IssueStateType =
  | "triage" | "backlog" | "unstarted" | "started" | "completed" | "canceled" | "duplicate";

export interface Issue {
  id: string;
  identifier: string;
  title: string;
  status: string;
  stateType?: IssueStateType;  // stable workflow position; status name varies per workspace
  assignee: string | null;
  linkedMrUrls: string[];
  webUrl: string;
  team?: string;
  project?: string;
  priority?: number;   // 0=none, 1=urgent, 2=high, 3=medium, 4=low
  updatedAt?: number;  // epoch ms
  description?: string;
  branchName?: string;  // Linear's suggested branch name
  labels?: Array<{ name: string; group?: string }>;
  comments?: Array<{
    id?: string;
    parentId?: string;
    author: string;
    body: string;
    createdAt: string;
  }>;
  links?: Array<{ type: string; title?: string; url: string }>;
}

/**
 * One workflow state a tracker offers, across all teams. Needed as a *global*
 * list (not the per-issue `getAvailableStatuses`) so settings can offer a
 * picker of real state names before any particular issue is selected.
 */
export interface WorkflowState {
  id: string;
  name: string;
  type: IssueStateType;
  team?: string;
}

export interface BranchContext {
  sessionName: string;
  remote: string;
  branch: string;
}

export interface SessionContext {
  sessionName: string;
  dir: string;
  branch: string | null;
  remote: string | null;
  mrs: Array<MergeRequest & { source: LinkSource }>;
  issues: Array<Issue & { source: LinkSource }>;
  resolvedAt: number;
  /**
   * An API call this resolution attempted threw, so the context is incomplete —
   * a persisted link may be missing purely because the tracker was unreachable.
   *
   * Load-bearing: contexts are cached, so without this a single network blip
   * during resolution would blank a session's links until the process restarts.
   * The background pass re-resolves anything flagged here.
   */
  degraded?: boolean;
}

/**
 * `unreachable` is deliberately distinct from `failed`. A revoked token and a
 * dropped network used to be the same state, which meant a blip at startup
 * latched the adapter off for the whole run — and, now that adapters can be
 * swapped, would let a transient failure block a swap that was actually fine.
 */
export type AdapterAuthState = "ok" | "failed" | "unreachable" | "unauthenticated";

/** Who the credential belongs to, for display and cross-workspace warnings. */
export interface AdapterIdentity {
  account: string;
  organization: string | null;
}

export type LinkSource = "manual" | "branch" | "mr-link" | "transitive";

export interface CodeHostAdapter {
  type: string;
  authState: AdapterAuthState;
  authHint: string;
  /** Populated by a successful `authenticate()`; null otherwise. */
  identity: AdapterIdentity | null;

  authenticate(): Promise<void>;
  getMergeRequest(remote: string, branch: string): Promise<MergeRequest | null>;
  pollMergeRequest(mrId: string): Promise<MergeRequest>;
  pollAllMergeRequests(remotes: BranchContext[]): Promise<Map<string, MergeRequest>>;
  openInBrowser(mrId: string): void;
  markReady(mrId: string): Promise<void>;
  approve(mrId: string): Promise<void>;
  searchMergeRequests(query: string): Promise<MergeRequest[]>;
  parseMrUrl(url: string): string | null;
  pollMergeRequestsByIds(ids: string[]): Promise<Map<string, MergeRequest>>;
  getMyMergeRequests(): Promise<MergeRequest[]>;
  getMrsAwaitingMyReview(): Promise<MergeRequest[]>;
}

export interface IssueTrackerAdapter {
  type: string;
  authState: AdapterAuthState;
  authHint: string;
  /** Populated by a successful `authenticate()`; null otherwise. */
  identity: AdapterIdentity | null;

  authenticate(): Promise<void>;
  getLinkedIssue(mrUrl: string): Promise<Issue | null>;
  getIssueByBranch(branch: string): Promise<Issue | null>;
  pollIssue(issueId: string): Promise<Issue>;
  pollAllIssues(issueIds: string[]): Promise<Map<string, Issue>>;
  getAvailableStatuses(issueId: string): Promise<string[]>;
  /**
   * Every workflow state across every team, de-duplicated by name. Trackers
   * with no real workflow (only open/closed) return a short list, which is the
   * signal that stage mapping has little to work with.
   */
  listWorkflowStates(): Promise<WorkflowState[]>;
  openInBrowser(issueId: string): void;
  updateStatus(issueId: string, status: string): Promise<void>;
  createIssue(teamId: string, title: string, description: string): Promise<Issue>;
  searchIssues(query: string): Promise<Issue[]>;
  getMyIssues(): Promise<Issue[]>;
  getTeams(): Promise<Array<{ id: string; name: string }>>;
  buildPrompt(issue: Issue): string;
  /** Seed prompt for a session carrying several issues; `label` names the group. */
  buildGroupPrompt(issues: Issue[], label: string): string;
}

export interface AdapterConfig {
  codeHost?: { type: string; [key: string]: unknown };
  issueTracker?: { type: string; [key: string]: unknown };
}

export class HttpError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}
