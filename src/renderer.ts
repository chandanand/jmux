import type { Cell, CellGrid, CursorPosition, WindowTab } from "./types";
import { ColorMode } from "./types";
import { createGrid, DEFAULT_CELL, blit, textCols, writeCell, writeStyledLine, drawBox, truncateToCols, isImagePlaceholder, type CellAttrs, type StyledSegment } from "./cell-grid";
import { packChips, type PlacedChip } from "./band-layout";
import { theme, neutralFg } from "./theme";
import type { FrameLayout } from "./frame-layout";
import { tokens, frame, space } from "./chrome-tokens";
import type { DragHandle } from "./drag";
import type { ImagePlane } from "./images/plane";

export const BORDER_CHAR = "\u2502"; // │

export interface ToolbarButton {
  label: string;
  id: string;
  fg?: number;      // optional RGB color
  fgMode?: number;  // ColorMode
}

export interface ToolbarConfig {
  buttons: ToolbarButton[];
  mainCols: number;
  hoveredButton?: string | null;
  tabs?: WindowTab[];
  hoveredTabId?: string | null;
  /** When set, a dim status chip is rendered between tabs and buttons —
   * the toolbar's snapshot-health indicator (see main.ts's makeToolbar()). */
  statusChip?: string | null;
  /**
   * Name and keybinding of the button the pointer is currently over, rendered
   * in the same slot as `statusChip` when that slot is free.
   *
   * The action buttons are bare glyphs (`? + ⊟ ◫ ◨`), and a terminal has no
   * tooltip — without this there is no way to learn what one does short of
   * clicking it. Passed as its parts rather than a finished string so
   * layoutToolbar can shrink it (see fitHoverHint) instead of overflowing.
   */
  hoverHint?: { label: string; keys: string } | null;
}

// Builds the toolbar's fixed action-button set — pure, no live state beyond
// whether the diff panel is currently active (which accents the panel
// button to match). main.ts's makeToolbar() wires diffPanel.isActive()
// through here rather than building the array inline, so the glyph order
// has a test seam independent of main.ts's un-importable top-level side
// effects (main.ts spawns tmux at import time, so it can't be imported by a
// unit test). Colours route through chrome-tokens' `tokens.accent`.
//
// The set is deliberately small: the four actions whose target is the surface
// the toolbar sits on — the window strip and the pane grid beneath it — plus
// the keyboard-help button. Everything else lives in the palette (`^a p`) or
// the settings screen (`^a i`); a glyph here has to earn its column by being
// something you reach for mid-flow, not merely something jmux can do.
// Launching Claude and opening settings are both once-per-session actions with
// keyboard homes, so they no longer occupy toolbar columns. `help` earns its
// column on the opposite ground: it is the only entry point here that a user
// who knows no chords can find, which is exactly who needs it.
//
// The four actions run left to right in escalating scope — add a window, then
// subdivide the one you're in, then the panel toggle last. Buttons pack
// right-aligned (see layoutToolbar), so the panel button lands flush against
// the terminal's right edge, the side the diff panel itself docks on
// (frame-layout.ts places `panel` after the divider); `◨`'s filled right half
// points at where the panel will appear.
//
// Hovering any of them names it and its chord in the toolbar's chip slot (see
// ToolbarConfig.hoverHint) — without that the glyphs are unreadable, since a
// terminal has no tooltip and hover can only recolour.
//
// The two split glyphs are a deliberate stroke pair: `⊟` is a square with one
// horizontal stroke (panes stacked — tmux `split-window -v`), `◫` the same
// square with one vertical stroke (panes side by side — `split-window -h`).
// Both must stay single-stroke outlines of the same weight; the earlier `▤`
// came from the fill-lines family (▤▥▦) and read as a denser, smaller glyph
// than its neighbours. Every label here must also be exactly one display
// column — `layoutToolbar` packs on `textCols` and the mouse hit boxes derive
// from that packing, so a 2-column glyph would shift every button to its left.
export function buildToolbarButtons(opts: {
  panelActive: boolean;
  /**
   * Whether a browser pane can actually be opened. The button is omitted rather
   * than shown-and-refusing, because unlike the other four this one depends on
   * a program jmux does not ship: an affordance that is only ever going to
   * explain why it doesn't work has no business taking a column from the ones
   * that do. `Ctrl-a b` still answers, and says what to install.
   */
  browserAvailable?: boolean;
  /**
   * Setup steps are outstanding.
   *
   * Marked on `?` rather than on a settings button, because there is no
   * settings button and `?` is the one affordance here reachable with no prior
   * knowledge of the prefix concept — the same audience the checklist is for.
   * Rendered as the accent colour, like the panel toggle's active state, so it
   * costs no column: every label must be exactly one display cell or the mouse
   * hit boxes shift.
   *
   * Never set for a capability the user has declined; see `config.setup`.
   */
  setupPending?: boolean;
}): ToolbarButton[] {
  return [
    // The keyboard reference leads the cluster rather than joining the end of
    // it. The other four are a scope ladder (window → pane → pane → panel)
    // that `help` is not a rung of, and the panel toggle has to stay rightmost
    // because that is the side the panel docks on. Leading is the only spot
    // that costs neither. It is also the one affordance here reachable with no
    // prior knowledge of the prefix concept, which is the whole point of it.
    {
      label: "?",
      id: "help",
      fg: opts.setupPending ? tokens.accent.fg : undefined,
      fgMode: opts.setupPending ? tokens.accent.fgMode : undefined,
    },
    { label: "+", id: "new-window" },
    { label: "⊟", id: "split-h" },
    { label: "◫", id: "split-v" },
    // A pane like the two above it, so it belongs on that rung of the ladder —
    // and ahead of the panel toggle, which stays rightmost.
    ...(opts.browserAvailable ? [{ label: "⊙", id: "browser-pane" }] : []),
    {
      label: "◨",
      id: "panel",
      fg: opts.panelActive ? tokens.accent.fg : undefined,
      fgMode: opts.panelActive ? tokens.accent.fgMode : undefined,
    },
  ];
}

