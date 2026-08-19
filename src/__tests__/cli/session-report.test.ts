// `ctl session report` lets an agent say what happened when it finished with
// nothing to raise — see the doc comment on `buildSessionReportCommands` in
// `../../cli/session` for why silence has to be distinguishable from a crash.
//
// Every report this command writes is unbound: there is no turn counter
// anywhere in this repository, and this test file does not add one. The
// design is that a report can never be trusted on its own — only adjudicated
// — so every stored and returned report is stamped `unbound: true` and this
// file pins that stamp at both the write path (`handleSession`'s "report"
// action) and the read path (`ctl status`'s `buildStatusSnapshot`).
import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  buildSessionReportCommands,
  parseSessionReport,
  handleSession,
  SESSION_REPORT_OUTCOMES,
  encodeReportReason,
  decodeReportReason,
} from "../../cli/session";
import { buildStatusSnapshot, type StatusSessionRow, type StatusInputs } from "../../cli/status";
import { CliError, type CliContext } from "../../cli/context";
import type { ParsedCtlArgs } from "../../cli";

const dummyCtx: CliContext = {
  socket: null,
  paneId: null,
  sessionOverride: null,
  insideTmux: false,
  insideJmux: false,
};

describe("buildSessionReportCommands", () => {
  test.each([...SESSION_REPORT_OUTCOMES])("round-trips the %s outcome", (outcome: string) => {
    const cmds = buildSessionReportCommands("TRA-1", outcome, "did the thing");
    expect(cmds).toEqual([
      {
        args: ["set-option", "-t", "TRA-1", "@jmux-session-report-reason", "did the thing"],
        required: true,
      },
      {
        args: ["set-option", "-t", "TRA-1", "@jmux-session-report-outcome", outcome],
        required: true,
      },
    ]);
    // And parsing the two fields the commands above would have stamped
    // reconstructs the same report, unbound.
    expect(parseSessionReport(outcome, "did the thing")).toEqual({
      outcome,
      reason: "did the thing",
      unbound: true,
    });
  });

  // An unrecognised outcome is refused, naming the four valid ones — a
  // consumer's type covers exactly those four, and nothing else may ever be
  // persisted.
  test("an unrecognised outcome is refused, naming the four valid ones", () => {
    expect(() => buildSessionReportCommands("TRA-1", "done", "did the thing")).toThrow(CliError);
    try {
      buildSessionReportCommands("TRA-1", "done", "did the thing");
      throw new Error("expected a throw");
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      const message = (err as CliError).message;
      for (const outcome of SESSION_REPORT_OUTCOMES) {
        expect(message).toContain(outcome);
      }
    }
  });

  // A blank reason tells a human nothing, and carrying a reason a world
  // check cannot is the entire point of this command.
  test("a missing reason is refused", () => {
    expect(() => buildSessionReportCommands("TRA-1", "shipped", "")).toThrow(CliError);
  });

  test("a whitespace-only reason is refused", () => {
    expect(() => buildSessionReportCommands("TRA-1", "shipped", "   ")).toThrow(CliError);
  });
});

describe("parseSessionReport", () => {
  // Absence and an empty reason are different facts. A session nobody has
  // reported on reads back as `null`; a session whose outcome field is set
  // but whose reason field is somehow blank (corrupt state, never reachable
  // through the CLI's own refusal above) must still surface as a report —
  // never silently collapse into "no report", the exact "an unreadable thing
  // reported as an empty thing" defect this project keeps shipping.
  test("no outcome field reads as absent, not as an empty report", () => {
    expect(parseSessionReport("", "")).toBeNull();
    expect(parseSessionReport("", "some stray reason")).toBeNull();
  });

  test("an outcome field with a blank reason reads as a present, unbound report — distinct from absence", () => {
    const report = parseSessionReport("shipped", "");
    expect(report).not.toBeNull();
    expect(report).toEqual({ outcome: "shipped", reason: "", unbound: true });
  });

  test("every stored report is marked unbound", () => {
    for (const outcome of SESSION_REPORT_OUTCOMES) {
      expect(parseSessionReport(outcome, "r")?.unbound).toBe(true);
    }
  });
});

