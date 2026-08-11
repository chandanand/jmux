# Command Center: derived membership, session tiles, saved views

Date: 2026-08-10

## Problem

The Command Center works. Getting anything onto it does not.

Membership is a set of hand-placed pins. `@jmux-pinned` is written per pane, and
the only ways to write it are a palette command that operates on *the active pane
of the session you are currently in*, `jmux ctl pane pin`, or the
`autoPinAgentPanes` setting that unions every detected agent pane in at render
time. Putting four agents on the grid means visiting four sessions and running
the same palette command four times, or turning on a blanket setting that takes
the decision away entirely. There is no middle.

The blanket setting then dead-ends: an auto-detected pane's *Unpin tile* command
is rendered disabled with the hint `auto-pinned; disable auto-pin or it returns`
(`glass/cc-commands.ts:41`). The first thing a user does after seeing a grid full
of everything — remove the two they don't want — is the thing the feature
refuses.

Three smaller failures compound it:

- **No key opens it.** Every other full-area surface has one — `Ctrl-a I`
  settings, `Ctrl-a W` workflow, `Ctrl-a g` panel, `Ctrl-a b` browser. The
  Command Center is reachable only by clicking the sidebar's first row or walking
  `Ctrl-Shift-Up` to it.
- **Nothing on screen says what its keys do.** The glass is a frameless
  full-screen takeover: no toolbar, no footer, and the strip is hidden below two
  tabs (`glass/strip.ts:22`). Shift-arrows move tile focus and nothing says so.
- **No way back in.** You spot the agent that is waiting and then have to find
  its session in the sidebar by hand, landing on the session rather than on the
  pane you were looking at.

Meanwhile jmux already knows which sessions matter — agent state, issue links,
workflow stages, parking, activity recency, and a sidebar that filters, groups
and sorts on all of it. The Command Center ignores every bit of that and asks the
user to re-state it as pins.

## The constraint everything else obeys

**One tile per session. Always.**

A tile is a second tmux client attached to the pinned pane's home session
(`glass/view.ts:392`), made full-bleed by `resize-pane -Z` (`glass/view.ts:381`).
Two facts follow from tmux, not from jmux:

- The current window is a property of the **session**, so two clients attached to
  one session look at the same window. Two tiles showing different windows of one
  session race each other's `select-window` (`glass/view.ts:365`).
- Zoom is **window-global**, so two panes in one window cannot both be full-bleed.
  This is already recorded as a known limitation
  (`src/__tests__/glass/view-zoom-note.md:23`).

So the grid cannot show two panes of one session at once, by any arrangement of
pins. Every design decision below is downstream of that: membership is a set of
*sessions*, a pin chooses a session's **face** rather than adding a tile, and
seeing a session's other agents is a cycle within its one tile.

Fan-out would need tiles to blit a sub-rectangle of the mirrored window instead
of relying on zoom, which also means giving up one-client-per-tile sizing. That
is a larger change than this spec and is not attempted.

## Approach

**Membership is derived from the same ordering the sidebar computes.** Pins
survive as explicit exceptions on top.

The naive version — "the grid is `buildRenderPlan(...).displayOrder`" — is wrong,
and the reason matters. `displayOrder` is populated by `emitSession`, which
`emitGroup` never reaches for a collapsed group (`sidebar.ts:695`), and the Parked
band is collapsed by default (`sidebar.ts:772`). `displayOrder` therefore means
*rows currently visible in the sidebar*, which would make a sidebar disclosure
gesture silently change which agents the grid mirrors.

So the shared primitive is extracted one level lower.

### `src/session-order.ts` — the shared primitive

A new pure module holding the membership-and-order half of `buildRenderPlan`
(`sidebar.ts:510–636`), with the emission half left behind:

```ts
export type BandKind = "pinned" | "group" | "ungrouped" | "parked";

export interface SessionBand {
  kind: BandKind;
  key: string;          // "pinned" | "parked" | "ungrouped" | "stage:<id>" | …
  label: string;        // "" for ungrouped
  rank: number;         // group ordering within kind="group"
  headerless: boolean;  // true only for kind="ungrouped"
  indices: number[];    // session indices, sorted by sortMode
}

export function orderSessions(input: {
  sessions: SessionInfo[];
  sortInfos: SessionSortInfo[];
  groupMode: GroupMode; sortMode: SortMode; filterMode: FilterMode;
  pinnedSessions: ReadonlySet<string>;
  parkedSessions: ReadonlySet<string>;
  workflowByName: ReadonlyMap<string, SessionWorkflow>;
  includeParked: boolean;
}): SessionBand[];

/** The comparator group bands are sorted by, exported so ghost-only bands
 *  appended later are ordered by the same rule. */
export function compareGroupBands(a: SessionBand, b: SessionBand, groupMode: GroupMode): number;
```

Bands come back in emission order: `pinned?`, group bands (sorted), `ungrouped?`,
`parked?`. `headerless` is what distinguishes the ungrouped remainder — which
today emits bare sessions with no group header (`sidebar.ts:729`) — from a band
that draws one, so the contract can represent both.

