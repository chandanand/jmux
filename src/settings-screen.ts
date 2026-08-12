import type { CellGrid } from "./types";
import { ColorMode } from "./types";
import { createGrid, writeString, textCols, truncateToCols, type CellAttrs } from "./cell-grid";
import { theme, neutralFg } from "./theme";
import { tokens, space, frame } from "./chrome-tokens";

// --- Setting definitions ---

export interface SettingDef {
  id: string;
  label: string;
  type: "boolean" | "text" | "list" | "map" | "multiselect" | "action";
  getValue: () => string;
  /**
   * The *editable* form of the value, when it differs from the displayed one.
   *
   * `getValue` is prose ("never", "2 days") because that is what reads well in a
   * row; feeding that same string back in as the edit buffer does not round-trip
   * — a commit parses "never" to NaN, and typing a number onto the end of it
   * yields "never5". Rows whose display form is not their input form supply this
   * so the prompt opens on something the user can actually edit.
   */
  getEditValue?: () => string;
  // For boolean: toggle callback
  onToggle?: () => void;
  /**
   * Commit a text value. Return a message to **reject** it; return nothing to
   * accept. A rejected commit leaves the editor open with the message on the
   * row — the alternative, which is what this screen used to do, was to discard
   * the value in silence and leave the old one on screen looking applied.
   *
   * `void` stays in the union so the many rows that return nothing keep
   * compiling unchanged.
   */
  onTextCommit?: (value: string) => string | null | void;
  /**
   * Nudge the value one place with ◂ ▸, without opening an editor.
   *
   * Only for values on an ordered ladder the user can walk — a count, a
   * duration. Deliberately NOT how `list` settings work: those choose among
   * every tracker state, and cycling twenty-five of them one keypress at a time
   * is why nobody found them (see `editSetting`). A row offering this still
   * supports Enter, so a distant value is one typed number rather than a
   * hundred presses.
   */
  onStep?: (delta: number) => void;
  // For list: cycle through options
  options?: string[];
  onOptionSelect?: (value: string) => void;
  // For map: entries + CRUD callbacks
  getMapEntries?: () => Array<{ key: string; value: string }>;
  getMapKeyOptions?: () => Array<{ id: string; label: string }>;   // available keys to add (e.g., Linear teams)
  getMapValueOptions?: () => Array<{ id: string; label: string }>; // available values (e.g., project dirs)
  onMapSave?: (key: string, value: string) => void;
  onMapRemove?: (key: string) => void;
  // For multiselect: a subset chosen from a (possibly live) option list.
  // Options may come from a fixed set or from the issue tracker at call time —
  // the primitive doesn't care, it just re-reads on every render so a toggle
  // is reflected without any snapshot/invalidate dance.
  getOptions?: () => Array<{ id: string; label: string }>;
  getSelected?: () => string[];
  onToggleOption?: (id: string) => void;
  /**
   * Where this row's effective value came from. Rows in the current-repo
   * category report "override" when that repo sets the field and "inherited"
   * when the value falls through to the global default. Omit for rows that
   * aren't per-repo — they render no marker.
   */
  getScope?: () => "inherited" | "override";
  /** Clear this repo's override, falling back to the inherited value. */
  onClearOverride?: () => void;
  /**
   * A short qualifier on the *effective* value, shown dim after it — for a row
   * whose value alone does not say what is actually true right now (the
   * adapter rows report the connected organization, or why there isn't one).
   *
   * Distinct from `describe`, which explains what the setting does and is the
   * same every time. This says what is true right now, and returns null the
   * moment it stops being true, so a row can never keep asserting a stale
   * caveat. Kept out of `getValue` because a `list` row's displayed value has
   * to match one of its `options` for the picker to open on the current choice.
   */
  getNote?: () => string | null;
  /**
   * For `action`: run on Enter instead of editing anything. `getValue` still
   * supplies a right-hand summary, so the row reads like the others.
   */
  onActivate?: () => void;
  /**
   * One sentence saying what this setting does, shown on the workflow screen's
   * explain line while the row is selected. Optional and ignored by the
   * settings screen, which has no explain line of its own.
   */
  describe?: () => string;
}

export interface SettingsCategory {
  label: string;
  collapsed: boolean;
  settings: SettingDef[];
}

// --- Rendering constants ---

// The single jmux accent (see chrome-tokens.ts) marks focus: the title, the
// active category/label, the row cursor and edit caret. The attr objects
// below are re-themed in place by rebuildSettingsColors(): every ACCENT-role
// object is re-patched from tokens.accent, HAIRLINE_ROLE from
// tokens.ruleHairline, every neutral-text object from the terminal default
// fg once a theme is detected, and the edit-field surfaces track
// theme.hover / theme.selected. They start on the dark defaults.

