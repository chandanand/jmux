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

/** Characters a shell will not split or interpret, so they need no quoting. */
const SHELL_SAFE = /^[A-Za-z0-9._\/@:=+-]+$/;

/**
 * Quote an argv element only when the shell would otherwise mangle it.
 *
 * For building a command that a *human reads* in a pane: quoting every token
 * turns `wtm create tra-123 --from main` into `'wtm' 'create' 'tra-123'
 * '--from' 'main'`, which is correct and unreadable. Leaving the safe tokens
 * bare keeps the command legible while still making a name with a space — the
 * case that split `wtm create` into the wrong arguments entirely — one word.
 *
 * An empty string is not safe: bare, it disappears from the argv rather than
 * arriving as an empty argument.
 */
export function shellArg(s: string): string {
  return s.length > 0 && SHELL_SAFE.test(s) ? s : tq(s);
}
