import type { CellGrid, AgentState } from "../types";
import { createGrid, writeString, writeStyledLine, blit, drawBox, textCols, type CellAttrs } from "../cell-grid";
import { ColorMode } from "../types";
import { stateAttrs, type StateColor } from "../state-colors";
import { tokens } from "../chrome-tokens";

// Default border palette by agent state — matches the sidebar's defaults
// (running=green 2, waiting=yellow 3, complete=blue 4). Overridable via config.
export const DEFAULT_BORDER_PALETTE: Record<AgentState, StateColor> = {
  running: { kind: "palette", index: 2 },
  waiting: { kind: "palette", index: 3 },
  complete: { kind: "palette", index: 4 },
};

/**
 * Resolve a tile's border cell attributes from its agent state and focus.
 *
 * Focus outranks state: the focused tile's border is the shared chrome accent,
 * so exactly one accent border can be on screen and "orange border = the pane
 * I'm in" is unambiguous. Every unfocused tile keeps its state colour (via
 * stateAttrs), so the state read across the rest of the grid is untouched; an
 * unfocused pane with no state falls back to the frame rule tone.
 */
export function borderAttrsForState(
  state: AgentState | null | undefined,
  isFocused: boolean,
  palette: Record<AgentState, StateColor>,
): CellAttrs {
  if (isFocused) {
    return { fg: tokens.accent.fg, fgMode: tokens.accent.fgMode, bold: true, dim: false };
  }
  if (!state) {
    return { fg: tokens.ruleFrame.fg, fgMode: tokens.ruleFrame.fgMode, bold: false, dim: true };
  }
  return stateAttrs(palette[state], { bold: false, dim: true });
}

// ─── Tile label chip ─────────────────────────────────────────────────────────
// The label renders as a filled chip on the top border, like the toolbar's
// window tabs. Focused: bold accent text on the selection background — the same
// accent as the focused border and the active window tab, since this is a focus
// cue, not a state cue (it was green before, which read as "running").
// Unfocused: secondary text on the subtler hover background. The chip
// background (theme.selected / theme.hover) is read live so it tracks the
// detected terminal theme.
import { theme } from "../theme";

/** Label-chip cell attributes for a tile, by focus. Read the live theme. */
export function labelChipAttrs(isFocused: boolean): CellAttrs {
  return isFocused
    ? { fg: tokens.accent.fg, fgMode: tokens.accent.fgMode, bold: true, bg: theme.selected, bgMode: ColorMode.RGB }
    : { fg: tokens.textSecondary.fg, fgMode: tokens.textSecondary.fgMode, dim: true, bg: theme.hover, bgMode: ColorMode.RGB };
}
import { ScreenBridge } from "../screen-bridge";
import { TmuxPty, type TmuxPtyOptions } from "../tmux-pty";
import { computeTileLayout } from "./layout";
import type { TileLayout, TileRect } from "./layout";
import {
  planTiles,
  tileKeyForSession,
  type ActiveTile,
  type RetainedTile,
  type TileKey,
} from "./tile-plan";
import { electRepresentative, eligiblePanes, type PaneRow } from "./representative";
import { buildTileHints } from "./tile-hints";
import { buildTileLabel } from "./pane-label";
import { DENSITIES, type Density } from "./density";

// ─── Public types ─────────────────────────────────────────────────────────────

export interface GlassTileSpec {
  sessionId: string;   // the tile's identity, e.g. "$2"
  /** The session's only pane as far as the caller knows — see `panes`. */
  paneId: string;
  /** Where to look if tmux can't be asked which window `paneId` is in. */
  windowId: string;
  label: string;       // pre-built display label
  agentState?: AgentState | null; // drives the border color (matches sidebar)
  /** Force-on (an explicit pin) — survives the client cap ahead of derived members. */
  forced?: boolean;
  /**
   * Every pane of the session, when the caller can see them: the face is
   * elected from this and `paneId` is then unused. A caller supplying nothing
   * gets a one-pane session synthesised from `paneId` instead, so the election
   * has a single candidate and answers with it.
   */
  panes?: readonly PaneRow[];
}

/**
 * What the empty state needs to say when membership is empty: the view the
 * user is looking through, and how many sessions exist but didn't match it.
 * Supplied by the caller alongside `setTiles` — `GlassView` has no notion of
 * "every session that exists", only the ones that survived the caller's own
 * filter, so it cannot compute `excludedCount` itself.
 *
 * Deliberately named `excludedCount`, not `hiddenCount`, and deliberately
 * **disjoint** from it: sessions that exist but are not tiled for any reason
 * *other* than an explicit hide — filtered out, parked, or with no pane to
 * mirror. Sessions carrying `@jmux-grid-hidden` are subtracted out by the
 * caller and reported under `hiddenCount` instead.
 *
 * Note what this count does not promise. `⌃a f` recovers only the filtered
 * part of it: parking is undone by unparking and a paneless session has
 * nothing to show at any filter. The empty state lists `⌃a f` as a key worth
 * trying, not as a remedy for every session in this figure — an earlier
 * wording claimed otherwise and would have sent a user to press it for
 * sessions it cannot reach.
 */
