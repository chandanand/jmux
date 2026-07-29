export const enum ColorMode {
  Default = 0,
  Palette = 1,
  RGB = 2,
}

/**
 * What a cell says about a terminal-graphics image drawn over it.
 *
 * Lives on the cell so that clipping, scrolling, offsetting and occlusion are
 * handled by the code that already does those things to text — see
 * `src/images/plane.ts`, which reads these back off the finished frame. Shared
 * by every cell of one image row so a run can be recognised by value.
 */
export interface ImageMark {
  /** Terminal-side image id. */
  id: number;
  /** This row's index within the image's full cell box. */
  tileRow: number;
  /** The image's full box, in cells. */
  rows: number;
  cols: number;
}

export interface Cell {
  char: string;
  width: number; // 0 = continuation of wide char, 1 = normal, 2 = wide
  fg: number;
  bg: number;
  fgMode: ColorMode;
  bgMode: ColorMode;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  dim: boolean;
  /**
   * Set only on cells reserved for an image. Painting text over a cell clears
   * it, which is what makes occlusion self-reporting rather than something the
   * image layer has to be told about.
   */
  image?: ImageMark;
  // OSC 8 hyperlink target. When set, the renderer wraps runs of cells
  // sharing the same link in OSC 8 open/close escapes so the terminal
  // treats the visible text as one clickable region — even across line
  // wraps where regex-based URL detection would otherwise fail.
  link?: string;
}

export interface CellGrid {
  cols: number;
  rows: number;
  cells: Cell[][];
}

export interface CursorPosition {
  x: number;
  y: number;
}

export interface WindowTab {
  windowId: string;
  index: number;
  name: string;
  active: boolean;
  bell: boolean;
  zoomed: boolean;
  branch?: string;
}

export interface SessionInfo {
  id: string;
  name: string;
  attached: boolean;
  activity: number;
  gitBranch?: string;
  windowCount: number;
  directory?: string;
  project?: string; // wtm project name (bare repo basename)
}

export type ErrorState = {
  type: "api_error" | "api_retries_exhausted";
  timestamp: number;
};

export type PermissionMode = "default" | "plan" | "accept-edits";

export interface SessionOtelState {
  // Cache-timer fields (existing)
  lastRequestTime: number;
  cacheWasHit: boolean;

  // Current main-loop context occupancy in tokens (input + cache_read +
  // cache_creation of the latest main-thread api_request). Reset on compaction.
  contextTokens: number;
  lastError: ErrorState | null;
  failedMcpServers: Set<string>;
  permissionMode: PermissionMode;
  lastCompactionTime: number | null;
  lastUserPromptTime: number | null;
}

export function makeSessionOtelState(): SessionOtelState {
  return {
    lastRequestTime: 0,
    cacheWasHit: false,
    contextTokens: 0,
    lastError: null,
    failedMcpServers: new Set(),
    permissionMode: "default",
    lastCompactionTime: null,
    lastUserPromptTime: null,
  };
}

export interface PaletteCommand {
  id: string;
  label: string;
  category: string;
  sublist?: PaletteSublistOption[];
  /** Non-selectable, dimmed row; Enter is a no-op. */
  disabled?: boolean;
  /** Explanatory suffix rendered after the label (e.g. on a disabled row). */
  hint?: string;
}

export interface PaletteSublistOption {
  id: string;
  label: string;
  current?: boolean;
}

export interface PaletteResult {
  commandId: string;
  sublistOptionId?: string;
}

export type PaletteAction =
  | { type: "consumed" }
  | { type: "closed" }
  | { type: "result"; value: PaletteResult };

export type AgentState = "running" | "waiting" | "complete";

export interface AgentStateRecord {
  state: AgentState;
  /** Epoch milliseconds. Converted from the seconds the hook writes. */
  since: number;
}

/**
 * Which agent program a pane is running, as written by that agent's own
 * integration into the per-pane `@jmux-agent-kind` option.
 *
 * Unlike `@jmux-agent-state`, nothing ever writes this at session scope, so it
 * has no inheritance source — a non-empty value is proof *this* pane hosts an
 * agent. That distinction is load-bearing for pane detection; see
 * `glass/auto-detect.ts`.
 */
export type AgentKind = "claude" | "codex" | "pi";

export const AGENT_KINDS: readonly AgentKind[] = ["claude", "codex", "pi"];

export function isAgentKind(v: string): v is AgentKind {
  return (AGENT_KINDS as readonly string[]).includes(v);
}
