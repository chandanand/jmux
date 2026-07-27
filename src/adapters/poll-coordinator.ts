import { resolveSessionContext } from "./context-resolver";
import { logError } from "../log";
import {
  HttpError,
  type CodeHostAdapter,
  type IssueTrackerAdapter,
  type SessionContext,
  type BranchContext,
  type Issue,
  type MergeRequest,
} from "./types";
import { getGitBranch } from "./context-resolver";
import type { SessionState } from "../session-state";

const ACTIVE_INTERVAL_MS = 20_000;
const BACKGROUND_INTERVAL_MS = 180_000;
const RATE_LIMITED_ACTIVE_MS = 60_000;
const GLOBAL_INTERVAL_MS = 300_000; // 5 minutes

/**
 * How many sessions resolve their context at once during backfill.
 *
 * Resolving is several API calls per session (branch MR, branch issue, one per
 * manual link, forward and transitive links), and a restart backfills every
 * session at once — so this is what keeps "jmux started" from becoming a
 * hundred-request burst. Low enough to be polite, high enough that a dozen
 * sessions fill in within a few seconds.
 */
const BACKFILL_CONCURRENCY = 3;

export type RateLimitState = "normal" | "rate_limited" | "hard_limited";

export interface PollCoordinatorOptions {
  codeHost: CodeHostAdapter | null;
  issueTracker: IssueTrackerAdapter | null;
  onUpdate: (sessionName: string) => void;
  getSessionDir: (sessionName: string) => string | null;
  sessionState: SessionState | null;
}

export class PollCoordinator {
  private opts: PollCoordinatorOptions;
  private contexts = new Map<string, SessionContext>();
  private sessionDirs = new Map<string, string>();
  private activeSession: string | null = null;
  private activeTimer: ReturnType<typeof setInterval> | null = null;
  private backgroundTimer: ReturnType<typeof setInterval> | null = null;
  private globalTimer: ReturnType<typeof setInterval> | null = null;
  private _rateLimitState: RateLimitState = "normal";
  private globalIssues: Issue[] = [];
  private globalMrs: MergeRequest[] = [];
  private globalReviewMrs: MergeRequest[] = [];

  // --- Context backfill ---
  //
  // `contexts` is in-memory only, so every session starts a run unresolved —
  // including ones whose links are sitting in state.json. Resolution used to be
  // reachable only through the *active* session, which meant a persisted link
  // came back only for whichever session you happened to be attached to, and a
  // newly created session stayed unlinked until you first visited it.
  //
  // So a session is resolved when jmux first learns of it, not when you first
  // look at it. `pending` is the queue, `inFlight` bounds concurrency, and
  // `degradedSessions` holds the ones whose resolution hit a failing API and
  // should be retried on the next background sweep — retrying them inline would
  // spin against a network that is down.
  private pending = new Set<string>();
  private inFlight = new Set<string>();
  private degradedSessions = new Set<string>();
  /** Backfill waits for start(), which main.ts calls once adapter auth settles. */
  private started = false;

  get rateLimitState(): RateLimitState {
    return this._rateLimitState;
  }

  get codeHost(): CodeHostAdapter | null {
    return this.opts.codeHost;
  }

  get issueTracker(): IssueTrackerAdapter | null {
    return this.opts.issueTracker;
  }

  getGlobalIssues(): Issue[] { return this.globalIssues; }
  getGlobalMrs(): MergeRequest[] { return this.globalMrs; }
  getGlobalReviewMrs(): MergeRequest[] { return this.globalReviewMrs; }

  addGlobalIssue(issue: Issue): void {
    const idx = this.globalIssues.findIndex((i) => i.id === issue.id);
    if (idx >= 0) {
      this.globalIssues[idx] = issue;
    } else {
      this.globalIssues.unshift(issue);
    }
    this.opts.onUpdate("__global__");
  }

  // Optimistic in-memory link mutators. SessionState persists the link to
  // disk; resolveContext only re-reads that disk state on initial resolve, so
  // without these mutators the rendered context wouldn't reflect a freshly
  // added or removed link until the user reopened the session.

