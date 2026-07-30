/**
 * Platform-dependent external commands.
 *
 * jmux ships a Linux channel, so a hardcoded `open` or `pbcopy` is not a
 * portability nicety — it is a feature that silently does nothing on half the
 * supported platforms. Both resolutions live here so there is one place to
 * look and one place to test, rather than a `process.platform` check at each
 * call site.
 */

/** Injected in tests; `Bun.which` in production. */
export type WhichFn = (cmd: string) => string | null;

const which: WhichFn = (cmd) => Bun.which(cmd);

/**
 * The browser-opening command for a platform, as argv.
 *
 * macOS has `open`; Linux has `xdg-open` from xdg-utils, which is present on
 * essentially every desktop install and absent on a bare server — where there
 * is no browser to open anyway.
 */
export function openUrlArgv(
  url: string,
  platform: string = process.platform,
  whichFn: WhichFn = which,
): string[] | null {
  if (platform === "darwin") return ["open", url];
  if (platform === "win32") return ["cmd", "/c", "start", "", url];
  return whichFn("xdg-open") ? ["xdg-open", url] : null;
}

/**
 * Open a URL in the user's browser. Returns false when the platform has no
 * usable opener, so callers can say so instead of appearing to work.
 */
export function openUrl(
  url: string,
  platform: string = process.platform,
  whichFn: WhichFn = which,
): boolean {
  const argv = openUrlArgv(url, platform, whichFn);
  if (!argv) return false;
  Bun.spawn(argv, { stdout: "ignore", stderr: "ignore" });
  return true;
}

/**
 * The clipboard-copy command tmux's `C-a y` bind pipes into, as a shell
 * fragment. Exported to the tmux server as `$JMUX_COPY`; empty when nothing
 * suitable exists, which the bind reports rather than swallowing.
 *
 * Wayland is checked before X11 because a Wayland session commonly has xclip
 * installed and non-functional.
 */
export function clipboardCopyCommand(
  platform: string = process.platform,
  whichFn: WhichFn = which,
): string {
  if (platform === "darwin") return "pbcopy";
  if (platform === "win32") return "clip";

  if (whichFn("wl-copy")) return "wl-copy";
  if (whichFn("xclip")) return "xclip -selection clipboard";
  if (whichFn("xsel")) return "xsel --clipboard --input";
  return "";
}
