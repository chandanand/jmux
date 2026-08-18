import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { buildRaise } from "../../cli/raise";

const base = {
  question: "Which behaviour is correct?",
  options: ["keep the old one", "use the new one"],
  recommendIndex: 2,
  why: "the ticket does not say",
  context: "read the handbook page",
  authority: "product" as const,
  nowMs: 100,
};

describe("buildRaise", () => {
  test("options get stable ids and the recommendation resolves to one of them", () => {
    const r = buildRaise({ ...base, scope: { kind: "issue", identifier: "AAA-1" }, snapshot: null });
    expect(r.options).toHaveLength(2);
    expect(new Set(r.options.map((o) => o.id)).size).toBe(2);
    expect(r.options.some((o) => o.id === r.recommendation)).toBe(true);
    // --recommend is 1-based for a human; the record stores an option id.
    expect(r.recommendation).toBe(r.options[1]!.id);
  });

  test("a recommendation outside the option list is refused", () => {
    expect(() =>
      buildRaise({ ...base, recommendIndex: 5, scope: { kind: "issue", identifier: "AAA-1" }, snapshot: null }),
    ).toThrow(/recommend/i);
  });

  test("a raise with no options is refused", () => {
    expect(() =>
      buildRaise({ ...base, options: [], scope: { kind: "issue", identifier: "AAA-1" }, snapshot: null }),
    ).toThrow(/option/i);
  });

  test("the idempotency key is stable for the same scope and question", () => {
    const a = buildRaise({ ...base, scope: { kind: "issue", identifier: "AAA-1" }, snapshot: null });
    const b = buildRaise({ ...base, scope: { kind: "issue", identifier: "AAA-1" }, snapshot: null, nowMs: 999 });
    expect(a.idempotencyKey).toBe(b.idempotencyKey);
  });

  test("a different question is a different key", () => {
    const a = buildRaise({ ...base, scope: { kind: "issue", identifier: "AAA-1" }, snapshot: null });
    const b = buildRaise({ ...base, question: "something else", scope: { kind: "issue", identifier: "AAA-1" }, snapshot: null });
    expect(a.idempotencyKey).not.toBe(b.idempotencyKey);
  });

  test("a session raise records socket and session id, not just a name", () => {
    const r = buildRaise({
      ...base,
      scope: { kind: "session", socket: "work", sessionId: "$3", sessionName: "aaa-1", agentPane: "%7" },
      snapshot: "screen text",
    });
    expect(r.scope).toEqual({ kind: "session", socket: "work", sessionId: "$3", sessionName: "aaa-1", agentPane: "%7" });
  });

  test("a missing pane yields a null snapshot and still produces a raise", () => {
    // A raise is never lost because its screen was.
    const r = buildRaise({
      ...base,
      scope: { kind: "session", socket: "work", sessionId: "$3", sessionName: "aaa-1", agentPane: null },
      snapshot: null,
    });
    expect(r.snapshot).toBeNull();
    expect(r.state).toBe("open");
  });
});

// The dispatch case for `raise` inside `runCtl`'s group switch is not exercised
// by any unit test above — those call `buildRaise` directly, in-process. A
// previous review found that removing that one `case "raise":` line leaves the
// whole suite green: `src/cli.ts` is a pure argv parser nobody imports as an
// executable, and nothing else spawns the real CLI. This test drives the
// actual entry point (`bin/jmux`) as a subprocess, so a missing dispatch case
// shows up as a real failure here.
//
// `HOME` is redirected to a scratch directory for the lifetime of the
// subprocess so `ctl raise create` reads and writes a raises.json beside a
// throwaway config, never the real one.
const BIN = join(import.meta.dir, "..", "..", "..", "bin", "jmux");

describe("ctl raise create (entry point)", () => {
  let home: string | null = null;

  afterEach(() => {
    if (home) rmSync(home, { recursive: true, force: true });
    home = null;
  });

  test("creates a raise and prints it as JSON", () => {
    home = mkdtempSync(join(tmpdir(), "jmux-raise-entry-"));

    const result = Bun.spawnSync(
      [
        "bun",
        "run",
        BIN,
        "ctl",
        "raise",
        "create",
        "--issue",
        "AAA-1",
        "--question",
        "Which behaviour is correct?",
        "--option",
        "keep the old one",
        "--option",
        "use the new one",
        "--recommend",
        "2",
        "--why",
        "the ticket does not say",
        "--authority",
        "product",
        "--context",
        "read the handbook page",
      ],
      {
        env: { ...process.env, HOME: home, JMUX: "", TMUX: "", TMUX_PANE: "" },
        stdout: "pipe",
        stderr: "pipe",
      },
    );

    const stdout = result.stdout.toString();
    const stderr = result.stderr.toString();
    expect({ exitCode: result.exitCode, stdout, stderr }).toMatchObject({ exitCode: 0 });

    const parsed = JSON.parse(stdout);
    expect(parsed.version).toBe(1);
    expect(parsed.raise.scope).toEqual({ kind: "issue", identifier: "AAA-1" });
    expect(parsed.raise.state).toBe("open");
  });
});
