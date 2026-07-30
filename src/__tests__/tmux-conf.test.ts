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
});
