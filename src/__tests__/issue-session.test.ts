import { describe, expect, test } from "bun:test";
import {
  linkKey,
  resolveIssueSessionName,
  issueWorktreePath,
  resolveIssueSession,
  drivingIssue,
  parseIssueLinkOption,
  formatIssueLinkOption,
  isWritableLinkId,
  isIssueFinished,
  slugifyName,
  sanitizeBranchName,
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

describe("drivingIssue", () => {
  const at = (identifier: string, stateType?: Issue["stateType"]) =>
    issue({ identifier, stateType });

  test("no issues means no driving issue", () => {
    expect(drivingIssue([])).toBeUndefined();
  });

  test("one issue drives itself", () => {
    expect(drivingIssue([at("TRA-1", "started")])?.identifier).toBe("TRA-1");
  });

  test("the least advanced unfinished issue wins", () => {
    const picked = drivingIssue([
      at("TRA-1", "started"),
      at("TRA-2", "backlog"),
      at("TRA-3", "unstarted"),
    ]);
    expect(picked?.identifier).toBe("TRA-2");
  });

  test("finished issues never drive while anything is open", () => {
    const picked = drivingIssue([
      at("TRA-1", "completed"),
      at("TRA-2", "canceled"),
      at("TRA-3", "started"),
    ]);
    expect(picked?.identifier).toBe("TRA-3");
  });

  test("all done settles on completed rather than canceled", () => {
    const picked = drivingIssue([at("TRA-1", "canceled"), at("TRA-2", "completed")]);
    expect(picked?.identifier).toBe("TRA-2");
  });

  test("ties break on array order", () => {
    const picked = drivingIssue([at("TRA-1", "started"), at("TRA-2", "started")]);
    expect(picked?.identifier).toBe("TRA-1");
  });

  // The behaviour this replaced was `issues[0]`. An adapter that populates no
  // stateType at all has to keep getting exactly that answer.
  test("with no stateType anywhere it is array order", () => {
    const picked = drivingIssue([at("TRA-1"), at("TRA-2"), at("TRA-3")]);
    expect(picked?.identifier).toBe("TRA-1");
  });

  test("an unknown stateType outranks a known finished one", () => {
    const picked = drivingIssue([at("TRA-1", "completed"), at("TRA-2")]);
    expect(picked?.identifier).toBe("TRA-2");
  });

  test("an unknown stateType never displaces a known unfinished one", () => {
    const picked = drivingIssue([at("TRA-1"), at("TRA-2", "started")]);
    expect(picked?.identifier).toBe("TRA-2");
  });
});

describe("issue link option encoding", () => {
  test("an unset or empty option is no issues", () => {
    expect(parseIssueLinkOption(undefined)).toEqual([]);
    expect(parseIssueLinkOption("")).toEqual([]);
    expect(parseIssueLinkOption("   ")).toEqual([]);
  });

  test("round-trips a list", () => {
    const ids = ["TRA-1", "TRA-2", "TRA-3"];
    expect(parseIssueLinkOption(formatIssueLinkOption(ids))).toEqual(ids);
  });

  test("a lone id round-trips unchanged — the single-issue case is a 1-element list", () => {
    expect(formatIssueLinkOption(["TRA-1"])).toBe("TRA-1");
    expect(parseIssueLinkOption("TRA-1")).toEqual(["TRA-1"]);
  });

  test("tolerates ragged whitespace from tmux", () => {
    expect(parseIssueLinkOption("  TRA-1   TRA-2\tTRA-3 ")).toEqual(["TRA-1", "TRA-2", "TRA-3"]);
  });

  // A duplicate would otherwise make the same issue count twice in the badge
  // and be offered twice for a transition.
  test("dedupes case-insensitively, keeping the first spelling", () => {
    expect(parseIssueLinkOption("TRA-1 tra-1 TRA-2")).toEqual(["TRA-1", "TRA-2"]);
  });

  test("rejects ids the option could not store unambiguously", () => {
    expect(isWritableLinkId("TRA-1")).toBe(true);
    expect(isWritableLinkId("  TRA-1  ")).toBe(true);
    expect(isWritableLinkId("TRA-1 TRA-2")).toBe(false);
    expect(isWritableLinkId("TRA\t1")).toBe(false);
    expect(isWritableLinkId("")).toBe(false);
    expect(isWritableLinkId("   ")).toBe(false);
  });

  // The invariant that makes space safe as a separator: anything the write
  // accepts must survive the read as exactly one id.
  test("every writable id survives a round-trip as one id", () => {
    for (const id of ["TRA-1", "eng-4242", "team/feature-1", "ABC-999"]) {
      expect(isWritableLinkId(id)).toBe(true);
      expect(parseIssueLinkOption(formatIssueLinkOption([id]))).toEqual([id]);
    }
  });
});

describe("isIssueFinished", () => {
  const at = (stateType?: Issue["stateType"]) => issue({ stateType });

  test("all three closed states count", () => {
    expect(isIssueFinished(at("completed"))).toBe(true);
    expect(isIssueFinished(at("canceled"))).toBe(true);
    // The one everybody forgets: never in a default Linear workflow, but
    // returned for closed-as-duplicate issues.
    expect(isIssueFinished(at("duplicate"))).toBe(true);
  });

  test("open states do not", () => {
    for (const s of ["triage", "backlog", "unstarted", "started"] as const) {
      expect(isIssueFinished(at(s))).toBe(false);
    }
  });

  // An adapter that cannot say is not evidence the work is done.
  test("an unknown stateType is not finished", () => {
    expect(isIssueFinished(at())).toBe(false);
  });

  // The two must agree, or a "finished" issue drives a session while the
  // fan-out treats it as live (or the reverse).
  test("agrees with drivingIssue's precedence", () => {
    const open = issue({ identifier: "TRA-OPEN", stateType: "started" });
    for (const s of ["completed", "canceled", "duplicate"] as const) {
      const done = issue({ identifier: "TRA-DONE", stateType: s });
      expect(isIssueFinished(done)).toBe(true);
      expect(drivingIssue([done, open])?.identifier).toBe("TRA-OPEN");
    }
  });
});

describe("slugifyName", () => {
  // The exact failure: a Linear project name went in unslugified, the space
  // split the worktree command, and `wtm create` built `Bulk` instead.
  test("turns a tracker project name into one safe token", () => {
    expect(slugifyName("Bulk Import / Importer V2"))
      .toBe("bulk-import-importer-v2");
  });

  test("never yields a space, which git refuses in a ref", () => {
    for (const s of ["a b", "  lots   of   space  ", "Tabs\tand\nnewlines"]) {
      expect(slugifyName(s)).not.toMatch(/\s/);
    }
  });

  test("collapses punctuation runs and trims the edges", () => {
    expect(slugifyName("--Foo & Bar!!--")).toBe("foo-bar");
    expect(slugifyName("(v2) [beta]")).toBe("v2-beta");
  });

  test("stays short enough to read in a tab strip, with no trailing hyphen", () => {
    const out = slugifyName("a".repeat(30) + " " + "b".repeat(30));
    expect(out.length).toBeLessThanOrEqual(40);
    expect(out.endsWith("-")).toBe(false);
  });

  test("unusable input yields an empty string rather than a bare hyphen", () => {
    expect(slugifyName("   ")).toBe("");
    expect(slugifyName("///")).toBe("");
  });
});

describe("sanitizeBranchName", () => {
  // Gentler than slugifyName on purpose: `/` is how humans namespace branches,
  // and Linear's own branchName uses it.
  test("keeps slash namespacing", () => {
    expect(sanitizeBranchName("feat/bulk-import")).toBe("feat/bulk-import");
    expect(sanitizeBranchName("jarred/tra-1-fix")).toBe("jarred/tra-1-fix");
  });

  test("kills whitespace, which is the character that broke provisioning", () => {
    expect(sanitizeBranchName("My Feature")).toBe("My-Feature");
    expect(sanitizeBranchName("a  b")).toBe("a-b");
  });

  test("removes what git forbids in a ref", () => {
    for (const bad of ["a~b", "a^b", "a?b", "a*b", "a[b", "a\\b", "a..b"]) {
      const out = sanitizeBranchName(bad);
      expect(out).not.toMatch(/[~^?*[\]\\]/);
      expect(out).not.toContain("..");
    }
  });

  test("strips leading and trailing separators", () => {
    expect(sanitizeBranchName("/feat/x/")).toBe("feat/x");
    expect(sanitizeBranchName("-feat-")).toBe("feat");
    expect(sanitizeBranchName(".hidden")).toBe("hidden");
  });

  test("nothing usable is an empty string, which callers treat as cancelled", () => {
    expect(sanitizeBranchName("   ")).toBe("");
    expect(sanitizeBranchName("~~~")).toBe("");
  });

  // The one-name rule: whatever comes out is also a tmux session name.
  test("still satisfies tmux's own rejects", () => {
    expect(sanitizeBranchName("a.b:c")).not.toMatch(/[.:]/);
  });
});
