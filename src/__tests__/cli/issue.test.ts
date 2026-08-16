import { describe, test, expect } from "bun:test";
import { US } from "../../tmux-fields";
import {
  parseIssueLinkRow,
  findSessionForIssue,
  decideIssueLink,
  decideStartReuse,
  startSessionName,
  matchStatus,
  resolveRepoContextForIssue,
  resolveRepoForIssue,
  expandTilde,
  validateIssueCreate,
  resolveTeamId,
  parseWaitFlag,
  provisioningDone,
  type IssueLinkRow,
} from "../../cli/issue";
import type { Issue } from "../../adapters/types";
import type { JmuxConfig } from "../../config";
import { homedir } from "os";

const issue = (o: Partial<Issue>): Issue => ({
  id: "uuid",
  identifier: "TRA-123",
  title: "Fix the thing",
  status: "In Progress",
  assignee: null,
  linkedMrUrls: [],
  webUrl: "https://linear.app/x",
  ...o,
});

const linkRow = (o: Partial<IssueLinkRow>): IssueLinkRow => ({
  id: "$1",
  name: "TRA-123",
  issues: [],
  path: "/repo/wt",
  ...o,
});

describe("parseIssueLinkRow", () => {
  test("parses session id, name, issues and path", () => {
    expect(parseIssueLinkRow(["$1", "TRA-1", "TRA-1", "/p"].join(US))).toEqual({
      id: "$1",
      name: "TRA-1",
      issues: ["TRA-1"],
      path: "/p",
    });
  });

  test("parses several issues out of one option", () => {
    expect(parseIssueLinkRow(["$1", "feat", "TRA-1 TRA-2 TRA-3", "/p"].join(US))?.issues)
      .toEqual(["TRA-1", "TRA-2", "TRA-3"]);
  });

  test("an unset option is no issues, not one empty one", () => {
    expect(parseIssueLinkRow(["$1", "feat", "", "/p"].join(US))?.issues).toEqual([]);
  });

  test("returns null on a short line", () => {
    expect(parseIssueLinkRow("$1\x1fname")).toBeNull();
  });

  test("parses tmux 3.4 output where the separator is octal-escaped (issue #7)", () => {
    expect(parseIssueLinkRow(["$1", "TRA-1", "TRA-1", "/p"].join("\\037"))).toEqual({
      id: "$1",
      name: "TRA-1",
      issues: ["TRA-1"],
      path: "/p",
    });
  });
});

describe("findSessionForIssue", () => {
  test("finds the session linked to an issue", () => {
    const rows = [linkRow({ name: "a" }), linkRow({ name: "b", issues: ["TRA-9"] })];
    expect(findSessionForIssue(rows, "TRA-9")?.name).toBe("b");
  });

  test("finds it among several the session carries", () => {
    const rows = [linkRow({ name: "b", issues: ["TRA-1", "TRA-9", "TRA-4"] })];
    expect(findSessionForIssue(rows, "TRA-9")?.name).toBe("b");
  });

  test("returns null when no session is linked", () => {
    expect(findSessionForIssue([linkRow({})], "TRA-9")).toBeNull();
  });

  test("matches regardless of case — the option holds whatever was typed", () => {
    const rows = [linkRow({ name: "b", issues: ["TRA-9"] })];
    expect(findSessionForIssue(rows, "tra-9")?.name).toBe("b");
  });
});

describe("decideIssueLink (one session per issue; many issues per session)", () => {
  test("errors when the session does not exist", () => {
    const d = decideIssueLink([], "ghost", "TRA-1");
    expect(d).toEqual({ kind: "error", message: 'session "ghost" not found' });
  });

  test("errors when the issue is already linked to another session", () => {
    const rows = [linkRow({ name: "a" }), linkRow({ name: "b", issues: ["TRA-1"] })];
    const d = decideIssueLink(rows, "a", "TRA-1");
    expect(d.kind).toBe("error");
  });

  // The invariant that went away. A session already carrying work is exactly
  // the case this feature exists for.
  test("appends to a session that already carries other issues", () => {
    const rows = [linkRow({ name: "a", issues: ["TRA-2"] })];
    expect(decideIssueLink(rows, "a", "TRA-1"))
      .toEqual({ kind: "ok", issues: ["TRA-2", "TRA-1"] });
  });

  test("is a no-op when re-linking the same pair (idempotent)", () => {
    const rows = [linkRow({ name: "a", issues: ["TRA-1"] })];
    expect(decideIssueLink(rows, "a", "TRA-1")).toEqual({ kind: "noop" });
  });

  test("is ok for an unlinked session and a free issue", () => {
    const rows = [linkRow({ name: "a" })];
    expect(decideIssueLink(rows, "a", "TRA-1")).toEqual({ kind: "ok", issues: ["TRA-1"] });
  });

  // Space is the separator, so an id containing one would silently become two
  // links on the next read.
  test("refuses an id it could not store unambiguously", () => {
    const rows = [linkRow({ name: "a" })];
    expect(decideIssueLink(rows, "a", "TRA-1 TRA-2").kind).toBe("error");
  });

  test("a case difference is the same issue, not a second one", () => {
    // Otherwise one-session-per-issue is defeated by a shift key: `tra-1` would
    // link happily to a second session while `TRA-1` already owned one.
    expect(decideIssueLink([linkRow({ name: "a", issues: ["TRA-1"] })], "a", "tra-1"))
      .toEqual({ kind: "noop" });
    const twoSessions = [linkRow({ name: "a" }), linkRow({ name: "b", issues: ["TRA-1"] })];
    expect(decideIssueLink(twoSessions, "a", "tra-1").kind).toBe("error");
  });
});