Collapse state, ghosts, issue rows and expansion are **not** inputs. They stay in
`buildRenderPlan`, which becomes a consumer: it calls `orderSessions({ …,
includeParked: true })` and emits headers, collapse, ghosts and issue rows over
the result. Three asymmetries the extraction must preserve:

- **Ghost placement creates bands `orderSessions` never returns.** A stage holding
  only ghosts still gets a band (`sidebar.ts:593–618`) — the whole point of the
  stage placement, and why a ghost carries its own stage label and rank. So
  `buildRenderPlan` appends ghost-only stage bands and re-sorts the group bands
  with `compareGroupBands`, the same comparator, so a ghost-only band and a
  session-bearing one can never be ordered by different rules.
- **Flat ghosts sit between `ungrouped` and `parked`** (`sidebar.ts:751`) and are
  purely an emission concern; `orderSessions` never sees a ghost, so the grid
  cannot grow a band from one.
- **Parked has inverted collapse polarity** (`sidebar.ts:747`): absent from
  `collapsedGroups` means collapsed. `orderSessions` expresses only *inclusion*
  (`includeParked`); polarity stays with emission.

The result is one implementation of "which sessions, in what order", read two
ways — the discipline `cli/workflow.ts` keeps by calling `transformIssues` /
`buildViewNodes` instead of restating their rules.

### The grid's set

```
sessions = orderSessions(…grid axes…, includeParked: false)
           minus sessions carrying @jmux-grid-hidden
           plus  sessions containing a pane carrying @jmux-pinned   → the "Added" band
each session → exactly one tile
```

Ghosts never enter: `orderSessions` takes sessions.

The leading band for pin-only sessions is called **Added**, not "Pinned":
`PINNED_GROUP_LABEL` already means pinned *sessions* (`sidebar.ts:454`), a
separate concept that floats sessions to the top and that the grid honours as its
own first band.

## The representative pane

Each tile mirrors one pane of its session. Two functions, deliberately separate,
because a sticky display and a live answer are different questions and conflating
them was a bug in the previous draft.

**`src/glass/representative.ts`** — pure:

```ts
export interface PaneRow {
  paneId: string;
  kind: string;            // @jmux-agent-kind, pane-scoped, no inheritance source
  command: string;         // pane_current_command, for the regex signal
  forcedOn: boolean;       // @jmux-pinned on this pane
  sessionActive: boolean;  // window_active && pane_active — see below
  state: AgentState | null;
  since: number | null;
}

/** Panes worth cycling: kinded, regex-matched, or force-on. Order: pane id. */
export function eligiblePanes(panes: readonly PaneRow[], commandRegex: string | null): PaneRow[];

/** The live answer. Stateless — recomputed from current urgency every call. */
export function electRepresentative(
  panes: readonly PaneRow[],
  explicitPane: string | null,     // @jmux-agent-pane, session-scoped
  commandRegex: string | null,
): string | null;
```

`electRepresentative` walks three tiers, taking the first that has members:

1. the live `explicitPane` (must appear in `panes`),
2. the force-on panes,
3. the eligible panes,
4. failing all of those, **all** the session's panes.

**Within whichever tier answers**, the winner is the most urgent by `outranks()`
(`agent-state-rollup.ts:31`) — waiting over running over complete, ties to the
earliest `since`; else that tier's `sessionActive` member; else its lowest pane id.

Two consequences, both deliberate. A force-on pane with no state beats a kinded
pane that has one, because the pin is an explicit "this is the pane I care about
in this session" and an explicit choice outranks a derived signal — the same rule
`explicitPane` above it and `@jmux-pinned` throughout this design follow. And a
session with *no* eligible pane at all still elects one, via tier 4: that is what
lets a dev server or a log tail tile without anyone pinning it, and it is the
whole reason the tier exists. `null` comes back only when the session has no
panes, which means it no longer exists.

`sessionActive` sits inside the tier rule rather than being a tier of its own
because it is a tiebreak, not a claim: among three agent panes that have not
reported state yet, the one in the window you were last looking at is a better
face than the one with the lowest id, but neither outranks a pane that is actually
waiting on you.

**`sessionActive` means `window_active && pane_active`, not `pane_active` alone.**
`pane_active` is true of one pane in *every* window, so a session with three
windows has three "active" panes and the fallback would pick arbitrarily.

**Stickiness lives in `GlassView`, not in the election.** A tile keeps its current
pane until that pane dies, the user cycles, or a force-on pin changes — a
representative that changed because a sibling became more urgent must not yank
the tile out from under someone typing into it. `resolveDisplayedRepresentative`
is that rule, and it is a method on the view, over the stateless election.

**`resolveAgentPane` (`main.ts:3114`) calls the stateless `electRepresentative`,
not the sticky one.** Its job is "which pane wrote this diff, so I can paste the
review at it" — that wants the live answer and has nothing to do with what the
grid happens to be showing. `resolveAgentPane`'s current contract (explicit →
*first* pane with a kind) is changed to most-urgent, because first-with-a-kind is
arbitrary when a session hosts two agents.

