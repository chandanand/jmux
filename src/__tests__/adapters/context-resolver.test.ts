import { describe, test, expect, mock } from "bun:test";
import { homedir } from "os";
import {
  getGitBranch,
  getGitRemotes,
  selectRemote,
  resolveSessionContext,
} from "../../adapters/context-resolver";
import type {
  CodeHostAdapter,
  IssueTrackerAdapter,
  MergeRequest,
  Issue,
  SessionContext,
} from "../../adapters/types";

describe("getGitBranch", () => {
  test("returns null for non-git directory", async () => {
    const branch = await getGitBranch("/tmp");
    expect(branch).toBeNull();
  });
});

describe("tilde paths", () => {
  // A subprocess cwd is not shell-expanded, so a `~/…` path used to run
  // nowhere and read back as "not a git repo" — silently killing branch
  // discovery for every session.
  test("a ~ path resolves the same branch as its absolute form", async () => {
    const home = homedir();
    const abs = process.cwd();
    if (!abs.startsWith(home)) return; // repo lives outside $HOME; nothing to compare
    const tilde = "~" + abs.slice(home.length);
    expect(await getGitBranch(tilde)).toBe(await getGitBranch(abs));
  });

  test("a ~ path finds the same remotes as its absolute form", async () => {
    const home = homedir();
    const abs = process.cwd();
    if (!abs.startsWith(home)) return;
    const tilde = "~" + abs.slice(home.length);
    expect(await getGitRemotes(tilde)).toEqual(await getGitRemotes(abs));
  });
});

describe("selectRemote", () => {
  test("returns origin when no hostname match", () => {
    const remotes = [
      { name: "origin", url: "https://github.com/user/repo.git" },
      { name: "upstream", url: "https://github.com/org/repo.git" },
    ];
    const result = selectRemote(remotes, null);
    expect(result).toEqual({ name: "origin", url: "https://github.com/user/repo.git" });
  });

  test("matches remote by hostname for gitlab", () => {
    const remotes = [
      { name: "origin", url: "https://github.com/user/fork.git" },
      { name: "upstream", url: "https://gitlab.com/org/repo.git" },
    ];
    const result = selectRemote(remotes, "gitlab");
    expect(result).toEqual({ name: "upstream", url: "https://gitlab.com/org/repo.git" });
  });

  test("matches remote by hostname for github", () => {
    const remotes = [
      { name: "origin", url: "https://github.com/user/repo.git" },
      { name: "work", url: "https://gitlab.com/org/repo.git" },
    ];
    const result = selectRemote(remotes, "github");
    expect(result).toEqual({ name: "origin", url: "https://github.com/user/repo.git" });
  });

  test("falls back to origin when hostname doesn't match any remote", () => {
    const remotes = [
      { name: "origin", url: "https://bitbucket.org/user/repo.git" },
      { name: "mirror", url: "https://bitbucket.org/org/repo.git" },
    ];
    const result = selectRemote(remotes, "gitlab");
    expect(result).toEqual({ name: "origin", url: "https://bitbucket.org/user/repo.git" });
  });

  test("returns first remote when no origin exists", () => {
    const remotes = [
      { name: "upstream", url: "https://github.com/org/repo.git" },
    ];
    const result = selectRemote(remotes, null);
    expect(result).toEqual({ name: "upstream", url: "https://github.com/org/repo.git" });
  });

  test("returns null for empty remotes list", () => {
    const result = selectRemote([], null);
    expect(result).toBeNull();
  });
});

describe("resolveSessionContext", () => {
  test("returns empty context for non-git directory", async () => {
    const ctx = await resolveSessionContext({
      sessionName: "scratch",
      dir: "/tmp",
      codeHost: null,
      issueTracker: null,
      manualIssueIds: [],
      manualMrIds: [],
    });
    expect(ctx.branch).toBeNull();
    expect(ctx.remote).toBeNull();
    expect(ctx.mrs).toEqual([]);
    expect(ctx.issues).toEqual([]);
  });

  // `degraded` is what stops a cached context from permanently standing in for
  // links the tracker was merely unreachable for. See PollCoordinator backfill.
  const tracker = (pollIssue: () => Promise<any>) => ({
    type: "linear", authState: "ok", authHint: "",
    authenticate: mock(() => Promise.resolve()),
    getLinkedIssue: mock(() => Promise.resolve(null)),
    getIssueByBranch: mock(() => Promise.resolve(null)),
    pollIssue: mock(pollIssue),
    pollAllIssues: mock(() => Promise.resolve(new Map())),
    getAvailableStatuses: mock(() => Promise.resolve([])),
    listWorkflowStates: mock(() => Promise.resolve([])),
    openInBrowser: mock(() => {}),
    updateStatus: mock(() => Promise.resolve()),
    createIssue: mock(() => Promise.resolve({} as any)),
    searchIssues: mock(() => Promise.resolve([])),
    getMyIssues: mock(() => Promise.resolve([])),
    getTeams: mock(() => Promise.resolve([])),
    buildPrompt: mock(() => ""),
  }) as unknown as IssueTrackerAdapter;

  const ISSUE = {
    id: "i1", identifier: "TRA-1", title: "x", status: "Todo",
    assignee: null, linkedMrUrls: [], webUrl: "",
  };

  test("flags degraded when a link lookup throws", async () => {
    const ctx = await resolveSessionContext({
      sessionName: "s", dir: "/tmp", codeHost: null,
      issueTracker: tracker(() => Promise.reject(new Error("Unable to connect"))),
      manualIssueIds: ["i1"], manualMrIds: [],
    });
    expect(ctx.issues).toEqual([]);
    expect(ctx.degraded).toBe(true);
  });

  test("a clean resolution is not flagged", async () => {
    const ctx = await resolveSessionContext({
      sessionName: "s", dir: "/tmp", codeHost: null,
      issueTracker: tracker(() => Promise.resolve({ ...ISSUE })),
      manualIssueIds: ["i1"], manualMrIds: [],
    });
    expect(ctx.issues[0]?.id).toBe("i1");
    expect(ctx.degraded).toBeUndefined();
  });

  test("a skipped adapter is not degraded — retrying would skip it again", async () => {
    const unauth = tracker(() => Promise.reject(new Error("never called")));
    (unauth as any).authState = "unauthenticated";
    const ctx = await resolveSessionContext({
      sessionName: "s", dir: "/tmp", codeHost: null,
      issueTracker: unauth, manualIssueIds: ["i1"], manualMrIds: [],
    });
    expect(ctx.issues).toEqual([]);
    expect(ctx.degraded).toBeUndefined();
  });
});
