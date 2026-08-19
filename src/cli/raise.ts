import { createHash, randomUUID } from "crypto";
import { homedir } from "os";
import { resolve } from "path";
import type { CliContext } from "./context";
import { CliError } from "./context";
import type { ParsedCtlArgs } from "../cli";
import type { Raise, RaiseScope } from "../raises/types";
import { RAISES_CONTRACT_VERSION } from "../raises/types";
import { raisesPathFor, mutateRaises, findByKey, pruneResolved } from "../raises/store";
import { buildAttentionCommands } from "./session";
import { runTmuxDirect } from "./tmux";
import { US, splitFields } from "../tmux-fields";

export interface BuildRaiseInput {
  scope: RaiseScope;
  question: string;
  options: string[];
  /** 1-based, as a human types it. The record stores an option id. */
  recommendIndex: number;
  why: string;
  context: string;
  authority: "developer" | "product";
  snapshot: string | null;
  nowMs: number;
}

/**
 * The key is derived from the scope and the question, never from the clock, so
 * a tick that asks the same question every two minutes produces one raise. A
 * resumed agent repeating an outcome is the same case.
 */
function idempotencyKeyFor(scope: RaiseScope, question: string): string {
  const scopeKey =
    scope.kind === "issue" ? `issue:${scope.identifier}` : `session:${scope.socket}:${scope.sessionId}`;
  return createHash("sha256").update(`${scopeKey} ${question}`).digest("hex").slice(0, 32);
}

export function buildRaise(input: BuildRaiseInput): Raise {
  if (input.options.length === 0) throw new CliError("a raise needs at least one --option");
  const options = input.options.map((text) => ({ id: randomUUID(), text }));
  const recommended = options[input.recommendIndex - 1];
  if (!recommended) {
    throw new CliError(`--recommend ${input.recommendIndex} is outside the ${options.length} option(s) given`);
  }
  return {
    id: randomUUID(),
    createdAt: input.nowMs,
    idempotencyKey: idempotencyKeyFor(input.scope, input.question),
    scope: input.scope,
    question: input.question,
    options,
    recommendation: recommended.id,
    why: input.why,
    context: input.context,
    authority: input.authority,
    snapshot: input.snapshot,
    state: "open",
    answer: null,
    resolvedAt: null,
  };
}

/**
 * Beside the config `ctl` actually uses. `ctl` (unlike the TUI) has no
 * `--config` flag, so this is always `~/.config/jmux/config.json` — the same
 * default `loadUserConfig()` and `ConfigStore` fall back to — and `raisesPathFor`
 * puts the store beside it. `$HOME` still governs where that resolves, exactly
 * as it does for every other jmux config path (see `log.ts`), which is what
 * lets a test point this at a scratch directory without a bespoke flag.
 */
function defaultConfigPath(): string {
  return resolve(homedir(), ".config", "jmux", "config.json");
}

/** How many resolved raises `create` leaves behind per mutation, alongside every unresolved one. */
const RESOLVED_HISTORY_LIMIT = 50;

export interface RaiseCreateArgs {
  sessionFlag: string | null;
  issueFlag: string | null;
  question: string;
  options: string[];
  recommendIndex: number;
  why: string;
  context: string;
  authority: "developer" | "product";
}

/**
 * Validate `ctl raise create` flags. Every field is required and explicit —
 * a raise a human is going to act on must never be built from a silently
 * defaulted question, recommendation or authority. Pure — exported so the
 * exactly-one-of-`--session`/`--issue` guard is directly testable without a
 * live tmux server.
 */
