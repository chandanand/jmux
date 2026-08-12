import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { PollCoordinator, type PollCoordinatorOptions } from "../../adapters/poll-coordinator";
import type {
  CodeHostAdapter,
  IssueTrackerAdapter,
  SessionContext,
  MergeRequest,
  AdapterAuthState,
  Issue,
} from "../../adapters/types";

function makeMockCodeHost(overrides: Partial<CodeHostAdapter> = {}): CodeHostAdapter {
  return {
    type: "gitlab",
    authState: "ok" as AdapterAuthState,
    authHint: "$GITLAB_TOKEN",
    identity: null,
    authenticate: mock(() => Promise.resolve()),
    getMergeRequest: mock(() => Promise.resolve(null)),
    pollMergeRequest: mock(() => Promise.resolve({
      id: "1", title: "Test", status: "open" as const,
      sourceBranch: "feat", targetBranch: "main",
      pipeline: { state: "passed" as const, webUrl: "https://example.com/pipeline/1" },
      approvals: { required: 1, current: 0 },
      webUrl: "https://example.com/mr/1",
    })),
    pollAllMergeRequests: mock(() => Promise.resolve(new Map())),
    pollMergeRequestsByIds: mock(() => Promise.resolve(new Map())),
    searchMergeRequests: mock(() => Promise.resolve([])),
    getMyMergeRequests: mock(() => Promise.resolve([])),
    getMrsAwaitingMyReview: mock(() => Promise.resolve([])),
    parseMrUrl: mock(() => null),
    openInBrowser: mock(() => {}),
    markReady: mock(() => Promise.resolve()),
    approve: mock(() => Promise.resolve()),
    ...overrides,
  };
}

