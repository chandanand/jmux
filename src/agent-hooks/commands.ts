import type { AgentKind, AgentState } from "../types";
import type { HookEvent, HookEntry } from "./types";

/**
 * The shell snippets every agent integration emits. One module so all agents
 * write byte-identical semantics — the tracker treats tmux as the source of
 * truth, so a divergence between two installers' shell strings shows up as an
 * agent whose state is subtly wrong rather than as a build failure.
 *
 * Three properties are deliberate:
 *
 *  - **Pane-scoped.** `-p -t "$TMUX_PANE"` writes the option on the pane the
 *    agent actually runs in. Session scope would let two agents split into one
 *    session clobber each other, last writer wins.
 *  - **One tmux process per fire.** The writes are chained with tmux's own `;`
 *    separator instead of being four separate `tmux` invocations. `PreToolUse`
 *    fires on every tool call, and Codex runs hooks through `$SHELL -lc`, so
 *    process count is the cost that matters here.
 *  - **`@jmux-agent-kind` identifies the pane.** Nothing writes it at session
 *    scope, so unlike `@jmux-agent-state` it never inherits — a non-empty value
 *    proves *this* pane hosts an agent. Pane detection depends on that.
 */

export const HOOK_TIMEOUT = 5;

/**
 * Codex caps SessionEnd hooks at 3s and prints a warning on every startup for
 * anything higher. The clear is a single tmux call, so 3s is ample — matching
 * the cap keeps the console clean instead of nagging the user forever.
 */
export const SESSION_END_TIMEOUT = 3;

/** Marker every jmux-written hook command contains, used to detect + strip. */
export const JMUX_HOOK_MARKER = "@jmux-agent-state";

/** Marker for the pre-0.19 `@jmux-attention` Stop hook, migrated on install. */
export const LEGACY_HOOK_MARKER = "@jmux-attention";

const PANE = 'set-option -p -t "$TMUX_PANE"';

/**
 * `@jmux-agent-pane` stays session-scoped: it answers "which pane should an
 * orchestrator send keys to for this session", which is a session-level
 * question, and `jmux ctl agent state` reports it. `set-option -t "$TMUX_PANE"`
 * without `-p` resolves the pane target to its owning session.
 */
const SESSION_AGENT_PANE = 'set-option -t "$TMUX_PANE" @jmux-agent-pane "$TMUX_PANE"';

function writeState(kind: AgentKind, state: AgentState): string {
  return [
    `tmux ${PANE} @jmux-agent-state ${state}`,
    `${PANE} @jmux-agent-state-since "$(date +%s)"`,
    `${PANE} @jmux-agent-kind ${kind}`,
    `${SESSION_AGENT_PANE} 2>/dev/null || true`,
  ].join(" \\; ");
}

/**
 * Clears the pane's state on session end, so a finished agent stops reporting
 * anything at all rather than sitting on a terminal COMPLETE forever. `-u`
 * unsets; the pane's kind goes with it so the pane stops counting as an agent.
 */
function clearState(): string {
  return [
    `tmux set-option -pu -t "$TMUX_PANE" @jmux-agent-state`,
    `set-option -pu -t "$TMUX_PANE" @jmux-agent-state-since`,
    `set-option -pu -t "$TMUX_PANE" @jmux-agent-kind 2>/dev/null || true`,
  ].join(" \\; ");
}

/**
 * PreToolUse fires on EVERY tool invocation mid-task. Without this guard every
 * call would overwrite `@jmux-agent-state-since`, resetting the row-1 elapsed
 * timer and making a stuck tool invisible. The other hooks fire at clean
 * transition points and don't need it.
 *
 * The guard reads with `show-option -p`, which — unlike a format expansion —
 * does *not* inherit from the session. That is what makes this self-migrating:
 * a pane still covered by a legacy session-scoped value reads empty here, so
 * the first tool call promotes it to a proper pane-scoped value.
 */
function writeRunningIdempotent(kind: AgentKind): string {
  const read = 'tmux show-option -p -t "$TMUX_PANE" -qv @jmux-agent-state 2>/dev/null';
  return `[ "$(${read})" = "running" ] || { ${writeState(kind, "running")}; }`;
}

/**
 * The canonical event → command mapping. Both Claude Code and Codex accept
 * every one of these events under these exact names.
 */
export function hookCommands(kind: AgentKind): Record<HookEvent, string> {
  return {
    UserPromptSubmit: writeState(kind, "running"),
    PermissionRequest: writeState(kind, "waiting"),
    // Idempotent — see writeRunningIdempotent.
    PreToolUse: writeRunningIdempotent(kind),
    Stop: writeState(kind, "complete"),
    SessionEnd: clearState(),
  };
}

/** Build the hook block for the given agent, restricted to `events`. */
export function buildHookBlock(
  kind: AgentKind,
  events: readonly HookEvent[],
): Record<string, HookEntry[]> {
  const commands = hookCommands(kind);
  const out: Record<string, HookEntry[]> = {};
  for (const event of events) {
    const timeout = event === "SessionEnd" ? SESSION_END_TIMEOUT : HOOK_TIMEOUT;
    out[event] = [
      { hooks: [{ type: "command", command: commands[event], timeout }] },
    ];
  }
  return out;
}
