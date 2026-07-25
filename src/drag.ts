// Mouse-drag policy for the frame's resize handles — pure, so it is testable
// without a terminal, a layout, or tmux.
//
// jmux already receives every motion event it needs: main.ts enables ?1000h +
// ?1003h + ?1006h at startup and InputRouter parses button/x/y/release out of
// each one. What was missing is the state machine below, which answers the one
// question a press cannot answer on its own: is this a click, or the start of
// a drag? Until the next event arrives, it is genuinely both — so a press on a
// drag handle commits nothing, and the handle's click behaviour (the divider's
// focus toggle) fires on release-without-motion instead.
//
// The controller is deliberately layout-free. Callers clamp columns to what
// the layout permits (see clampDragCol) before handing them over, so `move`
// and `commit` both carry already-legal positions and a drag can never resize
// to a place the commit would refuse.

import type { FrameLayout } from "./frame-layout";

/** The draggable handles. See handleAxis for which way each one moves. */
export type DragHandle = "sidebar-edge" | "panel-divider" | "panel-split";

/**
 * Which axis a handle travels along. The two frame edges are vertical lines
 * that move horizontally; the panel's list/detail split is a horizontal line
 * that moves vertically. Everything below tracks a single scalar `pos` — a
 * grid column for "x" handles, a grid row for "y" handles — because a drag is
 * 1-D either way and duplicating the state machine per axis would be silly.
 */
export function handleAxis(handle: DragHandle): "x" | "y" {
  return handle === "panel-split" ? "y" : "x";
}

/**
 * What the caller should do in response to a mouse event. The controller
 * never acts; it classifies. `click` is how a press+release with no motion
 * reaches the handle's non-drag behaviour.
 */
export type DragIntent =
  | { type: "none" }
  | { type: "click"; handle: DragHandle }
  | { type: "move"; handle: DragHandle; pos: number }
  | { type: "commit"; handle: DragHandle; pos: number }
  | { type: "cancel"; handle: DragHandle };

type State =
  | { phase: "idle" }
  | { phase: "armed"; handle: DragHandle; originPos: number }
  | { phase: "dragging"; handle: DragHandle; pos: number };

const NONE: DragIntent = { type: "none" };
const IDLE: State = { phase: "idle" };

export class DragController {
  private state: State = IDLE;

  /** Take ownership of the pointer. Commits nothing — see the module note. */
  press(handle: DragHandle, pos: number): DragIntent {
    this.state = { phase: "armed", handle, originPos: pos };
    return NONE;
  }

  /**
   * Promotion to a drag requires movement *along the handle's own axis*: a
   * vertical handle jiggled up and down is still a click, and vice versa.
   * Callers feed the axis-appropriate scalar (see handleAxis), so this only
   * has to compare positions. Once dragging, motion tracks freely — including
   * back across the origin.
   */
  motion(pos: number): DragIntent {
    const s = this.state;
    if (s.phase === "idle") return NONE;
    if (s.phase === "armed") {
      if (pos === s.originPos) return NONE;
      this.state = { phase: "dragging", handle: s.handle, pos };
      return { type: "move", handle: s.handle, pos };
    }
    if (pos === s.pos) return NONE; // unchanged — don't force a resize
    this.state = { phase: "dragging", handle: s.handle, pos };
    return { type: "move", handle: s.handle, pos };
  }

  release(pos: number): DragIntent {
    const s = this.state;
    this.state = IDLE;
    if (s.phase === "idle") return NONE;
    if (s.phase === "armed") return { type: "click", handle: s.handle };
    return { type: "commit", handle: s.handle, pos };
  }

  /**
   * Force back to idle. Drags leak — if the terminal loses focus or the
   * pointer exits the window mid-drag, the release never arrives — so every
   * event that proves the drag is over (a wheel, a keystroke, a resize, a
   * mode switch) routes here rather than waiting for a release that won't come.
   */
  abort(): DragIntent {
    const s = this.state;
    this.state = IDLE;
    if (s.phase === "idle") return NONE;
    return { type: "cancel", handle: s.handle };
  }

