import type { CellGrid } from "./types";
import { ColorMode } from "./types";
import { createGrid, writeStyledLine, textCols, type CellAttrs } from "./cell-grid";
import { packChips, type PlacedChip } from "./band-layout";
import { theme, neutralFg } from "./theme";
import { tokens } from "./chrome-tokens";

export type InfoTab = "diff" | string; // "diff" is special, others are view IDs

// These attr objects are re-themed in place by rebuildInfoPanelColors(): the
// active tab uses the shared chrome accent (the same one the window-tab
// underline uses, so "active tab" looks identical in both tab strips), the
// hovered tab uses neutral text (terminal default fg once a theme is
// detected), and the tab-bar surface tracks the detected background.
const ACTIVE_TAB: CellAttrs = {
  fg: tokens.accent.fg,
  fgMode: tokens.accent.fgMode,
  bold: true,
};

const INACTIVE_TAB: CellAttrs = {
  fg: 8,
  fgMode: ColorMode.Palette,
  dim: true,
};

const HOVERED_TAB: CellAttrs = {
  fg: 7,
  fgMode: ColorMode.Palette,
};

const TAB_BG: CellAttrs = {
  bg: theme.surface,
  bgMode: ColorMode.RGB,
};

export function rebuildInfoPanelColors(): void {
  TAB_BG.bg = theme.surface;
  // chrome-tokens is rebuilt before this (main.ts's onBackground handler), so
  // the accent read here is already adapted to the detected background.
  ACTIVE_TAB.fg = tokens.accent.fg;
  ACTIVE_TAB.fgMode = tokens.accent.fgMode;
  const hovered = neutralFg(7);
  HOVERED_TAB.fg = hovered.fg;
  HOVERED_TAB.fgMode = hovered.fgMode;
}
rebuildInfoPanelColors();

export interface InfoPanelConfig {
  viewIds: string[];      // ordered list of view IDs to show as tabs
  viewLabels: Map<string, string>; // id → label for tab bar rendering
  /** id → item count, rendered beside the label. Absent = no count shown. */
  viewCounts?: Map<string, number>;
}

export class InfoPanel {
  private _tabs: InfoTab[] = [];
  private _activeTab: InfoTab = "diff";
  private _viewLabels = new Map<string, string>();
  private _viewCounts = new Map<string, number>();
  // Survives rebuildTabs deliberately: a config reload rebuilds the view tabs,
  // and blanking the diff badge there would drop live state for a change that
  // has nothing to do with it.
  private _diffBadge: string | null = null;

  constructor(config: InfoPanelConfig) {
    this.rebuildTabs(config);
  }

  get tabs(): InfoTab[] {
    return [...this._tabs];
  }

  get activeTab(): InfoTab {
    return this._activeTab;
  }

  get hasMultipleTabs(): boolean {
    return this._tabs.length > 1;
  }

  /**
   * Whether the Diff tab has anything live to report. The tab strip hides
   * itself for a lone tab, so this is what earns the strip a row when Diff is
   * the only one — otherwise the badge would be invisible to every user with
   * no tracker configured.
   */
  get hasDiffBadge(): boolean {
    return this._diffBadge !== null;
  }

  /**
   * Whether the strip is drawn at all. A lone unlabelled tab is pure chrome,
   * which is why the strip hides for it; a lone tab *carrying live diff stats*
   * is not — it's the panel's header, and without it the badge is invisible to
   * every user with no tracker configured.
   *
   * Read by the render path *and* by the router's hit-test: the strip shares
   * row 0 with the toolbar, so "is it drawn?" decides who owns those columns,
   * and a second copy of this predicate could paint one owner while routing
   * clicks to the other.
   */
  get tabBarShown(): boolean {
    return this.hasMultipleTabs || this.hasDiffBadge;
  }

  updateConfig(config: InfoPanelConfig): void {
    const prevActive = this._activeTab;
    this.rebuildTabs(config);
    if (!this._tabs.includes(prevActive)) {
      this._activeTab = "diff";
    }
  }

  setActiveTab(tab: InfoTab): void {
    if (this._tabs.includes(tab)) {
      this._activeTab = tab;
    }
  }