export interface EmptyGridContext {
  viewName: string;
  excludedCount: number;
  /**
   * Sessions carrying `@jmux-grid-hidden` alone. **Disjoint from**
   * `excludedCount`, not a subset of it — the caller subtracts these out, so
   * each session is reported exactly once. A hide is an explicit exception
   * that no axis change reaches; only the palette's "Show hidden sessions"
   * undoes it, which is why it gets its own clause and its own key.
   */
  hiddenCount: number;
}

export interface GlassViewOptions {
  socketName?: string;
  configFile?: string;
  jmuxDir?: string;
  runner: (args: string[]) => { ok: boolean; lines: string[] }; // sync tmux
  /**
   * The grid's tile-size floor. Set from the active density
   * (`DENSITIES[d].minTileWidth/minTileHeight`) — the caller resolves the
   * density, `GlassView` only ever sees the two numbers it lays out against.
   * Live-settable via `setDensity`, unlike `maxClients`: changing the floor
   * only resizes existing clients, it never spawns or tears one down.
   */
  minTileWidth: number;
  minTileHeight: number;
  onFrame: () => void; // call to request a re-render (debounced by caller)
  /** Per-state border colors. Defaults to green/yellow/blue. */
  stateColors?: Record<AgentState, StateColor>;
  /** Cap on live mirror clients, rendered and retained together. */
  maxClients?: number;
  /** How long a tile that leaves membership keeps its client. */
  graceMs?: number;
  /** `pane_current_command` pattern that makes a pane worth electing. */
  agentPaneRegex?: string | null;
  /**
   * How a tile's mirror client is attached. Defaults to a real `TmuxPty`; the
   * seam exists because attaching one is the single thing in this class that
   * needs a live tmux server, and the lifecycle around it is the part worth
   * testing.
   */
  spawnPty?: (options: TmuxPtyOptions) => TilePty;
}

/** The pty surface a tile uses. `TmuxPty` satisfies it structurally. */
export interface TilePty {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  onData(listener: (data: string) => void): void;
}

export const DEFAULT_MAX_CLIENTS = 12;
export const DEFAULT_GRACE_MS = 30_000;

// ─── The face: which pane a tile is looking at ───────────────────────────────

/**
 * A tile's displayed pane, with the force-on set it was chosen against.
 *
 * The signature is what makes "a pin changes" observable without keeping a
 * second copy of the pane list: a face chosen while nothing was pinned is no
 * longer the answer once something is, even though the pane it names is still
 * perfectly alive.
 */
export interface FaceState {
  paneId: string;
  forcedSignature: string;
}

function forcedSignature(panes: readonly PaneRow[]): string {
  return panes
    .filter((p) => p.forcedOn)
    .map((p) => p.paneId)
    .sort()
    .join(" ");
}

/**
 * The sticky rule over the stateless election: a tile keeps the pane it is
 * showing until that pane dies, the user cycles the face, or the force-on set
 * changes underneath it.
 *
 * Without this the face would be re-elected on urgency every reconcile, so a
 * sibling agent going from complete to running would move the picture out from
 * under someone reading it. `electRepresentative` stays stateless and answers
 * "who represents this session right now"; deciding when to *ask it again* is
 * this function's whole job.
 */
export function resolveDisplayedRepresentative(input: {
  panes: readonly PaneRow[];
  /** The pane the user cycled to, if any. */
  override: string | null;
  /** What the tile shows now. */
  current: FaceState | null;
  commandRegex: string | null;
}): FaceState | null {
  const { panes, override, current, commandRegex } = input;
  if (panes.length === 0) return null;

  const signature = forcedSignature(panes);
  const live = (paneId: string): boolean => panes.some((p) => p.paneId === paneId);

  // An explicit cycle outranks stickiness — it is the user overruling it.
  if (override !== null && live(override)) {
    return { paneId: override, forcedSignature: signature };
  }

  if (current !== null && live(current.paneId) && current.forcedSignature === signature) {
    return current;
  }

  // The override is the user's cycle choice and is handled above; the explicit
  // pane is the hooks' answer and belongs in the election's first tier, where
  // `electRepresentative` expects it.
  const explicitPane = panes.find((p) => p.agentPane)?.agentPane ?? null;
  const elected = electRepresentative(panes, explicitPane, commandRegex);
  return elected ? { paneId: elected, forcedSignature: signature } : null;
}

/**
 * The session as seen by a caller that can only see one of its panes. The
 * election then has exactly one candidate — that pane — so a caller supplying
 * no pane list keeps the behaviour it had before there was an election, and
 * changing the pane it names reads as the face moving.
 */
function synthesizedPanes(spec: GlassTileSpec): readonly PaneRow[] {
  return [{
    paneId: spec.paneId,
    kind: "",
    command: "",
    forcedOn: spec.forced === true,
    sessionActive: false,
    state: spec.agentState ?? null,
    since: null,
    agentPane: null,
    title: "",
    currentPath: "",
  }];
}

// ─── Internal tile state ──────────────────────────────────────────────────────

interface TileState {
  key: TileKey;
  spec: GlassTileSpec;
  /** The pane this tile is looking at. Mutable backing state — see retarget. */
  face: FaceState;
  /** Last known panes of the session, so a face cycle can resolve immediately. */
  panes: readonly PaneRow[];
  pty: TilePty;
  bridge: ScreenBridge;
  /**
   * The pane WE zoomed, or null. Not a boolean: after a retarget the zoom to
   * undo is no longer on the pane the tile started on.
   */
  zoomedPaneId: string | null;
  /** Per-tile pending write counter, mirrors the main.ts pattern. */
  writesPending: number;
}