export function sgrForCell(cell: Cell): string {
  const parts: string[] = ["0"]; // always reset first

  if (cell.bold) parts.push("1");
  if (cell.dim) parts.push("2");
  if (cell.italic) parts.push("3");
  if (cell.underline) parts.push("4");

  // Foreground
  if (cell.fgMode === ColorMode.Palette) {
    if (cell.fg < 8) {
      parts.push(`${30 + cell.fg}`);
    } else if (cell.fg < 16) {
      parts.push(`${90 + cell.fg - 8}`);
    } else {
      parts.push(`38;5;${cell.fg}`);
    }
  } else if (cell.fgMode === ColorMode.RGB) {
    const r = (cell.fg >> 16) & 0xff;
    const g = (cell.fg >> 8) & 0xff;
    const b = cell.fg & 0xff;
    parts.push(`38;2;${r};${g};${b}`);
  }

  // Background
  if (cell.bgMode === ColorMode.Palette) {
    if (cell.bg < 8) {
      parts.push(`${40 + cell.bg}`);
    } else if (cell.bg < 16) {
      parts.push(`${100 + cell.bg - 8}`);
    } else {
      parts.push(`48;5;${cell.bg}`);
    }
  } else if (cell.bgMode === ColorMode.RGB) {
    const r = (cell.bg >> 16) & 0xff;
    const g = (cell.bg >> 8) & 0xff;
    const b = cell.bg & 0xff;
    parts.push(`48;2;${r};${g};${b}`);
  }

  return `\x1b[${parts.join(";")}m`;
}

// A placed toolbar tab carries the WindowTab alongside its geometry — the
// paint loop and the branch row both need the underlying tab, not just its id.
interface PlacedToolbarTab extends PlacedChip {
  tab: WindowTab;
}

interface ToolbarLayout {
  tabs: PlacedToolbarTab[];
  statusChip: PlacedChip | null;
  hoverHint: { x: number; width: number; text: string } | null;
  buttons: PlacedChip[];
}

/**
 * Fit a hovered button's hint into `slack` columns, shrinking rather than
 * overflowing: "Split pane left / right · ^a |" → "^a |" → nothing.
 *
 * The ladder exists because the hint must never cost a window tab. packChips
 * drops whole tabs, so a hint competing with them for width would make a tab
 * vanish and reappear as the pointer crossed the button cluster — and a
 * pointer moving over chrome must not rearrange the chrome. Callers place tabs
 * first and pass only what is left over. Same shrink ladder drawModalChrome
 * uses for title/count/hint and layoutFooter for its segments.
 */
export function fitHoverHint(
  hint: { label: string; keys: string },
  slack: number,
): string | null {
  const full = hint.keys ? `${hint.label} · ${hint.keys}` : hint.label;
  if (textCols(full) + 2 <= slack) return full;
  if (hint.keys && textCols(hint.keys) + 2 <= slack) return hint.keys;
  return null;
}

// Places the toolbar's three zones once — tabs packed left, action buttons
// packed right, and an optional status chip between them, right-aligned just
// before the buttons — so paint (compositeGrids) and hit-test
// (getToolbarTabRanges/getToolbarButtonRanges/getToolbarStatusChipRange) both
// read from this single placement rather than recomputing it independently.
// Buttons are placed first (they anchor the right edge), then the status
// chip (anchored to the buttons' left edge), then tabs (bounded by whichever
// of those sits leftmost) — mirroring the dependency order the original
// three standalone functions had.
function layoutToolbar(toolbar: ToolbarConfig): ToolbarLayout {
  // Each button's box is its glyph plus a single trailing gutter column
  // (space.glyphGutter) — no leading space. Packed contiguously (no gap/
  // sepWidth) right to left, that trailing gutter is the only blank column
  // between two adjacent glyphs, so the cluster reads as one tight group
  // (Task 7) instead of the old glyph+2 box, whose leading+trailing spaces
  // stacked into a two-column gap between buttons.
  const buttonItems = toolbar.buttons.map((b) => ({ id: b.id, width: textCols(b.label) + space.glyphGutter }));
  // No overflow guard on buttons — matches the original, which never checked
  // a budget for them either. `-Infinity` means "never overflow".
  const buttons = packChips(buttonItems, { start: toolbar.mainCols, budget: -Infinity, align: "right" });

  const buttonsStart = buttons.length > 0 ? buttons[0].x : toolbar.mainCols;

  let statusChip: PlacedChip | null = null;
  if (toolbar.statusChip) {
    // chip text is " <statusChip> " — 1 space padding each side
    const chipWidth = textCols(toolbar.statusChip) + 2;
    statusChip = packChips([{ id: "status", width: chipWidth }], {
      start: buttonsStart, budget: -Infinity, align: "right",
    })[0] ?? null;
  }

  // Reserve space for the status chip when present; tabs must not overlap it.
  const effectiveRightEdge = statusChip ? statusChip.x - 1 : buttonsStart;
  const maxCol = effectiveRightEdge - 2; // 2-col gap before buttons/chip

  const tabs = toolbar.tabs ?? [];
  const tabItems = tabs.map((tab) => ({
    id: tab.windowId,
    width: textCols(tab.name + (tab.zoomed ? " ⤢" : "")) + 2, // " name [Z] "
  }));
  const placedTabs = tabs.length === 0
    ? []
    // Two blank columns (space.groupGutter) between non-last tabs — the
    // underline (Task 5) now delimits tabs, so no "│" glyph is painted here.
    : packChips(tabItems, { start: 1, budget: maxCol, align: "left", sepWidth: space.groupGutter });

  const placedToolbarTabs: PlacedToolbarTab[] = placedTabs.map((c) => ({
    ...c,
    tab: tabs.find((t) => t.windowId === c.id)!,
  }));

  // The hover hint is placed *after* tabs, into whatever room they left, and
  // only when the status chip has not already claimed the slot. Placing it
  // last is the whole point: tabs are packed against exactly the same budget
  // whether a button is hovered or not, so hovering can never reflow them.
  // A real status chip (an undo window, a toast, a degraded snapshot) outranks
  // it — all three are things that happened, and this is only a label for
  // something the pointer is resting on.
  let hoverHint: ToolbarLayout["hoverHint"] = null;
  if (!statusChip && toolbar.hoverHint) {
    const lastTab = placedTabs[placedTabs.length - 1];
    const tabsEnd = lastTab ? lastTab.x + lastTab.width : 1;
    const slack = buttonsStart - tabsEnd;
    const text = fitHoverHint(toolbar.hoverHint, slack);
    if (text) {
      const width = textCols(text) + 2; // " text "
      hoverHint = { x: buttonsStart - width, width, text };
    }
  }

  return { tabs: placedToolbarTabs, statusChip, hoverHint, buttons };
}

