# Plan: Command Center derived membership

Spec: `docs/superpowers/specs/2026-08-10-command-center-derived-membership-design.md`

Ten phases. Each lands green — `bun run typecheck` and `bun test` pass at every
phase boundary — so a phase can be reviewed or reverted on its own. Phases 1–5
are pure modules with no wiring; the Command Center keeps working on the old
mechanism until phase 6 switches it over.

---

## Phase 1 — Extract `orderSessions`

**Files:** new `src/session-order.ts`; `src/sidebar.ts`.

Move the membership-and-order half of `buildRenderPlan` (`sidebar.ts:510–636`)
into an exported pure function. It returns bands in emission order:

```ts
type BandKey = { kind: "pinned" } | { kind: "group"; key: string } | { kind: "ungrouped" } | { kind: "parked" };
interface SessionBand { key: string; label: string; rank: number; indices: number[]; kind: BandKey["kind"] }
function orderSessions(input: SessionOrderInput): SessionBand[]
```

`buildRenderPlan` becomes a consumer: it calls `orderSessions({ …, includeParked:
true })`, then does emission, collapse, issue rows and ghost placement over the
result. Two subtleties the extraction must preserve:

- **Ghost placement can create bands `orderSessions` did not.** A stage holding
  only ghosts still gets a band (`sidebar.ts:593–618`). So `buildRenderPlan`
  merges ghost-only stage bands into the returned list and re-sorts group bands
  by rank before emitting. `orderSessions` itself never sees ghosts.
- **`pinnedPaneCountBySession` (`sidebar.ts:515–522`) is presentation** and stays
  in `buildRenderPlan`.

**Verify:** new `src/__tests__/session-order.test.ts` — `orderSessions` is
collapse-independent; `includeParked: false` drops the parked band; and, with
*nothing* collapsed, `buildRenderPlan(...).displayOrder` equals the concatenated
band indices. Note when writing that test: Parked inverts the collapse default
(`sidebar.ts:747`), so "not collapsed" for Parked means `collapsedGroups.has("parked")`
is **true**. Existing `sidebar.test.ts` must pass untouched.

---

## Phase 2 — Representative pane election

**Files:** new `src/glass/representative.ts`; `src/main.ts` (`resolveAgentPane`).

```ts
export interface PaneRow { paneId: string; kind: string; active: boolean; state: AgentState | null; since: number | null }
export function electRepresentative(panes: readonly PaneRow[], explicitPane: string | null, override: string | null): string | null
export function agentPanes(panes: readonly PaneRow[], commandRegex: string | null): PaneRow[]
```

Precedence: live override → live explicit → most urgent kinded pane by
`outranks()` (`agent-state-rollup.ts:31`) → active pane. `agentPanes` is the set
`Ctrl-a x` cycles: panes declaring `@jmux-agent-kind`, unioned with
`agentPaneRegex` matches on `pane_current_command`.

Rewrite `resolveAgentPane` (`main.ts:3114`) to build `PaneRow[]` from one
`list-panes -s` call and delegate, so the review-notes path and the grid can
never elect differently.

**Verify:** `src/__tests__/glass/representative.test.ts` — every precedence step
alone and in conflict; a dead override falls through; an explicit pane not in
this session's list is rejected; two kinded panes elect the more urgent, ties to
the earliest `since`; no kinded pane falls to active; empty input returns null.

---

## Phase 3 — Exception parsing

**Files:** `src/glass/pinned-pane-tracker.ts`; `src/cli/pane.ts`; new
`src/glass/exceptions.ts`.

`parsePinValue(raw): "on" | null` — any non-empty value is `on`, which is how
legacy `1` and old tab ids read. `resolveTabId` deleted.

`GridExceptions` holds force-on pane ids and hidden session ids and answers
`apply(bands, panes)` → the final tile list per the spec's truth table, including
the "force-on pane is its session's representative" collapse to one tile and the
leading **Added** band (not "Pinned" — `PINNED_GROUP_LABEL` already means pinned
*sessions*, `sidebar.ts:454`).

**Verify:** `src/__tests__/glass/exceptions.test.ts` — the truth table row by row,
including two force-on panes in one session ordering by pane id, and a force-on
pane in a hidden session still tiling.

---

## Phase 4 — Logical tile identity + lifecycle

**Files:** `src/glass/tile-plan.ts`; `src/glass/view.ts`.

`TileKey = \`session:${string}\` | \`pane:${string}\``. `planTiles` gains the
grace window and cap, staying pure by taking `now`:

```ts
planTiles(rendered: TileSpec[], warm: Map<TileKey, { lastSeen: number }>, now: number, graceMs: number, maxTiles: number): TilePlan
```

`GlassView` keys `tiles` by `TileKey`; `paneId` becomes mutable backing state on
the tile, retargeted only when the current pane dies or the override changes.
`focusedKey`, `zoomedKey` and the per-session agent override replace index/pane
state. `computeTileLayout` is unchanged — logical keys resolve to indices at the
call site.

