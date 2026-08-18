// src/browser-pane.ts
//
// Opening terminal-browser in a pane.
//
// jmux does the split itself rather than calling `terminal-browser --split`,
// which would have terminal-browser run `tmux split-window` on its own. Both
// end at the same place, but only the first goes through the control connection
// every other jmux-initiated split uses, so window events fire the way they do
// for `Ctrl-a |` and the new pane inherits `#{pane_current_path}` like the
// Claude button's does.
//
// Nothing here draws anything. The picture arrives because the pane's graphics
// reach the real terminal (src/images/passthrough.ts) and its placement rides
// in placeholder cells the compositor already handles. This module only starts
// the process.

import { DEFAULT_BROWSER_PANE_SIZE } from "./config";

/** The binary, as it is invoked and as the install instructions name it. */
export const BROWSER_BINARY = "terminal-browser";

/**
 * Pane options marking a browser pane, and where its browser lives.
 *
 * Two options rather than one, on the same reasoning as the agent-state
 * protocol: each says a single thing, and neither has to be read as a sentinel.
 * `@jmux-browser` is the marker — a pane either is a browser pane or isn't.
 * `@jmux-browser-runtime` is the private `XDG_RUNTIME_DIR` that pane's browser
 * was given, and is *empty* when isolation is off and the browser shares the
 * user's. Consumers that only want to find browser panes read the first;
 * anything that needs to talk to the browser needs the second.
 *
 * These exist because `ctl` has no IPC to the running TUI (see cli/workflow.ts)
 * and isolation makes a browser undiscoverable by any other means: with its own
 * runtime directory it is absent from the registry `terminal-browser ls` reads.
 * jmux is the one that chose the directory, so jmux is the one that can say.
 */
export const BROWSER_PANE_OPTION = "@jmux-browser";
export const BROWSER_RUNTIME_OPTION = "@jmux-browser-runtime";

/** `list-panes -F` spec whose lines `parseBrowserPanes` understands. */
export const BROWSER_PANE_FORMAT = [
  "#{pane_id}",
  "#{session_name}",
  "#{window_id}",
  "#{window_index}",
  `#{${BROWSER_PANE_OPTION}}`,
  `#{${BROWSER_RUNTIME_OPTION}}`,
  "#{pane_title}",
].join("\t");

/**
 * terminal-browser names its own pane `terminal-browser:<key>`, and that key is
 * how its CLI addresses one browser among several (`--browser <key>`).
 *
 * Reading it off the title is worth the slight indirection: the alternative is
 * letting terminal-browser work out which browser is "here" from `TMUX` and
 * `TMUX_PANE`, which are whatever the *caller* inherited. An agent shelling out
 * from one jmux while `ctl` targets another server then resolves confidently to
 * the wrong machine's browser — which is not an error anyone would catch.
 */
const PANE_TITLE_KEY = /terminal-browser:([\w-]+)/;

export interface BrowserPane {
  paneId: string;
  session: string;
  windowId: string;
  windowIndex: number;
  /** The browser's private runtime dir, or null when it shares the user's. */
  runtimeDir: string | null;
  /** terminal-browser's own key for this browser, from the pane title. */
  key: string | null;
}

/**
 * Browser panes, from `list-panes -F BROWSER_PANE_FORMAT` output.
 *
 * Panes that are not browser panes are dropped rather than returned with a
 * flag: every caller wants only browser panes, and a list that needs filtering
 * at each call site is a list that will eventually not be.
 */
export function parseBrowserPanes(lines: string[]): BrowserPane[] {
  const out: BrowserPane[] = [];
  for (const line of lines) {
    const [paneId, session, windowId, windowIndex, marker, runtimeDir, title] = line.split("\t");
    if (marker !== "1" || !paneId) continue;
    out.push({
      paneId,
      session: session ?? "",
      windowId: windowId ?? "",
      windowIndex: Number(windowIndex) || 0,
      runtimeDir: runtimeDir ? runtimeDir : null,
      key: (title ?? "").match(PANE_TITLE_KEY)?.[1] ?? null,
    });
  }
  return out;
}

/**
 * The browser pane a given pane should talk to, or null.
 *
 * Same window first, then same session, then anywhere. A browser two windows
 * away is still better than refusing — but one sitting next to the caller is
 * what they almost certainly meant, and with several open that difference is
 * the whole answer.
 */
export function pickBrowserPane(
  panes: BrowserPane[],
  from: { session?: string; windowId?: string },
): BrowserPane | null {
  if (panes.length === 0) return null;
  return (
    panes.find((p) => from.windowId && p.windowId === from.windowId) ??
    panes.find((p) => from.session && p.session === from.session) ??
    panes[0]
  );
}