### `Ctrl-a x` cycles the face

`Ctrl-a x` moves the focused tile to the next pane in `eligiblePanes`, setting an
override stored per session id, cleared when that pane dies. One tile, N agents,
one keystroke between them. The border hint carries the position (`⌃a x agent
2/3`), so the other agents are a visible fact before you press anything.

### Labels

A tile is labelled with the sidebar row's identity — `displaySessionName` plus the
issue badge. When the displayed pane is *not* the session's natural first choice
(a force-on pin or a live cycle override), `buildPaneLabel`'s pane half is
appended so the tile says which pane it is showing. `buildPaneLabel` is therefore
**kept**, not deleted; it stops being the whole label and becomes the suffix.

## Exceptions

Two options, two scopes, because the two exceptions have different subjects.

| Option | Scope | Value | Meaning |
| --- | --- | --- | --- |
| `@jmux-pinned` | pane | `on`, and every legacy value (`1`, `default`, any old tab id) | Keep this pane's **session** on the grid, and prefer this pane as its face |
| `@jmux-grid-hidden` | session | `1` | Keep this session off the grid |

Force-on no longer means "add a tile" — it cannot, under the one-tile-per-session
constraint. It means "this session belongs on the grid, and this is the pane I
care about in it". That is what a user pinning a dev-server pane actually wants,
and it is representable.

Force-off is session-scoped because its subject is a session tile; a pane-scoped
`off` would evaporate the moment the representative changed. Session scope costs
nothing to read — the reconciler already runs `list-sessions`.

`@jmux-pinned` stays pane-scoped and keeps ADR 0002's boundary: agents shape
membership through tmux with no IPC, and still cannot force the user's *view*.
Verified against tmux 3.7b: a session-scoped option **does** resolve through a
pane-context format read (`list-panes` supplies pane, window and session
contexts), and `show-options -p` correctly does not see it. The reconciler reads
`@jmux-grid-hidden` from `list-sessions -F` anyway, so no inheritance has to be
reasoned about at the read site. Both option names are **reserved at window
scope** — jmux never writes them there — so an accidental window-local value
cannot shadow the session value.

Legacy `@jmux-pinned` values read as `on` rather than being migrated. Every one
was written by someone saying "put this on the grid"; the tab-id half of that
sentence no longer has a referent. `parsePinValue(raw): "on" | null` replaces
`resolveTabId`, and is the one interpretation shared by the TUI and `cli/pane.ts`.

### Truth table

| Situation | Result |
| --- | --- |
| Session is a derived member, no exceptions | One tile, face = `electRepresentative` |
| Session hidden, no force-on pane in it | No tile |
| Session hidden **and** a pane in it force-on | No tile — hide is session-scoped and its subject is the whole session; the pin's remaining effect is to preselect the face if it is ever shown again |
| Derived member with a force-on pane | One tile, face = that pane |
| Non-member session with a force-on pane | One tile, in the `Added` band |
| Two force-on panes in one session | One tile; face = the more urgent, both in the `Ctrl-a x` cycle |
| Force-on pane dies | Pin pruned by `pruneExcept`; session keeps its tile if derived, loses it if it was pin-only |
| Session dies | Tile and both options die with it |

The hidden-plus-pinned row is the one place the previous draft said the opposite.
"More specific wins" is a fine rule for two facts about the same subject; these
have different subjects, and a rule where pinning any pane silently defeats an
explicit "keep this session off my grid" makes the hide untrustworthy.

A hidden session is discoverable, not silent: the palette carries **Show hidden
sessions (N)…** whenever N > 0, and the empty state names the count. An exception
you cannot see is an exception you cannot undo.

### `Ctrl-a P` — one subject, because there is only one kind of tile

Every tile is a session tile, so the previous draft's composite ambiguity does not
arise. In the grid, `Ctrl-a P` **removes the focused session from the grid**: it
sets `@jmux-grid-hidden` on the session *and* clears `@jmux-pinned` from every
pane in it, as one action. Clearing both is required, not tidy-up — leaving a pin
behind would mean the session returns to the grid the moment the hide is lifted,
for a reason the user has forgotten.

In a session, `Ctrl-a P` force-ons the current pane and clears the session's hide
if it had one. Both directions read as "act on the thing I am looking at", the
rule the info panel's action bar already follows.

`autoPinAgentPanes` is deleted — auto *is* the baseline, and a setting that turned
derived membership off would leave an empty grid with no way to fill it.
`agentPaneRegex` survives, moved under agent detection, and is now threaded into
`eligiblePanes` rather than into a pin decision. `detectAgentPanes` is deleted
outright: signal 1 is `kind`, signal 3 is the regex — both now live in
`eligiblePanes` — and signal 2 (active pane of a session with inherited state)
existed to serve session-scoped state writers, which the election's fallbacks
cover directly.

## Lifecycle: rendered set ≠ client set

Under `filter=active` — waiting or running (`sidebar-sort.ts:131`) — a session
going from running to complete leaves the derived set. Today `planTiles` tears
down every warm tile absent from membership (`glass/tile-plan.ts:29`) and teardown
unzooms and kills the pty (`glass/view.ts:427`), so an agent finishing and
starting again would attach, detach and toggle the user's real window zoom on a
poll cadence.