// A reason survives `set-option` (tmux stores opaque bytes) but not the read
// side: `list-panes -F` output is read one stdout line at a time, so a raw
// embedded newline in the option's value splits what tmux considers one pane
// row into what this codebase's own parsing treats as several, and
// everything after the first line is silently dropped — proven live against
// a real tmux server in the entry-point describe block below.
// `encodeReportReason`/`decodeReportReason` are the fix: no raw newline is
// ever handed to tmux, so this pure round trip is what the live tests below
// depend on holding.
describe("encodeReportReason / decodeReportReason", () => {
  test("round-trips a reason with a single embedded newline", () => {
    const raw = "line one\nline two";
    // The encoded form must carry no raw newline at all — that is the
    // property the read-path fix depends on, not merely that some
    // reversible transform happened. A no-op encoder would still pass a
    // decode(encode(x)) === x check trivially, for any x.
    expect(encodeReportReason(raw)).not.toContain("\n");
    expect(decodeReportReason(encodeReportReason(raw))).toBe(raw);
  });

  test("round-trips a reason with several newlines", () => {
    const raw = "step one failed\n\nwhat I tried:\n- a\n- b\n\nneed a human call";
    expect(encodeReportReason(raw)).not.toContain("\n");
    expect(decodeReportReason(encodeReportReason(raw))).toBe(raw);
  });

  test("a literal backslash-n pair is preserved, not decoded into a newline", () => {
    const raw = "the config key is literally \\n here";
    const roundTripped = decodeReportReason(encodeReportReason(raw));
    expect(roundTripped).toBe(raw);
    expect(roundTripped).not.toContain("\n");
  });

  test("a trailing newline is preserved, not trimmed away", () => {
    const raw = "done.\n";
    const roundTripped = decodeReportReason(encodeReportReason(raw));
    expect(roundTripped).toBe(raw);
    expect(roundTripped.endsWith("\n")).toBe(true);
  });

  test("a reason mixing backslashes and newlines round-trips exactly", () => {
    const raw = "path is C:\\\\repo\nbranch: fix\\bug\n\\n literal too";
    expect(decodeReportReason(encodeReportReason(raw))).toBe(raw);
  });
});

describe("handleSession report action", () => {
  test("requires --target", () => {
    const parsed: ParsedCtlArgs = {
      group: "session",
      action: "report",
      flags: { outcome: "shipped", reason: "done" },
      positional: [],
      repeated: {},
    };
    expect(() => handleSession(dummyCtx, parsed)).toThrow(/--target/);
  });
});

describe("ctl status surfaces a session report", () => {
  function inputs(rows: StatusSessionRow[], over: Partial<StatusInputs> = {}): StatusInputs {
    return {
      rows,
      linksByName: () => [],
      pinnedNames: new Set<string>(),
      branchByPath: () => null,
      nowSeconds: 1781480123,
      ...over,
    };
  }

  const baseRow = (o: Partial<StatusSessionRow>): StatusSessionRow => ({
    projectId: "",
    id: "$1",
    name: "TRA-123",
    agentState: "",
    agentSince: "",
    attention: "",
    attentionReason: "",
    linearIssues: [],
    path: "/repo/wt",
    active: true,
    reportOutcome: "",
    reportReason: "",
    ...o,
  });

  test("a session with no report surfaces report: null", () => {
    const out = buildStatusSnapshot(inputs([baseRow({})]));
    expect(out.sessions[0].report).toBeNull();
  });

  test("a reported session surfaces outcome, reason, and the unbound stamp", () => {
    const out = buildStatusSnapshot(
      inputs([baseRow({ reportOutcome: "needs-human", reportReason: "ambiguous requirement" })]),
    );
    expect(out.sessions[0].report).toEqual({
      outcome: "needs-human",
      reason: "ambiguous requirement",
      unbound: true,
    });
  });

  test("an empty stored reason still surfaces as a report, not as absence", () => {
    const out = buildStatusSnapshot(inputs([baseRow({ reportOutcome: "blocked", reportReason: "" })]));
    expect(out.sessions[0].report).toEqual({ outcome: "blocked", reason: "", unbound: true });
  });
});

// ---------------------------------------------------------------------------
// Entry-point, live-tmux round trip. Runs `ctl session report` and `ctl
// status` as real subprocesses against a disposable tmux server on its own
// socket — never the operator's real server — proving the whole pipeline
// (parseCtlArgs -> handleSession -> tmux options -> handleStatus) agrees with
// every unit test above, not just the pieces exercised in isolation.
// ---------------------------------------------------------------------------
const TMUX = Bun.which("tmux");
const BIN = join(import.meta.dir, "..", "..", "..", "bin", "jmux");
const SOCKET = `jmux-session-report-test-${process.pid}`;