const HEADER_ATTRS: CellAttrs = { fg: tokens.accent.fg, fgMode: tokens.accent.fgMode, bold: true };
const CATEGORY_ATTRS: CellAttrs = { fg: tokens.textSecondary.fg, fgMode: tokens.textSecondary.fgMode };
const CATEGORY_ACTIVE: CellAttrs = { fg: tokens.accent.fg, fgMode: tokens.accent.fgMode, bold: true };
const HAIRLINE_ATTRS: CellAttrs = { fg: tokens.ruleHairline.fg, fgMode: tokens.ruleHairline.fgMode, dim: tokens.ruleHairline.dim };
const LABEL_ATTRS: CellAttrs = { fg: 7, fgMode: ColorMode.Palette };
const LABEL_ACTIVE: CellAttrs = { fg: tokens.accent.fg, fgMode: tokens.accent.fgMode, bold: true };
const VALUE_ATTRS: CellAttrs = { fg: 8, fgMode: ColorMode.Palette };
const VALUE_ACTIVE: CellAttrs = { fg: 7, fgMode: ColorMode.Palette };
const DIM_ATTRS: CellAttrs = { fg: 8, fgMode: ColorMode.Palette, dim: true };
const HINT_ATTRS: CellAttrs = { fg: 8, fgMode: ColorMode.Palette, dim: true };
// The explain line, matching the workflow screen's treatment so the two
// full-screen surfaces read the same way.
const EXPLAIN_ATTRS: CellAttrs = { fg: tokens.textSecondary.fg, fgMode: tokens.textSecondary.fgMode, dim: true };
const HINT_KEY_ATTRS: CellAttrs = { fg: tokens.accentMuted.fg, fgMode: tokens.accentMuted.fgMode };
const HINT_LABEL_ATTRS: CellAttrs = { fg: tokens.textSecondary.fg, fgMode: tokens.textSecondary.fgMode };
const HINT_SEP_ATTRS: CellAttrs = { fg: tokens.ruleHairline.fg, fgMode: tokens.ruleHairline.fgMode, dim: tokens.ruleHairline.dim };
const CURSOR_ATTRS: CellAttrs = { fg: tokens.accent.fg, fgMode: tokens.accent.fgMode };
const EDIT_BG: CellAttrs = { bg: theme.hover, bgMode: ColorMode.RGB };
const EDIT_TEXT: CellAttrs = { fg: 7, fgMode: ColorMode.Palette, bg: theme.hover, bgMode: ColorMode.RGB };
const EDIT_CURSOR: CellAttrs = { fg: tokens.accent.fg, fgMode: tokens.accent.fgMode, bg: theme.selected, bgMode: ColorMode.RGB };
const MAP_KEY_ATTRS: CellAttrs = { fg: 5, fgMode: ColorMode.Palette };
const MAP_VAL_ATTRS: CellAttrs = { fg: 8, fgMode: ColorMode.Palette };
const MAP_KEY_ACTIVE: CellAttrs = { fg: tokens.accent.fg, fgMode: tokens.accent.fgMode };
const MAP_ADD_ATTRS: CellAttrs = { fg: 2, fgMode: ColorMode.Palette };
const ON_ATTRS: CellAttrs = { fg: 2, fgMode: ColorMode.Palette };
const OFF_ATTRS: CellAttrs = { fg: 1, fgMode: ColorMode.Palette };

// Objects whose foreground tracks the accent / neutral-text / hairline tokens — patched by role.
const ACCENT_ROLE: CellAttrs[] = [HEADER_ATTRS, CATEGORY_ACTIVE, LABEL_ACTIVE, CURSOR_ATTRS, EDIT_CURSOR, MAP_KEY_ACTIVE];
const NEUTRAL_ROLE: CellAttrs[] = [LABEL_ATTRS, VALUE_ACTIVE, EDIT_TEXT];
const TEXT_SECONDARY_ROLE: CellAttrs[] = [CATEGORY_ATTRS, HINT_LABEL_ATTRS, EXPLAIN_ATTRS];
const HAIRLINE_ROLE: CellAttrs[] = [HAIRLINE_ATTRS, HINT_SEP_ATTRS];

export function rebuildSettingsColors(): void {
  for (const a of ACCENT_ROLE) { a.fg = tokens.accent.fg; a.fgMode = tokens.accent.fgMode; }
  for (const a of TEXT_SECONDARY_ROLE) { a.fg = tokens.textSecondary.fg; a.fgMode = tokens.textSecondary.fgMode; }
  for (const a of HAIRLINE_ROLE) { a.fg = tokens.ruleHairline.fg; a.fgMode = tokens.ruleHairline.fgMode; a.dim = tokens.ruleHairline.dim; }
  HINT_KEY_ATTRS.fg = tokens.accentMuted.fg;
  HINT_KEY_ATTRS.fgMode = tokens.accentMuted.fgMode;
  const n = neutralFg(7);
  for (const a of NEUTRAL_ROLE) { a.fg = n.fg; a.fgMode = n.fgMode; }
  EDIT_BG.bg = theme.hover;
  EDIT_TEXT.bg = theme.hover;
  EDIT_CURSOR.bg = theme.selected;
}
rebuildSettingsColors();

// --- Shared row dialect ---
//
// `label ·········· value (marker)` with a ▸ cursor in the left gutter — the
// one row treatment used by every full-screen chrome surface. Exported so the
// workflow screen paints its behaviour bands identically instead of growing a
// second, drifting copy of this arithmetic.
//
// All widths go through textCols/truncateToCols rather than String.length:
// these rows carry user data (tracker status names), which may contain
// width-2 characters.

export interface SettingRowOpts {
  label: string;
  labelAttrs: CellAttrs;
  /** Right-aligned, painted left to right; each part keeps its own attrs. */
  value: ReadonlyArray<{ text: string; attrs: CellAttrs }>;
  selected: boolean;
  /** Columns from `left` to the label. The cursor sits two columns before it. */
  indent?: number;
  /** Dot leader between label and value. Off for rows that expand in place. */
  leader?: boolean;
}

