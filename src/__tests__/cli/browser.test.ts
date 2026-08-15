import { describe, test, expect } from "bun:test";
import { resolveTarget, agentSplitCommand } from "../../cli/browser";
import {
  parseBrowserPanes,
  pickBrowserPane,
  browserActionArgv,
  browserActionEnv,
  BROWSER_PANE_FORMAT,
  BROWSER_BINARY,
  type BrowserPane,
} from "../../browser-pane";
import { CliError } from "../../cli/context";

/** A `list-panes -F BROWSER_PANE_FORMAT` line. */
function line(
  paneId: string,
  session: string,
  windowId: string,
  index: number,
  marker: string,
  runtime: string,
  title = "",
): string {
  return [paneId, session, windowId, String(index), marker, runtime, title].join("\t");
}

const pane = (over: Partial<BrowserPane> = {}): BrowserPane => ({
  paneId: "%1", session: "s", windowId: "@1", windowIndex: 0,
  runtimeDir: "/tmp/jmux-501/browser/1/1", key: "123-1", ...over,
});

describe("BROWSER_PANE_FORMAT", () => {
  test("asks for the fields parseBrowserPanes reads, in order", () => {
    // A format and a parser that drift produce panes with the right shape and
    // the wrong values, which nothing downstream can detect.
    expect(BROWSER_PANE_FORMAT.split("\t")).toEqual([
      "#{pane_id}", "#{session_name}", "#{window_id}", "#{window_index}",
      "#{@jmux-browser}", "#{@jmux-browser-runtime}", "#{pane_title}",
    ]);
  });
});

describe("parseBrowserPanes", () => {
  test("keeps only panes marked as browsers", () => {
    const panes = parseBrowserPanes([
      line("%0", "s", "@1", 0, "", ""),
      line("%1", "s", "@1", 0, "1", "/tmp/jmux-501/browser/9/1", "terminal-browser:900-1"),
      line("%2", "s", "@1", 0, "", ""),
    ]);
    expect(panes.map((p) => p.paneId)).toEqual(["%1"]);
  });

  test("reads the runtime dir, and reports a shared one as null", () => {
    const [priv] = parseBrowserPanes([line("%1", "s", "@1", 0, "1", "/tmp/jmux-501/browser/9/1")]);
    expect(priv.runtimeDir).toBe("/tmp/jmux-501/browser/9/1");
    const [shared] = parseBrowserPanes([line("%2", "s", "@1", 0, "1", "")]);
    expect(shared.runtimeDir).toBeNull();
  });

  test("lifts terminal-browser's key out of the pane title", () => {
    // The key is how a browser is addressed among several; without it the CLI
    // falls back to inferring "here" from the caller's environment.
    const [p] = parseBrowserPanes([line("%1", "s", "@1", 0, "1", "/x", "terminal-browser:4207-2")]);
    expect(p.key).toBe("4207-2");
  });

  test("survives a pane whose title says nothing useful", () => {
    const [p] = parseBrowserPanes([line("%1", "s", "@1", 0, "1", "/x", "zsh")]);
    expect(p.key).toBeNull();
  });
});

describe("pickBrowserPane", () => {
  const here = pane({ paneId: "%same", session: "a", windowId: "@1" });
  const sameSession = pane({ paneId: "%sess", session: "a", windowId: "@2" });
  const elsewhere = pane({ paneId: "%far", session: "b", windowId: "@9" });

  test("prefers the browser in the caller's own window", () => {
    expect(pickBrowserPane([elsewhere, sameSession, here], { session: "a", windowId: "@1" })?.paneId)
      .toBe("%same");
  });

  test("falls back to the caller's session", () => {
    expect(pickBrowserPane([elsewhere, sameSession], { session: "a", windowId: "@1" })?.paneId)
      .toBe("%sess");
  });

  test("takes any browser rather than refusing", () => {
    expect(pickBrowserPane([elsewhere], { session: "a", windowId: "@1" })?.paneId).toBe("%far");
  });

  test("is null only when there are none", () => {
    expect(pickBrowserPane([], { session: "a" })).toBeNull();
  });
});

describe("resolveTarget", () => {
  test("--pane names one outright", () => {
    const panes = [pane({ paneId: "%1" }), pane({ paneId: "%2" })];
    expect(resolveTarget(panes, {}, "%2").paneId).toBe("%2");
  });

  test("explains itself when --pane names nothing", () => {
    expect(() => resolveTarget([pane({ paneId: "%1" })], {}, "%9")).toThrow(CliError);
    expect(() => resolveTarget([pane({ paneId: "%1" })], {}, "%9")).toThrow(/browser list/);
  });

  test("tells the caller how to get a browser when there is none", () => {
    // An agent hitting this needs to know both routes out of it.
    expect(() => resolveTarget([], {})).toThrow(/browser open|Ctrl-Space b/);
  });
});