function tmux(args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const r = Bun.spawnSync([TMUX!, "-L", SOCKET, ...args], { stdout: "pipe", stderr: "pipe" });
  return { ok: (r.exitCode ?? 1) === 0, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
}

function ctl(args: string[], home: string): { exitCode: number; stdout: string; stderr: string } {
  const r = Bun.spawnSync(["bun", "run", BIN, "ctl", "--socket", SOCKET, ...args], {
    env: { ...process.env, HOME: home, JMUX: "", TMUX: "", TMUX_PANE: "" },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { exitCode: r.exitCode ?? 1, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
}

describe.skipIf(!TMUX)("ctl session report (entry point, disposable tmux socket)", () => {
  test("reports through the real dispatch and reads back through ctl status", () => {
    const home = mkdtempSync(join(tmpdir(), "session-report-entry-"));
    const name = `report-test-${process.pid}`;
    try {
      const created = tmux(["new-session", "-d", "-s", name, "-c", "/tmp"]);
      expect(created.ok).toBe(true);

      const reportResult = ctl(
        ["session", "report", "--target", name, "--outcome", "shipped", "--reason", "merged and green"],
        home,
      );
      expect({ exitCode: reportResult.exitCode, stderr: reportResult.stderr }).toMatchObject({ exitCode: 0 });
      const reportParsed = JSON.parse(reportResult.stdout);
      expect(reportParsed.report).toEqual({
        outcome: "shipped",
        reason: "merged and green",
        unbound: true,
      });

      const statusResult = ctl(["status"], home);
      expect({ exitCode: statusResult.exitCode, stderr: statusResult.stderr }).toMatchObject({ exitCode: 0 });
      const statusParsed = JSON.parse(statusResult.stdout);
      const session = statusParsed.sessions.find((s: { name: string }) => s.name === name);
      expect(session).toBeDefined();
      expect(session.report).toEqual({
        outcome: "shipped",
        reason: "merged and green",
        unbound: true,
      });
    } finally {
      tmux(["kill-session", "-t", name]);
      tmux(["kill-server"]);
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("an unrecognised outcome is refused over the real entry point, naming the valid ones", () => {
    const home = mkdtempSync(join(tmpdir(), "session-report-entry-refuse-"));
    const name = `report-refuse-${process.pid}`;
    try {
      tmux(["new-session", "-d", "-s", name, "-c", "/tmp"]);
      const result = ctl(["session", "report", "--target", name, "--outcome", "done", "--reason", "x"], home);
      expect(result.exitCode).not.toBe(0);
      for (const outcome of SESSION_REPORT_OUTCOMES) {
        expect(result.stderr).toContain(outcome);
      }
    } finally {
      tmux(["kill-session", "-t", name]);
      tmux(["kill-server"]);
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Live proof that a reason containing newlines round-trips through a real
// server, not just through encodeReportReason/decodeReportReason in
// isolation: writes via `ctl session report`, reads back via `ctl status`
// (the only other place a report's tmux options are ever read), against a
// disposable tmux socket. Each case is exactly what the pure unit tests
// above assume holds once real tmux `set-option`/`list-panes -F` sit between
// write and read.
// ---------------------------------------------------------------------------
function reportAndReadBackViaStatus(reason: string): { home: string; report: unknown } {
  const home = mkdtempSync(join(tmpdir(), "session-report-newline-"));
  const name = `report-nl-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    const created = tmux(["new-session", "-d", "-s", name, "-c", "/tmp"]);
    expect(created.ok).toBe(true);

    const reportResult = ctl(["session", "report", "--target", name, "--outcome", "blocked", "--reason", reason], home);
    expect({ exitCode: reportResult.exitCode, stderr: reportResult.stderr }).toMatchObject({ exitCode: 0 });

    const statusResult = ctl(["status"], home);
    expect({ exitCode: statusResult.exitCode, stderr: statusResult.stderr }).toMatchObject({ exitCode: 0 });
    const statusParsed = JSON.parse(statusResult.stdout);
    const session = statusParsed.sessions.find((s: { name: string }) => s.name === name);
    expect(session).toBeDefined();

    return { home, report: session.report };
  } finally {
    tmux(["kill-session", "-t", name]);
    tmux(["kill-server"]);
    rmSync(home, { recursive: true, force: true });
  }
}

describe.skipIf(!TMUX)("a reason with newlines survives a live ctl status round trip", () => {
  test("an embedded newline round-trips intact through ctl status, not just the write response", () => {
    const reason = "ran the migration\nit failed on the third table";
    const { report } = reportAndReadBackViaStatus(reason);
    expect(report).toEqual({ outcome: "blocked", reason, unbound: true });
  });

  test("a multi-line reason with several newlines survives whole", () => {
    const reason = "tried three approaches:\n1. retry\n2. rollback\n3. manual fix\n\nnone worked, need a call";
    const { report } = reportAndReadBackViaStatus(reason);
    expect(report).toEqual({ outcome: "blocked", reason, unbound: true });
  });

  test("a literal backslash-n pair comes back as those two characters, not a newline", () => {
    const reason = "the env var is literally named FOO\\nBAR in the config";
    const { report } = reportAndReadBackViaStatus(reason);
    expect(report).toEqual({ outcome: "blocked", reason, unbound: true });
    const readReason = (report as { reason: string }).reason;
    expect(readReason).not.toContain("\n");
  });

  test("a trailing newline is preserved, not trimmed away", () => {
    const reason = "done for now.\n";
    const { report } = reportAndReadBackViaStatus(reason);
    expect(report).toEqual({ outcome: "blocked", reason, unbound: true });
    expect((report as { reason: string }).reason.endsWith("\n")).toBe(true);
  });
});