export function drawSettingRow(
  grid: CellGrid,
  row: number,
  bounds: { left: number; right: number },
  opts: SettingRowOpts,
): void {
  const { left, right } = bounds;
  const indent = left + (opts.indent ?? 2);

  const maxLabelCols = Math.max(1, Math.floor((right - indent - 2) * 0.5));
  const label = truncateToCols(opts.label, maxLabelCols);
  writeString(grid, row, indent, label, opts.labelAttrs);

  const valueCols = opts.value.reduce((n, part) => n + textCols(part.text), 0);
  const valueCol = right - valueCols;
  const labelEnd = indent + textCols(label);

  if (valueCol > labelEnd + 1) {
    if (opts.leader !== false) {
      const leaderStart = labelEnd + 1;
      // Reserve one flanking space each side so the dots never touch either end.
      const maxDots = valueCol - 1 - leaderStart - 1;
      if (maxDots >= 2) {
        writeString(grid, row, leaderStart, " " + "·".repeat(maxDots) + " ", HAIRLINE_ATTRS);
      }
    }
    let col = valueCol;
    for (const part of opts.value) {
      writeString(grid, row, col, part.text, part.attrs);
      col += textCols(part.text);
    }
  }

  if (opts.selected) writeString(grid, row, indent - 2, "▸", CURSOR_ATTRS);
}

// --- Node model ---

type SettingsNode =
  | { kind: "category"; label: string; collapsed: boolean; count: number }
  | { kind: "setting"; setting: SettingDef }
  | { kind: "map-entry"; parentId: string; key: string; value: string }
  | { kind: "map-add"; parentId: string };

type PickerItem = { id: string; label: string };

type EditState =
  | null
  | { mode: "text"; settingId: string; buffer: string; cursorPos: number }
  | { mode: "list"; settingId: string; optionIndex: number; options: string[] }
  | { mode: "picker"; settingId: string; title: string; items: PickerItem[]; filtered: PickerItem[]; selectedIndex: number; filter: string; onSelect: (item: PickerItem) => void; multi?: boolean };

export type SettingsAction =
  | { type: "none" }
  | { type: "map-add"; settingId: string }
  | { type: "map-edit"; settingId: string; key: string };

// --- Visual-row plan ---
//
// `buildNodes()` produces the list of *setting indices* — the only things
// `selectedIndex`/navigation ever address. `buildRowPlan()` wraps that list
// into the *rendered rows*: it inserts a blank spacer row before every
// category header except the first, purely for visual breathing room
// between sections. Blank rows carry no nodeIndex, so they can never be
// the render-time target of `isSelected`, and moveUp()/moveDown() never
// touch the row plan at all — they walk `nodes` directly, so the cursor
// can only ever land on a real node. The row plan's only jobs are (a)
// deciding what appears on which screen row and (b) letting scrolling
// account for the extra blank rows consuming vertical space.
type RenderRow =
  | { kind: "blank" }
  | { kind: "node"; nodeIndex: number; node: SettingsNode };

// Row 0 is the "Settings" title, row 1 is a blank breathing row; content
// starts at row 2. Shared between render() and ensureVisible() so the two
// can't drift apart.
const CONTENT_START_ROW = 2;

export class SettingsScreen {
  private categories: SettingsCategory[] = [];
  private selectedIndex = 0;
  private scrollOffset = 0;
  private _open = false;
  private lastRenderRows = 24;
  private editState: EditState = null;
  private expandedMaps = new Set<string>();
  /**
   * The `/` filter. An explicit mode rather than type-to-filter, because bare
   * typing collides with keys this screen already binds — `q` closes it and `d`
   * clears an override, so "query" would close the screen on its first
   * keystroke.
   */
  private filter = "";
  private filtering = false;
  private commitError: string | null = null;
  private title = "Settings";

  get isOpen(): boolean { return this._open; }
  get isEditing(): boolean { return this.editState !== null; }

  /**
   * `title` exists because this class is a generic categories renderer, not a
   * screen about one subject. The Projects surface is the same list, the same
   * search, the same explain line and the same validation over a different set
   * — building a second full-area surface to say "Projects" instead of
   * "Settings" would be a copy of all four.
   */
  open(categories: SettingsCategory[], title = "Settings"): void {
    this.title = title;
    this.categories = categories;
    this.selectedIndex = 0;
    this.scrollOffset = 0;
    this.editState = null;
    this.filter = "";
    this.filtering = false;
    this.commitError = null;
    this._open = true;
  }

  close(): void {
    this._open = false;
    this.editState = null;
    this.filter = "";
    this.filtering = false;
    this.commitError = null;
  }

  updateCategories(categories: SettingsCategory[]): void {
    for (const cat of categories) {
      const existing = this.categories.find((c) => c.label === cat.label);
      if (existing) cat.collapsed = existing.collapsed;
    }
    this.categories = categories;
    const nodes = this.buildNodes();
    if (this.selectedIndex >= nodes.length) {
      this.selectedIndex = Math.max(0, nodes.length - 1);
    }
  }

