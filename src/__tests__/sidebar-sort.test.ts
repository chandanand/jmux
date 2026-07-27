import { test, expect, describe } from "bun:test";
import {
  GROUP_MODES,
  SORT_MODES,
  FILTER_MODES,
  cycleGroup,
  cycleSort,
  cycleFilter,
  matchesFilter,
  sortIndices,
  statusRank,
  statusGroupLabel,
  groupModeLabel,
  sortModeLabel,
  filterModeLabel,
  migrateLegacySort,
  type SessionSortInfo,
} from "../sidebar-sort";

describe("cycle", () => {
  test("group wraps around the mode list", () => {
    expect(cycleGroup("none")).toBe("project");
    expect(cycleGroup("project")).toBe("status");
    expect(cycleGroup("status")).toBe("stage");
    expect(cycleGroup("stage")).toBe("none"); // wraps
    for (const m of GROUP_MODES) expect(GROUP_MODES).toContain(cycleGroup(m));
  });

  test("sort wraps around the mode list", () => {
    expect(cycleSort("name")).toBe("activity");
    expect(cycleSort("activity")).toBe("status");
    expect(cycleSort("status")).toBe("name"); // wraps
    for (const m of SORT_MODES) expect(SORT_MODES).toContain(cycleSort(m));
  });

  test("filter wraps around the filter list", () => {
    expect(cycleFilter("all")).toBe("attention");
    expect(cycleFilter("attention")).toBe("active");
    expect(cycleFilter("active")).toBe("all"); // wraps
    for (const f of FILTER_MODES) expect(FILTER_MODES).toContain(cycleFilter(f));
  });

  test("labels are human-readable and distinct", () => {
    const groupLabels = GROUP_MODES.map(groupModeLabel);
    expect(new Set(groupLabels).size).toBe(groupLabels.length);
    const sortLabels = SORT_MODES.map(sortModeLabel);
    expect(new Set(sortLabels).size).toBe(sortLabels.length);
    expect(groupModeLabel("status")).toBe("by status");
    expect(groupModeLabel("stage")).toBe("by workflow stage");
    expect(sortModeLabel("name")).toBe("by name");
    expect(filterModeLabel("attention")).toBe("needs you");
  });
});

describe("status ordering", () => {
  test("rank runs needs-you first, idle last", () => {
    expect(statusRank("waiting")).toBeLessThan(statusRank("running"));
    expect(statusRank("running")).toBeLessThan(statusRank("activity"));
    expect(statusRank("activity")).toBeLessThan(statusRank("complete"));
    expect(statusRank("complete")).toBeLessThan(statusRank("idle"));
  });

  test("group headers reuse the row/rollup vocabulary and are distinct", () => {
    expect(statusGroupLabel("waiting")).toBe("Needs you");
    expect(statusGroupLabel("running")).toBe("Running");
    expect(statusGroupLabel("activity")).toBe("Active");
    expect(statusGroupLabel("complete")).toBe("Done");
    expect(statusGroupLabel("idle")).toBe("Idle");
    const all = (["waiting", "running", "activity", "complete", "idle"] as const).map(statusGroupLabel);
    expect(new Set(all).size).toBe(all.length);
  });
});

describe("migrateLegacySort", () => {
  test("maps each pre-split value onto the two axes without loss", () => {
    expect(migrateLegacySort("project")).toEqual({ groupBy: "project", sortBy: "name" });
    expect(migrateLegacySort("status")).toEqual({ groupBy: "none", sortBy: "status" });
    expect(migrateLegacySort("activity")).toEqual({ groupBy: "none", sortBy: "activity" });
    expect(migrateLegacySort("name")).toEqual({ groupBy: "none", sortBy: "name" });
  });
});

describe("matchesFilter", () => {
  test("all passes every status", () => {
    for (const s of ["waiting", "running", "activity", "complete", "idle"] as const) {
      expect(matchesFilter(s, "all")).toBe(true);
    }
  });
  test("attention passes only waiting", () => {
    expect(matchesFilter("waiting", "attention")).toBe(true);
    expect(matchesFilter("running", "attention")).toBe(false);
    expect(matchesFilter("complete", "attention")).toBe(false);
    expect(matchesFilter("activity", "attention")).toBe(false);
    expect(matchesFilter("idle", "attention")).toBe(false);
  });
  test("active passes waiting or running", () => {
    expect(matchesFilter("waiting", "active")).toBe(true);
    expect(matchesFilter("running", "active")).toBe(true);
    expect(matchesFilter("activity", "active")).toBe(false);
    expect(matchesFilter("complete", "active")).toBe(false);
    expect(matchesFilter("idle", "active")).toBe(false);
  });
});

describe("sortIndices", () => {
  // index → info; indices are the array positions we sort.
  const make = (infos: SessionSortInfo[]) => {
    const lookup = (i: number) => infos[i]!;
    return { infos, lookup };
  };

  test("status: rank order (waiting → running → activity → complete → idle)", () => {
    const { lookup } = make([
      { name: "idle-one", status: "idle", lastActivity: 100 },
      { name: "waiting-one", status: "waiting", lastActivity: 100 },
      { name: "complete-one", status: "complete", lastActivity: 100 },
      { name: "running-one", status: "running", lastActivity: 100 },
      { name: "activity-one", status: "activity", lastActivity: 100 },
    ]);
    // indices 0..4 in scrambled status order → sorted to rank order
    expect(sortIndices([0, 1, 2, 3, 4], lookup, "status")).toEqual([1, 3, 4, 2, 0]);
  });

  test("status: within a tier, most-recently-active first", () => {
    const { lookup } = make([
      { name: "b", status: "waiting", lastActivity: 10 },
      { name: "a", status: "waiting", lastActivity: 50 }, // more recent
    ]);
    // a (recent) before b, despite a>b alphabetically
    expect(sortIndices([0, 1], lookup, "status")).toEqual([1, 0]);
  });

  test("status: equal recency within a tier breaks by name", () => {
    const { lookup } = make([
      { name: "zebra", status: "waiting", lastActivity: 10 },
      { name: "apple", status: "waiting", lastActivity: 10 },
    ]);
    expect(sortIndices([0, 1], lookup, "status")).toEqual([1, 0]); // apple first
  });

  test("activity: most-recently-active first regardless of status", () => {
    const { lookup } = make([
      { name: "old-waiting", status: "waiting", lastActivity: 10 },
      { name: "new-idle", status: "idle", lastActivity: 90 },
    ]);
    expect(sortIndices([0, 1], lookup, "activity")).toEqual([1, 0]);
  });

  test("name: A–Z regardless of status or recency", () => {
    const { lookup } = make([
      { name: "gamma", status: "waiting", lastActivity: 99 },
      { name: "alpha", status: "idle", lastActivity: 1 },
      { name: "beta", status: "running", lastActivity: 50 },
    ]);
    expect(sortIndices([0, 1, 2], lookup, "name")).toEqual([1, 2, 0]);
  });

  test("does not mutate the input array", () => {
    const { lookup } = make([
      { name: "b", status: "idle", lastActivity: 1 },
      { name: "a", status: "idle", lastActivity: 1 },
    ]);
    const input = [0, 1];
    sortIndices(input, lookup, "name");
    expect(input).toEqual([0, 1]);
  });
});
