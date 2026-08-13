// The one place a Command Center exit is allowed to happen. Pure
// orchestration over injected I/O so the ordering bug this replaced — tearing
// the grid's chrome down before confirming the client actually landed
// somewhere real — is a unit-testable seam rather than something only a live
// tmux server could exercise.
//
// The race it closes: `Ctrl-a C` and `Ctrl-a ↵` both pre-check a target
// session's liveness against a cached session list before calling this, but
// that list is a snapshot — a session can die in the window between the
// check and the `switch-client` command actually landing on the control
// channel. The old code tore the grid down (`exitGlass`) unconditionally and
// only *then* attempted the switch, so a target that died in that window left
// `inGlass = false` with the real pty client still parked on the internal
// `__jmux_park` session: the grid's own chrome gone, nothing useful in its
// place, and no path back that didn't already exist by luck (a sidebar
// click). Switching first and tearing down only once it lands makes that
// state unreachable — a failed switch leaves the grid exactly as it was.

export interface LeaveGlassDeps {
  /** Attempt to move the real pty client onto `sessionId`. Resolves `true`
   *  only once it actually landed there — never optimistically. */
  switchTo(sessionId: string): Promise<boolean>;
  /** Tear down the grid's chrome. Called only after `switchTo` confirms the
   *  client is on a real session, never before. */
  teardown(): void;
}

/**
 * Leave the grid for `sessionId`. Switches first; tears the chrome down only
 * once the switch is confirmed. Returns whether it landed — `false` means the
 * grid is untouched and the caller is still exactly where it was.
 */
export async function commitLeaveGlass(
  sessionId: string,
  deps: LeaveGlassDeps,
): Promise<boolean> {
  const landed = await deps.switchTo(sessionId);
  if (!landed) return false;
  deps.teardown();
  return true;
}

/**
 * `Ctrl-a C`'s target resolution: try each candidate in order (typically
 * `preGlassSessionId` then the sidebar's own first session), skipping
 * duplicates, until one actually lands. A single stale liveness check picked
 * one candidate and gave up if reality had already moved on by the time the
 * command executed; this retries against the live outcome instead, so a
 * session that died between the caller's snapshot and now doesn't strand the
 * user when a second candidate would have worked.
 *
 * Returns `false` (grid untouched) only once every candidate has failed.
 */
export async function leaveGlassWithFallback(
  candidates: readonly (string | null | undefined)[],
  deps: LeaveGlassDeps,
): Promise<boolean> {
  const tried = new Set<string>();
  for (const id of candidates) {
    if (!id || tried.has(id)) continue;
    tried.add(id);
    if (await commitLeaveGlass(id, deps)) return true;
  }
  return false;
}
