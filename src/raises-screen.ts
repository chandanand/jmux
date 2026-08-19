// src/raises-screen.ts
//
// The inbox screen: the queue of raises waiting on a human, meant to be
// worked in one sitting. Same shape as SettingsScreen / WorkflowScreen /
// GhostPreview — a render(cols, rows) grid, input handed in by main.ts, and
// every outside dependency arriving through a port so the screen itself
// knows nothing about tmux, the config path or the store on disk.
//
// A store in the `error` state (see raises/store.ts's `readRaises`) renders
// the error, never an empty queue — a queue of questions waiting on a human
// must never read back as "nothing to do" because its file could not be
// parsed.

import type { CellGrid } from "./types";
import { createGrid, writeString, truncateToCols, type CellAttrs } from "./cell-grid";
import { wrapText } from "./capture-modal";
import { tokens } from "./chrome-tokens";
import type { Raise, RaiseScope } from "./raises/types";
import type { ReadResult } from "./raises/store";

/**
 * Everything the screen reads and does, behind one interface — the same
 * getter/callback dialect as `WorkflowPort` and `GhostPreviewPort`.
 */
export interface RaisesPort {
  /** Read fresh each call. Never cached by the screen — see the module doc. */
  getResult(): ReadResult;
  /** Record the human's choice: an option id, never a display position. */
  answer(id: string, optionId: string): void;
  /**
   * Jump to the raising session. Takes the whole scope, not just a session
   * id, because the jump also needs the socket: two tmux sockets can hold a
   * session with the same name, and a name-only jump would land on the wrong
   * server's session.
   */
  jump(scope: Extract<RaiseScope, { kind: "session" }>): void;
}

// --- Colours ---
//
// Every attr object here is patched in place by rebuildRaisesColors() so a
// theme change re-tones the screen without re-importing, matching how
// workflow-screen.ts and settings-screen.ts handle the same problem.

const TITLE_ATTRS: CellAttrs = {};
const DIM_ATTRS: CellAttrs = {};
const LABEL_ATTRS: CellAttrs = {};
const LABEL_ACTIVE: CellAttrs = {};
const VALUE_ATTRS: CellAttrs = {};
const WARN_ATTRS: CellAttrs = {};
const OPTION_ATTRS: CellAttrs = {};
const REC_ATTRS: CellAttrs = {};
const SNAPSHOT_ATTRS: CellAttrs = {};

export function rebuildRaisesColors(): void {
  const assign = (target: CellAttrs, src: CellAttrs): void => {
    delete target.bold;
    delete target.dim;
    Object.assign(target, src);
  };
  assign(TITLE_ATTRS, { ...tokens.accent, bold: true });
  assign(DIM_ATTRS, tokens.textTertiary);
  assign(LABEL_ATTRS, tokens.textPrimary);
  assign(LABEL_ACTIVE, { ...tokens.accent, bold: true });
  assign(VALUE_ATTRS, tokens.textSecondary);
  assign(WARN_ATTRS, tokens.failure);
  assign(OPTION_ATTRS, tokens.textPrimary);
  assign(REC_ATTRS, tokens.affirmative);
  assign(SNAPSHOT_ATTRS, { ...tokens.textTertiary, dim: true });
}
rebuildRaisesColors();

const CONTENT_START_ROW = 2;
/** How many lines of a pane snapshot show before the preview truncates. */
const SNAPSHOT_PREVIEW_LINES = 4;
const HINT_TEXT = "[↑↓] select   [1-9] answer   [a] jump to session   [Esc] close";

interface Line {
  text: string;
  attrs: CellAttrs;
}

function badgeFor(raise: Raise): string {
  return raise.scope.kind === "issue" ? `[${raise.scope.identifier}]` : raise.scope.sessionName;
}

/** One card: badge/session name, question, numbered options, recommendation, reasoning, snapshot. */
function buildCard(raise: Raise, selected: boolean, width: number): Line[] {
  const lines: Line[] = [];
  const cursor = selected ? "> " : "  ";
  const stateTag = raise.state === "open" ? "" : `  (${raise.state})`;
  lines.push({ text: `${cursor}${badgeFor(raise)}${stateTag}`, attrs: selected ? LABEL_ACTIVE : LABEL_ATTRS });

  for (const q of wrapText(raise.question, width - 2)) {
    lines.push({ text: `  ${q}`, attrs: VALUE_ATTRS });
  }

  raise.options.forEach((opt, i) => {
    const rec = opt.id === raise.recommendation ? "  (recommended)" : "";
    const chosen = raise.answer?.optionId === opt.id ? "  (chosen)" : "";
    lines.push({ text: `  ${i + 1}) ${opt.text}${rec}${chosen}`, attrs: OPTION_ATTRS });
  });

  const recommended = raise.options.find((o) => o.id === raise.recommendation);
  lines.push({
    text: `  Recommended: ${recommended ? recommended.text : raise.recommendation}`,
    attrs: REC_ATTRS,
  });

  const whyLines = wrapText(raise.why, Math.max(1, width - 8));
  whyLines.forEach((w, i) => {
    lines.push({ text: i === 0 ? `  Why: ${w}` : `        ${w}`, attrs: DIM_ATTRS });
  });

  if (raise.snapshot === null) {
    lines.push({ text: "  Snapshot: (none)", attrs: DIM_ATTRS });
  } else {
    lines.push({ text: "  Snapshot:", attrs: DIM_ATTRS });
    const snapLines = raise.snapshot.replace(/\n+$/, "").split("\n");
    snapLines.slice(0, SNAPSHOT_PREVIEW_LINES).forEach((s) => {
      lines.push({ text: `  │ ${truncateToCols(s, Math.max(1, width - 4))}`, attrs: SNAPSHOT_ATTRS });
    });
    if (snapLines.length > SNAPSHOT_PREVIEW_LINES) {
      lines.push({ text: `  │ … ${snapLines.length - SNAPSHOT_PREVIEW_LINES} more line(s)`, attrs: SNAPSHOT_ATTRS });
    }
  }

  lines.push({ text: "", attrs: {} });
  return lines;
}

