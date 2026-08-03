// src/cli/browser.ts
//
// `jmux ctl browser` — find browser panes, point them at a URL, and drive them.
//
// The whole reason this exists is isolation. jmux gives each browser pane its
// own `XDG_RUNTIME_DIR` so that two panes don't render the same page (see
// src/browser-pane.ts), and terminal-browser's registry lives inside that
// directory — so `terminal-browser ls` run from an agent's pane finds nothing
// at all. jmux chose those directories and records them on the pane, which
// makes it the only thing that can hand an agent the right one.
//
// `action` deliberately does not model terminal-browser's command surface. It
// resolves which browser to talk to, sets the environment, and passes the rest
// through — so jmux gains whatever agent-browser gains, and cannot be subtly
// wrong about a vocabulary it doesn't own.

import { mkdirSync } from "fs";
import { runTmuxDirect } from "./tmux";
import { CliError, type CliContext } from "./context";
import type { ParsedCtlArgs } from "../cli";
import {
  BROWSER_BINARY,
  BROWSER_PANE_FORMAT,
  BROWSER_PANE_OPTION,
  BROWSER_RUNTIME_OPTION,
  browserRuntimeDir,
  runtimeDirFits,
  browserActionArgv,
  browserActionEnv,
  browserEnv,
  parseBrowserPanes,
  pickBrowserPane,
  type BrowserEnvOptions,
  type BrowserPane,
} from "../browser-pane";
import {
  loadUserConfig,
  DEFAULT_BROWSER_DISPLAY_SCALE,
  DEFAULT_BROWSER_FPS,
} from "../config";

/** Where the caller is, for choosing the nearest browser. */
export interface CallerLocation {
  session?: string;
  windowId?: string;
}

/** Every browser pane on this server. */
export function listBrowserPanes(ctx: CliContext): BrowserPane[] {
  const res = runTmuxDirect(["list-panes", "-a", "-F", BROWSER_PANE_FORMAT], ctx.socket);
  return parseBrowserPanes(res.lines);
}

/** Session and window of the pane `ctl` was invoked from, if it can tell. */
export function callerLocation(ctx: CliContext): CallerLocation {
  if (ctx.sessionOverride) return { session: ctx.sessionOverride };
  if (!ctx.paneId) return {};
  try {
    const res = runTmuxDirect(
      ["display-message", "-p", "-t", ctx.paneId, "-F", "#{session_name}\t#{window_id}"],
      ctx.socket,
    );
    const [session, windowId] = (res.lines[0] ?? "").split("\t");
    return { session: session || undefined, windowId: windowId || undefined };
  } catch {
    return {};
  }
}

/**
 * Resolve which browser pane a command is about.
 *
 * `--pane` names one outright. Otherwise the nearest one wins — same window,
 * then same session, then anywhere.
 */
export function resolveTarget(
  panes: BrowserPane[],
  where: CallerLocation,
  wanted?: string,
): BrowserPane {
  if (wanted) {
    const found = panes.find((p) => p.paneId === wanted);
    if (!found) throw new CliError(`No browser pane ${wanted}. Try: jmux ctl browser list`);
    return found;
  }
  const picked = pickBrowserPane(panes, where);
  if (!picked) {
    throw new CliError(
      "No browser pane is open. Open one with `jmux ctl browser open <url>`, " +
        "or Ctrl-a b in the TUI.",
    );
  }
  return picked;
}