describe("decideStartReuse", () => {
  test("a session carrying the link is reused, before the session name is known", () => {
    const rows = [linkRow({ name: "whatever", issues: ["TRA-1"] })];
    expect(decideStartReuse(rows, "TRA-1", null)).toEqual({ kind: "linked", row: rows[0]! });
  });

  test("nothing to reuse before the name is known means keep going", () => {
    expect(decideStartReuse([linkRow({ name: "a" })], "TRA-1", null))
      .toEqual({ kind: "none" });
  });

  test("an unlinked session on the derived name is adopted, not duplicated", () => {
    // The TUI records its link in state.json, which the CLI cannot read, so a
    // session jmux started looks unlinked here. Now that both derive the same
    // name, this is the path that stops `new-session` failing on a duplicate.
    const rows = [linkRow({ name: "tra-1-fix" })];
    expect(decideStartReuse(rows, "TRA-1", "tra-1-fix"))
      .toEqual({ kind: "adopt", row: rows[0]!, issues: ["TRA-1"] });
  });

  test("adopting a session that carries other issues appends rather than clobbers", () => {
    const rows = [linkRow({ name: "tra-1-fix", issues: ["TRA-999"] })];
    expect(decideStartReuse(rows, "TRA-1", "tra-1-fix"))
      .toEqual({ kind: "adopt", row: rows[0]!, issues: ["TRA-999", "TRA-1"] });
  });

  test("no session on the name means provision", () => {
    expect(decideStartReuse([linkRow({ name: "other" })], "TRA-1", "tra-1-fix"))
      .toEqual({ kind: "none" });
  });
});

describe("startSessionName", () => {
  test("prefers the tracker's branchName, sanitized", () => {
    expect(startSessionName("TRA-1", issue({ branchName: "jarred/tra-1.fix" }), "{identifier}"))
      .toBe("jarred/tra-1_fix");
  });

  test("uses the repo's session name template — the TUI's rule, not a second one", () => {
    expect(
      startSessionName("TRA-123", issue({ title: "Fix Auth", branchName: undefined }), "{identifier}"),
    ).toBe("tra-123");
    expect(
      startSessionName(
        "TRA-123",
        issue({ title: "Fix Auth", branchName: undefined }),
        "{identifier}-{title}",
      ),
    ).toBe("tra-123-fix-auth");
  });

  test("falls back to the bare id offline, where there is no issue to template", () => {
    expect(startSessionName("TRA-1", null, "{identifier}-{title}")).toBe("TRA-1");
  });
});

describe("matchStatus", () => {
  const available = ["To do", "In Progress", "QA (RELEASE BR)"];

  test("returns the tracker's canonical spelling, not what was typed", () => {
    // updateStatus matches exactly and no-ops silently on a miss, so echoing
    // the caller's casing back at it would turn a typo into a silent success.
    expect(matchStatus("in progress", available)).toBe("In Progress");
    expect(matchStatus("  QA (release br) ", available)).toBe("QA (RELEASE BR)");
  });

  test("returns null for a status the issue cannot move to", () => {
    expect(matchStatus("Shipped", available)).toBeNull();
  });
});

describe("expandTilde", () => {
  test("expands ~ and ~/", () => {
    expect(expandTilde("~")).toBe(homedir());
    expect(expandTilde("~/code")).toBe(`${homedir()}/code`);
  });

  test("leaves absolute paths untouched", () => {
    expect(expandTilde("/abs/path")).toBe("/abs/path");
  });
});

