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
  tabs (`glass/strip.ts:22`). Shift-arrows move tile focus and nothing anywhere
  says so.
- **No way back in.** You spot the agent that is waiting and then have to find
  its session in the sidebar by hand, landing on the session rather than on the
  pane you were looking at.

Meanwhile jmux already knows which sessions matter — agent state, issue links,
workflow stages, parking, activity recency, and a sidebar that filters, groups
and sorts on all of it. The Command Center ignores every bit of that and asks the
user to re-state it as pins.

## Approach

**Membership is derived from the same ordering the sidebar computes.** Pins
survive as explicit exceptions on top.

The naive version of this — "the grid is `buildRenderPlan(...).displayOrder`" —
is wrong, and the reason matters. `displayOrder` is populated by `emitSession`,
which `emitGroup` never reaches for a collapsed group (`sidebar.ts:695`), and the
Parked band is collapsed by default (`sidebar.ts:772`). `displayOrder` therefore
means *rows currently visible in the sidebar*, which would make a sidebar
disclosure gesture silently change which agents the grid mirrors.

So the shared primitive is extracted one level lower.

### `src/session-order.ts` — the shared primitive

A new pure module holding the membership-and-order half of `buildRenderPlan`,
with the emission half left behind:

```ts
export interface SessionBand {
  key: string;            // "pinned" | "parked" | group key
  label: string;
  rank: number;
  indices: number[];      // session indices, sorted by sortMode
}

export interface SessionOrderInput {
  sessions: SessionInfo[];
  sortInfos: SessionSortInfo[];
  groupMode: GroupMode;
  sortMode: SortMode;
  filterMode: FilterMode;
  pinnedSessions: ReadonlySet<string>;
  parkedSessions: ReadonlySet<string>;
  workflowByName: ReadonlyMap<string, SessionWorkflow>;
  includeParked: boolean;
}

export function orderSessions(input: SessionOrderInput): SessionBand[];
```

Collapse state, ghosts, issue rows and expansion are **not** inputs — they are
presentation, and they stay in `buildRenderPlan`, which becomes a consumer:
it calls `orderSessions({ ..., includeParked: true })` and then emits headers,
collapse, ghosts and issue rows over the result. The grid calls the same function
with its own axes and `includeParked: false`.

One asymmetry the extraction has to preserve: **ghost placement can create bands
`orderSessions` never returns.** A stage holding only ghosts still gets a band
(`sidebar.ts:593–618`) — that is the whole point of the stage placement, and it
is why a ghost carries its own stage label and rank. So `buildRenderPlan` merges
ghost-only stage bands into the returned list and re-sorts the group bands by
rank before emitting. `orderSessions` never sees a ghost, and the grid therefore
cannot grow a band from one.

Parked exclusion is stated here rather than inherited from the sidebar's collapse
default, because the grid has no disclosure gesture to inherit it from. Parked
work has been handed off; the grid is live work.

The result is one implementation of "which sessions, in what order", read two
ways — the same discipline `cli/workflow.ts` keeps by calling `transformIssues` /
`buildViewNodes` instead of restating their rules.

### The grid's set

```
members = orderSessions(…grid axes…)          → session tiles
          minus sessions carrying @jmux-grid-hidden
          plus  panes carrying @jmux-pinned    → pane tiles
```

Ghosts never enter: `orderSessions` takes sessions.

## A tile is a session

Today a tile is a pane. It becomes a session, mirroring that session's
**representative pane**.

### Election

A new pure module `src/glass/representative.ts`, fed the single `list-panes -a`
inventory the reconciler already collects — no per-session tmux calls:

```ts
export function electRepresentative(
  panes: readonly PaneRow[],        // this session's panes, with kind/state/active
  explicitPane: string | null,      // @jmux-agent-pane, session-scoped
  override: string | null,          // the user's Ctrl-a x choice
): string | null;
```

Precedence, stated once so there is one contract:

1. `override`, if that pane is still live and in this session.
2. `explicitPane`, same liveness and membership check.
3. The most urgent pane declaring `@jmux-agent-kind`, by `outranks()`
   (`agent-state-rollup.ts:31`) — waiting over running over complete, ties to the
   earliest `since`.