  addLinkedIssue(sessionName: string, issue: Issue): void {
    const ctx = this.contexts.get(sessionName);
    if (!ctx) return;
    if (ctx.issues.some((i) => i.id === issue.id)) return;
    ctx.issues.push({ ...issue, source: "manual" });
    ctx.resolvedAt = Date.now();
    this.opts.onUpdate(sessionName);
  }

  removeLinkedIssue(sessionName: string, issueId: string): void {
    const ctx = this.contexts.get(sessionName);
    if (!ctx) return;
    const idx = ctx.issues.findIndex((i) => i.id === issueId);
    if (idx < 0) return;
    ctx.issues.splice(idx, 1);
    ctx.resolvedAt = Date.now();
    this.opts.onUpdate(sessionName);
  }

  addLinkedMr(sessionName: string, mr: MergeRequest): void {
    const ctx = this.contexts.get(sessionName);
    if (!ctx) return;
    if (ctx.mrs.some((m) => m.id === mr.id)) return;
    ctx.mrs.push({ ...mr, source: "manual" });
    ctx.resolvedAt = Date.now();
    this.opts.onUpdate(sessionName);
  }

  removeLinkedMr(sessionName: string, mrId: string): void {
    const ctx = this.contexts.get(sessionName);
    if (!ctx) return;
    const idx = ctx.mrs.findIndex((m) => m.id === mrId);
    if (idx < 0) return;
    ctx.mrs.splice(idx, 1);
    ctx.resolvedAt = Date.now();
    this.opts.onUpdate(sessionName);
  }

  constructor(opts: PollCoordinatorOptions) {
    this.opts = opts;
  }

  start(): void {
    // Backfill is gated on this rather than on addSession, because the session
    // list is discovered before adapter auth finishes. Resolving early would
    // see authState !== "ok", skip every API call, and cache a context with no
    // links in it — the exact failure this backfill exists to prevent.
    this.started = true;
    void this.drainBackfill();
    this.startActivePolling();
    this.startBackgroundPolling();
    this.startGlobalPolling();
  }

  stop(): void {
    this.started = false;
    if (this.activeTimer) { clearInterval(this.activeTimer); this.activeTimer = null; }
    if (this.backgroundTimer) { clearInterval(this.backgroundTimer); this.backgroundTimer = null; }
    if (this.globalTimer) { clearInterval(this.globalTimer); this.globalTimer = null; }
  }

  async pollGlobal(): Promise<void> {
    const { codeHost, issueTracker } = this.opts;

    if (issueTracker && issueTracker.authState === "ok") {
      try {
        this.globalIssues = await issueTracker.getMyIssues();
      } catch (e) {
        logError("PollCoordinator", `global issues poll failed: ${(e as Error).message}`);
      }
    }

    if (codeHost && codeHost.authState === "ok") {
      try {
        this.globalMrs = await codeHost.getMyMergeRequests();
      } catch (e) {
        logError("PollCoordinator", `global MRs poll failed: ${(e as Error).message}`);
      }
      try {
        this.globalReviewMrs = await codeHost.getMrsAwaitingMyReview();
      } catch (e) {
        logError("PollCoordinator", `global review MRs poll failed: ${(e as Error).message}`);
      }
    }

    this.opts.onUpdate("__global__");
  }

  optimisticIssueStatus(issueId: string, status: string): void {
    for (const issue of this.globalIssues) {
      if (issue.id === issueId) { issue.status = status; break; }
    }
    for (const [, ctx] of this.contexts) {
      for (const issue of ctx.issues) {
        if (issue.id === issueId) { issue.status = status; break; }
      }
    }
    this.opts.onUpdate("__global__");
  }