// Returns the column ranges for each toolbar button (relative to main area start)
export function getToolbarButtonRanges(toolbar: ToolbarConfig): Array<{ id: string; startCol: number; endCol: number }> {
  return layoutToolbar(toolbar).buttons.map((c) => ({ id: c.id, startCol: c.x, endCol: c.x + c.width - 1 }));
}

// Returns the column range for the status chip (right-aligned, just before buttons).
// Returns null if there is no statusChip.
export function getToolbarStatusChipRange(toolbar: ToolbarConfig): { startCol: number; endCol: number } | null {
  const chip = layoutToolbar(toolbar).statusChip;
  return chip ? { startCol: chip.x, endCol: chip.x + chip.width - 1 } : null;
}

// Returns the column ranges for each window tab (left-aligned in toolbar)
export function getToolbarTabRanges(toolbar: ToolbarConfig): Array<{ id: string; startCol: number; endCol: number; tab: WindowTab }> {
  return layoutToolbar(toolbar).tabs.map((c) => ({
    id: c.id, startCol: c.x, endCol: c.x + c.width - 1, tab: c.tab,
  }));
}

// Returns the absolute grid position for modal content.
// Centered horizontally over the entire terminal (not just the main area);
// positioned vertically within the content band — [layout.contentTop,
// layout.contentTop + layout.contentRows) — so a modal never overlaps the
// toolbar/rule rows above it or the footer-rule/footer rows below it, even
// when the footer chrome is showing. Accounts for border (1 cell each side)
// and shadow (1 cell right/bottom).
export function getModalPosition(
  layout: FrameLayout,
  modalWidth: number, modalHeight: number,
): { startCol: number; startRow: number } {
  const totalW = modalWidth + 3; // border left + content + border right + shadow
  const totalH = modalHeight + 3; // border top + content + border bottom + shadow
  const startCol = Math.max(2, Math.floor((layout.termCols - totalW) / 2) + 1);

  const { contentTop, contentRows } = layout;
  // Ideal: same one-third-down centering as before, but relative to the
  // content band rather than the whole terminal.
  const idealStartRow = contentTop + Math.floor((contentRows - totalH) / 3) + 1;
  // The box top (startRow - 1) must not rise above the content band...
  const minStartRow = contentTop + 1;
  // ...and the shadow's bottom row (startRow + modalHeight + 1) must not
  // reach the footer-rule/footer rows below the content band.
  const maxStartRow = contentTop + contentRows - modalHeight - 2;

  // When the band is too short for the modal to fit within both bounds,
  // protecting the footer boundary wins — better to overlap the toolbar than
  // paint over the footer.
  const startRow = minStartRow <= maxStartRow
    ? Math.max(minStartRow, Math.min(idealStartRow, maxStartRow))
    : maxStartRow;

  return { startCol, startRow };
}

// Renders the optional second toolbar row: each window's git branch, aligned
// under its tab (dim, with a ⎇ glyph, truncated to the tab width). Windows whose
// pane isn't in a git repo simply leave their slot blank.
//
// Row 1 (this row) has no separator glyphs — those only exist on row 0 — so a
// non-last tab's branch label is allowed to extend across the inter-tab gap,
// all the way up to the next tab's x. This is a display-only widening: it
// does not change the tab bar's own column bookkeeping (`tabs` is the exact
// placement row 0 and hit-testing use), so the tab bar itself and
// hit-testing are unaffected. The last tab has no gap to borrow — the button
// cluster starts beyond it — so it stays bounded by its own tab width,
// exactly like every tab was before this widening.
function renderWindowBranchRow(
  grid: CellGrid,
  tabs: PlacedToolbarTab[],
  mainX: number,
): void {
  const branchIcon = "⎇ ";
  const iconWidth = textCols(branchIcon);
  const attrs: CellAttrs = { fg: 8, fgMode: ColorMode.Palette, dim: true };
  for (let i = 0; i < tabs.length; i++) {
    const { x, width, tab } = tabs[i];
    const branch = tab.branch;
    if (!branch) continue;
    const isLast = i === tabs.length - 1;
    const rowWidth = isLast ? width : tabs[i + 1].x - x;
    const maxLen = rowWidth - 2 - iconWidth; // leading + trailing space
    if (maxLen <= 0) continue;
    const branchText = truncateToCols(branch, maxLen);
    const label = " " + branchIcon + branchText + " ";
    writeStyledLine(grid, 1, mainX + x, [{ text: label, attrs }], rowWidth);
  }
}

