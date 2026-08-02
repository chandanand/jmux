// The keymap — one table, every binding jmux offers.
//
// This exists because the keymap had no owner. The same chords were written out
// by hand in five places — input-router.ts's post-prefix block,
// config/defaults.conf, main.ts's HELP const, the first-run modal and
// docs/cheat-sheet.md — and had drifted apart in every direction at once. The
// docs advertised `Ctrl-a j` for a window picker nothing ever bound; they named
// a palette command buildPaletteCommands has never built; they credited
// core.conf with a bind it does not contain; and they described `r` and `/` as
// doing what the router gives to two other keys.
//
// That is the failure src/__tests__/tmux-conf.test.ts was written for ("Three
// binds pointed at shell scripts for months after those scripts were deleted").
// So this table is not a sixth copy: keymap.test.ts checks it in both
// directions against the binds in defaults.conf and against the `data === "…"`
// chain in input-router.ts, and every consumer reads from here rather than
// restating a key.
//
// Consumers: help-modal.ts (the `Ctrl-a ?` overlay), command-palette.ts (the
// keys column), main.ts's makeToolbar (hover hints) and HELP const.

/**
 * Who implements the binding.
 *
 * - `jmux`   — intercepted by src/input-router.ts before tmux sees it.
 * - `tmux`   — a bind jmux ships in config/defaults.conf.
 * - `tmux-default` — tmux's own stock binding, which jmux deliberately does
 *   not unbind. These appear in no jmux file at all, which is exactly why they
 *   need a row: `Ctrl-a z` has been in jmux's cheat sheet and `--help` for as
 *   long as both have existed, and grepping the repo for it finds nothing.
 *   keymap.test.ts holds them to every rule except the defaults.conf match,
 *   which they would fail by definition.
 */
export type KeySource = "jmux" | "tmux" | "tmux-default";

export interface Binding {
  /**
   * Stable identifier. Where an action also exists in the command palette this
   * is *the palette's* command id, which is what lets keysFor() light up a
   * palette row and what keymap.test.ts checks for existence.
   */
  id: string;
  /**
   * Display form, spelled out: "Ctrl-a p", "Ctrl-Shift-Up", "Shift-Left".
   *
   * Deliberately not the compact `^a p` dialect. This table's primary reader is
   * the help overlay, whose whole audience is people who do not already know
   * the chords — and "Ctrl-Shift-Up" is legible to them in a way "^⇧↑" is not.
   * Tight surfaces call shortKeys() to compress it.
   */
  keys: string;
  label: string;
  /** Help-overlay grouping. Order of first appearance in KEYMAP wins. */
  section: string;
  source: KeySource;
  /**
   * For a jmux prefix chord: the literal byte the router matches after the
   * prefix. keymap.test.ts compares these against the `data === "…"` chain it
   * reads out of input-router.ts, so a chord added to the router without a row
   * here (or vice versa) fails the build. Absent on jmux bindings that are
   * *not* single-byte prefix chords — the Ctrl-Shift-Up/Down session walk is
   * matched as a whole escape sequence, and the Command Center's tab digits
   * are matched as a range rather than byte by byte.
   */
  prefixKey?: string;
  /**
   * For a tmux binding: the key exactly as written in config/defaults.conf.
   * Compared against a parse of that file in both directions.
   */
  conf?: string;
  /**
   * When the binding is only live in a particular mode. A binding with no
   * context is always available. The help overlay renders this after the label
   * so a key that "does nothing" is explained rather than doubted.
   */
  context?: string;
}

/**
 * Compact a spelled-out `keys` string for width-constrained surfaces (the
 * palette's keys column, the toolbar's hover chip). Purely mechanical and
 * order-sensitive: "Ctrl-a " collapses to "^a " before the general "Ctrl-"
 * rule, or "Ctrl-a p" would come out as "^a p" by luck rather than by rule.
 */
export function shortKeys(keys: string): string {
  return keys
    .replace(/Ctrl-a /g, "^a ")
    .replace(/Ctrl-/g, "^")
    .replace(/Shift-/g, "⇧")
    .replace(/\bUp\b/g, "↑")
    .replace(/\bDown\b/g, "↓")
    .replace(/\bLeft\b/g, "←")
    .replace(/\bRight\b/g, "→")
    .replace(/\bTab\b/g, "⇥")
    .replace(/\bEnter\b/g, "↵");
}

