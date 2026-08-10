import { describe, test, expect } from "bun:test";
import { parseSessionListOutput, validateSessionCreate } from "../../cli/session";
import { US } from "../../tmux-fields";

function row(parts: string[]): string {
  return parts.join(US);
}

describe("parseSessionListOutput", () => {
  test("parses list-sessions format string output", () => {
    const lines = [
      row(["$1", "my-project", "1712678400", "1", "3", "/home/dev/code/project", ""]),
      row(["$2", "other", "1712678300", "0", "1", "/home/dev/code/other", ""]),
    ];
    const sessions = parseSessionListOutput(lines);
    expect(sessions).toEqual([
      { id: "$1", name: "my-project", activity: 1712678400, attached: true, windows: 3, path: "/home/dev/code/project" },
      { id: "$2", name: "other", activity: 1712678300, attached: false, windows: 1, path: "/home/dev/code/other" },
    ]);
  });

  test("handles empty output", () => {
    expect(parseSessionListOutput([])).toEqual([]);
  });

  test("handles a path or title containing a colon", () => {
    // The whole reason for the US separator: a Windows path and a
    // model-written title can both contain a colon, which a `:`-joined
    // format would misparse as a field boundary.
    const lines = [row(["$1", "test", "100", "1", "1", "C:\\Users\\test", "Fix: stale cache headers"])];
    const sessions = parseSessionListOutput(lines);
    expect(sessions[0].path).toBe("C:\\Users\\test");
    expect(sessions[0].title).toBe("Fix: stale cache headers");
  });

  test("parses a title field, leaving name as the real session name", () => {
    const lines = [row(["$1", "tra-123", "100", "1", "1", "/repo", "Fix stale cache headers"])];
    const sessions = parseSessionListOutput(lines);
    expect(sessions[0]).toEqual({
      id: "$1",
      name: "tra-123",
      activity: 100,
      attached: true,
      windows: 1,
      path: "/repo",
      title: "Fix stale cache headers",
    });
  });

  test("omits title when the option is unset", () => {
    const lines = [row(["$1", "tra-123", "100", "1", "1", "/repo", ""])];
    const sessions = parseSessionListOutput(lines);
    expect(sessions[0].title).toBeUndefined();
  });
});

describe("validateSessionCreate", () => {
  test("requires --name", () => {
    expect(() => validateSessionCreate({ dir: "/tmp" })).toThrow("--name is required");
  });

  test("requires --dir", () => {
    expect(() => validateSessionCreate({ name: "foo" })).toThrow("--dir is required");
  });

  test("returns sanitized name", () => {
    const result = validateSessionCreate({ name: "foo.bar", dir: "/tmp" });
    expect(result.name).toBe("foo_bar");
    expect(result.dir).toBe("/tmp");
  });

  test("passes through command", () => {
    const result = validateSessionCreate({ name: "test", dir: "/tmp", command: "vim" });
    expect(result.command).toBe("vim");
  });
});
