import { describe, test, expect, mock } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  requireNewOrRefuse,
  buildNewSessionArgs,
  handleIssue,
  type IssueLinkRow,
} from "../../cli/issue";
import { CliError, type CliContext } from "../../cli/context";
import * as tmuxModule from "../../cli/tmux";
import type { TmuxResult } from "../../cli/tmux";
import type { ParsedCtlArgs } from "../../cli";

const ROW: IssueLinkRow = {
  id: "$1",
  name: "TRA-123",
  issues: ["TRA-123"],
  path: "/repo/wt",
};

describe("requireNewOrRefuse", () => {
  test("a linked session is refused with the existing-link code", () => {
    const r = requireNewOrRefuse({ kind: "linked", row: ROW }, { ok: true, malformed: 0 });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.code).toBe("issue-already-linked");
  });

  test("an adoptable session is refused with the name-collision code", () => {
    const r = requireNewOrRefuse({ kind: "adopt", row: ROW, issues: [] }, { ok: true, malformed: 0 });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.code).toBe("session-name-taken");
  });

  test("none proceeds when the query was healthy", () => {
    expect(requireNewOrRefuse({ kind: "none" }, { ok: true, malformed: 0 }).ok).toBe(true);
  });

  test("A FAILED QUERY IS REFUSED, NOT TREATED AS NONE", () => {
    // Without this, a tmux failure yields zero known sessions, `none` is
    // returned, and a duplicate session is created for an issue that already
    // has one — while reporting success.
    const r = requireNewOrRefuse({ kind: "none" }, { ok: false, malformed: 0 });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.code).toBe("session-query-failed");
  });

  test("a malformed row is refused even when the query succeeded", () => {
    const r = requireNewOrRefuse({ kind: "none" }, { ok: true, malformed: 1 });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.code).toBe("session-query-failed");
  });
});

// `--owner-token` must stamp `@orch-owned` in the *same* tmux invocation that
// creates the session — not a follow-up call — because the session name is
// unreserved until `new-session` returns and the spawned process can outlive
// the caller. Proven at the level that actually decides the argv: deleting
// the stamping branch changes the array this function returns, with no tmux
// server, real or stubbed, required to see it.
describe("buildNewSessionArgs", () => {
  test("with no owner token, the invocation is unchanged", () => {
    const args = buildNewSessionArgs({
      sessionName: "TRA-1",
      otelEnv: "OTEL_RESOURCE_ATTRIBUTES=tmux_session_name=TRA-1",
      sessionCwd: "/repo",
      mainCommand: "bash",
      ownerToken: null,
    });
    expect(args).toEqual([
      "new-session", "-d", "-e", "OTEL_RESOURCE_ATTRIBUTES=tmux_session_name=TRA-1",
      "-s", "TRA-1", "-c", "/repo", "bash",
    ]);
  });

  test("an owner token stamps @orch-owned by chaining set-option onto the same invocation", () => {
    const args = buildNewSessionArgs({
      sessionName: "TRA-1",
      otelEnv: "OTEL_RESOURCE_ATTRIBUTES=tmux_session_name=TRA-1",
      sessionCwd: "/repo",
      mainCommand: "bash",
      ownerToken: "orch-token-1",
    });
    expect(args).toEqual([
      "new-session", "-d", "-e", "OTEL_RESOURCE_ATTRIBUTES=tmux_session_name=TRA-1",
      "-s", "TRA-1", "-c", "/repo", "bash",
      ";", "set-option", "-t", "TRA-1", "@orch-owned", "orch-token-1",
    ]);
  });
});

// --- Command-layer proof: a failed session query never reaches new-session ---
//
// Everything above tests the pure decision. This drives `issue start` itself,
// with tmux stubbed, to prove the decision is actually wired into the
// command — a refusal that still created the session would be worthless.
// `runTmuxDirect` is replaced module-wide for the span of the test and
// restored in `finally`; nothing here ever reaches a real tmux server.

const realRunTmuxDirect = tmuxModule.runTmuxDirect;

function fakeCtx(): CliContext {
  return { socket: null, paneId: null, sessionOverride: null, insideTmux: false, insideJmux: false };
}

function startArgs(issueId: string, flags: Record<string, string | boolean>, repo: string): ParsedCtlArgs {
  return {
    group: "issue",
    action: "start",
    flags: { ...flags, repo, "no-launch-agent": true },
    positional: [issueId],
    repeated: {},
  };
}

