import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { applyRaiseEvent, listRaisesAt, parseRaiseListFilters, handleRaise } from "../../cli/raise";
import { mutateRaises, readRaises } from "../../raises/store";
import type { Raise, RaiseState } from "../../raises/types";

let dir: string;
let path: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "raise-actions-")); path = join(dir, "raises.json"); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function seed(over: Partial<Raise> = {}): Raise {
  const r: Raise = {
    id: "r1", createdAt: 1, idempotencyKey: "k1",
    scope: { kind: "issue", identifier: "AAA-1" },
    question: "q", options: [{ id: "o1", text: "a" }, { id: "o2", text: "b" }],
    recommendation: "o1", why: "w", context: "c", authority: "developer",
    snapshot: null, state: "open", answer: null, resolvedAt: null,
    ...over,
  };
  mutateRaises(path, () => [r]);
  return r;
}

describe("applyRaiseEvent", () => {
  test("answering records the choice and persists it", () => {
    seed();
    const out = applyRaiseEvent(path, "r1", { kind: "answer", optionId: "o2", note: null, atMs: 5 });
    expect(out.state).toBe("answered");
    const stored = readRaises(path);
    expect(stored.kind === "valid" && stored.raises[0]!.state).toBe("answered");
  });

  test("an illegal transition throws with the machine's reason and changes nothing", () => {
    seed({ state: "resolved", resolvedAt: 2 });
    expect(() => applyRaiseEvent(path, "r1", { kind: "answer", optionId: "o1", note: null, atMs: 5 }))
      .toThrow(/cannot answer/i);
    const stored = readRaises(path);
    expect(stored.kind === "valid" && stored.raises[0]!.state).toBe("resolved");
  });

  test("an unknown raise id is refused, not silently ignored", () => {
    seed();
    expect(() => applyRaiseEvent(path, "nope", { kind: "ack" })).toThrow(/nope/);
  });

  test("an issue raise cannot be resolved before its tracker change is applied", () => {
    seed({ state: "answered" });
    expect(() => applyRaiseEvent(path, "r1", { kind: "resolve", atMs: 9 })).toThrow(/cannot resolve/i);
  });

  // The `!target` guard above throws before `transition` ever runs. Without it
  // `target` stays `undefined` and `transition(undefined, event)` throws a
  // TypeError reading `raise.scope.kind`, which does not mention the id and
  // does not satisfy the "refused, not silently ignored" contract this
  // covers — see the guard-deletion proof in the task report.

  test("applyRaiseEvent refuses when the store itself cannot be read, with the reason", () => {
    // No `seed()`: the store is corrupted before any raise is written, so
    // `mutateRaises`'s own re-read under the lock hits `readRaises`'s error
    // path and returns `{ ok: false, why }` — this is the `!result.ok`
    // branch, distinct from a refused transition or an unknown id.
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, "not json");
    expect(() => applyRaiseEvent(path, "r1", { kind: "ack" })).toThrow(/could not be parsed/);
  });
});

describe("listRaisesAt", () => {
  test("filters by state, session and issue", () => {
    const sessionScope = { kind: "session" as const, socket: "default", sessionId: "$1", sessionName: "aaa-1", agentPane: null };
    const a = seed({ id: "a", state: "open" });
    const b = seed({ id: "b", state: "resolved", resolvedAt: 3, scope: sessionScope });
    mutateRaises(path, () => [a, b]);

    expect(listRaisesAt(path, { state: "open", session: null, issue: null }).map((r) => r.id)).toEqual(["a"]);
    expect(listRaisesAt(path, { state: null, session: "aaa-1", issue: null }).map((r) => r.id)).toEqual(["b"]);
    expect(listRaisesAt(path, { state: null, session: null, issue: "AAA-1" }).map((r) => r.id)).toEqual(["a"]);
    expect(listRaisesAt(path, { state: null, session: null, issue: null }).map((r) => r.id).sort()).toEqual(["a", "b"]);
  });

  test("a missing store is an empty list, not an error", () => {
    expect(listRaisesAt(path, { state: null, session: null, issue: null })).toEqual([]);
  });

  // Six defects in this project have been "an unreadable thing reported as an
  // empty thing" — a corrupt store must never read back as "no raises
  // waiting". This is the case the brief calls out by name: list must fail
  // when the store is unreadable, and never return `[]` for it.
  test("an unreadable store makes list fail with the reason, not an empty array", () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, "not json");
    expect(() => listRaisesAt(path, { state: null, session: null, issue: null })).toThrow(/could not be parsed/);
  });
});

