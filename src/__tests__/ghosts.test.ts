import { describe, test, expect } from "bun:test";
import {
  selectGhosts, ghostCapValue, formatGhostCap, editGhostCap, parseGhostCap, stepGhostCap,
  ghostProjectBand, UNASSIGNED_GHOST_BAND,
  GHOST_CAP_MAX, type GhostIssue, type GhostQueue,
} from "../ghosts";

const issue = (over: Partial<GhostIssue> & { id: string }): GhostIssue => ({
  identifier: over.id.toUpperCase(),
  title: `title ${over.id}`,
  hasSession: false,
  inactive: false,
  ...over,
});

const queue = (viewId: string, rank: number, ids: Array<GhostIssue | string>): GhostQueue => ({
  viewId,
  label: viewId.charAt(0).toUpperCase() + viewId.slice(1),
  rank,
  issues: ids.map((i) => (typeof i === "string" ? issue({ id: i }) : i)),
});

const ids = (out: ReturnType<typeof selectGhosts>): string[] => out.map((g) => g.issueId);

describe("selectGhosts", () => {
  test("carries the fields a row needs, tagged with its stage", () => {
    const out = selectGhosts([queue("todo", 0, [issue({ id: "a", identifier: "ENG-1", title: "fix it" })])], 5);
    expect(out).toEqual([{
      issueId: "a", identifier: "ENG-1", title: "fix it",
      stageId: "todo", stageLabel: "Todo", rank: 0,
    }]);
  });

  test("orders by stage rank, not by the order queues were passed in", () => {
    const out = selectGhosts([queue("later", 2, ["c"]), queue("first", 0, ["a"]), queue("mid", 1, ["b"])], 5);
    expect(ids(out)).toEqual(["a", "b", "c"]);
  });

  test("keeps each queue's own order — the top of the band is the top of the tab", () => {
    expect(ids(selectGhosts([queue("todo", 0, ["a", "b", "c"])], 5))).toEqual(["a", "b", "c"]);
  });

  test("skips issues that already have a session", () => {
    const out = selectGhosts([queue("todo", 0, ["a", issue({ id: "b", hasSession: true }), "c"])], 5);
    expect(ids(out)).toEqual(["a", "c"]);
  });

  test("skips done and parked issues, which would otherwise never age out", () => {
    const out = selectGhosts([queue("todo", 0, ["a", issue({ id: "b", inactive: true })])], 5);
    expect(ids(out)).toEqual(["a"]);
  });

  test("deduplicates across queues, highest rank winning", () => {
    // A queue with no `states` falls back to a plain "assigned" filter, so the
    // same issue legitimately appears in two queues.
    const out = selectGhosts([queue("all", 1, ["a", "b"]), queue("urgent", 0, ["b"])], 5);
    expect(ids(out)).toEqual(["b", "a"]);
  });

  test("caps per stage, not in total — one number, one meaning on both placements", () => {
    // It briefly capped the total on the flat placement and per stage on the
    // banded one, so "3" meant three altogether or three each depending on a
    // grouping mode the setting never mentioned.
    const out = selectGhosts([queue("one", 0, ["a", "b", "c"]), queue("two", 1, ["d", "e", "f"])], 2);
    expect(ids(out)).toEqual(["a", "b", "d", "e"]);
  });

  test("a cap of zero is how the feature is off — no second boolean to disagree", () => {
    expect(selectGhosts([queue("todo", 0, ["a"])], 0)).toEqual([]);
    expect(selectGhosts([queue("todo", 0, ["a"])], -1)).toEqual([]);
  });

  test("an infinite cap is 'all' — every eligible issue, still filtered and deduped", () => {
    const out = selectGhosts([
      queue("urgent", 0, ["a", issue({ id: "b", hasSession: true }), "c"]),
      queue("todo", 1, ["c", "d", issue({ id: "e", inactive: true }), "f"]),
    ], Infinity);
    expect(ids(out)).toEqual(["a", "c", "d", "f"]);
  });

  test("an infinite cap over a large queue returns all of it", () => {
    const many = Array.from({ length: 250 }, (_, i) => `i${i}`);
    expect(selectGhosts([queue("todo", 0, many)], Infinity)).toHaveLength(250);
  });

  test("filtered-out issues don't consume cap slots", () => {
    // The cap counts rows drawn, not candidates considered — otherwise a queue
    // whose head is all started work would show an empty band.
    const out = selectGhosts([
      queue("todo", 0, [issue({ id: "a", hasSession: true }), issue({ id: "b", inactive: true }), "c", "d"]),
    ], 2);
    expect(ids(out)).toEqual(["c", "d"]);
  });

  test("no queues, or empty ones, produce no rows", () => {
    expect(selectGhosts([], 5)).toEqual([]);
    expect(selectGhosts([queue("todo", 0, [])], 5)).toEqual([]);
  });
});

