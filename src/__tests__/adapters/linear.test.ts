// src/__tests__/adapters/linear.test.ts
import { describe, test, expect } from "bun:test";
import { LinearAdapter, extractIssueIdFromBranch, mapWorkflowStates } from "../../adapters/linear";

describe("extractIssueIdFromBranch", () => {
  test("extracts from standard branch name", () => {
    expect(extractIssueIdFromBranch("eng-1234-fix-auth")).toBe("ENG-1234");
  });

  test("extracts from branch with prefix", () => {
    expect(extractIssueIdFromBranch("feature/eng-1234-fix-auth")).toBe("ENG-1234");
  });

  test("extracts from branch with nested prefix", () => {
    expect(extractIssueIdFromBranch("jarred/eng-1234-fix-auth")).toBe("ENG-1234");
  });

  test("extracts multi-letter team prefix", () => {
    expect(extractIssueIdFromBranch("platform-42-refactor")).toBe("PLATFORM-42");
  });

  test("returns null for branch with no issue id", () => {
    expect(extractIssueIdFromBranch("main")).toBeNull();
    expect(extractIssueIdFromBranch("feature/add-login")).toBeNull();
  });
});

describe("searchIssues", () => {
  test("returns empty array when not authenticated", async () => {
    const adapter = new LinearAdapter({ type: "linear" });
    const results = await adapter.searchIssues("test");
    expect(results).toEqual([]);
  });
});

describe("getMyIssues", () => {
  test("returns empty array when not authenticated", async () => {
    const adapter = new LinearAdapter({ type: "linear" });
    const results = await adapter.getMyIssues();
    expect(results).toEqual([]);
  });
});

describe("LinearAdapter", () => {
  test("starts in unauthenticated state", () => {
    const adapter = new LinearAdapter({ type: "linear" });
    expect(adapter.type).toBe("linear");
    expect(adapter.authState).toBe("unauthenticated");
    expect(adapter.authHint).toBe("$LINEAR_API_KEY or $LINEAR_TOKEN");
  });

  // Rewritten, not removed: this used to assert that a non-empty env var means
  // "ok", which is the bug being fixed — a revoked or wrong-workspace token
  // reported connected. The contract is now "the API confirmed who we are".
  test("authenticate succeeds when the API confirms the token", async () => {
    const orig = process.env.LINEAR_API_KEY;
    const realFetch = globalThis.fetch;
    process.env.LINEAR_API_KEY = "lin_test_key";
    globalThis.fetch = (async () => new Response(JSON.stringify({
      data: { viewer: { id: "u1", name: "Ada", organization: { name: "Acme", urlKey: "acme" } } },
    }))) as unknown as typeof fetch;
    try {
      const adapter = new LinearAdapter({ type: "linear" });
      await adapter.authenticate();
      expect(adapter.authState).toBe("ok");
      expect(adapter.identity?.account).toBe("Ada");
      expect(adapter.identity?.organization).toBe("Acme");
    } finally {
      globalThis.fetch = realFetch;
      if (orig === undefined) delete process.env.LINEAR_API_KEY;
      else process.env.LINEAR_API_KEY = orig;
    }
  });

  test("a rejected token reports failed, not ok", async () => {
    const orig = process.env.LINEAR_API_KEY;
    const realFetch = globalThis.fetch;
    process.env.LINEAR_API_KEY = "lin_revoked";
    globalThis.fetch = (async () => new Response("{}", { status: 401 })) as unknown as typeof fetch;
    try {
      const adapter = new LinearAdapter({ type: "linear" });
      await adapter.authenticate();
      expect(adapter.authState).toBe("failed");
      expect(adapter.identity).toBeNull();
    } finally {
      globalThis.fetch = realFetch;
      if (orig === undefined) delete process.env.LINEAR_API_KEY;
      else process.env.LINEAR_API_KEY = orig;
    }
  });

  test("a network error reports unreachable, not failed", async () => {
    const orig = process.env.LINEAR_API_KEY;
    const realFetch = globalThis.fetch;
    process.env.LINEAR_API_KEY = "lin_test_key";
    globalThis.fetch = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    try {
      const adapter = new LinearAdapter({ type: "linear" });
      await adapter.authenticate();
      expect(adapter.authState).toBe("unreachable");
    } finally {
      globalThis.fetch = realFetch;
      if (orig === undefined) delete process.env.LINEAR_API_KEY;
      else process.env.LINEAR_API_KEY = orig;
    }
  });

  test("no token makes no request at all", async () => {
    const origKey = process.env.LINEAR_API_KEY;
    const origToken = process.env.LINEAR_TOKEN;
    const realFetch = globalThis.fetch;
    delete process.env.LINEAR_API_KEY;
    delete process.env.LINEAR_TOKEN;
    let called = false;
    globalThis.fetch = (async () => { called = true; return new Response("{}"); }) as unknown as typeof fetch;
    try {
      const adapter = new LinearAdapter({ type: "linear" });
      await adapter.authenticate();
      expect(adapter.authState).toBe("failed");
      expect(called).toBe(false);
    } finally {
      globalThis.fetch = realFetch;
      if (origKey !== undefined) process.env.LINEAR_API_KEY = origKey;
      if (origToken !== undefined) process.env.LINEAR_TOKEN = origToken;
    }
  });

  test("authenticate fails without env var", async () => {
    const origKey = process.env.LINEAR_API_KEY;
    const origToken = process.env.LINEAR_TOKEN;
    delete process.env.LINEAR_API_KEY;
    delete process.env.LINEAR_TOKEN;
    try {
      const adapter = new LinearAdapter({ type: "linear" });
      await adapter.authenticate();
      expect(adapter.authState).toBe("failed");
    } finally {
      if (origKey !== undefined) process.env.LINEAR_API_KEY = origKey;
      if (origToken !== undefined) process.env.LINEAR_TOKEN = origToken;
    }
  });
});

