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

describe("repeated value flags", () => {
  // `flags` must stay last-wins for every existing command's sake — this is
  // the regression guard for that promise.
  test("a value flag given twice leaves flags[name] holding the last value", () => {
    const result = parseCtlArgs([
      "issue", "list", "--status", "To do", "--status", "QA Failed",
    ]);
    expect(result.flags.status).toBe("QA Failed");
    expect(result.repeated.status).toEqual(["To do", "QA Failed"]);
  });

  test("a value flag given once is a plain string in flags and a single-element array in repeated", () => {
    const result = parseCtlArgs(["issue", "list", "--status", "To do"]);
    expect(result.flags.status).toBe("To do");
    expect(result.repeated.status).toEqual(["To do"]);
  });

  test("a value flag never given has no entry in repeated", () => {
    const result = parseCtlArgs(["issue", "list"]);
    expect(result.repeated.status).toBeUndefined();
  });
});

describe("--flag=value form", () => {
  // `--status="QA Failed"` reaches us as the single token `--status=QA
  // Failed` once the shell strips the quotes. Before this, `name` included
  // the whole `status=QA Failed` string, matched nothing in VALUE_FLAGS, and
  // fell through to the permissive unknown-flag branch — the filter vanished
  // and the command silently returned the operator's entire queue with exit
  // 0, the form a programmatic caller most naturally emits.
  test("--flag=value sets flags[name] to the value after the equals sign", () => {
    const result = parseCtlArgs(["issue", "list", "--status=QA Failed"]);
    expect(result.flags.status).toBe("QA Failed");
  });

  test("--flag=value accumulates into repeated exactly like --flag value", () => {
    const result = parseCtlArgs(["issue", "list", "--status=QA Failed"]);
    expect(result.repeated.status).toEqual(["QA Failed"]);
  });

  test("--flag=value never leaves a junk flag key behind", () => {
    const result = parseCtlArgs(["issue", "list", "--status=QA Failed"]);
    expect(Object.keys(result.flags)).toEqual(["status"]);
  });

  test("a value containing its own equals sign splits only on the first one", () => {
    const result = parseCtlArgs(["session", "create", "--name", "x", "--command=FOO=bar"]);
    expect(result.flags.command).toBe("FOO=bar");
  });

  test("an empty value after the equals sign is accepted, not treated as missing", () => {
    const result = parseCtlArgs(["issue", "list", "--status="]);
    expect(result.flags.status).toBe("");
  });

  test("--flag=value still consumes exactly one token, leaving positionals intact", () => {
    const result = parseCtlArgs(["issue", "move", "TRA-1", "--status=In Review", "extra"]);
    expect(result.flags.status).toBe("In Review");
    expect(result.positional).toEqual(["TRA-1", "extra"]);
  });

  test("a repeated mix of --flag=value and --flag value forms both accumulate, last-wins in flags", () => {
    const result = parseCtlArgs([
      "issue", "list", "--status=To do", "--status", "QA Failed", "--status=Done",
    ]);
    expect(result.flags.status).toBe("Done");
    expect(result.repeated.status).toEqual(["To do", "QA Failed", "Done"]);
  });

  test("boolean flags are unaffected — --force=true still falls through, not treated as inline-valued", () => {
    // Out of scope for this fix: only VALUE_FLAGS gain `=value` support.
    const result = parseCtlArgs(["session", "kill", "--target", "foo", "--force=true"]);
    expect(result.flags.force).toBeUndefined();
    expect(result.flags["force=true"]).toBe(true);
  });

  test("an optional-numeric flag written with = keeps its value", () => {
    const parsed = parseCtlArgs(["issue", "start", "TRA-1", "--wait=30"]);
    expect(parsed.flags.wait).toBe("30");
    expect(parsed.flags["wait=30"]).toBeUndefined();
  });

  test("an optional-numeric flag with no value still works both ways", () => {
    expect(parseCtlArgs(["issue", "start", "TRA-1", "--wait"]).flags.wait).toBe(true);
    expect(parseCtlArgs(["issue", "start", "TRA-1", "--wait", "60"]).flags.wait).toBe("60");
  });

  test("repeating an optional-numeric flag accumulates across both spellings", () => {
    const parsed = parseCtlArgs(["issue", "start", "TRA-1", "--wait=30", "--wait", "60"]);
    expect(parsed.repeated.wait).toEqual(["30", "60"]);
  });

  test("an optional-numeric flag's = value reaches the parser literally, with no numeric sniffing", () => {
    const parsed = parseCtlArgs(["issue", "start", "TRA-1", "--wait=abc"]);
    expect(parsed.flags.wait).toBe("abc");
    expect(parsed.flags["wait=abc"]).toBeUndefined();
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

describe("optional-value flags (`--wait`)", () => {
  test("bare --wait before the issue id does not eat it", () => {
    // A plain value flag would take "TRA-1580" as the wait duration and leave
    // the command with no positional at all — the same class of silent
    // misparse the `--` handling exists to prevent.
    const r = parseCtlArgs(["issue", "start", "--wait", "TRA-1580"]);
    expect(r.flags.wait).toBe(true);
    expect(r.positional).toEqual(["TRA-1580"]);
  });

  test("bare --wait at the end of the argv does not throw", () => {
    const r = parseCtlArgs(["issue", "start", "TRA-1580", "--wait"]);
    expect(r.flags.wait).toBe(true);
    expect(r.positional).toEqual(["TRA-1580"]);
  });

  test("a numeric value is taken as the bound", () => {
    const r = parseCtlArgs(["issue", "start", "TRA-1580", "--wait", "90"]);
    expect(r.flags.wait).toBe("90");
    expect(r.positional).toEqual(["TRA-1580"]);
  });

  test("--wait 90 before the id keeps both", () => {
    const r = parseCtlArgs(["issue", "start", "--wait", "90", "TRA-1580"]);
    expect(r.flags.wait).toBe("90");
    expect(r.positional).toEqual(["TRA-1580"]);
  });
});

describe("raise-group flags are scoped to the raise group", () => {
  test("--option accumulates inside the raise group", () => {
    const p = parseCtlArgs(["raise", "create", "--issue", "AAA-1", "--option", "a", "--option", "b"]);
    expect(p.repeated.option).toEqual(["a", "b"]);
  });

  test("--note takes a value inside the raise group", () => {
    const p = parseCtlArgs(["raise", "answer", "r1", "--option", "o1", "--note", "because"]);
    expect(p.flags.note).toBe("because");
  });

  test("outside the raise group, the same flag names keep their old meaning", () => {
    // Registering these globally would change how existing published commands
    // consume the token after them. `--option` is unknown to `session`, so it
    // stays a permissive boolean and "a" stays a positional.
    const p = parseCtlArgs(["session", "list", "--option", "a"]);
    expect(p.flags.option).toBe(true);
    expect(p.positional).toContain("a");
    expect(p.repeated.option).toBeUndefined();
  });
});
