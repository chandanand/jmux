// src/ghost-preview.ts
//
// The ghost preview: a full-area surface showing an unstarted issue and what
// starting it will do.
//
// Clicking a ghost row used to provision a worktree and a session on the spot.
// It now focuses the row and opens this instead, so "look before you commit" is
// possible at all. Start is still one keypress away — it just isn't the only
// thing a click can mean.
//
// Same shape as SettingsScreen / WorkflowScreen: a `render(cols, rows)` grid
// composited through `fullScreenLayout`, input handed in by main.ts, and every
// outside dependency arriving through a port so the screen itself knows nothing
// about tmux, adapters or config.

import type { CellGrid } from "./types";
import { ColorMode } from "./types";
import { createGrid, writeString, textCols, truncateToCols, type CellAttrs } from "./cell-grid";
import type { Issue } from "./adapters/types";
import {
  buildIssueDetailLines,
  paintDetailLines,
  maxDetailScroll,
  DETAIL_LABEL,
  DETAIL_DIM,
} from "./issue-detail";
import { buildPreflightLines, preflightActionLabel, type Preflight } from "./ghost-preflight";
import { neutralFg } from "./theme";

/**
 * How a start attempt ended.
 *
 * A bare promise cannot carry this: `startWorkOnIssue` catches its own failures
 * into an error modal and the unmapped-repo path opens the session picker, so
 * both resolve normally. Without a verdict the surface would close itself on
 * top of a modal it just opened.
 */
export type StartOutcome =
  | "switched"    // an existing session was targeted
  | "created"     // a session was provisioned
  | "handed-off"  // the manual session picker is now up
  | "failed"      // an error modal is now up
  | "gone";       // the issue vanished before we could act

export interface GhostPreviewPort {
  /** null once the issue has left the global list — drives the gone state. */
  getIssue(issueId: string): Issue | null;
  getPreflight(issueId: string): Preflight | null;
  onStart(issueId: string): Promise<StartOutcome>;
  onOpenInBrowser(issueId: string): void;
  onChangeStatus(issueId: string): void;
  /**
   * Put this issue into a session that already exists, instead of provisioning
   * one for it. The counterpart to Start for work that belongs to a feature
   * somebody is already on: no worktree, no branch, no second agent.
   *
   * Opens a picker, so it hands off exactly like the manual session modal does
   * — which is why the preview stays open underneath rather than closing.
   */
  onAttachToSession(issueId: string): void;
}

/** The issue a preview is opened on. The identifier is cached — see `open`. */
export interface GhostPreviewTarget {
  id: string;
  identifier: string;
}

const TITLE_ATTRS: CellAttrs = { fg: 7, fgMode: ColorMode.Palette, bold: true };
const KEY_ATTRS: CellAttrs = { fg: 2, fgMode: ColorMode.Palette };
const LABEL_ATTRS: CellAttrs = { fg: 8, fgMode: ColorMode.Palette, dim: true };

/** Wide terminals get a measure, not full-bleed prose. */
const MAX_CONTENT_COLS = 100;
const HEADER_ROWS = 2;   // title + blank
const ACTION_ROWS = 2;   // blank + action bar

export function rebuildGhostPreviewColors(): void {
  const n = neutralFg(7);
  TITLE_ATTRS.fg = n.fg;
  TITLE_ATTRS.fgMode = n.fgMode;
}
rebuildGhostPreviewColors();

export class GhostPreview {
  private port: GhostPreviewPort | null = null;
  private target: GhostPreviewTarget | null = null;
  private scrollOffset = 0;
  private _open = false;
  private starting = false;
  /** Rows the last frame had, so paging can move by a screenful. */
  private lastBodyRows = 10;

  get isOpen(): boolean { return this._open; }

  getIssueId(): string | null { return this.target?.id ?? null; }

  /**
   * `target` carries the identifier as well as the id because the port cannot
   * supply it later: once the issue drops out of the global list `getIssue`
   * returns null, and `Issue.id` is an opaque tracker key, not something to
   * show a human. Cheap to cache, impossible to recover.
   */
  open(port: GhostPreviewPort, target: GhostPreviewTarget): void {
    this.port = port;
    this.target = target;
    this.scrollOffset = 0;
    this.starting = false;
    this._open = true;
  }

  close(): void {
    this._open = false;
    this.port = null;
    this.target = null;
    this.starting = false;
  }

  // --- Input ---

