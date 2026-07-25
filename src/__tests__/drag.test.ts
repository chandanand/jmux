import { describe, test, expect } from "bun:test";
import {
  DragController,
  hitHandle,
  sidebarWidthForCol,
  panelWidthForCol,
  clampDragCol,
} from "../drag";
import { computeFrameLayout, type FrameLayout } from "../frame-layout";

// Layouts come from computeFrameLayout rather than hand-rolled Spans, so the
// geometry these functions are tested against is internally consistent — the
// same guarantee relayout() gives production code.
function layoutOf(
  over: Partial<Parameters<typeof computeFrameLayout>[0]> = {},
): FrameLayout {
  return computeFrameLayout({
    termCols: 200,
    termRows: 40,
    sidebarWidth: 26,
    borderWidth: 1,
    toolbarRows: 1,
    diffState: "off",
    requestedPanelCols: 0,
    frameRulesEnabled: false,
    footerEnabled: false,
    ...over,
  });
}

// The controller is deliberately layout-free: it classifies press/motion/
// release into intents and nothing else. Columns are whatever the caller
// passes (InputRouter clamps them first), so these tests use bare numbers.

describe("DragController", () => {
  test("a press alone emits nothing but takes ownership", () => {
    const d = new DragController();
    expect(d.press("sidebar-edge", 26)).toEqual({ type: "none" });
    // Armed counts as active: the router must keep routing mouse events here
    // through the ambiguous window before we know if it's a click or a drag.
    expect(d.activeHandle()).not.toBeNull();
  });

  test("press then release with no motion is a click", () => {
    const d = new DragController();
    d.press("panel-divider", 80);
    expect(d.release(80)).toEqual({ type: "click", handle: "panel-divider" });
    expect(d.activeHandle()).toBeNull();
  });

  test("motion at the origin column does not promote to a drag", () => {
    const d = new DragController();
    d.press("sidebar-edge", 26);
    expect(d.motion(26)).toEqual({ type: "none" });
    // Still a click if released here.
    expect(d.release(26)).toEqual({ type: "click", handle: "sidebar-edge" });
  });

  test("motion to a new column promotes to a drag and emits a move", () => {
    const d = new DragController();
    d.press("sidebar-edge", 26);
    expect(d.motion(30)).toEqual({ type: "move", handle: "sidebar-edge", pos: 30 });
  });

  test("further motion keeps emitting moves, including back to the origin", () => {
    const d = new DragController();
    d.press("sidebar-edge", 26);
    d.motion(30);
    expect(d.motion(34)).toEqual({ type: "move", handle: "sidebar-edge", pos: 34 });
    // Dragging back over the origin still tracks — only *promotion* required
    // leaving the origin, not staying away from it.
    expect(d.motion(26)).toEqual({ type: "move", handle: "sidebar-edge", pos: 26 });
  });

  test("repeated motion at the same column emits nothing (no redundant resize)", () => {
    const d = new DragController();
    d.press("sidebar-edge", 26);
    d.motion(30);
    expect(d.motion(30)).toEqual({ type: "none" });
  });

  test("release after motion commits at the release column", () => {
    const d = new DragController();
    d.press("sidebar-edge", 26);
    d.motion(30);
    expect(d.release(31)).toEqual({ type: "commit", handle: "sidebar-edge", pos: 31 });
    expect(d.activeHandle()).toBeNull();
  });

  test("abort mid-drag cancels and resets", () => {
    const d = new DragController();
    d.press("panel-divider", 80);
    d.motion(70);
    expect(d.abort()).toEqual({ type: "cancel", handle: "panel-divider" });
    expect(d.activeHandle()).toBeNull();
  });

  test("abort while merely armed also cancels", () => {
    const d = new DragController();
    d.press("panel-divider", 80);
    expect(d.abort()).toEqual({ type: "cancel", handle: "panel-divider" });
    expect(d.activeHandle()).toBeNull();
  });

  test("abort while idle is a no-op", () => {
    const d = new DragController();
    expect(d.abort()).toEqual({ type: "none" });
  });

  test("motion and release while idle are no-ops", () => {
    const d = new DragController();
    expect(d.motion(10)).toEqual({ type: "none" });
    expect(d.release(10)).toEqual({ type: "none" });
    expect(d.activeHandle()).toBeNull();
  });

  test("a fresh press after a completed drag starts clean", () => {
    const d = new DragController();
    d.press("sidebar-edge", 26);
    d.motion(30);
    d.release(30);
    d.press("panel-divider", 80);
    expect(d.motion(80)).toEqual({ type: "none" });
    expect(d.release(80)).toEqual({ type: "click", handle: "panel-divider" });
  });
});

describe("hitHandle", () => {
  test("the sidebar border column hits sidebar-edge", () => {
    const l = layoutOf({ sidebarWidth: 26 });
    expect(l.borderCol).toBe(26);
    expect(hitHandle(l, 26)).toBe("sidebar-edge");
  });

  test("neighbouring columns miss — handles are exactly one column wide", () => {
    const l = layoutOf({ sidebarWidth: 26 });
    expect(hitHandle(l, 25)).toBeNull();
    expect(hitHandle(l, 27)).toBeNull();
  });

  test("the divider column hits panel-divider in split mode", () => {
    const l = layoutOf({ diffState: "split", requestedPanelCols: 60 });
    expect(l.divider).not.toBeNull();
    expect(hitHandle(l, l.divider!)).toBe("panel-divider");
  });

  test("full mode has no divider, so no column hits panel-divider", () => {
    const l = layoutOf({ diffState: "full", requestedPanelCols: 173 });
    expect(l.divider).toBeNull();
    // Only the sidebar edge remains draggable.
    for (let x = 0; x < l.termCols; x++) {
      expect(hitHandle(l, x)).toBe(x === l.borderCol ? "sidebar-edge" : null);
    }
  });

  test("below SIDEBAR_MIN_TERM_COLS there is no sidebar and no handle", () => {
    const l = layoutOf({ termCols: 70 });
    expect(l.sidebar).toBeNull();
    expect(l.borderCol).toBeNull();
    for (let x = 0; x < l.termCols; x++) expect(hitHandle(l, x)).toBeNull();
  });
});

