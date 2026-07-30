import { describe, expect, test } from "bun:test";
import {
  compareGeneration,
  GENERATION_OPTION,
  hashOf,
  stampCommand,
  staleGenerationNotice,
} from "../config-generation";

const DIR = "/home/u/.local/share/jmux/assets/96cac232fb21da7c";

describe("hashOf", () => {
  test("is the last path segment of a materialized dir", () => {
    expect(hashOf(DIR)).toBe("96cac232fb21da7c");
  });
});

describe("stampCommand", () => {
  test("sets the generation option to this jmux's asset hash", () => {
    expect(stampCommand(DIR)).toBe(`set-option -g ${GENERATION_OPTION} 96cac232fb21da7c`);
  });
});

describe("compareGeneration", () => {
  test("matching stamp is current", () => {
    expect(compareGeneration("96cac232fb21da7c", DIR)).toEqual({ kind: "current" });
  });

  test("tolerates surrounding whitespace from tmux output", () => {
    expect(compareGeneration(" 96cac232fb21da7c\n", DIR)).toEqual({ kind: "current" });
  });

  // The upgrade case this exists for: jmux was upgraded, the server was not
  // restarted, and every new binding silently does nothing.
  test("different stamp is stale and names both generations", () => {
    expect(compareGeneration("0000aaaa1111bbbb", DIR)).toEqual({
      kind: "stale",
      running: "0000aaaa1111bbbb",
      expected: "96cac232fb21da7c",
    });
  });

  // Never cry wolf: an unstamped server may be one the user started themselves,
  // and a warning that fires on those gets trained away.
  test("no stamp is unstamped, not stale", () => {
    expect(compareGeneration("", DIR)).toEqual({ kind: "unstamped" });
    expect(compareGeneration("   ", DIR)).toEqual({ kind: "unstamped" });
  });
});

describe("staleGenerationNotice", () => {
  test("explains why a restart is required, not just that one is", () => {
    const notice = staleGenerationNotice(compareGeneration("old", DIR)).join("\n");
    expect(notice).toContain("only reads its config file when the");
    expect(notice).toContain("tmux kill-server");
  });

  test("says nothing when there is nothing wrong", () => {
    expect(staleGenerationNotice({ kind: "current" })).toEqual([]);
    expect(staleGenerationNotice({ kind: "unstamped" })).toEqual([]);
  });
});
