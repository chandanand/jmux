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

  test("authenticate succeeds with env var", async () => {
    const orig = process.env.LINEAR_API_KEY;
    process.env.LINEAR_API_KEY = "lin_test_key";
    try {
      const adapter = new LinearAdapter({ type: "linear" });
      await adapter.authenticate();
      expect(adapter.authState).toBe("ok");
    } finally {
      if (orig === undefined) delete process.env.LINEAR_API_KEY;
      else process.env.LINEAR_API_KEY = orig;
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
