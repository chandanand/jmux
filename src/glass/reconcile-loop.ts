// The Command Center's reconcile scheduler.
//
// Reconciliation reads tmux asynchronously, so "one run per tick" is not a
// debounce problem — it is a lost-update problem. An invalidation that arrives
// after a run has taken its snapshot but before it applies describes a world
// the run in flight cannot see, and swallowing it leaves a tile stale until
// something unrelated happens to move.
//
// Three flags, and the order they are written in is the whole contract:
//
//   scheduled  a run is queued for the trailing edge of this tick's burst
//   inFlight   a run is between its snapshot and its apply
//   dirty      an invalidation arrived while a run was in flight
//
// `dirty` is cleared **before** the snapshot, never after: clearing it
// afterwards discards every event that arrived during the query, which is the
// exact window this exists to cover. The rescheduling lives in `finally`, so a
// read that throws reschedules instead of leaving `inFlight` stuck true and the
// grid frozen for the life of the process.

export interface ReconcileLoopOptions {
  /** Takes the snapshot and applies it. Rejections are reported, not fatal. */
  run: () => Promise<void>;
  /** Where a failed run is reported. */
  onError: (error: unknown) => void;
  /**
   * How a queued run is deferred. Defaults to `queueMicrotask` — the trailing
   * edge of the current tick, so a burst of invalidations from one control-mode
   * notification costs one read. Injectable so tests can drive it by hand.
   */
  schedule?: (fn: () => void) => void;
}

export class ReconcileLoop {
  private readonly opts: ReconcileLoopOptions;
  private readonly schedule: (fn: () => void) => void;

  private scheduled = false;
  private inFlight = false;
  private dirty = false;

  /** Callers awaiting a run that has not started yet. */
  private pendingWaiters: Array<() => void> = [];
  /** Callers awaiting the run currently in flight. */
  private runWaiters: Array<() => void> = [];

  constructor(opts: ReconcileLoopOptions) {
    this.opts = opts;
    this.schedule = opts.schedule ?? ((fn) => queueMicrotask(fn));
  }

  /** Something that can change the grid happened. Coalesces within a tick. */
  invalidate(): void {
    if (this.inFlight) {
      this.dirty = true;
      return;
    }
    if (this.scheduled) return;
    this.scheduled = true;
    this.schedule(() => void this.runOnce());
  }

  /**
   * Invalidate and resolve once a run that started *after* this call has
   * applied. Used where the caller needs the answer on screen in the same
   * breath — opening the grid, which would otherwise paint its empty state for
   * a frame before the first read came back.
   */
  flush(): Promise<void> {
    this.invalidate();
    return new Promise<void>((resolve) => this.pendingWaiters.push(resolve));
  }

  private async runOnce(): Promise<void> {
    this.scheduled = false;
    this.inFlight = true;
    this.dirty = false; // cleared BEFORE the snapshot
    this.runWaiters = this.pendingWaiters;
    this.pendingWaiters = [];
    try {
      await this.opts.run();
    } catch (error) {
      this.opts.onError(error);
    } finally {
      this.inFlight = false;
      const waiters = this.runWaiters;
      this.runWaiters = [];
      for (const resolve of waiters) resolve();
      if (this.dirty) {
        this.dirty = false;
        this.scheduled = true;
        this.schedule(() => void this.runOnce());
      }
    }
  }
}