describe("PollCoordinator", () => {
  test("starts and stops cleanly", () => {
    const coordinator = new PollCoordinator({
      codeHost: null,
      issueTracker: null,
      onUpdate: () => {},
      getSessionDir: () => "/tmp",
      sessionState: null,
    });
    coordinator.start();
    coordinator.stop();
  });

  test("addSession and removeSession manage session list", () => {
    const coordinator = new PollCoordinator({
      codeHost: null,
      issueTracker: null,
      onUpdate: () => {},
      getSessionDir: () => "/tmp",
      sessionState: null,
    });
    coordinator.addSession("test", "/tmp/test");
    expect(coordinator.getContext("test")).toBeNull();
    coordinator.removeSession("test");
  });

  test("setActiveSession updates active session", () => {
    const coordinator = new PollCoordinator({
      codeHost: null,
      issueTracker: null,
      onUpdate: () => {},
      getSessionDir: () => "/tmp",
      sessionState: null,
    });
    coordinator.addSession("test", "/tmp/test");
    coordinator.setActiveSession("test");
    coordinator.stop();
  });

  test("getAllContexts returns all cached contexts", () => {
    const coordinator = new PollCoordinator({
      codeHost: null,
      issueTracker: null,
      onUpdate: () => {},
      getSessionDir: () => "/tmp",
      sessionState: null,
    });
    const contexts = coordinator.getAllContexts();
    expect(contexts.size).toBe(0);
    coordinator.stop();
  });

  test("handles rate limit state transitions", () => {
    const coordinator = new PollCoordinator({
      codeHost: null,
      issueTracker: null,
      onUpdate: () => {},
      getSessionDir: () => "/tmp",
      sessionState: null,
    });
    expect(coordinator.rateLimitState).toBe("normal");
    coordinator.reportRateLimit("rate_limited");
    expect(coordinator.rateLimitState).toBe("rate_limited");
    coordinator.reportRateLimit("hard_limited");
    expect(coordinator.rateLimitState).toBe("hard_limited");
    coordinator.reportRateLimit("normal");
    expect(coordinator.rateLimitState).toBe("normal");
    coordinator.stop();
  });

  test("handles auth failure", () => {
    const codeHost = makeMockCodeHost();
    const coordinator = new PollCoordinator({
      codeHost,
      issueTracker: null,
      onUpdate: () => {},
      getSessionDir: () => "/tmp",
      sessionState: null,
    });
    coordinator.reportAuthFailure("codeHost");
    expect(codeHost.authState).toBe("failed");
    coordinator.stop();
  });

  test("global polling lifecycle", () => {
    const coordinator = new PollCoordinator({
      codeHost: null, issueTracker: null,
      onUpdate: () => {}, getSessionDir: () => "/tmp", sessionState: null,
    });
    coordinator.start();
    expect(coordinator.getGlobalIssues()).toEqual([]);
    expect(coordinator.getGlobalMrs()).toEqual([]);
    expect(coordinator.getGlobalReviewMrs()).toEqual([]);
    coordinator.stop();
  });

  describe("optimistic link mutators", () => {
    function seededCoordinator(): { coord: PollCoordinator; updates: string[] } {
      const updates: string[] = [];
      const coord = new PollCoordinator({
        codeHost: null, issueTracker: null,
        onUpdate: (name) => { updates.push(name); },
        getSessionDir: () => "/tmp", sessionState: null,
      });
      const ctx: SessionContext = {
        sessionName: "s1", dir: "/tmp/s1", branch: "main", remote: null,
        mrs: [], issues: [], resolvedAt: 0,
      };
      coord.getAllContexts().set("s1", ctx);
      return { coord, updates };
    }

    test("addLinkedIssue inserts into context with manual source and notifies", () => {
      const { coord, updates } = seededCoordinator();
      const issue = {
        id: "i1", identifier: "ENG-1", title: "x", status: "Todo",
        assignee: null, linkedMrUrls: [], webUrl: "",
      };
      coord.addLinkedIssue("s1", issue);
      const ctx = coord.getContext("s1")!;
      expect(ctx.issues).toHaveLength(1);
      expect(ctx.issues[0].id).toBe("i1");
      expect(ctx.issues[0].source).toBe("manual");
      expect(updates).toContain("s1");
      coord.stop();
    });

    test("addLinkedIssue is idempotent for duplicate ids", () => {
      const { coord } = seededCoordinator();
      const issue = {
        id: "i1", identifier: "ENG-1", title: "x", status: "Todo",
        assignee: null, linkedMrUrls: [], webUrl: "",
      };
      coord.addLinkedIssue("s1", issue);
      coord.addLinkedIssue("s1", issue);
      expect(coord.getContext("s1")!.issues).toHaveLength(1);
      coord.stop();
    });

    test("removeLinkedIssue deletes by id and notifies", () => {
      const { coord, updates } = seededCoordinator();
      const issue = {
        id: "i1", identifier: "ENG-1", title: "x", status: "Todo",
        assignee: null, linkedMrUrls: [], webUrl: "",
      };
      coord.addLinkedIssue("s1", issue);
      updates.length = 0;
      coord.removeLinkedIssue("s1", "i1");
      expect(coord.getContext("s1")!.issues).toHaveLength(0);
      expect(updates).toContain("s1");
      coord.stop();
    });

    test("addLinkedMr inserts into context with manual source", () => {
      const { coord, updates } = seededCoordinator();
      const mr: MergeRequest = {
        id: "1", title: "x", status: "open", sourceBranch: "f", targetBranch: "main",
        pipeline: null, approvals: { required: 0, current: 0 }, webUrl: "",
      };
      coord.addLinkedMr("s1", mr);
      const ctx = coord.getContext("s1")!;
      expect(ctx.mrs).toHaveLength(1);
      expect(ctx.mrs[0].source).toBe("manual");
      expect(updates).toContain("s1");
      coord.stop();
    });

    test("removeLinkedMr deletes by id", () => {
      const { coord } = seededCoordinator();
      const mr: MergeRequest = {
        id: "1", title: "x", status: "open", sourceBranch: "f", targetBranch: "main",
        pipeline: null, approvals: { required: 0, current: 0 }, webUrl: "",
      };
      coord.addLinkedMr("s1", mr);
      coord.removeLinkedMr("s1", "1");
      expect(coord.getContext("s1")!.mrs).toHaveLength(0);
      coord.stop();
    });

    test("mutators no-op when context is not yet resolved", () => {
      const updates: string[] = [];
      const coord = new PollCoordinator({
        codeHost: null, issueTracker: null,
        onUpdate: (name) => { updates.push(name); },
        getSessionDir: () => "/tmp", sessionState: null,
      });
      const issue = {
        id: "i1", identifier: "ENG-1", title: "x", status: "Todo",
        assignee: null, linkedMrUrls: [], webUrl: "",
      };
      coord.addLinkedIssue("nonexistent", issue);
      coord.removeLinkedIssue("nonexistent", "i1");
      expect(updates).toEqual([]);
      coord.stop();
    });
  });

  // --- Context backfill ---
  //
  // Contexts are in-memory, so every session starts a run unresolved. These
  // cover the guarantee that a persisted link comes back for EVERY session
  // after a restart, not just whichever one you happen to be attached to.

  describe("context backfill", () => {
    const ISSUE = {
      id: "i1", identifier: "TRA-1", title: "x", status: "Todo",
      assignee: null, linkedMrUrls: [], webUrl: "",
    };

    // Dirs that aren't git repos, so branch discovery is inert and resolution
    // exercises exactly the persisted-link path this backfill exists for.
    function harness(opts: {
      pollIssue?: () => Promise<any>;
      links?: string[];
    } = {}) {
      const calls: string[] = [];
      const issueTracker = {
        type: "linear", authState: "ok" as AdapterAuthState, authHint: "",
        authenticate: mock(() => Promise.resolve()),
        getLinkedIssue: mock(() => Promise.resolve(null)),
        getIssueByBranch: mock(() => Promise.resolve(null)),
        pollIssue: mock((id: string) => {
          calls.push(id);
          return opts.pollIssue ? opts.pollIssue() : Promise.resolve({ ...ISSUE });
        }),
        pollAllIssues: mock(() => Promise.resolve(new Map())),
        getAvailableStatuses: mock(() => Promise.resolve([])),
        listWorkflowStates: mock(() => Promise.resolve([])),
        openInBrowser: mock(() => {}),
        updateStatus: mock(() => Promise.resolve()),
        createIssue: mock(() => Promise.resolve({ ...ISSUE })),
        searchIssues: mock(() => Promise.resolve([])),
        getMyIssues: mock(() => Promise.resolve([])),
        getTeams: mock(() => Promise.resolve([])),
        buildPrompt: mock(() => ""),
      } as unknown as IssueTrackerAdapter;

      const coord = new PollCoordinator({
        codeHost: null,
        issueTracker,
        onUpdate: () => {},
        getSessionDir: () => "/nonexistent",
        sessionState: {
          getLinkedIssueIds: () => opts.links ?? ["i1"],
          getLinkedMrIds: () => [],
        } as any,
      });
      return { coord, issueTracker, calls };
    }

    const settle = () => new Promise((r) => setTimeout(r, 10));

    test("a discovered session resolves without ever being made active", async () => {
      // The bug this replaces: resolveContext was reachable only through the
      // active session, so a restart left every other session unlinked.
      const { coord, calls } = harness();
      coord.start();
      coord.addSession("tra-1", "/nonexistent/tra-1");
      await settle();
      expect(calls).toEqual(["i1"]);
      expect(coord.getContext("tra-1")?.issues[0]?.id).toBe("i1");
      coord.stop();
    });

    test("backfill waits for start(), so auth can settle first", async () => {
      // Sessions are discovered before adapters finish authenticating.
      // Resolving early would skip every API call and cache a link-less
      // context — the exact state this backfill exists to prevent.
      const { coord, calls } = harness();
      coord.addSession("tra-1", "/nonexistent/tra-1");
      await settle();
      expect(calls).toEqual([]);
      expect(coord.getContext("tra-1")).toBeNull();

      coord.start();
      await settle();
      expect(calls).toEqual(["i1"]);
      coord.stop();
    });

    test("resolves at most 3 sessions concurrently", async () => {
      let inFlight = 0;
      let peak = 0;
      const { coord } = harness({
        pollIssue: async () => {
          inFlight++;
          peak = Math.max(peak, inFlight);
          await new Promise((r) => setTimeout(r, 5));
          inFlight--;
          return { ...ISSUE };
        },
      });
      coord.start();
      for (let i = 0; i < 10; i++) coord.addSession(`s${i}`, `/nonexistent/s${i}`);
      await new Promise((r) => setTimeout(r, 150));
      expect(peak).toBe(3);
      // All ten still finish — the cap throttles, it does not drop work.
      expect(coord.getAllContexts().size).toBe(10);
      coord.stop();
    });

    test("a resolved session is not re-resolved when rediscovered", async () => {
      // addSession fires for every session on every session-list refresh.
      const { coord, calls } = harness();
      coord.start();
      coord.addSession("tra-1", "/nonexistent/tra-1");
      await settle();
      coord.addSession("tra-1", "/nonexistent/tra-1");
      await settle();
      expect(calls).toEqual(["i1"]);
      coord.stop();
    });

    test("a context degraded by a failing tracker is retried, not cached forever", async () => {
      // One network blip during resolution used to blank a session's links for
      // the rest of the run: the empty context cached and nothing re-resolved.
      let fail = true;
      const { coord, calls } = harness({
        pollIssue: async () => {
          if (fail) throw new Error("Unable to connect");
          return { ...ISSUE };
        },
      });
      coord.start();
      coord.addSession("tra-1", "/nonexistent/tra-1");
      await settle();
      expect(coord.getContext("tra-1")?.issues).toEqual([]);
      expect(coord.getContext("tra-1")?.degraded).toBe(true);

      // Rediscovery retries it, and the recovered link lands.
      fail = false;
      coord.addSession("tra-1", "/nonexistent/tra-1");
      await settle();
      expect(calls).toEqual(["i1", "i1"]);
      expect(coord.getContext("tra-1")?.issues[0]?.id).toBe("i1");
      expect(coord.getContext("tra-1")?.degraded).toBeUndefined();
      coord.stop();
    });

    test("removeSession drops a queued session instead of resolving it", async () => {
      const { coord, calls } = harness();
      coord.addSession("gone", "/nonexistent/gone");
      coord.removeSession("gone");
      coord.start();
      await settle();
      expect(calls).toEqual([]);
      coord.stop();
    });

    // `ctl issue link` writes the `@jmux-linear-issue` tmux option, which the
    // context was built without — so an agent-linked issue suppressed the ghost
    // row (explicitIssueLinks reads both stores) and then had no sidebar badge,
    // no stage band, no linked dot and no MR transition.
    describe("both link stores", () => {
      test("an option-store link resolves into the context", async () => {
        const { coord, calls } = harness({ links: [] });
        coord.start();
        coord.addSession("tra-1", "/nonexistent/tra-1", ["TRA-9"]);
        await settle();
        expect(calls).toEqual(["TRA-9"]);
        coord.stop();
      });

      test("both stores contribute, state.json first", async () => {
        const { coord, calls } = harness({ links: ["i1"] });
        coord.start();
        coord.addSession("tra-1", "/nonexistent/tra-1", ["TRA-9"]);
        await settle();
        expect(calls).toEqual(["i1", "TRA-9"]);
        coord.stop();
      });

      test("an issue in both stores is resolved once", async () => {
        const { coord, calls } = harness({ links: ["TRA-9"] });
        coord.start();
        coord.addSession("tra-1", "/nonexistent/tra-1", ["tra-9"]);
        await settle();
        expect(calls).toEqual(["TRA-9"]);
        coord.stop();
      });

      // The reason the signature exists. Neither the active poll nor the
      // background sweep re-reads the link *set* — they refresh the issues a
      // context already has, by id — and the CLI has no IPC to reach the
      // optimistic mutators the TUI's own link key uses.
      test("a link added after resolution re-resolves the context", async () => {
        const { coord, calls } = harness({ links: [] });
        coord.start();
        coord.addSession("tra-1", "/nonexistent/tra-1", ["TRA-9"]);
        await settle();
        expect(calls).toEqual(["TRA-9"]);

        coord.addSession("tra-1", "/nonexistent/tra-1", ["TRA-9", "TRA-10"]);
        await settle();
        expect(calls).toEqual(["TRA-9", "TRA-9", "TRA-10"]);
        coord.stop();
      });

      test("an unchanged link set does not re-resolve", async () => {
        const { coord, calls } = harness({ links: [] });
        coord.start();
        coord.addSession("tra-1", "/nonexistent/tra-1", ["TRA-9"]);
        await settle();
        coord.addSession("tra-1", "/nonexistent/tra-1", ["TRA-9"]);
        await settle();
        expect(calls).toEqual(["TRA-9"]);
        coord.stop();
      });

      // Re-ordering and re-spelling are the two ways the same set arrives
      // looking different. Either counting as a change would re-resolve every
      // session on every list refresh.
      test("re-ordering or re-spelling the same links does not re-resolve", async () => {
        const { coord, calls } = harness({ links: [] });
        coord.start();
        coord.addSession("tra-1", "/nonexistent/tra-1", ["TRA-9", "TRA-10"]);
        await settle();
        coord.addSession("tra-1", "/nonexistent/tra-1", ["tra-10", "TRA-9"]);
        await settle();
        expect(calls).toEqual(["TRA-9", "TRA-10"]);
        coord.stop();
      });

      test("removing the last link re-resolves to an empty context", async () => {
        const { coord } = harness({ links: [] });
        coord.start();
        coord.addSession("tra-1", "/nonexistent/tra-1", ["TRA-9"]);
        await settle();
        expect(coord.getContext("tra-1")?.issues.length).toBe(1);

        coord.addSession("tra-1", "/nonexistent/tra-1", []);
        await settle();
        expect(coord.getContext("tra-1")?.issues).toEqual([]);
        coord.stop();
      });
    });
  });
});

