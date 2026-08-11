# Plan: Command Center derived membership

Spec: `docs/superpowers/specs/2026-08-10-command-center-derived-membership-design.md`

Ten phases. Each lands green — `bun run typecheck` and `bun test` pass at every
phase boundary — so a phase can be reviewed or reverted on its own. Phases 1–5
are pure modules with no wiring; the Command Center keeps working on the old
mechanism until phase 6 switches it over.

The governing constraint, restated because every phase obeys it: **one tile per
session**. Two clients attached to one session share the session's current
window, and zoom is window-global, so no arrangement of pins can put two panes of
one session on the grid at once.

---

## Phase 1 — Extract `orderSessions`

**Files:** new `src/session-order.ts`; `src/sidebar.ts`.

Move `sidebar.ts:510–636` into an exported pure function returning
`SessionBand[]` in emission order — `pinned?`, group bands, `ungrouped?`,
`parked?` — with `kind` and `headerless` so the headerless ungrouped remainder
(`sidebar.ts:729`) is representable. Export `compareGroupBands` too.

`buildRenderPlan` becomes a consumer. Three asymmetries to preserve:

- Ghost placement appends stage bands `orderSessions` never returns
  (`sidebar.ts:593–618`); `buildRenderPlan` re-sorts with `compareGroupBands` so
  ghost-only and session-bearing bands can never order by different rules.
- Flat ghosts sit between `ungrouped` and `parked` (`sidebar.ts:751`) — emission
  only.
- Parked's collapse polarity is inverted (`sidebar.ts:747`) and stays with
  emission; `orderSessions` expresses inclusion only.
- `pinnedPaneCountBySession` (`sidebar.ts:515–522`) is presentation and stays.

**Verify:** `src/__tests__/session-order.test.ts` — collapse-independence;
`includeParked: false`; `headerless` only for ungrouped; `displayOrder` equals the
concatenated band indices with nothing collapsed (Parked's inverted polarity means
that case passes `collapsedGroups` **containing** `"parked"`); a ghost-only band
sorts identically to a session-bearing one. `sidebar.test.ts` passes untouched.

---

## Phase 2 — Representative election

**Files:** new `src/glass/representative.ts`; `src/main.ts` (`resolveAgentPane`).

`PaneRow { paneId, kind, command, forcedOn, sessionActive, state, since }`.
`eligiblePanes(panes, regex)` unions kinded ∪ regex-matched ∪ force-on, ordered by
pane id. `electRepresentative(panes, explicitPane, regex)` is stateless: live
explicit → most urgent force-on → most urgent eligible by `outranks()`
(`agent-state-rollup.ts:31`) → `sessionActive` → first.

`sessionActive` is `window_active && pane_active`. `pane_active` alone is true of
one pane in every window.

Rewrite `resolveAgentPane` (`main.ts:3114`) to delegate to the **stateless**
election — it answers "which pane wrote this diff", which wants the live answer,
not what the grid is showing. Stickiness is phase 4's, and lives in `GlassView`.

**Verify:** `src/__tests__/glass/representative.test.ts` per the spec, including
the three-window `sessionActive` case.

---

## Phase 3 — Exception parsing

**Files:** `src/glass/pinned-pane-tracker.ts`; new `src/glass/exceptions.ts`;
`src/cli/pane.ts`.

`parsePinValue(raw): "on" | null`; `resolveTabId` deleted. `GridExceptions`
applies the spec's truth table to `SessionBand[]` + pane inventory, producing the
final ordered session list with the `Added` band leading (not "Pinned" —
`PINNED_GROUP_LABEL` already means pinned *sessions*, `sidebar.ts:454`).

The row that is easy to get backwards: **hidden wins over a force-on pane in that
session.** Different subjects; a pin must not silently defeat an explicit hide.

**Verify:** `src/__tests__/glass/exceptions.test.ts` — every row, hidden-plus-pinned
included.

---

## Phase 4 — Tile identity and lifecycle

**Files:** `src/glass/tile-plan.ts`; `src/glass/view.ts`.

`TileKey = \`session:${string}\``, and only that. `paneId` becomes mutable backing
state; `focusedKey`, `zoomedKey` and the per-session face override replace index
and pane state. `resolveDisplayedRepresentative` is the sticky rule over phase 2's
stateless election: keep the current pane until it dies, the user cycles, or a
pin changes.

`planTiles` is rewritten, not extended, to the spec's `TilePlanInput` /
`TilePlan`. `active` entries are `{ key, forced }` — the flag has to travel on the
active side, or a cap of 1 over two active tiles cannot tell which is pinned.
`retained` carries only `lastSeenAt`, stamped by the reconciler at the moment a
tile leaves membership. Cap counts active plus retained; active evicts retained
immediately; under overflow force-on is kept first; `nextExpiryAt` is armed by the
caller so a grace expires with no tmux traffic.

`GlassView` gains a third transition, **retarget**, for a face moving to a pane in
another window of the same session: unzoom the window the tile currently owns,
`select-window` the new one, re-zoom, and track the pane the zoom landed on — so
teardown undoes the zoom it ended with, not the one it started with. Today window
selection and zoom happen only at spawn (`glass/view.ts:357-383`) and unzoom only
at teardown (`glass/view.ts:427`), so without this a cycled tile keeps showing the
old window.

`computeTileLayout` is untouched — `glass/view.ts:184–344` maps `rect.index`
through `tileOrder` to a key, then to its client.

**Verify:** `tile-plan.test.ts` rewritten, `tile-identity.test.ts` new (including
the retarget command sequence against a recording runner), per the spec.

---

## Phase 5 — Views

