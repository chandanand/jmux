import { describe, test, expect } from "bun:test";
import { parseCtlArgs } from "../../cli";

describe("parseCtlArgs", () => {
  test("parses session list", () => {
    const result = parseCtlArgs(["session", "list"]);
    expect(result.group).toBe("session");
    expect(result.action).toBe("list");
    expect(result.flags).toEqual({});
    expect(result.positional).toEqual([]);
  });

  test("parses global --session flag", () => {
    const result = parseCtlArgs(["--session", "my-proj", "window", "list"]);
    expect(result.group).toBe("window");
    expect(result.action).toBe("list");
    expect(result.flags.session).toBe("my-proj");
  });

  test("parses global -L flag", () => {
    const result = parseCtlArgs(["-L", "work", "session", "list"]);
    expect(result.flags.socket).toBe("work");
  });

  test("parses --socket flag", () => {
    const result = parseCtlArgs(["--socket", "work", "session", "list"]);
    expect(result.flags.socket).toBe("work");
  });

  test("parses action-specific flags", () => {
    const result = parseCtlArgs(["session", "create", "--name", "foo", "--dir", "/tmp"]);
    expect(result.action).toBe("create");
    expect(result.flags.name).toBe("foo");
    expect(result.flags.dir).toBe("/tmp");
  });

  test("parses --target flag", () => {
    const result = parseCtlArgs(["session", "kill", "--target", "my-proj"]);
    expect(result.flags.target).toBe("my-proj");
  });

  test("parses --force flag", () => {
    const result = parseCtlArgs(["session", "kill", "--target", "foo", "--force"]);
    expect(result.flags.force).toBe(true);
  });

  test("parses --no-enter flag", () => {
    const result = parseCtlArgs(["pane", "send-keys", "--target", "%5", "--no-enter"]);
    expect(result.flags["no-enter"]).toBe(true);
  });

  test("collects positional args after flags", () => {
    const result = parseCtlArgs(["pane", "send-keys", "--target", "%5", "ls", "-la"]);
    expect(result.positional).toEqual(["ls", "-la"]);
  });

  test("parses run-claude as standalone group", () => {
    const result = parseCtlArgs(["run-claude", "--name", "fix", "--dir", "/tmp"]);
    expect(result.group).toBe("run-claude");
    expect(result.action).toBeNull();
  });

  test("errors on missing group", () => {
    expect(() => parseCtlArgs([])).toThrow();
  });

  test("errors on unknown group", () => {
    expect(() => parseCtlArgs(["bogus", "list"])).toThrow();
  });

  test("parses status as a standalone group", () => {
    const result = parseCtlArgs(["status"]);
    expect(result.group).toBe("status");
    expect(result.action).toBeNull();
  });

  test("parses agent state with --all", () => {
    const result = parseCtlArgs(["agent", "state", "--all"]);
    expect(result.group).toBe("agent");
    expect(result.action).toBe("state");
    expect(result.flags.all).toBe(true);
  });

  test("parses agent watch with a trailing --session", () => {
    const result = parseCtlArgs(["agent", "watch", "--session", "TRA-1"]);
    expect(result.action).toBe("watch");
    expect(result.flags.session).toBe("TRA-1");
  });

  test("parses session attention set with target and reason", () => {
    const result = parseCtlArgs([
      "session",
      "attention",
      "set",
      "--target",
      "TRA-1",
      "--reason",
      "ci failed",
    ]);
    expect(result.group).toBe("session");
    expect(result.action).toBe("attention");
    expect(result.positional).toEqual(["set"]);
    expect(result.flags.target).toBe("TRA-1");
    expect(result.flags.reason).toBe("ci failed");
  });

  test("-L is honored after the group, not swallowed as a positional", () => {
    // Otherwise it silently reads the default server instead of the named one.
    const result = parseCtlArgs(["workflow", "board", "-L", "other"]);
    expect(result.flags.socket).toBe("other");
    expect(result.positional).toEqual([]);
  });

  test("-L after the group still requires a value", () => {
    expect(() => parseCtlArgs(["workflow", "board", "-L"])).toThrow();
  });

  test("parses workflow actions", () => {
    for (const action of ["stages", "board", "next", "statuses"]) {
      const result = parseCtlArgs(["workflow", action]);
      expect(result.group).toBe("workflow");
      expect(result.action).toBe(action);
    }
  });

  test("parses workflow board --stage as a value flag, not a boolean", () => {
    const result = parseCtlArgs(["workflow", "board", "--stage", "in-progress"]);
    expect(result.flags.stage).toBe("in-progress");
  });

  test("parses workflow next --start", () => {
    const result = parseCtlArgs(["workflow", "next", "--start"]);
    expect(result.flags.start).toBe(true);
  });

  test("parses issue move with two positional args", () => {
    const result = parseCtlArgs(["issue", "move", "TRA-1", "In Review"]);
    expect(result.group).toBe("issue");
    expect(result.action).toBe("move");
    expect(result.positional).toEqual(["TRA-1", "In Review"]);
  });

  test("parses issue link with two positional args", () => {
    const result = parseCtlArgs(["issue", "link", "TRA-1", "session-name"]);
    expect(result.group).toBe("issue");
    expect(result.action).toBe("link");
    expect(result.positional).toEqual(["TRA-1", "session-name"]);
  });

  test("parses issue start with repo, base-branch and no-launch-agent", () => {
    const result = parseCtlArgs([
      "issue",
      "start",
      "TRA-1",
      "--repo",
      "/repo",
      "--base-branch",
      "develop",
      "--no-launch-agent",
    ]);
    expect(result.action).toBe("start");
    expect(result.positional).toEqual(["TRA-1"]);
    expect(result.flags.repo).toBe("/repo");
    expect(result.flags["base-branch"]).toBe("develop");
    expect(result.flags["no-launch-agent"]).toBe(true);
  });
});

describe("end-of-flags (`--`)", () => {
  // `browser action` hands everything after `--` to another program's CLI.
  // Parsing it as ours dropped the flag *names* and left their values as bare
  // positionals — `click --ref e2` arrived as `click e2`, a different command
  // delivered to a real browser without any error.
  test("passes everything after -- through verbatim", () => {
    const p = parseCtlArgs(["browser", "action", "--", "click", "--ref", "e2"]);
    expect(p.positional).toEqual(["click", "--ref", "e2"]);
  });

  test("keeps values that would otherwise be eaten as flag arguments", () => {
    const p = parseCtlArgs([
      "browser", "action", "--", "fill", "--ref", "e3", "--text", "hello world",
    ]);
    expect(p.positional).toEqual(["fill", "--ref", "e3", "--text", "hello world"]);
  });

  test("does not leave a junk empty-named flag behind", () => {
    expect(parseCtlArgs(["browser", "action", "--", "snapshot"]).flags).toEqual({});
  });

  test("still parses jmux's own flags before the --", () => {
    const p = parseCtlArgs(["browser", "action", "--pane", "%3", "--", "click", "--ref", "e2"]);
    expect(p.flags.pane).toBe("%3");
    expect(p.positional).toEqual(["click", "--ref", "e2"]);
  });

  test("a second -- is the payload's, not ours", () => {
    const p = parseCtlArgs(["browser", "action", "--", "eval", "--", "1 + 1"]);
    expect(p.positional).toEqual(["eval", "--", "1 + 1"]);
  });
});