4. The session's active pane.

Step 3 is a deliberate change from `resolveAgentPane` (`main.ts:3114`), which
returns the *first* pane with a kind. First-with-a-kind is arbitrary when a
session hosts two agents, and this surface exists to show the one that needs you.
`resolveAgentPane` is rewritten to call `electRepresentative` so the review-notes
path and the grid cannot elect differently. Step 4 is new and is what lets a
session with no agent at all — a dev server, a log tail — tile without a pin.

The election is re-run by the reconciler, but a tile only *retargets* when its
current pane dies or the override changes. A representative that changes because
a sibling became more urgent does not yank the tile out from under a user who is
typing into it.

### `Ctrl-a x` cycles the agent pane; it does not fan out

The design that this replaces had `Ctrl-a x` expand a session tile into one tile
per agent pane. **That is not implementable with the current mechanism.** Each
tile is a second client attached to the home session, made full-bleed by
`resize-pane -Z` (`glass/view.ts:381`), and tmux's zoom is *window-global* — two
panes in one window cannot both be zoomed. This is already recorded as a known
limitation (`src/__tests__/glass/view-zoom-note.md:23`), and a split-pane session
is exactly the case expansion was for.

So `Ctrl-a x` cycles which agent pane the focused session tile mirrors, setting
the `override` above. One tile, N agents, one keystroke between them. The border
hint carries the position (`⌃a x agent 2/3`) so the other agents are visible as a
fact even before you press it. The override is stored per session id in memory,
cleared when the chosen pane dies.

Fan-out would need the tiles to blit a sub-rectangle of the mirrored window
rather than rely on zoom, which also means giving up one-client-per-tile sizing.
That is a larger change than this spec and is not attempted here.

### Labels

Session tiles are labelled with the sidebar row's identity — `displaySessionName`
plus the issue badge — instead of `buildPaneLabel`'s `session › paneTitle`, which
repeated the session name on every tile from that session.

`buildPaneLabel` is **kept**, for pane tiles: a force-on pane needs to say *which*
pane it is, and a session label there would make two force-on panes in one
session indistinguishable.

## Exceptions

Two options, two scopes, because the two exceptions have different subjects.

| Option | Scope | Value | Meaning |
| --- | --- | --- | --- |
| `@jmux-pinned` | pane | `on`, and every legacy value (`1`, `default`, any old tab id) | Force this pane onto the grid as its own tile |
| `@jmux-grid-hidden` | session | `1` | Keep this session off the grid |

Force-off is session-scoped because its subject is a session tile, and a
pane-scoped `off` would evaporate the moment the representative changed. Session
scope also costs nothing to read: the reconciler already runs `list-sessions`.

`@jmux-pinned` stays pane-scoped and keeps ADR 0002's boundary — agents shape
membership through tmux with no IPC, and still cannot force the user's *view*.
Reading it through `#{@jmux-pinned}` in a `list-panes -a` format inherits from
the session, which is harmless because nothing writes it at session scope; the
force-off option deliberately does not reuse this name, so the inheritance
asymmetry never has to be reasoned about twice.

Legacy values read as `on` rather than being migrated. Every one of them was
written by someone saying "put this on the grid"; the tab-id half of that
sentence no longer has a referent. `parsePinValue(raw): "on" | null` replaces
`resolveTabId` and is the one interpretation shared by the TUI and `cli/pane.ts`.

### Truth table

| Situation | Result |
| --- | --- |
| Session is a derived member, no exceptions | One session tile |
| Session hidden | No session tile |
| Force-on pane **is** its session's representative | The session tile, labelled as a pane tile; not two tiles |
| Force-on pane is a sibling in a member session | Extra tile, inserted directly after its session's tile |
| Force-on pane in a non-member session | Tile in a leading `Added` band |
| Force-on pane in a hidden session | Tile appears — the pane names one thing, the hide names a whole session, and the more specific wins |
| Two force-on panes in one session | Two tiles, ordered by pane id |
| Force-on pane dies | Tile removed; the stale option is cleared by `pruneExcept` |
| Hidden session dies | Option dies with the session |

