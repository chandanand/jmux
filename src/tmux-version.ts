/**
 * The tmux version floor.
 *
 * jmux depends on tmux 3.2+ for pane border titles, `-A` on new-session, and
 * the control-mode behaviour the whole architecture rests on.
 *
 * This constant is duplicated in `site/install.sh` — deliberately, because the
 * installer must fail before a user is holding a binary that cannot start, and
 * it cannot import TypeScript. `tmux-conf.test.ts` asserts the two agree, so
 * they cannot drift silently.
 */
export const MIN_TMUX_MAJOR = 3;
export const MIN_TMUX_MINOR = 2;
export const MIN_TMUX_VERSION = `${MIN_TMUX_MAJOR}.${MIN_TMUX_MINOR}`;

/**
 * Parse `tmux -V` output.
 *
 * tmux appends a letter to patch releases (`tmux 3.1a`), and versions like
 * `3.4-rc1` show up in distro builds — both must reduce to a comparable
 * major/minor rather than throwing.
 */
export function parseTmuxVersion(output: string): { major: number; minor: number } | null {
  const match = output.match(/(\d+)\.(\d+)/);
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]) };
}

/** Whether a `tmux -V` string satisfies the floor. Unparseable is not fatal. */
export function tmuxVersionOk(output: string): boolean {
  const parsed = parseTmuxVersion(output);
  // An unrecognisable version string is more likely a tmux fork or a future
  // format than an old build. Refusing to start on it would be worse than
  // letting it try.
  if (!parsed) return true;
  if (parsed.major > MIN_TMUX_MAJOR) return true;
  return parsed.major === MIN_TMUX_MAJOR && parsed.minor >= MIN_TMUX_MINOR;
}
