// The keymap — one table, every binding jmux offers.
//
// This exists because the keymap had no owner. The same chords were written out
// by hand in five places — input-router.ts's post-prefix block,
// config/defaults.conf, main.ts's HELP const, the first-run modal and
// docs/cheat-sheet.md — and had drifted apart in every direction at once. The
// docs advertised `Ctrl-Space j` for a window picker nothing ever bound; they named
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
// Consumers: help-modal.ts (the `Ctrl-Space ?` overlay), command-palette.ts (the
// keys column), main.ts's makeToolbar (hover hints) and HELP const.

/**
 * Who implements the binding.
 *
 * - `jmux`   — intercepted by src/input-router.ts before tmux sees it.
 * - `tmux`   — a bind jmux ships in config/defaults.conf.
 * - `tmux-default` — tmux's own stock binding, which jmux deliberately does
 *   not unbind. These appear in no jmux file at all, which is exactly why they
 *   need a row: `Ctrl-Space z` has been in jmux's cheat sheet and `--help` for as
 *   long as both have existed, and grepping the repo for it finds nothing.
 *   keymap.test.ts holds them to every rule except the defaults.conf match,
 *   which they would fail by definition.
 */
export type KeySource = "jmux" | "tmux" | "tmux-default";

/**
 * Which post-prefix arm(s) of input-router.ts a chord is reachable from — the
 * ordinary arm, the Command Center's, or the full-screen-surface arm. Only
 * meaningful alongside `prefixKey`; keymap.test.ts asserts each declared set
 * against the arms that actually intercept the byte, which is what makes a
 * chord added to only one arm (or removed from one without updating this) a
 * build failure instead of a silent gap.
 */
export type Arm = "ordinary" | "glass" | "surface";

export interface Binding {
  /**
   * Stable identifier. Where an action also exists in the command palette this
   * is *the palette's* command id, which is what lets keysFor() light up a
   * palette row and what keymap.test.ts checks for existence.
   */
  id: string;
  /**
   * Display form, spelled out: "Ctrl-Space p", "Ctrl-Shift-Up", "Shift-Left".
   *
   * Deliberately not the compact `^Space p` dialect. This table's primary reader is
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
   * matched as a whole escape sequence, and the Command Center's view-switch
   * digits are matched as a range rather than byte by byte.
   */
  prefixKey?: string;
  /**
   * Required alongside `prefixKey`. See `Arm`'s doc comment.
   */
  arms?: readonly Arm[];
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
 * order-sensitive: "Ctrl-Space " collapses to "^Space " before the general
 * "Ctrl-" rule, keeping the prefix readable in narrow surfaces.
 */
export function shortKeys(keys: string): string {
  return keys
    .replace(/Ctrl-Space /g, "^Space ")
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
    keys: "Ctrl-Space ?",
    label: "Keyboard shortcuts",
    section: "Getting around",
    source: "jmux",
    prefixKey: "?",
    arms: ["ordinary", "glass"],
  },
  {
    id: "palette",
    keys: "Ctrl-Space p",
    label: "Command palette",
    section: "Getting around",
    source: "jmux",
    prefixKey: "p",
    arms: ["ordinary", "glass"],
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
    keys: "Ctrl-Space n",
    label: "New session or worktree",
    section: "Sessions",
    source: "jmux",
    prefixKey: "n",
    arms: ["ordinary", "glass"],
  },
  {
    id: "group-cycle",
    keys: "Ctrl-Space G",
    label: "Cycle sidebar grouping",
    section: "Sessions",
    source: "jmux",
    prefixKey: "G",
    // Glass reads this same byte too, but as `group-cycle-grid` — the Command
    // Center's own axis, not the sidebar's. See that binding's comment.
    arms: ["ordinary"],
  },
  {
    id: "sort-cycle",
    keys: "Ctrl-Space s",
    label: "Cycle sidebar sort",
    section: "Sessions",
    source: "jmux",
    prefixKey: "s",
    arms: ["ordinary"],
  },
  {
    id: "session-picker",
    keys: "Ctrl-Space w",
    label: "tmux's own session/window tree",
    section: "Sessions",
    source: "tmux-default",
  },
  {
    id: "filter-cycle",
    keys: "Ctrl-Space f",
    label: "Cycle sidebar filter",
    section: "Sessions",
    source: "jmux",
    prefixKey: "f",
    arms: ["ordinary"],
  },
  {
    id: "sidebar-toggle",
    keys: "Ctrl-Space \\",
    label: "Hide / show the sidebar",
    section: "Sessions",
    source: "jmux",
    prefixKey: "\\",
    arms: ["ordinary", "glass", "surface"],
  },