describe("selectGhosts — stage tagging", () => {
  test("tags each row with the band it belongs in", () => {
    const out = selectGhosts(
      [queue("todo", 0, [issue({ id: "a", identifier: "ENG-1", title: "fix" })])], 5);
    expect(out).toEqual([{
      issueId: "a", identifier: "ENG-1", title: "fix",
      stageId: "todo", stageLabel: "Todo", rank: 0,
    }]);
  });

  test("caps per stage, so a busy stage can't starve the ones below it", () => {
    const out = selectGhosts([
      queue("urgent", 0, ["a", "b", "c", "d"]),
      queue("todo", 1, ["e", "f", "g"]),
    ], 2);
    expect(ids(out)).toEqual(["a", "b", "e", "f"]);
  });

  test("still skips started and done work, and those don't consume a stage's slots", () => {
    const out = selectGhosts([
      queue("todo", 0, [
        issue({ id: "a", hasSession: true }), issue({ id: "b", inactive: true }), "c", "d",
      ]),
    ], 2);
    expect(ids(out)).toEqual(["c", "d"]);
  });

  test("dedupes across stages so one issue never appears under two bands", () => {
    const out = selectGhosts([
      queue("all", 1, ["a", "b"]),
      queue("urgent", 0, ["b"]),
    ], 5);
    expect(ids(out)).toEqual(["b", "a"]);
    // It lands under the highest-ranked stage that claimed it.
    expect(out.find((g) => g.issueId === "b")?.stageId).toBe("urgent");
  });

  test("emits stages in rank order regardless of input order", () => {
    const out = selectGhosts([
      queue("later", 2, ["c"]), queue("first", 0, ["a"]), queue("mid", 1, ["b"]),
    ], 5);
    expect(out.map((g) => g.stageId)).toEqual(["first", "mid", "later"]);
  });

  test("an infinite cap takes every eligible issue in every stage", () => {
    const out = selectGhosts([
      queue("a", 0, Array.from({ length: 120 }, (_, i) => `x${i}`)),
      queue("b", 1, Array.from({ length: 80 }, (_, i) => `y${i}`)),
    ], Infinity);
    expect(out).toHaveLength(200);
  });

  test("off is off, on either placement", () => {
    expect(selectGhosts([queue("todo", 0, ["a"])], 0)).toEqual([]);
  });
});

