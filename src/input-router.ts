import type { FrameLayout } from "./frame-layout";
import {
  DragController,
  borderWidthOf,
  clampDragCol,
  handleAxis,
  hitHandle,
  type DragHandle,
  type DragIntent,
} from "./drag";

export interface SgrMouseEvent {
  button: number;
  x: number;
  y: number;
  release: boolean;
}

const SGR_MOUSE_RE = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/;

/**
 * Parses a chunk that is *entirely* SGR mouse reports, or returns null if it
 * contains anything else.
 *
 * A terminal writes one report per movement, but the kernel merges pending
 * writes when the reader falls behind — and a live drag resize is exactly
 * when jmux falls behind, since each tracked movement costs a tmux resize.
 * `translateMouse` matches a single anchored report, as did the per-event
 * parsing this replaced, so a merged chunk read as "not a mouse event": it
 * was handled as keystrokes, leaking raw escape bytes into the pty (and,
 * once drag landed, cancelling the drag mid-gesture).
 *
 * handleInput uses this to split a merged chunk and re-enter once per report,
 * so every mouse path downstream — drag, sidebar, toolbar, glass, panel, and
 * tmux forwarding — keeps seeing exactly one event at a time.
 */
export function parseSgrMouseChunk(chunk: string): SgrMouseEvent[] | null {
  const re = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
  const events: SgrMouseEvent[] = [];
  let pos = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(chunk)) !== null) {
    if (match.index !== pos) return null; // a gap means non-mouse bytes
    events.push({
      button: parseInt(match[1], 10),
      x: parseInt(match[2], 10),
      y: parseInt(match[3], 10),
      release: match[4] === "m",
    });
    pos = re.lastIndex;
  }
  if (events.length === 0 || pos !== chunk.length) return null;
  return events;
}

export function translateMouse(
  seq: string,
  xOffset: number,
  yOffset = 0,
): string | null {
  const match = seq.match(SGR_MOUSE_RE);
  if (!match) return null;
  const newX = parseInt(match[2], 10) - xOffset;
  const newY = parseInt(match[3], 10) - yOffset;
  if (newX <= 0 || newY <= 0) return null;
  return `\x1b[<${match[1]};${newX};${newY}${match[4]}`;
}