describe("applyRaiseEvent retry", () => {
  test("delivery-failed plus retry returns to answered, and the change is persisted", () => {
    seed({ state: "delivery-failed", deliveryAttemptId: "a1", deliveryError: "socket reset" });
    const out = applyRaiseEvent(path, "r1", { kind: "retry" });
    expect(out.state).toBe("answered");
    const stored = readRaises(path);
    expect(stored.kind === "valid" && stored.raises[0]!.state).toBe("answered");
  });

  test("retry from any other state is refused with the machine's reason and changes nothing", () => {
    seed({ state: "open" });
    expect(() => applyRaiseEvent(path, "r1", { kind: "retry" })).toThrow(/cannot retry/i);
    const stored = readRaises(path);
    expect(stored.kind === "valid" && stored.raises[0]!.state).toBe("open");
  });

  test("an unknown raise id is refused, not silently ignored", () => {
    seed({ state: "delivery-failed" });
    expect(() => applyRaiseEvent(path, "nope", { kind: "retry" })).toThrow(/nope/);
  });
});

// The whole session path, end to end against a real temporary store. This is
// what proves a refused delivery can actually recover: `delivery-failed` was
// introduced so a refused send lands somewhere that is not "pending forever",
// but `retry` is the only transition out of it — nothing else accepts that
// state, and `resolve` requires `acknowledged`. A CLI layer that adds every
// other action but forgets `retry` reproduces the exact dead end
// `delivery-failed` exists to avoid: a human's answer that can never reach
// the agent. Asserting the state after every step, not just the last one,
// means a wrong intermediate transition fails here instead of only showing up
// as a wrong final state.
describe("the full session raise path", () => {
  test("open -> answer -> delivering -> delivery-failed -> retry -> delivering -> ack -> resolve", () => {
    seed({
      scope: { kind: "session", socket: "work", sessionId: "$3", sessionName: "aaa-1", agentPane: "%7" },
      state: "open",
    });

    const answered = applyRaiseEvent(path, "r1", { kind: "answer", optionId: "o2", note: null, atMs: 1 });
    expect(answered.state).toBe("answered");

    const delivering1 = applyRaiseEvent(path, "r1", { kind: "delivering", attemptId: "attempt-1" });
    expect(delivering1.state).toBe("delivery-pending");

    const failed = applyRaiseEvent(path, "r1", { kind: "delivery-failed", reason: "pane was gone" });
    expect(failed.state).toBe("delivery-failed");

    const retried = applyRaiseEvent(path, "r1", { kind: "retry" });
    expect(retried.state).toBe("answered");

    const delivering2 = applyRaiseEvent(path, "r1", { kind: "delivering", attemptId: "attempt-2" });
    expect(delivering2.state).toBe("delivery-pending");

    const acked = applyRaiseEvent(path, "r1", { kind: "ack" });
    expect(acked.state).toBe("acknowledged");

    const resolved = applyRaiseEvent(path, "r1", { kind: "resolve", atMs: 99 });
    expect(resolved.state).toBe("resolved");
    expect(resolved.resolvedAt).toBe(99);

    const stored = readRaises(path);
    expect(stored.kind === "valid" && stored.raises[0]!.state).toBe("resolved");
  });
});