`planTiles` cannot express "retain but do not render", so it is redesigned rather
than extended:

```ts
export interface ActiveTile { key: TileKey; forced: boolean }

export interface TilePlanInput {
  active: ActiveTile[];                                // rendered, in order
  live: ReadonlySet<TileKey>;                          // clients that exist right now
  retained: ReadonlyMap<TileKey, { lastSeenAt: number }>;  // ⊆ live, left membership
  now: number;
  graceMs: number;      // 30_000
  maxClients: number;   // commandCenter.maxTiles, default 12
}
export interface TilePlan {
  spawn: TileKey[];
  render: TileKey[];        // may be shorter than `active` under overflow
  teardown: TileKey[];
  droppedActive: number;    // active tiles the cap refused — reported, never silent
  nextExpiryAt: number | null;  // arm a timer; grace must expire with no tmux traffic
}
```

The planner runs in this order, and the order is the contract — admission
precedes spawning, because a `spawn` computed before the cap is applied would
attach clients for tiles that are never rendered (`glass/view.ts:138` executes
every `plan.spawn`, and `ensureTile` attaches a real client at
`glass/view.ts:389`):

```
1. admitted   = cap(active, maxClients)        # SELECTION priority: forced first,
                                               # then active order. The survivors
                                               # keep their original active order.
2. render     = admitted
3. droppedActive = active.length - admitted.length
4. spawn      = admitted.filter(k => !live.has(k))
5. budget     = maxClients - admitted.length
   keptRetained = retained
                    .filter(r => now - r.lastSeenAt < graceMs)
                    .sortBy(lastSeenAt, descending)
                    .slice(0, max(0, budget))
6. teardown   = live \ (admitted ∪ keptRetained)
7. nextExpiryAt = min(lastSeenAt + graceMs over keptRetained) ?? null
```

Every rule falls out of that sequence:

- **`live` separates a spawn from a survivor**, and is not derivable from the
  other fields. `retained` holds only tiles that have *left* membership, so an
  active tile whose client already exists appears in neither `active`-minus-
  `retained` nor `retained`: without `live`, two consecutive reconciles with
  identical membership are identical input, and step 4 would have to answer
  "spawn A" the first time and "don't" the second. `retained ⊆ live` by
  construction. This is the job today's `warm` set does (`glass/view.ts:122`,
  `glass/tile-plan.ts:20`), unchanged in purpose.
- **The cap counts clients, active and grace-retained together** — step 5's
  `budget` is what enforces that — because it is a resource cap or it is nothing.
- **Active always outranks retained.** Step 1 takes its share first, so a newly
  active tile evicts the least-recently-seen retained client through step 6
  rather than waiting out its grace.
- **Under active overflow, force-on sessions are kept first** — but that is which
  tiles survive the cap, *not* what order they draw in. `admitted` keeps the
  active order of whatever it selected; a pinned tile does not jump to the front
  of the grid. Hoisting on overflow would mean the grid silently rearranged itself
  the moment a session count crossed `maxTiles`, fighting the `sortBy` the user
  chose. The remainder is `droppedActive`, stated in the strip (`+3 not shown`).
  `forced`
  therefore has to travel on the **active** entries, which is why they are
  `{ key, forced }` and not bare keys: with `active = [A, B]`, no retained clients
  and `maxClients: 1`, a planner given only keys receives identical input whether
  A or B is pinned. Putting new actives into `retained` to carry the flag is not
  the workaround it looks like — `retained` is also what distinguishes a survivor
  from a spawn.
- **An active tile the cap refuses is torn down**, not left attached: step 6
  subtracts `admitted`, not `active`, so a client that was live and is no longer
  admitted releases its resources rather than becoming an invisible leak.
- **`retained` carries only `lastSeenAt`, and the reconciler stamps it** at the
  moment a tile moves from active to retained, with the same `now` it passes in.
  The planner never invents a timestamp.
- **`nextExpiryAt` is a returned deadline**, because a tile that leaves membership
  during a quiet period would otherwise never be collected — there is no
  subsequent tmux event to trigger the sweep.

Zoom is applied on spawn, moved on **retarget** (below), and undone on teardown.
Churn inside the grace window touches none of the three, so it cannot toggle a
user's window layout.

### Retarget: the face moves without the tile moving

`Ctrl-a x`, the death of the displayed pane, or a new force-on pin can move a
tile's face to a pane in a **different window** of the same session. Its `TileKey`
is unchanged, so `planTiles` correctly neither spawns nor tears down — and today a
survivor only receives new metadata (`glass/view.ts:142`), while `select-window`
and zoom happen solely at spawn (`glass/view.ts:357–383`) and unzoom solely at
teardown (`glass/view.ts:427`). Left there, the tile would keep showing the old
window.

So `GlassView` gains a third transition beside spawn and teardown:

