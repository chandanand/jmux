import { describe, expect, test } from "bun:test";
import {
  deriveAutomaticWindowTitle,
  needsWindowProcessArgv,
  parseWindowProcesses,
  windowProcessArgv,
} from "../window-title";

describe("deriveAutomaticWindowTitle", () => {
  test("a shell names the directory", () => {
    expect(deriveAutomaticWindowTitle({ command: "zsh", cwd: "/code/payments" }))
      .toBe("payments");
    expect(deriveAutomaticWindowTitle({ command: "bash", cwd: "/" })).toBe("/");
  });

  test("editors and review tools use stable role names", () => {
    expect(deriveAutomaticWindowTitle({ command: "nvim", cwd: "/code/api" })).toBe("editor");
    expect(deriveAutomaticWindowTitle({ command: "hunk", cwd: "/code/api" })).toBe("review");
  });

  test("agents keep their recognizable names", () => {
    expect(deriveAutomaticWindowTitle({ command: "codex", cwd: "/code/api" })).toBe("codex");
    expect(deriveAutomaticWindowTitle({
      command: "fish",
      cwd: "/code/api",
      argv: "fish -c codex --profile work --approve-for-me; exec $SHELL",
    })).toBe("codex");
    expect(deriveAutomaticWindowTitle({
      command: "node",
      cwd: "/code/api",
      argv: "node /opt/lib/node_modules/@anthropic-ai/claude-code/cli.js",
    })).toBe("claude");
  });

  test("runner argv distinguishes tests from servers", () => {
    expect(deriveAutomaticWindowTitle({
      command: "bun", cwd: "/code/api", argv: "bun test --watch",
    })).toBe("tests");
    expect(deriveAutomaticWindowTitle({
      command: "node", cwd: "/code/api", argv: "node ./node_modules/vitest/vitest.mjs",
    })).toBe("tests");
    expect(deriveAutomaticWindowTitle({
      command: "bun", cwd: "/code/api", argv: "bun run dev",
    })).toBe("server");
    expect(deriveAutomaticWindowTitle({
      command: "node", cwd: "/code/api", argv: "node src/server.ts",
    })).toBe("server");
  });

  test("an unknown foreground program uses its executable name", () => {
    expect(deriveAutomaticWindowTitle({ command: "/usr/local/bin/htop", cwd: "/code/api" }))
      .toBe("htop");
  });
});

describe("process argv resolution", () => {
  const processes = parseWindowProcesses([
    " 100 1 /bin/zsh",
    " 200 100 /opt/homebrew/bin/bun run test",
    " 201 200 /opt/homebrew/bin/bun ./node_modules/vitest.mjs",
    " 300 1 unrelated",
  ].join("\n"));

  test("parses pid, parent and the unsplit argv tail", () => {
    expect(processes[1]).toEqual({ pid: 200, ppid: 100, argv: "/opt/homebrew/bin/bun run test" });
  });

  test("chooses the deepest matching foreground process under the pane", () => {
    expect(windowProcessArgv(100, "bun", processes))
      .toBe("/opt/homebrew/bin/bun ./node_modules/vitest.mjs");
  });

  test("never borrows a command from another pane tree", () => {
    expect(windowProcessArgv(300, "bun", processes)).toBeNull();
  });

  test("recovers an auto-launched agent from its wrapper shell", () => {
    const wrapped = parseWindowProcesses([
      " 400 1 /opt/homebrew/bin/fish -c codex --profile work --approve-for-me; exec $SHELL",
      " 401 400 /opt/homebrew/bin/codex --profile work --approve-for-me",
    ].join("\n"));
    const argv = windowProcessArgv(400, "fish", wrapped);
    expect(argv).toContain("fish -c codex");
    expect(deriveAutomaticWindowTitle({ command: "fish", cwd: "/code/api", argv }))
      .toBe("codex");
  });

  test("only ambiguous executables pay for a process snapshot", () => {
    expect(needsWindowProcessArgv("bun")).toBe(true);
    expect(needsWindowProcessArgv("node")).toBe(true);
    expect(needsWindowProcessArgv("fish")).toBe(true);
    expect(needsWindowProcessArgv("nvim")).toBe(false);
    expect(needsWindowProcessArgv("zsh")).toBe(true);
  });
});
