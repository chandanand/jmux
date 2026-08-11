/**
 * Tile lifecycle for the Command Center grid.
 *
 * A tile is a session, never a pane: `TileKey` is `session:$id` and only that,
 * so the pane a tile displays is mutable backing state that no key, order or
 * plan depends on.
 *
 * The rendered set and the client set are deliberately different. Membership is
 * derived from live agent state, so a session flipping running→complete leaves
 * the set on a poll cadence; tearing its client down immediately would attach,
 * detach and toggle the user's real window zoom every time an agent finished a
 * turn. A tile that leaves membership is therefore *retained* — its client, pty
 * and ScreenBridge stay alive, unrendered — until its grace expires or the cap
 * needs the slot.
 */

export type TileKey = `session:${string}`;

/** The one construction of a tile key. */
export function tileKeyForSession(sessionId: string): TileKey {
  return `session:${sessionId}`;
}

/** The session id behind a tile key. */
export function sessionIdForTileKey(key: TileKey): string {
  return key.slice("session:".length);
}

/**
 * A tile in the rendered set.
 *
 * `forced` travels here, on the *active* side, because the cap has to break its
 * own ties: with `active = [A, B]`, no retained clients and `maxClients: 1`, a
 * planner given bare keys receives identical input whether A or B is pinned.
 */
export interface ActiveTile {
  key: TileKey;
  /** Force-on (an explicit pin) — kept ahead of derived members under overflow. */
  forced: boolean;
}

/** Retained tiles carry only when they left membership; the planner invents no time. */
export interface RetainedTile {
  lastSeenAt: number;
}

export interface TilePlanInput {
  /** Rendered set, in render order. */
  active: readonly ActiveTile[];
  /**
   * Clients that exist right now. Not derivable from the other fields: an
   * active tile whose client already exists appears in neither `active` minus
   * `retained` nor `retained`, so without this two consecutive reconciles with
   * identical membership would be identical input and `spawn` could not answer
   * "yes" the first time and "no" the second. `retained ⊆ live` by construction.
   */
  live: ReadonlySet<TileKey>;
  /** Live tiles that have left membership, with the moment they left. */
  retained: ReadonlyMap<TileKey, RetainedTile>;
  now: number;
  /** How long a tile that left membership keeps its client. */
  graceMs: number;
  /** Cap on clients — active and grace-retained together, or it is not a cap. */
  maxClients: number;
}

export interface TilePlan {
  spawn: TileKey[];
  /** May be shorter than `active` under overflow. */
  render: TileKey[];
  teardown: TileKey[];
  /** Active tiles the cap refused — reported in the strip, never silent. */
  droppedActive: number;
  /** Deadline to arm a timer on: a grace must expire with no tmux traffic. */
  nextExpiryAt: number | null;
}

/**
 * Decide what to spawn, render and tear down.
 *
 * The order below is the contract, and admission precedes spawning: a `spawn`
 * computed before the cap attaches real tmux clients for tiles that are never
 * rendered.
 *
 *   1. admitted     = cap(active, maxClients)   — forced first, then render order
 *   2. render       = admitted
 *   3. droppedActive= active.length - admitted.length
 *   4. spawn        = admitted not already live
 *   5. keptRetained = unexpired retained, most-recently-seen first, within the
 *                     budget the admitted set leaves
 *   6. teardown     = live \ (admitted ∪ keptRetained)
 *   7. nextExpiryAt = the earliest grace deadline still standing
 *
 * Step 6 subtracts `admitted` and not `active`, so an active tile the cap
 * refuses releases its client rather than becoming an invisible leak; and step 1
 * taking its share first is what lets a newly active tile evict the
 * least-recently-seen retained client instead of waiting out its grace.
 */
export function planTiles(input: TilePlanInput): TilePlan {
  const { active, live, retained, now, graceMs } = input;
  const maxClients = Math.max(0, input.maxClients);

  // 1 — admission. Forced wins the scarce slots; render order breaks the rest.
  // Admitted keeps *render* order: the grid must not rearrange itself the
  // moment a tile count crosses the cap.
  const ranked = active.map((tile, index) => ({ tile, index }));
  ranked.sort((a, b) => {
    if (a.tile.forced !== b.tile.forced) return a.tile.forced ? -1 : 1;
    return a.index - b.index;
  });
  const admittedIndexes = new Set(ranked.slice(0, maxClients).map((r) => r.index));
  const admitted = active.filter((_, index) => admittedIndexes.has(index)).map((t) => t.key);
  const admittedSet = new Set(admitted);

  // 2, 3
  const render = admitted;
  const droppedActive = active.length - admitted.length;

  // 4 — spawn only what was admitted and has no client yet.
  const spawn = admitted.filter((key) => !live.has(key));

  // 5 — retained tiles keep their clients while unexpired, newest first, but
  //     only within the budget the admitted set leaves. Active always outranks
  //     retained.
  const budget = Math.max(0, maxClients - admitted.length);
  const keptRetained = [...retained.entries()]
    .filter(([key]) => !admittedSet.has(key))
    .filter(([, r]) => now - r.lastSeenAt < graceMs)
    .sort((a, b) => b[1].lastSeenAt - a[1].lastSeenAt)
    .slice(0, budget);
  const keptSet = new Set(keptRetained.map(([key]) => key));

  // 6
  const teardown = [...live].filter((key) => !admittedSet.has(key) && !keptSet.has(key));

  // 7
  let nextExpiryAt: number | null = null;
  for (const [, r] of keptRetained) {
    const deadline = r.lastSeenAt + graceMs;
    if (nextExpiryAt === null || deadline < nextExpiryAt) nextExpiryAt = deadline;
  }

  return { spawn, render, teardown, droppedActive, nextExpiryAt };
}
