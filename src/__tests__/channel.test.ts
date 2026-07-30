import { describe, expect, test } from "bun:test";
import { detectChannel, isCompiled, upgradeCommand, UPGRADE_DOCS_URL } from "../channel";

const SRC = "/Users/j/Code/jmux/src";
const BUNFS = "/$bunfs/root";

describe("isCompiled", () => {
  test("recognises the compiled virtual filesystem", () => {
    expect(isCompiled(BUNFS)).toBe(true);
    expect(isCompiled(SRC)).toBe(false);
  });
});

describe("detectChannel", () => {
  // The regression this whole two-step design exists to prevent: under Bun,
  // execPath is *Bun's* binary. A Homebrew-installed Bun running jmux from a
  // checkout is an npm/source install, not a Homebrew install of jmux.
  test("a Homebrew Bun running source is npm, not brew", () => {
    expect(detectChannel(SRC, "/opt/homebrew/bin/bun")).toBe("npm");
  });

  test("source is npm regardless of execPath", () => {
    expect(detectChannel(SRC, "/usr/local/bin/bun")).toBe("npm");
    expect(detectChannel(SRC, "/Users/j/.bun/bin/bun")).toBe("npm");
  });

  test("compiled binary under Homebrew is brew", () => {
    expect(detectChannel(BUNFS, "/opt/homebrew/bin/jmux")).toBe("brew");
    expect(detectChannel(BUNFS, "/usr/local/Cellar/jmux/0.25.0/bin/jmux")).toBe("brew");
    expect(detectChannel(BUNFS, "/home/linuxbrew/.linuxbrew/bin/jmux")).toBe("brew");
  });

  test("compiled binary in an installer target is installer", () => {
    expect(detectChannel(BUNFS, "/Users/j/.local/bin/jmux")).toBe("installer");
    expect(detectChannel(BUNFS, "/usr/local/bin/jmux")).toBe("installer");
  });

  test("an unrecognised compiled location is unknown, not a guess", () => {
    expect(detectChannel(BUNFS, "/opt/custom/jmux")).toBe("unknown");
  });
});

describe("upgradeCommand", () => {
  test("names the right command per channel", () => {
    expect(upgradeCommand("brew")).toBe("brew upgrade jmux");
    expect(upgradeCommand("installer")).toContain("jmux.build/install");
    expect(upgradeCommand("npm")).toBe("bun install -g @jx0/jmux");
  });

  // Never invent a command for a location we don't recognise — a wrong upgrade
  // instruction is worse than a link.
  test("falls back to docs when the channel is unknown", () => {
    expect(upgradeCommand("unknown")).toBe(UPGRADE_DOCS_URL);
  });
});