  // Returns an action that main.ts needs to handle asynchronously (map add/edit)
  handleInput(data: string): SettingsAction {
    // Editing mode
    if (this.editState) {
      return this.handleEditInput(data);
    }

    // Filter mode consumes everything printable, so the navigation keys below
    // (q closes, d clears) cannot eat a search term.
    if (this.filtering) {
      if (data === "\x1b") {
        this.filtering = false;
        this.filter = "";
        this.selectedIndex = 0;
        this.scrollOffset = 0;
        return { type: "none" };
      }
      if (data === "\r") { this.filtering = false; return { type: "none" }; }
      if (data === "\x7f" || data === "\b") {
        this.filter = this.filter.slice(0, -1);
        this.clampSelection();
        return { type: "none" };
      }
      if (data === "\x1b[A") { this.moveUp(); return { type: "none" }; }
      if (data === "\x1b[B") { this.moveDown(); return { type: "none" }; }
      if (data.length === 1 && data.charCodeAt(0) >= 32) {
        this.filter += data;
        this.clampSelection();
        return { type: "none" };
      }
      return { type: "none" };
    }

    if (data === "/") { this.filtering = true; this.filter = ""; return { type: "none" }; }

    // Navigation mode
    if (data === "\x1b" || data === "q") {
      this.close();
      return { type: "none" };
    }
    if (data === "\x1b[A" || data === "k") { this.moveUp(); return { type: "none" }; }
    if (data === "\x1b[B" || data === "j") { this.moveDown(); return { type: "none" }; }

    // ◂ ▸ nudge a value one place without opening an editor, for rows on an
    // ordered ladder. Deliberately not how `list` rows work — see the note on
    // SettingDef.onStep. Rows without onStep simply ignore them.
    if (data === "\x1b[C" || data === "\x1b[D") {
      const stepNode = this.getSelectedNode();
      if (stepNode?.kind === "setting" && stepNode.setting.onStep) {
        stepNode.setting.onStep(data === "\x1b[C" ? 1 : -1);
      }
      return { type: "none" };
    }

    if (data === "\r") {
      return this.handleEnter();
    }

    // Delete key: removes a map entry, or clears a per-repo override back to
    // the inherited value. Both are "unset this", so they share one key.
    if (data === "d" || data === "\x7f") {
      const node = this.getSelectedNode();
      if (node?.kind === "map-entry") {
        const setting = this.findSetting(node.parentId);
        setting?.onMapRemove?.(node.key);
        return { type: "none" };
      }
      if (node?.kind === "setting" && node.setting.getScope?.() === "override") {
        node.setting.onClearOverride?.();
        return { type: "none" };
      }
    }

    return { type: "none" };
  }

  render(cols: number, rows: number): CellGrid {
    this.lastRenderRows = rows;

    // Picker mode gets a dedicated render
    if (this.editState?.mode === "picker") {
      return this.renderPicker(cols, rows, this.editState);
    }

    const grid = createGrid(cols, rows);

    // Content is capped at space.measure and centred within the render
    // area (which is already the main rect, excluding the sidebar) rather
    // than laid out edge-to-edge — the dot leaders used to fill the whole
    // terminal width, so the layout got worse the wider the terminal.
    // measureWidth is clamped to `cols` so `right` never lands past the
    // grid edge: below the measure, content uses the full available width
    // (left = 0); at/above it, content is capped at the measure and
    // centred with symmetric margins.
    const measureWidth = Math.min(cols, space.measure);
    const left = cols > space.measure ? Math.floor((cols - space.measure) / 2) : 0;
    const right = left + measureWidth;

    const nodes = this.buildNodes();
    const rowPlan = this.buildRowPlan(nodes);

    // Header
    writeString(grid, 0, left, this.title, HEADER_ATTRS);
    if (this.filtering || this.filter) {
      writeString(grid, 1, left, `/${this.filter}`, LABEL_ACTIVE);
    }

    // Two reserved rows at the bottom: the explain line sits above the hints,
    // the same layout the workflow screen uses.
    const hintRow = rows - 1;
    const explainRow = rows - 2;

    for (let r = 0; r < rowPlan.length; r++) {
      const row = CONTENT_START_ROW + r - this.scrollOffset;
      if (row < CONTENT_START_ROW || row >= explainRow) continue;

      const entry = rowPlan[r];
      if (entry.kind === "blank") continue;

      const node = entry.node;
      const isSelected = entry.nodeIndex === this.selectedIndex;

      if (node.kind === "category") {
        this.renderCategory(grid, row, left, right, node, isSelected);
      } else if (node.kind === "setting") {
        this.renderSetting(grid, row, left, right, node.setting, isSelected);
      } else if (node.kind === "map-entry") {
        this.renderMapEntry(grid, row, left, right, node, isSelected);
      } else if (node.kind === "map-add") {
        const indent = left + 4;
        writeString(grid, row, indent, "+ Add mapping", isSelected ? MAP_KEY_ACTIVE : MAP_ADD_ATTRS);
        if (isSelected) writeString(grid, row, indent - 2, "▸", CURSOR_ATTRS);
      }
    }

    if (this.filter && nodes.length === 0) {
      writeString(grid, CONTENT_START_ROW, left + 2, "No matches", DIM_ATTRS);
    }

    // Only a `setting` row has a description; a category header or a map entry
    // deliberately shows nothing rather than inheriting its neighbour's.
    const selectedNode = nodes[this.selectedIndex];
    if (selectedNode?.kind === "setting") {
      const text = selectedNode.setting.describe?.() ?? "";
      if (text) {
        writeString(grid, explainRow, left, truncateToCols(text, Math.max(1, right - left)), EXPLAIN_ATTRS);
      }
    }

    this.renderHint(grid, hintRow, left);

    return grid;
  }

