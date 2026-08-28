import type { Raise, RaiseEvent, TransitionResult } from "./types";

/**
 * The two lifecycles, as one total function.
 *
 * A session raise must reach a running agent, so its answer travels
 * `answered -> delivery-pending -> acknowledged -> resolved`, with
 * `delivery-failed` as the landing place for a refused send. An issue raise has
 * no agent: its answer is a change to the tracker, so it travels
 * `answered -> applied -> resolved`, and it reaches `resolved` only once the
 * change has been confirmed by re-reading the issue.
 *
 * Every event that does not match the current state and scope is refused with a
 * reason. A raise is never advanced because a command returned zero.
 */
export function transition(raise: Raise, event: RaiseEvent): TransitionResult {
  const isSession = raise.scope.kind === "session";
  const refuse = (why: string): TransitionResult => ({ ok: false, why });
  const to = (patch: Partial<Raise>): TransitionResult => ({ ok: true, raise: { ...raise, ...patch } });

  switch (event.kind) {
    case "answer": {
      if (raise.state !== "open") return refuse(`cannot answer a raise in state ${raise.state}`);
      if (!raise.options.some((o) => o.id === event.optionId)) {
        return refuse(`${event.optionId} is not an option on this raise`);
      }
      return to({
        state: "answered",
        answer: { optionId: event.optionId, note: event.note, answeredAt: event.atMs },
      });
    }
    case "delivering": {
      if (!isSession) return refuse("only a session-scoped raise is delivered; an issue raise has no agent");
      if (raise.state !== "answered") return refuse(`cannot deliver a raise in state ${raise.state}`);
      return to({ state: "delivery-pending", deliveryAttemptId: event.attemptId });
    }
    case "delivery-failed": {
      if (!isSession) return refuse("only a session-scoped raise is delivered");
      if (raise.state !== "delivery-pending") return refuse(`cannot fail delivery from state ${raise.state}`);
      return to({ state: "delivery-failed", deliveryError: event.reason });
    }
    case "retry": {
      if (raise.state !== "delivery-failed") return refuse(`cannot retry from state ${raise.state}`);
      return to({ state: "answered" });
    }
    case "ack": {
      if (!isSession) return refuse("only a session-scoped raise is acknowledged");
      if (raise.state !== "delivery-pending") return refuse(`cannot acknowledge a raise in state ${raise.state}`);
      return to({ state: "acknowledged" });
    }
    case "applied": {
      if (isSession) return refuse("`applied` is issue-scoped; a session raise is delivered instead");
      if (raise.state !== "answered") return refuse(`cannot apply a raise in state ${raise.state}`);
      return to({ state: "applied" });
    }
    case "resolve": {
      const from = isSession ? "acknowledged" : "applied";
      if (raise.state !== from) return refuse(`cannot resolve a ${raise.scope.kind} raise from state ${raise.state}`);
      return to({ state: "resolved", resolvedAt: event.atMs });
    }
  }
}