// `applyRaiseEvent` above proves the lifecycle event itself works — it
// already did, since `transition` implements `retry` correctly and always
// has. What was missing is the CLI dispatch: `handleRaise`'s switch on
// `parsed.action` had no `case "retry"`, so `ctl raise retry <id>` fell
// through to "Unknown raise action" no matter how correct the lifecycle was.
// This drives the real entry point (`bin/jmux`) as a subprocess, the same way
// `raise-create.test.ts`'s own entry-point test does, rather than calling
// `applyRaiseEvent` directly — so a missing or removed dispatch case shows up
// here. It has to be a subprocess: `handleRaise` resolves the store from
// `homedir()`, and Bun's `os.homedir()` reads the OS user database rather
// than `process.env.HOME`, so redirecting it for an in-process call has no
// effect — only a freshly spawned process picks up an overridden `HOME`.
const BIN = join(import.meta.dir, "..", "..", "..", "bin", "jmux");

describe("ctl raise retry (entry point)", () => {
  test("`ctl raise retry <id>` reaches the retry event through the real action dispatch", () => {
    const home = mkdtempSync(join(tmpdir(), "raise-retry-entry-"));
    try {
      const raisesPath = join(home, ".config", "jmux", "raises.json");
      const seeded: Raise = {
        id: "r1", createdAt: 1, idempotencyKey: "k1",
        scope: { kind: "issue", identifier: "AAA-1" },
        question: "q", options: [{ id: "o1", text: "a" }, { id: "o2", text: "b" }],
        recommendation: "o1", why: "w", context: "c", authority: "developer",
        snapshot: null, state: "delivery-failed", answer: null, resolvedAt: null,
      };
      mutateRaises(raisesPath, () => [seeded]);

      const result = Bun.spawnSync(["bun", "run", BIN, "ctl", "raise", "retry", "r1"], {
        env: { ...process.env, HOME: home, JMUX: "", TMUX: "", TMUX_PANE: "" },
        stdout: "pipe",
        stderr: "pipe",
      });

      const stdout = result.stdout.toString();
      const stderr = result.stderr.toString();
      expect({ exitCode: result.exitCode, stdout, stderr }).toMatchObject({ exitCode: 0 });

      const parsed = JSON.parse(stdout);
      expect(parsed.raise.state).toBe("answered");

      const stored = readRaises(raisesPath);
      expect(stored.kind === "valid" && stored.raises[0]!.state).toBe("answered");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// `handleRaise` is the actual dispatch `runCtl` calls for every `ctl raise
// ...` invocation. Every test above calls `applyRaiseEvent` or
// `listRaisesAt` directly, which proves those functions are correct but
// proves nothing about whether `handleRaise`'s `switch (parsed.action)`
// still routes to them — a deleted `case` line leaves every one of those
// tests green while the actual command stops working. These tests close
// that gap for all nine actions `handleRaise` knows: `create`, `list`, and
// the seven event-driven actions.
//
// `handleRaise` always resolves the store from the real default config path
// (`defaultConfigPath()`), so `$HOME` is pointed at a fresh scratch
// directory for each test — the same mechanism `defaultConfigPath`'s own
// doc comment describes — and restored afterward, so nothing here ever
// touches a real `~/.config/jmux/raises.json`.
// ---------------------------------------------------------------------------

function raiseAt(over: Partial<Raise> = {}): Raise {
  return {
    id: "r1", createdAt: 1, idempotencyKey: "k1",
    scope: { kind: "issue", identifier: "AAA-1" },
    question: "q", options: [{ id: "o1", text: "a" }, { id: "o2", text: "b" }],
    recommendation: "o1", why: "w", context: "c", authority: "developer",
    snapshot: null, state: "open", answer: null, resolvedAt: null,
    ...over,
  };
}

const dispatchSessionScope = {
  kind: "session" as const,
  socket: "default",
  sessionId: "$1",
  sessionName: "aaa-1",
  agentPane: null,
};

const dummyCtx = { socket: null, paneId: null, sessionOverride: null, insideTmux: false, insideJmux: false };

describe("handleRaise dispatch (every wired action)", () => {
  let home: string;
  let raisesPath: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    originalHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), "raise-dispatch-"));
    process.env.HOME = home;
    raisesPath = join(home, ".config", "jmux", "raises.json");
  });

  afterEach(() => {
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    rmSync(home, { recursive: true, force: true });
  });

  test("create reaches its handler through the real dispatch, not the unknown-action refusal", () => {
    const result = handleRaise(dummyCtx, {
      group: "raise",
      action: "create",
      flags: { issue: "AAA-1", question: "q", recommend: "1", why: "w", context: "c", authority: "developer" },
      positional: [],
      repeated: { option: ["a", "b"] },
    }) as { version: number; raise: Raise };
    expect(result.raise.state).toBe("open");
  });

  test("list reaches its handler through the real dispatch, not the unknown-action refusal", () => {
    mutateRaises(raisesPath, () => [raiseAt({ state: "open" })]);
    const result = handleRaise(dummyCtx, {
      group: "raise",
      action: "list",
      flags: {},
      positional: [],
      repeated: {},
    }) as { version: number; raises: Raise[] };
    expect(result.raises).toHaveLength(1);
    expect(result.raises[0]!.id).toBe("r1");
  });

  const EVENT_DISPATCH_CASES: Array<[action: string, seed: Raise, flags: Record<string, string>, expectedState: RaiseState]> = [
    ["answer", raiseAt({ state: "open" }), { option: "o2" }, "answered"],
    ["delivering", raiseAt({ state: "answered", scope: dispatchSessionScope }), { attempt: "attempt-1" }, "delivery-pending"],
    ["delivery-failed", raiseAt({ state: "delivery-pending", scope: dispatchSessionScope }), { reason: "pane was gone" }, "delivery-failed"],
    ["applied", raiseAt({ state: "answered" }), {}, "applied"],
    ["ack", raiseAt({ state: "delivery-pending", scope: dispatchSessionScope }), {}, "acknowledged"],
    ["resolve", raiseAt({ state: "applied" }), {}, "resolved"],
    ["retry", raiseAt({ state: "delivery-failed", scope: dispatchSessionScope }), {}, "answered"],
  ];

  test.each(EVENT_DISPATCH_CASES)(
    "%s reaches its handler through the real dispatch, not the unknown-action refusal",
    (action, seed, flags, expectedState) => {
      mutateRaises(raisesPath, () => [seed]);
      const result = handleRaise(dummyCtx, {
        group: "raise",
        action,
        flags,
        positional: ["r1"],
        repeated: {},
      }) as { version: number; raise: Raise };
      expect(result.raise.state).toBe(expectedState);
    },
  );
});

