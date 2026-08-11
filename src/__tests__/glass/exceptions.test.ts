import { describe, test, expect } from "bun:test";
import { GridExceptions, type GridPaneRow } from "../../glass/exceptions";
import type { SessionBand } from "../../session-order";
import type { SessionInfo } from "../../types";

function makeSessions(entries: Array<Partial<SessionInfo> & { name: string }>): SessionInfo[] {
  return entries.map((e, i) => ({
    id: `$${i}`,
    attached: false,
    activity: 0,
    windowCount: 1,
    ...e,
  }));
}

function band(kind: SessionBand["kind"], key: string, indices: number[]): SessionBand {
  return { kind, key, label: key, rank: 0, headerless: false, indices };
}

function pane(sessionId: string, pinnedRaw: string | null): GridPaneRow {
  return { sessionId, pinnedRaw };
}

describe("GridExceptions", () => {
  test("derived member, no exceptions -> tile, source derived", () => {
    const sessions = makeSessions([{ name: "a" }]);
    const result = GridExceptions({
      sessions,
      bands: [band("ungrouped", "ungrouped", [0])],
      hiddenSessionIds: new Set(),
      panes: [],
    });
    expect(result).toEqual([{ index: 0, source: "derived" }]);
  });

  test("hidden, no force-on pane in it -> no tile", () => {
    const sessions = makeSessions([{ name: "a" }]);
    const result = GridExceptions({
      sessions,
      bands: [band("ungrouped", "ungrouped", [0])],
      hiddenSessionIds: new Set(["$0"]),
      panes: [],
    });
    expect(result).toEqual([]);
  });

  test("hidden AND a pane in it force-on -> still no tile, hide wins", () => {
    const sessions = makeSessions([{ name: "a" }]);
    const result = GridExceptions({
      sessions,
      bands: [band("ungrouped", "ungrouped", [0])],
      hiddenSessionIds: new Set(["$0"]),
      panes: [pane("$0", "on")],
    });
    expect(result).toEqual([]);
  });

  test("derived member with a force-on pane -> one tile, still derived (not moved to Added)", () => {
    const sessions = makeSessions([{ name: "a" }]);
    const result = GridExceptions({
      sessions,
      bands: [band("ungrouped", "ungrouped", [0])],
      hiddenSessionIds: new Set(),
      panes: [pane("$0", "on")],
    });
    expect(result).toEqual([{ index: 0, source: "derived" }]);
  });

  test("non-member session with a force-on pane -> one tile, in the Added band, leading", () => {
    const sessions = makeSessions([{ name: "a" }, { name: "b" }]);
    // Only "a" (index 0) is a derived member; "b" (index 1) is not in any band.
    const result = GridExceptions({
      sessions,
      bands: [band("ungrouped", "ungrouped", [0])],
      hiddenSessionIds: new Set(),
      panes: [pane("$1", "on")],
    });
    expect(result).toEqual([
      { index: 1, source: "added" },
      { index: 0, source: "derived" },
    ]);
  });

  test("non-member, non-hidden, no force-on pane -> no tile", () => {
    const sessions = makeSessions([{ name: "a" }, { name: "b" }]);
    const result = GridExceptions({
      sessions,
      bands: [band("ungrouped", "ungrouped", [0])],
      hiddenSessionIds: new Set(),
      panes: [],
    });
    expect(result).toEqual([{ index: 0, source: "derived" }]);
  });

  test("non-member session, hidden, with a force-on pane -> no tile, hide still wins", () => {
    const sessions = makeSessions([{ name: "a" }, { name: "b" }]);
    const result = GridExceptions({
      sessions,
      bands: [band("ungrouped", "ungrouped", [0])],
      hiddenSessionIds: new Set(["$1"]),
      panes: [pane("$1", "on")],
    });
    expect(result).toEqual([{ index: 0, source: "derived" }]);
  });

  test("two force-on panes in one session -> one tile, not two", () => {
    const sessions = makeSessions([{ name: "a" }]);
    const result = GridExceptions({
      sessions,
      bands: [],
      hiddenSessionIds: new Set(),
      panes: [pane("$0", "on"), pane("$0", "on")],
    });
    expect(result).toEqual([{ index: 0, source: "added" }]);
  });

  test("legacy pin values (tab ids, '1', 'default') all read as force-on", () => {
    const sessions = makeSessions([{ name: "a" }, { name: "b" }, { name: "c" }]);
    const result = GridExceptions({
      sessions,
      bands: [],
      hiddenSessionIds: new Set(),
      panes: [pane("$0", "1"), pane("$1", "default"), pane("$2", "some-old-tab-id")],
    });
    expect(result.map((m) => m.index).sort()).toEqual([0, 1, 2]);
    expect(result.every((m) => m.source === "added")).toBe(true);
  });

  test("empty/null pin values are not force-on", () => {
    const sessions = makeSessions([{ name: "a" }]);
    const result = GridExceptions({
      sessions,
      bands: [],
      hiddenSessionIds: new Set(),
      panes: [pane("$0", ""), pane("$0", null)],
    });
    expect(result).toEqual([]);
  });

  test("Added band leads every derived band, in sessions-array order", () => {
    const sessions = makeSessions([
      { name: "derived-a" },
      { name: "added-b" },
      { name: "derived-c" },
      { name: "added-d" },
    ]);
    const result = GridExceptions({
      sessions,
      bands: [band("ungrouped", "ungrouped", [0, 2])],
      hiddenSessionIds: new Set(),
      panes: [pane("$1", "on"), pane("$3", "on")],
    });
    expect(result).toEqual([
      { index: 1, source: "added" },
      { index: 3, source: "added" },
      { index: 0, source: "derived" },
      { index: 2, source: "derived" },
    ]);
  });

  test("preserves multi-band derived order (e.g. pinned band before group bands)", () => {
    const sessions = makeSessions([{ name: "p" }, { name: "g" }]);
    const result = GridExceptions({
      sessions,
      bands: [band("pinned", "pinned", [0]), band("group", "project:x", [1])],
      hiddenSessionIds: new Set(),
      panes: [],
    });
    expect(result).toEqual([
      { index: 0, source: "derived" },
      { index: 1, source: "derived" },
    ]);
  });

  test("session dying (absent from `sessions`) simply cannot appear — no crash on stale band index", () => {
    const sessions = makeSessions([{ name: "a" }]);
    const result = GridExceptions({
      sessions,
      bands: [band("ungrouped", "ungrouped", [0, 1])], // index 1 doesn't exist
      hiddenSessionIds: new Set(),
      panes: [],
    });
    expect(result).toEqual([{ index: 0, source: "derived" }]);
  });

  test("empty input -> empty output", () => {
    const result = GridExceptions({
      sessions: [],
      bands: [],
      hiddenSessionIds: new Set(),
      panes: [],
    });
    expect(result).toEqual([]);
  });
});
