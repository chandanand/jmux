/**
 * Groundcrew stamps every tmux session whose lifecycle it owns with this
 * session option. Jmux observes that ownership; it never writes the marker.
 */
export const GROUNDCREW_MANAGED_OPTION = "@groundcrew_managed";

export type SessionManager = "groundcrew";

/**
 * Header a manager's sessions band under on the owner axis. A record rather
 * than a ternary so a second manager cannot be added to `SessionManager`
 * without deciding what its band is called.
 */
const MANAGER_BAND_LABELS: Record<SessionManager, string> = {
  groundcrew: "Groundcrew",
};

export function sessionManagerBandLabel(manager: SessionManager): string {
  return MANAGER_BAND_LABELS[manager];
}

export type GroundcrewGuardedAction =
  | "kill-session"
  | "cleanup-session"
  | "rename-session"
  | "close-window"
  | "move-window"
  | "close-pane";

/** Strict on purpose: an absent, stale, or unexpected option is not ownership. */
export function sessionManagerFromGroundcrewOption(
  value: string | undefined,
): SessionManager | undefined {
  return value === "1" ? "groundcrew" : undefined;
}

export interface GroundcrewActionGuidance {
  message: string;
  hint: string;
  paletteHint: string;
}

/**
 * Explain why Jmux will not mutate a Groundcrew-owned session. Kept pure so
 * the palette, runtime guard, and CLI all use the same ownership contract.
 */
export function groundcrewActionGuidance(
  action: GroundcrewGuardedAction,
  task: string,
): GroundcrewActionGuidance {
  const stopCommand = `crewop stop ${task}`;
  if (action === "rename-session") {
    return {
      message: `Groundcrew uses ${task} as the task and session identity.`,
      hint: `Keep that identity stable. To pause the task, run: ${stopCommand}`,
      paletteHint: `Groundcrew task identity must stay ${task}`,
    };
  }

  const message = action === "kill-session" || action === "cleanup-session"
    ? `Groundcrew owns the session and worktree for ${task}.`
    : `Groundcrew owns the tmux topology for ${task}.`;
  return {
    message,
    hint: `Pause it safely with: ${stopCommand}`,
    paletteHint: `Groundcrew-managed; use ${stopCommand}`,
  };
}
