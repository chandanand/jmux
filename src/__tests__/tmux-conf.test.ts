import { describe, expect, test } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

// The .conf files are the one part of jmux tmux executes directly, so nothing
// in the type system or the render pipeline can catch a reference to a file
// that does not exist. Three binds pointed at shell scripts for months after
// those scripts were deleted; on every install, pressing the key produced a
// tmux error instead of the feature the docs promised.

const CONFIG_DIR = resolve(import.meta.dir, "..", "..", "config");
const CONF_FILES = ["tmux.conf", "defaults.conf", "core.conf"] as const;

/** `$JMUX_DIR/config/foo.sh` and friends — the only path form the confs use. */
const JMUX_DIR_REF = /\$JMUX_DIR\/(\S+?)(?=["'\s]|$)/g;

/**
 * Executable lines only. Comments routinely name a command precisely because
 * it is *not* being used any more, and a lint that forbade explaining itself
 * would be worse than no lint.
 */
function confText(name: string): string {
  return readFileSync(resolve(CONFIG_DIR, name), "utf-8")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");
}

describe("tmux config files", () => {
  for (const name of CONF_FILES) {
    test(`${name} references only files that exist`, () => {
      const text = confText(name);
      const missing: string[] = [];

      for (const match of text.matchAll(JMUX_DIR_REF)) {
        const rel = match[1];
        // $JMUX_DIR is the repo root when running from source.
        const path = resolve(CONFIG_DIR, "..", rel);
        if (!existsSync(path)) missing.push(rel);
      }

      expect(missing).toEqual([]);
    });
  }

  // Linux is a shipping target. A bind that shells out to a macOS-only binary
  // fails silently there — the keypress does nothing and says nothing.
  const MAC_ONLY = ["pbcopy", "pbpaste", "open "];

  for (const name of CONF_FILES) {
    test(`${name} hardcodes no macOS-only binary`, () => {
      const text = confText(name);
      const found = MAC_ONLY.filter((bin) => text.includes(bin));
      expect(found).toEqual([]);
    });
  }

  describe("pane border titles stay off", () => {
    // jmux already names the window in its toolbar and the session in its
    // sidebar. A per-pane title row is a third label, and it costs a line of
    // every pane's height plus a rule across the top of the window — permanent
    // chrome to name commands you can watch running.
    //
    // This was briefly automatic: a window-layout-changed hook switched titles
    // on the moment a window held more than one pane. Splitting a pane then
    // silently changed the shape of the window, which is why it is asserted
    // rather than left to whoever edits the conf next.
    test("defaults.conf sets pane-border-status off and nothing turns it back on", () => {
      const text = confText("defaults.conf");
      expect(text).toContain("set -g pane-border-status off");
      expect(text).not.toMatch(/pane-border-status\s+(top|bottom)/);
    });

    test("no conf hooks pane-border-status to the layout", () => {
      for (const name of CONF_FILES) {
        const text = confText(name);
        expect(text).not.toContain("window-layout-changed");
      }
    });
  });

  // Sourcing the user's tmux config is opt-out (`userTmuxConfig` in
  // config.json), and the entire mechanism is one line of tmux.conf: jmux
  // resolves the path in TypeScript — where the XDG fallback and the `false`
  // case are testable — and exports it as $JMUX_USER_CONF, empty meaning
  // "source nothing". An edit that reinstated an unconditional `source-file
  // ~/.tmux.conf` would silently restore the old behaviour for every user who
  // had turned it off, and nothing in the type system can see a .conf file.
  describe("the user's tmux config is gated", () => {
    test("tmux.conf reaches it only through $JMUX_USER_CONF", () => {
      const text = confText("tmux.conf");
      expect(text).toContain("$JMUX_USER_CONF");
      expect(text).not.toMatch(/source-file\s+(?:-\S+\s+)*["']?~\/\.tmux\.conf/);
    });

    // `if-shell` without -b stops the command queue until its shell exits
    // (man tmux), so step 2 cannot outlive step 3. If the gate ever moves to a
    // backgrounded form, the user's config would land *after* core.conf and
    // win on the six settings jmux is not willing to negotiate.
    test("core.conf is still sourced last", () => {
      const text = confText("tmux.conf");
      expect(text).not.toMatch(/if-shell\s+-\S*b/);
      expect(text.indexOf("core.conf")).toBeGreaterThan(text.indexOf("JMUX_USER_CONF"));
    });
  });

  // core.conf is sourced last and overrides ~/.tmux.conf, so anything in it is
  // a setting the user is not allowed to have an opinion about. That is only
  // defensible for things jmux genuinely cannot run without — it held an
  // `unbind P` and a hook-unset that existed solely to protect the border
  // automation above, and which silently destroyed those bindings for any user
  // who had bound them deliberately.
  test("core.conf overrides only what jmux requires", () => {
    const settings = confText("core.conf")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    const allowed = [
      "detach-on-destroy", // jmux switches sessions rather than detaching
      "mouse", //            sidebar and toolbar click handling
      "allow-rename", //     jmux owns window names
      "automatic-rename",
      "automatic-rename-format",
      "status", //           jmux draws its own toolbar in that row
    ];
    const unexpected = settings.filter((line) => !allowed.some((s) => line.includes(s)));
    expect(unexpected).toEqual([]);
  });
});