**Verify:** `tile-lifecycle.test.ts` (running → complete → running inside the
grace spawns and tears down once; outside it tears down; the cap evicts LRU and
reports the overflow) and `tile-identity.test.ts` (focus survives a reorder; on
disappearance moves to the successor; scroll reclamps; zoom clears when its tile
leaves; override clears when its pane dies).

---

## Phase 5 — Views

**Files:** `src/glass/tabs.ts` → `src/glass/views.ts`; `src/config.ts`.

`CommandCenterView`, `normalizeViews` (clamping each axis to its enum),
`addView` / `renameView` / `deleteView` (delete-last re-seeds), `slugifyViewName`,
`validateViewName`, and `axesDiffer(view, axes)` for the dirty marker. Config
gains `commandCenterViews`, `commandCenterActiveViewId`, `commandCenterAxes`, and
`commandCenter.maxTiles`; a one-time migration deletes `commandCenterTabs` and
`autoPinAgentPanes` and persists, since `persist()` writes the whole object
(`config.ts:551`).

Note in the config comment that the grid's filter **does** persist, unlike the
sidebar's, which deliberately does not (`config.ts:175`) — a view carries a
filter by definition.

**Verify:** `glass/views.test.ts` and `config.test.ts` per the spec.

---

## Phase 6 — The reconciler

**Files:** `src/main.ts`.

`refreshPinnedPanes` → `reconcileGrid()`, trailing-edge debounced to one run per
render tick (trailing edge so a coalesced burst can never be dropped). It reads
one `list-panes -a` pass plus `list-sessions -F`, elects representatives, applies
exceptions to `orderSessions(gridAxes)`, and hands the result to `GlassView`.

Remove the `pinnedTracker.size > 0 || autoPinAgentPanes` guard (`main.ts:1398`)
and call `reconcileGrid()` from every source in the spec's invalidation table.
Add a session-scoped subscription for the hide option beside the existing pane
one (`main.ts:10076`):

```
"#{S:#{session_id}=#{@jmux-grid-hidden} }"
```

Verified working. Note that `#{P:…}` loops only the *current window's* panes, so
the existing pin subscription is a partial trigger — the poll tick is what makes
a pin set in another window land, and `reconcileGrid` must run there too.

`sidebar.setPinnedPanes` → `setGridSummary({ count, tally })`; the Overview row
counts derived members, not `pinnedPanes.length` (`sidebar.ts:669`).

**Verify:** boot-smoke stays green; manual — pin from `ctl` in another window and
watch the tile appear within a poll.

---

## Phase 7 — Keys

**Files:** `src/input-router.ts`; `src/keymap.ts`; `src/__tests__/keymap.test.ts`.

Add `C` and `P` to the ordinary arm, `C`, `P`, `\r`, `x`, `z` to the glass arm,
with `onGlassGroupCycle` / `onGlassSortCycle` / `onGlassFilterCycle` splitting the
grid's axes off the sidebar's (`input-router.ts:487` currently shares them).

**`keymap.test.ts` must change first, and it is the phase's real deliverable:**
decode `\r` and `\n` in `routerPrefixKeys` (it special-cases only `\t`, so
`data === "\r"` currently decodes to the printable `r`, `keymap.test.ts:81`), and
replace the two asymmetric arm checks (`:128`, `:134`) with an arm-matrix test
that asserts each binding's declared arms against the arms that actually
intercept it. Write the test, watch it fail, then add the chords.

---

## Phase 8 — Tile chrome

**Files:** new `src/glass/tile-hints.ts`; `src/glass/view.ts`; `src/glass/strip.ts`.

`buildTileHints(tile, width)` returns the hint string, dropping from the tail and
returning empty rather than truncating; `⌃a x` omitted at one agent pane; `hide`
vs `unpin` by tile kind. Drawn on the focused tile's bottom border only. Strip
becomes always-visible in the grid and carries the active view, the dirty marker
and the overflow count.

**Verify:** `tile-hints.test.ts`; `glass/strip.test.ts` extended.

---

## Phase 9 — Palette and CLI

**Files:** `src/glass/cc-commands.ts`; `src/main.ts`; `src/cli/pane.ts`,
`src/cli/cc.ts`, `src/cli/session.ts`, `src/cli.ts`.

Palette: **Save current axes as view…**, **Rename view…**, **Delete view**,
**Switch view…**, **Show hidden sessions (N)…**, and the pin/unpin pair. The six
tab-CRUD commands and their handlers (`main.ts:7840–7895`) go.

CLI: `ctl pane pin/unpin` lose `--tab`; `pinned` returns `{ pinned: [{ id }] }`;
`ctl session hide/unhide/hidden` added; `ctl cc tabs` → `ctl cc views` returning
definitions only. `cli.ts` parser, help and tests move with them.

---

## Phase 10 — Docs and ADR

`docs/cheat-sheet.md`, `docs/getting-started.md`, `docs/configuration.md`, the
`CLAUDE.md` Command Center section, new `docs/adr/0005-derived-command-center-membership.md`
(superseding 0003 and correcting ADR 0001's stale "off-screen tiles pause"
claim), and `src/__tests__/glass/view-zoom-note.md` rewritten as the manual
regression the spec describes.

**Final gate:** `bun run typecheck`, `bun test`, `bun run dev` smoke against the
spec's manual list.
