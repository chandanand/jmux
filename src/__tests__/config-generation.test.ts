import { describe, expect, test } from "bun:test";
import {
  compareGeneration,
  confTag,
  GENERATION_OPTION,
  hashOf,
  stampCommand,
  staleGenerationNotice,
} from "../config-generation";

const DIR = "/home/u/.local/share/jmux/assets/96cac232fb21da7c";
const ASSETS = "96cac232fb21da7c";
const DOT = "/home/u/.tmux.conf";
const DOT_TAG = "20d213e9";
const XDG = "/home/u/.config/tmux/tmux.conf";

describe("hashOf", () => {
  test("is the last path segment of a materialized dir", () => {
    expect(hashOf(DIR)).toBe(ASSETS);
  });
});

describe("confTag", () => {
  // Hashed rather than stored literally so the option value has a fixed shape
  // and carries neither spaces nor the user's home directory.
  test("is a short stable hash of the resolved path", () => {
    expect(confTag(DOT)).toBe(DOT_TAG);
    expect(confTag(DOT)).toBe(confTag(DOT));
  });

  test("distinguishes the two auto-detect locations", () => {
    expect(confTag(XDG)).not.toBe(confTag(DOT));
  });

  test("sourcing nothing is a value, not an absence", () => {
    expect(confTag("")).toBe("none");
  });
});

describe("stampCommand", () => {
  test("records the asset hash and the tmux config in force", () => {
    expect(stampCommand(DIR, DOT)).toBe(
      `set-option -g ${GENERATION_OPTION} ${ASSETS}.${DOT_TAG}`,
    );
  });

  test("records 'none' when jmux sourced no user config", () => {
    expect(stampCommand(DIR, "")).toBe(`set-option -g ${GENERATION_OPTION} ${ASSETS}.none`);
  });
});

describe("compareGeneration", () => {
  test("matching stamp is current", () => {
    expect(compareGeneration(`${ASSETS}.${DOT_TAG}`, DIR, DOT)).toEqual({ kind: "current" });
  });

  test("tolerates surrounding whitespace from tmux output", () => {
    expect(compareGeneration(` ${ASSETS}.${DOT_TAG}\n`, DIR, DOT)).toEqual({ kind: "current" });
  });

  // The upgrade case this exists for: jmux was upgraded, the server was not
  // restarted, and every new binding silently does nothing.
  test("a different asset hash is stale on the assets", () => {
    expect(compareGeneration(`0000aaaa1111bbbb.${DOT_TAG}`, DIR, DOT)).toEqual({
      kind: "stale",
      cause: "assets",
      running: `0000aaaa1111bbbb.${DOT_TAG}`,
      expected: `${ASSETS}.${DOT_TAG}`,
    });
  });

  // The new case: `-f` is only read when a server starts, so toggling
  // userTmuxConfig against a running server changes nothing at all.
  test("a different conf tag is stale on the user config", () => {
    expect(compareGeneration(`${ASSETS}.${DOT_TAG}`, DIR, "")).toEqual({
      kind: "stale",
      cause: "user-config",
      running: `${ASSETS}.${DOT_TAG}`,
      expected: `${ASSETS}.none`,
    });
  });

  // Two causes, one remedy. The version is the larger fact and its notice
  // covers the config change, so it does not need a third message.
  test("both differing reports the assets, the bigger fact", () => {
    const verdict = compareGeneration(`0000aaaa1111bbbb.none`, DIR, DOT);
    expect(verdict).toMatchObject({ kind: "stale", cause: "assets" });
  });

  // A stamp written before this feature has no conf half. It cannot say what
  // that server sourced, and guessing would be the confidently-wrong answer
  // this module already refuses to give for an unstamped server. In practice
  // it is moot: this release edits config/tmux.conf, so the asset half of any
  // such stamp differs anyway and reports itself.
  test("a one-part legacy stamp is judged on its assets alone", () => {
    expect(compareGeneration("0000aaaa1111bbbb", DIR, DOT)).toMatchObject({
      kind: "stale",
      cause: "assets",
    });
    expect(compareGeneration(ASSETS, DIR, DOT)).toEqual({ kind: "current" });
  });

  // Never cry wolf: an unstamped server may be one the user started themselves,
  // and a warning that fires on those gets trained away.
  test("no stamp is unstamped, not stale", () => {
    expect(compareGeneration("", DIR, DOT)).toEqual({ kind: "unstamped" });
    expect(compareGeneration("   ", DIR, DOT)).toEqual({ kind: "unstamped" });
  });
});

describe("staleGenerationNotice", () => {
  test("explains why a restart is required, not just that one is", () => {
    const notice = staleGenerationNotice(compareGeneration("old", DIR, DOT)).join("\n");
    expect(notice).toContain("only reads its config file when the");
    expect(notice).toContain("tmux kill-server");
  });

  // One message covering two causes is how a warning trains people to ignore
  // it: "jmux was upgraded" is not an explanation a user who just edited
  // userTmuxConfig can act on, and they would go looking for the wrong thing.
  test("names the cause, so the two are not one message", () => {
    const assets = staleGenerationNotice(
      compareGeneration(`0000aaaa1111bbbb.${DOT_TAG}`, DIR, DOT),
    ).join("\n");
    const conf = staleGenerationNotice(compareGeneration(`${ASSETS}.${DOT_TAG}`, DIR, "")).join(
      "\n",
    );

    expect(assets).toContain("version of jmux");
    expect(assets).not.toContain("userTmuxConfig");
    expect(conf).toContain("userTmuxConfig");
    expect(conf).not.toContain("version of jmux");
    expect(conf).toContain("tmux kill-server");
  });

  test("says nothing when there is nothing wrong", () => {
    expect(staleGenerationNotice({ kind: "current" })).toEqual([]);
    expect(staleGenerationNotice({ kind: "unstamped" })).toEqual([]);
  });
});