// The tab-underline colour table (Task 5 of the chrome-frame plan): weight
// signals active, hue signals bell/hover/idle. Checked in this order because
// a bell on the active tab is still the active tab (heavy, accent) — bell
// only changes hue for a tab that isn't already active or hovered.
function tabUnderlineGlyphAndAttrs(tab: WindowTab, isHovered: boolean): { glyph: string; attrs: CellAttrs } {
  // Non-idle cues must be full intensity: writeCell only assigns `dim` when
  // the incoming attrs define it, so without an explicit `dim: false` here
  // these would silently inherit whatever dim the base ruleFrame fill left
  // behind underneath. Only the idle (ruleFrame) case is meant to stay dim.
  if (tab.active) return { glyph: frame.ruleHeavy, attrs: { ...tokens.accent, dim: false } };
  if (isHovered) return { glyph: frame.ruleLight, attrs: { ...tokens.accentMuted, dim: false } };
  if (tab.bell) return { glyph: frame.ruleLight, attrs: { ...tokens.attention, dim: false } };
  return { glyph: frame.ruleLight, attrs: tokens.ruleFrame };
}

// Paints a single frame rule row: a light ruleFrame line spanning the main
// (and, when docked, panel) area, crossing the sidebar border — and, when a
// split diff-panel divider is present, the divider too — with `junction`.
// Shared by the top rule (┼, under the toolbar) and the footer rule (┴,
// above the footer) — see paintTopRuleRow/paintFooterRuleRow, which layer
// their own row-specific cues (tab underline, focus cue) on top of this.
function paintRuleRow(
  grid: CellGrid,
  row: number,
  layout: FrameLayout,
  borderCol: number | null,
  junction: string,
): void {
  const totalCols = grid.cols;
  const mainStart = layout.main.x;

  for (let x = mainStart; x < totalCols; x++) {
    writeCell(grid, row, x, frame.ruleLight, tokens.ruleFrame);
  }

  // No sidebar, no border column to cross — the rule simply starts at column
  // 0. A junction painted anyway would be a ┼ hanging off the end of a line
  // that meets nothing.
  if (borderCol !== null) {
    writeCell(grid, row, borderCol, junction, tokens.ruleFrame);
  }

  if (layout.divider !== null) {
    writeCell(grid, row, layout.divider, junction, tokens.ruleFrame);
  }
}

// Paints the rule row under the toolbar: paintRuleRow's base line/junctions
// (┼), with the window-tab underline and (when a panel is docked) the
// panel-focus underline painted over top. The sidebar's own header rule
// (drawn into its own grid, see sidebar.ts's HEADER_ROWS) is what makes this
// read as one continuous line across the divider — this function only owns
// the main/panel side of it.
function paintTopRuleRow(
  grid: CellGrid,
  row: number,
  layout: FrameLayout,
  borderCol: number | null,
  toolbar: ToolbarConfig | null,
  toolbarLayout: ToolbarLayout | null,
  diffPanel?: { mode: "split" | "full"; focused: boolean },
): void {
  const totalCols = grid.cols;

  paintRuleRow(grid, row, layout, borderCol, frame.crossDown);

  if (diffPanel?.mode === "split" && layout.divider !== null) {
    // The split divider itself goes neutral (see the divider paint below in
    // compositeGrids) — so the panel's own focus cue lives here instead:
    // the rule segment over the panel's tab bar is accent when the panel
    // has focus, muted otherwise. This is painted across the whole panel
    // span rather than per-tab — the panel's tab bar is an externally
    // rendered grid (diffPanel.tabBar) whose own column layout isn't ours
    // to read.
    const panelStart = layout.panel!.x;
    // Same dim-clearing rationale as tabUnderlineGlyphAndAttrs above — this
    // is always a focus cue (accent or accentMuted), never the idle rule.
    const panelAttrs = diffPanel.focused
      ? { ...tokens.accent, dim: false }
      : { ...tokens.accentMuted, dim: false };
    for (let x = panelStart; x < totalCols; x++) {
      writeCell(grid, row, x, frame.ruleLight, panelAttrs);
    }
  }

  // Window-tab underline — the rule segment under each tab reflects its
  // state per tabUnderlineGlyphAndAttrs.
  if (toolbar && toolbarLayout) {
    for (const { x, width, tab } of toolbarLayout.tabs) {
      const isHovered = !tab.active && toolbar.hoveredTabId === tab.windowId;
      const { glyph, attrs } = tabUnderlineGlyphAndAttrs(tab, isHovered);
      const startCol = layout.main.x + x;
      for (let i = 0; i < width; i++) {
        writeCell(grid, row, startCol + i, glyph, attrs);
      }
    }
  }
}