The band holding force-on panes from non-member sessions is called **Added**, not
"Pinned": `PINNED_GROUP_LABEL` already means pinned *sessions* (`sidebar.ts:454`),
a separate concept that floats sessions to the top of the sidebar and that the
grid honours as its own first band.

A hidden session is discoverable, not silent: the palette carries **Show hidden
sessions (N)…** whenever N > 0, and the empty state names the count. An exception
you cannot see is an exception you cannot undo.

### One key, two subjects

`Ctrl-a P` acts on what is in front of you. In the grid it removes the focused
tile — hiding the session for a session tile, clearing `@jmux-pinned` for a pane
tile. In a session it force-ons the current pane. Both read as "act on the thing
I am looking at", the rule the info panel's action bar already follows.

**A tile can be both**, by row 3 of the table: a force-on pane that is also its
session's representative renders as one tile backed by two facts. Pressing
`Ctrl-a P` there must do *both* — hide the session and clear the force-on — or
the key removes one reason the tile is present, the other keeps it on screen, and
the press reads as broken. "Remove what I am looking at" is the contract; it is
not satisfied by removing one of two causes.

`autoPinAgentPanes` is deleted — auto *is* the baseline now, and a setting that
turned derived membership off would leave an empty grid with no way to fill it.
`agentPaneRegex` survives, moved under agent detection, where it identifies agent
panes for the representative election rather than configuring a pin.
`detectAgentPanes`' signal 2 (active pane of a session with inherited state) is
deleted: it existed to serve session-scoped state writers, which the election's
step 4 now covers directly.

## Lifecycle: rendered set ≠ client set

Under `filter=active` — waiting or running (`sidebar-sort.ts:131`) — a session
going from running to complete leaves the derived set. `planTiles` tears down
every warm tile absent from membership (`glass/tile-plan.ts:29`), and teardown
unzooms and kills the pty (`glass/view.ts:427`). Left alone, an agent finishing
and starting again would attach, detach and toggle the user's real window zoom on
a poll cadence.

So the two are separated:

- **Rendered set** — the derived membership, recomputed every reconcile.
- **Client set** — physical mirrors, with a keep-warm grace of `TILE_GRACE_MS`
  (30s). A tile that leaves membership stops rendering immediately and is torn
  down only after the grace elapses without returning, or immediately when the
  cap forces an eviction.
- **Cap** — `commandCenter.maxTiles`, default 12, LRU by last-rendered. Overflow
  is stated in the strip (`+3 not shown`), never silently dropped.

The cap is not optional. ADR 0001 claims off-screen tiles pause parsing; that is
**stale** — `planTiles` takes no viewport (`glass/tile-plan.ts:20`) and every
spawned pty writes into its `ScreenBridge` unconditionally (`glass/view.ts:414`),
with visibility consulted only while drawing (`glass/view.ts:197`). Every tile in
the rendered set costs a tmux client and a live xterm.js parser whether or not it
is on screen. ADR 0001 gets a correction note saying so.

Zoom is applied on spawn and undone on teardown only, so churn inside the grace
window cannot toggle a user's window layout.

## Logical tile identity

`GlassView` is keyed and ordered by `paneId` today (`glass/view.ts:99`), and
`setTiles` preserves only a numeric `focusedIndex` (`glass/view.ts:150`). With a
set that reorders whenever an agent changes state — `sortBy: "status"` puts
waiting first — that focuses a different tile under the user's hands.

Tiles are therefore keyed by a **logical key**: `session:$3` or `pane:%7`. The
pane behind a session tile is replaceable backing state. Everything positional is
stored as a logical key and resolved to an index at use:

- **Focus** — on disappearance, the nearest surviving neighbour by the vanished
  tile's last index, preferring the successor.
- **Scroll** — reclamped from the resolved focus index after every reconcile.
- **Zoom** (`Ctrl-a z`) — a logical key; cleared if that tile leaves the rendered
  set. Zoom and the agent cycle are independent: cycling inside a zoomed session
  tile is allowed and keeps the zoom.
- **Agent override** — keyed by session id, cleared when its pane dies.

## Views

`commandCenterTabs` is replaced by three fields:

