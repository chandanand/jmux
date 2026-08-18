import { describe, test, expect } from "bun:test";
import { transition } from "../../raises/lifecycle";
import type { Raise } from "../../raises/types";

function sessionRaise(over: Partial<Raise> = {}): Raise {
  return {
    id: "r1", createdAt: 1, idempotencyKey: "k1",
    scope: { kind: "session", socket: "default", sessionId: "$1", sessionName: "aaa-1", agentPane: "%1" },
    question: "q", options: [{ id: "o1", text: "a" }, { id: "o2", text: "b" }],
    recommendation: "o1", why: "w", context: "c", authority: "developer",
    snapshot: null, state: "open", answer: null, resolvedAt: null,
    ...over,
  };
}

function issueRaise(over: Partial<Raise> = {}): Raise {
  return { ...sessionRaise(), scope: { kind: "issue", identifier: "AAA-1" }, ...over };
}

describe("session-scoped lifecycle", () => {
  test("answering an open raise records the choice", () => {
    const r = transition(sessionRaise(), { kind: "answer", optionId: "o2", note: "n", atMs: 5 });
    expect(r.ok).toBe(true);
    expect(r.ok && r.raise.state).toBe("answered");
    expect(r.ok && r.raise.answer).toEqual({ optionId: "o2", note: "n", answeredAt: 5 });
  });

  test("delivering is written before the send, carrying an attempt id", () => {
    const r = transition(sessionRaise({ state: "answered" }), { kind: "delivering", attemptId: "a1" });
    expect(r.ok).toBe(true);
    expect(r.ok && r.raise.state).toBe("delivery-pending");
    expect(r.ok && r.raise.deliveryAttemptId).toBe("a1");
  });

  test("a refused delivery lands in delivery-failed, not pending forever", () => {
    const r = transition(sessionRaise({ state: "delivery-pending" }), { kind: "delivery-failed", reason: "pane is a shell" });
    expect(r.ok).toBe(true);
    expect(r.ok && r.raise.state).toBe("delivery-failed");
    expect(r.ok && r.raise.deliveryError).toBe("pane is a shell");
  });

  test("a failed delivery can be retried from answered", () => {
    const r = transition(sessionRaise({ state: "delivery-failed" }), { kind: "retry" });
    expect(r.ok && r.raise.state).toBe("answered");
  });

  test("ack and resolve are separate, so acknowledged is observable", () => {
    const acked = transition(sessionRaise({ state: "delivery-pending" }), { kind: "ack" });
    expect(acked.ok && acked.raise.state).toBe("acknowledged");
    const done = transition(acked.ok ? acked.raise : sessionRaise(), { kind: "resolve", atMs: 9 });
    expect(done.ok && done.raise.state).toBe("resolved");
    expect(done.ok && done.raise.resolvedAt).toBe(9);
  });

  test("a session raise cannot take the issue-scoped applied event", () => {
    const r = transition(sessionRaise({ state: "answered" }), { kind: "applied" });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.why).toMatch(/issue-scoped/i);
  });
});

describe("issue-scoped lifecycle", () => {
  test("an answered issue raise becomes applied when the tracker change is made", () => {
    const r = transition(issueRaise({ state: "answered" }), { kind: "applied" });
    expect(r.ok && r.raise.state).toBe("applied");
  });

  test("an issue raise resolves from applied, after the change was confirmed", () => {
    const r = transition(issueRaise({ state: "applied" }), { kind: "resolve", atMs: 7 });
    expect(r.ok && r.raise.state).toBe("resolved");
    expect(r.ok && r.raise.resolvedAt).toBe(7);
  });

  test("an issue raise cannot be delivered, because it has no agent", () => {
    const r = transition(issueRaise({ state: "answered" }), { kind: "delivering", attemptId: "a1" });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.why).toMatch(/no agent|session-scoped/i);
  });

  test("an issue raise cannot resolve straight from answered", () => {
    // Resolving before the tracker change is confirmed closes the question and
    // leaves the ticket unworkable. A command reporting success is not evidence.
    const r = transition(issueRaise({ state: "answered" }), { kind: "resolve", atMs: 7 });
    expect(r.ok).toBe(false);
  });
});

describe("every illegal transition is refused with a reason", () => {
  test.each([
    ["resolved", { kind: "answer", optionId: "o1", note: null, atMs: 1 }],
    ["open", { kind: "ack" }],
    ["open", { kind: "resolve", atMs: 1 }],
    ["acknowledged", { kind: "delivering", attemptId: "a1" }],
  ] as const)("%s refuses %o", (state, event) => {
    const r = transition(sessionRaise({ state }), event);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.why.length).toBeGreaterThan(0);
  });

  test("answering with an option id that is not on the raise is refused", () => {
    const r = transition(sessionRaise(), { kind: "answer", optionId: "nope", note: null, atMs: 1 });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.why).toMatch(/not an option/i);
  });
});