// Paints the rule row above the footer: paintRuleRow's base line/junctions,
// but with ┴ (crossUp) instead of ┼ — it terminates the sidebar border (and,
// in split mode, the diff-panel divider) from above rather than continuing
// them further down, since nothing but the footer sits below this row.
function paintFooterRuleRow(
  grid: CellGrid,
  row: number,
  layout: FrameLayout,
  borderCol: number | null,
): void {
  paintRuleRow(grid, row, layout, borderCol, frame.crossUp);
}

/**
 * Drag-handle chrome state. `hoveredHandle` accents the handle under the
 * pointer — with one-column handles, that highlight is the whole discovery
 * mechanism, since a terminal can't change the cursor shape over a region.
 * It stays set for the duration of a drag, so the handle being dragged
 * remains lit. There is no separate preview position: a drag resizes the
 * frame live, so the handle itself is the feedback.
 */
export interface DragState {
  hoveredHandle: DragHandle | null;
}

export function compositeGrids(
  layout: FrameLayout,
  main: CellGrid,
  sidebar: CellGrid | null,
  toolbar?: ToolbarConfig | null,
  modalOverlay?: CellGrid | null,
  diffPanel?: {
    grid: CellGrid;
    mode: "split" | "full";
    focused: boolean;
    tabBar?: CellGrid;
  },
  footer?: StyledSegment[] | null,
  drag?: DragState | null,
): CellGrid {
  // A missing sidebar subtracts the sidebar, and nothing else. This used to
  // `return main` — every other piece of chrome (toolbar, rules, diff panel,
  // modal overlay, footer) skipped along with it — which was survivable only
  // while the single way to lose the sidebar was a terminal too narrow to
  // carry chrome anyway. `Ctrl-a \` made it reachable on a 200-column screen,
  // where it read as the diff panel, the palette and the toolbar all being
  // broken at once.
  //
  // Everything below is positioned from `layout.main.x`, which is `borderCol +
  // borderWidth` with a sidebar and 0 without, so the two cases are the same
  // arithmetic rather than two paths.
  //
  // Invariant maintained by callers (see src/frame-layout.ts): a sidebar grid
  // is only ever passed when `layout.sidebar`/`layout.borderCol` are also
  // non-null — main.ts sizes both from the same relayout() call. Likewise
  // `layout.panel` is non-null whenever `diffPanel.isActive()` is true, and
  // `layout.divider` is non-null whenever `diffPanel.mode` is "split" — full
  // mode has no divider. Both hold because main.ts's relayout() runs
  // synchronously after every diffPanel state mutation. The reads below are
  // guarded to match: the divider read sits inside the `mode === "split"`
  // branch, and moving it out would break this invariant.
  const borderCol = sidebar ? layout.borderCol! : null;
  const mainX = layout.main.x;
  const mainCols = toolbar ? toolbar.mainCols : main.cols;
  const totalCols = layout.termCols;
  const toolbarRows = toolbar ? layout.toolbarRows : 0;
  const totalRows = layout.termRows;
  const grid = createGrid(totalCols, totalRows);

  // Placed once per frame; row 0 (tabs/buttons/status chip) and row 1 (the
  // per-window branch row) both paint from this single placement, and it's
  // the same placement getToolbarTabRanges/getToolbarButtonRanges/
  // getToolbarStatusChipRange read for hit-testing.
  const toolbarLayout = toolbar ? layoutToolbar(toolbar) : null;

  for (let y = 0; y < totalRows; y++) {
    // Copy sidebar cells
    if (sidebar && borderCol !== null) {
      blit(grid, sidebar, { destX: 0, destY: y, srcX: 0, srcY: y, w: sidebar.cols, h: 1 });
      // Border column — accented while it's hovered as a drag handle, so the
      // resize affordance is visible before the user commits to a press.
      grid.cells[y][borderCol] = drag?.hoveredHandle === "sidebar-edge"
        ? { ...DEFAULT_CELL, char: BORDER_CHAR, ...tokens.accent }
        : { ...DEFAULT_CELL, char: BORDER_CHAR, fg: 8, fgMode: ColorMode.Palette };
    }

    if (toolbar && y < toolbarRows) {
      if (y === 1 && toolbarRows >= 2) {
        // Second toolbar row: per-window git branch, aligned under each tab.
        renderWindowBranchRow(grid, toolbarLayout!.tabs, mainX);
      } else if (y === 0) {
      // Toolbar row — always render (palette no longer replaces it)
      const hoverBg = theme.hover;
      const activeBg = theme.selected;

      // Render window tabs (left side)
      const tabs = toolbarLayout!.tabs;
      for (let ti = 0; ti < tabs.length; ti++) {
        const { x, width, tab } = tabs[ti];
        const isActive = tab.active;
        const isHovered = !isActive && toolbar.hoveredTabId === tab.windowId;
        const hasBg = isActive || isHovered;
        const bg = isActive ? activeBg : hoverBg;
        const label = ` ${tab.name}${tab.zoomed ? " ⤢" : ""} `;
        const attrs: CellAttrs = {
          fg: tab.bell ? 3 : isActive ? tokens.accent.fg! : 8,
          fgMode: tab.bell ? ColorMode.Palette : isActive ? (tokens.accent.fgMode ?? ColorMode.RGB) : ColorMode.Palette,
          bold: isActive || tab.bell,
          bg: hasBg ? bg : 0,
          bgMode: hasBg ? ColorMode.RGB : ColorMode.Default,
        };
        writeStyledLine(grid, 0, mainX + x, [{ text: label, attrs }], width);
        // No separator glyph between tabs — the gap between placements
        // (space.groupGutter, two blank columns) already reads as a
        // separator, and the tab underline (Task 5) delimits tabs from below.
      }

      // Render action buttons (right side): glyph + one trailing gutter
      // space (no leading space — see layoutToolbar), so adjacent buttons
      // read as a tight one-space-gutter cluster. The icon glyph and its
      // trailing gutter get different foregrounds, so they're built as
      // separate segments rather than one uniformly-styled string. The
      // hover background covers both segments, i.e. the button's whole
      // painted range, matching the hit-test range from the same placement.
      for (const { id, x, width } of toolbarLayout!.buttons) {
        const btn = toolbar.buttons.find(b => b.id === id)!;
        const isHovered = toolbar.hoveredButton === id;
        const bg = isHovered ? hoverBg : 0;
        const bgMode = isHovered ? ColorMode.RGB : ColorMode.Default;
        const spaceAttrs: CellAttrs = { fg: 8, fgMode: ColorMode.Palette, bg, bgMode };
        const iconAttrs: CellAttrs = { fg: btn.fg ?? 8, fgMode: btn.fgMode ?? ColorMode.Palette, bg, bgMode };
        const segments: StyledSegment[] = [
          { text: btn.label, attrs: iconAttrs },
          { text: " ", attrs: spaceAttrs },
        ];
        writeStyledLine(grid, 0, mainX + x, segments, width);
      }

      // Render status chip (dim text, right-aligned just before action buttons)
      const chip = toolbarLayout!.statusChip;
      if (chip && toolbar.statusChip) {
        const label = ` ${toolbar.statusChip} `;
        const attrs: CellAttrs = { fg: 8, fgMode: ColorMode.Palette, dim: true };
        writeStyledLine(grid, 0, mainX + chip.x, [{ text: label, attrs }], chip.width);
      }

      // Hover hint — same slot, and layoutToolbar only ever places one of the
      // two. Rendered a shade brighter than the status chip: it answers a
      // question the pointer is actively asking, where the chip is ambient.
      const hint = toolbarLayout!.hoverHint;
      if (hint) {
        const attrs: CellAttrs = { fg: 8, fgMode: ColorMode.Palette };
        writeStyledLine(grid, 0, mainX + hint.x, [{ text: ` ${hint.text} `, attrs }], hint.width);
      }
      }
    } else if (layout.topRuleRow !== null && y === layout.topRuleRow) {
      // The rule row under the toolbar — continues the sidebar's own
      // header rule (sidebar.ts's HEADER_ROWS) across the divider, with a
      // junction glyph, and carries the window-tab / panel-focus underline.
      paintTopRuleRow(grid, y, layout, borderCol, toolbar ?? null, toolbarLayout, diffPanel);
    } else if (layout.footerRuleRow !== null && y === layout.footerRuleRow) {
      // The rule row above the footer — terminates the sidebar border (and,
      // in split mode, the diff-panel divider) from above with ┴, since
      // nothing but the footer sits below.
      paintFooterRuleRow(grid, y, layout, borderCol);
    } else if (layout.footerRow !== null && y === layout.footerRow) {
      // The footer row itself: keybind hints (left) and ambient status —
      // snapshot chip + version (right) — laid out once by footer.ts's
      // layoutFooter and simply replayed here.
      if (footer) {
        writeStyledLine(grid, y, 0, footer, totalCols);
      }
    } else {
      // Main content — offset by the content band's top row (below the
      // toolbar, and below the rule row when it's shown).
      const mainY = y - layout.contentTop;
      if (mainY >= 0) {
        // Copy main grid at layout.main.x. In full mode the diff panel
        // below is painted at layout.panel.x, which equals layout.main.x —
        // it overlaps and overwrites these same columns rather than main
        // being replaced by a separate code path.
        if (mainY < main.rows) {
          blit(grid, main, { destX: layout.main.x, destY: y, srcX: 0, srcY: mainY, w: mainCols, h: 1 });
        }

        if (diffPanel) {
          if (diffPanel.mode === "split") {
            // Neutral — the split divider no longer encodes panel focus.
            // The focus cue moved to the rule row's panel-underline (see
            // paintTopRuleRow) so focus is never left without a cue.
            const dividerCol = layout.divider!;
            writeCell(
              grid,
              y,
              dividerCol,
              frame.divider,
              drag?.hoveredHandle === "panel-divider" ? tokens.accent : tokens.ruleFrame,
            );
          }
          const panelCol = layout.panel!.x;
          if (mainY < diffPanel.grid.rows) {
            blit(grid, diffPanel.grid, { destX: panelCol, destY: y, srcX: 0, srcY: mainY, w: diffPanel.grid.cols, h: 1 });
          }
        }
      }
    }
  }

  // Tab bar rendering — writes into the toolbar row of the panel area
  if (diffPanel?.tabBar && toolbarRows > 0) {
    const tabBarRow = 0; // toolbar is always row 0
    const panelStartCol = layout.panel!.x;
    blit(grid, diffPanel.tabBar, { destX: panelStartCol, destY: tabBarRow, srcX: 0, srcY: 0, w: diffPanel.tabBar.cols, h: 1 });
  }

  // Overlay modal centered over entire terminal with border, shadow, and dimmed background
  if (modalOverlay) {
    const pos = getModalPosition(layout, modalOverlay.cols, modalOverlay.rows);

    // Dim all content cells behind the palette (main area + toolbar, not sidebar)
    //
    // Images go away entirely rather than dimming: a terminal draws them over
    // the text and there is no dim to apply, so an image left behind a modal
    // would be the one bright thing on a screen whose whole point is that
    // everything but the modal has receded. Clearing the mark here is the same
    // occlusion signal writing text over a cell gives — see images/plane.ts.
    //
    // A pane's own image needs the same treatment by a different route. Its
    // placement lives in U+10EEEE placeholder cells whose truecolor foreground
    // *is* the image id, so dimming does not weaken it — it names a different
    // image, or none. Only blanking the cell withdraws the placement, which is
    // why these are cleared to a space rather than dimmed like everything else.
    const mainStart = layout.main.x;
    for (let y = 0; y < totalRows; y++) {
      for (let x = mainStart; x < totalCols; x++) {
        const cell = grid.cells[y][x];
        cell.dim = true;
        cell.image = undefined;
        if (isImagePlaceholder(cell)) {
          cell.char = " ";
          cell.fgMode = ColorMode.Default;
          cell.fg = 0;
        }
      }
    }

    // Border positions (absolute grid coordinates). Colors track the detected
    // terminal theme: surface for the border fill, a derived darkening for the
    // shadow, and the terminal's default foreground for the border glyph once a
    // background is known (so the outline stays visible on light themes too).
    const paletteBg = theme.surface;
    const shadowBg = theme.shadow;
    const borderFg = neutralFg(8);
    const bTop = pos.startRow - 1;
    const bLeft = pos.startCol - 1;
    const bRight = pos.startCol + modalOverlay.cols;
    const bBottom = pos.startRow + modalOverlay.rows;

    // Modal content
    blit(grid, modalOverlay, { destX: pos.startCol, destY: pos.startRow, srcX: 0, srcY: 0, w: modalOverlay.cols, h: modalOverlay.rows });

    // Border ring (corners + edges) around the content.
    drawBox(grid, { x: bLeft, y: bTop, w: bRight - bLeft + 1, h: bBottom - bTop + 1 }, {
      border: { fg: borderFg.fg, fgMode: borderFg.fgMode, bg: paletteBg, bgMode: ColorMode.RGB },
    });

    // Shadow: right edge
    const shadowX = bRight + 1;
    if (shadowX < totalCols) {
      for (let y = bTop + 1; y <= bBottom + 1 && y < totalRows; y++) {
        const cell = grid.cells[y][shadowX];
        cell.bg = shadowBg;
        cell.bgMode = ColorMode.RGB;
        cell.dim = true;
      }
    }
    // Shadow: bottom edge
    const shadowY = bBottom + 1;
    if (shadowY < totalRows) {
      for (let x = bLeft + 1; x <= bRight + 1 && x < totalCols; x++) {
        const cell = grid.cells[shadowY][x];
        cell.bg = shadowBg;
        cell.bgMode = ColorMode.RGB;
        cell.dim = true;
      }
    }
  }

  return grid;
}