/**
 * Argv for driving a browser through terminal-browser's agent CLI.
 *
 * Everything after `--` is agent-browser's own vocabulary — snapshot, click,
 * fill, eval — which jmux deliberately does not model. Wrapping it would mean
 * tracking someone else's command surface forever and being wrong about it in
 * between; passing it through means jmux gains whatever they add.
 */
export function browserActionArgv(pane: BrowserPane, command: string[]): string[] {
  // `--browser` names the instance outright. Without it terminal-browser
  // decides which browser is "here" from the environment it inherited, which
  // belongs to whoever ran `ctl`, not to the pane being addressed.
  const select = pane.key ? ["--browser", pane.key] : [];
  return [BROWSER_BINARY, "action", ...select, "--", ...command];
}

/**
 * Environment for talking to a specific pane's browser.
 *
 * The runtime dir is the whole point: without it the CLI looks in the user's
 * default registry, finds nothing (because isolation put this browser
 * elsewhere) and reports no browser running.
 */
export function browserActionEnv(pane: BrowserPane): Record<string, string> {
  return pane.runtimeDir ? { XDG_RUNTIME_DIR: pane.runtimeDir } : {};
}

/**
 * Longest a unix socket path may be. macOS caps `sun_path` at 104 bytes and
 * Linux at 108; connecting to anything longer fails with EINVAL.
 */
const SUN_PATH_MAX = 104;

/**
 * What terminal-browser appends inside a runtime directory before it has a
 * socket path: `<runtime>/terminal-browser/instances/<key>.sock`, where the key
 * is a pid plus a session suffix.
 */
const SOCKET_SUFFIX_BUDGET = "/terminal-browser/instances/".length + 20;

/**
 * Root for the private runtime directories browser panes get.
 *
 * Short on purpose, and this is the whole reason the function exists. jmux hands
 * a browser a private `XDG_RUNTIME_DIR`; terminal-browser then puts a unix
 * socket underneath it, and a socket path over the platform limit fails with a
 * bare EINVAL that looks nothing like "your directory name is too long". A
 * runtime root under `~/.local/state` is already 26 characters before jmux adds
 * anything, and under a macOS temp dir it is over 50.
 *
 * `/tmp/jmux-<uid>` follows tmux's own convention for exactly this problem
 * (`/tmp/tmux-<uid>`), and `XDG_RUNTIME_DIR` is preferred when the platform
 * sets one because on Linux it is both correct and short (`/run/user/1000`).
 */
export function browserRuntimeBase(
  env: Record<string, string | undefined> = process.env,
  uid = process.getuid?.() ?? 0,
): string {
  return env.XDG_RUNTIME_DIR || `/tmp/jmux-${uid}`;
}

/** A private runtime directory, named so the socket beneath it still fits. */
export function browserRuntimeDir(scope: string, base = browserRuntimeBase()): string {
  return `${base}/browser/${scope}`;
}

/** Would a browser's socket under this directory exceed the platform limit? */
export function runtimeDirFits(dir: string): boolean {
  return dir.length + SOCKET_SUFFIX_BUDGET <= SUN_PATH_MAX;
}

/** What to run when the user has no particular page in mind. */
const DEFAULT_ARGV = [BROWSER_BINARY];

/**
 * Single-quote a value for the shell tmux will hand the pane.
 *
 * A URL is user input arriving from a prompt, and it lands in a string that
 * tmux passes to `/bin/sh`. Anything with a quote, a semicolon or a `$` in it
 * would otherwise be run rather than browsed to — and "paste a URL" is the one
 * gesture this feature is built around.
 */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * The argv for a browser pane, optionally pointed at a URL.
 *
 * `open <url>` targets the *current* pane, which is the one jmux is about to
 * create. Passing `--split` here as well would produce two panes and leave the
 * first one empty.
 */
export function browserArgv(url?: string): string[] {
  const trimmed = url?.trim();
  if (!trimmed) return [...DEFAULT_ARGV];
  return [BROWSER_BINARY, "open", shellQuote(trimmed)];
}

/** Bounds terminal-browser documents for its own `--size`, mirrored here. */
const MIN_PANE_SIZE = 0.2;
const MAX_PANE_SIZE = 0.95;

/**
 * Clamp a configured pane fraction into the range that produces a usable pane.
 *
 * Out-of-range is clamped rather than refused: this arrives from a hand-edited
 * config, and the cost of a silly number is a badly proportioned split, not
 * anything jmux needs to stop and explain.
 *
 * Unset, or not a number at all, is a different case and gets `fallback`.
 * Clamping those would answer a typo — a quoted `"0.62"`, a missing key — with
 * the *smallest pane the range allows*, which looks far more like a deliberate
 * setting than like the mistake it is. `undefined` is in the signature rather
 * than smuggled in as NaN by callers, because "no size given" is a real state
 * this has to answer for and a sentinel only hides that.
 */
