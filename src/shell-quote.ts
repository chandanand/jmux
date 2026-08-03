/**
 * Escape a string for safe interpolation inside a single-quoted shell/tmux
 * argument. Replaces each ' with the sequence '\'' (end quote, escaped literal
 * quote, reopen quote) — the standard POSIX single-quote escape.
 *
 * Usage: control.sendCommand(`rename-session -t ${tq(id)} ${tq(name)}`)
 * The function wraps the value in single quotes, so callers must NOT add their own.
 *
 * It lives in its own module because both the TUI (which sends command *lines*
 * over the control channel) and the CLI (which passes argv straight to tmux)
 * quote the same shell fragments, and `issue-provision.ts` builds those
 * fragments for both. Nesting is safe and intended: a fragment that already
 * contains `tq(path)` can itself be `tq`'d for the control channel, because
 * tmux unquotes exactly once before handing the result to `sh -c`.
 */
export function tq(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}