/** What a window looks like from a pane's point of view. */
interface PaneWindowInfo {
  windowId: string;
  paneCount: number;
  zoomed: boolean;
}

// ─── GlassView ────────────────────────────────────────────────────────────────

export class GlassView {
  private opts: GlassViewOptions;
  /** Every live client, keyed by tile — rendered and retained alike. */
  private tiles: Map<TileKey, TileState> = new Map();
  /** The rendered set, in render order. `rect.index` resolves through this. */
  private tileOrder: TileKey[] = [];
  /** Focus is a key, never an index: the set reorders as agents change state. */
  private focusedKey: TileKey | null = null;
  /**
   * The tile zoomed to the full area, or null. A key, on the same reasoning as
   * `focusedKey` — cleared in `reconcile` when its tile leaves the rendered
   * set, never re-derived from focus: `moveFocus` refuses to move away from it
   * while set (see below), so the two only ever diverge by a tile vanishing.
   */
  private zoomedKey: TileKey | null = null;
  /**
   * Whether keys are going to the focused tile at all. False while the docked
   * panel holds keyboard focus beside the grid: the focused tile is still
   * *the* tile — writeFocused, cycling and zoom keep addressing it, and it is
   * where focus returns — but it paints unfocused, because an accent border on
   * a tile that is not receiving keys is a lie about where the keys go. The
   * grid has no rule row to underline the panel with, so this withdrawal is
   * the whole cue.
   */
  private inputFocus = true;
  /** Live tiles that have left membership, with the moment they left. */
  private retained: Map<TileKey, RetainedTile> = new Map();
  /** Face cycles, keyed by tile — cleared when the pane they name dies. */
  private faceOverrides: Map<TileKey, string> = new Map();
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;
  private droppedActive = 0;
  private allSpecs: GlassTileSpec[] = []; // the grid's one derived membership set
  /** What the empty state names — the active view and how many sessions it excludes. */
  private emptyContext: EmptyGridContext = { viewName: "", excludedCount: 0, hiddenCount: 0 };
  private width: number = 80;
  private height: number = 24;
  private scrollRow: number = 0;
  private stateColors: Record<AgentState, StateColor>;

  constructor(opts: GlassViewOptions) {
    this.opts = opts;
    this.stateColors = opts.stateColors ?? { ...DEFAULT_BORDER_PALETTE };
  }

  /** Set the per-state border colors. */
  setStateColors(colors: Record<AgentState, StateColor>): void {
    this.stateColors = colors;
    this.opts.onFrame();
  }

  /**
   * Which `pane_current_command`s make a pane worth electing. Live-settable
   * because it is a config field the settings screen edits: a grid holding the
   * old pattern's answer until the next restart would look like the setting had
   * no effect. The caller reconciles after this, which is what re-elects.
   */
  setAgentPaneRegex(pattern: string | null): void {
    this.opts.agentPaneRegex = pattern;
  }

  /**
   * Switch the grid's tile-size floor and re-lay out immediately. The tiles
   * are real tmux clients, so "re-lay out" has to mean what `resize()` means:
   * resize every visible tile's pty and `ScreenBridge` to its new rect, not
   * just repaint one. Nothing is spawned or torn down — `layout()` reads
   * `opts.minTileWidth/minTileHeight` fresh on every call, so mutating them
   * here is enough for the next `resizeAllTiles()` (and the next `getGrid()`)
   * to lay out against the new floor.
   */
  setDensity(d: Density): void {
    const spec = DENSITIES[d];
    this.opts.minTileWidth = spec.minTileWidth;
    this.opts.minTileHeight = spec.minTileHeight;
    this.resizeAllTiles();
    this.opts.onFrame();
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * `emptyContext` is what the empty state names when `specs` is empty (or
   * becomes empty after this reconcile) — the active view's name and how many
   * sessions it excludes. Stored unconditionally, not only when empty: the
   * caller doesn't know in advance whether this call will empty the grid, and
   * a stale context from the last non-empty call would misname the view the
   * moment it did.
   */
  setTiles(specs: GlassTileSpec[], emptyContext: EmptyGridContext): void {
    this.allSpecs = specs;
    this.emptyContext = emptyContext;
    this.reconcile(Date.now());
  }

  /**
   * Point a session's tile at a specific pane — the face cycle. Applied at once
   * rather than on the next reconcile: the user pressed a key, so the picture
   * moves now. `null` hands the choice back to the election.
   */
  setFace(sessionId: string, paneId: string | null): void {
    const key = tileKeyForSession(sessionId);
    if (paneId === null) this.faceOverrides.delete(key);
    else this.faceOverrides.set(key, paneId);

    const tile = this.tiles.get(key);
    if (!tile) return;
    const face = resolveDisplayedRepresentative({
      panes: tile.panes,
      override: this.faceOverrides.get(key) ?? null,
      current: tile.face,
      commandRegex: this.opts.agentPaneRegex ?? null,
    });
    if (face && face.paneId !== tile.face.paneId) this.retargetTile(tile, face);
    else if (face) tile.face = face;
    this.opts.onFrame();
  }

  /**
   * Step the focused tile's face to the next eligible pane, wrapping. A no-op
   * with fewer than two eligible panes — there is nothing to cycle to, which
   * is also why the chord's own hint (phase 8) omits itself in that case.
   */
  cycleFace(): void {
    const tile = this.focusedTile();
    if (!tile) return;
    const eligible = eligiblePanes(tile.panes, this.opts.agentPaneRegex ?? null);
    if (eligible.length < 2) return;
    const index = eligible.findIndex((p) => p.paneId === tile.face.paneId);
    const next = eligible[(index + 1) % eligible.length]!;
    this.setFace(tile.spec.sessionId, next.paneId);
  }

  /**
   * Zoom the focused tile to fill the whole area, or restore the grid if a
   * tile is already zoomed. Bound to whichever tile was focused at the moment
   * of the press — not re-read from focus afterwards — so a zoom outlives
   * `moveFocus` being asked to move (which it refuses, below, while zoomed).
   */
  toggleZoom(): void {
    this.zoomedKey = this.zoomedKey !== null ? null : this.focusedKey;
    this.resizeAllTiles();
    this.opts.onFrame();
  }

  /** True while a tile is zoomed to the full area. */
  isZoomed(): boolean {
    return this.zoomedKey !== null;
  }

  /** Active tiles the client cap refused. Reported in the strip, never silent. */
  getDroppedActive(): number {
    return this.droppedActive;
  }

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    this.resizeAllTiles();
  }