export function validateRaiseCreate(parsed: ParsedCtlArgs): RaiseCreateArgs {
  const { flags, repeated } = parsed;

  const sessionFlag = typeof flags.session === "string" ? flags.session : null;
  const issueFlag = typeof flags.issue === "string" ? flags.issue : null;
  if (sessionFlag && issueFlag) {
    throw new CliError("raise create takes exactly one of --session or --issue, not both");
  }
  if (!sessionFlag && !issueFlag) {
    throw new CliError("raise create requires exactly one of --session <name> or --issue <identifier>");
  }

  const question = typeof flags.question === "string" ? flags.question : "";
  if (!question) throw new CliError("raise create requires --question <text>");

  const options = repeated.option ?? [];

  const recommendRaw = typeof flags.recommend === "string" ? flags.recommend : null;
  if (recommendRaw === null) throw new CliError("raise create requires --recommend <n>");
  const recommendIndex = Number(recommendRaw);
  if (!Number.isInteger(recommendIndex)) {
    throw new CliError(`--recommend must be a whole number, got "${recommendRaw}"`);
  }

  const why = typeof flags.why === "string" ? flags.why : "";
  if (!why) throw new CliError("raise create requires --why <text>");

  const context = typeof flags.context === "string" ? flags.context : "";
  if (!context) throw new CliError("raise create requires --context <text>");

  const authorityRaw = typeof flags.authority === "string" ? flags.authority : "";
  if (authorityRaw !== "developer" && authorityRaw !== "product") {
    throw new CliError(`--authority must be "developer" or "product", got "${authorityRaw || "(none)"}"`);
  }

  return { sessionFlag, issueFlag, question, options, recommendIndex, why, context, authority: authorityRaw };
}

const SESSION_LOOKUP_FORMAT = ["#{session_id}", "#{@jmux-agent-pane}"].join(US);

export interface SessionLookupRow {
  sessionId: string;
  agentPane: string | null;
}

/**
 * Parse one `display-message -p "<SESSION_LOOKUP_FORMAT>"` line into a
 * session id and agent pane, or `null` when the session id field is empty
 * (tmux resolved no session). Pure — no tmux call, so the missing-pane case
 * is directly testable: an empty `@jmux-agent-pane` field (no agent has
 * fired a hook yet, or hooks predate this option — see `agent.ts`) comes back
 * `agentPane: null`, never an empty string.
 */
export function parseSessionLookupLine(line: string): SessionLookupRow | null {
  const [sessionId, agentPane] = splitFields(line);
  if (!sessionId) return null;
  return { sessionId, agentPane: agentPane || null };
}

/**
 * Resolve a session scope from its name. `sessionId` and `@jmux-agent-pane`
 * come from one `display-message`, not `list-panes`: `@jmux-agent-pane` is a
 * session option (see `agent.ts`), so any pane context reads the same value,
 * and a single lookup is enough.
 *
 * The socket falls back to the literal `"default"` when `ctx.socket` is null
 * (no `-L`/`--socket` and no `$TMUX` to parse one from), matching how jmux
 * already displays the unnamed default socket elsewhere (`main.ts`'s
 * `setSocket(socketName ?? "default")`). A scope's socket is never left
 * absent — two default-socket servers on two machines are still "the default
 * socket" as far as this record is concerned, and that is the identity this
 * field exists to pin down.
 */
function resolveSessionScope(ctx: CliContext, sessionName: string): RaiseScope {
  const socket = ctx.socket ?? "default";
  const result = runTmuxDirect(["display-message", "-t", sessionName, "-p", SESSION_LOOKUP_FORMAT], ctx.socket);
  if (!result.ok || result.lines.length === 0) {
    throw new CliError(`session "${sessionName}" was not found: ${result.error || "no output"}`);
  }
  const row = parseSessionLookupLine(result.lines[0]);
  if (!row) {
    throw new CliError(`session "${sessionName}" was not found`);
  }
  return { kind: "session", socket, sessionId: row.sessionId, sessionName, agentPane: row.agentPane };
}

/**
 * Whether there is a recorded agent pane worth capturing. Pure — the decision
 * `captureSnapshot` acts on before it ever calls `runTmuxDirect`, so the
 * missing-pane case ("A raise is never lost because its screen was") is
 * testable without a tmux server.
 */
export function isCapturablePane(agentPane: string | null): agentPane is string {
  return agentPane !== null;
}