describe("the ghost cap", () => {
  test("reads a count, 'all', and off", () => {
    expect(ghostCapValue(null)).toBe(0);
    expect(ghostCapValue(0)).toBe(0);
    expect(ghostCapValue(7)).toBe(7);
    expect(ghostCapValue("all")).toBe(Infinity);
    expect(ghostCapValue(" ALL ")).toBe(Infinity);
  });

  test("anything a hand-edited config could hold reads as off, never throws", () => {
    for (const raw of [undefined, true, "yes", {}, [], -3, NaN, Infinity]) {
      expect(ghostCapValue(raw)).toBe(0);
    }
    // A fractional count floors rather than being rejected outright.
    expect(ghostCapValue(2.9)).toBe(2);
  });

  test("displays as prose but edits as input — the two are not the same string", () => {
    expect(formatGhostCap(null)).toBe("never");
    expect(formatGhostCap(1)).toBe("1 per stage");
    expect(formatGhostCap(5)).toBe("5 per stage");
    expect(formatGhostCap("all")).toBe("all");
    expect(editGhostCap(null)).toBe("");
    expect(editGhostCap(5)).toBe("5");
    expect(editGhostCap("all")).toBe("all");
  });

  test("parses what a person would type", () => {
    expect(parseGhostCap("")).toBeNull();
    expect(parseGhostCap("0")).toBeNull();
    expect(parseGhostCap("-3")).toBeNull();
    expect(parseGhostCap("banana")).toBeNull();
    expect(parseGhostCap("7")).toBe(7);
    expect(parseGhostCap("5 issues")).toBe(5);   // leaving the unit in still works
    expect(parseGhostCap("ALL")).toBe("all");
    expect(parseGhostCap("  all  ")).toBe("all");
  });

  test("every stored form survives a JSON round-trip", () => {
    // "all" is a literal precisely because Infinity stringifies to null, which
    // is this field's "off" — the setting would switch itself off on save.
    for (const stored of [null, 1, 42, "all"] as const) {
      expect(JSON.parse(JSON.stringify({ v: stored })).v).toEqual(stored);
    }
    expect(JSON.parse(JSON.stringify({ v: Infinity })).v).toBeNull();
  });

  test("steps never → 1 → 2, and back down again", () => {
    expect(stepGhostCap(null, 1)).toBe(1);
    expect(stepGhostCap(1, 1)).toBe(2);
    expect(stepGhostCap(2, -1)).toBe(1);
    expect(stepGhostCap(1, -1)).toBeNull();
  });

  test("the ends are adjacent, so 'all' is one press from 'never'", () => {
    expect(stepGhostCap(null, -1)).toBe("all");
    expect(stepGhostCap("all", 1)).toBeNull();
    expect(stepGhostCap(GHOST_CAP_MAX, 1)).toBe("all");
    expect(stepGhostCap("all", -1)).toBe(GHOST_CAP_MAX);
  });

  test("a typed count above the ladder enters at its top rather than snapping off", () => {
    expect(stepGhostCap(500, -1)).toBe(GHOST_CAP_MAX - 1);
    expect(stepGhostCap(500, 1)).toBe("all");
  });

  test("stepping is closed over its own output — 101 rungs return to the start", () => {
    let v: ReturnType<typeof stepGhostCap> = null;
    for (let i = 0; i < GHOST_CAP_MAX + 2; i++) v = stepGhostCap(v, 1);
    expect(v).toBeNull();
    const seen = new Set<string>();
    let w: ReturnType<typeof stepGhostCap> = null;
    for (let i = 0; i < GHOST_CAP_MAX + 2; i++) { seen.add(String(w)); w = stepGhostCap(w, 1); }
    expect(seen.size).toBe(GHOST_CAP_MAX + 2); // every rung distinct: never, 1..99, all
  });

  test("garbage steps onto the ladder rather than sticking", () => {
    expect(stepGhostCap("banana", 1)).toBe(1);
    expect(stepGhostCap(undefined, 1)).toBe(1);
  });
});

describe("ghost Project outcomes", () => {
  const issue = (id: string, project?: any) => ({
    id, identifier: id.toUpperCase(), title: `t-${id}`,
    hasSession: false, inactive: false,
    ...(project ? { project } : {}),
  });

  test("a resolved Project rides along on the entry", () => {
    const out = selectGhosts(
      [{ viewId: "v", label: "To do", rank: 0, issues: [issue("a", { kind: "resolved", id: "api", title: "API" })] }],
      5,
    );
    expect(out[0].project).toEqual({ kind: "resolved", id: "api", title: "API" });
  });

  test("an entry with no routing carries no project", () => {
    const out = selectGhosts([{ viewId: "v", label: "To do", rank: 0, issues: [issue("a")] }], 5);
    expect(out[0].project).toBeUndefined();
  });

  test("a resolved ghost bands under its Project's title", () => {
    expect(ghostProjectBand({
      issueId: "a", identifier: "A", title: "t",
      project: { kind: "resolved", id: "api", title: "API" },
    })).toBe("API");
  });

  // Hiding unroutable work would make a misconfigured team map silently
  // shorten the ghost list — the original failure in a new costume.
  test("unclaimed and ambiguous ghosts band together rather than vanishing", () => {
    expect(ghostProjectBand({ issueId: "a", identifier: "A", title: "t", project: { kind: "unclaimed" } }))
      .toBe(UNASSIGNED_GHOST_BAND);
    expect(ghostProjectBand({ issueId: "b", identifier: "B", title: "t", project: { kind: "ambiguous" } }))
      .toBe(UNASSIGNED_GHOST_BAND);
  });

  test("a ghost with no routing at all also bands as unassigned", () => {
    expect(ghostProjectBand({ issueId: "a", identifier: "A", title: "t" }))
      .toBe(UNASSIGNED_GHOST_BAND);
  });
});