export interface InputRouterOptions {
  onPtyData: (data: string) => void;
  onSidebarClick: (row: number, col: number) => void;
  onSidebarScroll?: (delta: number) => void;
  onToolbarClick?: (col: number) => void;
  // Chrome footer row — see classifyRow. col is the 0-indexed absolute grid
  // column (the footer band spans the full terminal width, joining the
  // sidebar divider, so it is not relative to layout.main.x).
  onFooterClick?: (col: number) => void;
  onHover?: (target: { area: "sidebar"; row: number } | { area: "toolbar"; col: number } | { area: "handle"; handle: DragHandle } | null) => void;
  // Drag handles — the sidebar border, the split panel divider, and the info
  // panel's list/detail separator. `pos` is the already-clamped 0-indexed
  // grid position on that handle's own axis (a column for the two vertical
  // edges, a row for the horizontal split — see handleAxis), so a drag can
  // never report a position the commit would refuse. onDragMove fires per
  // tracked pointer movement; throttling whatever it triggers is the
  // consumer's business, not the router's.
  onDragMove?: (handle: DragHandle, pos: number) => void;
  onDragCommit?: (handle: DragHandle, pos: number) => void;
  onDragCancel?: (handle: DragHandle) => void;
  /**
   * Geometry of the info panel's list/detail separator, in *absolute* grid
   * rows, or null when there isn't one (diff tab, panel closed, or a panel
   * too short for a detail pane). The panel owns its own internal row layout
   * — FrameLayout only knows the panel's column span — so the router is told
   * where the separator is rather than deriving it. Same shape of dependency
   * as glassStripRows.
   */
  panelSplit?: () => { row: number; minRow: number; maxRow: number } | null;
  onModalInput?: (data: string) => void;
  onModalToggle?: () => void;
  // Ctrl-a ? — the keyboard-help overlay. Also reachable by mouse from the
  // toolbar's `?` button, which is the path that needs no prior knowledge of
  // the prefix concept at all.
  onHelp?: () => void;
  onNewSession?: () => void;
  onSettings?: () => void;
  onCaptureIssue?: () => void;
  onStartUpNext?: () => void;
  onUndoTransition?: () => void;
  onSettingsScreen?: () => void;  // Ctrl-a I (uppercase) — full settings screen
  // Ctrl-a W (uppercase) — the workflow screen. Uppercase because tmux binds
  // lowercase `w` to choose-tree and jmux never unbinds it.
  onWorkflowScreen?: () => void;
  onGroupCycle?: () => void;      // Ctrl-a G — cycle sidebar group mode
  onSortCycle?: () => void;       // Ctrl-a s — cycle sidebar sort mode
  onFilterCycle?: () => void;     // Ctrl-a f — cycle sidebar filter mode
  onBrowserPane?: () => void;     // Ctrl-a b — open a terminal-browser pane
  onSidebarToggle?: () => void;   // Ctrl-a \ — hide/show the sidebar
  /**
   * True while a full-screen surface (settings, workflow, ghost preview) owns
   * input. Those set `modalOpen`, which otherwise kills every chord — right
   * for chords aimed at the surface, wrong for the ones aimed at the chrome
   * drawn around it. See the surface arm in handleInput.
   *
   * Deliberately not true for ordinary modals: a modal is a transient question
   * over the frame, and the sidebar is not what you are looking at.
   */
  fullScreenSurfaceActive?: () => boolean;
  onSessionPrev?: () => void;
  onSessionNext?: () => void;
  // Pane-of-glass (Overview) additions
  glassActive?: () => boolean;                       // true while the glass is shown
  onGlassClick?: (x: number, y: number) => void;     // content-relative click → focus tile
  onGlassMouse?: (x: number, y: number, button: number, release: boolean) => void; // wheel/scroll → tile under cursor
  onGlassFocusMove?: (dir: "left" | "right" | "up" | "down") => void; // Shift+arrows
  onGlassDetach?: () => void;                        // prefix+d in glass → detach jmux, not the focused tile
  onGlassTabSwitch?: (index: number) => void;       // glass-only Ctrl-a <n> → switch tab
  onGlassTabRelative?: (delta: number) => void;     // glass-only Ctrl-a [ / ] → prev/next tab
  glassStripRows?: () => number;                    // tab-strip row count (0 when hidden)
  onGlassTabClick?: (x: number) => void;            // content-relative click on the strip row
  // Diff panel additions
  onDiffPanelData?: (data: string) => void;
  onDiffPanelFocusToggle?: () => void;
  /** Expand or collapse the current session's issue list in the sidebar. */
  onToggleSessionIssues?: () => void;
  onFixWorkflowDrift?: () => void;
  onDiffToggle?: () => void;
  onDiffZoom?: () => void;  // Ctrl-a z when diff panel is focused — toggles split/full
  onDiffSendReview?: () => void;  // Ctrl-a r — hunk review notes → this session's agent
  onDiffViewPicker?: () => void;  // Ctrl-a v — pick the changeset the Diff tab shows
  onPaneNavRight?: () => void;  // Shift+Right when diff panel is open — main.ts queries pane_at_right
  // Info panel tab / action callbacks
  onPanelPrevTab?: () => void;
  onPanelNextTab?: () => void;
  /** Step the detail pane's preview strip — `{` / `}`. */
  onPanelPrevPreview?: () => void;
  onPanelNextPreview?: () => void;
  onPanelAction?: (key: string) => void;
  onPanelTabClick?: (col: number) => void; // col relative to panel start
  /** Row and column relative to the panel's content origin (after the toolbar,
   * right of the panel's left edge). main.ts resolves both against the layout. */
  onPanelItemClick?: (row: number, col: number) => void;
  onPanelTabHover?: (col: number) => void; // col relative to panel start, for hover detection
  onPanelScroll?: (delta: number, row: number) => void; // wheel scroll in panel area, row relative to content
  onPanelSelectPrev?: () => void;
  onPanelSelectNext?: () => void;
  onPanelEditFilter?: () => void;
  onPanelCycleGroupBy?: () => void;
  onPanelCycleSubGroupBy?: () => void;
  onPanelCycleSortBy?: () => void;
  onPanelToggleSortOrder?: () => void;
  onPanelToggleCollapse?: () => void;
  onPanelCreateSession?: () => void;  // 'n' key
  onPanelLinkToSession?: () => void;  // 'l' key
  onPanelToggleCheck?: () => void;    // space — tick the highlighted item
  /** True when the active view has ticked items, so Escape clears them first. */
  panelHasChecks?: () => boolean;
  onPanelClearChecks?: () => void;
  onPanelFilterStart?: () => void;
  onPanelFilterInput?: (char: string) => void;
  onPanelFilterBackspace?: () => void;
  onPanelFilterClear?: () => void;
  onPanelRefresh?: () => void;
  // Link clicking — jmux opens links itself rather than relying on the
  // terminal's (fragile, per-terminal) mouse-capture bypass. getLinkAt looks up
  // a rendered cell's URL by absolute 0-indexed grid coords; onOpenLink hands it
  // off to the OS opener.
  getLinkAt?: (x: number, y: number) => string | undefined;
  onOpenLink?: (url: string) => void;
}

export class InputRouter {
  private opts: InputRouterOptions;
  private layout: FrameLayout;
  private modalOpen = false;
  private prefixSeen = false;
  private prefixTimer: ReturnType<typeof setTimeout> | null = null;
  private glassPrefixDeferred = false;
  private surfacePrefixDeferred = false;
  private diffPanelFocused = false;
  private panelTabsActive = false;
  private panelFilterActive = false;
  private drag = new DragController();
  constructor(opts: InputRouterOptions, layout: FrameLayout) {
    this.opts = opts;
    this.layout = layout;
  }