export function clampPaneSize(
  size: number | undefined,
  fallback = DEFAULT_BROWSER_PANE_SIZE,
): number {
  if (size === undefined || !Number.isFinite(size)) return fallback;
  return Math.min(MAX_PANE_SIZE, Math.max(MIN_PANE_SIZE, size));
}

export interface BrowserEnvOptions {
  /** Device pixel ratio to render at, or "auto" for terminal-browser's own. */
  displayScale?: number | "auto";
  /** Frames per second to render at, or "auto" for terminal-browser's own. */
  fps?: number | "auto";
  /**
   * A private runtime directory for this pane, or undefined to share the
   * user's. Set, it is what stops every browser pane rendering the same page.
   */
  runtimeDir?: string;
}

/**
 * Environment overrides for a browser pane.
 *
 * `TERMINAL_BROWSER_DISPLAY_SCALE` is the device pixel ratio the page is laid
 * out at. terminal-browser defaults to the display's scale factor, which on a
 * Mac halves the CSS viewport — a 66-column pane reports 528px and every site
 * that has a phone layout picks it. Passing 1 keeps the picture identical (the
 * canvas is the same number of device pixels either way) and lays the page out
 * for the width it is actually shown at.
 *
 * `TERMINAL_BROWSER_FPS` caps the frame rate. Left alone terminal-browser uses
 * the fastest refresh rate among *all* attached displays, so one ProMotion
 * laptop panel puts a pane on a 60Hz external monitor at 120fps. Every one of
 * those frames is a full-canvas image the terminal has to decode and blit, and
 * it does not stop when the page is static — so the cost is paid continuously,
 * for frames that are either invisible or identical to the last.
 *
 * `"auto"` on either hands the decision back rather than encoding jmux's
 * opinion as the only possibility.
 */
export function browserEnv(opts: BrowserEnvOptions = {}): Record<string, string> {
  const env: Record<string, string> = {};
  const scale = opts.displayScale ?? "auto";
  if (scale !== "auto" && Number.isFinite(scale) && scale > 0) {
    env.TERMINAL_BROWSER_DISPLAY_SCALE = String(scale);
  }
  const fps = opts.fps ?? "auto";
  if (fps !== "auto" && Number.isFinite(fps) && fps > 0) {
    env.TERMINAL_BROWSER_FPS = String(Math.round(fps));
  }
  // The daemon socket terminal-browser attaches to lives here. A pane with its
  // own runtime directory finds no daemon, starts its own browser, and so gets
  // its own process id — which is the only thing distinguishing one pane's
  // kitty image from another's.
  if (opts.runtimeDir) env.XDG_RUNTIME_DIR = opts.runtimeDir;
  return env;
}

export interface BrowserSplitOptions extends BrowserEnvOptions {
  url?: string;
  /** Fraction of the current pane the browser takes. */
  size?: number;
  /**
   * Ask tmux to print the new pane's id. Built here rather than appended by the
   * caller because tmux takes flags before the command and everything after it
   * as the command's own argv — appending `-P` hands it to the browser, which
   * refuses to start and takes the whole feature with it.
   */
  printPaneId?: boolean;
}

/**
 * The tmux command that opens a browser pane beside the client's current one.
 *
 * `-h` is tmux's sense of horizontal — panes side by side — which is what a web
 * page wants: it is the axis with columns to spare, and a browser squeezed into
 * half the rows of a terminal is unreadable in a way half the columns is not.
 *
 * The size goes to tmux's `-l`, not terminal-browser's `--size`, because jmux
 * owns the split — passing both would size the pane twice from two different
 * places, and only one of them fires.
 */
/**
 * `target` is anything tmux's `-t` accepts: the pty client's name outside the
 * Command Center, a pane id inside it (the focused tile's).
 */
export function browserSplitCommand(target: string, opts: BrowserSplitOptions = {}): string {
  const argv = browserArgv(opts.url).join(" ");
  // One answer to "no usable size", not two. This used to default to an even
  // split here while clampPaneSize defaulted to something else, so omitting the
  // size and passing a garbage one landed on different panes.
  const pct = Math.round(clampPaneSize(opts.size) * 100);
  const env = browserEnv(opts);
  // `-e` sets the new pane's environment; tmux 3.2+ (jmux's floor) accepts it.
  // Values are quoted because one of them is a path: unquoted, a directory with
  // a space in it would split into two arguments and tmux would reject the lot.
  const envArgs = Object.entries(env).map(([k, v]) => `-e ${k}=${shellQuote(v)}`).join(" ");
  return [
    `split-window -t ${target} -h -l ${pct}%`,
    opts.printPaneId ? `-P -F '#{pane_id}'` : "",
    envArgs,
    `-c '#{pane_current_path}'`,
    argv,
  ].filter(Boolean).join(" ");
}