```
retarget(key, nextPaneId):
  if tile.didZoom: resize-pane -Z -t <tile.zoomedPaneId>   # give the old window back
  select-window -t <session>:<window of nextPaneId>
  didZoom = (that window has siblings and is not already zoomed)
  if didZoom: resize-pane -Z -t nextPaneId
  tile.paneId = nextPaneId; tile.zoomedPaneId = didZoom ? nextPaneId : null
```

The client, its pty and its `ScreenBridge` are all retained — only what the
session is looking at changes. `didZoom` and the zoomed pane are tracked together
because teardown must undo exactly the zoom it applied, and after a retarget that
is no longer the pane the tile started on.

The cap is not optional. ADR 0001 claims off-screen tiles pause parsing; that is
**stale** — `planTiles` takes no viewport (`glass/tile-plan.ts:20`) and every
spawned pty writes into its `ScreenBridge` unconditionally (`glass/view.ts:414`),
with visibility consulted only while drawing (`glass/view.ts:197`). Every client
costs a tmux attach and a live xterm.js parser whether or not it is on screen.
ADR 0001 gets a correction note.

## Logical tile identity

`GlassView` is keyed and ordered by `paneId` today (`glass/view.ts:99`), and
`setTiles` preserves only a numeric `focusedIndex` (`glass/view.ts:150`). With a
set that reorders whenever an agent changes state — `sortBy: "status"` puts
waiting first — that focuses a different tile under the user's hands.

`TileKey` is `session:$id`, and only that: one tile per session means there is no
second kind of key. The pane behind a tile is mutable backing state. Everything
positional is stored as a key and resolved to an index at use:

- **Focus** — on disappearance, the nearest survivor by the vanished tile's last
  index, preferring the successor.
- **Scroll** — reclamped from the resolved focus index after every reconcile.
- **Zoom** (`Ctrl-a z`) — a key; cleared if that tile leaves the rendered set.
  Cycling the face inside a zoomed tile is allowed and keeps the zoom.
- **Face override** — keyed by session id, cleared when its pane dies.

`computeTileLayout` is unchanged: it stays positional, and `GlassView` maps
`rect.index` through `tileOrder` to a key and then to its client. Every
pane-id-indexed operation in `glass/view.ts:184–344` changes together.

## Views

`commandCenterTabs` is replaced by three fields:

```ts
interface CommandCenterView {
  id: string;                 // slug, unique
  name: string;               // 1–24 chars, unique case-insensitively
  filter: FilterMode; groupBy: GroupMode; sortBy: SortMode;
}

commandCenterViews: CommandCenterView[];        // never empty after normalize
commandCenterActiveViewId: string;              // clamped to an existing view
commandCenterAxes: { filter, groupBy, sortBy }; // the live, possibly-dirty axes
```

The seed is one view — `{ id: "active", name: "Active", filter: "active",
groupBy: "status", sortBy: "status" }` — and `commandCenterAxes` seeds from it.
The grid does **not** seed from the sidebar: the sidebar defaults to `filter:
"all"` (`sidebar.ts:992`), which on a 25-session machine is 25 mirrors on first
open. The default view *is* the first-run state.

The grid's filter **persists**, where the sidebar's deliberately does not
(`config.ts:175`). Not an oversight copied wrong: the sidebar's filter is a
transient narrowing of a list that is always on screen, while the grid's filter
*is* its membership rule and half of what a saved view means.

Three transitions, each stated because each has two plausible answers:

- **Switching views while the axes are dirty** — the incoming view's axes win and
  the dirty axes are discarded. Selecting a view means adopting it; carrying
  unsaved axes across would make the marker mean two different things. **Save
  current axes as view…** is the way to keep them, and the switch command's
  sublist says `(unsaved changes)` beside the active view when dirty.
- **Deleting the active view** — the previous view by index becomes active, or the
  first when it was index 0; its axes are adopted. Deleting the last view
  re-seeds the default and adopts it. There is no protected default, because a
  view has no members to strand.
