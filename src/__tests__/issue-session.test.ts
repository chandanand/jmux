import { describe, expect, test } from "bun:test";
import {
  linkKey,
  resolveIssueSessionName,
  issueWorktreePath,
  resolveIssueSession,
  type IssueSessionInput,
} from "../issue-session";
import type { Issue } from "../adapters/types";

function issue(over: Partial<Issue> = {}): Issue {
  return {
    id: "11111111-2222-3333-4444-555555555555",
    identifier: "TRA-123",
    title: "Fix the auth timeout",
    status: "In Progress",
    assignee: null,
    linkedMrUrls: [],
    webUrl: "https://linear.app/x/issue/TRA-123",
    team: "Core",
    ...over,
  };
}

function input(over: Partial<IssueSessionInput> = {}): IssueSessionInput {
  return {
    issue: issue(),
    links: new Map(),
    liveSessions: new Set(),
    repoDir: "/repo",
    sessionNameTemplate: "{identifier}",
    worktreeExists: () => false,
    ...over,
  };
}

describe("resolveIssueSessionName", () => {
  test("the tracker's suggested branch name wins over the template", () => {
    const name = resolveIssueSessionName(
      issue({ branchName: "jarred/tra-123-fix-auth" }),
      "{identifier}-{title}",
    );
    expect(name).toBe("jarred/tra-123-fix-auth");
  });

  test("{identifier} expands lowercased", () => {
    expect(resolveIssueSessionName(issue(), "{identifier}")).toBe("tra-123");
  });

  test("{title} slugifies and truncates to 40 characters", () => {
    const name = resolveIssueSessionName(
      issue({ title: "Retry storms on the payment webhook when upstream is slow" }),
      "{title}",
    );
    expect(name).toBe("retry-storms-on-the-payment-webhook-when");
    expect(name.length).toBe(40);
  });

  test("both placeholders expand in one template", () => {
    expect(resolveIssueSessionName(issue(), "{identifier}-{title}")).toBe(
      "tra-123-fix-the-auth-timeout",
    );
  });

  test("the result is a legal tmux session name", () => {
    // tmux rejects `.` and `:`; a suggested branch name can carry both.
    expect(resolveIssueSessionName(issue({ branchName: "rel/1.2:hotfix" }), "{identifier}"))
      .toBe("rel/1_2_hotfix");
  });
});

describe("issueWorktreePath", () => {
  test("is the repo dir and the session name — the one-name rule", () => {
    expect(issueWorktreePath("/repo", "tra-123")).toBe("/repo/tra-123");
  });
});

describe("resolveIssueSession", () => {
  test("an explicit link by tracker id resolves to that session", () => {
    const info = resolveIssueSession(
      input({ links: new Map([[linkKey(issue().id), "some-other-name"]]) }),
    );
    expect(info).toEqual({ state: "session", sessionName: "some-other-name" });
  });

  test("an explicit link by identifier resolves too — the CLI stores that form", () => {
    const info = resolveIssueSession(input({ links: new Map([["tra-123", "cli-started"]]) }));
    expect(info).toEqual({ state: "session", sessionName: "cli-started" });
  });

  test("identifier links match case-insensitively", () => {
    const info = resolveIssueSession(
      input({ links: new Map([[linkKey("TRA-123"), "cli-started"]]) }),
    );
    expect(info?.sessionName).toBe("cli-started");
  });

  test("an explicit link wins even when the issue's team maps to no repo", () => {
    const info = resolveIssueSession(
      input({ repoDir: null, links: new Map([["tra-123", "manually-linked"]]) }),
    );
    expect(info).toEqual({ state: "session", sessionName: "manually-linked" });
  });

  test("a live session under the derived name counts as started", () => {
    const info = resolveIssueSession(input({ liveSessions: new Set(["tra-123"]) }));
    expect(info).toEqual({ state: "session", sessionName: "tra-123" });
  });

  test("a worktree with no session is resumable, not started", () => {
    const info = resolveIssueSession(
      input({ worktreeExists: (p) => p === "/repo/tra-123" }),
    );
    expect(info).toEqual({ state: "worktree", sessionName: "tra-123" });
  });

  test("a live session outranks a worktree on disk", () => {
    const info = resolveIssueSession(
      input({ liveSessions: new Set(["tra-123"]), worktreeExists: () => true }),
    );
    expect(info?.state).toBe("session");
  });

  test("nothing on disk and nothing linked is unstarted", () => {
    expect(resolveIssueSession(input())).toBeUndefined();
  });

  test("an unmapped team can't derive a name, so nothing resolves", () => {
    expect(
      resolveIssueSession(input({ repoDir: null, worktreeExists: () => true })),
    ).toBeUndefined();
  });

  test("derivation honours the repo's session name template", () => {
    const info = resolveIssueSession(
      input({
        sessionNameTemplate: "{identifier}-{title}",
        liveSessions: new Set(["tra-123-fix-the-auth-timeout"]),
      }),
    );
    expect(info?.sessionName).toBe("tra-123-fix-the-auth-timeout");
  });
});