describe("mapWorkflowStates", () => {
  test("flattens team states and de-duplicates by name", () => {
    const raw = {
      teams: {
        nodes: [
          { name: "Platform", states: { nodes: [
            { id: "s1", name: "Todo", type: "unstarted", position: 1 },
            { id: "s2", name: "QA", type: "started", position: 2 },
          ] } },
          { name: "Web", states: { nodes: [
            // Same name on another team — one picker row, not two.
            { id: "s3", name: "QA", type: "started", position: 2 },
            { id: "s4", name: "Shipped", type: "completed", position: 3 },
          ] } },
        ],
      },
    };
    const states = mapWorkflowStates(raw);
    expect(states.map((s) => s.name)).toEqual(["Todo", "QA", "Shipped"]);
    expect(states.find((s) => s.name === "QA")?.type).toBe("started");
  });

  test("sorts by workflow position so the picker reads in lifecycle order", () => {
    const raw = {
      teams: { nodes: [{ name: "T", states: { nodes: [
        { id: "c", name: "Done", type: "completed", position: 9 },
        { id: "a", name: "Backlog", type: "backlog", position: 1 },
        { id: "b", name: "Doing", type: "started", position: 5 },
      ] } }] },
    };
    expect(mapWorkflowStates(raw).map((s) => s.name)).toEqual(["Backlog", "Doing", "Done"]);
  });

  test("tolerates missing or malformed payloads", () => {
    expect(mapWorkflowStates(null)).toEqual([]);
    expect(mapWorkflowStates({})).toEqual([]);
    expect(mapWorkflowStates({ teams: { nodes: [{ name: "T" }] } })).toEqual([]);
  });
});

describe("listWorkflowStates", () => {
  test("returns empty array when not authenticated", async () => {
    const adapter = new LinearAdapter({ type: "linear" });
    expect(await adapter.listWorkflowStates()).toEqual([]);
  });
});

// A GraphQL error arrives as HTTP 200 with an `errors` array. Treating that as
// data is how the deprecation of `issueSearch` silently emptied every
// branch-derived issue out of the sidebar, with nothing logged.
describe("GraphQL error handling", () => {
  const ISSUE = (identifier: string) => ({
    id: "u1", identifier, title: "T", url: "https://linear.app/x",
    state: { name: "Todo", type: "unstarted" }, assignee: null,
    labels: { nodes: [] }, attachments: { nodes: [] }, priority: 0,
  });

  async function withFetch<T>(
    handler: (body: any) => unknown,
    run: (a: LinearAdapter) => Promise<T>,
  ): Promise<{ result?: T; error?: Error; queries: string[] }> {
    const real = globalThis.fetch;
    const prevToken = process.env.LINEAR_TOKEN;
    const prevKey = process.env.LINEAR_API_KEY;
    const queries: string[] = [];
    process.env.LINEAR_TOKEN = "lin_test";
    delete process.env.LINEAR_API_KEY;
    globalThis.fetch = (async (_url: string, init: any) => {
      const body = JSON.parse(init.body);
      // authenticate() now makes an identity request of its own. It is not part
      // of the operation under test, so it stays out of `queries` — otherwise
      // every assertion on queries[0] would silently be about the probe.
      const isIdentityProbe = typeof body.query === "string" && body.query.includes("viewer {");
      if (!isIdentityProbe) queries.push(body.query);
      if (isIdentityProbe) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: { viewer: { id: "u1", name: "Test", organization: { name: "Test Org" } } } }),
        };
      }
      return { ok: true, status: 200, json: async () => handler(body) };
    }) as any;
    try {
      const adapter = new LinearAdapter({ type: "linear" });
      await adapter.authenticate();
      return { result: await run(adapter), queries };
    } catch (e) {
      return { error: e as Error, queries };
    } finally {
      globalThis.fetch = real;
      if (prevToken === undefined) delete process.env.LINEAR_TOKEN;
      else process.env.LINEAR_TOKEN = prevToken;
      if (prevKey !== undefined) process.env.LINEAR_API_KEY = prevKey;
    }
  }

  test("an error with no data throws rather than reading as 'no results'", async () => {
    const { error } = await withFetch(
      () => ({ errors: [{ message: "deprecated" }], data: null }),
      (a) => a.pollIssue("u1"),
    );
    expect(error).toBeDefined();
    expect(error!.message).toContain("deprecated");
  });

  test("partial data survives an error on one alias of a batch", async () => {
    // A stale link failing must not cost the batch every other session's issue.
    const { result } = await withFetch(
      () => ({
        errors: [{ message: "Entity not found: Issue" }],
        data: { issue0: ISSUE("ENG-1"), issue1: null },
      }),
      (a) => a.pollAllIssues(["u1", "gone"]),
    );
    expect(result!.size).toBe(1);
    expect(result!.get("u1")?.identifier).toBe("ENG-1");
  });

  // Exercises the real pollIssue -> graphql -> mapIssue path, not
  // customerRequestSignal in isolation. A correct helper function that
  // mapIssue never calls is indistinguishable from no signal at all.
  test("a needs resolver failure maps through pollIssue as unknown, not absent", async () => {
    const { result } = await withFetch(
      () => ({
        errors: [{ message: "Cannot query field \"needs\" on type \"Issue\"" }],
        data: { issue: { ...ISSUE("TRA-1"), needs: null } },
      }),
      (a) => a.pollIssue("u1"),
    );
    expect(result!.hasCustomerRequest).toBeUndefined();
  });

  test("an attached customer request maps through pollIssue as true", async () => {
    const { result } = await withFetch(
      () => ({
        data: { issue: { ...ISSUE("TRA-2"), needs: { nodes: [{ id: "n1" }] } } },
      }),
      (a) => a.pollIssue("u2"),
    );
    expect(result!.hasCustomerRequest).toBe(true);
  });

  test("branch lookup uses the supported search field, not deprecated issueSearch", async () => {
    const { result, queries } = await withFetch(
      () => ({ data: { searchIssues: { nodes: [ISSUE("ENG-1234")] } } }),
      (a) => a.getIssueByBranch("eng-1234-fix-auth"),
    );
    expect(queries[0]).toContain("searchIssues");
    expect(queries[0]).not.toContain("issueSearch");
    expect(result?.identifier).toBe("ENG-1234");
  });

  test("branch lookup rejects a loose search hit for another issue", async () => {
    // Search answers an unknown identifier with unrelated matches rather than
    // an error, so the identifier check is what keeps them out.
    const { result } = await withFetch(
      () => ({ data: { searchIssues: { nodes: [ISSUE("ENG-999")] } } }),
      (a) => a.getIssueByBranch("eng-1234-fix-auth"),
    );
    expect(result).toBeNull();
  });
});