  private renderHint(grid: CellGrid, row: number, left: number): void {
    const groups: Array<{ key: string; label: string }> = this.editState
      ? [{ key: "↵", label: "confirm" }, { key: "esc", label: "cancel" }]
      : [{ key: "↵", label: "edit" }, { key: "/", label: "search" }, { key: "esc", label: "close" }, { key: "↑↓", label: "navigate" }];

    let col = left;
    groups.forEach((group, i) => {
      if (i > 0) {
        writeString(grid, row, col, "  ", HINT_SEP_ATTRS);
        col += 2;
        writeString(grid, row, col, "·", HINT_SEP_ATTRS);
        col += 1;
        writeString(grid, row, col, "  ", HINT_SEP_ATTRS);
        col += 2;
      }
      writeString(grid, row, col, group.key, HINT_KEY_ATTRS);
      col += group.key.length;
      writeString(grid, row, col, " " + group.label, HINT_LABEL_ATTRS);
      col += group.label.length + 1;
    });
  }

  // --- Private: visual-row plan ---

  private buildRowPlan(nodes: SettingsNode[]): RenderRow[] {
    const plan: RenderRow[] = [];
    nodes.forEach((node, nodeIndex) => {
      if (node.kind === "category" && plan.length > 0) {
        plan.push({ kind: "blank" });
      }
      plan.push({ kind: "node", nodeIndex, node });
    });
    return plan;
  }

  // --- Private: rendering helpers ---

  // Section header as a "label ────" hairline (replacing the old
  // "▸/▸ label (count)" chevron form): the label, a space, then a
  // ruleHairline-toned fill of frame.ruleLight to the right edge of the
  // measure. Collapse still toggles via Enter (handleEnter()) and still
  // hides the category's settings (buildNodes()) — only the *display* of
  // collapse changed, from a count on every header to "n hidden" shown
  // only when collapsed.
  private renderCategory(grid: CellGrid, row: number, left: number, right: number, node: Extract<SettingsNode, { kind: "category" }>, selected: boolean): void {
    const label = node.label;
    writeString(grid, row, left, label, selected ? CATEGORY_ACTIVE : CATEGORY_ATTRS);
    if (selected) writeString(grid, row, left - 1, "▸", CURSOR_ATTRS);

    const hiddenLabel = node.collapsed ? `${node.count} hidden` : "";
    const hairlineStart = left + label.length + 1;
    const hairlineEnd = hiddenLabel ? right - hiddenLabel.length - 1 : right;
    const fillLen = Math.max(0, hairlineEnd - hairlineStart);
    if (fillLen > 0) {
      writeString(grid, row, hairlineStart, frame.ruleLight.repeat(fillLen), HAIRLINE_ATTRS);
    }
    if (hiddenLabel && right - hiddenLabel.length >= hairlineStart) {
      writeString(grid, row, right - hiddenLabel.length, hiddenLabel, CATEGORY_ATTRS);
    }
  }

  private renderSetting(grid: CellGrid, row: number, left: number, right: number, setting: SettingDef, selected: boolean): void {
    // Check if this setting is being edited
    if (this.editState?.settingId === setting.id) {
      if (this.editState.mode === "text") {
        this.renderTextEdit(grid, row, left, right, setting, this.editState);
        return;
      }
      if (this.editState.mode === "list") {
        this.renderListEdit(grid, row, left, setting, this.editState);
        return;
      }
    }

    const value = setting.getValue();
    const isBoolean = setting.type === "boolean";
    const isMap = setting.type === "map";
    const valueStr = isMap
      ? (this.expandedMaps.has(setting.id) ? "▾" : `▸ ${value}`)
      : truncateToCols(value, 25);

    // Per-repo rows carry a provenance marker after the value, so an override
    // is visible at a glance and the [d] clear key has something to point at.
    const scope = setting.getScope?.();
    const note = setting.getNote?.() ?? null;

    drawSettingRow(grid, row, { left, right }, {
      label: setting.label,
      labelAttrs: selected ? LABEL_ACTIVE : LABEL_ATTRS,
      value: [
        {
          text: valueStr,
          attrs: isBoolean
            ? (value === "on" ? ON_ATTRS : OFF_ATTRS)
            : (selected ? VALUE_ACTIVE : VALUE_ATTRS),
        },
        ...(scope ? [{ text: ` (${scope})`, attrs: DIM_ATTRS }] : []),
        ...(note ? [{ text: ` · ${note}`, attrs: DIM_ATTRS }] : []),
      ],
      selected,
      // A map row expands in place rather than carrying a value, so a leader
      // pointing at its ▸/▾ chevron would read as a value it doesn't have.
      leader: !isMap,
    });
  }