  async refreshGlobalItem(type: "mr" | "issue", id: string): Promise<void> {
    const { codeHost, issueTracker } = this.opts;
    if (type === "mr" && codeHost && codeHost.authState === "ok") {
      try {
        const fresh = await codeHost.pollMergeRequest(id);
        const idx = this.globalMrs.findIndex((m) => m.id === id);
        if (idx >= 0) this.globalMrs[idx] = fresh;
        const ridx = this.globalReviewMrs.findIndex((m) => m.id === id);
        if (ridx >= 0) this.globalReviewMrs[ridx] = fresh;
      } catch (e) {
        logError("PollCoordinator", `refresh MR failed: ${(e as Error).message}`);
      }
    }
    if (type === "issue" && issueTracker && issueTracker.authState === "ok") {
      try {
        const fresh = await issueTracker.pollIssue(id);
        const idx = this.globalIssues.findIndex((i) => i.id === id);
        if (idx >= 0) this.globalIssues[idx] = fresh;
      } catch (e) {
        logError("PollCoordinator", `refresh issue failed: ${(e as Error).message}`);
      }
    }
    this.opts.onUpdate("__global__");
  }

  addSession(name: string, dir: string): void {
    this.sessionDirs.set(name, dir);
    // Called for every session on every session-list refresh, so this has to be
    // idempotent: already-resolved sessions are skipped, and the queue is a set.
    this.enqueueBackfill(name);
  }

  removeSession(name: string): void {
    this.sessionDirs.delete(name);
    this.contexts.delete(name);
    this.pending.delete(name);
    this.degradedSessions.delete(name);
  }

  /** Queue a session for context resolution unless it already has a good one. */
  private enqueueBackfill(name: string): void {
    if (this.inFlight.has(name)) return;
    if (this.contexts.has(name) && !this.degradedSessions.has(name)) return;
    this.pending.add(name);
    void this.drainBackfill();
  }

  /**
   * Resolve queued sessions, at most BACKFILL_CONCURRENCY at a time.
   *
   * Deliberately does not re-queue on failure: `resolveContext` records a
   * degraded result instead, and the background sweep retries it on its own
   * cadence. Retrying here would busy-loop against an unreachable tracker.
   */
  private async drainBackfill(): Promise<void> {
    // Backs off on any rate limit, matching the background pass — backfill is
    // the most request-hungry thing here and the worst to run while throttled.
    // Queued names survive; reportRateLimit("normal") restarts and drains them.
    if (!this.started || this._rateLimitState !== "normal") return;
    while (this.pending.size > 0 && this.inFlight.size < BACKFILL_CONCURRENCY) {
      const name: string = this.pending.values().next().value!;
      this.pending.delete(name);
      if (!this.sessionDirs.has(name)) continue;      // died while queued
      if (this.contexts.has(name) && !this.degradedSessions.has(name)) continue;
      this.inFlight.add(name);
      void this.resolveContext(name).finally(() => {
        this.inFlight.delete(name);
        void this.drainBackfill();
      });
    }
  }

  async setActiveSession(name: string): Promise<void> {
    this.activeSession = name;
    if (!this.contexts.has(name)) {
      await this.resolveContext(name);
    }
  }

  getContext(session: string): SessionContext | null {
    return this.contexts.get(session) ?? null;
  }

  getAllContexts(): Map<string, SessionContext> {
    return this.contexts;
  }

  reportRateLimit(state: RateLimitState): void {
    this._rateLimitState = state;
    this.stop();
    if (state !== "hard_limited") {
      this.start();
    }
  }

  reportAuthFailure(adapterKey: "codeHost" | "issueTracker"): void {
    const adapter = this.opts[adapterKey];
    if (adapter) {
      adapter.authState = "failed";
    }
  }

