import { resolveSessionContext } from "./context-resolver";
import type { AdapterSet } from "./registry";
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
import { mergeIssueLinkIds, issueLinkSignature } from "../issue-session";

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
  /**
   * Per session, the ids in `@jmux-linear-issue` as of the last session-list
   * refresh. Pushed in with the dir rather than pulled through a callback, so
   * there is no window where this disagrees with the list it came from.
   */
  private sessionOptionLinks = new Map<string, string[]>();
  /** Per session, the link signature the cached context was resolved from. */
  private resolvedLinkSignatures = new Map<string, string>();
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
  private epoch = 0;

  get rateLimitState(): RateLimitState {
    return this._rateLimitState;
  }

  get codeHost(): CodeHostAdapter | null {
    return this.opts.codeHost;
  }

  get issueTracker(): IssueTrackerAdapter | null {
    return this.opts.issueTracker;
  }

  /** The current adapter generation. Exposed so tests can observe a swap. */
  get adapterEpoch(): number { return this.epoch; }

  /** Sessions being resolved right now. Exposed so a swap can be seen to drain them. */
  get inFlightCount(): number { return this.inFlight.size; }

  /** Whether a captured epoch is still the live one. */
  private isCurrent(epoch: number): boolean { return epoch === this.epoch; }

  /**
   * Replace the adapters and retire everything derived from the old ones.
   *
   * Clearing is not optional. Contexts, global caches and link signatures were
   * all computed against a different workspace, and `resolvedLinkSignatures` in
   * particular would make every session look freshly resolved and suppress the
   * re-resolve that would fix it. Sessions are re-queued so they refill from
   * the new adapters.
   */
  setAdapters(set: AdapterSet): void {
    this.epoch++;
    this.opts.codeHost = set.codeHost;
    this.opts.issueTracker = set.issueTracker;

    this.contexts.clear();
    this.resolvedLinkSignatures.clear();
    this.degradedSessions.clear();
    this.globalIssues = [];
    this.globalMrs = [];
    this.globalReviewMrs = [];
    this._rateLimitState = "normal";
    this.pending.clear();
    this.inFlight.clear();

    for (const name of this.sessionDirs.keys()) this.enqueueBackfill(name);
    this.opts.onUpdate("__global__");
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

  /**
   * Give an adapter that could not be *reached* another chance.
   *
   * `authenticate()` runs once at startup and every poll gates on
   * `authState === "ok"`, so without this a network blip during startup would
   * disable the adapter for the whole session with no way back but a restart.
   * That is precisely why auth used to be a token-presence check with no I/O;
   * a real identity probe is only safe alongside this retry.
   *
   * Deliberately only `unreachable`. A `failed` credential was *rejected* — the
   * answer will not change by asking again, and re-probing a revoked token on
   * every global tick is a request per tick, forever.
   */
  private async retryUnreachableAuth(): Promise<void> {
    const { codeHost, issueTracker } = this.opts;
    const attempts: Array<Promise<void>> = [];
    if (issueTracker?.authState === "unreachable") attempts.push(issueTracker.authenticate());
    if (codeHost?.authState === "unreachable") attempts.push(codeHost.authenticate());
    if (attempts.length > 0) await Promise.allSettled(attempts);
  }

  async pollGlobal(): Promise<void> {
    await this.retryUnreachableAuth();
    // Captured after the retry, since that awaits and a swap can land inside it.
    const { codeHost, issueTracker } = this.opts;
    const epoch = this.epoch;

    if (issueTracker && issueTracker.authState === "ok") {
      try {
        const issues = await issueTracker.getMyIssues();
        if (!this.isCurrent(epoch)) return;
        this.globalIssues = issues;
      } catch (e) {
        if (!this.isCurrent(epoch)) return;
        logError("PollCoordinator", `global issues poll failed: ${(e as Error).message}`);
      }
    }

    if (codeHost && codeHost.authState === "ok") {
      try {
        const mrs = await codeHost.getMyMergeRequests();
        if (!this.isCurrent(epoch)) return;
        this.globalMrs = mrs;
      } catch (e) {
        if (!this.isCurrent(epoch)) return;
        logError("PollCoordinator", `global MRs poll failed: ${(e as Error).message}`);
      }
      try {
        const review = await codeHost.getMrsAwaitingMyReview();
        if (!this.isCurrent(epoch)) return;
        this.globalReviewMrs = review;
      } catch (e) {
        if (!this.isCurrent(epoch)) return;
        logError("PollCoordinator", `global review MRs poll failed: ${(e as Error).message}`);
      }
    }

    if (!this.isCurrent(epoch)) return;
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

  /**
   * `optionIssueLinks` are the ids in the session's `@jmux-linear-issue` tmux
   * option — the store `jmux ctl` writes, which has no route into `state.json`
   * (a running TUI holds that in memory and would clobber the write).
   */
  addSession(name: string, dir: string, optionIssueLinks: readonly string[] = []): void {
    this.sessionDirs.set(name, dir);
    this.sessionOptionLinks.set(name, [...optionIssueLinks]);
    // Called for every session on every session-list refresh, so this has to be
    // idempotent: already-resolved sessions are skipped, and the queue is a set.
    this.enqueueBackfill(name);
  }

  removeSession(name: string): void {
    this.sessionDirs.delete(name);
    this.sessionOptionLinks.delete(name);
    this.resolvedLinkSignatures.delete(name);
    this.contexts.delete(name);
    this.pending.delete(name);
    this.degradedSessions.delete(name);
  }

  /** The union of both link stores for a session, in the order they resolve. */
  private linkIdsFor(name: string): string[] {
    return mergeIssueLinkIds(
      this.opts.sessionState?.getLinkedIssueIds(name) ?? [],
      this.sessionOptionLinks.get(name) ?? [],
    );
  }

  /**
   * Queue a session for context resolution unless it already has a good one
   * *built from the links it currently has*.
   *
   * That last clause is what lets `ctl issue link` show up at all. Neither the
   * active poll nor the background sweep re-reads the link set — they refresh
   * the issues already in a context, by id — so without a signature check a
   * resolved session would never pick up a link an agent added, no matter how
   * long it ran.
   */
  private enqueueBackfill(name: string): void {
    if (this.inFlight.has(name)) return;
    const stale = this.resolvedLinkSignatures.get(name)
      !== issueLinkSignature(this.linkIdsFor(name));
    if (this.contexts.has(name) && !this.degradedSessions.has(name) && !stale) return;
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
      // Same three-part test as enqueueBackfill, staleness included: a session
      // queued for a link change must not be dropped here for having a context.
      const fresh = this.resolvedLinkSignatures.get(name)
        === issueLinkSignature(this.linkIdsFor(name));
      if (this.contexts.has(name) && !this.degradedSessions.has(name) && fresh) continue;
      this.inFlight.add(name);
      const startedAt = this.epoch;
      void this.resolveContext(name).finally(() => {
        // Only the epoch that added this marker may remove it. A retired
        // resolve settling late would otherwise delete a marker the current
        // epoch had just added, and two resolves would run for one session.
        if (!this.isCurrent(startedAt)) return;
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

  /**
   * `epoch` is optional so callers that have none keep working. When supplied
   * and stale the report is dropped: a 429 belongs to the adapter that earned
   * it, and applying a retired one throttles a brand-new adapter that has made
   * no requests at all.
   */
  reportRateLimit(state: RateLimitState, epoch?: number): void {
    if (epoch !== undefined && !this.isCurrent(epoch)) return;
    this._rateLimitState = state;
    this.stop();
    if (state !== "hard_limited") {
      this.start();
    }
  }

  /**
   * Looks up the *current* adapter, so a late 401 from a retired one would
   * otherwise mark its replacement dead — with no request of its own having
   * failed, and nothing on screen able to explain why.
   */
  reportAuthFailure(adapterKey: "codeHost" | "issueTracker", epoch?: number): void {
    if (epoch !== undefined && !this.isCurrent(epoch)) return;
    const adapter = this.opts[adapterKey];
    if (adapter) {
      adapter.authState = "failed";
    }
  }

  private async resolveContext(name: string): Promise<void> {
    const dir = this.sessionDirs.get(name);
    if (!dir) return;
    const epoch = this.epoch;
    try {
      // Both link stores. Their id shapes differ — a tracker UUID from
      // state.json, a human identifier from the tmux option — and the resolver's
      // lookup accepts either, so they need no separate handling here.
      const manualIssueIds = this.linkIdsFor(name);
      const manualMrIds = this.opts.sessionState?.getLinkedMrIds(name) ?? [];
      // Stamped before the await, against the set actually being resolved: a
      // link added *during* resolution must leave the signature stale so the
      // next sweep picks it up, not be credited to this pass.
      this.resolvedLinkSignatures.set(name, issueLinkSignature(manualIssueIds));
      const ctx = await resolveSessionContext({
        sessionName: name,
        dir,
        codeHost: this.opts.codeHost,
        issueTracker: this.opts.issueTracker,
        manualIssueIds,
        manualMrIds,
      });
      // The signature above was stamped *before* the await — deliberately, so a
      // link added mid-resolution stays stale. That stamp would otherwise
      // survive a swap that cleared the map, marking this session fresh against
      // adapters it was never resolved from, and it would never re-resolve.
      if (!this.isCurrent(epoch)) {
        this.resolvedLinkSignatures.delete(name);
        return;
      }
      this.contexts.set(name, ctx);
      // Cache it either way — a partial context still shows whatever resolved —
      // but remember an incomplete one so the background sweep tries again.
      // Without this a single blip blanks a session's links for the whole run.
      if (ctx.degraded) this.degradedSessions.add(name);
      else this.degradedSessions.delete(name);
      this.opts.onUpdate(name);
    } catch (e) {
      if (!this.isCurrent(epoch)) {
        this.resolvedLinkSignatures.delete(name);
        return;
      }
      logError("PollCoordinator", `resolve session "${name}" failed: ${(e as Error).message}`);
      this.degradedSessions.add(name);
    }
  }

  private async pollActiveSession(): Promise<void> {
    // Every catch below reports auth/rate state against the *current* adapter,
    // so a failure from a retired one must not be applied. Captured once here
    // and passed to each report.
    const epoch = this.epoch;
    if (!this.activeSession || this._rateLimitState === "hard_limited") return;
    const name = this.activeSession;
    const ctx = this.contexts.get(name);
    if (!ctx) {
      await this.resolveContext(name);
      return;
    }

    // Check for link drift, for the same reason as branch drift below: the
    // batch refresh further down updates the issues a context already has, so
    // only a re-resolve can pick up one that was linked since. This is the
    // session the user is looking at and the one an agent's `ctl issue link` is
    // most likely to be about, so it must not wait for the 3-minute sweep.
    if (this.resolvedLinkSignatures.get(name) !== issueLinkSignature(this.linkIdsFor(name))) {
      await this.resolveContext(name);
      return;
    }

    // Check for branch drift
    const dir = this.sessionDirs.get(name);
    if (dir) {
      const currentBranch = await getGitBranch(dir);
      if (!this.isCurrent(epoch)) return;
      if (currentBranch !== ctx.branch) {
        await this.resolveContext(name);
        return;
      }
    }

    // Re-read rather than reusing the `ctx` captured above: a swap clears
    // `contexts`, which detaches that object from the map. Mutating it below
    // would write into something nothing reads again.
    const live = this.contexts.get(name);
    if (!live) return;

    const { codeHost, issueTracker } = this.opts;
    let changed = false;

    // Poll all MRs by ID
    if (live.mrs.length > 0 && codeHost && codeHost.authState === "ok") {
      try {
        const ids = live.mrs.map((mr) => mr.id);
        const updated = await codeHost.pollMergeRequestsByIds(ids);
        if (!this.isCurrent(epoch)) return;
        for (let i = 0; i < live.mrs.length; i++) {
          const fresh = updated.get(live.mrs[i].id);
          if (fresh) {
            live.mrs[i] = { ...fresh, source: live.mrs[i].source };
            changed = true;
          }
        }
      } catch (e) {
        if (!this.isCurrent(epoch)) return;
        const status = e instanceof HttpError ? e.status : 0;
        if (status === 401 || status === 403) this.reportAuthFailure("codeHost", epoch);
        else if (status === 429) this.reportRateLimit("rate_limited", epoch);
        else logError("PollCoordinator", `poll error: ${(e as Error).message}`);
      }
    }

    // Poll all issues by ID
    if (live.issues.length > 0 && issueTracker && issueTracker.authState === "ok") {
      try {
        const ids = live.issues.map((issue) => issue.id);
        const updated = await issueTracker.pollAllIssues(ids);
        if (!this.isCurrent(epoch)) return;
        for (let i = 0; i < live.issues.length; i++) {
          const fresh = updated.get(live.issues[i].id);
          if (fresh) {
            live.issues[i] = { ...fresh, source: live.issues[i].source };
            changed = true;
          }
        }
      } catch (e) {
        if (!this.isCurrent(epoch)) return;
        const status = e instanceof HttpError ? e.status : 0;
        if (status === 401 || status === 403) this.reportAuthFailure("issueTracker", epoch);
        else if (status === 429) this.reportRateLimit("rate_limited", epoch);
        else logError("PollCoordinator", `poll error: ${(e as Error).message}`);
      }
    }

    if (changed) {
      live.resolvedAt = Date.now();
      this.opts.onUpdate(name);
    }
  }

  private async pollBackgroundSessions(): Promise<void> {
    const epoch = this.epoch;
    if (this._rateLimitState !== "normal") return;
    const { codeHost, issueTracker } = this.opts;

    // Sweep for anything still unresolved or resolved incompletely — sessions
    // added while rate-limited, and retries for tracker failures. The batches
    // below only refresh contexts that already exist, so without this a session
    // that missed its backfill would never get one.
    // enqueueBackfill is authoritative about what needs resolving — unresolved,
    // degraded, or resolved from a link set that has since changed — so this
    // offers every session rather than pre-filtering on a subset of its test.
    for (const name of this.sessionDirs.keys()) {
      this.enqueueBackfill(name);
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
        // contexts is cleared by a swap, but re-queued sessions can repopulate it
        // before these results land — so the map lookup alone is not enough.
        if (!this.isCurrent(epoch)) return;
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
        if (!this.isCurrent(epoch)) return;
        const status = e instanceof HttpError ? e.status : 0;
        if (status === 429) this.reportRateLimit("rate_limited", epoch);
        else logError("PollCoordinator", `poll error: ${(e as Error).message}`);
      }
    }

    // Batch 2: ID-oriented MR polling for manual/transitive
    if (nonBranchMrIds.length > 0 && codeHost && codeHost.authState === "ok") {
      try {
        const results = await codeHost.pollMergeRequestsByIds(nonBranchMrIds);
        if (!this.isCurrent(epoch)) return;
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
        if (!this.isCurrent(epoch)) return;
        const status = e instanceof HttpError ? e.status : 0;
        if (status === 429) this.reportRateLimit("rate_limited", epoch);
        else logError("PollCoordinator", `poll error: ${(e as Error).message}`);
      }
    }

    // Batch 3: issue polling (already ID-based)
    if (allIssueIds.length > 0 && issueTracker && issueTracker.authState === "ok") {
      try {
        const results = await issueTracker.pollAllIssues(allIssueIds);
        if (!this.isCurrent(epoch)) return;
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
        if (!this.isCurrent(epoch)) return;
        const status = e instanceof HttpError ? e.status : 0;
        if (status === 429) this.reportRateLimit("rate_limited", epoch);
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