export class RaisesScreen {
  private port: RaisesPort | null = null;
  private selectedIndex = 0;
  private scrollOffset = 0;
  private _open = false;

  get isOpen(): boolean {
    return this._open;
  }

  open(port: RaisesPort): void {
    this.port = port;
    this.selectedIndex = 0;
    this.scrollOffset = 0;
    this._open = true;
  }

  close(): void {
    this._open = false;
    this.port = null;
  }

  /** The raises the queue works, oldest first. A resolved raise is done; it never occupies the queue. */
  private queue(): Raise[] {
    const result = this.port?.getResult();
    if (!result || result.kind !== "valid") return [];
    return result.raises
      .filter((r) => r.state !== "resolved")
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  private clampSelection(count: number): void {
    if (count === 0) {
      this.selectedIndex = 0;
      return;
    }
    this.selectedIndex = Math.max(0, Math.min(this.selectedIndex, count - 1));
  }

  // --- Input ---

  handleInput(data: string): void {
    if (!this.port) return;
    if (data === "\x1b" || data === "q") {
      this.close();
      return;
    }
    if (data === "\x1b[A") {
      this.move(-1);
      return;
    }
    if (data === "\x1b[B") {
      this.move(1);
      return;
    }

    const q = this.queue();
    this.clampSelection(q.length);
    const raise = q[this.selectedIndex];
    if (!raise) return;

    if (data === "a") {
      if (raise.scope.kind === "session") this.port.jump(raise.scope);
      return;
    }

    // A number key answers the option at that display position — but the
    // choice recorded is the option's id, never the position, because
    // answering by position would record a decision the human did not make
    // the moment options are reordered or renumbered underneath the queue.
    if (/^[1-9]$/.test(data)) {
      if (raise.state !== "open") return;
      const option = raise.options[Number(data) - 1];
      if (!option) return;
      this.port.answer(raise.id, option.id);
      return;
    }
  }

  private move(delta: number): void {
    const q = this.queue();
    if (q.length === 0) return;
    this.selectedIndex = Math.max(0, Math.min(this.selectedIndex + delta, q.length - 1));
  }

  // --- Render ---

  render(cols: number, rows: number): CellGrid {
    const grid = createGrid(cols, rows);
    const port = this.port;
    if (!port) return grid;

    const result = port.getResult();

    if (result.kind === "error") {
      writeString(grid, 0, 2, "Raises", TITLE_ATTRS);
      writeString(grid, CONTENT_START_ROW, 2, "The raise queue could not be read.", WARN_ATTRS);
      const errLines = wrapText(result.why, Math.max(1, cols - 4));
      errLines.forEach((line, i) => {
        writeString(grid, CONTENT_START_ROW + 2 + i, 2, truncateToCols(line, cols - 4), WARN_ATTRS);
      });
      return grid;
    }

    const q = this.queue();
    this.clampSelection(q.length);

    writeString(grid, 0, 2, `Raises · ${q.length} open`, TITLE_ATTRS);

    if (q.length === 0) {
      writeString(grid, CONTENT_START_ROW, 2, "No open raises.", DIM_ATTRS);
      return grid;
    }

    const width = Math.max(20, Math.min(cols - 4, 96));
    const visibleRows = Math.max(1, rows - CONTENT_START_ROW - 1);

    const allLines: Line[] = [];
    const startOffsets: number[] = [];
    q.forEach((raise, i) => {
      startOffsets.push(allLines.length);
      allLines.push(...buildCard(raise, i === this.selectedIndex, width));
    });

    const selectedStart = startOffsets[this.selectedIndex] ?? 0;
    if (selectedStart < this.scrollOffset) this.scrollOffset = selectedStart;
    else if (selectedStart - this.scrollOffset >= visibleRows) this.scrollOffset = selectedStart - visibleRows + 1;
    this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, Math.max(0, allLines.length - visibleRows)));

    for (let r = 0; r < visibleRows; r++) {
      const lineIdx = r + this.scrollOffset;
      if (lineIdx >= allLines.length) break;
      const line = allLines[lineIdx]!;
      writeString(grid, CONTENT_START_ROW + r, 2, truncateToCols(line.text, cols - 4), line.attrs);
    }

    if (rows > 0) writeString(grid, rows - 1, 2, truncateToCols(HINT_TEXT, cols - 4), DIM_ATTRS);
    return grid;
  }
}