describe("resolveRepoForIssue", () => {
  // Rewritten from "falls back to teamRepoMap". That map is deleted by the
  // Projects migration, so reading it answered null for every issue and
  // `ctl issue start` refused work the sidebar would have started — the exact
  // "the CLI disagrees with my sidebar" failure the shared-module rule exists
  // to prevent. Resolution now goes through the router the TUI uses, which
  // keys on the team *id*.
  const config: JmuxConfig = {
    projects: [{ id: "backend", title: "Backend", dir: "/repos/backend", teamId: "T1" }],
  };

  test("prefers an explicit --repo flag", () => {
    expect(
      resolveRepoForIssue({ repo: "/explicit" }, issue({ team: "Platform", teamId: "T1" }), config),
    ).toBe("/explicit");
  });

  test("resolves through the issue's team id", () => {
    expect(resolveRepoForIssue({}, issue({ team: "Platform", teamId: "T1" }), config))
      .toBe("/repos/backend");
  });

  test("retains the routed Project id for provisioning", () => {
    expect(resolveRepoContextForIssue(
      {},
      issue({ team: "Platform", teamId: "T1" }),
      config,
    )).toEqual({ repo: "/repos/backend", projectId: "backend" });
  });

  test("infers an unambiguous Project for an explicit repo", () => {
    expect(resolveRepoContextForIssue(
      { repo: "/repos/backend" },
      null,
      config,
    )).toEqual({ repo: "/repos/backend", projectId: "backend" });
  });

  test("does not guess a Project when an explicit repo is shared", () => {
    const shared: JmuxConfig = {
      projects: [
        { id: "api", title: "API", dir: "/repos/mono" },
        { id: "web", title: "Web", dir: "/repos/mono" },
      ],
    };
    expect(resolveRepoContextForIssue(
      { repo: "/repos/mono" },
      null,
      shared,
    )).toEqual({ repo: "/repos/mono", projectId: null });
  });

  // A name is not unique across workspaces; routing must not fall back to it.
  test("a matching team name with no id does not resolve", () => {
    expect(resolveRepoForIssue({}, issue({ team: "Backend" }), config)).toBeNull();
  });

  test("returns null when nothing resolves", () => {
    expect(resolveRepoForIssue({}, issue({ team: "Unknown", teamId: "T9" }), config)).toBeNull();
    expect(resolveRepoForIssue({}, null, config)).toBeNull();
  });
});

describe("validateIssueCreate", () => {
  test("requires a title", () => {
    expect(() => validateIssueCreate({})).toThrow(/title/i);
    expect(() => validateIssueCreate({ title: true })).toThrow(/title/i);
  });

  test("accepts a title alone; description defaults to empty", () => {
    expect(validateIssueCreate({ title: "Fix auth" })).toEqual({
      title: "Fix auth",
      description: "",
      team: null,
      start: false,
    });
  });

  test("carries description, team and the --start flag", () => {
    expect(validateIssueCreate({
      title: "Fix auth",
      description: "It times out",
      team: "Platform",
      start: true,
    })).toEqual({
      title: "Fix auth",
      description: "It times out",
      team: "Platform",
      start: true,
    });
  });
});

describe("resolveTeamId", () => {
  const teams = [
    { id: "t-plat", name: "Platform" },
    { id: "t-web", name: "Web" },
  ];

  test("passes an exact id straight through", () => {
    expect(resolveTeamId("t-web", teams)).toBe("t-web");
  });

  test("resolves a team name case-insensitively", () => {
    expect(resolveTeamId("platform", teams)).toBe("t-plat");
  });

  test("defaults to the only team when none is given", () => {
    expect(resolveTeamId(null, [{ id: "solo", name: "Solo" }])).toBe("solo");
  });

  test("throws when ambiguous and unspecified", () => {
    expect(() => resolveTeamId(null, teams)).toThrow(/--team/);
  });

  test("throws for an unknown team", () => {
    expect(() => resolveTeamId("Mobile", teams)).toThrow(/Mobile/);
  });
});

describe("parseWaitFlag", () => {
  test("absent means do not wait — the default is non-blocking", () => {
    expect(parseWaitFlag(undefined)).toEqual({ wait: false, seconds: 0 });
    expect(parseWaitFlag(false)).toEqual({ wait: false, seconds: 0 });
  });

  test("bare --wait gets a bounded default, never an open-ended block", () => {
    const spec = parseWaitFlag(true);
    expect(spec.wait).toBe(true);
    expect(spec.seconds).toBeGreaterThan(0);
    expect(Number.isFinite(spec.seconds)).toBe(true);
  });

  test("--wait 60 takes the caller's bound", () => {
    expect(parseWaitFlag("60")).toEqual({ wait: true, seconds: 60 });
  });

  test("rejects a non-positive or non-numeric bound", () => {
    for (const bad of ["0", "-5", "soon", ""]) {
      expect(() => parseWaitFlag(bad)).toThrow(/--wait/);
    }
  });
});

describe("provisioningDone", () => {
  // The directory appears the moment the worktree tool creates it, which is
  // *before* any install hooks run. Treating that alone as "ready" is the bug
  // that let an interrupted setup be resumed as a finished one.
  test("a worktree directory alone is not ready", () => {
    expect(provisioningDone({ worktreeExists: true, setupPaneAlive: true })).toBe(false);
  });

  test("ready only once the setup pane has exited", () => {
    expect(provisioningDone({ worktreeExists: true, setupPaneAlive: false })).toBe(true);
  });

  test("no worktree is never ready, pane or not", () => {
    expect(provisioningDone({ worktreeExists: false, setupPaneAlive: false })).toBe(false);
    expect(provisioningDone({ worktreeExists: false, setupPaneAlive: true })).toBe(false);
  });
});