// Compare only visual attributes (used for SGR dedup within a row)
function cellsEqual(a: Cell, b: Cell): boolean {
  return (
    a.fg === b.fg &&
    a.bg === b.bg &&
    a.fgMode === b.fgMode &&
    a.bgMode === b.bgMode &&
    a.bold === b.bold &&
    a.dim === b.dim &&
    a.italic === b.italic &&
    a.underline === b.underline
  );
}

// Compare all cell fields including character content (used for frame diffing)
function fullCellsEqual(a: Cell, b: Cell): boolean {
  return (
    a.char === b.char &&
    a.width === b.width &&
    a.fg === b.fg &&
    a.bg === b.bg &&
    a.fgMode === b.fgMode &&
    a.bgMode === b.bgMode &&
    a.bold === b.bold &&
    a.dim === b.dim &&
    a.italic === b.italic &&
    a.underline === b.underline &&
    a.link === b.link
  );
}

const MOUSE_MODE_INTERVAL_MS = 2_000;

export class Renderer {
  private prevAttrs: Cell | null = null;
  private prevGrid: CellGrid | null = null;
  private lastMouseModeTime = 0;
  private imagePlane: ImagePlane | null = null;

  /**
   * Install the terminal-graphics layer, or null on a terminal that can't draw
   * images. Set after construction because the capability is only known once
   * the terminal has answered its probe, which is several frames after the
   * renderer exists.
   */
  setImagePlane(plane: ImagePlane | null): void {
    if (this.imagePlane && this.imagePlane !== plane) {
      process.stdout.write(this.imagePlane.shutdown());
    }
    this.imagePlane = plane;
  }

