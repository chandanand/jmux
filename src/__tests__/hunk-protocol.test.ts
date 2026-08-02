import { describe, test, expect } from "bun:test";
import {
  daemonBase,
  diffStats,
  formatDiffBadge,
  formatReviewPrompt,
  parseCapabilities,
  parseNote,
  parseNotes,
  parseSession,
  parseSessionList,
  sessionByPid,
  supportsControlPlane,
  userNotes,
  type HunkNote,
} from "../hunk/protocol";

// Every fixture below is a payload captured verbatim from a live hunk 0.17.7
// daemon. Inventing these shapes would defeat the point of the module: the
// parsers exist because the daemon is a separate program whose payloads jmux
// does not control, so a fixture that was written to match the parser proves
// nothing about the parser.

const LIST_PAYLOAD = {
  sessions: [
    {
      sessionId: "4d65065d-444b-4ee6-b3d0-8d4d1de917a4",
      pid: 45197,
      cwd: "/Users/j/Code/jmux",
      repoRoot: "/Users/j/Code/jmux",
      launchedAt: "2026-08-02T14:46:59.398Z",
      terminal: { program: "tmux", locations: [{ source: "tty", tty: "/dev/ttys019" }] },
      inputKind: "vcs",
      title: "jmux working tree",
      sourceLabel: "/Users/j/Code/jmux",
      fileCount: 2,
      files: [
        { id: "…:0:IDEAS.md:extra:0", path: "IDEAS.md", additions: 1, deletions: 0, hunkCount: 1 },
        { id: "…:1:src/main.ts", path: "src/main.ts", additions: 12, deletions: 4, hunkCount: 3 },
      ],
      snapshot: {
        updatedAt: "2026-08-02T14:47:52.801Z",
        state: {
          selectedFileId: "…:0:IDEAS.md:extra:0",
          selectedFilePath: "IDEAS.md",
          selectedHunkIndex: 0,
          selectedHunkNewRange: [1, 1],
          showAgentNotes: false,
          liveCommentCount: 1,
          liveComments: [
            {
              commentId: "mcp:a1f2452b",
              filePath: "IDEAS.md",
              hunkIndex: 0,
              side: "new",
              line: 1,
              summary: "probe note",
              rationale: "checking shape",
              author: "agent",
              createdAt: "2026-08-02T14:47:16.779Z",
            },
          ],
          reviewNoteCount: 2,
          reviewNotes: [
            {
              noteId: "mcp:a1f2452b",
              source: "agent",
              filePath: "IDEAS.md",
              hunkIndex: 0,
              newRange: [1, 1],
              body: "probe note\n\nchecking shape",
              author: "agent",
              createdAt: "2026-08-02T14:47:16.779Z",
              editable: false,
            },
            {
              noteId: "user:1785682072798-1",
              source: "user",
              filePath: "IDEAS.md",
              hunkIndex: 0,
              newRange: [1, 1],
              body: "this needs a test",
              author: "user",
              createdAt: "2026-08-02T14:47:52.798Z",
              editable: true,
            },
          ],
        },
      },
    },
  ],
};

const COMMENT_LIST_PAYLOAD = {
  comments: [
    {
      noteId: "user:1785684407421-1",
      source: "user",
      filePath: "IDEAS.md",
      hunkIndex: 0,
      newRange: [7, 7],
      body: "needs a test here",
      author: "user",
      createdAt: "2026-08-02T15:26:47.421Z",
      editable: true,
    },
  ],
};

describe("daemonBase", () => {
  test("defaults to hunk's documented bind", () => {
    expect(daemonBase({})).toBe("http://127.0.0.1:47657");
  });

  test("follows the same env vars hunk itself reads", () => {
    expect(daemonBase({ HUNK_MCP_HOST: "localhost", HUNK_MCP_PORT: "9999" })).toBe("http://localhost:9999");
  });

  // A garbage port must not produce an unfetchable URL — the panel would then
  // have no control plane for a reason no error surface would ever explain.
  test("falls back on an unusable port", () => {
    expect(daemonBase({ HUNK_MCP_PORT: "not-a-port" })).toBe("http://127.0.0.1:47657");
    expect(daemonBase({ HUNK_MCP_PORT: "70000" })).toBe("http://127.0.0.1:47657");
    expect(daemonBase({ HUNK_MCP_PORT: "0" })).toBe("http://127.0.0.1:47657");
  });
});