/**
 * Stub `runTmuxDirect` for the span of one test. `listSessions` controls the
 * `list-sessions` reply; every other command gets a generic success so the
 * rest of `issue start`'s plumbing (set-option, split-window, ...) can run
 * without ever touching a real tmux server. Calls are recorded in order.
 */
function withStubbedTmux<T>(
  listSessions: TmuxResult,
  run: (calls: string[][]) => Promise<T>,
): Promise<T> {
  const calls: string[][] = [];
  mock.module("../../cli/tmux", () => ({
    ...tmuxModule,
    runTmuxDirect: (args: string[]): TmuxResult => {
      calls.push(args);
      if (args[0] === "list-sessions") return listSessions;
      return { ok: true, lines: ["stub-pane"], rawOutput: "", error: "" };
    },
  }));
  return run(calls).finally(() => {
    mock.module("../../cli/tmux", () => ({ ...tmuxModule, runTmuxDirect: realRunTmuxDirect }));
  });
}

describe("--require-new wired through issue start", () => {
  test("a failed session query refuses before new-session is ever called", async () => {
    const scratchHome = mkdtempSync(join(tmpdir(), "jmux-require-new-home-"));
    const scratchRepo = mkdtempSync(join(tmpdir(), "jmux-require-new-repo-"));
    const savedHome = process.env.HOME;
    const savedToken = process.env.LINEAR_TOKEN;
    const savedKey = process.env.LINEAR_API_KEY;
    process.env.HOME = scratchHome;
    delete process.env.LINEAR_TOKEN;
    delete process.env.LINEAR_API_KEY;

    try {
      await withStubbedTmux(
        { ok: false, lines: [], rawOutput: "", error: "tmux: no server running on this socket" },
        async (calls) => {
          let thrown: unknown = null;
          try {
            await handleIssue(fakeCtx(), startArgs("FAKE-1", { "require-new": true }, scratchRepo));
          } catch (e) {
            thrown = e;
          }

          expect(thrown).toBeInstanceOf(CliError);
          expect((thrown as CliError).code).toBe("session-query-failed");
          // The load-bearing assertion: not "it returned an error", but that
          // the command never issued the one call that would have created a
          // duplicate session.
          expect(calls.some((c) => c[0] === "new-session")).toBe(false);
        },
      );
    } finally {
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
      if (savedToken !== undefined) process.env.LINEAR_TOKEN = savedToken;
      if (savedKey !== undefined) process.env.LINEAR_API_KEY = savedKey;
      rmSync(scratchHome, { recursive: true, force: true });
      rmSync(scratchRepo, { recursive: true, force: true });
    }
  });
});

describe("worktreePreexisting", () => {
  async function runOffline(worktreeAlreadyExists: boolean): Promise<{ worktreePreexisting?: boolean }> {
    const scratchHome = mkdtempSync(join(tmpdir(), "jmux-worktree-home-"));
    const scratchRepo = mkdtempSync(join(tmpdir(), "jmux-worktree-repo-"));
    const savedHome = process.env.HOME;
    const savedToken = process.env.LINEAR_TOKEN;
    const savedKey = process.env.LINEAR_API_KEY;
    process.env.HOME = scratchHome;
    delete process.env.LINEAR_TOKEN;
    delete process.env.LINEAR_API_KEY;

    if (worktreeAlreadyExists) {
      mkdirSync(join(scratchRepo, "FAKE-2"), { recursive: true });
    }

    try {
      return await withStubbedTmux(
        { ok: true, lines: [], rawOutput: "", error: "" },
        async () => {
          const result = (await handleIssue(
            fakeCtx(),
            startArgs("FAKE-2", {}, scratchRepo),
          )) as { worktreePreexisting?: boolean };
          return result;
        },
      );
    } finally {
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
      if (savedToken !== undefined) process.env.LINEAR_TOKEN = savedToken;
      if (savedKey !== undefined) process.env.LINEAR_API_KEY = savedKey;
      rmSync(scratchHome, { recursive: true, force: true });
      rmSync(scratchRepo, { recursive: true, force: true });
    }
  }

  test("false when the worktree does not exist yet", async () => {
    const result = await runOffline(false);
    expect(result.worktreePreexisting).toBe(false);
  });

  test("true when the worktree was already on disk", async () => {
    const result = await runOffline(true);
    expect(result.worktreePreexisting).toBe(true);
  });
});