  nextTab(): void {
    if (this._tabs.length <= 1) return;
    const idx = this._tabs.indexOf(this._activeTab);
    this._activeTab = this._tabs[(idx + 1) % this._tabs.length];
  }

  prevTab(): void {
    if (this._tabs.length <= 1) return;
    const idx = this._tabs.indexOf(this._activeTab);
    this._activeTab = this._tabs[(idx - 1 + this._tabs.length) % this._tabs.length];
  }

  /**
   * The Diff tab's live badge — "+142 −38 ●2" — or null for none.
   *
   * Arrives pre-formatted from main.ts rather than being derived here, for the
   * same reason `setSessionWorkflow` exists on the sidebar: composing it needs
   * hunk's daemon and the panel's current width, and neither belongs in a
   * module whose job is a tab strip. See `formatDiffBadge` in hunk/protocol.ts.
   */
  setDiffBadge(badge: string | null): void {
    this._diffBadge = badge;
  }

  /** Public so tab-strip rendering can be asserted without pixel-peeping. */
  tabLabel(tab: InfoTab): string {
    // Same rule as a view's count: the badge is what makes "is there anything
    // to look at?" answerable without switching to the tab to find out.
    if (tab === "diff") return this._diffBadge ? ` Diff ${this._diffBadge} ` : " Diff ";
    const label = this._viewLabels.get(tab) ?? tab;
    // A count on the tab itself is what makes an attention-model layout work:
    // "is anything urgent?" shouldn't require switching tabs to find out.
    const count = this._viewCounts.get(tab);
    return count ? ` ${label} ${count} ` : ` ${label} `;
  }

  // Places every tab once (paint and hit-test both read from this). No
  // budget cutoff — `getTabRanges` never dropped a tab that didn't fit
  // before this refactor (it just returned an unreachable range past the
  // grid's width), so `budget: Infinity` preserves that rather than
  // introducing a new whole-chip-drop behaviour here.
  private layoutTabs(): PlacedChip[] {
    const items = this._tabs.map((tab) => ({ id: tab, width: textCols(this.tabLabel(tab)) }));
    return packChips(items, { start: 1, budget: Infinity, align: "left", sepWidth: 1 });
  }

  getTabBarGrid(cols: number, hoveredTab?: string | null): CellGrid {
    const grid = createGrid(cols, 1);

    // Fill leading padding with background
    if (cols > 0) {
      grid.cells[0][0].bg = TAB_BG.bg!;
      grid.cells[0][0].bgMode = TAB_BG.bgMode!;
    }

    const chips = this.layoutTabs();
    let col = 1;
    for (let i = 0; i < chips.length; i++) {
      const chip = chips[i];
      const tab = chip.id;
      const isActive = tab === this._activeTab;
      const isHovered = !isActive && hoveredTab === tab;
      const label = this.tabLabel(tab);
      const attrs: CellAttrs = {
        ...(isActive ? ACTIVE_TAB : isHovered ? HOVERED_TAB : INACTIVE_TAB),
        ...TAB_BG,
      };
      writeStyledLine(grid, 0, chip.x, [{ text: label, attrs }]);
      col = chip.x + chip.width;

      if (i < chips.length - 1) {
        writeStyledLine(grid, 0, col, [{ text: "│", attrs: { ...INACTIVE_TAB, ...TAB_BG } }]);
        col += 1;
      }
    }

    // Fill remaining columns with background
    for (let c = col; c < cols; c++) {
      grid.cells[0][c].bg = TAB_BG.bg!;
      grid.cells[0][c].bgMode = TAB_BG.bgMode!;
    }

    return grid;
  }

  getTabRanges(): Array<{ tab: InfoTab; startCol: number; endCol: number }> {
    return this.layoutTabs().map((chip) => ({
      tab: chip.id,
      startCol: chip.x,
      endCol: chip.x + chip.width - 1,
    }));
  }

  private rebuildTabs(config: InfoPanelConfig): void {
    this._tabs = ["diff"];
    for (const id of config.viewIds) {
      this._tabs.push(id);
    }
    this._viewLabels = config.viewLabels;
    this._viewCounts = config.viewCounts ?? new Map();
  }
}
