import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { applyRaiseEvent, listRaisesAt } from "../../cli/raise";
import { mutateRaises, readRaises } from "../../raises/store";
import type { Raise } from "../../raises/types";

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
