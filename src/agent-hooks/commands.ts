import type { AgentKind, AgentState } from "../types";
import type { HookEvent, HookEntry } from "./types";
import { PROMPT_OPTION, TITLE_CAPTURE_OPTION } from "../session-title/display";

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
 * Store the human's first prompt for the session titler, guarded twice.
 *
 * Three things here are load-bearing:
 *
 *  - **It runs after the state write, not as part of it.** Reading the prompt
 *    means reading the hook's stdin, and a `cat` with nothing on the other end
 *    blocks until the hook's timeout. Ordering it second means the worst case is
 *    a missing title rather than a RUNNING indicator that appears five seconds
 *    late. This is the one event where the "one tmux process per fire" property
 *    above is deliberately relaxed: `UserPromptSubmit` fires once per human
 *    prompt, unlike `PreToolUse`.
 *  - **`@jmux-title-capture` gates it.** jmux writes that global option at
 *    startup from `sessionTitle.command`. Hooks are installed once and cannot
 *    read jmux's config, so an option is how they ask — and without it,
 *    installing agent hooks would store the human's prompts whether or not they
 *    use titling at all.
 *  - **It skips a pane that already has a value**, using the same
 *    non-inheriting `show-option -p` read as writeRunningIdempotent. That makes
 *    the stored value the *first* prompt rather than the latest, so a title is
 *    stable for the life of the session, and the capture runs once instead of on
 *    every prompt.
 *
 * The raw stdin JSON is stored and jmux parses it. Extracting a field in a shell
 * one-liner needs `jq`, which is not guaranteed to exist, and a hand-rolled
 * `sed` would be wrong on the first prompt containing a quote. Parsing belongs
 * where parsing is easy.
 */
function capturePrompt(): string {
  const capture = `tmux show-option -gqv ${TITLE_CAPTURE_OPTION} 2>/dev/null`;
  const existing =
    `tmux show-option -p -t "$TMUX_PANE" -qv ${PROMPT_OPTION} 2>/dev/null`;
  const store =
    'p=$(head -c 4000); ' +
    `tmux set-option -t "$TMUX_PANE" -p ${PROMPT_OPTION} "$p"`;
  return `{ [ -n "$(${capture})" ] && [ -z "$(${existing})" ] && { ${store}; }; } 2>/dev/null || true`;
}

/**
 * The canonical event → command mapping. Both Claude Code and Codex accept
 * every one of these events under these exact names.
 */
export function hookCommands(kind: AgentKind): Record<HookEvent, string> {
  return {
    UserPromptSubmit: `${writeState(kind, "running")}\n${capturePrompt()}`,
    // Codex also emits PermissionRequest for requests handled by automatic
    // approval review. The event therefore does not mean a human is waiting,
    // and writing WAITING here leaves an actively-running tool under "Needs
    // you" with no post-approval event to clear it. Keep the pane RUNNING;
    // Claude Code's PermissionRequest is still a human-attention signal.
    PermissionRequest: kind === "codex"
      ? writeRunningIdempotent(kind)
      : writeState(kind, "waiting"),
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
