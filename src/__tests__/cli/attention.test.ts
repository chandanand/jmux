import { describe, test, expect } from "bun:test";
import { buildAttentionCommands } from "../../cli/session";

describe("buildAttentionCommands", () => {
  // The flag is what every reader watches, and each entry is its own round trip
  // to the server, so it is written after the reason it explains and cleared
  // before it. Anything else is briefly readable as a flag with no reason.
  test("set writes the reason first, then raises the flag", () => {
    const cmds = buildAttentionCommands("set", "TRA-1", "ci failed");
    expect(cmds).toEqual([
      {
        args: ["set-option", "-t", "TRA-1", "@jmux-attention-reason", "ci failed"],
        required: true,
      },
      { args: ["set-option", "-t", "TRA-1", "@jmux-attention", "1"], required: true },
    ]);
  });

  test("set without a reason clears any stale one before flagging (optional)", () => {
    const cmds = buildAttentionCommands("set", "TRA-1", null);
    expect(cmds[0]).toEqual({
      args: ["set-option", "-t", "TRA-1", "-u", "@jmux-attention-reason"],
      required: false,
    });
    expect(cmds[1].args).toEqual(["set-option", "-t", "TRA-1", "@jmux-attention", "1"]);
  });

  test("clear drops the flag first; only the flag itself is required", () => {
    const cmds = buildAttentionCommands("clear", "TRA-1", null);
    expect(cmds).toEqual([
      { args: ["set-option", "-t", "TRA-1", "-u", "@jmux-attention"], required: true },
      {
        args: ["set-option", "-t", "TRA-1", "-u", "@jmux-attention-reason"],
        required: false,
      },
    ]);
  });

  test("rejects an unknown verb", () => {
    expect(() => buildAttentionCommands("bogus", "TRA-1", null)).toThrow();
  });
});