  handleInput(data: string): void {
    const port = this.port;
    const target = this.target;
    if (!port || !target) return;

    if (data === "\x1b" || data === "q") { this.close(); return; }

    if (data === "\x1b[A") { this.scrollBy(-1); return; }
    if (data === "\x1b[B") { this.scrollBy(1); return; }
    if (data === "\x1b[5~") { this.scrollBy(-this.lastBodyRows); return; }
    if (data === "\x1b[6~") { this.scrollBy(this.lastBodyRows); return; }

    // Every action below needs the issue to still exist. The gone state is a
    // dead end by design: nothing to start, nothing to re-status, nothing to
    // open — only a way back.
    if (!port.getIssue(target.id)) return;

    if (data === "\r") { void this.start(); return; }
    if (data === "a") { port.onAttachToSession(target.id); return; }
    if (data === "o") { port.onOpenInBrowser(target.id); return; }
    if (data === "s") { port.onChangeStatus(target.id); return; }
  }

  /**
   * Nothing below this guards against reentrancy — a second Enter would run a
   * second provisioning attempt before `currentSessions` has caught up with the
   * first, producing two worktrees for one issue.
   */
  private async start(): Promise<void> {
    const port = this.port;
    const target = this.target;
    if (!port || !target || this.starting) return;
    this.starting = true;
    let outcome: StartOutcome;
    try {
      outcome = await port.onStart(target.id);
    } catch {
      outcome = "failed";
    }
    this.starting = false;
    // Only the two outcomes that actually moved us somewhere close the surface.
    // `handed-off` and `failed` both leave a modal on top of this screen, and
    // closing underneath it would strand the user; `gone` falls through to the
    // no-longer-available state, which is more informative than a blank screen.
    if (outcome === "switched" || outcome === "created") this.close();
  }

  private scrollBy(delta: number): void {
    this.scrollOffset = Math.max(0, this.scrollOffset + delta);
    // The upper bound is applied in render(), where the true line count for the
    // current width is known.
  }

  // --- Render ---

  render(cols: number, rows: number): CellGrid {
    const grid = createGrid(cols, rows);
    const port = this.port;
    const target = this.target;
    if (!port || !target) return grid;

    const contentCols = Math.min(cols, MAX_CONTENT_COLS);
    const issue = port.getIssue(target.id);

    writeString(grid, 0, 2, truncateToCols(target.identifier, contentCols - 4), TITLE_ATTRS);

    if (!issue) {
      this.renderGone(grid, rows);
      return grid;
    }

    const bodyStart = HEADER_ROWS;
    const bodyRows = Math.max(1, rows - HEADER_ROWS - ACTION_ROWS);
    this.lastBodyRows = bodyRows;

    const pf = port.getPreflight(target.id);
    const lines = buildIssueDetailLines(issue, contentCols, {
      afterMetadata: pf ? buildPreflightLines(pf, contentCols) : undefined,
    });

    // Clamp here, not in scrollBy: the line count depends on the width (the
    // description and comments re-wrap) and on the content (a poll can drop
    // comments), so an offset that was valid last frame can be past the end of
    // this one. Without this a resize leaves the body blank.
    this.scrollOffset = Math.min(this.scrollOffset, maxDetailScroll(lines.length, bodyRows));

    paintDetailLines(grid, bodyStart, 0, contentCols, bodyRows, lines, this.scrollOffset);
    this.renderActionBar(grid, rows - 1, pf);
    return grid;
  }

  private renderGone(grid: CellGrid, rows: number): void {
    writeString(grid, HEADER_ROWS, 2, "This issue is no longer available.", DETAIL_DIM);
    writeString(
      grid,
      HEADER_ROWS + 1,
      2,
      "It may have been closed, reassigned, or removed from your queues.",
      DETAIL_DIM,
    );
    this.writeAction(grid, rows - 1, 2, "[Esc]", " Back");
  }

  private renderActionBar(grid: CellGrid, row: number, pf: Preflight | null): void {
    let col = 2;
    const primary = this.starting
      ? "Starting…"
      : preflightActionLabel(pf?.action ?? "start");
    col = this.writeAction(grid, row, col, "[↵]", ` ${primary}  `);
    col = this.writeAction(grid, row, col, "[a]", " Add to session  ");
    col = this.writeAction(grid, row, col, "[s]", " Status  ");
    col = this.writeAction(grid, row, col, "[o]", " Open  ");
    this.writeAction(grid, row, col, "[Esc]", " Back");
  }

  private writeAction(grid: CellGrid, row: number, col: number, key: string, label: string): number {
    writeString(grid, row, col, key, this.starting ? LABEL_ATTRS : KEY_ATTRS);
    col += textCols(key);
    writeString(grid, row, col, label, DETAIL_LABEL);
    return col + textCols(label);
  }
}