  // --- Windows ---
  {
    id: "new-window",
    keys: "Ctrl-Space c",
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
    keys: "Ctrl-Space |",
    label: "Split pane left / right",
    section: "Panes",
    source: "tmux",
    conf: "|",
  },
  {
    id: "split-h",
    keys: "Ctrl-Space -",
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
    id: "browser-pane",
    keys: "Ctrl-Space b",
    label: "Open browser pane",
    section: "Panes",
    source: "jmux",
    prefixKey: "b",
    arms: ["ordinary", "glass"],
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
    keys: "Ctrl-Space Left",
    label: "Resize pane left (hold to repeat)",
    section: "Panes",
    source: "tmux",
    conf: "Left",
  },
  {
    id: "resize-down",
    keys: "Ctrl-Space Down",
    label: "Resize pane down (hold to repeat)",
    section: "Panes",
    source: "tmux",
    conf: "Down",
  },
  {
    id: "resize-up",
    keys: "Ctrl-Space Up",
    label: "Resize pane up (hold to repeat)",
    section: "Panes",
    source: "tmux",
    conf: "Up",
  },
  {
    id: "resize-right",
    keys: "Ctrl-Space Right",
    label: "Resize pane right (hold to repeat)",
    section: "Panes",
    source: "tmux",
    conf: "Right",
  },
  {
    id: "zoom-pane",
    keys: "Ctrl-Space z",
    label: "Zoom pane to full window (press again to restore)",
    section: "Panes",
    source: "tmux-default",
  },
  {
    id: "clear-pane",
    keys: "Ctrl-Space k",
    label: "Clear pane and scrollback",
    section: "Panes",
    source: "tmux",
    conf: "k",
  },
  {
    id: "copy-pane",
    keys: "Ctrl-Space y",
    label: "Copy whole pane to clipboard",
    section: "Panes",
    source: "tmux",
    conf: "y",
  },

  // --- Info panel ---
  {
    id: "diff-toggle",
    keys: "Ctrl-Space g",
    label: "Toggle info panel",
    section: "Info panel",
    source: "jmux",
    prefixKey: "g",
    arms: ["ordinary", "surface"],
  },
  {
    id: "diff-zoom",
    keys: "Ctrl-Space z",
    label: "Zoom panel (split ↔ full)",
    section: "Info panel",
    source: "jmux",
    prefixKey: "z",
    context: IN_PANEL,
    arms: ["ordinary"],
  },
  {
    id: "panel-focus-toggle",
    keys: "Ctrl-Space Tab",
    label: "Switch focus between terminal and panel",
    section: "Info panel",
    source: "jmux",
    prefixKey: "\t",
    arms: ["ordinary"],
  },
  {
    id: "diff-send-review",
    keys: "Ctrl-Space r",
    label: "Send your review notes to this session's agent",
    section: "Info panel",
    source: "jmux",
    prefixKey: "r",
    arms: ["ordinary"],
  },
  {
    id: "diff-view-picker",
    keys: "Ctrl-Space v",
    label: "Choose what the Diff tab shows",
    section: "Info panel",
    source: "jmux",
    prefixKey: "v",
    arms: ["ordinary"],
  },
  {
    id: "panel-prev-tab",
    keys: "h / [",
    label: "Previous tab",
    section: "Info panel",
    source: "jmux",
    context: IN_PANEL,
  },
  {
    id: "panel-next-tab",
    keys: "l / ]",
    label: "Next tab",
    section: "Info panel",
    source: "jmux",
    context: IN_PANEL,
  },
  {
    id: "panel-navigate",
    keys: "j / k / Up / Down",
    label: "Navigate items",
    section: "Info panel",
    source: "jmux",
    context: IN_PANEL_LIST,
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
    keys: "L",
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
    id: "panel-brief-agent",
    keys: "p",
    label: "Send issue prompt to this session's agent",
    section: "Info panel",
    source: "jmux",
    context: IN_PANEL_LIST,
  },
  {
    id: "panel-preview-tabs",
    keys: "{ / }",
    label: "Previous / next issue in the preview strip",
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
    keys: "Ctrl-Space W",
    label: "Workflow screen (stages, statuses, parking)",
    section: "Work pipeline",
    source: "jmux",
    prefixKey: "W",
    arms: ["ordinary", "glass"],
  },
  {
    id: "capture-issue",
    keys: "Ctrl-Space a",
    label: "Capture a new issue",
    section: "Work pipeline",
    source: "jmux",
    prefixKey: "a",
    arms: ["ordinary", "glass"],
  },
  {
    id: "start-up-next",
    keys: "Ctrl-Space u",
    label: "Start the next issue in your rotation",
    section: "Work pipeline",
    source: "jmux",
    prefixKey: "u",
    arms: ["ordinary", "glass"],
  },
  {
    id: "undo-transition",
    keys: "Ctrl-Space Z",
    label: "Undo the last status write",
    section: "Work pipeline",
    source: "jmux",
    prefixKey: "Z",
    arms: ["ordinary", "glass"],
  },
  {
    id: "fix-workflow-drift",
    keys: "Ctrl-Space m",
    label: "Move the issue where the workflow says it should be",
    section: "Work pipeline",
    source: "jmux",
    prefixKey: "m",
    arms: ["ordinary"],
  },
  {
    id: "toggle-session-issues",
    keys: "Ctrl-Space e",
    label: "Expand this session's issues in the sidebar",
    section: "Work pipeline",
    source: "jmux",
    prefixKey: "e",
    arms: ["ordinary"],
  },

