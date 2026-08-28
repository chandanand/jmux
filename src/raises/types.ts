/**
 * Bumped whenever the JSON `ctl raise` emits changes shape. A consumer that
 * reads a version it does not know must refuse rather than guess.
 */
export const RAISES_CONTRACT_VERSION = 1;

export type RaiseState =
  | "open"
  | "answered"
  | "delivery-pending"
  | "delivery-failed"
  | "acknowledged"
  | "applied"
  | "resolved";

/** Every state a raise can be in, in the one place both the store's record validation and the CLI's `--state` filter draw from. */
export const RAISE_STATES: readonly RaiseState[] = [
  "open",
  "answered",
  "delivery-pending",
  "delivery-failed",
  "acknowledged",
  "applied",
  "resolved",
];

export type RaiseScope =
  /**
   * Socket and session id, not just a name. The session manager supports
   * several tmux sockets, and two of them can hold the same session name. A
   * name-only record lets one screen jump to the wrong server's session.
   */
  | { kind: "session"; socket: string; sessionId: string; sessionName: string; agentPane: string | null }
  | { kind: "issue"; identifier: string };

/** Stable id, never a display position: answering by position records the wrong choice. */
export interface RaiseOption { id: string; text: string }

export interface RaiseAnswer { optionId: string; note: string | null; answeredAt: number }

export interface Raise {
  id: string;
  createdAt: number;
  /** Two creates with the same key are one raise. See the store's `findByKey`. */
  idempotencyKey: string;
  scope: RaiseScope;
  question: string;
  options: RaiseOption[];
  /** An option id, validated to be one of `options`. */
  recommendation: string;
  why: string;
  context: string;
  authority: "developer" | "product";
  /** Pane capture taken AT CREATION. `null` when the pane was gone. */
  snapshot: string | null;
  state: RaiseState;
  answer: RaiseAnswer | null;
  deliveryAttemptId?: string;
  deliveryError?: string;
  /** Set on reaching `resolved`. Pruning orders by this, never by `createdAt`. */
  resolvedAt: number | null;
}

export type RaiseEvent =
  | { kind: "answer"; optionId: string; note: string | null; atMs: number }
  | { kind: "delivering"; attemptId: string }
  | { kind: "delivery-failed"; reason: string }
  | { kind: "retry" }
  | { kind: "ack" }
  | { kind: "applied" }
  | { kind: "resolve"; atMs: number };

export type TransitionResult =
  | { ok: true; raise: Raise }
  | { ok: false; why: string };