describe("sidebarWidthForCol", () => {
  test("round-trips the current geometry", () => {
    const l = layoutOf({ sidebarWidth: 26 });
    expect(sidebarWidthForCol(l, l.borderCol!)).toBe(l.sidebar!.w);
  });

  test("dragging right widens, dragging left narrows", () => {
    const l = layoutOf({ sidebarWidth: 26 });
    expect(sidebarWidthForCol(l, 40)).toBe(40);
    expect(sidebarWidthForCol(l, 15)).toBe(15);
  });

  test("clamps to the 10..60 settings range", () => {
    const l = layoutOf();
    expect(sidebarWidthForCol(l, 0)).toBe(10);
    expect(sidebarWidthForCol(l, 5)).toBe(10);
    expect(sidebarWidthForCol(l, 999)).toBe(60);
  });

  test("leaves room for main on a narrow terminal", () => {
    // termCols 80 => max sidebar is 80 - 40 = 40, not the usual 60.
    const l = layoutOf({ termCols: 80 });
    expect(sidebarWidthForCol(l, 70)).toBe(40);
  });

  test("never inverts the range on an absurdly narrow terminal", () => {
    const l = layoutOf({ termCols: 45 });
    expect(sidebarWidthForCol(l, 99)).toBe(10);
    expect(sidebarWidthForCol(l, 0)).toBe(10);
  });
});

describe("panelWidthForCol", () => {
  test("round-trips the current geometry", () => {
    const l = layoutOf({ diffState: "split", requestedPanelCols: 60 });
    expect(panelWidthForCol(l, l.divider!, 1)).toBe(l.panel!.w);
  });

  test("dragging the divider left widens the panel", () => {
    const l = layoutOf({ diffState: "split", requestedPanelCols: 60 });
    const wider = panelWidthForCol(l, l.divider! - 10, 1);
    expect(wider).toBe(l.panel!.w + 10);
  });

  test("clamps to 20 columns at each end, matching calcSplitPanelCols", () => {
    const l = layoutOf({ diffState: "split", requestedPanelCols: 60 });
    const available = l.termCols - l.main.x;
    expect(panelWidthForCol(l, l.termCols, 1)).toBe(20);
    expect(panelWidthForCol(l, 0, 1)).toBe(available - 20);
  });
});

describe("clampDragCol", () => {
  test("is the identity on a legal sidebar column", () => {
    const l = layoutOf({ sidebarWidth: 26 });
    expect(clampDragCol(l, "sidebar-edge", 40, 1)).toBe(40);
  });

  test("is the identity on a legal divider column", () => {
    const l = layoutOf({ diffState: "split", requestedPanelCols: 60 });
    expect(clampDragCol(l, "panel-divider", l.divider!, 1)).toBe(l.divider!);
  });

  test("agrees with the width clamps at the extremes", () => {
    const l = layoutOf({ diffState: "split", requestedPanelCols: 60 });
    // A drag pinned at the clamp must map back to the clamped width, or a
    // drag held past the limit would keep resizing by a column each event.
    const col = clampDragCol(l, "sidebar-edge", 999, 1);
    expect(col).toBe(60);
    expect(sidebarWidthForCol(l, col)).toBe(60);

    const dcol = clampDragCol(l, "panel-divider", l.termCols, 1);
    expect(panelWidthForCol(l, dcol, 1)).toBe(20);
  });
});

// The whole feature rests on one property: the column a drag reports is the
// column the handle actually occupies once that width is applied. If these
// ever disagree the handle drifts away from the pointer as you drag — the
// resize would lag or overshoot the mouse. Checked across every column of the
// terminal, including well past both clamps.
describe("a drag lands where the pointer is", () => {
  test("sidebar drag column === the border column after the resize", () => {
    const l = layoutOf({ sidebarWidth: 26 });
    for (let x = -5; x < l.termCols + 5; x++) {
      const tracked = clampDragCol(l, "sidebar-edge", x, 1);
      const committedWidth = sidebarWidthForCol(l, tracked);
      // computeFrameLayout puts the border at sidebar.x + sidebar.w, and
      // sidebar.x is 0 — so the committed border column IS the width.
      expect(tracked).toBe(committedWidth);
    }
  });

  test("divider drag column === the divider column after the resize", () => {
    const l = layoutOf({ diffState: "split", requestedPanelCols: 60 });
    for (let x = -5; x < l.termCols + 5; x++) {
      const tracked = clampDragCol(l, "panel-divider", x, 1);
      const committedWidth = panelWidthForCol(l, tracked, 1);
      // Rebuild the layout the commit would produce and read back its divider.
      const after = computeFrameLayout({
        termCols: l.termCols, termRows: l.termRows, sidebarWidth: l.sidebar!.w,
        borderWidth: 1, toolbarRows: 1, diffState: "split",
        requestedPanelCols: committedWidth,
        frameRulesEnabled: false, footerEnabled: false,
      });
      expect(tracked).toBe(after.divider!);
    }
  });
});