describe("PollCoordinator retries unreachable adapters", () => {
  // `unreachable` only earns its existence if something retries it. Nothing
  // does otherwise: authenticate() runs once at startup and every poll gates on
  // authState === "ok", so a network blip during startup would disable the
  // adapter for the whole session — the exact failure the presence-only auth
  // check was originally written to avoid.
  test("re-authenticates an unreachable tracker before polling", async () => {
    let authCalls = 0;
    const tracker = {
      type: "linear",
      authState: "unreachable" as AdapterAuthState,
      authHint: "",
      identity: null,
      authenticate: async () => { authCalls++; tracker.authState = "ok"; },
      getMyIssues: async () => [{ id: "recovered" } as unknown as Issue],
    } as unknown as IssueTrackerAdapter & { authState: AdapterAuthState };

    const coord = new PollCoordinator({
      codeHost: null,
      issueTracker: tracker,
      onUpdate: () => {},
      getSessionDir: () => null,
      sessionState: null,
    });

    await coord.pollGlobal();
    expect(authCalls).toBe(1);
    expect(coord.getGlobalIssues()).toHaveLength(1);
  });

  test("does not re-authenticate an adapter whose credential was rejected", async () => {
    let authCalls = 0;
    const tracker = {
      type: "linear",
      authState: "failed" as AdapterAuthState,
      authHint: "",
      identity: null,
      authenticate: async () => { authCalls++; },
      getMyIssues: async () => [],
    } as unknown as IssueTrackerAdapter;

    const coord = new PollCoordinator({
      codeHost: null,
      issueTracker: tracker,
      onUpdate: () => {},
      getSessionDir: () => null,
      sessionState: null,
    });

    await coord.pollGlobal();
    expect(authCalls).toBe(0);
  });
});

