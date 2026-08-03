import { describe, test, expect } from "bun:test";
import { browserArgv, browserSplitCommand, browserEnv, clampPaneSize, shellQuote, BROWSER_BINARY, browserRuntimeBase, browserRuntimeDir, runtimeDirFits, parseBrowserPanes, pickBrowserPane, browserActionArgv } from "../browser-pane";
import { DEFAULT_BROWSER_PANE_SIZE } from "../config";

describe("browserArgv", () => {
  test("launches the browser with no url", () => {
    expect(browserArgv()).toEqual([BROWSER_BINARY]);
  });

  test("treats blank and whitespace-only input as no url", () => {
    expect(browserArgv("")).toEqual([BROWSER_BINARY]);
    expect(browserArgv("   ")).toEqual([BROWSER_BINARY]);
  });

  test("opens a url in the pane jmux is about to create", () => {
    // `open` targets the current pane. Adding --split here would make a second
    // pane and leave the one jmux just split empty.
    expect(browserArgv("example.com")).toEqual([BROWSER_BINARY, "open", "'example.com'"]);
    expect(browserArgv("example.com")).not.toContain("--split");
  });

  test("trims surrounding whitespace off the url", () => {
    expect(browserArgv("  example.com  ")).toEqual([BROWSER_BINARY, "open", "'example.com'"]);
  });
});

describe("shellQuote", () => {
  // The URL comes from a prompt and ends up in a string tmux hands to /bin/sh.
  test("neutralises shell metacharacters", () => {
    expect(shellQuote("a;rm -rf /")).toBe("'a;rm -rf /'");
    expect(shellQuote("$(whoami)")).toBe("'$(whoami)'");
    expect(shellQuote("a`id`b")).toBe("'a`id`b'");
  });

  test("escapes embedded single quotes rather than closing the string", () => {
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
  });

  test("leaves a real url intact inside the quotes", () => {
    const url = "https://example.com/a?b=1&c=2#frag";
    expect(shellQuote(url)).toBe(`'${url}'`);
  });
});

describe("clampPaneSize", () => {
  test("keeps a sensible fraction as-is", () => {
    expect(clampPaneSize(0.62)).toBe(0.62);
  });

  test("clamps rather than refusing an out-of-range config value", () => {
    // Hand-edited config: the cost of a silly number is a badly proportioned
    // split, not something worth stopping to explain.
    expect(clampPaneSize(0.05)).toBe(0.2);
    expect(clampPaneSize(2)).toBe(0.95);
  });

  test("falls back to the default when the value is not a number at all", () => {
    // Clamping a typo — a quoted "0.62", a missing key — would answer it with
    // the smallest pane the range allows, which reads as a deliberate setting
    // rather than the mistake it is.
    expect(clampPaneSize(NaN)).toBe(DEFAULT_BROWSER_PANE_SIZE);
    expect(clampPaneSize(Number("nonsense"))).toBe(DEFAULT_BROWSER_PANE_SIZE);
    expect(clampPaneSize(Infinity)).toBe(DEFAULT_BROWSER_PANE_SIZE);
    expect(clampPaneSize(undefined)).toBe(DEFAULT_BROWSER_PANE_SIZE);
    expect(clampPaneSize(NaN, 0.4)).toBe(0.4);
  });

  test("its default is the one callers pass, not a second copy of it", () => {
    expect(clampPaneSize(NaN)).toBe(DEFAULT_BROWSER_PANE_SIZE);
  });
});