  // --- Command Center ---
  {
    id: "cc-toggle",
    keys: "Ctrl-Space C",
    label: "Toggle the Command Center",
    section: "Command Center",
    source: "jmux",
    prefixKey: "C",
    arms: ["ordinary", "glass"],
    // Shadows tmux's stock `bind-key -T prefix C customize-mode -Z` — accepted,
    // on the precedent `?` already set against list-keys and `s` against
    // choose-session: jmux ships Ctrl-Space I / Ctrl-Space i in customize-mode's place.
  },
  {
    id: "cc-view-n",
    keys: "Ctrl-Space 1…9",
    label: "Switch to view N",
    section: "Command Center",
    source: "jmux",
    context: IN_GLASS,
  },
  {
    id: "cc-view-prev",
    keys: "Ctrl-Space [",
    label: "Previous view",
    section: "Command Center",
    source: "jmux",
    prefixKey: "[",
    context: IN_GLASS,
    arms: ["glass"],
  },
  {
    id: "cc-view-next",
    keys: "Ctrl-Space ]",
    label: "Next view",
    section: "Command Center",
    source: "jmux",
    prefixKey: "]",
    context: IN_GLASS,
    arms: ["glass"],
  },
  {
    id: "cc-open-focused",
    keys: "Ctrl-Space Enter",
    label: "Open the focused tile's session full-size, on its displayed pane",
    section: "Command Center",
    source: "jmux",
    prefixKey: "\r",
    context: IN_GLASS,
    arms: ["glass"],
  },
  {
    id: "cc-cycle-face",
    keys: "Ctrl-Space x",
    label: "Cycle the focused tile's face",
    section: "Command Center",
    source: "jmux",
    prefixKey: "x",
    context: IN_GLASS,
    arms: ["glass"],
  },
  {
    id: "cc-zoom-tile",
    keys: "Ctrl-Space z",
    label: "Zoom the focused tile to full size (press again to restore)",
    section: "Command Center",
    source: "jmux",
    prefixKey: "z",
    context: IN_GLASS,
    arms: ["glass"],
  },
  {
    id: "cc-toggle-pin",
    keys: "Ctrl-Space P",
    label: "Remove the focused session from the grid, or add the current pane to it",
    section: "Command Center",
    source: "jmux",
    prefixKey: "P",
    arms: ["ordinary", "glass"],
  },
  {
    id: "cc-detach",
    keys: "Ctrl-Space d",
    label: "Detach jmux (not the focused tile)",
    section: "Command Center",
    source: "jmux",
    prefixKey: "d",
    context: IN_GLASS,
    arms: ["glass"],
  },
  {
    id: "group-cycle-grid",
    keys: "Ctrl-Space G",
    label: "Cycle Command Center grouping",
    section: "Command Center",
    source: "jmux",
    prefixKey: "G",
    context: IN_GLASS,
    arms: ["glass"],
  },
  {
    id: "sort-cycle-grid",
    keys: "Ctrl-Space s",
    label: "Cycle Command Center sort",
    section: "Command Center",
    source: "jmux",
    prefixKey: "s",
    context: IN_GLASS,
    arms: ["glass"],
  },
  {
    id: "filter-cycle-grid",
    keys: "Ctrl-Space f",
    label: "Cycle Command Center filter",
    section: "Command Center",
    source: "jmux",
    prefixKey: "f",
    context: IN_GLASS,
    arms: ["glass"],
  },
  {
    id: "density-cycle-grid",
    keys: "Ctrl-Space D",
    label: "Toggle Command Center tile density (Fit / Focus)",
    section: "Command Center",
    source: "jmux",
    prefixKey: "D",
    // Capital D, not lowercase d (glass detach): shadows tmux's stock
    // choose-client, accepted on the same precedent as Ctrl-Space z shadowing
    // resize-pane -Z — there is no client to choose from inside the grid.
    context: IN_GLASS,
    arms: ["glass"],
  },

  // --- Settings ---
  {
    id: "settings",
    keys: "Ctrl-Space i",
    label: "Settings palette (quick toggles)",
    section: "Settings",
    source: "jmux",
    prefixKey: "i",
    arms: ["ordinary", "glass"],
  },
  {
    id: "settings-screen",
    keys: "Ctrl-Space I",
    label: "Settings screen",
    section: "Settings",
    source: "jmux",
    prefixKey: "I",
    arms: ["ordinary", "glass"],
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
