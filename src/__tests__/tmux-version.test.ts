import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  MIN_TMUX_MAJOR,
  MIN_TMUX_MINOR,
  parseTmuxVersion,
  tmuxVersionOk,
} from "../tmux-version";

describe("parseTmuxVersion", () => {
  test("parses plain versions", () => {
    expect(parseTmuxVersion("tmux 3.4")).toEqual({ major: 3, minor: 4 });
  });

  // tmux appends a letter to patch releases, which a naive Number() chokes on.
  test("parses lettered patch releases", () => {
    expect(parseTmuxVersion("tmux 3.1a")).toEqual({ major: 3, minor: 1 });
  });

  test("parses distro release-candidate strings", () => {
    expect(parseTmuxVersion("tmux 3.4-rc1")).toEqual({ major: 3, minor: 4 });
  });

  test("returns null for unrecognisable output", () => {
    expect(parseTmuxVersion("tmux next")).toBeNull();
  });
});

describe("tmuxVersionOk", () => {
  test("accepts the floor and above", () => {
    expect(tmuxVersionOk("tmux 3.2")).toBe(true);
    expect(tmuxVersionOk("tmux 3.6")).toBe(true);
    expect(tmuxVersionOk("tmux 4.0")).toBe(true);
  });

  test("rejects below the floor", () => {
    expect(tmuxVersionOk("tmux 3.1a")).toBe(false);
    expect(tmuxVersionOk("tmux 2.8")).toBe(false);
  });

  // A version string we cannot parse is likelier a fork or a future format
  // than an ancient build; refusing to start would be worse than trying.
  test("lets unparseable versions through", () => {
    expect(tmuxVersionOk("tmux next")).toBe(true);
  });
});

// The installer duplicates this floor on purpose — it must fail before the
// user holds a binary that cannot start, and shell cannot import TypeScript.
// Duplication is fine; silent divergence is not.
describe("install.sh agrees with the constant", () => {
  const installer = readFileSync(
    resolve(import.meta.dir, "..", "..", "site", "install"),
    "utf-8",
  );

  test("carries the same major", () => {
    expect(installer).toContain(`MIN_TMUX_MAJOR=${MIN_TMUX_MAJOR}`);
  });

  test("carries the same minor", () => {
    expect(installer).toContain(`MIN_TMUX_MINOR=${MIN_TMUX_MINOR}`);
  });
});