describe("PollCoordinator adapter swap", () => {
  function tracker(over: Partial<IssueTrackerAdapter> = {}): IssueTrackerAdapter {
    return {
      type: "linear", authState: "ok" as AdapterAuthState, authHint: "", identity: null,
      authenticate: async () => {},
      getMyIssues: async () => [],
      ...over,
    } as unknown as IssueTrackerAdapter;
  }

  test("setAdapters advances the epoch", () => {
    const coord = new PollCoordinator({
      codeHost: null, issueTracker: null,
      onUpdate: () => {}, getSessionDir: () => null, sessionState: null,
    });
    const before = coord.adapterEpoch;
    coord.setAdapters({ codeHost: null, issueTracker: null });
    expect(coord.adapterEpoch).toBeGreaterThan(before);
  });

  test("results from a retired adapter are dropped", async () => {
    let release: (v: Issue[]) => void = () => {};
    const slow = new Promise<Issue[]>((r) => { release = r; });
    const coord = new PollCoordinator({
      codeHost: null,
      issueTracker: tracker({ getMyIssues: () => slow } as Partial<IssueTrackerAdapter>),
      onUpdate: () => {}, getSessionDir: () => null, sessionState: null,
    });

    const inFlight = coord.pollGlobal();
    coord.setAdapters({ codeHost: null, issueTracker: null });
    release([{ id: "from-the-old-workspace" } as Issue]);
    await inFlight;

    expect(coord.getGlobalIssues()).toEqual([]);
  });

  test("setAdapters clears provider-derived caches", async () => {
    const coord = new PollCoordinator({
      codeHost: null,
      issueTracker: tracker({ getMyIssues: async () => [{ id: "a" } as Issue] } as Partial<IssueTrackerAdapter>),
      onUpdate: () => {}, getSessionDir: () => null, sessionState: null,
    });
    await coord.pollGlobal();
    expect(coord.getGlobalIssues()).toHaveLength(1);
    coord.setAdapters({ codeHost: null, issueTracker: null });
    expect(coord.getGlobalIssues()).toEqual([]);
  });

  test("the new adapters are the ones subsequently polled", async () => {
    const coord = new PollCoordinator({
      codeHost: null,
      issueTracker: tracker({ getMyIssues: async () => [{ id: "old" } as Issue] } as Partial<IssueTrackerAdapter>),
      onUpdate: () => {}, getSessionDir: () => null, sessionState: null,
    });
    coord.setAdapters({
      codeHost: null,
      issueTracker: tracker({ getMyIssues: async () => [{ id: "new" } as Issue] } as Partial<IssueTrackerAdapter>),
    });
    await coord.pollGlobal();
    expect(coord.getGlobalIssues().map((i) => i.id)).toEqual(["new"]);
  });
});