  /**
   * Turns a DragController intent into callbacks. `click` is where a handle's
   * non-drag behaviour lives, now that a press on a handle is ambiguous until
   * the next event: the divider's focus toggle fires here, on
   * release-without-motion, rather than on press. The sidebar edge has no
   * click behaviour, so a bare click there is deliberately inert — same as
   * before this feature, when border-column clicks were swallowed by
   * translateMouse returning null.
   */
  private dispatchDrag(intent: DragIntent): void {
    switch (intent.type) {
      case "none":
        return;
      case "click":
        // The divider toggles focus; the split only ever *acquires* it, which
        // is what a press anywhere else in the panel does (see the focus
        // acquisition below). Without this, clicking the separator — a press
        // the drag handler consumes before that code runs — would silently
        // stop focusing the panel.
        if (intent.handle === "panel-divider") this.opts.onDiffPanelFocusToggle?.();
        else if (intent.handle === "panel-split" && !this.diffPanelFocused) {
          this.opts.onDiffPanelFocusToggle?.();
        }
        return;
      case "move":
        this.opts.onDragMove?.(intent.handle, intent.pos);
        return;
      case "commit":
        this.opts.onDragCommit?.(intent.handle, intent.pos);
        return;
      case "cancel":
        this.opts.onDragCancel?.(intent.handle);
        return;
    }
  }

  /**
   * The info panel's list/detail separator, when the pointer is on it. Unlike
   * the two frame edges this is a *horizontal* handle, so it hit-tests on the
   * row — but it still has to be inside the panel's columns, or the same row
   * over the terminal or the sidebar would grab it.
   */
  private hitPanelSplit(gridX: number, gridY: number): DragHandle | null {
    const panel = this.layout.panel;
    if (panel === null || gridX < panel.x) return null;
    const split = this.opts.panelSplit?.();
    if (split == null || gridY !== split.row) return null;
    return "panel-split";
  }

  /**
   * The nearest legal position for `handle`, on that handle's own axis (see
   * handleAxis). Clamping here rather than in main.ts keeps a drag from ever
   * reporting a position the frame would refuse — the handle tracks the
   * pointer right up to its limit and then simply stops.
   */
  private clampDragPos(handle: DragHandle, gridX: number, gridY: number): number {
    if (handleAxis(handle) === "x") {
      return clampDragCol(this.layout, handle, gridX, borderWidthOf(this.layout));
    }
    const split = this.opts.panelSplit?.();
    if (split == null) return gridY;
    return Math.max(split.minRow, Math.min(split.maxRow, gridY));
  }

  /**
   * Ends any in-flight drag. Called by main.ts from the SIGWINCH handler: a
   * terminal resize invalidates the geometry the drag was hit-tested against,
   * and the handle the user grabbed may not exist at the new size.
   *
   * Deliberately NOT called from every relayout — a live drag relayouts on
   * each tracked movement, and cancelling there would abort the drag on its
   * own first motion. Mode changes (settings, Command Center) can't strand a
   * drag either: reaching them requires a keystroke, which already aborts.
   */
  cancelDrag(): void {
    this.dispatchDrag(this.drag.abort());
  }

  /**
   * Single source of truth for the frame's column/row geometry — see
   * src/frame-layout.ts. Replaces the five geometry setters this router used
   * to expose (setSidebarVisible/setMainCols/setDiffPanel(cols)/setToolbarRows
   * and the constructor's sidebarCols), which could be updated independently
   * of one another and drift out of sync with the actual rendered frame.
   * All hit-testing below reads `this.layout` directly.
   */
  setLayout(layout: FrameLayout): void {
    this.layout = layout;
  }

  setModalOpen(open: boolean): void {
    this.modalOpen = open;
  }

  /**
   * Classifies a 1-indexed SGR mouse row against the frame's chrome bands
   * (see src/frame-layout.ts). Rule and footer rows span the full terminal
   * width — including over the sidebar's column range — so this is a
   * row-only classification; it is checked before any column-based routing
   * (sidebar/toolbar/panel/main) in handleInput. With both chrome flags off
   * (today's production wiring) topRuleRow/footerRuleRow/footerRow are all
   * null, row can never equal null, and every row below toolbarRows falls
   * through to "content" — unchanged from pre-chrome behaviour.
   */
  classifyRow(y1: number): "toolbar" | "rule" | "content" | "footer" {
    const row = y1 - 1;
    const layout = this.layout;
    if (row < layout.toolbarRows) return "toolbar";
    if (row === layout.topRuleRow || row === layout.footerRuleRow) return "rule";
    if (row === layout.footerRow) return "footer";
    return "content";
  }

  /** Diff-panel keyboard focus. Geometry lives in `layout.panel` (setLayout); this is the one piece of diff-panel state that isn't geometry. */
  setPanelFocused(focused: boolean): void {
    this.diffPanelFocused = focused;
  }

  setPanelTabsActive(active: boolean): void {
    this.panelTabsActive = active;
  }

  setPanelFilterActive(active: boolean): void {
    this.panelFilterActive = active;
  }

