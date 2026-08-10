/**
 * The tmux options a session's title lives in, and the one function that
 * decides what a session is called on screen.
 *
 * Options rather than `state.json` for the same reason the agent-state options
 * are: `ctl` has no IPC to the running TUI, so anything both halves must agree
 * on has to live where tmux can hold it. They are session-scoped — unlike
 * `@jmux-agent-state`, which is pane-scoped because several agents can share a
 * session and the last writer would clobber its siblings. A title has the
 * opposite shape: one session, one row, one name. There is nothing to roll up.
 */

/** The title itself. Session-scoped. */
export const SESSION_TITLE_OPTION = "@jmux-session-title";

/**
 * The signature of the input that produced the current title. Session-scoped.
 *
 * Two jobs. It is the cache key that stops a restart re-titling every session,
 * and it carries {@link MANUAL_SIGNATURE} when the human named the session
 * themselves — which is what makes "an explicit rename wins" survive a restart
 * rather than being an in-memory set jmux forgets.
 */
export const TITLE_SIGNATURE_OPTION = "@jmux-title-signature";

/**
 * The first prompt the human gave an agent in this pane. Pane-scoped, written
 * once by the `UserPromptSubmit` hook — see agent-hooks/commands.ts.
 */
export const PROMPT_OPTION = "@jmux-prompt";

/**
 * The gate the prompt-capture hook reads before storing anything.
 *
 * Global session option, written by jmux at startup from `sessionTitle.command`.
 * Hooks are installed once and cannot read jmux's config, so a tmux option is
 * how they ask. Without this, installing agent hooks would store the human's
 * first prompt whether or not they use titling at all.
 */
export const TITLE_CAPTURE_OPTION = "@jmux-title-capture";

/** {@link TITLE_SIGNATURE_OPTION} value meaning "the human named this one". */
export const MANUAL_SIGNATURE = "manual";

/**
 * What a session is called on screen.
 *
 * One function, because a session shown as a phrase in the sidebar and a slug
 * in the palette is a translation the human should not have to perform. The
 * whole off-state is here: no command configured, no title yet, a call that
 * failed and a model that returned nothing all land on the real name, which is
 * the behaviour that already ships. There is no second rendering path.
 */
export function displaySessionName(session: { name: string; title?: string }): string {
  const trimmed = session.title?.trim();
  return trimmed ? trimmed : session.name;
}

/**
 * Whether jmux should generate a title for this session on its own initiative.
 *
 * **The first title wins.** The three input tiers become available at different
 * moments — git commits exist at boot, the tracker poll resolves an issue a
 * second or two later, the human's first prompt arrives whenever they type —
 * and each is a different signature, so without this rule a session visibly
 * renames itself two or three times in its first minute as stronger inputs turn
 * up. A name that changes while you are reading the sidebar is worse than a
 * name that is merely not the best one available, which is the same judgement
 * behind never re-titling from the accumulating diff.
 *
 * What this gives up is the automatic re-title when a session's issue set grows
 * from one ticket to five. That is a real loss, and the deliberate remedy is the
 * palette's "Re-name session with the model" — which does not come through here.
 */
export function shouldGenerateTitle(session: { title?: string; titleSignature?: string }): boolean {
  if (session.titleSignature === MANUAL_SIGNATURE) return false;
  return (session.title?.trim().length ?? 0) === 0;
}