**Files:** `src/glass/tabs.ts` → `src/glass/views.ts`; `src/config.ts`.

`CommandCenterView`, `normalizeViews` (clamping each axis to its enum),
`addView` / `renameView` / `deleteView`, `slugifyViewName`, `validateViewName`,
`axesDiffer`. Config gains `commandCenterViews`, `commandCenterActiveViewId`,
`commandCenterAxes`, `commandCenter.maxTiles`, and a one-time migration deleting
`commandCenterTabs` and `autoPinAgentPanes` — needed because `persist()` writes
the whole object (`config.ts:551`).

The three transitions are the substance: switching while dirty (incoming view
wins), deleting the active view (previous by index, or re-seed at the last), hot
reload (surviving id keeps its dirty axes; a vanished one falls to index 0).

Comment that the grid's filter persists where the sidebar's deliberately does not
(`config.ts:175`).

**Verify:** `glass/views.test.ts`, `config.test.ts`.

---

## Phase 6 — The reconciler

**Files:** `src/main.ts`; `src/tmux-control.ts`.

`refreshPinnedPanes` → `reconcileGrid()`, implemented as the spec's
`scheduled` / `inFlight` / `dirty` machine verbatim — `dirty` cleared *before* the
snapshot and rescheduling in `finally`, or a read that throws wedges the grid.
One `list-panes -a` pass (the old `AGENT_DETECT_FORMAT` folds into it) plus
`list-sessions -F`.

Drop the `pinnedTracker.size > 0 || autoPinAgentPanes` guard (`main.ts:1398`) and
wire every source in the spec's table. Two need new plumbing:

- `ControlParser` discards unknown notifications (`tmux-control.ts:84`);
  `%layout-change` and `%window-pane-changed` must parse and surface.
- Async project resolution currently only repaints the sidebar (`main.ts:9143`)
  and must reconcile, or a `groupBy: "project"` band stays wrong.

**Fix the pin subscription while here.** `"#{P:#{pane_id}=#{@jmux-pinned} }"`
(`main.ts:10080`) loops only the current window's panes, so it has never fired for
a pin written in an unfocused window. Nest it as `#{S:#{W:#{P:…}}}`, the pattern
the agent-state subscriptions already use and document (`main.ts:10043-10050`).
Add `"#{S:#{session_id}=#{@jmux-grid-hidden} }"` beside it — verified. No periodic
reconcile: jmux runs no general tmux poll, and inventing one to cover a
subscription gap would be a second, slower answer to a question the control
channel answers exactly.

`sidebar.setPinnedPanes` → `setGridSummary({ count, tally })`; the Overview row
counts derived members (`sidebar.ts:669`).

Delete `src/glass/auto-detect.ts` and its test — `main.ts` is its only importer.

**Verify:** `tmux-control.test.ts` for the two notifications; new
`reconcile-loop.test.ts` for the state machine; boot-smoke green; manual —
`ctl pane pin` from an unfocused window lands immediately.

---

## Phase 7 — Keys

**Files:** `src/__tests__/keymap.test.ts` first, then `src/input-router.ts`,
`src/keymap.ts`.

**The test changes are the deliverable and come first.** Decode `\r` / `\n` in
`routerPrefixKeys` (it special-cases only `\t`, so `data === "\r"` decodes to the
printable `r`, `keymap.test.ts:81`), and replace the two asymmetric arm checks
(`:128`, `:134`) with an arm-matrix test asserting each binding's declared arms
against the arms that actually intercept it. Watch it fail, then add `C` and `P`
to the ordinary arm and `C`, `P`, `\r`, `x`, `z` to the glass arm, with
`onGlassGroupCycle` / `onGlassSortCycle` / `onGlassFilterCycle` splitting the
grid's axes off the sidebar's (`input-router.ts:487` shares them today).

---

## Phase 8 — Tile chrome

**Files:** new `src/glass/tile-hints.ts`; `src/glass/view.ts`; `src/glass/strip.ts`.

`buildTileHints(tile, width)` drops from the tail, returns empty rather than
truncating, omits `⌃a x` at one eligible pane. Drawn on the focused tile's bottom
border only. Strip always visible in the grid, carrying view, dirty marker and
`droppedActive` overflow.

**Verify:** `tile-hints.test.ts`; `glass/strip.test.ts` extended.

---

## Phase 9 — Palette and CLI

**Files:** `src/glass/cc-commands.ts`; `src/main.ts`; `src/cli/pane.ts`,
`src/cli/cc.ts`, `src/cli/session.ts`, `src/cli.ts`.

Palette: **Save current axes as view…**, **Rename view…**, **Delete view**,
**Switch view…** (marking the active view `(unsaved changes)` when dirty), **Show
hidden sessions (N)…**, and the pin/unpin pair. The six tab-CRUD commands and
their handlers (`main.ts:7840–7895`) go.

CLI: `pin`/`unpin` lose `--tab`; `pinned` returns `{ pinned: [{ id }] }`;
`ctl session hide/unhide/hidden` added; `ctl cc tabs` → `ctl cc views` returning
definitions only.

---

## Phase 10 — Docs and ADR

`docs/cheat-sheet.md`, `docs/getting-started.md`, `docs/configuration.md`, the
`CLAUDE.md` Command Center section, new
`docs/adr/0005-derived-command-center-membership.md` (superseding 0003,
correcting ADR 0001's stale "off-screen tiles pause" claim, and recording
one-tile-per-session), and `src/__tests__/glass/view-zoom-note.md` rewritten as
the manual regression the spec describes.

**Final gate:** `bun run typecheck`, `bun test`, `bun run dev` against the spec's
manual list.