  handleInput(data: string): void {
    // A terminal writes one mouse report per event, but the kernel merges
    // pending writes whenever the reader falls behind — and a live drag
    // resize, which costs a tmux resize per tracked movement, is exactly when
    // jmux falls behind. Every mouse path below (and translateMouse) matches a
    // single anchored report, so a merged chunk would otherwise parse as "not
    // a mouse event" and be handled as keystrokes: raw escape bytes into the
    // pty, and a cancelled drag. Split it and handle each report on its own.
    const reports = parseSgrMouseChunk(data);
    if (reports !== null && reports.length > 1) {
      for (const report of reports) {
        this.handleInput(
          `\x1b[<${report.button};${report.x};${report.y}${report.release ? "m" : "M"}`,
        );
      }
      return;
    }

    // Parsed once, up front: whether this is a mouse sequence decides drag
    // ownership below, and every hit-test further down reuses the result.
    const mouse = reports !== null ? reports[0]! : null;

    // Non-null exactly while a drag is armed or in flight.
    const dragHandle = this.drag.activeHandle();

    // Drags leak — if the terminal loses focus or the pointer leaves the
    // window, the release never arrives. Any keystroke proves the drag is
    // over, so end it and let the key do its normal job.
    if (dragHandle !== null && mouse === null) {
      this.dispatchDrag(this.drag.abort());
    }

    // A live drag owns every mouse event, wherever the pointer has travelled:
    // one drag routinely crosses the sidebar, the main pane and the panel, and
    // ownership was settled by the press. Checked before row classification
    // and before any column routing, so a drag can't be misread as a sidebar
    // click, a hover, or pty input. A wheel is not part of a drag gesture, so
    // it aborts rather than being swallowed.
    if (mouse !== null && dragHandle !== null) {
      const isMotion = (mouse.button & 32) !== 0;
      const isWheel = (mouse.button & 64) !== 0;
      if (isWheel) {
        this.dispatchDrag(this.drag.abort());
        return;
      }
      const pos = this.clampDragPos(dragHandle, mouse.x - 1, mouse.y - 1);
      if (mouse.release) this.dispatchDrag(this.drag.release(pos));
      else if (isMotion) this.dispatchDrag(this.drag.motion(pos));
      return;
    }

    // Always-active hotkeys: Ctrl-Shift-Up/Down for session switching
    if (data === "\x1b[1;6A") {
      this.opts.onSessionPrev?.();
      return;
    }
    if (data === "\x1b[1;6B") {
      this.opts.onSessionNext?.();
      return;
    }

    // Pane-of-glass: Shift+arrows move focus between tiles (intercepted before
    // the diff-panel Shift handling and before reaching tmux).
    if (this.opts.glassActive?.() && !this.modalOpen) {
      if (data === "\x1b[1;2D") { this.opts.onGlassFocusMove?.("left"); return; }
      if (data === "\x1b[1;2C") { this.opts.onGlassFocusMove?.("right"); return; }
      if (data === "\x1b[1;2A") { this.opts.onGlassFocusMove?.("up"); return; }
      if (data === "\x1b[1;2B") { this.opts.onGlassFocusMove?.("down"); return; }
    }

    // Shift+Right/Left pane navigation integrating with diff panel
    if (this.layout.panel !== null && !this.modalOpen) {
      // Shift+Left from diff panel: unfocus back to tmux
      if (data === "\x1b[1;2D" && this.diffPanelFocused) {
        this.opts.onDiffPanelFocusToggle?.();
        return;
      }
      // Shift+Right when tmux focused: let main.ts check pane_at_right
      if (data === "\x1b[1;2C" && !this.diffPanelFocused) {
        this.opts.onPaneNavRight?.();
        return;
      }
    }

    // Ctrl-a p interception: detect prefix + p to toggle palette
    // Ctrl-a is forwarded to tmux (so other prefix bindings work),
    // but if next byte is "p" we intercept it before tmux sees it.
    //
    // A full-screen surface (settings, workflow, ghost preview) consumes
    // input, so it reaches this with `modalOpen` set — and every chord dies
    // there. That is right for chords acting on the surface's own area, and
    // wrong for the ones acting on the chrome *around* it: the sidebar is
    // painted beside all three, and the preview is the surface you reach from
    // a sidebar row, so `Ctrl-a \` going dead exactly there is the least
    // defensible place for it to. Those surfaces therefore get their own
    // narrow arm below (the Command Center has had one all along).
    const surfaceActive = this.modalOpen && this.opts.fullScreenSurfaceActive?.() === true;
    if (!this.modalOpen || surfaceActive) {
      if (this.prefixSeen) {
        this.prefixSeen = false;
        if (this.prefixTimer) { clearTimeout(this.prefixTimer); this.prefixTimer = null; }

        // Full-screen surface: only the chrome chords intercept. Anything
        // else flushes the deferred prefix and the key to the surface, so it
        // sees exactly the bytes it would have seen — same shape as the glass
        // arm below, and delimited for keymap.test.ts the same way.
        if (surfaceActive) {
          const deferred = this.surfacePrefixDeferred;
          this.surfacePrefixDeferred = false;
          // --- keymap:surface-prefix start ---
          if (data === "\\") { this.opts.onSidebarToggle?.(); return; }
          // --- keymap:surface-prefix end ---
          if (deferred) this.opts.onModalInput?.("\x01");
          this.opts.onModalInput?.(data);
          return;
        }

        // Glass owns the post-prefix byte: digits switch tabs, jmux chords
        // intercept, everything else flushes the deferred prefix to the tile.
        //
        // The sentinel comments below delimit this arm for keymap.test.ts,
        // which regexes the `data === "…"` comparisons out of the source and
        // asserts them against src/keymap.ts in both directions. A hand-kept
        // manifest array would not have caught a chord added straight to the
        // chain; reading the chain itself does. Same tactic as
        // tmux-conf.test.ts regexing the .conf files it cannot type-check.
        if (this.opts.glassActive?.()) {
          const deferred = this.glassPrefixDeferred;
          this.glassPrefixDeferred = false;
          if (data >= "1" && data <= "9") {
            this.opts.onGlassTabSwitch?.(parseInt(data, 10));
            return;
          }
          // --- keymap:glass-prefix start ---
          if (data === "[") { this.opts.onGlassTabRelative?.(-1); return; }
          if (data === "]") { this.opts.onGlassTabRelative?.(1); return; }
          if (data === "d") { this.opts.onGlassDetach?.(); return; }
          if (data === "?") { this.opts.onHelp?.(); return; }
          if (data === "p") { this.opts.onModalToggle?.(); return; }
          if (data === "n") { this.opts.onNewSession?.(); return; }
          if (data === "i") { this.opts.onSettings?.(); return; }
          if (data === "a") { this.opts.onCaptureIssue?.(); return; }
          if (data === "u") { this.opts.onStartUpNext?.(); return; }
          if (data === "Z") { this.opts.onUndoTransition?.(); return; }
          if (data === "I") { this.opts.onSettingsScreen?.(); return; }
          if (data === "W") { this.opts.onWorkflowScreen?.(); return; }
          if (data === "G") { this.opts.onGroupCycle?.(); return; }
          if (data === "s") { this.opts.onSortCycle?.(); return; }
          if (data === "f") { this.opts.onFilterCycle?.(); return; }
          if (data === "b") { this.opts.onBrowserPane?.(); return; }
          if (data === "\\") { this.opts.onSidebarToggle?.(); return; }
          // --- keymap:glass-prefix end ---
          // Not a jmux chord — flush the buffered prefix, then the key, to the tile.
          if (deferred) this.opts.onPtyData("\x01");
          this.opts.onPtyData(data);
          return;
        }

        // Non-glass: existing intercepts. Delimited for keymap.test.ts — see
        // the note on the glass arm above.
        // --- keymap:prefix start ---
        // Keyboard help. Deliberately shadows tmux's own `list-keys`, on the
        // same reasoning that lets `s` shadow choose-session: jmux already
        // replaces the thing tmux's version would show, and a raw list-keys
        // dump is precisely the wrong answer for someone who needed to press
        // this key in the first place.
        if (data === "?") {
          this.opts.onHelp?.();
          return;
        }
        if (data === "p") {
          this.opts.onModalToggle?.();
          return;
        }
        if (data === "n") {
          this.opts.onNewSession?.();
          return;
        }
        if (data === "i") {
          this.opts.onSettings?.();
          return;
        }
        // Capture: file an issue from wherever you are, without losing your place.
        // `a` not `c`: `c` is tmux's new-window and stealing it would be a
        // regression. Same reason undo is `Z` — `z` is pane/panel zoom.
        if (data === "a") {
          this.opts.onCaptureIssue?.();
          return;
        }
        // Pull the next thing off the queue rotation and start working it.
        if (data === "u") {
          this.opts.onStartUpNext?.();
          return;
        }
        // Take back the last status write, while the undo window is open.
        if (data === "Z") {
          this.opts.onUndoTransition?.();
          return;
        }
        if (data === "I") {
          this.opts.onSettingsScreen?.();
          return;
        }
        if (data === "W") {
          this.opts.onWorkflowScreen?.();
          return;
        }
        if (data === "G") {
          this.opts.onGroupCycle?.();
          return;
        }
        if (data === "s") {
          this.opts.onSortCycle?.();
          return;
        }
        if (data === "f") {
          this.opts.onFilterCycle?.();
          return;
        }
        // Browser pane. `b` rather than anything closer to "web": `w` is
        // tmux's window chooser and `B` reads as a variant of a `b` that
        // wouldn't exist.
        if (data === "b") {
          this.opts.onBrowserPane?.();
          return;
        }
        // Hide the sidebar to give the panes the whole terminal. `\` because
        // every letter that reads as "sidebar" is spoken for and tmux binds
        // nothing to it — this shadows no binding at all, jmux's or tmux's.
        if (data === "\\") {
          this.opts.onSidebarToggle?.();
          return;
        }
        if (data === "g") {
          this.opts.onDiffToggle?.();
          return;
        }
        if (data === "z" && this.diffPanelFocused && this.layout.panel !== null) {
          this.opts.onDiffZoom?.();
          return;
        }
        // Hand the review notes you left in the diff panel to the agent that
        // wrote the code. Unconditional rather than gated on the panel being
        // open: the notes live in hunk, not in the panel's visibility, and
        // requiring the panel to be focused would mean reopening it just to
        // send a review you already finished writing.
        if (data === "r") {
          this.opts.onDiffSendReview?.();
          return;
        }
        if (data === "v") {
          this.opts.onDiffViewPicker?.();
          return;
        }
        if (data === "\t" && this.layout.panel !== null) {
          this.opts.onDiffPanelFocusToggle?.();
          return;
        }
        // Disclose the current session's issue list in the sidebar. The click
        // affordance is the badge itself; this is the keyboard half, and jmux
        // is keyboard-first enough that a click-only reveal would put the list
        // out of reach of the people most likely to be living in it.
        if (data === "e") {
          this.opts.onToggleSessionIssues?.();
          return;
        }
        // Move the current session's issues where the workflow says they
        // should be. `m` is tmux's mark-pane, which this shadows — the same
        // trade `n` and `p` already make against next-window and
        // previous-window, and mark-pane is a far quieter loss than either.
        if (data === "m") {
          this.opts.onFixWorkflowDrift?.();
          return;
        }
        // --- keymap:prefix end ---
        // When diff panel is focused, swallow unrecognized post-prefix keys
        if (this.diffPanelFocused && this.layout.panel !== null) {
          return;
        }
        // Not intercepted — forward to PTY normally (tmux handles its prefix binding)
      } else if (data === "\x01") {
        this.prefixSeen = true;
        this.prefixTimer = setTimeout(() => {
          this.prefixSeen = false;
          this.prefixTimer = null;
          this.glassPrefixDeferred = false;
          this.surfacePrefixDeferred = false;
        }, 2000);
        if (surfaceActive) {
          // Same deferral as glass: the next byte decides whether this was a
          // chrome chord or a key the surface itself wanted.
          this.surfacePrefixDeferred = true;
        } else if (this.opts.glassActive?.()) {
          // In glass, defer the prefix: the next byte decides whether it's a
          // jmux action, a tab digit, or a real in-tile prefix chord.
          this.glassPrefixDeferred = true;
        } else if (!this.diffPanelFocused || this.layout.panel === null) {
          this.opts.onPtyData(data);
        }
        return;
      }
    }

    // Check for SGR mouse events. Grid-space conversion happens exactly once,
    // here — `gridX`/`gridY` are 0-indexed and every hit-test below reads
    // spans off `this.layout` rather than recomputing offsets from scattered
    // fields (see src/frame-layout.ts).
    //
    // A missing sidebar is a sidebar of zero columns, not a reason to stop
    // classifying. This block used to be gated on `layout.sidebar` outright,
    // on the reading that null meant "the terminal is too narrow for jmux's
    // chrome" — but `Ctrl-a \` hides the sidebar with every other piece of
    // chrome still on screen, and the gate took the toolbar's buttons, the
    // panel's tabs, link clicks, hover and the divider drag down with it.
    // Every test below reads `sidebarCols`, which is 0 in that case, so the
    // sidebar's own branches fall through on arithmetic rather than needing a
    // second path.
    const layout = this.layout;
    if (mouse) {
      const sidebarCols = layout.sidebar?.w ?? 0;
      const gridX = mouse.x - 1;
      const gridY = mouse.y - 1;
      const isMotion = (mouse.button & 32) !== 0;
      const isWheel = (mouse.button & 64) !== 0;

      // Chrome rule/footer rows span the full terminal width (they join the
      // sidebar divider — see docs/superpowers/plans/2026-07-23-chrome-frame.md
      // Tasks 5-6), so they're classified and routed here, before any
      // column-based routing (sidebar/toolbar/panel/main) gets a look. Rule
      // rows are purely decorative chrome: inert, swallowed outright. The
      // footer row dispatches a bare click to onFooterClick with the
      // absolute grid column, then is likewise consumed. With both chrome
      // flags off (today's production wiring) these rows are never present,
      // so classifyRow always returns "toolbar" or "content" here and this
      // block never fires — no behaviour change yet.
      const rowKind = this.classifyRow(mouse.y);
      if (rowKind === "rule") return;
      if (rowKind === "footer") {
        if (!mouse.release && !isMotion && !isWheel) {
          this.opts.onFooterClick?.(gridX);
        }
        return;
      }

      // Dispatch hover on any motion event. Drag handles are checked first:
      // they're one column wide, so a hover highlight is the entire
      // discovery mechanism (a terminal can't change the cursor shape over a
      // region the way a GUI would).
      if (isMotion && this.opts.onHover) {
        const hoverHandle = this.modalOpen
          ? null
          : hitHandle(layout, gridX) ?? this.hitPanelSplit(gridX, gridY);
        if (hoverHandle) {
          this.opts.onHover({ area: "handle", handle: hoverHandle });
        } else if (gridX < sidebarCols) {
          this.opts.onHover({ area: "sidebar", row: gridY });
        } else if (!this.modalOpen) {
          if (gridY < layout.toolbarRows) {
            this.opts.onHover({ area: "toolbar", col: gridX - layout.main.x });
          } else {
            this.opts.onHover(null);
          }
        }
      }

      // Link click: a clean left-click on a rendered link cell opens the URL
      // directly. jmux owns this rather than depending on the terminal's
      // mouse-capture bypass (which varies per terminal and has historically
      // drifted out of working). Checked before area routing so it works in the
      // main pane, glass tiles, diff and panels alike — getLinkAt reads the
      // composited grid by absolute coords. Only a bare left button event (no
      // motion/drag, not wheel) over the content area qualifies, so drag-to-
      // select and sidebar/toolbar clicks are untouched. The press opens; the
      // matching release over the same link cell is swallowed so tmux never
      // sees a stray event.
      if (
        !this.modalOpen &&
        gridX >= sidebarCols &&
        !isMotion &&
        !isWheel &&
        (mouse.button & 0x03) === 0
      ) {
        const url = this.opts.getLinkAt?.(gridX, gridY);
        if (url) {
          if (!mouse.release) this.opts.onOpenLink?.(url);
          return;
        }
      }

      // Drag handles: a bare left press on the sidebar border column or the
      // split panel divider arms a drag. It commits nothing — whether this is
      // a click or a drag isn't knowable until the next event (see src/drag.ts).
      // Checked before the sidebar/toolbar/panel routing below so the handle
      // columns belong to the drag; both sit outside the sidebar's own column
      // range, so no session row loses a click to this.
      if (
        !this.modalOpen &&
        !isMotion &&
        !isWheel &&
        !mouse.release &&
        (mouse.button & 0x03) === 0
      ) {
        const handle = hitHandle(layout, gridX) ?? this.hitPanelSplit(gridX, gridY);
        if (handle) {
          this.drag.press(handle, this.clampDragPos(handle, gridX, gridY));
          return;
        }
      }

      if (gridX < sidebarCols) {
        // Wheel events: button 64 = up, 65 = down
        if (isWheel) {
          const delta = (mouse.button & 1) ? 3 : -3;
          this.opts.onSidebarScroll?.(delta);
          return;
        }
        // Click in sidebar region (ignore drags/motion). Both are 0-indexed
        // grid coordinates within the sidebar (col 0 is its left edge).
        if (!mouse.release && !isMotion) {
          this.opts.onSidebarClick(gridY, gridX);
        }
        return; // Consume sidebar mouse events
      }

      // When modal is open, forward wheel events as arrow keys, ignore other mouse events
      if (this.modalOpen) {
        if (isWheel) {
          this.opts.onModalInput?.((mouse.button & 1) ? "\x1b[B" : "\x1b[A");
        }
        return;
      }

      // Pane-of-glass: forward mouse to the tile under the cursor so wheel
      // scrollback, copy-mode text selection (press→drag→release), and app
      // mouse interaction all work. A fresh press also focuses that tile.
      // Checked before toolbar so that glass strip row 1 isn't eaten by the
      // toolbar handler (there is no toolbar visible in glass mode).
      if (this.opts.glassActive?.()) {
        const stripRows = this.opts.glassStripRows?.() ?? 0;
        const cx = gridX - layout.main.x;
        const yInContent = gridY; // 0-indexed within the content column
        const bareMotion = isMotion && (mouse.button & 0x03) === 3;
        if (bareMotion) return; // ignore hover motion (no button held)

        // Strip row: a button-down switches tabs; ignore wheel/release/motion here.
        if (yInContent < stripRows) {
          if (!mouse.release && !isMotion && !isWheel) {
            this.opts.onGlassTabClick?.(cx);
          }
          return;
        }

        const cy = yInContent - stripRows; // tile-area row
        if (!mouse.release && !isMotion && !isWheel) {
          this.opts.onGlassClick?.(cx, cy); // focus on button-down
        }
        this.opts.onGlassMouse?.(cx, cy, mouse.button, mouse.release);
        return;
      }

      // Toolbar click — rows within layout.toolbarRows, anywhere in the main area
      if (gridY < layout.toolbarRows && !mouse.release && !isMotion && !isWheel) {
        const mainCol = gridX - layout.main.x; // 0-indexed in main area
        this.opts.onToolbarClick?.(mainCol);
        return;
      }

      // Diff panel mouse handling. `layout.panel` is set in both split and
      // full mode; full mode has no divider and `panel.x === main.x` (the
      // panel overlaps main rather than sitting after it), so the single
      // `gridX >= layout.panel.x` test below unifies both modes — a
      // content-area click in full mode routes to the panel, not to main.
      if (layout.panel) {
        // The divider's focus toggle used to fire here, on press. It now fires
        // on release-without-motion, via the drag controller's `click` intent
        // (see dispatchDrag) — a press on the divider is ambiguous between a
        // click and the start of a resize drag, so it can't commit anything.
        // The press itself is consumed by the handle check above.

        if (gridX >= layout.panel.x) {
          const panelCol = gridX - layout.panel.x; // 0-indexed in panel

          // Panel tab bar — first row of the panel area (toolbar row)
          if (gridY === 0) {
            if (isMotion) {
              this.opts.onPanelTabHover?.(panelCol);
            } else if (!mouse.release && !isWheel) {
              this.opts.onPanelTabClick?.(panelCol);
            }
            return;
          }

          // Click in panel acquires keyboard focus
          if (!mouse.release && !isMotion && !isWheel && !this.diffPanelFocused) {
            this.opts.onDiffPanelFocusToggle?.();
          }

          // Non-diff tab: wheel scrolls the view
          if (this.panelTabsActive && isWheel) {
            const delta = (mouse.button & 1) ? 3 : -3;
            const panelRow = gridY - layout.contentTop;
            this.opts.onPanelScroll?.(delta, panelRow);
            return;
          }

          // Non-diff tab: clicks in list area select items
          if (this.panelTabsActive && !mouse.release && !isMotion && !isWheel) {
            const panelRow = gridY - layout.contentTop;
            if (panelRow >= 0) {
              // main.ts routes this against the layout: list rows, or the
              // detail pane's preview strip.
              this.opts.onPanelItemClick?.(panelRow, gridX - layout.panel.x);
            }
            return;
          }

          if (isMotion && (mouse.button & 0x03) === 3) return; // bare motion, skip
          const translated = translateMouse(data, layout.panel.x, layout.contentTop);
          if (translated) {
            this.opts.onDiffPanelData?.(translated);
          }
          return;
        }
      }

      // Mouse in main area — translate X coordinate and Y (offset by the
      // first content row, layout.contentTop — not layout.toolbarRows, which
      // undercounts by the top rule row once chrome rules are enabled).
      // Click in main area releases diff panel focus
      if (!mouse.release && !isMotion && !isWheel && this.diffPanelFocused && layout.panel) {
        this.opts.onDiffPanelFocusToggle?.();
      }
      // Don't forward bare motion events to PTY (too noisy)
      if (isMotion && (mouse.button & 0x03) === 3) return;
      const mainTranslated = translateMouse(data, layout.main.x, layout.contentTop);
      if (mainTranslated) {
        this.opts.onPtyData(mainTranslated);
      }
      return;
    }

    // When palette is open, route keyboard input to palette callback
    if (this.modalOpen) {
      this.opts.onModalInput?.(data);
      return;
    }

    // When diff panel is focused, intercept tab-switching and action keys before
    // forwarding to the diff panel's underlying process
    if (this.diffPanelFocused && this.layout.panel !== null) {
      // Tab switching — clear filter mode first
      if (data === "[" && this.opts.onPanelPrevTab) {
        if (this.panelFilterActive) { this.panelFilterActive = false; this.opts.onPanelFilterClear?.(); }
        this.opts.onPanelPrevTab();
        return;
      }
      if (data === "]" && this.opts.onPanelNextTab) {
        if (this.panelFilterActive) { this.panelFilterActive = false; this.opts.onPanelFilterClear?.(); }
        this.opts.onPanelNextTab();
        return;
      }

      // Filter mode — captures all input when active
      if (this.panelTabsActive && this.panelFilterActive) {
        // Arrow navigation still works during filter
        if (data === "\x1b[A" && this.opts.onPanelSelectPrev) { this.opts.onPanelSelectPrev(); return; }
        if (data === "\x1b[B" && this.opts.onPanelSelectNext) { this.opts.onPanelSelectNext(); return; }
        // Enter confirms filter — exit input capture but keep filterQuery
        if (data === "\r") { this.panelFilterActive = false; return; }
        // Esc clears filter and exits filter mode
        if (data === "\x1b") { this.panelFilterActive = false; this.opts.onPanelFilterClear?.(); return; }
        // Backspace removes last char
        if (data === "\x7f") { this.opts.onPanelFilterBackspace?.(); return; }
        // Printable chars append to filter query
        if (data.length === 1 && data.charCodeAt(0) >= 32) { this.opts.onPanelFilterInput?.(data); return; }
        // Everything else consumed
        return;
      }

      // Up/Down arrow for item selection within a tab (only on MR/Issues tabs)
      if (this.panelTabsActive) {
        if (data === "\x1b[A" && this.opts.onPanelSelectPrev) {
          this.opts.onPanelSelectPrev();
          return;
        }
        if (data === "\x1b[B" && this.opts.onPanelSelectNext) {
          this.opts.onPanelSelectNext();
          return;
        }
      }
      if (this.panelTabsActive) {
        // Esc clears the most recent transient state first: ticks, then the
        // persisted filter. Clearing the filter out from under a half-made
        // selection would throw away the more expensive of the two.
        if (data === "\x1b" && this.opts.panelHasChecks?.() && this.opts.onPanelClearChecks) {
          this.opts.onPanelClearChecks();
          return;
        }
        if (data === "\x1b" && this.opts.onPanelFilterClear) { this.opts.onPanelFilterClear(); return; }
        if (data === " " && this.opts.onPanelToggleCheck) { this.opts.onPanelToggleCheck(); return; }
        if (data === "g" && this.opts.onPanelCycleGroupBy) { this.opts.onPanelCycleGroupBy(); return; }
        if (data === "G" && this.opts.onPanelCycleSubGroupBy) { this.opts.onPanelCycleSubGroupBy(); return; }
        if (data === "/" && this.opts.onPanelFilterStart) { this.panelFilterActive = true; this.opts.onPanelFilterStart(); return; }
        if (data === "S" && this.opts.onPanelCycleSortBy) { this.opts.onPanelCycleSortBy(); return; }
        if (data === "?" && this.opts.onPanelToggleSortOrder) { this.opts.onPanelToggleSortOrder(); return; }
        // Membership filter (states / stages / labels / priority) — the axes
        // that turn a generic list into a named pull queue.
        if (data === "F" && this.opts.onPanelEditFilter) { this.opts.onPanelEditFilter(); return; }
        if (data === "r" && this.opts.onPanelRefresh) { this.opts.onPanelRefresh(); return; }
        if (data === "\r" && this.opts.onPanelToggleCollapse) { this.opts.onPanelToggleCollapse(); return; }
        if (data === "n" && this.opts.onPanelCreateSession) { this.opts.onPanelCreateSession(); return; }
        if (data === "l" && this.opts.onPanelLinkToSession) { this.opts.onPanelLinkToSession(); return; }
        // Preview tabs, shifted from the queue-tab keys beside them: `[`/`]`
        // move between queues, `{`/`}` between the issues of the set you are
        // looking at. Same gesture, one level in.
        if (data === "{" && this.opts.onPanelPrevPreview) { this.opts.onPanelPrevPreview(); return; }
        if (data === "}" && this.opts.onPanelNextPreview) { this.opts.onPanelNextPreview(); return; }
      }
      if (this.panelTabsActive && this.opts.onPanelAction && (data === "o" || data === "a" || data === "s" || data === "c" || data === "C" || data === "p")) {
        this.opts.onPanelAction(data);
        return;
      }
      this.opts.onDiffPanelData?.(data);
      return;
    }

    // Default: pass through to PTY
    this.opts.onPtyData(data);
  }
}