describe("browserEnv", () => {
  test("pins the device pixel ratio so sites get a desktop layout", () => {
    // terminal-browser otherwise uses the display scale factor — 2 on a Mac —
    // which halves the CSS viewport and picks a phone layout in a wide pane.
    expect(browserEnv({ displayScale: 1 })).toEqual({ TERMINAL_BROWSER_DISPLAY_SCALE: "1" });
  });

  test("caps the frame rate", () => {
    // Left alone terminal-browser uses the fastest refresh among *all*
    // displays, so one ProMotion panel drives a pane on a 60Hz monitor at
    // 120fps — full-canvas blits that continue on a completely static page.
    expect(browserEnv({ fps: 60 })).toEqual({ TERMINAL_BROWSER_FPS: "60" });
    expect(browserEnv({ fps: 30.4 })).toEqual({ TERMINAL_BROWSER_FPS: "30" });
  });

  test("'auto' hands each decision back to terminal-browser", () => {
    expect(browserEnv({ displayScale: "auto", fps: "auto" })).toEqual({});
    expect(browserEnv({})).toEqual({});
  });

  test("the two knobs are independent", () => {
    expect(browserEnv({ displayScale: 1, fps: "auto" })).toEqual({
      TERMINAL_BROWSER_DISPLAY_SCALE: "1",
    });
    expect(browserEnv({ displayScale: "auto", fps: 30 })).toEqual({
      TERMINAL_BROWSER_FPS: "30",
    });
  });

  test("a nonsensical value is treated as auto rather than passed on", () => {
    expect(browserEnv({ displayScale: 0, fps: 0 })).toEqual({});
    expect(browserEnv({ displayScale: -1, fps: -1 })).toEqual({});
    expect(browserEnv({ displayScale: NaN, fps: NaN })).toEqual({});
  });
});

describe("browserSplitCommand", () => {
  test("splits side by side, inheriting the current path", () => {
    const cmd = browserSplitCommand("%3", { displayScale: "auto", fps: "auto" });
    expect(cmd).toBe(`split-window -t %3 -h -l 62% -c '#{pane_current_path}' ${BROWSER_BINARY}`);
  });

  test("sizes the pane from the given fraction", () => {
    const cmd = browserSplitCommand("%3", { size: 0.62, displayScale: "auto", fps: "auto" });
    expect(cmd).toContain("-l 62%");
  });

  test("sizes through tmux, never terminal-browser's own --size", () => {
    // jmux owns the split. Passing both would size the pane from two places
    // and only one of them fires.
    const cmd = browserSplitCommand("%3", { size: 0.62 });
    expect(cmd).not.toContain("--size");
  });

  test("passes the display scale as pane environment", () => {
    const cmd = browserSplitCommand("%3", { displayScale: 1 });
    expect(cmd).toContain("-e TERMINAL_BROWSER_DISPLAY_SCALE='1'");
  });

  test("gives the pane its own runtime dir, quoted", () => {
    // This is what stops every browser pane rendering the same page: no daemon
    // socket to attach to means a browser of its own, and so an image id of
    // its own.
    const cmd = browserSplitCommand("%3", { runtimeDir: "/run/jmux/browser/9/1" });
    expect(cmd).toContain("-e XDG_RUNTIME_DIR='/run/jmux/browser/9/1'");
  });

  test("survives a runtime dir with a space in it", () => {
    // Unquoted this splits into two arguments and tmux rejects the command —
    // and "/Users/Some One/..." is an ordinary macOS home.
    const cmd = browserSplitCommand("%3", { runtimeDir: "/Users/Some One/.local/state/x" });
    expect(cmd).toContain("-e XDG_RUNTIME_DIR='/Users/Some One/.local/state/x'");
  });

  test("shares the runtime dir when isolation is off", () => {
    expect(browserSplitCommand("%3", { displayScale: "auto", fps: "auto" }))
      .not.toContain("XDG_RUNTIME_DIR");
  });

  test("omits the environment flag entirely on auto", () => {
    expect(browserSplitCommand("%3", { displayScale: "auto", fps: "auto" })).not.toContain("-e ");
  });

  test("carries a quoted url through to the pane", () => {
    const cmd = browserSplitCommand("%3", { url: "localhost:3000", displayScale: "auto", fps: "auto" });
    expect(cmd).toBe(
      `split-window -t %3 -h -l 62% -c '#{pane_current_path}' ${BROWSER_BINARY} open 'localhost:3000'`,
    );
  });

  // Asserting on the quoted *spelling* proves nothing — the dangerous text is
  // still in there either way, inert or not. What matters is how a shell splits
  // it, so ask one. This is the same /bin/sh tmux hands the pane command to.
  describe("as a real shell parses it", () => {
    /** The words `sh` would pass to the pane, for the argv part of `cmd`. */
    function shellWords(cmd: string): string[] {
      const argv = cmd.split("'#{pane_current_path}' ")[1];
      const out = Bun.spawnSync(["sh", "-c", `printf '%s\\n' ${argv}`]);
      expect(out.exitCode).toBe(0);
      return new TextDecoder().decode(out.stdout).split("\n").slice(0, -1);
    }

    test("a plain url arrives as one argument", () => {
      expect(shellWords(browserSplitCommand("%3", { url: "https://example.com/a?b=1&c=2" }))).toEqual([
        BROWSER_BINARY,
        "open",
        "https://example.com/a?b=1&c=2",
      ]);
    });

    test("a url built to break out stays a single inert argument", () => {
      const hostile = "x'; touch /tmp/jmux-pwned; '";
      expect(shellWords(browserSplitCommand("%3", { url: hostile }))).toEqual([
        BROWSER_BINARY,
        "open",
        hostile,
      ]);
    });

    test("command substitution is not substituted", () => {
      expect(shellWords(browserSplitCommand("%3", { url: "$(id)`id`" }))).toEqual([
        BROWSER_BINARY,
        "open",
        "$(id)`id`",
      ]);
    });
  });
});