  getGrid(): CellGrid {
    const grid = createGrid(this.width, this.height);

    if (this.tileOrder.length === 0) {
      this.drawEmptyState(grid);
      return grid;
    }

    const layout = this.layout();
    const focusedIndex = this.focusIndex();

    // Update scrollRow from layout (it may have been clamped/adjusted).
    this.scrollRow = layout.scrollRow;

    for (const rect of layout.tiles) {
      if (!rect.visible) continue;
      const tile = this.tileAt(rect.index);
      if (!tile) continue;

      const isFocused = this.inputFocus && rect.index === focusedIndex;
      this.drawTile(grid, rect, tile, isFocused);
    }

    return grid;
  }

  focusAt(x: number, y: number): void {
    if (this.tileOrder.length === 0) return;
    const layout = this.layout();
    for (const rect of layout.tiles) {
      if (!rect.visible) continue;
      if (
        x >= rect.x && x < rect.x + rect.width &&
        y >= rect.y && y < rect.y + rect.height
      ) {
        this.focusedKey = this.tileOrder[rect.index] ?? this.focusedKey;
        return;
      }
    }
  }

  /**
   * Returns whether focus actually moved. `false` at an edge is what lets the
   * caller hand focus onward — Shift+Right off the right-most column goes to
   * the docked panel — instead of the key dying silently at the border.
   */
  moveFocus(dir: "left" | "right" | "up" | "down"): boolean {
    if (this.tileOrder.length === 0) return false;
    // While zoomed only one tile is drawn, so there is nowhere else to move
    // focus into — and moving it silently would desync keystrokes (routed by
    // focus) from the picture (pinned to zoomedKey) from the tile the user is
    // actually looking at.
    if (this.zoomedKey !== null) return false;
    const layout = this.layout();
    const cols = layout.columns;
    const total = this.tileOrder.length;
    let next = this.focusIndex();

    switch (dir) {
      case "left":
        if (next % cols > 0) next--;
        break;
      case "right":
        if (next % cols < cols - 1 && next + 1 < total) next++;
        break;
      case "up":
        if (next - cols >= 0) next -= cols;
        break;
      case "down":
        if (next + cols < total) next += cols;
        break;
    }

    const moved = next !== this.focusIndex();
    this.focusedKey = this.tileOrder[next] ?? this.focusedKey;
    return moved;
  }

  /** See `inputFocus`. */
  setInputFocus(focused: boolean): void {
    this.inputFocus = focused;
  }

  writeFocused(data: string): void {
    const tile = this.focusedTile();
    if (!tile) return;
    tile.pty.write(data);
  }

  /**
   * Forward a mouse event (e.g. wheel scroll) to the tile under the cursor,
   * translated into that tile's pane-local 1-indexed coordinates. This makes
   * scrollback / copy-mode work per-tile. x/y are glass-viewport-relative.
   */
  forwardMouse(x: number, y: number, button: number, release: boolean): void {
    if (this.tileOrder.length === 0) return;
    const layout = this.layout();
    for (const rect of layout.tiles) {
      if (!rect.visible) continue;
      if (
        x >= rect.x && x < rect.x + rect.width &&
        y >= rect.y && y < rect.y + rect.height
      ) {
        const tile = this.tileAt(rect.index);
        if (!tile) return;
        // Interior begins after the 1-cell border; tmux mouse coords are 1-indexed.
        const localCol = x - rect.x; // (x - (rect.x + 1)) + 1
        const localRow = y - rect.y;
        if (localCol < 1 || localRow < 1) return;
        tile.pty.write(`\x1b[<${button};${localCol};${localRow}${release ? "m" : "M"}`);
        return;
      }
    }
  }

  /** The pane the focused tile is currently looking at. */
  focusedPaneId(): string | null {
    return this.focusedTile()?.face.paneId ?? null;
  }

  /** The session the focused tile mirrors. */
  focusedSessionId(): string | null {
    return this.focusedTile()?.spec.sessionId ?? null;
  }