- **Hot reload changing the active view** — re-normalize, clamp the active id. If
  the id survives, it stays active; axes that were dirty stay dirty (the user's
  in-flight narrowing is not the file's business). If it vanished, fall to index 0
  and adopt its axes.

`normalizeViews` keeps `normalizeTabs`' defensive shape and additionally clamps
each axis to its legal enum, falling back to the seed's value. `slugifyTabName` /
`validateTabName` survive as `slugifyViewName` / `validateViewName`;
`addTab`/`renameTab`/`deleteTab`/`moveTab` become `addView`/`renameView`/
`deleteView`.

`Ctrl-a f` / `G` / `s` inside the grid write `commandCenterAxes`. They cannot
share the existing callbacks: the glass arm currently dispatches the very same
`onGroupCycle` / `onSortCycle` / `onFilterCycle` (`input-router.ts:487`) that
mutate and persist Sidebar state (`main.ts:4641`). The glass arm gets
`onGlassGroupCycle` / `onGlassSortCycle` / `onGlassFilterCycle`.

The strip is **always visible in the grid**, carrying the active view, the dirty
marker (`Active ·`), and the overflow count.

## Keys

| Chord | Arms | Action |
| --- | --- | --- |
| `Ctrl-a C` | ordinary + glass | Toggle the Command Center |
| `Ctrl-a ↵` | glass | Open the focused tile's session full-size, on its displayed pane |
| `Ctrl-a x` | glass | Cycle the focused tile's face |
| `Ctrl-a z` | glass | Zoom the focused tile / restore |
| `Ctrl-a P` | ordinary + glass | Remove the focused session from the grid / add the current pane |

"Everywhere" is precisely the ordinary prefix arm and the glass arm. **Not** the
full-screen-surface arm — settings, workflow and ghost preview keep their
deliberate two chords (`input-router.ts:441`) — and not while a modal is open,
which suppresses the prefix path entirely (`input-router.ts:431`).

`Ctrl-a C` **does** shadow a stock tmux binding: `bind-key -T prefix C
customize-mode -Z`, verified against a `tmux -f /dev/null` server on 3.7b. An
accepted shadow, on the precedent jmux already set for `?` (list-keys) and `s`
(choose-session): customize-mode is tmux's settings browser and jmux ships
`Ctrl-a I` and `Ctrl-a i` in its place. `P` and `Enter` are unbound in the stock
prefix table. `x` and `z` are tmux pane operations shadowed only in the glass arm,
where there is no tmux pane to act on. No `o` chord is added.

**Failure paths, both reachable:**

- `Ctrl-a C` leaving the grid must move the client off the park session —
  `exitGlass` explicitly leaves that to its caller (`main.ts:9651`) and
  `switchSession` swallows a dead target (`main.ts:3882`). It targets
  `preGlassSessionId` if still live, else the first session in the current order,
  else it stays in the grid and shows a notice. Stranding the client on
  `__jmux_park` renders an empty screen with no chrome.
- `Ctrl-a ↵` re-resolves the tile's pane at press time. Pane gone → the session
  and its active pane. Session gone → notice, stay in the grid.

## The focused tile says what it does

The bottom border of the focused tile carries its actions, mirroring the label
chip already drawn on the top border:

```
┌─ TRA-412 fix the retry backoff ────────────────────┐
│                                                    │
└─ ⇧↔ focus · ⌃a↵ open · ⌃a x agent 2/3 · ⌃a P hide ─┘
```

Left-aligned after the corner, in the frame-rule tone, on the focused tile only,
so exactly one hint is ever on screen and it moves with attention. Hints drop from
the tail as the tile narrows — the first hint or nothing, never a truncated one.
Every glyph is width-1, for the same reason the drift marker is `!` and not `⚠`:
this string is measured with `cellWidth` and written into a `CellGrid` like every
other row, and a width-2 glyph terminals disagree about leaves ghost gaps.

`⌃a x` is omitted when the session has one eligible pane. The empty state names
the view, what did not match, and the key that widens it:

```
No sessions match "Active"
⌃a f  all sessions      ⌃a 1…9  switch view      3 hidden
```

## Reconciliation

`refreshPinnedPanes` becomes `reconcileGrid()`, the single entry point. It reads
one `list-panes -a` pass plus `list-sessions -F`, elects faces, applies
exceptions to `orderSessions(gridAxes)`, and hands the result to `GlassView`.

**Scheduling is a state machine, not a debounce.** Reconciliation runs async tmux
queries, so an invalidation arriving after a snapshot but before the run finishes
would be swallowed by "one run per tick". Written out, because every ambiguity
below is a lost update:

```ts
let scheduled = false;   // a run is queued on the next tick
let inFlight  = false;   // a run is between snapshot and apply
let dirty     = false;   // an invalidation arrived while inFlight

function invalidateGrid(): void {
  if (inFlight) { dirty = true; return; }   // queue for after the current run
  if (scheduled) return;                    // already coalescing
  scheduled = true;
  queueMicrotask(runReconcile);             // trailing edge of this tick's burst
}

async function runReconcile(): Promise<void> {
  scheduled = false;
  inFlight = true;
  dirty = false;                            // cleared BEFORE the snapshot
  try {
    const snapshot = await readTmuxState();  // list-panes -a + list-sessions -F
    applyGrid(snapshot);
  } catch (e) {
    logError("reconcileGrid", String(e));    // a failed read must not wedge the loop
  } finally {
    inFlight = false;
    if (dirty) { dirty = false; scheduled = true; queueMicrotask(runReconcile); }
  }
}
```

`dirty` is cleared **before** the snapshot, never after: clearing it afterwards
discards every event that arrived while the query was in flight, which is the
exact window this machine exists to cover. The rescheduling lives in `finally`, so
a thrown read reschedules rather than leaving `inFlight` stuck true and the grid
permanently frozen. Plus the `nextExpiryAt` timer from the tile plan, which is the
only thing that collects a grace-expired client when tmux has gone quiet.

Every invalidation source, enumerated because a missed one is an invisible stale
tile:

| Source | Why |
| --- | --- |
| Session list add/remove/rename | membership and labels |
| Session title / project resolution / activity | labels, `sortBy` activity/name |
| `%layout-change`, `%window-pane-changed` | pane inventory and active pane |
| `@jmux-agent-state` / `-kind` / `-pane` | election, `filter`, `sortBy` status |
| Tracker poll → workflow/stage change | `groupBy: "stage"` bands |
| Parking change | membership |
| `@jmux-pinned` / `@jmux-grid-hidden` change | exceptions |
| View switch, axis cycle, view CRUD | axes |
| Config file reload | views, axes |

**`commandCenter.maxTiles` is read once, at `GlassView` construction, and is
deliberately not in the row above.** Every other hot-reloadable field here is
a pure input to *what the grid computes* — `orderSessions`, the exceptions, the
axes — so re-deriving it is side-effect-free. The cap is different: it is
consumed by `planTiles`'s admission step, and lowering it live means real
attached mirror clients — live tmux clients with a pty and a running
`ScreenBridge` — cross from admitted to refused and get torn down
(`GlassView.teardownTile`: unzoom, detach) as a side effect of an unrelated
config edit landing on disk. A config reload silently closing tiles the user
is looking at is a worse experience than the cap requiring a restart to take
effect. Raising it live would be safe on its own, but a setting that sometimes
hot-applies and sometimes doesn't — depending on the direction of the edit —
is a worse contract than one that never does; `ensureGlassView()` constructs
`GlassView` once and reuses it for the process's life (`teardown()` on
`Ctrl-a C` out clears its clients, not the instance), so `maxTiles` takes
effect on restart, consistently, the same as any other constructor-only
option.