  /**
   * The handle this drag owns, or null when idle — which doubles as the "is a
   * drag live?" test, so there is no second boolean accessor that could
   * disagree with this one. Non-null while *armed* as well as dragging: the
   * router must keep routing mouse events to the drag through the ambiguous
   * window, or the motion that would promote a drag gets eaten as a hover.
   *
   * Callers need the handle *before* calling motion()/release(), since both
   * the axis and the clamp are handle-specific, and the intent that carries
   * the handle only comes back afterwards.
   */
  activeHandle(): DragHandle | null {
    return this.state.phase === "idle" ? null : this.state.handle;
  }
}

// --- Layout math -----------------------------------------------------------
//
// Stated once here so no caller re-derives it:
//   borderCol === sidebar.x + sidebar.w and sidebar.x === 0, so dragging the
//     sidebar edge to column X means sidebarWidth === X.
//   panel.x === divider + borderWidth and panel.x + panel.w === termCols, so
//     dragging the divider to column X means panelWidth === termCols - X - borderWidth.

/** Sidebar width bounds. 10..60 matches the settings-screen clamp; the
 *  termCols term keeps a usable main area on narrow terminals. */
const SIDEBAR_MIN_WIDTH = 10;
const SIDEBAR_MAX_WIDTH = 60;
const MAIN_MIN_WIDTH = 40;
/** Panel width bounds — mirrors calcSplitPanelCols in main.ts. */
const PANEL_MIN_WIDTH = 20;

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** Which handle, if any, a 0-indexed grid column lands on. */
export function hitHandle(layout: FrameLayout, gridX: number): DragHandle | null {
  if (layout.borderCol !== null && gridX === layout.borderCol) return "sidebar-edge";
  if (layout.divider !== null && gridX === layout.divider) return "panel-divider";
  return null;
}

/** Clamped sidebar width for a drag ending at `gridX`. */
export function sidebarWidthForCol(layout: FrameLayout, gridX: number): number {
  const hi = Math.max(
    SIDEBAR_MIN_WIDTH,
    Math.min(SIDEBAR_MAX_WIDTH, layout.termCols - MAIN_MIN_WIDTH),
  );
  return clamp(gridX, SIDEBAR_MIN_WIDTH, hi);
}

/** Clamped panel width for a divider drag ending at `gridX`. */
export function panelWidthForCol(
  layout: FrameLayout,
  gridX: number,
  borderWidth: number,
): number {
  const available = layout.termCols - layout.main.x;
  const hi = Math.max(PANEL_MIN_WIDTH, available - PANEL_MIN_WIDTH);
  return clamp(layout.termCols - gridX - borderWidth, PANEL_MIN_WIDTH, hi);
}

/**
 * The frame's border/divider width, recovered from a built layout. Saves
 * callers that already hold a FrameLayout (InputRouter) from having to be
 * told a constant that computeFrameLayout was already given — it is derived
 * from the same geometry, so it cannot drift from main.ts's BORDER_WIDTH.
 */
export function borderWidthOf(layout: FrameLayout): number {
  if (layout.divider !== null && layout.panel !== null) {
    return layout.panel.x - layout.divider;
  }
  if (layout.borderCol !== null) return layout.main.x - layout.borderCol;
  return 1;
}

/**
 * The nearest legal column for `handle`, derived from the same clamps as the
 * width functions so a drag and its commit can never disagree.
 */
export function clampDragCol(
  layout: FrameLayout,
  handle: DragHandle,
  gridX: number,
  borderWidth: number,
): number {
  if (handle === "sidebar-edge") return sidebarWidthForCol(layout, gridX);
  return layout.termCols - panelWidthForCol(layout, gridX, borderWidth) - borderWidth;
}