/**
 * The snapshot targets the recorded agent pane (`@jmux-agent-pane`), never the
 * session's active pane — the active pane may be a setup pane or a shell (see
 * `agent.ts`). When the pane is gone or the capture fails, the snapshot is
 * `null` and creation proceeds anyway: a raise is never lost because its
 * screen was.
 */
function captureSnapshot(ctx: CliContext, agentPane: string | null): string | null {
  if (!isCapturablePane(agentPane)) return null;
  const result = runTmuxDirect(["capture-pane", "-p", "-t", agentPane], ctx.socket);
  return result.ok ? result.rawOutput : null;
}

/**
 * Persist a candidate raise idempotently at `path`: when an unresolved raise
 * with the same idempotency key already exists, it is returned unchanged and
 * no second raise is appended; otherwise the candidate is appended. Either
 * way `pruneResolved` runs in the same mutation. Exported (and parameterized
 * on `path` rather than reading `defaultConfigPath()` itself) so the
 * idempotency short-circuit — the load-bearing behaviour of `create` — is
 * directly testable against a temporary store, the same way `store.test.ts`
 * already tests `mutateRaises` itself.
 */
export function commitRaise(path: string, candidate: Raise, keep: number): Raise {
  let outcome: Raise | null = null;
  const mutation = mutateRaises(path, (raises) => {
    const existing = findByKey(raises, candidate.idempotencyKey);
    if (existing) {
      outcome = existing;
      return pruneResolved(raises, keep);
    }
    outcome = candidate;
    return pruneResolved([...raises, candidate], keep);
  });
  if (!mutation.ok) throw new CliError(mutation.why);
  if (outcome === null) {
    // Unreachable: mutateRaises invokes `fn` exactly once, and both branches
    // above set `outcome` before returning. Guarded rather than asserted so a
    // future change to that contract fails loudly instead of shipping `null`
    // as a `Raise`.
    throw new CliError("raise store mutation produced no result");
  }
  return outcome;
}

function createAction(ctx: CliContext, parsed: ParsedCtlArgs): { version: number; raise: Raise } {
  const args = validateRaiseCreate(parsed);

  const scope: RaiseScope = args.sessionFlag
    ? resolveSessionScope(ctx, args.sessionFlag)
    : { kind: "issue", identifier: args.issueFlag! };

  const snapshot = scope.kind === "session" ? captureSnapshot(ctx, scope.agentPane) : null;

  const candidate = buildRaise({
    scope,
    question: args.question,
    options: args.options,
    recommendIndex: args.recommendIndex,
    why: args.why,
    context: args.context,
    authority: args.authority,
    snapshot,
    nowMs: Date.now(),
  });

  const path = raisesPathFor(defaultConfigPath());
  const raise = commitRaise(path, candidate, RESOLVED_HISTORY_LIMIT);

  if (scope.kind === "session") {
    // Best-effort, like `issue-provision.ts`'s own writes of this same option:
    // the raise is already durably persisted above, and a session that can't
    // be flagged for attention must not turn an otherwise-successful create
    // into an error. This never calls the `clear` verb — a raise sets the
    // flag, it never unsets one it did not set. Note this flag is the signal
    // `ctl status` and the workflow board read for a flagged session; it is
    // not, by itself, what routes a session into the sidebar's `attention`
    // filter — `matchesFilter` resolves that from agent state (`waiting`),
    // a separate mechanism (`sidebar-sort.ts`).
    for (const cmd of buildAttentionCommands("set", scope.sessionName, candidate.question)) {
      runTmuxDirect(cmd.args, ctx.socket);
    }
  }

  return { version: RAISES_CONTRACT_VERSION, raise };
}

export function handleRaise(ctx: CliContext, parsed: ParsedCtlArgs): unknown {
  switch (parsed.action) {
    case "create":
      return createAction(ctx, parsed);
    default:
      throw new CliError(
        `Unknown raise action "${parsed.action}". Known actions: create, list, answer, delivering, delivery-failed, applied, ack, resolve`,
      );
  }
}