describe("browserActionArgv", () => {
  test("addresses the browser by key rather than by guessing", () => {
    expect(browserActionArgv(pane({ key: "42-1" }), ["snapshot"])).toEqual([
      BROWSER_BINARY, "action", "--browser", "42-1", "--", "snapshot",
    ]);
  });

  test("omits the selector when the key is unknown", () => {
    expect(browserActionArgv(pane({ key: null }), ["snapshot"])).toEqual([
      BROWSER_BINARY, "action", "--", "snapshot",
    ]);
  });

  test("passes the command through verbatim", () => {
    // jmux does not model agent-browser's vocabulary; wrapping it would mean
    // being subtly wrong about someone else's surface forever.
    const argv = browserActionArgv(pane(), ["click", "--ref", "e2"]);
    expect(argv.slice(argv.indexOf("--") + 1)).toEqual(["click", "--ref", "e2"]);
  });
});

describe("browserActionEnv", () => {
  test("points the CLI at the pane's own registry", () => {
    // Without this the CLI reads the user's default registry, finds nothing
    // (isolation put this browser elsewhere) and reports no browser running.
    expect(browserActionEnv(pane({ runtimeDir: "/tmp/jmux-501/browser/9/1" })))
      .toEqual({ XDG_RUNTIME_DIR: "/tmp/jmux-501/browser/9/1" });
  });

  test("sets nothing when the browser shares the user's", () => {
    expect(browserActionEnv(pane({ runtimeDir: null }))).toEqual({});
  });
});

describe("agentSplitCommand", () => {
  const RT = "/tmp/jmux-501/browser/ctl-9";

  test("splits off the caller's own pane", () => {
    // Agents may create panes, but beside themselves — `-t` is the caller, so
    // an agent cannot rearrange a session it is not in.
    const cmd = agentSplitCommand("%7", "https://example.com", { runtimeDir: RT });
    expect(cmd[cmd.indexOf("-t") + 1]).toBe("%7");
  });

  test("carries the runtime dir and asks for the new pane id", () => {
    const cmd = agentSplitCommand("%7", undefined, { runtimeDir: RT });
    expect(cmd).toContain("-P");
    expect(cmd.join(" ")).toContain(`-e XDG_RUNTIME_DIR=${RT}`);
  });

  test("carries the presentation settings the TUI's split carries", () => {
    // Built by hand, this command set only the runtime directory — so a browser
    // an agent opened laid out at the display's scale factor (a phone layout in
    // a desktop-width pane) and rendered uncapped, while one the human opened
    // beside it did neither.
    const flat = agentSplitCommand("%7", undefined, { runtimeDir: RT, displayScale: 1, fps: 60 })
      .join(" ");
    expect(flat).toContain("-e TERMINAL_BROWSER_DISPLAY_SCALE=1");
    expect(flat).toContain("-e TERMINAL_BROWSER_FPS=60");
  });

  test("hands the decision back on \"auto\"", () => {
    const flat = agentSplitCommand("%7", undefined, { runtimeDir: RT, displayScale: "auto", fps: "auto" })
      .join(" ");
    expect(flat).not.toContain("TERMINAL_BROWSER_DISPLAY_SCALE");
    expect(flat).not.toContain("TERMINAL_BROWSER_FPS");
  });

  test("puts the flags before the command", () => {
    // tmux reads everything after the command as its argv; a flag that lands
    // there is handed to terminal-browser, which refuses to start.
    const cmd = agentSplitCommand("%7", "https://example.com", { runtimeDir: "/tmp/x", fps: 30 });
    expect(cmd.indexOf("-P")).toBeLessThan(cmd.indexOf(BROWSER_BINARY));
    expect(cmd.indexOf("-e")).toBeLessThan(cmd.indexOf(BROWSER_BINARY));
  });
});

describe("agentSplitCommand without a runtime dir", () => {
  test("omits -e rather than setting the variable to empty", () => {
    // No directory means "share the user's", which is what an absent variable
    // says. An empty assignment is a different statement that happens to be
    // falsy everywhere reading it today.
    const cmd = agentSplitCommand("%7", undefined, {});
    expect(cmd).not.toContain("-e");
    expect(cmd.join(" ")).not.toContain("XDG_RUNTIME_DIR");
  });
});
