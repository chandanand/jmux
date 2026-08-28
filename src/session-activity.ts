import { splitFields, US } from "./tmux-fields";

/**
 * `session_activity` is the last time a tmux client interacted with a session;
 * it is not the last time one of the session's panes produced output. The
 * sidebar's Active group is about output, so it must use `window_activity` and
 * roll every window up to its owning session.
 */
export const WINDOW_ACTIVITY_FORMAT = ["#{session_id}", "#{window_activity}"].join(US);

/** Newest window-output timestamp for each session in a list-windows result. */
export function latestWindowActivity(lines: readonly string[]): Map<string, number> {
  const bySession = new Map<string, number>();
  for (const line of lines) {
    if (!line) continue;
    const [sessionId, rawActivity] = splitFields(line);
    const activity = Number(rawActivity);
    if (!sessionId || !Number.isFinite(activity) || activity <= 0) continue;
    bySession.set(sessionId, Math.max(bySession.get(sessionId) ?? 0, activity));
  }
  return bySession;
}