Two of these need plumbing that does not exist. `ControlParser` discards
notifications it does not know (`tmux-control.ts:84`), so `%layout-change` and
`%window-pane-changed` must be parsed and surfaced. And **project resolution is
async and currently only repaints the sidebar** (`main.ts:9143`); it must
reconcile too, or a session's `groupBy: "project"` band is wrong until something
else moves.

**The pin subscription is nested, and today's is a bug.** `#{P:…}` loops only the
panes of the *current window*, so `"#{P:#{pane_id}=#{@jmux-pinned} }"`
(`main.ts:10080`) has never fired for a pin written in an unfocused window — a
`ctl pane pin` from an agent working in another window is invisible until
something unrelated triggers a refresh. jmux already solved this for the
agent-state options and says so in the comment above them: `#{S:#{W:#{P:…}}}`
enumerates the whole server (`main.ts:10043–10050`). The pin subscription is
nested the same way as part of this work.

There is deliberately **no periodic reconcile**. jmux runs no general tmux poll —
`PollCoordinator` is the *tracker* poll, and the intervals in `main.ts` belong to
hunk, the cache timer, the theme requery and the agent screen scan. Adding one to
paper over a subscription gap would be inventing a second, slower answer to a
question the control channel already answers exactly. The hide option gets a
session-scoped sibling, `"#{S:#{session_id}=#{@jmux-grid-hidden} }"`, verified to
expand correctly.

The sidebar's Overview row stops counting `pinnedPanes` (`sidebar.ts:669`) — a
derived grid can be full while zero panes are pinned. `reconcileGrid` computes the
count and state tally and calls `sidebar.setGridSummary({ count, tally })`, the
same boundary shape as `setSessionWorkflow`.

## CLI

- `ctl pane pin` / `unpin` — unchanged verbs, new meaning per the table above.
  `--tab` is removed, with `loadTabRegistry` / `resolveTabFlagToId`.
- `ctl pane pinned` — returns `{ pinned: [{ id }] }`; `parsePinnedListWithTab`
  becomes `parsePinnedList`.
- `ctl session hide` / `unhide` / `hidden` — new, session-scoped.
- `ctl cc tabs` → `ctl cc views`, returning view definitions. It deliberately does
  **not** return member counts: membership needs the TUI's session and agent
  state, and a count re-derived a second way is exactly the disagreement this
  design exists to remove. `cli.ts`'s parser, help and tests move with it.

## Config migration

`config.ts` writes the whole loaded object back (`config.ts:551`), so deleting a
TypeScript field does not delete the JSON key. A one-time migration on load drops
`commandCenterTabs` and `autoPinAgentPanes`, seeds `commandCenterViews` /
`commandCenterActiveViewId` / `commandCenterAxes` / `commandCenter.maxTiles` when
absent, and persists once. Existing `@jmux-pinned` values survive untouched and
read as force-on.

## What is deleted

`commandCenterTabs`, `autoPinAgentPanes`; `addTab` / `renameTab` / `deleteTab` /
`moveTab` / `resolveTabId`; the tab id inside `@jmux-pinned`;
`openInputModalForNewTab` / `openInputModalForRenameTab` / `tryDeleteActiveTab`;
the six tab-CRUD palette commands and `NEW_TAB_OPTION_ID`; `detectAgentPanes` and
`glass/auto-detect.ts` entirely; `--tab` / `loadTabRegistry` /
`resolveTabFlagToId`; `ctl cc tabs`.

`buildPaneLabel` is **not** deleted — it becomes the label suffix when a tile
shows a non-default face.