  private renderTextEdit(grid: CellGrid, row: number, left: number, right: number, setting: SettingDef, state: Extract<EditState, { mode: "text" }>): void {
    const indent = left + 2;
    writeString(grid, row, indent, setting.label + ": ", LABEL_ACTIVE);
    const fieldStart = indent + setting.label.length + 2;
    const fieldWidth = Math.max(0, right - fieldStart);

    // Background for edit field
    const bg = " ".repeat(fieldWidth);
    writeString(grid, row, fieldStart, bg, EDIT_BG);

    // Buffer text — when overflowing, show a window around the cursor
    const sliceOffset = state.buffer.length > fieldWidth - 1
      ? Math.max(0, Math.min(state.cursorPos - Math.floor(fieldWidth / 2), state.buffer.length - fieldWidth + 1))
      : 0;
    const displayBuf = state.buffer.slice(sliceOffset, sliceOffset + fieldWidth - 1);
    writeString(grid, row, fieldStart, displayBuf, EDIT_TEXT);

    // Cursor
    const cursorCol = fieldStart + state.cursorPos - sliceOffset;
    const cursorChar = state.cursorPos < state.buffer.length ? state.buffer[state.cursorPos] : " ";
    writeString(grid, row, cursorCol, cursorChar, EDIT_CURSOR);

    // The rejection shares the row, right-aligned, so it costs no extra height
    // and sits where the eye already is.
    if (this.commitError) {
      const msg = truncateToCols(this.commitError, Math.max(1, right - fieldStart - 2));
      const col = right - textCols(msg);
      if (col > fieldStart) writeString(grid, row, col, msg, OFF_ATTRS);
    }
  }

  private renderListEdit(grid: CellGrid, row: number, left: number, setting: SettingDef, state: Extract<EditState, { mode: "list" }>): void {
    const indent = left + 2;
    writeString(grid, row, indent, setting.label + ": ", LABEL_ACTIVE);
    const fieldStart = indent + setting.label.length + 2;

    // Show current option with arrows
    const option = state.options[state.optionIndex];
    writeString(grid, row, fieldStart, `◂ ${option} ▸`, CURSOR_ATTRS);
  }

  private renderMapEntry(grid: CellGrid, row: number, left: number, right: number, node: Extract<SettingsNode, { kind: "map-entry" }>, selected: boolean): void {
    const indent = left + 4;
    const keyStr = node.key;
    const valStr = node.value.length > 30 ? node.value.slice(0, 29) + "\u2026" : node.value;

    writeString(grid, row, indent, keyStr, selected ? MAP_KEY_ACTIVE : MAP_KEY_ATTRS);
    writeString(grid, row, indent + keyStr.length, " → ", DIM_ATTRS);
    writeString(grid, row, indent + keyStr.length + 3, valStr, selected ? VALUE_ACTIVE : MAP_VAL_ATTRS);

    if (selected) {
      writeString(grid, row, indent - 2, "▸", CURSOR_ATTRS);
      // Hint for delete
      const hintCol = right - 10;
      if (hintCol > indent + keyStr.length + valStr.length + 5) {
        writeString(grid, row, hintCol, "[d] remove", HINT_ATTRS);
      }
    }
  }

  // --- Private: input handling ---

  private handleEditInput(data: string): SettingsAction {
    if (!this.editState) return { type: "none" };

    if (this.editState.mode === "text") {
      const state = this.editState;
      if (data === "\x1b") {
        // Cancel
        this.editState = null;
        this.commitError = null;
        return { type: "none" };
      }
      if (data === "\r") {
        // Commit. A returned string is a rejection: stay in the editor so the
        // value can be corrected, with the reason on the row.
        const setting = this.findSetting(state.settingId);
        const err = setting?.onTextCommit ? setting.onTextCommit(state.buffer) : null;
        if (typeof err === "string" && err.length > 0) {
          this.commitError = err;
          return { type: "none" };
        }
        this.commitError = null;
        this.editState = null;
        return { type: "none" };
      }
      if (data === "\x7f" || data === "\b") {
        // Backspace
        if (state.cursorPos > 0) {
          state.buffer = state.buffer.slice(0, state.cursorPos - 1) + state.buffer.slice(state.cursorPos);
          state.cursorPos--;
        }
        return { type: "none" };
      }
      if (data === "\x1b[D") { // Left
        if (state.cursorPos > 0) state.cursorPos--;
        return { type: "none" };
      }
      if (data === "\x1b[C") { // Right
        if (state.cursorPos < state.buffer.length) state.cursorPos++;
        return { type: "none" };
      }
      if (data === "\x1b[H" || data === "\x01") { // Home / Ctrl-a
        state.cursorPos = 0;
        return { type: "none" };
      }
      if (data === "\x1b[F" || data === "\x05") { // End / Ctrl-e
        state.cursorPos = state.buffer.length;
        return { type: "none" };
      }
      // Printable character
      if (data.length === 1 && data.charCodeAt(0) >= 32) {
        state.buffer = state.buffer.slice(0, state.cursorPos) + data + state.buffer.slice(state.cursorPos);
        state.cursorPos++;
        return { type: "none" };
      }
      return { type: "none" };
    }

    if (this.editState.mode === "list") {
      const state = this.editState;
      if (data === "\x1b") {
        this.editState = null;
        return { type: "none" };
      }
      if (data === "\x1b[D" || data === "h") { // Left
        state.optionIndex = (state.optionIndex - 1 + state.options.length) % state.options.length;
        return { type: "none" };
      }
      if (data === "\x1b[C" || data === "l") { // Right
        state.optionIndex = (state.optionIndex + 1) % state.options.length;
        return { type: "none" };
      }
      if (data === "\r") {
        const setting = this.findSetting(state.settingId);
        const value = state.options[state.optionIndex];
        if (setting?.onOptionSelect) setting.onOptionSelect(value);
        this.editState = null;
        return { type: "none" };
      }
      return { type: "none" };
    }

    if (this.editState.mode === "picker") {
      const state = this.editState;
      if (data === "\x1b") {
        this.editState = null;
        return { type: "none" };
      }
      if (data === "\x1b[A") { // Up
        if (state.selectedIndex > 0) state.selectedIndex--;
        return { type: "none" };
      }
      if (data === "\x1b[B") { // Down
        if (state.selectedIndex < state.filtered.length - 1) state.selectedIndex++;
        return { type: "none" };
      }
      if (data === "\r") {
        const item = state.filtered[state.selectedIndex];
        // A multi picker toggles and stays open — picking a subset in one
        // visit is the whole point. Single pickers commit and close via
        // their own onSelect.
        if (item) state.onSelect(item);
        return { type: "none" };
      }
      if (data === "\x7f" || data === "\b") {
        if (state.filter.length > 0) {
          state.filter = state.filter.slice(0, -1);
          this.applyPickerFilter(state);
        }
        return { type: "none" };
      }
      // Printable character — filter
      if (data.length === 1 && data.charCodeAt(0) >= 32) {
        state.filter += data;
        this.applyPickerFilter(state);
        return { type: "none" };
      }
      return { type: "none" };
    }

    return { type: "none" };
  }