```ts
interface CommandCenterView {
  id: string;                 // slug, unique
  name: string;               // 1–24 chars, unique case-insensitively
  filter: FilterMode;
  groupBy: GroupMode;
  sortBy: SortMode;
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
(`config.ts:175`). That is not an oversight copied wrong: the sidebar's filter is
a transient narrowing of a list that is always on screen, while the grid's filter
*is* its membership rule and is half of what a saved view means. A view whose
filter reset on restart would not be saved.

`normalizeViews` keeps `normalizeTabs`' defensive shape and additionally clamps
each axis to its legal enum, falling back to the seed's value. `slugifyTabName`
and `validateTabName` survive as `slugifyViewName` / `validateViewName`; the
CRUD helpers `addTab` / `renameTab` / `deleteTab` / `moveTab` are replaced by
`addView` / `renameView` / `deleteView`, with `deleteView` on the last view
re-seeding rather than refusing — there is no protected default any more, because
a view has no members to strand.

`Ctrl-a f` / `G` / `s` inside the grid write `commandCenterAxes`, not the
sidebar's. They cannot share the existing callbacks: the glass arm currently
dispatches the very same `onGroupCycle` / `onSortCycle` / `onFilterCycle`
(`input-router.ts:487`) that mutate and persist Sidebar state (`main.ts:4641`).
The glass arm gets `onGlassGroupCycle` / `onGlassSortCycle` /
`onGlassFilterCycle`.

When `commandCenterAxes` no longer equals the active view, its chip is marked
(`Active ·`) rather than continuing to name a view you are not in. **Save current
axes as view…**, **Rename view…** and **Delete view** are the three palette
commands, down from six. Config hot-reload re-normalizes, clamps the active id
and re-renders, exactly as `clampTabSelection` does now.

The strip is **always visible in the grid**, not gated on two views — it is the
grid's only chrome besides the tile borders, and it carries the active view, the
dirty marker and the overflow count.

## Keys

| Chord | Arms | Action |
| --- | --- | --- |
| `Ctrl-a C` | ordinary + glass | Toggle the Command Center |
| `Ctrl-a ↵` | glass | Open the focused tile's session full-size, on its pane |
| `Ctrl-a x` | glass | Cycle the focused session tile's agent pane |
| `Ctrl-a z` | glass | Zoom the focused tile / restore |
| `Ctrl-a P` | ordinary + glass | Remove the focused tile / force-on the current pane |

"Everywhere" is precisely: the ordinary prefix arm and the glass arm. **Not** the
full-screen-surface arm — settings, workflow and ghost preview keep their
deliberate two chords (`input-router.ts:441`) — and not while a modal is open,
which suppresses the prefix path entirely (`input-router.ts:431`).

`Ctrl-a C` **does** shadow a stock tmux binding: `bind-key -T prefix C
customize-mode -Z`, verified against a `tmux -f /dev/null` server. That is an
accepted shadow on the precedent jmux already set for `?` (list-keys) and `s`
(choose-session): tmux's customize-mode is its settings browser, and jmux ships
`Ctrl-a I` and `Ctrl-a i` in its place. `P` and `Enter` are unbound in the stock
prefix table. `x`, `z` and `o` are tmux pane operations but are shadowed only in
the glass arm, where there is no tmux pane to act on.

**Failure paths, both of which are reachable:**

- `Ctrl-a C` leaving the grid must move the client off the park session —
  `exitGlass` explicitly leaves that to its caller (`main.ts:9651`) and
  `switchSession` swallows a dead target (`main.ts:3882`). It targets
  `preGlassSessionId` if still live, else the first member of the current order,
  else it stays in the grid and shows a notice. Stranding the client on
  `__jmux_park` renders an empty screen with no chrome.
- `Ctrl-a ↵` re-resolves the tile's pane at press time. Pane gone → select the
  session and its active pane. Session gone → notice, stay in the grid.

## The focused tile says what it does

The bottom border of the focused tile carries its actions, mirroring the label
chip already drawn on the top border:

```
┌─ TRA-412 fix the retry backoff ────────────────┐
│                                                │
└─ ⇧↔ focus · ⌃a↵ open · ⌃a x agent 2/3 · ⌃a P hide ─┘
```

Left-aligned after the corner, in the frame-rule tone, on the focused tile only,
so exactly one hint is ever on screen and it moves with attention. Hints drop
from the tail as the tile narrows — the first hint or nothing, never a truncated
one. Every glyph is width-1, for the same reason the drift marker is `!` and not
`⚠`: this string is measured with `cellWidth` and written into a `CellGrid` like
every other row, and a width-2 glyph terminals disagree about leaves ghost gaps.

`⌃a x` is omitted when the session has one agent pane, and `⌃a P hide` reads
`unpin` on a pane tile — a hint naming the wrong subject is worse than no hint.

The empty state names the view, what did not match, and the key that widens it:

```
No sessions match "Active"
⌃a f  all sessions      ⌃a 1…9  switch view      3 hidden
```

## Reconciliation

`refreshPinnedPanes` becomes `reconcileGrid()`, the single entry point, debounced
to at most one run per render tick. Today the glass is refreshed on agent-state
change only when a pin exists or auto-pin is on (`main.ts:1396`) — a guard that
under derived membership would leave the ordinary case unrefreshed.

Every invalidation source, enumerated because a missed one is an invisible stale
tile:

| Source | Why |
| --- | --- |
| Session list add/remove/rename | membership and labels |
| Session title / project / activity change | labels, `sortBy` activity/name |
| `%layout-change`, pane add/remove/active-pane | election and liveness |
| `@jmux-agent-state` / `-kind` / `-pane` | election, `filter`, `sortBy` status |
| Tracker poll → workflow/stage change | `groupBy: "stage"` bands |
| Parking change | membership |
| `@jmux-pinned` / `@jmux-grid-hidden` change | exceptions |
| View switch, axis cycle, view CRUD | axes |
| Config file reload | views, cap, axes |

The debounce is **trailing-edge**, so a burst of control-channel events coalesces
into one run that happens after the last of them. A leading-edge debounce would
drop the state the burst was reporting.

Two subscriptions feed it. The existing per-pane one for `@jmux-pinned`
(`main.ts:10076`) gains a session-scoped sibling for the hide option,
`#{S:#{session_id}=#{@jmux-grid-hidden} }` — verified to expand correctly against
a scratch tmux. Note that `#{P:…}` loops only the panes of the *current window*,
so the pin subscription has always been a partial trigger; a pin written by `ctl`
in another window lands on the poll tick instead, which is why `reconcileGrid`
must be on the poll's invalidation list and not only on the subscription's.