  private async resolveContext(name: string): Promise<void> {
    const dir = this.sessionDirs.get(name);
    if (!dir) return;
    try {
      const manualIssueIds = this.opts.sessionState?.getLinkedIssueIds(name) ?? [];
      const manualMrIds = this.opts.sessionState?.getLinkedMrIds(name) ?? [];
      const ctx = await resolveSessionContext({
        sessionName: name,
        dir,
        codeHost: this.opts.codeHost,
        issueTracker: this.opts.issueTracker,
        manualIssueIds,
        manualMrIds,
      });
      this.contexts.set(name, ctx);
      // Cache it either way — a partial context still shows whatever resolved —
      // but remember an incomplete one so the background sweep tries again.
      // Without this a single blip blanks a session's links for the whole run.
      if (ctx.degraded) this.degradedSessions.add(name);
      else this.degradedSessions.delete(name);
      this.opts.onUpdate(name);
    } catch (e) {
      logError("PollCoordinator", `resolve session "${name}" failed: ${(e as Error).message}`);
      this.degradedSessions.add(name);
    }
  }

  private async pollActiveSession(): Promise<void> {
    if (!this.activeSession || this._rateLimitState === "hard_limited") return;
    const name = this.activeSession;
    const ctx = this.contexts.get(name);
    if (!ctx) {
      await this.resolveContext(name);
      return;
    }

    // Check for branch drift
    const dir = this.sessionDirs.get(name);
    if (dir) {
      const currentBranch = await getGitBranch(dir);
      if (currentBranch !== ctx.branch) {
        await this.resolveContext(name);
        return;
      }
    }

    const { codeHost, issueTracker } = this.opts;
    let changed = false;

    // Poll all MRs by ID
    if (ctx.mrs.length > 0 && codeHost && codeHost.authState === "ok") {
      try {
        const ids = ctx.mrs.map((mr) => mr.id);
        const updated = await codeHost.pollMergeRequestsByIds(ids);
        for (let i = 0; i < ctx.mrs.length; i++) {
          const fresh = updated.get(ctx.mrs[i].id);
          if (fresh) {
            ctx.mrs[i] = { ...fresh, source: ctx.mrs[i].source };
            changed = true;
          }
        }
      } catch (e) {
        const status = e instanceof HttpError ? e.status : 0;
        if (status === 401 || status === 403) this.reportAuthFailure("codeHost");
        else if (status === 429) this.reportRateLimit("rate_limited");
        else logError("PollCoordinator", `poll error: ${(e as Error).message}`);
      }
    }

    // Poll all issues by ID
    if (ctx.issues.length > 0 && issueTracker && issueTracker.authState === "ok") {
      try {
        const ids = ctx.issues.map((issue) => issue.id);
        const updated = await issueTracker.pollAllIssues(ids);
        for (let i = 0; i < ctx.issues.length; i++) {
          const fresh = updated.get(ctx.issues[i].id);
          if (fresh) {
            ctx.issues[i] = { ...fresh, source: ctx.issues[i].source };
            changed = true;
          }
        }
      } catch (e) {
        const status = e instanceof HttpError ? e.status : 0;
        if (status === 401 || status === 403) this.reportAuthFailure("issueTracker");
        else if (status === 429) this.reportRateLimit("rate_limited");
        else logError("PollCoordinator", `poll error: ${(e as Error).message}`);
      }
    }

    if (changed) {
      ctx.resolvedAt = Date.now();
      this.opts.onUpdate(name);
    }
  }