  private applyPickerFilter(state: Extract<EditState, { mode: "picker" }>): void {
    const q = state.filter.toLowerCase();
    state.filtered = q
      ? state.items.filter((i) => i.label.toLowerCase().includes(q))
      : state.items;
    state.selectedIndex = Math.min(state.selectedIndex, Math.max(0, state.filtered.length - 1));
  }

  private handleEnter(): SettingsAction {
    const nodes = this.buildNodes();
    const node = nodes[this.selectedIndex];
    if (!node) return { type: "none" };

    if (node.kind === "category") {
      const cat = this.categories.find((c) => c.label === node.label);
      if (cat) cat.collapsed = !cat.collapsed;
      return { type: "none" };
    }

    if (node.kind === "setting") {
      const setting = node.setting;

      if (setting.type === "boolean" && setting.onToggle) {
        setting.onToggle();
        return { type: "none" };
      }

      if (setting.type === "text" && setting.onTextCommit) {
        const current = setting.getEditValue?.() ?? setting.getValue();
        this.editState = { mode: "text", settingId: setting.id, buffer: current, cursorPos: current.length };
        return { type: "none" };
      }

      if (setting.type === "list" && setting.options && setting.onOptionSelect) {
        const current = setting.getValue();
        const idx = setting.options.indexOf(current);
        this.editState = {
          mode: "list",
          settingId: setting.id,
          optionIndex: idx >= 0 ? idx : 0,
          options: setting.options,
        };
        return { type: "none" };
      }

      if (setting.type === "map") {
        if (this.expandedMaps.has(setting.id)) {
          this.expandedMaps.delete(setting.id);
        } else {
          this.expandedMaps.add(setting.id);
        }
        return { type: "none" };
      }

      if (setting.type === "action") {
        setting.onActivate?.();
        return { type: "none" };
      }

      if (setting.type === "multiselect" && setting.getOptions && setting.onToggleOption) {
        const items = setting.getOptions();
        const toggle = setting.onToggleOption;
        this.editState = {
          mode: "picker",
          settingId: setting.id,
          title: setting.label,
          items,
          filtered: items,
          selectedIndex: 0,
          filter: "",
          multi: true,
          onSelect: (item) => toggle(item.id),
        };
        return { type: "none" };
      }
    }

    if (node.kind === "map-add") {
      const setting = this.findSetting(node.parentId);
      if (setting?.getMapKeyOptions && setting?.getMapValueOptions && setting?.onMapSave) {
        const keyOptions = setting.getMapKeyOptions();
        if (keyOptions.length > 0) {
          const valOpts = setting.getMapValueOptions();
          const saveFn = setting.onMapSave;
          this.editState = {
            mode: "picker",
            settingId: node.parentId,
            title: "Select team",
            items: keyOptions,
            filtered: keyOptions,
            selectedIndex: 0,
            filter: "",
            onSelect: (keyItem) => {
              // After picking a key, open a second picker for value
              this.editState = {
                mode: "picker",
                settingId: node.parentId,
                title: `Repository for ${keyItem.label}`,
                items: valOpts,
                filtered: valOpts,
                selectedIndex: 0,
                filter: "",
                onSelect: (valItem) => {
                  saveFn(keyItem.id, valItem.id);
                  this.editState = null;
                },
              };
            },
          };
        }
      }
      return { type: "none" };
    }

    if (node.kind === "map-entry") {
      const setting = this.findSetting(node.parentId);
      if (setting?.getMapValueOptions && setting?.onMapSave) {
        const valOpts = setting.getMapValueOptions();
        const saveFn = setting.onMapSave;
        this.editState = {
          mode: "picker",
          settingId: node.parentId,
          title: `Repository for ${node.key}`,
          items: valOpts,
          filtered: valOpts,
          selectedIndex: 0,
          filter: "",
          onSelect: (valItem) => {
            saveFn(node.key, valItem.id);
            this.editState = null;
          },
        };
      }
      return { type: "none" };
    }

    return { type: "none" };
  }

  private moveUp(): void {
    if (this.selectedIndex > 0) this.selectedIndex--;
    this.ensureVisible();
  }

  private moveDown(): void {
    const nodes = this.buildNodes();
    if (this.selectedIndex < nodes.length - 1) this.selectedIndex++;
    this.ensureVisible();
  }