The sidebar's Overview row stops counting `pinnedPanes` (`sidebar.ts:669`) — a
derived grid can be full while zero panes are pinned. `reconcileGrid` computes
the count and state tally and calls `sidebar.setGridSummary({ count, tally })`,
the same boundary shape as `setSessionWorkflow`.

## CLI

- `ctl pane pin` / `unpin` — force-on only. `--tab` is removed;
  `loadTabRegistry` / `resolveTabFlagToId` go with it.
- `ctl pane pinned` — returns `{ pinned: [{ id }] }`. The old shape leaked the
  tab; `parsePinnedListWithTab` becomes `parsePinnedList`.
- `ctl session hide` / `unhide` / and `hidden` — force-off, new, session-scoped.
- `ctl cc tabs` → `ctl cc views`, returning view definitions. It does **not**
  return member counts: membership needs the TUI's session/agent state, and a
  count re-derived a second way is the disagreement this whole design exists to
  remove. `cli.ts`'s parser, help text and tests move with it.

## Config migration

`config.ts` writes the whole loaded object back (`config.ts:551`), so deleting a
TypeScript field does not delete the JSON key. A one-time migration on load drops
`commandCenterTabs` and `autoPinAgentPanes` and seeds `commandCenterViews` /
`commandCenterActiveViewId` / `commandCenterAxes` if absent. Existing
`@jmux-pinned` values survive untouched and read as force-on.

## What is deleted

`commandCenterTabs`, `autoPinAgentPanes`; `addTab` / `renameTab` / `deleteTab` /
`moveTab` / `resolveTabId`; the tab id inside `@jmux-pinned`;
`openInputModalForNewTab` / `openInputModalForRenameTab` / `tryDeleteActiveTab`;
the six tab-CRUD palette commands and `NEW_TAB_OPTION_ID`; `detectAgentPanes`'
signal 2; `--tab` / `loadTabRegistry` / `resolveTabFlagToId`; `ctl cc tabs`.