describe("printPaneId", () => {
  // tmux takes flags before the command and everything after it as the
  // command's argv. Appending `-P` hands it to terminal-browser, which refuses
  // to start — the pane never opens at all.
  test("puts -P before the command, not after it", () => {
    const cmd = browserSplitCommand("%3", { printPaneId: true });
    expect(cmd.indexOf("-P -F")).toBeLessThan(cmd.indexOf(BROWSER_BINARY));
  });

  test("is absent unless asked for", () => {
    expect(browserSplitCommand("%3")).not.toContain("-P");
  });
});

describe("runtime directories", () => {
  // A private runtime dir is only useful if terminal-browser can put a socket
  // under it. macOS caps sun_path at 104 bytes and the failure is a bare
  // EINVAL — nothing in it suggests the directory name is the problem.
  test("prefers XDG_RUNTIME_DIR when the platform sets one", () => {
    expect(browserRuntimeBase({ XDG_RUNTIME_DIR: "/run/user/1000" }, 1000)).toBe("/run/user/1000");
  });

  test("falls back to tmux's own convention, not a deep home path", () => {
    // ~/.local/state is 26 characters before jmux adds anything, and a macOS
    // temp dir is over 50 — both blow the budget once a socket goes under them.
    expect(browserRuntimeBase({}, 501)).toBe("/tmp/jmux-501");
    expect(browserRuntimeBase({ XDG_STATE_HOME: "/Users/someone/.local/state" }, 501))
      .toBe("/tmp/jmux-501");
  });

  test("a realistic directory leaves room for the socket", () => {
    expect(runtimeDirFits(browserRuntimeDir("99999/12", browserRuntimeBase({}, 501)))).toBe(true);
    expect(runtimeDirFits(browserRuntimeDir("ctl-99999", browserRuntimeBase({}, 501)))).toBe(true);
    expect(runtimeDirFits(browserRuntimeDir("1/1", "/run/user/1000"))).toBe(true);
  });

  test("rejects a directory whose socket would not fit", () => {
    const deep = `/var/folders/cb/7pwp6ljx721dqtn9yh26_k_h0000gn/T/jmux-browser-XXXXXX/run`;
    expect(runtimeDirFits(browserRuntimeDir("1/1", deep))).toBe(false);
  });
});