describe("parseCapabilities / supportsControlPlane", () => {
  const REAL = {
    version: 1,
    daemonVersion: 4,
    actions: [
      "list", "get", "context", "review", "navigate", "reload",
      "comment-add", "comment-apply", "comment-list", "comment-rm", "comment-clear",
    ],
  };

  test("parses the live capabilities payload", () => {
    expect(parseCapabilities(REAL)).toEqual({ version: 1, daemonVersion: 4, actions: REAL.actions });
  });

  test("a real daemon supports everything jmux calls", () => {
    expect(supportsControlPlane(parseCapabilities(REAL))).toBe(true);
  });

  test("no daemon means no control plane", () => {
    expect(parseCapabilities(null)).toBeNull();
    expect(parseCapabilities("nope")).toBeNull();
    expect(supportsControlPlane(null)).toBe(false);
  });

  // Refusing an unfamiliar version would strand users on every hunk release;
  // the actions list is the contract that actually matters.
  test("an unknown future version is accepted when the actions are there", () => {
    const future = parseCapabilities({ version: 99, daemonVersion: 400, actions: REAL.actions });
    expect(supportsControlPlane(future)).toBe(true);
  });

  test("a daemon missing an action jmux calls is refused", () => {
    const old = parseCapabilities({ version: 1, daemonVersion: 1, actions: ["list", "get"] });
    expect(supportsControlPlane(old)).toBe(false);
  });
});

describe("parseSessionList", () => {
  const sessions = parseSessionList(LIST_PAYLOAD);

  test("reads the live list payload", () => {
    expect(sessions).toHaveLength(1);
    expect(sessions[0].sessionId).toBe("4d65065d-444b-4ee6-b3d0-8d4d1de917a4");
    expect(sessions[0].pid).toBe(45197);
    expect(sessions[0].files.map((f) => f.path)).toEqual(["IDEAS.md", "src/main.ts"]);
  });

  test("lifts the selection out of the nested snapshot", () => {
    expect(sessions[0].selectedFilePath).toBe("IDEAS.md");
    expect(sessions[0].selectedHunkIndex).toBe(0);
  });

  test("reads notes off the snapshot, both sources", () => {
    expect(sessions[0].notes.map((n) => n.source)).toEqual(["agent", "user"]);
  });

  test("a session with no snapshot yet parses with empty selection", () => {
    const bare = parseSessionList({ sessions: [{ sessionId: "s", pid: 1 }] });
    expect(bare).toHaveLength(1);
    expect(bare[0].selectedFilePath).toBeNull();
    expect(bare[0].notes).toEqual([]);
  });

  test("garbage yields no sessions rather than throwing", () => {
    expect(parseSessionList(null)).toEqual([]);
    expect(parseSessionList({ sessions: "no" })).toEqual([]);
    expect(parseSessionList({ sessions: [{ noPid: true }] })).toEqual([]);
  });
});

describe("parseSession", () => {
  test("unwraps a get payload", () => {
    const s = parseSession(LIST_PAYLOAD.sessions[0]);
    expect(s?.title).toBe("jmux working tree");
    expect(s?.inputKind).toBe("vcs");
  });
});

describe("parseNote — the two shapes the daemon uses", () => {
  test("comment-list's newRange form", () => {
    const notes = parseNotes(COMMENT_LIST_PAYLOAD);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ noteId: "user:1785684407421-1", line: 7, side: "new", body: "needs a test here" });
  });

  // A snapshot's liveComments carry commentId/line/side/summary instead, and
  // normalising both here is what lets every consumer see one shape.
  test("a snapshot's liveComment form normalises to the same thing", () => {
    const note = parseNote(LIST_PAYLOAD.sessions[0].snapshot.state.liveComments[0]);
    expect(note).toMatchObject({ noteId: "mcp:a1f2452b", line: 1, side: "new", author: "agent" });
  });

  test("summary and rationale join into one body", () => {
    const note = parseNote(LIST_PAYLOAD.sessions[0].snapshot.state.liveComments[0]);
    expect(note?.body).toBe("probe note\n\nchecking shape");
  });

  test("an oldRange note keeps its side", () => {
    const note = parseNote({ noteId: "n", filePath: "a.ts", oldRange: [12, 12], body: "x" });
    expect(note).toMatchObject({ line: 12, side: "old" });
  });

  test("a note with no anchor still parses", () => {
    const note = parseNote({ noteId: "n", filePath: "a.ts", body: "x" });
    expect(note?.line).toBeNull();
  });

  test("a note with no id is dropped", () => {
    expect(parseNote({ filePath: "a.ts", body: "x" })).toBeNull();
  });

  // The legacy no-type comment list returns entries with neither field.
  test("the legacy comment view's entries are dropped rather than half-read", () => {
    expect(parseNotes({ comments: [{ text: "legacy" }] })).toEqual([]);
  });
});