/** Run terminal-browser against a specific pane's browser. */
export async function runBrowserCli(
  pane: BrowserPane,
  args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn([BROWSER_BINARY, ...args], {
    env: { ...process.env, ...browserActionEnv(pane) },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
}

/**
 * The tmux command that opens a browser pane for an agent.
 *
 * Split off the *target* pane rather than a client, because `ctl` has no client
 * — it is a one-shot process, and there may be no attached client at all.
 *
 * The environment comes from `browserEnv`, the same builder the TUI's split
 * uses. Building it here by hand is how the runtime directory came to be the
 * only variable an agent's pane got: it rendered at the display's scale factor,
 * so every page picked a phone layout in a pane wide enough for a desktop one,
 * and uncapped its frame rate — a browser opened by an agent behaved unlike one
 * opened by the human beside it, for no reason either could see.
 */
export function agentSplitCommand(
  target: string,
  url: string | undefined,
  env: BrowserEnvOptions,
): string[] {
  const argv = [BROWSER_BINARY, ...(url ? ["open", url] : [])];
  // An absent variable is what "use the default" says; `XDG_RUNTIME_DIR=` is a
  // different statement that happens to be falsy everywhere reading it today.
  const envArgs = Object.entries(browserEnv(env)).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
  return [
    "split-window", "-h", "-t", target,
    "-P", "-F", "#{pane_id}",
    ...envArgs,
    "-c", "#{pane_current_path}",
    ...argv,
  ];
}

export async function handleBrowser(ctx: CliContext, parsed: ParsedCtlArgs): Promise<unknown> {
  const action = parsed.action ?? "list";
  const panes = listBrowserPanes(ctx);
  const where = callerLocation(ctx);
  const wantedPane = typeof parsed.flags.pane === "string" ? parsed.flags.pane : undefined;

  switch (action) {
    case "list": {
      // One query per pane is not redundancy: isolation gives each browser its
      // own registry, so a single call could only ever see one of them. They do
      // not depend on each other, though, and each is an Electron CLI start —
      // so they run at once rather than in series.
      //
      // The URL comes from each browser rather than from tmux, so a pane whose
      // browser has died reports null instead of a stale address.
      const results = await Promise.all(
        panes.map(async (pane) => {
          const res = await runBrowserCli(pane, ["ls", "--all", "--json"]);
          let tabs: unknown = null;
          if (res.exitCode === 0) {
            try { tabs = JSON.parse(res.stdout); } catch { tabs = null; }
          }
          return { ...pane, alive: res.exitCode === 0, tabs };
        }),
      );
      return { browsers: results };
    }

    case "open": {
      const url = parsed.positional[0];
      // An existing browser is navigated rather than joined by a second one:
      // "open this page" almost never means "and also rearrange my screen".
      if (panes.length > 0 && !parsed.flags.new) {
        const pane = resolveTarget(panes, where, wantedPane);
        if (!url) return { paneId: pane.paneId, url: null, created: false };
        // Navigate through the action path, not `terminal-browser open`. `open`
        // means "give me a browser": it goes to the daemon, asks for a new
        // session and waits for it to register, which is not what "point the
        // browser you already have at this URL" should do — and in a private
        // runtime directory there is no daemon for it to reach, so it simply
        // times out.
        const res = await runBrowserCli(pane, browserActionArgv(pane, ["navigate", url]).slice(1));
        if (res.exitCode !== 0) {
          throw new CliError(res.stderr || `terminal-browser exited ${res.exitCode}`);
        }
        return { paneId: pane.paneId, url, created: false };
      }
      return openNewPane(ctx, url);
    }

    case "action": {
      const command = parsed.positional;
      if (command.length === 0) {
        throw new CliError("Nothing to run. Usage: jmux ctl browser action -- <command>");
      }
      const pane = resolveTarget(panes, where, wantedPane);
      const res = await runBrowserCli(pane, browserActionArgv(pane, command).slice(1));
      if (res.exitCode !== 0) {
        throw new CliError(res.stderr || `terminal-browser exited ${res.exitCode}`);
      }
      let parsedOut: unknown = res.stdout;
      try { parsedOut = JSON.parse(res.stdout); } catch { /* plain text is fine */ }
      return { paneId: pane.paneId, result: parsedOut };
    }

    default:
      throw new CliError(`Unknown browser action: ${action}`);
  }
}

/**
 * Split a new browser pane from the agent's own pane.
 *
 * Agents may create panes, but only beside themselves: `-t` is the caller's
 * pane, so an agent can show you something in its own workspace and cannot
 * rearrange a session it isn't in.
 */
function openNewPane(ctx: CliContext, url?: string): unknown {
  const target = ctx.paneId;
  if (!target) {
    throw new CliError(
      "Can't tell which pane to split — run this from inside a jmux pane, " +
        "or name an existing browser with --pane.",
    );
  }
  if (!Bun.which(BROWSER_BINARY)) {
    throw new CliError(
      `${BROWSER_BINARY} is not installed. ` +
        "Install it with: curl -fsSl https://terminal-browser.sh/install | bash",
    );
  }
  // The user's browser settings, not `ctl`'s own opinion: a pane an agent opens
  // has to behave like one the human opened beside it.
  const cfg = loadUserConfig().browser;
  const runtimeDir = (cfg?.isolate ?? true) ? allocRuntimeDir() : "";
  const res = runTmuxDirect(
    agentSplitCommand(target, url, {
      displayScale: cfg?.displayScale ?? DEFAULT_BROWSER_DISPLAY_SCALE,
      fps: cfg?.fps ?? DEFAULT_BROWSER_FPS,
      runtimeDir: runtimeDir || undefined,
    }),
    ctx.socket,
  );
  const paneId = res.lines[0] ?? "";
  if (paneId.startsWith("%")) {
    // Same two options the TUI sets, so a pane an agent made is findable by
    // exactly the same lookup as one the human made.
    runTmuxDirect(["set-option", "-p", "-t", paneId, BROWSER_PANE_OPTION, "1"], ctx.socket);
    if (runtimeDir) {
      runTmuxDirect(
        ["set-option", "-p", "-t", paneId, BROWSER_RUNTIME_OPTION, runtimeDir],
        ctx.socket,
      );
    }
  }
  return { paneId, url: url ?? null, created: true };
}

/**
 * A runtime directory for a pane this process is creating.
 *
 * Namespaced by `ctl`'s own pid, which is a different tree from the TUI's — the
 * two never hand out the same directory, and neither cleans up the other's.
 */
function allocRuntimeDir(): string {
  // Short, for the reason browserRuntimeBase documents: a socket path over the
  // platform limit fails with a bare EINVAL. `ctl-<pid>` keeps this out of the
  // TUI's tree, so neither cleans up the other's.
  const dir = browserRuntimeDir(`ctl-${process.pid}`);
  if (!runtimeDirFits(dir)) return "";
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch {
    return "";
  }
  return dir;
}
