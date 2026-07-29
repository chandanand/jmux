// src/nav-order.ts
//
// Ctrl-Shift-Up/Down stepping over the sidebar's navigable rows.
//
// Extracted from main.ts because the cycle has three edge cases that are easy
// to get wrong from memory and impossible to unit-test in place: an empty
// target list, a focus that has vanished between keypresses, and the wrap
// across the Overview stop. The original plan for this feature asserted the
// wrong fallback for the empty case, which is exactly why it lives here now.
//
// Ghosts are navigable targets. They were previously excluded because landing
// on one provisioned a worktree; now that selecting a ghost only previews it,
// the exclusion has no remaining justification.

/** A row Ctrl-Shift-Up/Down can land on. */
export type NavTarget =
  | { type: "session"; sessionId: string }
  | { type: "ghost"; issueId: string };

/**
 * Where focus currently sits in the virtual cycle `[Overview, ...targets]`.
 * `overview` is the Command Center, which is always the first stop.
 */
export type NavFocus =
  | { type: "overview" }
  | { type: "session"; sessionId: string }
  | { type: "ghost"; issueId: string };

function indexOfFocus(targets: readonly NavTarget[], focus: NavFocus): number {
  if (focus.type === "overview") return 0;
  const found = targets.findIndex((t) =>
    t.type === "session" && focus.type === "session"
      ? t.sessionId === focus.sessionId
      : t.type === "ghost" && focus.type === "ghost"
        ? t.issueId === focus.issueId
        : false,
  );
  // A focus that isn't in the list — the session got filtered out, or the
  // focused ghost stopped being one between keypresses — enters the cycle at
  // the first real target. With no targets at all that is Overview (0), NOT
  // position 1: there is nothing at position 1 to land on.
  return found >= 0 ? found + 1 : Math.min(1, targets.length);
}

/**
 * Step `offset` places through `[Overview, ...targets]`, wrapping at both ends.
 *
 * Returns the new focus rather than acting on it, so the caller owns the
 * session switch / preview open and this stays free of tmux.
 */
export function resolveNavStep(
  targets: readonly NavTarget[],
  focus: NavFocus,
  offset: number,
): NavFocus {
  const n = targets.length + 1;
  const current = indexOfFocus(targets, focus);
  const next = (((current + offset) % n) + n) % n;
  if (next === 0) return { type: "overview" };
  const target = targets[next - 1]!;
  return target.type === "session"
    ? { type: "session", sessionId: target.sessionId }
    : { type: "ghost", issueId: target.issueId };
}
