import type { AdapterSet } from "./registry";
import type { CodeHostAdapter, IssueTrackerAdapter } from "./types";

/**
 * The one mutable adapter set, plus the epoch every async consumer checks.
 *
 * Adapters were a module-scope `const` whose fields nothing ever reassigned, so
 * changing the tracker in settings wrote config that did nothing until the next
 * launch — the first thing a new user hit. Making them swappable is only half
 * the problem: every in-flight request holds a reference to the adapter it
 * started with, and its completion would otherwise write one workspace's data
 * into another's caches. The epoch is how a completion asks "am I still the
 * current world?" before it mutates anything.
 *
 * Deliberately exposes `codeHost` / `issueTracker` as getters: `main.ts` reads
 * `adapters.issueTracker` in dozens of places, and this keeps all of them
 * correct with no edit.
 */
export class ActiveAdapters {
  private set: AdapterSet;
  private _epoch = 0;

  constructor(initial: AdapterSet) {
    this.set = initial;
  }

  get epoch(): number { return this._epoch; }
  get codeHost(): CodeHostAdapter | null { return this.set.codeHost; }
  get issueTracker(): IssueTrackerAdapter | null { return this.set.issueTracker; }

  /** True while `epoch` is the world the caller started in. */
  isCurrent(epoch: number): boolean {
    return epoch === this._epoch;
  }

  /**
   * Publish a new adapter set. Returns the new epoch.
   *
   * Callers must have verified `next` first — this does no I/O and cannot tell
   * a working adapter from a broken one. See `swapAdapters` in main.ts, which
   * authenticates the candidate and only calls this on success.
   */
  swap(next: AdapterSet): number {
    this.set = next;
    return ++this._epoch;
  }
}
