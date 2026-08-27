import { describe, test, expect } from "bun:test";
import { orderSessions, compareGroupBands, type SessionBand } from "../session-order";
import { Sidebar } from "../sidebar";
import type { SessionInfo } from "../types";
import type { SessionSortInfo, SessionStatus } from "../sidebar-sort";
import type { SessionWorkflow } from "../workflow-drift";

function makeSessions(entries: Array<Partial<SessionInfo> & { name: string }>): SessionInfo[] {
  return entries.map((e, i) => ({
    id: `$${i}`,
    attached: false,
    activity: 0,
    windowCount: 1,
    ...e,
  }));
}

function makeSortInfos(
  sessions: SessionInfo[],
  statusByName: Record<string, SessionStatus> = {},
): SessionSortInfo[] {
  return sessions.map((s) => ({
    name: s.name,
    status: statusByName[s.name] ?? "idle",
    lastActivity: 0,
  }));
}

function idsOf(sessions: SessionInfo[], indices: readonly number[]): string[] {
  return indices.map((i) => sessions[i]!.id);
}

describe("orderSessions", () => {
  test("buckets pinned, grouped, ungrouped and parked sessions in emission order", () => {
    const sessions = makeSessions([
      { name: "p1", repoName: "alpha" },
      { name: "s1", repoName: "alpha" },
      { name: "s2", repoName: "beta" },
      { name: "u1" },
      { name: "k1", repoName: "alpha" },
    ]);
    const sortInfos = makeSortInfos(sessions);

    const bands = orderSessions({
      sessions,
      sortInfos,
      groupMode: "project",
      sortMode: "name",
      filterMode: "all",
      pinnedSessions: new Set(["p1"]),
      parkedSessions: new Set(["k1"]),
      workflowByName: new Map(),
      includeParked: true,
    });

    expect(bands.map((b) => b.kind)).toEqual(["pinned", "group", "group", "ungrouped", "parked"]);
    expect(idsOf(sessions, bands[0]!.indices)).toEqual(["$0"]); // p1
    expect(idsOf(sessions, bands[1]!.indices)).toEqual(["$1"]); // s1, alpha
    expect(idsOf(sessions, bands[2]!.indices)).toEqual(["$2"]); // s2, beta
    expect(idsOf(sessions, bands[3]!.indices)).toEqual(["$3"]); // u1
    expect(idsOf(sessions, bands[4]!.indices)).toEqual(["$4"]); // k1, parked
  });

  test("includeParked: false drops parked sessions entirely rather than reassigning them", () => {
    const sessions = makeSessions([{ name: "a" }, { name: "b" }]);
    const sortInfos = makeSortInfos(sessions);

    const bands = orderSessions({
      sessions,
      sortInfos,
      groupMode: "none",
      sortMode: "name",
      filterMode: "all",
      pinnedSessions: new Set(),
      parkedSessions: new Set(["a"]),
      workflowByName: new Map(),
      includeParked: false,
    });

    // No parked band at all, and "a" doesn't surface anywhere else (not the
    // ungrouped remainder either) — it is dropped, not relabelled.
    expect(bands.some((b) => b.kind === "parked")).toBe(false);
    const allIndices = bands.flatMap((b) => b.indices);
    expect(idsOf(sessions, allIndices)).toEqual(["$1"]); // only "b"
  });

  test("a session that is both pinned and parked still floats into Pinned, even with includeParked: false", () => {
    const sessions = makeSessions([{ name: "a" }]);
    const sortInfos = makeSortInfos(sessions);

    const bands = orderSessions({
      sessions,
      sortInfos,
      groupMode: "none",
      sortMode: "name",
      filterMode: "all",
      pinnedSessions: new Set(["a"]),
      parkedSessions: new Set(["a"]),
      workflowByName: new Map(),
      includeParked: false,
    });

    expect(bands.map((b) => b.kind)).toEqual(["pinned"]);
    expect(idsOf(sessions, bands[0]!.indices)).toEqual(["$0"]);
  });

  test("headerless is true only for the ungrouped band, across every grouping axis", () => {
    const sessions = makeSessions([
      { name: "a", repoName: "alpha" },
      { name: "b" }, // no project → ungrouped under group=project
      { name: "c" },
    ]);
    const sortInfos = makeSortInfos(sessions, { a: "waiting", b: "running", c: "idle" });
    const workflowByName = new Map<string, SessionWorkflow>();

    for (const groupMode of ["none", "project", "status", "stage"] as const) {
      const bands = orderSessions({
        sessions,
        sortInfos,
        groupMode,
        sortMode: "name",
        filterMode: "all",
        pinnedSessions: new Set(),
        parkedSessions: new Set(),
        workflowByName,
        includeParked: true,
      });
      for (const band of bands) {
        expect(band.headerless).toBe(band.kind === "ungrouped");
      }
    }
  });

  test("collapse is not an input — every matching session's index is returned somewhere, unconditionally", () => {
    const sessions = makeSessions([
      { name: "a" },
      { name: "b" },
      { name: "c" },
      { name: "d" },
      { name: "e" },
    ]);
    const sortInfos = makeSortInfos(sessions, {
      a: "waiting",
      b: "running",
      c: "complete",
      d: "activity",
      e: "idle",
    });

    const bands = orderSessions({
      sessions,
      sortInfos,
      groupMode: "status",
      sortMode: "name",
      filterMode: "all",
      pinnedSessions: new Set(),
      parkedSessions: new Set(),
      workflowByName: new Map(),
      includeParked: true,
    });

    // orderSessions has no collapse parameter at all — nothing it returns can
    // depend on collapse state, so the full session set always comes back.
    const allIndices = bands.flatMap((b) => b.indices);
    expect(allIndices.slice().sort((x, y) => x - y)).toEqual([0, 1, 2, 3, 4]);
  });

  test("displayOrder equals the concatenated band indices, with nothing collapsed", () => {
    const sessions = makeSessions([
      { name: "p1", repoName: "alpha" },
      { name: "s1", repoName: "alpha" },
      { name: "s2", repoName: "beta" },
      { name: "u1" },
      { name: "k1" },
    ]);

    const sidebar = new Sidebar(30, 40);
    sidebar.updateSessions(sessions);
    sidebar.setGroupMode("project");
    sidebar.setSortMode("name");
    sidebar.setPinnedSessions(new Set(["p1"]));
    sidebar.setParkedSessions(new Set(["k1"]));
    // Parked's collapse polarity is inverted: absence from collapsedGroups
    // means collapsed, so it must be toggled IN to be expanded — "nothing
    // collapsed" for Parked means `collapsedGroups` containing "parked".
    sidebar.toggleGroup("parked");

    const sortInfos = makeSortInfos(sessions);
    const bands = orderSessions({
      sessions,
      sortInfos,
      groupMode: "project",
      sortMode: "name",
      filterMode: "all",
      pinnedSessions: new Set(["p1"]),
      parkedSessions: new Set(["k1"]),
      workflowByName: new Map(),
      includeParked: true,
    });
    const expectedIds = idsOf(sessions, bands.flatMap((b) => b.indices));

    expect(sidebar.getDisplayOrderIds()).toEqual(expectedIds);
  });
});

