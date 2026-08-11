import { describe, test, expect } from "bun:test";
import {
  planTiles,
  tileKeyForSession,
  sessionIdForTileKey,
  type ActiveTile,
  type TileKey,
  type TilePlanInput,
} from "../../glass/tile-plan";

const k = (sessionId: string): TileKey => tileKeyForSession(sessionId);

const active = (...entries: (string | [string, boolean])[]): ActiveTile[] =>
  entries.map((e) =>
    typeof e === "string"
      ? { key: k(e), forced: false }
      : { key: k(e[0]), forced: e[1] },
  );

const NOW = 1_000_000;

const plan = (input: Partial<TilePlanInput>) =>
  planTiles({
    active: [],
    live: new Set(),
    retained: new Map(),
    now: NOW,
    graceMs: 30_000,
    maxClients: 12,
    ...input,
  });

describe("tile keys", () => {
  test("a tile is a session and nothing else", () => {
    expect(k("$2")).toBe("session:$2");
    expect(sessionIdForTileKey(k("$2"))).toBe("$2");
  });
});

describe("planTiles", () => {
  test("spawns admitted tiles that have no client yet", () => {
    const p = plan({ active: active("$1", "$2"), live: new Set([k("$1")]) });
    expect(p.spawn).toEqual([k("$2")]);
    expect(p.render).toEqual([k("$1"), k("$2")]);
    expect(p.teardown).toEqual([]);
    expect(p.droppedActive).toBe(0);
  });

  test("tears down a live tile that left membership and was never retained", () => {
    const p = plan({ active: active("$1"), live: new Set([k("$1"), k("$9")]) });
    expect(p.teardown).toEqual([k("$9")]);
    expect(p.spawn).toEqual([]);
  });

  // Replaces the old "keeps warm tiles from other tabs" case. Warmth is no
  // longer unbounded: a tile that leaves the rendered set keeps its client for
  // the grace window and is collected after it, so membership churning on a
  // poll cadence cannot attach, detach and toggle a window's zoom.
  test("retains a tile that left membership until its grace expires", () => {
    const retained = new Map([[k("$9"), { lastSeenAt: NOW - 10_000 }]]);
    const live = new Set([k("$1"), k("$9")]);

    const within = plan({ active: active("$1"), live, retained });
    expect(within.teardown).toEqual([]);
    expect(within.render).toEqual([k("$1")]); // retained, not rendered
    expect(within.nextExpiryAt).toBe(NOW - 10_000 + 30_000);

    const after = plan({ active: active("$1"), live, retained, now: NOW + 25_000 });
    expect(after.teardown).toEqual([k("$9")]);
    expect(after.nextExpiryAt).toBeNull();
  });

  test("a returning tile is a survivor, not a spawn", () => {
    const p = plan({ active: active("$1"), live: new Set([k("$1")]) });
    expect(p.spawn).toEqual([]);
    expect(p.render).toEqual([k("$1")]);
  });

  describe("the client cap", () => {
    test("keeps force-on tiles first but draws them in render order", () => {
      const p = plan({ active: active("$1", ["$2", true], "$3"), maxClients: 2 });
      // $2 is pinned so it survives; $1 fills the remaining slot on render
      // order. The grid must not rearrange itself the moment the count crosses
      // the cap, so admission order is membership order.
      expect(p.render).toEqual([k("$1"), k("$2")]);
      expect(p.droppedActive).toBe(1);
    });

    test("reports the refused tiles rather than dropping them silently", () => {
      const p = plan({ active: active("$1", "$2", "$3", "$4"), maxClients: 1 });
      expect(p.render).toEqual([k("$1")]);
      expect(p.droppedActive).toBe(3);
    });

    test("releases a live tile it stops admitting", () => {
      const p = plan({
        active: active(["$2", true], "$1"),
        live: new Set([k("$1"), k("$2")]),
        maxClients: 1,
      });
      // $1 is active but refused: teardown subtracts `admitted`, not `active`,
      // so it releases its client instead of leaking one that never draws.
      expect(p.render).toEqual([k("$2")]);
      expect(p.teardown).toEqual([k("$1")]);
      expect(p.spawn).toEqual([]);
    });

    test("counts retained clients against the same budget", () => {
      const retained = new Map([
        [k("$8"), { lastSeenAt: NOW - 1_000 }],
        [k("$9"), { lastSeenAt: NOW - 2_000 }],
      ]);
      const p = plan({
        active: active("$1"),
        live: new Set([k("$1"), k("$8"), k("$9")]),
        retained,
        maxClients: 2,
      });
      // One slot left after the active tile: the most recently seen keeps it.
      expect(p.teardown).toEqual([k("$9")]);
      expect(p.nextExpiryAt).toBe(NOW - 1_000 + 30_000);
    });

    test("a newly active tile evicts a retained one rather than waiting", () => {
      const retained = new Map([[k("$9"), { lastSeenAt: NOW }]]);
      const p = plan({
        active: active("$1", "$2"),
        live: new Set([k("$9")]),
        retained,
        maxClients: 2,
      });
      expect(p.spawn).toEqual([k("$1"), k("$2")]);
      expect(p.teardown).toEqual([k("$9")]);
      expect(p.nextExpiryAt).toBeNull();
    });
  });

  test("nextExpiryAt is the earliest deadline still standing", () => {
    const retained = new Map([
      [k("$8"), { lastSeenAt: NOW - 5_000 }],
      [k("$9"), { lastSeenAt: NOW - 1_000 }],
    ]);
    const p = plan({ live: new Set([k("$8"), k("$9")]), retained });
    expect(p.teardown).toEqual([]);
    expect(p.nextExpiryAt).toBe(NOW - 5_000 + 30_000);
  });

  test("no retained tiles means no timer to arm", () => {
    const p = plan({ active: active("$1"), live: new Set([k("$1")]) });
    expect(p.nextExpiryAt).toBeNull();
  });
});