describe("LinearAdapter carries team and project ids", () => {
  // Routing keys on ids, never names. Without these the Issue reaches
  // resolveIssueProject with teamId undefined, projectsClaimingTeam returns the
  // empty array for every issue, and group start fails for all of them — which
  // is exactly what shipped before this test existed.
  async function fetchIssue(node: Record<string, unknown> | null): Promise<{
    issue: Awaited<ReturnType<LinearAdapter["getIssueByBranch"]>>;
    queries: string[];
  }> {
    const real = globalThis.fetch;
    const prev = process.env.LINEAR_TOKEN;
    process.env.LINEAR_TOKEN = "lin_test";
    const queries: string[] = [];
    globalThis.fetch = (async (_u: string, init: { body: string }) => {
      const body = JSON.parse(init.body);
      const isProbe = typeof body.query === "string" && body.query.includes("viewer {");
      if (isProbe) {
        return new Response(JSON.stringify({
          data: { viewer: { id: "u1", name: "T", organization: { name: "O" } } },
        }));
      }
      queries.push(body.query);
      return new Response(JSON.stringify({
        data: { searchIssues: { nodes: node ? [node] : [] } },
      }));
    }) as unknown as typeof fetch;
    try {
      const adapter = new LinearAdapter({ type: "linear" });
      await adapter.authenticate();
      const issue = await adapter.getIssueByBranch("eng-1-x");
      return { issue, queries };
    } finally {
      globalThis.fetch = real;
      if (prev === undefined) delete process.env.LINEAR_TOKEN;
      else process.env.LINEAR_TOKEN = prev;
    }
  }

  const BASE = {
    id: "i1", identifier: "ENG-1", title: "t", url: "u",
    state: { name: "Todo", type: "unstarted" },
  };

  test("mapIssue populates teamId and linearProjectId", async () => {
    const { issue } = await fetchIssue({
      ...BASE,
      team: { id: "team-uuid", name: "Core" },
      project: { id: "proj-uuid", name: "Billing" },
    });
    expect(issue?.teamId).toBe("team-uuid");
    expect(issue?.linearProjectId).toBe("proj-uuid");
    // The names stay, for display.
    expect(issue?.team).toBe("Core");
    expect(issue?.project).toBe("Billing");
  });

  test("the query asks for both ids, or the mapper has nothing to map", async () => {
    const { queries } = await fetchIssue(null);
    expect(queries[0]).toContain("team { id name }");
    expect(queries[0]).toContain("project { id name }");
  });

  test("an issue with no team or project leaves both ids undefined", async () => {
    const { issue } = await fetchIssue({ ...BASE });
    expect(issue?.teamId).toBeUndefined();
    expect(issue?.linearProjectId).toBeUndefined();
  });
});
