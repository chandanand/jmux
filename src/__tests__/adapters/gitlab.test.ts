import { describe, test, expect, mock, beforeEach } from "bun:test";
import { GitLabAdapter, extractProjectPath } from "../../adapters/gitlab";

describe("extractProjectPath", () => {
  test("extracts from HTTPS URL", () => {
    expect(extractProjectPath("https://gitlab.com/org/repo.git")).toBe("org/repo");
  });

  test("extracts from HTTPS URL without .git", () => {
    expect(extractProjectPath("https://gitlab.com/org/repo")).toBe("org/repo");
  });

  test("extracts from SSH URL", () => {
    expect(extractProjectPath("git@gitlab.com:org/repo.git")).toBe("org/repo");
  });

  test("extracts nested group paths", () => {
    expect(extractProjectPath("https://gitlab.com/org/sub/repo.git")).toBe("org/sub/repo");
  });

  test("returns null for invalid URL", () => {
    expect(extractProjectPath("not-a-url")).toBeNull();
  });
});

describe("parseMrUrl", () => {
  test("parses GitLab MR URL", () => {
    const adapter = new GitLabAdapter({ type: "gitlab" });
    const result = adapter.parseMrUrl("https://gitlab.com/org/repo/-/merge_requests/42");
    expect(result).toBe("org%2Frepo:42");
  });

  test("returns null for non-MR URL", () => {
    const adapter = new GitLabAdapter({ type: "gitlab" });
    expect(adapter.parseMrUrl("https://example.com")).toBeNull();
  });

  test("handles nested group paths", () => {
    const adapter = new GitLabAdapter({ type: "gitlab" });
    const result = adapter.parseMrUrl("https://gitlab.com/org/sub/repo/-/merge_requests/7");
    expect(result).toBe("org%2Fsub%2Frepo:7");
  });
});

describe("getMyMergeRequests", () => {
  test("returns empty array when not authenticated", async () => {
    const adapter = new GitLabAdapter({ type: "gitlab" });
    const results = await adapter.getMyMergeRequests();
    expect(results).toEqual([]);
  });
});

describe("getMrsAwaitingMyReview", () => {
  test("returns empty array when not authenticated", async () => {
    const adapter = new GitLabAdapter({ type: "gitlab" });
    const results = await adapter.getMrsAwaitingMyReview();
    expect(results).toEqual([]);
  });
});

describe("GitLabAdapter", () => {
  test("starts in unauthenticated state", () => {
    const adapter = new GitLabAdapter({ type: "gitlab" });
    expect(adapter.type).toBe("gitlab");
    expect(adapter.authState).toBe("unauthenticated");
    expect(adapter.authHint).toBe("$GITLAB_TOKEN or $GITLAB_PRIVATE_TOKEN");
  });

  // Rewritten, not removed: this asserted that a non-empty env var means "ok",
  // which is the bug — a revoked token reported connected, and swapping to one
  // would replace a working adapter with a dead one. It also reached the real
  // gitlab.com once authenticate() started probing.
  test("authenticate succeeds when the API confirms the token", async () => {
    const origToken = process.env.GITLAB_TOKEN;
    const realFetch = globalThis.fetch;
    process.env.GITLAB_TOKEN = "test-token";
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ username: "ada" }), { status: 200 })) as unknown as typeof fetch;
    try {
      const adapter = new GitLabAdapter({ type: "gitlab" });
      await adapter.authenticate();
      expect(adapter.authState).toBe("ok");
      expect(adapter.identity?.account).toBe("ada");
    } finally {
      globalThis.fetch = realFetch;
      if (origToken === undefined) delete process.env.GITLAB_TOKEN;
      else process.env.GITLAB_TOKEN = origToken;
    }
  });

  test("a rejected token reports failed", async () => {
    const origToken = process.env.GITLAB_TOKEN;
    const realFetch = globalThis.fetch;
    process.env.GITLAB_TOKEN = "revoked";
    globalThis.fetch = (async () => new Response("{}", { status: 401 })) as unknown as typeof fetch;
    try {
      const adapter = new GitLabAdapter({ type: "gitlab" });
      await adapter.authenticate();
      expect(adapter.authState).toBe("failed");
    } finally {
      globalThis.fetch = realFetch;
      if (origToken === undefined) delete process.env.GITLAB_TOKEN;
      else process.env.GITLAB_TOKEN = origToken;
    }
  });

  test("a network error reports unreachable, not failed", async () => {
    const origToken = process.env.GITLAB_TOKEN;
    const realFetch = globalThis.fetch;
    process.env.GITLAB_TOKEN = "test-token";
    globalThis.fetch = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    try {
      const adapter = new GitLabAdapter({ type: "gitlab" });
      await adapter.authenticate();
      expect(adapter.authState).toBe("unreachable");
    } finally {
      globalThis.fetch = realFetch;
      if (origToken === undefined) delete process.env.GITLAB_TOKEN;
      else process.env.GITLAB_TOKEN = origToken;
    }
  });

  test("authenticate fails without env var", async () => {
    const origToken = process.env.GITLAB_TOKEN;
    const origPrivate = process.env.GITLAB_PRIVATE_TOKEN;
    const origPersonal = process.env.GITLAB_PERSONAL_ACCESS_TOKEN;
    delete process.env.GITLAB_TOKEN;
    delete process.env.GITLAB_PRIVATE_TOKEN;
    delete process.env.GITLAB_PERSONAL_ACCESS_TOKEN;
    try {
      const adapter = new GitLabAdapter({ type: "gitlab" });
      await adapter.authenticate();
      expect(adapter.authState).toBe("failed");
    } finally {
      if (origToken !== undefined) process.env.GITLAB_TOKEN = origToken;
      if (origPersonal !== undefined) process.env.GITLAB_PERSONAL_ACCESS_TOKEN = origPersonal;
      if (origPrivate !== undefined) process.env.GITLAB_PRIVATE_TOKEN = origPrivate;
    }
  });
});