describe("sessionByPid", () => {
  const sessions = parseSessionList(LIST_PAYLOAD);

  test("finds our own hunk by its pty child pid", () => {
    expect(sessionByPid(sessions, 45197)?.sessionId).toBe("4d65065d-444b-4ee6-b3d0-8d4d1de917a4");
  });

  // The daemon keeps dead sessions for 45s, so "not found" is both normal
  // right after spawn and the only safe answer for someone else's session.
  test("a pid the daemon has never seen is a miss, not a wrong match", () => {
    expect(sessionByPid(sessions, 999)).toBeNull();
    expect(sessionByPid(sessions, null)).toBeNull();
    expect(sessionByPid([], 45197)).toBeNull();
  });
});

describe("diffStats", () => {
  test("totals every file", () => {
    expect(diffStats(parseSessionList(LIST_PAYLOAD)[0])).toEqual({ files: 2, additions: 13, deletions: 4 });
  });

  test("no session is a zero, not a crash", () => {
    expect(diffStats(null)).toEqual({ files: 0, additions: 0, deletions: 0 });
  });
});

describe("userNotes", () => {
  test("keeps the human's notes and drops the agent's", () => {
    const notes = parseSessionList(LIST_PAYLOAD)[0].notes;
    expect(userNotes(notes).map((n) => n.body)).toEqual(["this needs a test"]);
  });
});

describe("formatDiffBadge", () => {
  const stats = { files: 2, additions: 13, deletions: 4 };

  test("shows the stats when there is a diff", () => {
    expect(formatDiffBadge(stats, 0, 80)).toBe("+13 −4");
  });

  test("appends a pending-note count", () => {
    expect(formatDiffBadge(stats, 2, 80)).toBe("+13 −4 ●2");
  });

  test("tightens up in a narrow panel", () => {
    expect(formatDiffBadge(stats, 0, 30)).toBe("+13−4");
  });

  test("nothing to say means no badge at all", () => {
    expect(formatDiffBadge({ files: 0, additions: 0, deletions: 0 }, 0, 80)).toBeNull();
  });

  // Notes can outlive the diff they were written against — a note on a hunk the
  // agent has since reverted still needs sending.
  test("pending notes show even with an empty diff", () => {
    expect(formatDiffBadge({ files: 0, additions: 0, deletions: 0 }, 1, 80)).toBe("●1");
  });
});

describe("formatReviewPrompt", () => {
  const note = (over: Partial<HunkNote>): HunkNote => ({
    noteId: "n",
    source: "user",
    filePath: "src/a.ts",
    hunkIndex: 0,
    line: 10,
    side: "new",
    body: "extract this",
    author: "user",
    createdAt: "",
    ...over,
  });

  test("no notes produces nothing to send", () => {
    expect(formatReviewPrompt([])).toBe("");
  });

  test("each note carries a path:line an agent can navigate to", () => {
    const out = formatReviewPrompt([note({})]);
    expect(out).toContain("src/a.ts:10 — extract this");
  });

  test("groups by file", () => {
    const out = formatReviewPrompt([
      note({ filePath: "src/a.ts", line: 10 }),
      note({ filePath: "src/b.ts", line: 3, body: "rename" }),
      note({ filePath: "src/a.ts", line: 40, body: "add a test" }),
    ]);
    expect(out.match(/^src\/a\.ts:$/gm)).toHaveLength(1);
    expect(out.indexOf("src/a.ts:40")).toBeGreaterThan(out.indexOf("src/a.ts:10"));
  });

  // Read in file order, so the agent opens each file once.
  test("orders notes within a file by line", () => {
    const out = formatReviewPrompt([note({ line: 90, body: "late" }), note({ line: 4, body: "early" })]);
    expect(out.indexOf("early")).toBeLessThan(out.indexOf("late"));
  });

  test("a multi-line note keeps its shape without swallowing the next note", () => {
    const out = formatReviewPrompt([
      note({ line: 5, body: "first line\nsecond line" }),
      note({ line: 6, body: "next note" }),
    ]);
    expect(out).toContain("  - src/a.ts:5 — first line");
    expect(out).toContain("    second line");
    expect(out).toContain("  - src/a.ts:6 — next note");
  });

  test("an unanchored note still names its file", () => {
    const out = formatReviewPrompt([note({ line: null })]);
    expect(out).toContain("- src/a.ts — extract this");
  });

  test("the title names the changeset the notes are about", () => {
    expect(formatReviewPrompt([note({})], { title: "jmux working tree" })).toContain("jmux working tree");
  });
});