  /** Everything the image layer has on screen, gone. For shutdown. */
  teardownImages(): string {
    return this.imagePlane ? this.imagePlane.shutdown() : "";
  }

  /**
   * URL of the hyperlink at the given absolute (0-indexed) cell of the last
   * composited frame, or undefined. Backs jmux-owned link clicking — the input
   * router maps a click's coordinates straight onto what was rendered there.
   */
  getLinkAt(col: number, row: number): string | undefined {
    return this.prevGrid?.cells[row]?.[col]?.link;
  }

  render(
    layout: FrameLayout,
    main: CellGrid,
    cursor: CursorPosition,
    sidebar: CellGrid | null,
    toolbar?: ToolbarConfig | null,
    modalOverlay?: CellGrid | null,
    modalCursor?: { row: number; col: number } | null,
    diffPanel?: {
      grid: CellGrid;
      mode: "split" | "full";
      focused: boolean;
      tabBar?: CellGrid;
    },
    footer?: StyledSegment[] | null,
    drag?: DragState | null,
  ): void {
    const grid = compositeGrids(layout, main, sidebar, toolbar, modalOverlay, diffPanel, footer, drag);
    const cursorOffset = layout.main.x;
    const buf: string[] = [];

    // Row-level diffing: skip rows whose cells are identical to the
    // previous frame.  This dramatically reduces stdout output when
    // the screen is static, which prevents terminal emulators' URL
    // detection from being disrupted by constant full-screen rewrites.
    const canDiff =
      this.prevGrid !== null &&
      this.prevGrid.rows === grid.rows &&
      this.prevGrid.cols === grid.cols;

    // A frame that can't be diffed is a frame whose coordinate system changed —
    // a resize. Image placements are anchored to cells, so every one of them is
    // now pinned to the wrong place, and nothing will ever overwrite a picture
    // by drawing text: they have to be dropped explicitly and re-placed below.
    if (!canDiff && this.imagePlane) {
      buf.push(this.imagePlane.reset());
    }

    for (let y = 0; y < grid.rows; y++) {
      if (canDiff) {
        let rowChanged = false;
        const prevRow = this.prevGrid!.cells[y];
        const curRow = grid.cells[y];
        for (let x = 0; x < grid.cols; x++) {
          if (!fullCellsEqual(curRow[x], prevRow[x])) {
            rowChanged = true;
            break;
          }
        }
        if (!rowChanged) continue;
      }

      // Move to start of row (1-indexed)
      buf.push(`\x1b[${y + 1};1H`);
      this.prevAttrs = null;
      let col = 1; // expected terminal column (1-indexed)
      // OSC 8 link state — reset per row so the close emitted at the
      // end of each row keeps state cleanly bounded.
      let prevLink: string | undefined = undefined;

      for (let x = 0; x < grid.cols; x++) {
        const cell = grid.cells[y][x];

        // Skip continuation cells (second half of wide characters)
        if (cell.width === 0) continue;

        // Emit OSC 8 transitions before SGR/text so the link "wraps"
        // the styled glyphs the way Bun emits them.
        if (cell.link !== prevLink) {
          if (prevLink !== undefined) buf.push("\x1b]8;;\x1b\\");
          if (cell.link !== undefined) buf.push(`\x1b]8;;${cell.link}\x1b\\`);
          prevLink = cell.link;
        }

        // Emit SGR only when attributes change
        if (!this.prevAttrs || !cellsEqual(this.prevAttrs, cell)) {
          buf.push(sgrForCell(cell));
          this.prevAttrs = cell;
        }

        buf.push(cell.char);
        col += cell.width;

        // Reposition cursor after wide characters to prevent drift
        // from width disagreements between xterm.js and the real
        // terminal.  Only characters with display width >= 2 (CJK,
        // emoji) can cause drift — width-1 non-ASCII (box-drawing,
        // bullets, arrows, Latin Extended) are unambiguous and don't
        // need correction.  Repositioning after every non-ASCII char
        // (cp >= 0x80) injected hundreds of CUP sequences per frame,
        // which broke URL detection in terminal emulators that track
        // text segments separated by cursor movement.
        if (col <= grid.cols && cell.width >= 2) {
          buf.push(`\x1b[${y + 1};${col}H`);
        }
      }

      // Close any open OSC 8 region at the end of the row so it
      // doesn't leak into the next row's text or the trailing reset.
      if (prevLink !== undefined) {
        buf.push("\x1b]8;;\x1b\\");
      }
    }

    this.prevGrid = grid;

    // Terminal graphics, after the text of the frame and before the cursor is
    // parked: placements are read back off the finished composite (so clipping
    // and occlusion come from the same cells the text did), and each one moves
    // the cursor to its anchor, which the block below then corrects.
    if (this.imagePlane) {
      buf.push(this.imagePlane.frame(grid));
    }

    // Reset attributes, position cursor. Matches compositeGrids's content
    // offset exactly (layout.contentTop, not a hardcoded toolbar row count)
    // so the real cursor tracks the content band even when the rule row
    // shifts it down an extra row.
    const cursorRowOffset = toolbar ? layout.contentTop : 0;
    buf.push("\x1b[0m");
    if (modalCursor != null) {
      // Modal cursor is in absolute grid coordinates
      buf.push(`\x1b[${modalCursor.row + 1};${modalCursor.col + 1}H`);
      buf.push("\x1b[?25h");
    } else if (diffPanel?.focused) {
      buf.push("\x1b[?25l"); // hide cursor when diff panel focused
    } else {
      buf.push(
        `\x1b[${cursor.y + cursorRowOffset + 1};${cursor.x + cursorOffset + 1}H`,
      );
      buf.push("\x1b[?25h");
    }

    // Re-assert mouse tracking modes periodically to keep jmux's own mouse
    // reception alive against mode drift — link clicking now depends on jmux
    // receiving the click (see InputRouter's getLinkAt path), so these modes
    // must stay on. Throttled to 2s rather than per-frame: per-frame re-assert
    // sent ?1003h 60x/sec, churn that could disrupt terminals' URL detection.
    // (We no longer depend on the terminal's own click bypass, so reasserting
    // here is purely upside.)
    const now = Date.now();
    if (now - this.lastMouseModeTime >= MOUSE_MODE_INTERVAL_MS) {
      buf.push("\x1b[?1000h\x1b[?1003h\x1b[?1006h");
      this.lastMouseModeTime = now;
    }

    process.stdout.write(buf.join(""));
  }
}