`buildPaneLabel` is **not** deleted — pane tiles need it.

ADR 0003 is superseded. ADR 0005 records derived membership, the two-option
exception model, and the corrected resource claim against ADR 0001.

## Verification

Unit, all pure modules:

- `session-order.test.ts` — `orderSessions` is collapse-independent; parked
  excluded under `includeParked: false`; `buildRenderPlan`'s `displayOrder`
  equals the concatenated bands **when nothing is collapsed**, which pins the
  refactor without enshrining disclosure state. Writing that case needs care:
  Parked inverts the collapse default (`sidebar.ts:747`), so "Parked not
  collapsed" means `collapsedGroups.has("parked")` is **true**, and a test that
  passes an empty set is asserting the opposite of what it reads as.
- `glass/representative.test.ts` — each precedence step in isolation and in
  conflict; a dead override falls through; an explicit pane belonging to another
  session is rejected; two kinded panes elect the more urgent by `outranks`; no
  agent falls to the active pane.
- `glass/tile-lifecycle.test.ts` — running → complete → running inside the grace
  window spawns and tears down **once**; outside it, tears down; the cap evicts
  LRU and reports the overflow count.
- `glass/tile-identity.test.ts` — focus survives a reorder; focus moves to the
  successor when its tile vanishes; scroll reclamps; zoom clears when its tile
  leaves; the agent override clears when its pane dies.
- `glass/exceptions.test.ts` — the truth table above, row by row.
- `glass/views.test.ts` — normalize drops malformed entries and clamps illegal
  axes; delete-last re-seeds; dirty-axis marker; hot-reload clamps the active id.
- `glass/strip.test.ts` — view chips, dirty marker, overflow count, always-on.
- `tile-hints.test.ts` — tail-dropping; never a partial hint; `⌃a x` omitted at
  one agent pane; `hide` vs `unpin` by tile kind; total width by `cellWidth`.
- `cli/pane.test.ts`, `cli/cc.test.ts` — `parsePinValue`; `pinned`'s new shape;
  `session hide/unhide/hidden`; `cc views`.
- `config.test.ts` — the migration drops both dead keys and seeds the three new
  ones; a config already migrated is untouched.

`keymap.test.ts` needs **changing, not merely relying on**. As written it cannot
enforce what this design needs: the non-glass equality test excludes
Command-Center-context bindings (`keymap.test.ts:91,128`), the glass test only
requires bindings carrying the exact glass context (`keymap.test.ts:134`), so a
chord declared for both arms can be missing from one and still pass — and its
decoder special-cases only `\t`, so `data === "\r"` decodes to the printable key
`r`, which is already bound. Changes: decode `\r` / `\n` correctly, and add an
arm-matrix test asserting each binding's declared arms against the arms that
actually intercept it. This matters because an unintercepted glass chord is
flushed straight to the mirrored agent (`input-router.ts:493`).

Integration and manual, for what unit tests structurally cannot reach:

- `boot-smoke.test.ts` / `binary-boot-smoke.test.ts` — unchanged, run.
- Manual, replacing `view-zoom-note.md`: two agent panes in one window — `Ctrl-a
  x` cycles between them in one tile and the home window's zoom is left clean on
  exit; more tiles than fit the viewport; `Ctrl-a ↵` lands on the tile's pane;
  `Ctrl-a C` from a session, from the grid, and with the pre-glass session killed
  while the grid is open.

## Risks accepted

**The grid's axes can differ from the sidebar's.** Deliberate — a wide sidebar
and a tight grid at once — with the dirty-view marker and the always-visible
strip as the disclosure, the same obligation the workflow screen took on when
`showUnstartedInSidebar` could make a per-stage toggle moot.

**Fan-out into sibling panes is not delivered**, because window-global zoom
forbids it. `Ctrl-a x` cycling is the honest substitute; sub-rectangle blitting
is the path if fan-out is ever wanted.

**`maxTiles` truncates.** Stated in the strip rather than silent, on the rule
that a workflow which bounds coverage must say what it dropped.
