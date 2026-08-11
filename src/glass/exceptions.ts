// The Command Center's exceptions layer. It sits between `orderSessions` and
// the tile plan: it takes the sidebar's own derived session ordering (called
// with `includeParked: false`) plus a raw pane inventory, and applies the
// two tmux-option-backed exceptions on top of it —
//
//   @jmux-grid-hidden  (session-scoped)  keep this session off the grid
//   @jmux-pinned       (pane-scoped)     keep this pane's session on the grid
//
// — producing the final ordered list of sessions that get a tile.
//
// The two exceptions have different subjects, and that is why hidden beats a
// force-on pane in the same session rather than "more specific wins": hide's
// subject is the whole session, force-on's subject is one pane in it. A rule
// where pinning any pane silently defeated an explicit "keep this session off
// my grid" would make the hide untrustworthy.

import type { SessionInfo } from "../types";
import type { SessionBand } from "../session-order";
import { parsePinValue } from "./pinned-pane-tracker";

export type GridMemberSource = "derived" | "added";

export interface GridMember {
  /** Index into `GridExceptionsInput.sessions`. */
  index: number;
  /**
   * "derived" — this session was already produced by `orderSessions`.
   * "added" — it owes its tile entirely to a force-on pane and belongs to
   * the leading `Added` band, never to "Pinned": `PINNED_GROUP_LABEL`
   * (`session-order.ts`) already names pinned *sessions*, the sidebar's own,
   * separate feature.
   */
  source: GridMemberSource;
}

export interface GridPaneRow {
  /** The tmux session id ($N) the pane belongs to. */
  sessionId: string;
  /** Raw `@jmux-pinned` value for this pane, or null when unset. */
  pinnedRaw: string | null;
}

export interface GridExceptionsInput {
  /** Same array `orderSessions` was called with — `bands[*].indices` and the
   *  returned `GridMember.index` both index into it. */
  sessions: SessionInfo[];
  /** `orderSessions(…, { includeParked: false })`'s result — membership and
   *  order before either exception is applied. */
  bands: SessionBand[];
  /** Session ids carrying `@jmux-grid-hidden`. */
  hiddenSessionIds: ReadonlySet<string>;
  /** Every pane across every session, for the force-on signal. A session
   *  needs only one force-on pane to qualify for a tile — which pane is
   *  irrelevant here; `electRepresentative` (`glass/representative.ts`)
   *  picks the face separately. */
  panes: readonly GridPaneRow[];
}

/**
 * Applies the grid's two exceptions to `orderSessions`'s derived membership,
 * per the design's truth table:
 *
 * | Situation                                    | Result                       |
 * | --------------------------------------------- | ---------------------------- |
 * | Derived member, no exceptions                  | tile, source "derived"       |
 * | Hidden, no force-on pane in it                 | no tile                      |
 * | Hidden **and** a pane in it force-on            | no tile — hide wins          |
 * | Derived member with a force-on pane            | tile, source "derived"       |
 * | Non-member session with a force-on pane        | tile, source "added"         |
 * | Two force-on panes in one session              | one tile either way          |
 *
 * A **parked** session with a force-on pane is worth naming separately, because
 * `includeParked: false` reads as absolute and is not: parked work never reaches
 * `bands`, so it is never `seen`, so its pin puts it in the Added band. That is
 * the sidebar's own rule — an explicit "keep this" beats a derived "this is
 * handed off", which is why `buildRenderPlan` checks pinned before parked — and
 * hidden still beats both, because hide is the exception the user aimed at this
 * whole session rather than at one pane in it.
 *
 * Returns the final order: the `Added` band leading, then every derived band
 * in the order `bands` gave it, each with any hidden member dropped.
 */
export function GridExceptions(input: GridExceptionsInput): GridMember[] {
  const { sessions, bands, hiddenSessionIds, panes } = input;

  const forcedOnSessionIds = new Set<string>();
  for (const pane of panes) {
    if (parsePinValue(pane.pinnedRaw) === "on") forcedOnSessionIds.add(pane.sessionId);
  }

  // Every session `orderSessions` already placed, whether or not it survives
  // the hidden check below. Marking it "seen" here — before that check — is
  // what keeps a hidden derived member out of the Added band too: it has a
  // subject (a whole session) that hide already ruled on, and a force-on pane
  // there must not re-litigate that in the non-member loop.
  const seen = new Set<number>();
  const derived: GridMember[] = [];

  for (const band of bands) {
    for (const index of band.indices) {
      const session = sessions[index];
      if (!session) continue;
      seen.add(index);
      if (hiddenSessionIds.has(session.id)) continue;
      derived.push({ index, source: "derived" });
    }
  }

  const added: GridMember[] = [];
  for (let index = 0; index < sessions.length; index++) {
    if (seen.has(index)) continue;
    const session = sessions[index]!;
    if (hiddenSessionIds.has(session.id)) continue;
    if (!forcedOnSessionIds.has(session.id)) continue;
    added.push({ index, source: "added" });
  }

  return [...added, ...derived];
}