describe("compareGroupBands", () => {
  const bandOf = (overrides: Partial<SessionBand>): SessionBand => ({
    kind: "group",
    key: "group:x",
    label: "X",
    rank: 0,
    headerless: false,
    indices: [],
    ...overrides,
  });

  test("orders by rank under status/stage axes, regardless of whether either band has any sessions", () => {
    const ghostOnly = bandOf({ key: "stage:z", label: "Zeta", rank: 5, indices: [] });
    const sessionBearing = bandOf({ key: "stage:a", label: "Alpha", rank: 2, indices: [0, 1] });

    expect(compareGroupBands(sessionBearing, ghostOnly, "stage")).toBeLessThan(0);
    expect(compareGroupBands(ghostOnly, sessionBearing, "stage")).toBeGreaterThan(0);
    expect(compareGroupBands(sessionBearing, ghostOnly, "status")).toBeLessThan(0);
  });

  test("orders alphabetically by label under the project axis, regardless of whether either band has any sessions", () => {
    const ghostOnly = bandOf({ key: "project:zeta", label: "zeta", rank: 99, indices: [] });
    const sessionBearing = bandOf({ key: "project:alpha", label: "alpha", rank: 0, indices: [0] });

    expect(compareGroupBands(sessionBearing, ghostOnly, "project")).toBeLessThan(0);
    expect(compareGroupBands(ghostOnly, sessionBearing, "project")).toBeGreaterThan(0);
  });

  test("a ghost-only band sorts identically to a session-bearing one with the same label and rank", () => {
    const ghostOnly = bandOf({ key: "stage:shared", label: "Shared", rank: 3, indices: [] });
    const sessionBearing = bandOf({ key: "stage:shared", label: "Shared", rank: 3, indices: [7, 8] });

    expect(compareGroupBands(ghostOnly, sessionBearing, "stage")).toBe(0);
    expect(compareGroupBands(ghostOnly, sessionBearing, "project")).toBe(0);
  });
});