// Context strings, named once so a typo can't split one mode into two.
const IN_PANEL = "info panel focused";
const IN_PANEL_LIST = "Issues/MRs tab focused";
const IN_GLASS = "Command Center open";

export const KEYMAP: readonly Binding[] = [
  // --- Getting around ---
  {
    id: "help",
    keys: "Ctrl-a ?",
    label: "Keyboard shortcuts",
    section: "Getting around",
    source: "jmux",
    prefixKey: "?",
  },
  {
    id: "palette",
    keys: "Ctrl-a p",
    label: "Command palette",
    section: "Getting around",
    source: "jmux",
    prefixKey: "p",
  },
  {
    id: "session-prev",
    keys: "Ctrl-Shift-Up",
    label: "Previous session",
    section: "Getting around",
    source: "jmux",
  },
  {
    id: "session-next",
    keys: "Ctrl-Shift-Down",
    label: "Next session",
    section: "Getting around",
    source: "jmux",
  },

  // --- Sessions ---
  {
    id: "new-session",
    keys: "Ctrl-a n",
    label: "New session or worktree",
    section: "Sessions",
    source: "jmux",
    prefixKey: "n",
  },
  {
    id: "group-cycle",
    keys: "Ctrl-a G",
    label: "Cycle sidebar grouping",
    section: "Sessions",
    source: "jmux",
    prefixKey: "G",
  },
  {
    id: "sort-cycle",
    keys: "Ctrl-a s",
    label: "Cycle sidebar sort",
    section: "Sessions",
    source: "jmux",
    prefixKey: "s",
  },
  {
    id: "session-picker",
    keys: "Ctrl-a w",
    label: "tmux's own session/window tree",
    section: "Sessions",
    source: "tmux-default",
  },
  {
    id: "filter-cycle",
    keys: "Ctrl-a f",
    label: "Cycle sidebar filter",
    section: "Sessions",
    source: "jmux",
    prefixKey: "f",
  },

  // --- Windows ---
  {
    id: "new-window",
    keys: "Ctrl-a c",
    label: "New window",
    section: "Windows",
    source: "tmux",
    conf: "c",
  },
  {
    id: "window-next",
    keys: "Ctrl-Right",
    label: "Next window",
    section: "Windows",
    source: "tmux",
    conf: "C-Right",
  },
  {
    id: "window-prev",
    keys: "Ctrl-Left",
    label: "Previous window",
    section: "Windows",
    source: "tmux",
    conf: "C-Left",
  },
  {
    id: "window-move-left",
    keys: "Ctrl-Shift-Left",
    label: "Move window left",
    section: "Windows",
    source: "tmux",
    conf: "C-S-Left",
  },
  {
    id: "window-move-right",
    keys: "Ctrl-Shift-Right",
    label: "Move window right",
    section: "Windows",
    source: "tmux",
    conf: "C-S-Right",
  },

  // --- Panes ---
  // "Horizontal" and "vertical" are used in opposite senses either side of
  // this line and always have been: tmux's `split-window -h` puts panes side
  // by side, while jmux's own `split-h` button id means the *divider* is
  // horizontal and runs `split-window -v`. Both readings are defensible, which
  // is exactly why neither word appears in these labels — a new user reading
  // "split horizontally" cannot tell which they will get, and an id-keyed
  // lookup across the two conventions would have printed the opposite chord on
  // the button. The ids below follow jmux's (they are the palette and toolbar
  // ids, wired to real actions); the labels describe what you see instead.
  {
    id: "split-v",
    keys: "Ctrl-a |",
    label: "Split pane left / right",
    section: "Panes",
    source: "tmux",
    conf: "|",
  },
  {
    id: "split-h",
    keys: "Ctrl-a -",
    label: "Split pane top / bottom",
    section: "Panes",
    source: "tmux",
    conf: "-",
  },
  {
    id: "pane-left",
    keys: "Shift-Left",
    label: "Focus pane left",
    section: "Panes",
    source: "tmux",
    conf: "S-Left",
  },
  {
    id: "pane-right",
    keys: "Shift-Right",
    label: "Focus pane right",
    section: "Panes",
    source: "tmux",
    conf: "S-Right",
  },
  {
    id: "pane-up",
    keys: "Shift-Up",
    label: "Focus pane up",
    section: "Panes",
    source: "tmux",
    conf: "S-Up",
  },
  {
    id: "pane-down",
    keys: "Shift-Down",
    label: "Focus pane down",
    section: "Panes",
    source: "tmux",
    conf: "S-Down",
  },
  {
    id: "resize-left",
    keys: "Ctrl-a Left",
    label: "Resize pane left (hold to repeat)",
    section: "Panes",
    source: "tmux",
    conf: "Left",
  },
  {
    id: "resize-down",
    keys: "Ctrl-a Down",
    label: "Resize pane down (hold to repeat)",
    section: "Panes",
    source: "tmux",
    conf: "Down",
  },
  {
    id: "resize-up",
    keys: "Ctrl-a Up",
    label: "Resize pane up (hold to repeat)",
    section: "Panes",
    source: "tmux",
    conf: "Up",
  },
  {
    id: "resize-right",
    keys: "Ctrl-a Right",
    label: "Resize pane right (hold to repeat)",
    section: "Panes",
    source: "tmux",
    conf: "Right",
  },
  {
    id: "zoom-pane",
    keys: "Ctrl-a z",
    label: "Zoom pane to full window (press again to restore)",
    section: "Panes",
    source: "tmux-default",
  },
  {
    id: "clear-pane",
    keys: "Ctrl-a k",
    label: "Clear pane and scrollback",
    section: "Panes",
    source: "tmux",
    conf: "k",
  },
  {
    id: "copy-pane",
    keys: "Ctrl-a y",
    label: "Copy whole pane to clipboard",
    section: "Panes",
    source: "tmux",
    conf: "y",
  },

  // --- Info panel ---
  {
    id: "diff-toggle",
    keys: "Ctrl-a g",
    label: "Toggle info panel",
    section: "Info panel",
    source: "jmux",
    prefixKey: "g",
  },
  {
    id: "diff-zoom",
    keys: "Ctrl-a z",
    label: "Zoom panel (split ↔ full)",
    section: "Info panel",
    source: "jmux",
    prefixKey: "z",
    context: IN_PANEL,
  },
  {
    id: "panel-focus-toggle",
    keys: "Ctrl-a Tab",
    label: "Switch focus between terminal and panel",
    section: "Info panel",
    source: "jmux",
    prefixKey: "\t",
  },
  {
    id: "diff-send-review",
    keys: "Ctrl-a r",
    label: "Send your review notes to this session's agent",
    section: "Info panel",
    source: "jmux",
    prefixKey: "r",
  },
  {
    id: "diff-view-picker",
    keys: "Ctrl-a v",
    label: "Choose what the Diff tab shows",
    section: "Info panel",
    source: "jmux",
    prefixKey: "v",
  },
  {
    id: "panel-prev-tab",
    keys: "[",
    label: "Previous tab",
    section: "Info panel",
    source: "jmux",
    context: IN_PANEL,
  },
  {
    id: "panel-next-tab",
    keys: "]",
    label: "Next tab",
    section: "Info panel",
    source: "jmux",
    context: IN_PANEL,
  },
  {
    id: "panel-open",
    keys: "o",
    label: "Open in browser",
    section: "Info panel",
    source: "jmux",
    context: IN_PANEL_LIST,
  },
  {
    id: "panel-start-session",
    keys: "n",
    label: "Start work on this issue",
    section: "Info panel",
    source: "jmux",
    context: IN_PANEL_LIST,
  },
  {
    id: "panel-link",
    keys: "l",
    label: "Link to current session",
    section: "Info panel",
    source: "jmux",
    context: IN_PANEL_LIST,
  },
  {
    id: "panel-status",
    keys: "s",
    label: "Update issue status",
    section: "Info panel",
    source: "jmux",
    context: IN_PANEL_LIST,
  },
  {
    id: "panel-approve",
    keys: "a",
    label: "Approve merge request",
    section: "Info panel",
    source: "jmux",
    context: IN_PANEL_LIST,
  },
  {
    id: "panel-copy-prompt",
    keys: "c",
    label: "Copy issue prompt",
    section: "Info panel",
    source: "jmux",
    context: IN_PANEL_LIST,
  },
  {
    id: "panel-create-issue",
    keys: "C",
    label: "Create an issue",
    section: "Info panel",
    source: "jmux",
    context: IN_PANEL_LIST,
  },
  {
    id: "panel-refresh",
    keys: "r",
    label: "Refresh from the tracker",
    section: "Info panel",
    source: "jmux",
    context: IN_PANEL_LIST,
  },
  {
    id: "panel-filter",
    keys: "/",
    label: "Filter by text",
    section: "Info panel",
    source: "jmux",
    context: IN_PANEL_LIST,
  },
  {
    id: "panel-edit-filter",
    keys: "F",
    label: "Filter by state, stage, label or priority",
    section: "Info panel",
    source: "jmux",
    context: IN_PANEL_LIST,
  },
  {
    id: "panel-group-by",
    keys: "g",
    label: "Cycle group-by",
    section: "Info panel",
    source: "jmux",
    context: IN_PANEL_LIST,
  },
  {
    id: "panel-sub-group-by",
    keys: "G",
    label: "Cycle sub-group-by",
    section: "Info panel",
    source: "jmux",
    context: IN_PANEL_LIST,
  },
  {
    id: "panel-sort-by",
    keys: "S",
    label: "Cycle sort field",
    section: "Info panel",
    source: "jmux",
    context: IN_PANEL_LIST,
  },
  {
    id: "panel-sort-order",
    keys: "?",
    label: "Reverse sort order",
    section: "Info panel",
    source: "jmux",
    context: IN_PANEL_LIST,
  },

  // --- Work pipeline ---
  {
    id: "workflow-screen",
    keys: "Ctrl-a W",
    label: "Workflow screen (stages, statuses, parking)",
    section: "Work pipeline",
    source: "jmux",
    prefixKey: "W",
  },
  {
    id: "capture-issue",
    keys: "Ctrl-a a",
    label: "Capture a new issue",
    section: "Work pipeline",
    source: "jmux",
    prefixKey: "a",
  },
  {
    id: "start-up-next",
    keys: "Ctrl-a u",
    label: "Start the next issue in your rotation",
    section: "Work pipeline",
    source: "jmux",
    prefixKey: "u",
  },
  {
    id: "undo-transition",
    keys: "Ctrl-a Z",
    label: "Undo the last status write",
    section: "Work pipeline",
    source: "jmux",
    prefixKey: "Z",
  },

  // --- Command Center ---
  {
    id: "cc-tab-n",
    keys: "Ctrl-a 1…9",
    label: "Switch to tab N",
    section: "Command Center",
    source: "jmux",
    context: IN_GLASS,
  },
  {
    id: "cc-tab-prev",
    keys: "Ctrl-a [",
    label: "Previous tab",
    section: "Command Center",
    source: "jmux",
    prefixKey: "[",
    context: IN_GLASS,
  },
  {
    id: "cc-tab-next",
    keys: "Ctrl-a ]",
    label: "Next tab",
    section: "Command Center",
    source: "jmux",
    prefixKey: "]",
    context: IN_GLASS,
  },
  {
    id: "cc-detach",
    keys: "Ctrl-a d",
    label: "Detach jmux (not the focused tile)",
    section: "Command Center",
    source: "jmux",
    prefixKey: "d",
    context: IN_GLASS,
  },

  // --- Settings ---
  {
    id: "settings",
    keys: "Ctrl-a i",
    label: "Settings palette (quick toggles)",
    section: "Settings",
    source: "jmux",
    prefixKey: "i",
  },
  {
    id: "settings-screen",
    keys: "Ctrl-a I",
    label: "Settings screen",
    section: "Settings",
    source: "jmux",
    prefixKey: "I",
  },
];

/** The binding for an id, or undefined. */
export function bindingFor(id: string): Binding | undefined {
  return KEYMAP.find((b) => b.id === id);
}

/**
 * Display keys for an id — the spelled-out form. Callers on tight surfaces
 * wrap this in shortKeys().
 */
export function keysFor(id: string): string | undefined {
  return bindingFor(id)?.keys;
}

/**
 * KEYMAP grouped for the help overlay, in section order of first appearance.
 * Insertion order is the authored order, which is deliberate: sections read
 * roughly in the order a new user meets them.
 */
export function bindingsBySection(): Array<{ section: string; bindings: Binding[] }> {
  const bySection = new Map<string, Binding[]>();
  for (const binding of KEYMAP) {
    const existing = bySection.get(binding.section);
    if (existing) existing.push(binding);
    else bySection.set(binding.section, [binding]);
  }
  return [...bySection].map(([section, bindings]) => ({ section, bindings }));
}
