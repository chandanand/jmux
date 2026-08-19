// Pins the JSON `ctl raise list` and `ctl raise create` emit. The orchestrator
// — a separate repository — reads this shape directly (`{ version, raises }`
// from `list`, `{ version, raise }` from `create`), and has no way to see a
// change here except by this test breaking. A field renamed, dropped, or
// added without this test noticing is exactly the kind of undocumented
// adapter this file exists to prevent.
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { handleRaise } from "../../cli/raise";
import { mutateRaises } from "../../raises/store";
import type { Raise } from "../../raises/types";
import type { CliContext } from "../../cli/context";
import type { ParsedCtlArgs } from "../../cli";

let dir: string;
let path: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "raise-contract-")); path = join(dir, "raises.json"); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const NULL_CTX: CliContext = { socket: null, paneId: null, sessionOverride: null, insideTmux: false, insideJmux: false };

// Fixed, hand-authored records — not built through `buildRaise` — so every
// field in this fixture is a literal this test controls, and the `list`
// assertion below can compare against them byte for byte with no
// non-determinism to explain away.
const issueRaise: Raise = {
  id: "issue-raise-1",
  createdAt: 1000,
  idempotencyKey: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  scope: { kind: "issue", identifier: "AAA-1" },
  question: "Which behaviour is correct?",
  options: [
    { id: "o1", text: "keep the old one" },
    { id: "o2", text: "use the new one" },
  ],
  recommendation: "o2",
  why: "the ticket does not say",
  context: "read the handbook page",
  authority: "product",
  snapshot: null,
  state: "open",
  answer: null,
  resolvedAt: null,
};

const sessionRaise: Raise = {
  id: "session-raise-1",
  createdAt: 2000,
  idempotencyKey: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  scope: { kind: "session", socket: "default", sessionId: "$1", sessionName: "aaa-1", agentPane: "%1" },
  question: "Should the retry back off?",
  options: [
    { id: "o1", text: "yes" },
    { id: "o2", text: "no" },
  ],
  recommendation: "o1",
  why: "flaky under load",
  context: "see the CI log",
  authority: "developer",
  snapshot: "pane text",
  state: "delivery-failed",
  answer: { optionId: "o1", note: null, answeredAt: 1500 },
  deliveryAttemptId: "attempt-1",
  deliveryError: "agent pane closed",
  resolvedAt: null,
};

describe("ctl raise list JSON contract", () => {
  test("emits {version, raises}, an issue raise and a session raise unchanged field for field", () => {
    mutateRaises(path, () => [issueRaise, sessionRaise]);
    const parsed: ParsedCtlArgs = { group: "raise", action: "list", flags: {}, positional: [], repeated: {} };
    const result = handleRaise(NULL_CTX, parsed, path);
    expect(result).toEqual({ version: 1, raises: [issueRaise, sessionRaise] });
  });
});

describe("ctl raise create JSON contract", () => {
  test("an issue raise: {version, raise}, no field omitted or renamed", () => {
    const parsed: ParsedCtlArgs = {
      group: "raise",
      action: "create",
      flags: {
        issue: "AAA-1",
        question: "Which behaviour is correct?",
        recommend: "2",
        why: "the ticket does not say",
        context: "read the handbook page",
        authority: "product",
      },
      positional: [],
      repeated: { option: ["keep the old one", "use the new one"] },
    };
    const result = handleRaise(NULL_CTX, parsed, path) as { version: number; raise: Raise };
    expect(result).toEqual({
      version: 1,
      raise: {
        // Genuinely non-deterministic (random id, wall clock, a
        // scope+question hash whose exact derivation is pinned separately in
        // raise-create.test.ts) — format-checked here, not value-pinned.
        id: expect.any(String),
        createdAt: expect.any(Number),
        idempotencyKey: expect.stringMatching(/^[0-9a-f]{32}$/),
        scope: { kind: "issue", identifier: "AAA-1" },
        question: "Which behaviour is correct?",
        options: [
          { id: expect.any(String), text: "keep the old one" },
          { id: expect.any(String), text: "use the new one" },
        ],
        recommendation: expect.any(String),
        why: "the ticket does not say",
        context: "read the handbook page",
        authority: "product",
        snapshot: null,
        state: "open",
        answer: null,
        resolvedAt: null,
      },
    });
  });
});

// A session-scoped `create` resolves its scope against a live tmux server
// (session id, agent pane) — the one part of this contract that cannot be
// pinned without one. Same real-tmux, dedicated-socket pattern already used
// elsewhere in this suite (see issue-provision-integration.test.ts).
const TMUX = Bun.which("tmux");

function tmux(socket: string, ...args: string[]): { code: number; out: string } {
  const r = Bun.spawnSync([TMUX!, "-L", socket, ...args], { stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode ?? 1, out: (r.stdout.toString() + r.stderr.toString()).trim() };
}

describe.skipIf(!TMUX)("ctl raise create JSON contract — session scope", () => {
  const socket = `jmux-raise-contract-${process.pid}`;
  const sessionName = "contract-fixture";

  afterEach(() => {
    tmux(socket, "kill-server");
  });

  test("a session raise: {version, raise}, no field omitted or renamed", () => {
    tmux(socket, "new-session", "-d", "-s", sessionName);

    const ctx: CliContext = { socket, paneId: null, sessionOverride: null, insideTmux: false, insideJmux: false };
    const parsed: ParsedCtlArgs = {
      group: "raise",
      action: "create",
      flags: {
        session: sessionName,
        question: "Should the retry back off?",
        recommend: "1",
        why: "flaky under load",
        context: "see the CI log",
        authority: "developer",
      },
      positional: [],
      repeated: { option: ["yes", "no"] },
    };
    const result = handleRaise(ctx, parsed, path) as { version: number; raise: Raise };
    expect(result).toEqual({
      version: 1,
      raise: {
        id: expect.any(String),
        createdAt: expect.any(Number),
        idempotencyKey: expect.stringMatching(/^[0-9a-f]{32}$/),
        scope: {
          kind: "session",
          socket,
          // Freshly assigned by a fresh tmux server for its first session —
          // deterministic in shape, not in exact value.
          sessionId: expect.stringMatching(/^\$\d+$/),
          sessionName,
          // No agent hook has fired against this session, so there is no
          // `@jmux-agent-pane` to resolve — matching `parseSessionLookupLine`'s
          // documented behaviour for a missing field.
          agentPane: null,
        },
        question: "Should the retry back off?",
        options: [
          { id: expect.any(String), text: "yes" },
          { id: expect.any(String), text: "no" },
        ],
        recommendation: expect.any(String),
        why: "flaky under load",
        context: "see the CI log",
        authority: "developer",
        // No capturable pane, so no snapshot — a raise is never lost because
        // its screen was, but there is also no screen here to capture.
        snapshot: null,
        state: "open",
        answer: null,
        resolvedAt: null,
      },
    });
  });
});