  private async pollBackgroundSessions(): Promise<void> {
    if (this._rateLimitState !== "normal") return;
    const { codeHost, issueTracker } = this.opts;

    // Sweep for anything still unresolved or resolved incompletely — sessions
    // added while rate-limited, and retries for tracker failures. The batches
    // below only refresh contexts that already exist, so without this a session
    // that missed its backfill would never get one.
    for (const name of this.sessionDirs.keys()) {
      if (!this.contexts.has(name) || this.degradedSessions.has(name)) {
        this.enqueueBackfill(name);
      }
    }

    const branchContexts: BranchContext[] = [];
    const nonBranchMrIds: string[] = [];
    const mrIdToSession = new Map<string, string>();
    const allIssueIds: string[] = [];
    const issueIdToSession = new Map<string, string>();

    for (const [name, ctx] of this.contexts) {
      if (name === this.activeSession) continue;
      if (ctx.branch && ctx.remote) {
        branchContexts.push({ sessionName: name, remote: ctx.remote, branch: ctx.branch });
      }
      for (const mr of ctx.mrs) {
        if (mr.source !== "branch") {
          nonBranchMrIds.push(mr.id);
          mrIdToSession.set(mr.id, name);
        }
      }
      for (const issue of ctx.issues) {
        allIssueIds.push(issue.id);
        issueIdToSession.set(issue.id, name);
      }
    }

    // Batch 1: branch-oriented MR discovery
    if (branchContexts.length > 0 && codeHost && codeHost.authState === "ok") {
      try {
        const results = await codeHost.pollAllMergeRequests(branchContexts);
        for (const [sessionName, mr] of results) {
          const ctx = this.contexts.get(sessionName);
          if (ctx) {
            const idx = ctx.mrs.findIndex((m) => m.source === "branch");
            if (idx >= 0) ctx.mrs[idx] = { ...mr, source: "branch" };
            ctx.resolvedAt = Date.now();
            this.opts.onUpdate(sessionName);
          }
        }
      } catch (e) {
        const status = e instanceof HttpError ? e.status : 0;
        if (status === 429) this.reportRateLimit("rate_limited");
        else logError("PollCoordinator", `poll error: ${(e as Error).message}`);
      }
    }

    // Batch 2: ID-oriented MR polling for manual/transitive
    if (nonBranchMrIds.length > 0 && codeHost && codeHost.authState === "ok") {
      try {
        const results = await codeHost.pollMergeRequestsByIds(nonBranchMrIds);
        for (const [mrId, mr] of results) {
          const sessionName = mrIdToSession.get(mrId);
          if (!sessionName) continue;
          const ctx = this.contexts.get(sessionName);
          if (ctx) {
            const idx = ctx.mrs.findIndex((m) => m.id === mrId);
            if (idx >= 0) {
              ctx.mrs[idx] = { ...mr, source: ctx.mrs[idx].source };
              ctx.resolvedAt = Date.now();
              this.opts.onUpdate(sessionName);
            }
          }
        }
      } catch (e) {
        const status = e instanceof HttpError ? e.status : 0;
        if (status === 429) this.reportRateLimit("rate_limited");
        else logError("PollCoordinator", `poll error: ${(e as Error).message}`);
      }
    }

    // Batch 3: issue polling (already ID-based)
    if (allIssueIds.length > 0 && issueTracker && issueTracker.authState === "ok") {
      try {
        const results = await issueTracker.pollAllIssues(allIssueIds);
        for (const [issueId, issue] of results) {
          const sessionName = issueIdToSession.get(issueId);
          if (!sessionName) continue;
          const ctx = this.contexts.get(sessionName);
          if (ctx) {
            const idx = ctx.issues.findIndex((i) => i.id === issueId);
            if (idx >= 0) {
              ctx.issues[idx] = { ...issue, source: ctx.issues[idx].source };
              ctx.resolvedAt = Date.now();
              this.opts.onUpdate(sessionName);
            }
          }
        }
      } catch (e) {
        const status = e instanceof HttpError ? e.status : 0;
        if (status === 429) this.reportRateLimit("rate_limited");
        else logError("PollCoordinator", `poll error: ${(e as Error).message}`);
      }
    }
  }

  private startActivePolling(): void {
    const interval =
      this._rateLimitState === "rate_limited" ? RATE_LIMITED_ACTIVE_MS : ACTIVE_INTERVAL_MS;
    this.activeTimer = setInterval(() => {
      this.pollActiveSession().catch(() => {});
    }, interval);
  }

  private startBackgroundPolling(): void {
    if (this._rateLimitState !== "normal") return;
    this.backgroundTimer = setInterval(() => {
      this.pollBackgroundSessions().catch(() => {});
    }, BACKGROUND_INTERVAL_MS);
  }

  private startGlobalPolling(): void {
    this.globalTimer = setInterval(() => {
      this.pollGlobal().catch(() => {});
    }, GLOBAL_INTERVAL_MS);
  }
}
