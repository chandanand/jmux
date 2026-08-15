import type { PaletteCommand } from "../types";
import type { CommandCenterView } from "./views";

/** A session currently kept off the grid by `@jmux-grid-hidden`. */
export interface HiddenSessionOption {
  id: string;
  name: string;
}

export interface CcCommandInput {
  inGlass: boolean;
  views: CommandCenterView[];
  activeViewId: string;
  /** The live axes have moved on from the active view's own saved axes. */
  dirty: boolean;
  /** Sessions currently off the grid via `@jmux-grid-hidden` — the palette's
   *  only way to discover and undo a hide that isn't the focused session. */
  hiddenSessions: readonly HiddenSessionOption[];
  /**
   * The pane a pin/unpin command would act on: the glass tile's displayed
   * pane while in the grid, the current session's active pane otherwise.
   * Null when there is nothing to act on — an empty grid with no focused
   * tile, or no current session.
   */
  targetPaneId: string | null;
  /** Whether `targetPaneId` already carries a force-on `@jmux-pinned`. */
  targetPinned: boolean;
}

/** "Active (unsaved changes)" for the active view while its saved axes and
 *  the live axes disagree; the bare name otherwise. */
function viewSublistLabel(view: CommandCenterView, input: CcCommandInput): string {
  const isDirtyActive = view.id === input.activeViewId && input.dirty;
  return isDirtyActive ? `${view.name} (unsaved changes)` : view.name;
}

export function buildCcCommands(input: CcCommandInput): PaletteCommand[] {
  const cmds: PaletteCommand[] = [];

  // Pin no longer targets a tab — there is no tab to choose. It keeps this
  // pane's session on the grid and prefers this pane as the session's face;
  // unpin drops that preference. Direct actions, no sublist.
  if (input.targetPaneId) {
    if (input.targetPinned) {
      cmds.push({
        id: "unpin-pane",
        label: "Unpin from Command Center",
        category: "command center",
      });
    } else {
      cmds.push({
        id: "pin-pane",
        label: "Pin to Command Center — keep this session on the grid, showing this pane",
        category: "command center",
      });
    }
  }

  // View CRUD acts on the active view, so it only makes sense while looking
  // at the grid — the same reason Ctrl-Space G/s/f (the axes these views name)
  // are glass-only chords.
  if (input.inGlass) {
    cmds.push({ id: "save-cc-view", label: "Save current axes as view…", category: "command center" });
    cmds.push({ id: "rename-cc-view", label: "Rename view…", category: "command center" });
    cmds.push({ id: "delete-cc-view", label: "Delete view", category: "command center" });
  }

  // Switching views is available everywhere: picking one from outside the
  // grid opens it, the same as the old switch-to-tab command did.
  cmds.push({
    id: "switch-cc-view",
    label: "Switch view…",
    category: "command center",
    sublist: input.views.map((v) => ({
      id: v.id,
      label: viewSublistLabel(v, input),
      current: v.id === input.activeViewId,
    })),
  });

  // A hidden session is discoverable, not silent: this is the only way to
  // undo a hide for a session that isn't the one currently focused (Ctrl-Space P
  // only acts on that one).
  if (input.hiddenSessions.length > 0) {
    cmds.push({
      id: "show-hidden-sessions",
      label: `Show hidden sessions (${input.hiddenSessions.length})…`,
      category: "command center",
      sublist: input.hiddenSessions.map((s) => ({ id: s.id, label: s.name })),
    });
  }

  return cmds;
}