describe("project grouping keys on the Project id", () => {
  // Two Projects may share a title — a monorepo serving two teams migrates to
  // exactly that — so keying on the label would put two teams' work under one
  // header. Ghosts bucket on the same key, so an unstarted issue lands in the
  // band its session will join after Start rather than a second one beside it.
  test("two Projects with the same title get separate bands", () => {
    const sessions = makeSessions([
      { name: "a" },
      { name: "b" },
    ]);
    sessions[0]!.projectId = "platform";
    sessions[0]!.projectName = "platform";
    sessions[1]!.projectId = "platform-2";
    sessions[1]!.projectName = "platform";
    const bands = orderSessions({
      sessions,
      sortInfos: makeSortInfos(sessions),
      groupMode: "project",
      sortMode: "name",
      filterMode: "all",
      pinnedSessions: new Set(),
      parkedSessions: new Set(),
      workflowByName: new Map(),
      includeParked: true,
    });
    const groups = bands.filter((b) => b.kind === "group");
    expect(groups).toHaveLength(2);
    expect(new Set(groups.map((g) => g.key)).size).toBe(2);
  });

  test("the key is namespaced on the id, which is what ghosts bucket on", () => {
    const sessions = makeSessions([{ name: "a" }]);
    sessions[0]!.projectId = "platform";
    sessions[0]!.projectName = "platform";
    const bands = orderSessions({
      sessions,
      sortInfos: makeSortInfos(sessions),
      groupMode: "project",
      sortMode: "name",
      filterMode: "all",
      pinnedSessions: new Set(),
      parkedSessions: new Set(),
      workflowByName: new Map(),
      includeParked: true,
    });
    expect(bands.find((b) => b.kind === "group")?.key).toBe("project:id:platform");
  });

  // A persisted collapse state must survive Projects arriving.
  test("a session with no Project keeps the label key it always had", () => {
    const sessions = makeSessions([{ name: "a", repoName: "alpha" }]);
    const bands = orderSessions({
      sessions,
      sortInfos: makeSortInfos(sessions),
      groupMode: "project",
      sortMode: "name",
      filterMode: "all",
      pinnedSessions: new Set(),
      parkedSessions: new Set(),
      workflowByName: new Map(),
      includeParked: true,
    });
    expect(bands.find((b) => b.kind === "group")?.key).toBe("project:alpha");
  });
});

describe("owner grouping (group=crew)", () => {
  const owned = () =>
    makeSessions([
      { name: "mine-b" },
      { name: "ALF-123", managedBy: "groundcrew" },
      { name: "mine-a" },
    ]);

  const order = (sessions: SessionInfo[]) =>
    orderSessions({
      sessions,
      sortInfos: makeSortInfos(sessions),
      groupMode: "crew",
      sortMode: "name",
      filterMode: "all",
      pinnedSessions: new Set(),
      parkedSessions: new Set(),
      workflowByName: new Map(),
      includeParked: true,
    });

  test("bands Groundcrew-managed work above your own, both with headers", () => {
    const sessions = owned();
    const bands = order(sessions);

    expect(bands.map((b) => b.kind)).toEqual(["group", "group"]);
    expect(bands.map((b) => b.label)).toEqual(["Groundcrew", "Yours"]);
    expect(idsOf(sessions, bands[0]!.indices)).toEqual(["$1"]);
    // Members still sort by sortMode within the band.
    expect(idsOf(sessions, bands[1]!.indices)).toEqual(["$2", "$0"]);
  });

  test("keys the bands per axis so collapse state cannot collide with a project", () => {
    const bands = order(owned());
    expect(bands.map((b) => b.key)).toEqual(["crew:groundcrew", "crew:none"]);
  });

  test("draws a header even when nothing is managed, so the axis is never inert", () => {
    // With the human half left in the flat remainder this would be
    // indistinguishable from group=none while the header chip read "Owner".
    const sessions = makeSessions([{ name: "solo" }]);
    const bands = order(sessions);
    expect(bands.map((b) => b.kind)).toEqual(["group"]);
    expect(bands[0]!.label).toBe("Yours");
  });

  test("pinned and parked still outrank ownership", () => {
    const sessions = makeSessions([
      { name: "pinned-crew", managedBy: "groundcrew" },
      { name: "parked-crew", managedBy: "groundcrew" },
      { name: "live-crew", managedBy: "groundcrew" },
    ]);
    const bands = orderSessions({
      sessions,
      sortInfos: makeSortInfos(sessions),
      groupMode: "crew",
      sortMode: "name",
      filterMode: "all",
      pinnedSessions: new Set(["pinned-crew"]),
      parkedSessions: new Set(["parked-crew"]),
      workflowByName: new Map(),
      includeParked: true,
    });
    expect(bands.map((b) => b.kind)).toEqual(["pinned", "group", "parked"]);
    expect(idsOf(sessions, bands[1]!.indices)).toEqual(["$2"]);
  });
});
