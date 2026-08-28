import { describe, test, expect, mock } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, chmodSync, statSync } from "fs";
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
import { US } from "../../tmux-fields";

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

  // The query-failed test above cannot tell the two `if (requireNew)` call
  // sites in `issueStart` apart: with the query itself unhealthy, either one
  // alone refuses, so deleting either leaves that test green. The two tests
  // below each isolate one call site, with a *healthy* query, so only the
  // site actually responsible for that refusal can produce it. Both were
  // proven red by deleting their call site and restored — see the report.

  test("an already-linked issue refuses with the existing-link code before anything is read back", async () => {
    // Exercises the FIRST `if (requireNew)` block (the pass before the
    // session name is even derived). Deleting it does not fall through to
    // the second block: `firstPass.kind === "linked"` returns early via the
    // reuse path a few lines later, so an unguarded first block turns this
    // into a silent, successful reuse — no throw at all.
    const scratchHome = mkdtempSync(join(tmpdir(), "jmux-require-new-home-"));
    const scratchRepo = mkdtempSync(join(tmpdir(), "jmux-require-new-repo-"));
    const savedHome = process.env.HOME;
    const savedToken = process.env.LINEAR_TOKEN;
    const savedKey = process.env.LINEAR_API_KEY;
    process.env.HOME = scratchHome;
    delete process.env.LINEAR_TOKEN;
    delete process.env.LINEAR_API_KEY;

    const issueId = "FAKE-LINKED";
    const linkedLine = ["$1", "other-session", issueId, "/repo/wt"].join(US);

    try {
      await withStubbedTmux(
        { ok: true, lines: [linkedLine], rawOutput: "", error: "" },
        async (calls) => {
          let thrown: unknown = null;
          try {
            await handleIssue(fakeCtx(), startArgs(issueId, { "require-new": true }, scratchRepo));
          } catch (e) {
            thrown = e;
          }

          expect(thrown).toBeInstanceOf(CliError);
          expect((thrown as CliError).code).toBe("issue-already-linked");
          // Nothing beyond the one list-sessions read that produced the
          // refusal — no pane lookup for a "reused" reply, no set-option,
          // no new-session.
          expect(calls).toEqual([["list-sessions", "-f", expect.any(String), "-F", expect.any(String)]]);
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

  test("a session already sitting on the derived name refuses with the name-collision code, and adopts nothing", async () => {
    // Exercises the SECOND `if (requireNew)` block (the pass after the
    // session name is derived, against a *healthy* query). The first block
    // cannot catch this: on the first pass the issue is not linked to
    // anything yet, so `decideStartReuse` answers "none" and the first
    // check waves it through. Deleting the second block here reproduces
    // the exact live failure from the review: exit 0, `reused: true`, and
    // no owner token ever stamped.
    const scratchHome = mkdtempSync(join(tmpdir(), "jmux-require-new-home-"));
    const scratchRepo = mkdtempSync(join(tmpdir(), "jmux-require-new-repo-"));
    const savedHome = process.env.HOME;
    const savedToken = process.env.LINEAR_TOKEN;
    const savedKey = process.env.LINEAR_API_KEY;
    process.env.HOME = scratchHome;
    delete process.env.LINEAR_TOKEN;
    delete process.env.LINEAR_API_KEY;

    // Offline mode (no tracker configured) derives the session name as the
    // sanitized bare issue id, so a row already sitting on that exact name
    // — linked to a *different* issue — is the name-collision case.
    const issueId = "FAKE-TAKEN";
    const takenLine = ["$1", issueId, "OTHER-ISSUE", "/repo/wt"].join(US);

    try {
      await withStubbedTmux(
        { ok: true, lines: [takenLine], rawOutput: "", error: "" },
        async (calls) => {
          let thrown: unknown = null;
          try {
            await handleIssue(fakeCtx(), startArgs(issueId, { "require-new": true }, scratchRepo));
          } catch (e) {
            thrown = e;
          }

          expect(thrown).toBeInstanceOf(CliError);
          expect((thrown as CliError).code).toBe("session-name-taken");
          // Nothing beyond the one list-sessions read: no set-option
          // adopting the session, and above all no new-session — creating
          // or reusing anything is exactly what `--require-new` forbids.
          expect(calls).toEqual([["list-sessions", "-f", expect.any(String), "-F", expect.any(String)]]);
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

// ---------------------------------------------------------------------------
// Finding 2 (final whole-branch review): "no tmux server" has to mean two
// different things — genuinely no server (a readable, empty world; the
// start should proceed) versus a server that exists but cannot be queried
// (still refuse, unchanged). Both driven against real tmux, through the
// real `bun run bin/jmux ctl` entry point, on disposable sockets never the
// operator's own. A stubbed `runTmuxDirect` cannot stand in here — the
// defect this closes was a fixture whose failure text was worded to dodge
// the very regex it was meant to exercise.
// ---------------------------------------------------------------------------

const REAL_TMUX = Bun.which("tmux");
const CTL_BIN = join(import.meta.dir, "..", "..", "..", "bin", "jmux");

function realTmuxCall(socket: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const r = Bun.spawnSync([REAL_TMUX!, "-L", socket, ...args], { stdout: "pipe", stderr: "pipe" });
  return { ok: (r.exitCode ?? 1) === 0, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
}

function realTmuxSocketPath(socket: string): string {
  const uid = process.getuid!();
  const base = process.env.TMUX_TMPDIR && process.env.TMUX_TMPDIR.length > 0 ? process.env.TMUX_TMPDIR : "/tmp";
  return join(base, `tmux-${uid}`, socket);
}

function ctlLive(socket: string, args: string[], home: string): { exitCode: number; stdout: string; stderr: string } {
  const { LINEAR_API_KEY: _apiKey, LINEAR_TOKEN: _token, ...rest } = process.env;
  const env = { ...rest, HOME: home, JMUX: "", TMUX: "", TMUX_PANE: "" };
  const r = Bun.spawnSync(["bun", "run", CTL_BIN, "ctl", "--socket", socket, ...args], {
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  return { exitCode: r.exitCode ?? 1, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
}

function scratchGitRepo(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  Bun.spawnSync(["git", "init", "-q", dir]);
  return dir;
}

describe.skipIf(!REAL_TMUX)("--require-new against real tmux: no server vs. an unreadable one", () => {
  test("genuinely no server on the socket: the start proceeds instead of refusing", () => {
    // This socket has never been touched by any tmux command — absent, not
    // merely unchecked.
    const socket = `jmux-reqnew-cold-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    const home = mkdtempSync(join(tmpdir(), "jmux-reqnew-cold-home-"));
    const repo = scratchGitRepo("jmux-reqnew-cold-repo-");
    try {
      const result = ctlLive(
        socket,
        ["issue", "start", "COLD-1", "--require-new", "--owner-token", "TOK-COLD-1", "--repo", repo, "--no-launch-agent"],
        home,
      );

      expect({ exitCode: result.exitCode, stderr: result.stderr }).toMatchObject({ exitCode: 0 });
      const parsed = JSON.parse(result.stdout);
      expect(parsed.reused).toBe(false);

      // And the session is real, on the socket that had no server a moment
      // ago, carrying the owner token stamped in the same call.
      const rows = realTmuxCall(socket, ["list-sessions", "-F", "#{session_name}\t#{@orch-owned}"]);
      expect(rows.ok).toBe(true);
      expect(rows.stdout).toContain("TOK-COLD-1");
    } finally {
      realTmuxCall(socket, ["kill-server"]);
      // `kill-server` stops the process but this tmux build leaves the
      // socket file itself behind — remove it so the disposable socket
      // does not linger.
      rmSync(realTmuxSocketPath(socket), { force: true });
      rmSync(home, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("a server exists but its socket is unreadable: the start still refuses with session-query-failed", () => {
    const socket = `jmux-reqnew-unreadable-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    const home = mkdtempSync(join(tmpdir(), "jmux-reqnew-unreadable-home-"));
    const repo = scratchGitRepo("jmux-reqnew-unreadable-repo-");
    let socketPath: string | null = null;
    try {
      // A real server, so the socket file exists — then lock it down. Proof
      // this refusal is about unreadability, not mere absence.
      expect(realTmuxCall(socket, ["new-session", "-d", "-s", "seed", "-c", "/tmp"]).ok).toBe(true);
      socketPath = realTmuxSocketPath(socket);
      chmodSync(socketPath, 0o000);

      const result = ctlLive(
        socket,
        [
          "issue", "start", "UNREADABLE-1",
          "--require-new", "--owner-token", "TOK-UNREADABLE-1",
          "--repo", repo, "--no-launch-agent",
        ],
        home,
      );

      expect(result.exitCode).not.toBe(0);
      const payload = JSON.parse(result.stderr.trim());
      expect(payload.code).toBe("session-query-failed");
    } finally {
      if (socketPath) {
        try {
          statSync(socketPath);
          chmodSync(socketPath, 0o600);
        } catch {
          // Socket file never materialized — nothing to restore.
        }
      }
      realTmuxCall(socket, ["kill-server"]);
      // Same as above: `kill-server` alone does not remove the socket file
      // on this tmux build.
      if (socketPath) rmSync(socketPath, { force: true });
      rmSync(home, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
