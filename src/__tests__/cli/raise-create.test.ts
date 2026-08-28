import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  buildRaise,
  commitRaise,
  parseSessionLookupLine,
  isCapturablePane,
  validateRaiseCreate,
} from "../../cli/raise";
import { mutateRaises, readRaises } from "../../raises/store";
import type { Raise } from "../../raises/types";

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
    // Isolated to the empty-options guard's own message: `--recommend`
    // pointing past an empty option list throws a *different* message that
    // also happens to contain the word "option", so a looser assertion here
    // (e.g. /option/i) would still pass with the empty-options guard deleted
    // entirely — the `--recommend` guard would fire instead and the test
    // would never notice which one actually ran.
    expect(() =>
      buildRaise({ ...base, options: [], scope: { kind: "issue", identifier: "AAA-1" }, snapshot: null }),
    ).toThrow("a raise needs at least one --option");
  });

  test("the idempotency key is a fixed derivation of scope and question", () => {
    // A golden value, not a clock-variance comparison: `idempotencyKeyFor`
    // never reads `nowMs`, so asserting two keys built with different
    // `nowMs` values match proves nothing about the derivation — it passes
    // whether or not the key is clock-derived. Pinning the exact hash means
    // any change to what the key is built from (including adding the clock)
    // breaks this test.
    const r = buildRaise({ ...base, scope: { kind: "issue", identifier: "AAA-1" }, snapshot: null });
    expect(r.idempotencyKey).toBe("860f8dc363c962f4923e73cb88fd054a");
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

// `commitRaise` is the load-bearing decision behind `create`'s idempotency:
// a tick that asks the same question every two minutes must produce one
// raise, and a resumed agent repeating an outcome is the same case. It is
// exercised here against a real temporary store file, the same way
// `raises/store.test.ts` exercises `mutateRaises` directly — no tmux
// involved, since an issue-scoped raise never touches it.
describe("commitRaise", () => {
  let dir: string;
  let path: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function freshCandidate(question = base.question): Raise {
    return buildRaise({ ...base, question, scope: { kind: "issue", identifier: "AAA-1" }, snapshot: null });
  }

  test("two calls with the same scope and question return the same raise, and only one is stored", () => {
    dir = mkdtempSync(join(tmpdir(), "raise-commit-"));
    path = join(dir, "raises.json");

    const first = commitRaise(path, freshCandidate(), 50);
    // A second, independently-built candidate — a different id and
    // createdAt, same idempotencyKey because scope and question match.
    const second = commitRaise(path, freshCandidate(), 50);

    expect(second.id).toBe(first.id);
    const stored = readRaises(path);
    expect(stored.kind === "valid" && stored.raises).toHaveLength(1);
  });

  test("varying only the question creates a second raise", () => {
    dir = mkdtempSync(join(tmpdir(), "raise-commit-"));
    path = join(dir, "raises.json");

    const first = commitRaise(path, freshCandidate("Which behaviour is correct?"), 50);
    const second = commitRaise(path, freshCandidate("Something else entirely"), 50);

    expect(second.id).not.toBe(first.id);
    const stored = readRaises(path);
    expect(stored.kind === "valid" && stored.raises).toHaveLength(2);
  });

  test("a resolved raise does not block a new one with the same key", () => {
    dir = mkdtempSync(join(tmpdir(), "raise-commit-"));
    path = join(dir, "raises.json");

    const candidate = freshCandidate();
    // Seed the store with an already-resolved raise carrying the same
    // idempotency key, exactly as if this same question had been asked,
    // answered and resolved before.
    const resolved: Raise = { ...candidate, id: "resolved-1", state: "resolved", resolvedAt: 1 };
    mutateRaises(path, (rs) => [...rs, resolved]);

    const created = commitRaise(path, candidate, 50);

    expect(created.id).toBe(candidate.id);
    expect(created.id).not.toBe("resolved-1");
    const stored = readRaises(path);
    expect(stored.kind === "valid" && stored.raises.map((r) => r.id).sort()).toEqual(
      [candidate.id, "resolved-1"].sort(),
    );
  });
});

describe("parseSessionLookupLine", () => {
  test("a missing agent pane field yields agentPane: null", () => {
    expect(parseSessionLookupLine("$3:|:")).toEqual({ sessionId: "$3", agentPane: null });
  });

  test("a present agent pane field is carried through", () => {
    expect(parseSessionLookupLine("$3:|:%7")).toEqual({ sessionId: "$3", agentPane: "%7" });
  });

  test("a missing session id is refused", () => {
    expect(parseSessionLookupLine(":|:%7")).toBeNull();
  });
});

describe("isCapturablePane", () => {
  test("null is not capturable", () => {
    expect(isCapturablePane(null)).toBe(false);
  });

  test("a pane id is capturable", () => {
    expect(isCapturablePane("%7")).toBe(true);
  });
});

describe("validateRaiseCreate", () => {
  // No `session` or `issue` key at all — every scope-related test below adds
  // exactly the ones it wants to exercise, rather than starting from one flag
  // set and knocking a key out.
  const scopelessFlags = {
    question: "Which behaviour is correct?",
    recommend: "1",
    why: "the ticket does not say",
    context: "read the handbook page",
    authority: "product",
  };

  test("neither --session nor --issue is refused", () => {
    expect(() =>
      validateRaiseCreate({
        group: "raise",
        action: "create",
        flags: { ...scopelessFlags },
        positional: [],
        repeated: { option: ["a", "b"] },
      }),
    ).toThrow(/requires exactly one of --session/);
  });

  test("both --session and --issue together is refused", () => {
    expect(() =>
      validateRaiseCreate({
        group: "raise",
        action: "create",
        flags: { ...scopelessFlags, session: "aaa-1", issue: "AAA-1" },
        positional: [],
        repeated: { option: ["a", "b"] },
      }),
    ).toThrow(/not both/);
  });

  test("exactly one of --session or --issue is accepted", () => {
    const args = validateRaiseCreate({
      group: "raise",
      action: "create",
      flags: { ...scopelessFlags, issue: "AAA-1" },
      positional: [],
      repeated: { option: ["a", "b"] },
    });
    expect(args.issueFlag).toBe("AAA-1");
    expect(args.sessionFlag).toBeNull();
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
