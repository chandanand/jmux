type ChangeListener = (paneId: string) => void;

/**
 * Interpret a raw `@jmux-pinned` value under the current grammar: any
 * non-empty value — `"on"`, and every legacy value ("1", "default", an old
 * tab id) — means force-on. Unset or empty means not pinned. This is the one
 * interpretation shared by the TUI and `cli/pane.ts`; legacy values are read
 * as `"on"` rather than migrated, because every one was written by someone
 * saying "put this on the grid" — the tab-id half of that sentence no longer
 * has a referent.
 */
export function parsePinValue(raw: string | null | undefined): "on" | null {
  return raw && raw.length > 0 ? "on" : null;
}

/**
 * Tracks each pane's desired Command Center membership via the per-pane tmux
 * option `@jmux-pinned`. The stored value is the raw option string, not just a
 * boolean — `parsePinValue` is the one place that interprets it as force-on or
 * not. tmux is the source of truth; this mirrors what the control channel
 * reports. It never breaks or joins panes.
 */
export class PinnedPaneTracker {
  private values = new Map<string, string>(); // paneId → raw non-empty value
  private listeners: ChangeListener[] = [];

  get size(): number {
    return this.values.size;
  }

  has(paneId: string): boolean {
    return this.values.has(paneId);
  }

  /** Raw `@jmux-pinned` value (`"on"`, or a legacy value — see `parsePinValue`),
   *  or undefined when unpinned. */
  getValue(paneId: string): string | undefined {
    return this.values.get(paneId);
  }

  all(): string[] {
    return [...this.values.keys()];
  }

  onChange(fn: ChangeListener): void {
    this.listeners.push(fn);
  }

  /**
   * Reflect a raw `@jmux-pinned` value. Non-empty → pinned with that value;
   * empty/null → unpinned. Emits only when the effective value changes.
   */
  apply(paneId: string, rawValue: string | null): void {
    const next = rawValue && rawValue.length > 0 ? rawValue : null;
    const prev = this.values.get(paneId) ?? null;
    if (next === prev) return;
    if (next === null) this.values.delete(paneId);
    else this.values.set(paneId, next);
    this.emit(paneId);
  }

  /** Drop any tracked pane not in `activeIds` (e.g. its process exited). */
  pruneExcept(activeIds: string[]): void {
    const active = new Set(activeIds);
    let changed: string | null = null;
    for (const id of [...this.values.keys()]) {
      if (!active.has(id)) {
        this.values.delete(id);
        changed = id;
      }
    }
    if (changed !== null) this.emit(changed);
  }

  private emit(paneId: string): void {
    for (const fn of this.listeners) fn(paneId);
  }
}