  /** Keep the cursor on a real node after the filter changes the node list. */
  private clampSelection(): void {
    const n = this.buildNodes().length;
    if (this.selectedIndex >= n) this.selectedIndex = Math.max(0, n - 1);
    this.scrollOffset = 0;
    this.ensureVisible();
  }

  private getSelectedNode(): SettingsNode | null {
    const nodes = this.buildNodes();
    return nodes[this.selectedIndex] ?? null;
  }

  private getSelectedMapEntry(): boolean {
    const node = this.getSelectedNode();
    return node?.kind === "map-entry";
  }

  private findSetting(id: string): SettingDef | null {
    for (const cat of this.categories) {
      for (const s of cat.settings) {
        if (s.id === id) return s;
      }
    }
    return null;
  }

  private buildNodes(): SettingsNode[] {
    const q = this.filter.trim().toLowerCase();
    const nodes: SettingsNode[] = [];
    for (const cat of this.categories) {
      const settings = q
        ? cat.settings.filter((x) => x.label.toLowerCase().includes(q))
        : cat.settings;
      // A category with nothing matching is dropped whole: leaving its header
      // would claim a section the filter has emptied.
      if (q && settings.length === 0) continue;
      nodes.push({
        kind: "category",
        label: cat.label,
        collapsed: cat.collapsed,
        count: settings.length,
      });
      // A filter overrides collapse. The user asked to see matches, and a match
      // hidden inside a collapsed section reads as no match at all.
      if (cat.collapsed && !q) continue;
      for (const setting of settings) {
        nodes.push({ kind: "setting", setting });
        // Expanded map entries
        if (setting.type === "map" && this.expandedMaps.has(setting.id) && setting.getMapEntries) {
          for (const entry of setting.getMapEntries()) {
            nodes.push({ kind: "map-entry", parentId: setting.id, key: entry.key, value: entry.value });
          }
          nodes.push({ kind: "map-add", parentId: setting.id });
        }
      }
    }
    return nodes;
  }

  private renderPicker(cols: number, rows: number, state: Extract<EditState, { mode: "picker" }>): CellGrid {
    const grid = createGrid(cols, rows);
    const pad = 2;

    // Title
    writeString(grid, 0, pad, state.title, HEADER_ATTRS);

    // Filter input
    const filterLabel = "Filter: ";
    writeString(grid, 1, pad, filterLabel, HINT_ATTRS);
    const filterStart = pad + filterLabel.length;
    const filterWidth = cols - filterStart - pad;
    const filterBg = " ".repeat(filterWidth);
    writeString(grid, 1, filterStart, filterBg, EDIT_BG);
    writeString(grid, 1, filterStart, state.filter, EDIT_TEXT);
    const filterCursorCol = filterStart + state.filter.length;
    if (filterCursorCol < cols - pad) {
      writeString(grid, 1, filterCursorCol, " ", EDIT_CURSOR);
    }

    // Items
    const startRow = 3;
    const maxVisible = rows - startRow;
    let scrollOff = 0;
    if (state.selectedIndex >= maxVisible) {
      scrollOff = state.selectedIndex - maxVisible + 1;
    }

    // Checkbox state is re-read from the setting on every frame rather than
    // snapshotted into the EditState, so a toggle shows up immediately.
    const checked = state.multi
      ? new Set(this.findSetting(state.settingId)?.getSelected?.() ?? [])
      : null;

    for (let i = 0; i < state.filtered.length; i++) {
      const row = startRow + i - scrollOff;
      if (row < startRow || row >= rows) continue;
      const item = state.filtered[i];
      const isSelected = i === state.selectedIndex;

      if (isSelected) {
        writeString(grid, row, pad, "▸", CURSOR_ATTRS);
      }
      const label = checked ? `[${checked.has(item.id) ? "x" : " "}] ${item.label}` : item.label;
      writeString(grid, row, pad + 2, label, isSelected ? LABEL_ACTIVE : LABEL_ATTRS);
    }

    if (state.filtered.length === 0) {
      writeString(grid, startRow, pad + 2, "No matches", DIM_ATTRS);
    }

    // Hint
    const hintRow = rows - 1;
    writeString(
      grid,
      hintRow,
      pad,
      state.multi
        ? "↑↓ select  ·  Enter toggle  ·  Esc done  ·  type to filter"
        : "↑↓ select  ·  Enter confirm  ·  Esc cancel  ·  type to filter",
      HINT_ATTRS,
    );

    return grid;
  }

  // scrollOffset is measured in row-plan positions (rowPlan indices), not
  // node indices, since the plan's blank spacer rows consume screen space
  // too. Convert the selected node index to its row-plan position before
  // clamping — this keeps the selected setting on-screen without ever
  // being able to land scroll on a blank row itself (selectedIndex only
  // ever addresses "node" entries).
  private ensureVisible(): void {
    const rowPlan = this.buildRowPlan(this.buildNodes());
    const rowPos = rowPlan.findIndex((r) => r.kind === "node" && r.nodeIndex === this.selectedIndex);
    if (rowPos < 0) return;

    // Reserve CONTENT_START_ROW rows above the content and 1 row for the
    // hint line at the bottom.
    const visibleCount = Math.max(1, this.lastRenderRows - CONTENT_START_ROW - 2);
    const relativeIdx = rowPos - this.scrollOffset;
    if (relativeIdx < 0) {
      this.scrollOffset = rowPos;
    } else if (relativeIdx >= visibleCount) {
      this.scrollOffset = rowPos - visibleCount + 1;
    }
  }
}