ADR 0003 is superseded. ADR 0005 records one-tile-per-session, derived
membership, the two-option exception model, and the corrected resource claim
against ADR 0001.

## Verification

Unit, all pure modules:

- `session-order.test.ts` — `orderSessions` is collapse-independent;
  `includeParked: false` drops the parked band; `headerless` is true only for
  ungrouped; and with nothing collapsed, `buildRenderPlan(...).displayOrder`
  equals the concatenated band indices. That last case needs care: Parked inverts
  the collapse default (`sidebar.ts:747`), so "Parked not collapsed" means
  `collapsedGroups.has("parked")` is **true**, and a test passing an empty set
  asserts the opposite of what it reads as. Plus: a ghost-only stage band appended
  by `buildRenderPlan` sorts identically to a session-bearing one.
- `glass/representative.test.ts` — every precedence step alone and in conflict; a
  `sessionActive` fallback with three windows picks the one in the active window,
  not one per window; `eligiblePanes` unions kind, regex and force-on and orders
  by pane id; an explicit pane absent from `panes` is rejected; two kinded panes
  elect the more urgent, ties to the earliest `since`.
- `glass/tile-plan.test.ts` — rewritten for the new contract: two consecutive
  calls with identical `active` spawn on the first and nothing on the second, once
  `live` reflects the first; an active tile the cap refuses is never spawned, and
  one that was live and stops being admitted appears in `teardown`; running →
  complete → running inside the grace spawns and tears down **once**; outside it,
  tears down;
  `nextExpiryAt` is returned and is null when nothing is retained; an active tile
  evicts a retained one immediately; active overflow keeps force-on first and
  reports `droppedActive`.
- `glass/tile-identity.test.ts` — focus survives a reorder; moves to the successor
  when its tile vanishes; scroll reclamps; zoom clears when its tile leaves; the
  face override clears when its pane dies. Plus the retarget command sequence
  against a recording runner: unzoom the old window before selecting the new one,
  and teardown after a retarget unzooms the pane the tile *ended* on, not the one
  it started on.
- `reconcile-loop.test.ts` — the state machine against a fake async read: an
  invalidation during `inFlight` causes exactly one follow-up run; a throwing read
  clears `inFlight` and still reschedules a pending `dirty`; a burst of ten
  invalidations in one tick produces one run.
- `glass/exceptions.test.ts` — the truth table row by row, hidden-plus-pinned
  included.
- `glass/views.test.ts` — normalize drops malformed entries and clamps illegal
  axes; the three transitions above; dirty marker.
- `glass/strip.test.ts` — view chips, dirty marker, overflow count, always-on.
- `tile-hints.test.ts` — tail-dropping; never a partial hint; `⌃a x` omitted at
  one eligible pane; total width by `cellWidth`.
- `cli/pane.test.ts`, `cli/cc.test.ts`, `cli/session.test.ts` — `parsePinValue`;
  `pinned`'s new shape; `session hide/unhide/hidden`; `cc views`.
- `config.test.ts` — the migration drops both dead keys and seeds the new ones; a
  config already migrated is untouched.
- `tmux-control.test.ts` — `%layout-change` and `%window-pane-changed` parse and
  surface rather than being discarded.

`keymap.test.ts` needs **changing, not merely relying on**. As written it cannot
enforce what this design needs: the non-glass equality test excludes
Command-Center-context bindings (`keymap.test.ts:91,128`), the glass test only
requires bindings carrying the exact glass context (`keymap.test.ts:134`), so a
chord declared for both arms can be missing from one and still pass — and its
decoder special-cases only `\t`, so `data === "\r"` decodes to the printable `r`,
which is already bound. Changes: decode `\r` / `\n` correctly, and replace those
two checks with an arm-matrix test asserting each binding's declared arms against
the arms that actually intercept it. This matters because an unintercepted glass
chord is flushed straight to the mirrored agent (`input-router.ts:493`).

Integration and manual, for what unit tests structurally cannot reach:

- `boot-smoke.test.ts` / `binary-boot-smoke.test.ts` — unchanged, run.
- Manual, replacing `view-zoom-note.md`: a session with two agent panes in one
  window — `Ctrl-a x` cycles between them in one tile, and the home window's zoom
  is clean on exit; a session with panes in two windows — one tile, no
  `select-window` fighting; more sessions than `maxTiles`; `Ctrl-a ↵` lands on the
  displayed pane; `Ctrl-a C` from a session, from the grid, and with the pre-glass
  session killed while the grid is open; `ctl pane pin` from another window landing
  within one poll.

## Risks accepted

**The grid's axes can differ from the sidebar's.** Deliberate — a wide sidebar and
a tight grid at once — with the dirty marker and the always-visible strip as the
disclosure, the same obligation the workflow screen took on when
`showUnstartedInSidebar` could make a per-stage toggle moot.

**One tile per session** is a hard limit of attach-and-zoom, not a preference. A
user running two agents in one session sees one at a time. `Ctrl-a x` and the
`2/3` counter are what keep that honest rather than invisible.

**`maxTiles` truncates.** Stated in the strip rather than silent, on the rule that
anything bounding coverage must say what it dropped.