  /**
   * Cursor position of the focused tile, translated into this view's grid
   * coordinates (accounting for the tile's rect offset + 1-cell border).
   * Returns null when there is no focused tile or it's scrolled off-screen.
   */
  getFocusedCursor(): { x: number; y: number } | null {
    const tile = this.focusedTile();
    if (!tile) return null;

    const layout = this.layout();
    const rect = layout.tiles[this.focusIndex()];
    if (!rect || !rect.visible) return null;

    const cur = tile.bridge.getCursor();
    const iCols = Math.max(0, rect.width - 2);
    const iRows = Math.max(0, rect.height - 2);
    // Clamp into the tile interior so the cursor never lands on the border.
    const cx = Math.min(Math.max(0, cur.x), Math.max(0, iCols - 1));
    const cy = Math.min(Math.max(0, cur.y), Math.max(0, iRows - 1));
    return { x: rect.x + 1 + cx, y: rect.y + 1 + cy };
  }

  teardown(): void {
    for (const key of [...this.tiles.keys()]) {
      this.teardownTile(key);
    }
    this.tileOrder = [];
    this.focusedKey = null;
    this.zoomedKey = null;
    this.inputFocus = true;
    this.retained.clear();
    this.faceOverrides.clear();
    this.droppedActive = 0;
    this.armExpiry(null);
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  /**
   * Bring the client set into line with membership.
   *
   * Ordering here is the contract. Admission runs before spawning, so a client
   * is never attached for a tile the cap will not render; teardown runs before
   * spawning, so a churning set does not transiently exceed the cap; and the
   * render order and focus are settled before spawning, so a new tile is sized
   * against the grid it is about to appear in rather than the one it replaced.
   */
  private reconcile(now: number): void {
    const activeSpecs = this.activeSpecs();

    // Resolve each active tile's face before anything is attached: spawning
    // needs a pane, and a survivor whose face moved needs a retarget.
    const faces = new Map<TileKey, FaceState>();
    for (const [key, spec] of activeSpecs) {
      const panes = spec.panes ?? synthesizedPanes(spec);
      const override = this.faceOverrides.get(key) ?? null;
      // A face override survives only as long as the pane it names.
      if (override !== null && !panes.some((p) => p.paneId === override)) {
        this.faceOverrides.delete(key);
      }
      const face = resolveDisplayedRepresentative({
        panes,
        override: this.faceOverrides.get(key) ?? null,
        current: this.tiles.get(key)?.face ?? null,
        commandRegex: this.opts.agentPaneRegex ?? null,
      });
      if (face) faces.set(key, face);
    }

    // A live tile that has left membership starts its grace now; one that came
    // back stops being retained. The planner never invents a timestamp.
    for (const key of this.tiles.keys()) {
      if (activeSpecs.has(key)) this.retained.delete(key);
      else if (!this.retained.has(key)) this.retained.set(key, { lastSeenAt: now });
    }

    const active: ActiveTile[] = [...activeSpecs].map(([key, spec]) => ({
      key,
      forced: spec.forced === true,
    }));
    const plan = planTiles({
      active,
      live: new Set(this.tiles.keys()),
      retained: this.retained,
      now,
      graceMs: this.opts.graceMs ?? DEFAULT_GRACE_MS,
      maxClients: this.opts.maxClients ?? DEFAULT_MAX_CLIENTS,
    });

    for (const key of plan.teardown) {
      this.teardownTile(key);
      this.retained.delete(key);
      // The override outlives its tile otherwise: the prune above only reaches
      // keys still in membership, so a session that ends leaves its entry here
      // until teardown() clears the lot. "Every session ever seen" is not a
      // bound for a process that runs for days.
      this.faceOverrides.delete(key);
    }

    // Focus follows the key; when its tile is gone, the nearest survivor by the
    // vanished tile's last index, preferring the successor.
    const lastFocusIndex = this.focusedKey ? this.tileOrder.indexOf(this.focusedKey) : -1;
    this.tileOrder = plan.render;
    if (this.tileOrder.length === 0) {
      this.focusedKey = null;
    } else if (!this.focusedKey || !this.tileOrder.includes(this.focusedKey)) {
      const at = Math.min(Math.max(0, lastFocusIndex), this.tileOrder.length - 1);
      this.focusedKey = this.tileOrder[at] ?? null;
    }

    // A logical key, not a boolean: cleared the moment its tile leaves the
    // rendered set, the same rule as focus above but with no successor to
    // hand off to — restoring the grid is the only honest outcome for a zoom
    // whose subject is gone.
    if (this.zoomedKey !== null && !this.tileOrder.includes(this.zoomedKey)) {
      this.zoomedKey = null;
    }

    for (const key of plan.spawn) {
      const spec = activeSpecs.get(key);
      const face = faces.get(key);
      if (spec && face) this.ensureTile(key, spec, face);
    }

    for (const [key, tile] of this.tiles) {
      const spec = activeSpecs.get(key);
      if (!spec) continue;
      tile.spec = spec; // refresh label/agentState
      tile.panes = spec.panes ?? synthesizedPanes(spec);
      const face = faces.get(key);
      if (!face) continue;
      if (face.paneId !== tile.face.paneId) this.retargetTile(tile, face);
      else tile.face = face;
    }

    this.droppedActive = plan.droppedActive;
    this.armExpiry(plan.nextExpiryAt);
    this.resizeAllTiles();
  }

  /**
   * Active membership as tiles, in render order. One tile per session: a second
   * pane of a session already claimed is backing state for the same tile, not a
   * tile of its own, so the first spec in membership order wins the row.
   */
  private activeSpecs(): Map<TileKey, GlassTileSpec> {
    const out = new Map<TileKey, GlassTileSpec>();
    for (const spec of this.allSpecs) {
      const key = tileKeyForSession(spec.sessionId);
      if (!out.has(key)) out.set(key, spec);
    }
    return out;
  }

  /**
   * A grace has to expire with no tmux traffic behind it: the tile that left
   * membership during a quiet period would otherwise never be collected,
   * because nothing is going to ask again.
   */
  private armExpiry(at: number | null): void {
    if (this.expiryTimer !== null) {
      clearTimeout(this.expiryTimer);
      this.expiryTimer = null;
    }
    if (at === null) return;
    const delay = Math.max(0, at - Date.now()) + 1;
    this.expiryTimer = setTimeout(() => {
      this.expiryTimer = null;
      this.reconcile(Date.now());
      this.opts.onFrame();
    }, delay);
    this.expiryTimer.unref?.();
  }

  private ensureTile(key: TileKey, spec: GlassTileSpec, face: FaceState): void {
    const { runner, socketName, configFile, jmuxDir, onFrame } = this.opts;

    // 1. Point the home session at the face's window and make it full-bleed. We
    //    attach the mirror client DIRECTLY to the home session — never a
    //    new/group session, so teardown only ever DETACHES a client and can
    //    never destroy a session. The main client is parked while the glass is
    //    up, so this mirror is the only client on the session.
    const zoomedPaneId = this.showPane(spec.sessionId, face.paneId, spec.windowId);

    // 2. Compute initial tile dimensions.
    const { interiorCols, interiorRows } = this.getTileInterior(key);

    // 3. Spawn the PTY as a second client attached to the home session
    //    (strictAttach → `tmux attach-session -t <session>`). Killing this pty
    //    later just detaches the client; the session is untouched.
    const spawnPty = this.opts.spawnPty ?? ((o: TmuxPtyOptions) => new TmuxPty(o));
    const pty = spawnPty({
      sessionName: spec.sessionId,
      socketName,
      configFile,
      jmuxDir,
      cols: interiorCols,
      rows: interiorRows,
      attachMode: "strictAttach",
    });

    // 4. Create the screen bridge.
    const bridge = new ScreenBridge(interiorCols, interiorRows);

    // 5. Wire data→bridge→onFrame, per-tile writesPending counter.
    const state: TileState = {
      key,
      spec,
      face,
      panes: spec.panes ?? synthesizedPanes(spec),
      pty,
      bridge,
      zoomedPaneId,
      writesPending: 0,
    };

    pty.onData((data: string) => {
      state.writesPending++;
      bridge.write(data).then(() => {
        state.writesPending--;
        // Only a *rendered* tile can change the picture. A retained tile is
        // alive but absent from `tileOrder`, so asking for a frame on its
        // behalf recomposites the whole grid to produce an identical one — and
        // the event that retires a tile into its grace is an agent finishing a
        // turn, which is precisely when it prints. Feeding the bridge still
        // matters: the tile must be current the moment it comes back.
        if (state.writesPending === 0 && this.tileOrder.includes(key)) {
          onFrame();
        }
      });
    });

    this.tiles.set(key, state);
  }

  /**
   * Move a tile's face to another pane of the same session. The client, its pty
   * and its ScreenBridge are all retained — only what the session is looking at
   * changes, which is why this is neither a spawn nor a teardown.
   *
   * The old window is given back BEFORE the new one is selected: unzooming
   * afterwards would unzoom a window the session is no longer looking at, and
   * leave the one it is looking at unzoomed too.
   */
  private retargetTile(tile: TileState, face: FaceState): void {
    if (tile.zoomedPaneId) {
      this.opts.runner(["resize-pane", "-Z", "-t", tile.zoomedPaneId]);
      tile.zoomedPaneId = null;
    }
    // The old window is the hint: `tile.panes` is a snapshot, so the new face
    // can be dead by the time we act on it. Without a hint that failure issues
    // no `select-window` at all and the tile sits on a window it has already
    // given the zoom back to. It self-corrects on the next reconcile; the hint
    // keeps the frames in between showing something the session is on.
    tile.zoomedPaneId = this.showPane(tile.spec.sessionId, face.paneId, tile.spec.windowId);
    tile.face = face;
  }

  /**
   * Select a pane's window and zoom the pane if the window has siblings and is
   * not zoomed already. Returns the pane WE zoomed, or null — teardown must
   * undo exactly the zoom it applied, and after a retarget that is no longer
   * the pane the tile started on.
   */
  private showPane(sessionId: string, paneId: string, windowIdHint?: string): string | null {
    const info = this.paneWindowInfo(paneId);
    const windowId = info?.windowId || windowIdHint;
    if (windowId) {
      this.opts.runner(["select-window", "-t", `${sessionId}:${windowId}`]);
    }
    if (info && info.paneCount > 1 && !info.zoomed) {
      this.opts.runner(["resize-pane", "-Z", "-t", paneId]);
      return paneId;
    }
    return null;
  }

  /** One query answers both the window to select and whether to zoom. */
  private paneWindowInfo(paneId: string): PaneWindowInfo | null {
    const result = this.opts.runner([
      "display-message", "-p", "-t", paneId,
      "#{window_id} #{window_panes} #{window_zoomed_flag}",
    ]);
    if (!result.ok || result.lines.length === 0) return null;
    const parts = (result.lines[0] ?? "").trim().split(" ");
    if (!parts[0]) return null;
    return {
      windowId: parts[0],
      paneCount: parseInt(parts[1] ?? "0", 10) || 0,
      zoomed: parts[2] === "1",
    };
  }

  private teardownTile(key: TileKey): void {
    const tile = this.tiles.get(key);
    if (!tile) return;

    // Unzoom the pane if we were the ones who zoomed it (restore the layout).
    if (tile.zoomedPaneId) {
      this.opts.runner(["resize-pane", "-Z", "-t", tile.zoomedPaneId]);
    }

    // Detach the mirror client. This NEVER kills the session — the home session,
    // its windows, and the pane all survive untouched.
    tile.pty.kill();

    this.tiles.delete(key);
  }

  private resizeAllTiles(): void {
    if (this.tileOrder.length === 0) {
      this.scrollRow = 0;
      return;
    }

    const layout = this.layout();
    // Scroll is reclamped from the resolved focus, every reconcile.
    this.scrollRow = layout.scrollRow;

    for (const rect of layout.tiles) {
      // Skip on *zoom*, not on visibility. A zoomed layout gives every other
      // tile a deliberately stale rect (see computeTileLayout) and resizing to
      // it would shrink a session's real tmux window to fit a rect nobody
      // draws. A tile merely scrolled out of view has a real rect — the size
      // it will have the moment it scrolls back in — and must take it.
      //
      // This used to skip on `!rect.visible`, justified by every rect in a
      // row/column sharing a size. That held only while the size floors were
      // fixed: density changes them, so after Fit → Focus every tile below the
      // scroll window kept its Fit dimensions and `moveFocus` revealed it at
      // the wrong size.
      if (!rect.visible && this.zoomedKey !== null) continue;
      const tile = this.tileAt(rect.index);
      if (!tile) continue;

      const iCols = Math.max(1, rect.width - 2);
      const iRows = Math.max(1, rect.height - 2);
      tile.pty.resize(iCols, iRows);
      tile.bridge.resize(iCols, iRows);
    }
  }

  // ── Positional resolution ───────────────────────────────────────────────────
  // computeTileLayout stays positional; everything stored is a key, resolved to
  // an index at use.

  private layout(): TileLayout {
    return computeTileLayout({
      tileCount: this.tileOrder.length,
      mainWidth: this.width,
      mainHeight: this.height,
      minTileWidth: this.opts.minTileWidth,
      minTileHeight: this.opts.minTileHeight,
      focusedIndex: this.focusIndex(),
      scrollRow: this.scrollRow,
      zoomedIndex: this.zoomedKey !== null ? this.tileOrder.indexOf(this.zoomedKey) : null,
    });
  }

  private focusIndex(): number {
    if (!this.focusedKey) return 0;
    const index = this.tileOrder.indexOf(this.focusedKey);
    return index >= 0 ? index : 0;
  }

  private focusedTile(): TileState | undefined {
    if (this.tileOrder.length === 0) return undefined;
    return this.tileAt(this.focusIndex());
  }

  private tileAt(index: number): TileState | undefined {
    const key = this.tileOrder[index];
    return key ? this.tiles.get(key) : undefined;
  }

  /**
   * Compute interior dimensions for a tile, using the current layout.
   * Falls back to a sensible minimum.
   */
  private getTileInterior(key: TileKey): { interiorCols: number; interiorRows: number } {
    const full = {
      interiorCols: Math.max(1, this.width - 2),
      interiorRows: Math.max(1, this.height - 2),
    };
    const index = this.tileOrder.indexOf(key);
    if (index < 0 || this.tileOrder.length === 0) return full;

    const rect = this.layout().tiles[index];
    if (!rect) return full;

    return {
      interiorCols: Math.max(1, rect.width - 2),
      interiorRows: Math.max(1, rect.height - 2),
    };
  }

  // ── Rendering ───────────────────────────────────────────────────────────────

  /**
   * The tile's full label: `spec.label` (the session's own identity plus
   * issue badge, built by the caller) with the displayed pane's own identity
   * appended when it is not the session's natural first choice.
   *
   * "Not the natural choice" is computed fresh from current state, not
   * cached, because the face can move (`Ctrl-a x`, a retarget) without a new
   * `spec` arriving — `setTiles` only runs on the caller's own reconcile
   * cadence. The two triggers are literal: a live cycle override
   * (`faceOverrides` naming this tile) or the displayed pane itself carrying
   * a force-on pin. Recomputed here rather than stored on `TileState` for the
   * same reason spec.label isn't recomputed elsewhere — it's cheap and this
   * is the only place that reads it.
   */
  private tileLabel(tile: TileState): string {
    const showSuffix = this.faceOverrides.has(tile.key)
      || (tile.panes.find((p) => p.paneId === tile.face.paneId)?.forcedOn ?? false);
    if (!showSuffix) return tile.spec.label;
    const pane = tile.panes.find((p) => p.paneId === tile.face.paneId);
    if (!pane) return tile.spec.label;
    return buildTileLabel(tile.spec.label, {
      paneTitle: pane.title,
      paneCurrentCommand: pane.command,
      paneCurrentPath: pane.currentPath,
    }, true);
  }

  private drawTile(
    grid: CellGrid,
    rect: TileRect,
    tile: TileState,
    isFocused: boolean,
  ): void {
    // Border color encodes agent state (matching the sidebar). Focus stays
    // legible via bold (focused) vs dim (unfocused). Panes with no agent state
    // fall back to bright-white (focused) / dark-gray (unfocused).
    const borderAttrs = borderAttrsForState(tile.spec.agentState, isFocused, this.stateColors);

    // The label pops in bold green when focused, dims to gray otherwise.
    const labelAttrs: CellAttrs = labelChipAttrs(isFocused);

    const { x, y, width, height } = rect;

    if (width < 2 || height < 2) return;

    // Border ring (┌─ label ─────┐ / │ … │ / └──────────┘).
    drawBox(grid, { x, y, w: width, h: height }, {
      border: borderAttrs,
      label: this.tileLabel(tile),
      labelAttrs,
    });

    // Blit interior: copy bridge cells into grid at (x+1, y+1).
    const bridgeGrid = tile.bridge.getGrid();
    const iStartX = x + 1;
    const iStartY = y + 1;
    const iCols = width - 2;
    const iRows = height - 2;

    blit(grid, bridgeGrid, { destX: iStartX, destY: iStartY, w: iCols, h: iRows });

    // The bottom border's mirror of the top's label chip: what the focused
    // tile's keys do, not what it is. Only the focused tile draws one, so
    // exactly one hint is ever on screen and it moves with attention.
    if (isFocused) this.drawFocusedHints(grid, rect, tile);
  }

  /**
   * Overwrite a prefix of the bottom border — already drawn as `─` by
   * `drawBox` above — with the focused tile's hint text, left-aligned after
   * the corner exactly like the top label chip (`innerStart + 1`). Unlike the
   * label this carries no background fill: it's plain text in the frame-rule
   * tone laid over the rule, not a chip, so only the glyphs it actually
   * writes replace border cells — anything the hint doesn't reach stays `─`.
   */
  private drawFocusedHints(grid: CellGrid, rect: TileRect, tile: TileState): void {
    const { x, y, width, height } = rect;
    if (width < 2 || height < 2) return;

    const bottom = y + height - 1;
    const right = x + width - 1;
    const innerStart = x + 1;
    // Mirrors drawBox's label math exactly: the written text starts one
    // column after the left "─" (innerStart + 1) and the raw text budget
    // reserves a trailing column before the right corner.
    const maxHintCols = right - (innerStart + 2) - 1;

    const eligible = eligiblePanes(tile.panes, this.opts.agentPaneRegex ?? null);
    const index = eligible.findIndex((p) => p.paneId === tile.face.paneId);
    const hintText = buildTileHints(
      {
        // A sticky face can in principle sit outside the eligible set for a
        // moment (see `resolveDisplayedRepresentative`'s doc comment on
        // stickiness) — fall back to 1 rather than showing a negative index.
        eligibleIndex: index >= 0 ? index + 1 : 1,
        eligibleCount: eligible.length,
      },
      maxHintCols,
    );
    if (hintText.length === 0) return;

    const padded = ` ${hintText} `;
    writeStyledLine(
      grid,
      bottom,
      innerStart + 1,
      [{ text: padded, attrs: tokens.ruleFrame }],
      textCols(padded),
    );
  }

  /**
   * Empty membership: name the view, say what didn't match, and give the key
   * that widens it — replacing the flat "No pinned panes" that predates the
   * grid having a filter at all (nothing is pinned any more; the sentence was
   * simply false). `emptyContext` is supplied by the caller via `setTiles`,
   * because this class has no notion of "every session that exists", only
   * the ones that survived the caller's own filter.
   */
  private drawEmptyState(grid: CellGrid): void {
    const { viewName, excludedCount, hiddenCount } = this.emptyContext;
    const line1 = viewName ? `No sessions match "${viewName}"` : "No sessions to show";
    // "not shown", not "hidden" — the strip's own word for the same idea
    // (`+N not shown`), because "hidden" already names the `@jmux-grid-hidden`
    // exception and this figure is everything the view's axes excluded.
    // Two clauses because they have two remedies. "not shown" is everything the
    // axes excluded and `⌃a f` recovers it; "hidden" is the explicit exception,
    // which no filter reaches — it names the palette entry instead. Reported
    // separately so the number never points at the wrong key.
    const excludedClause = excludedCount > 0 ? `      ${excludedCount} not shown` : "";
    const hiddenClause = hiddenCount > 0 ? `      ${hiddenCount} hidden (⌃a p)` : "";
    const line2 = `⌃a f  all sessions      ⌃a 1…9  switch view${excludedClause}${hiddenClause}`;

    // Left-align both lines against the wider of the two, then center that
    // block — independently centering each line would zig-zag the left edge
    // between them, which reads as two unrelated messages rather than one.
    const blockCols = Math.max(textCols(line1), textCols(line2));
    const col = Math.max(0, Math.floor((this.width - blockCols) / 2));
    const row = Math.max(0, Math.floor(this.height / 2) - 1);

    const attrs = { fgMode: ColorMode.Palette, fg: 8 } as const; // dark gray
    writeString(grid, row, col, line1, attrs);
    writeString(grid, row + 1, col, line2, attrs);
  }
}