describe("parseRaiseListFilters", () => {
  test("a valid --state passes through untouched", () => {
    const filters = parseRaiseListFilters({
      group: "raise", action: "list", flags: { state: "open" }, positional: [], repeated: {},
    });
    expect(filters).toEqual({ state: "open", session: null, issue: null });
  });

  // The allow-list check is what stands between "an unrecognised filter" and
  // "silently reads back as no matches": without it, `--state answerd`
  // would parse to `{ state: "answerd", ... }`, `listRaisesAt` would compare
  // every raise's real state against a value nothing can ever equal, and a
  // human asking what is waiting on them would see an empty queue instead of
  // a refusal naming their typo.
  test("an invalid --state is refused, naming the bad value, not silently accepted", () => {
    expect(() =>
      parseRaiseListFilters({
        group: "raise", action: "list", flags: { state: "answerd" }, positional: [], repeated: {},
      }),
    ).toThrow(/answerd/);
  });

  test("an invalid --state reaching handleRaise's list action is refused, never an empty result", () => {
    const home = mkdtempSync(join(tmpdir(), "raise-list-state-"));
    const originalHome = process.env.HOME;
    try {
      process.env.HOME = home;
      const raisesPath = join(home, ".config", "jmux", "raises.json");
      // A real, unresolved raise is waiting — the failure mode this guards
      // against is exactly that a human would see `[]` here and conclude
      // wrongly that nothing needs them.
      mutateRaises(raisesPath, () => [raiseAt({ state: "open" })]);

      expect(() =>
        handleRaise(dummyCtx, {
          group: "raise", action: "list", flags: { state: "answerd" }, positional: [], repeated: {},
        }),
      ).toThrow(/answerd/);
    } finally {
      if (originalHome !== undefined) process.env.HOME = originalHome;
      else delete process.env.HOME;
      rmSync(home, { recursive: true, force: true });
    }
  });
});
