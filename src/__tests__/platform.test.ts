import { describe, expect, test } from "bun:test";
import { clipboardCopyCommand, openUrlArgv } from "../platform";

const has = (...present: string[]) => (cmd: string) =>
  present.includes(cmd) ? `/usr/bin/${cmd}` : null;
const hasNothing = () => null;

describe("openUrlArgv", () => {
  test("uses open on macOS", () => {
    expect(openUrlArgv("https://x.test", "darwin", hasNothing)).toEqual([
      "open",
      "https://x.test",
    ]);
  });

  test("uses xdg-open on Linux when present", () => {
    expect(openUrlArgv("https://x.test", "linux", has("xdg-open"))).toEqual([
      "xdg-open",
      "https://x.test",
    ]);
  });

  // A headless box has no browser to open. Returning null lets the caller say
  // so; spawning a missing binary would look like success.
  test("returns null on Linux without xdg-open", () => {
    expect(openUrlArgv("https://x.test", "linux", hasNothing)).toBeNull();
  });
});

describe("clipboardCopyCommand", () => {
  test("pbcopy on macOS", () => {
    expect(clipboardCopyCommand("darwin", hasNothing)).toBe("pbcopy");
  });

  test("prefers wl-copy over xclip on Linux", () => {
    expect(clipboardCopyCommand("linux", has("wl-copy", "xclip"))).toBe("wl-copy");
  });

  test("falls back through xclip to xsel", () => {
    expect(clipboardCopyCommand("linux", has("xclip", "xsel"))).toBe(
      "xclip -selection clipboard",
    );
    expect(clipboardCopyCommand("linux", has("xsel"))).toBe("xsel --clipboard --input");
  });

  // Empty is the signal the tmux bind branches on to print a message.
  test("empty when Linux has no clipboard tool", () => {
    expect(clipboardCopyCommand("linux", hasNothing)).toBe("");
  });
});
