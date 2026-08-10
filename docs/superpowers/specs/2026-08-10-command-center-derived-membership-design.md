# Command Center: derived membership, session tiles, saved views

Date: 2026-08-10

## Problem

The Command Center works. Getting anything onto it does not.

Membership is a set of hand-placed pins. `@jmux-pinned` is written per pane, and
the only ways to write it are a palette command that operates on *the active pane
of the session you are currently in*, `jmux ctl pane pin`, or the
`autoPinAgentPanes` setting that unions every detected agent pane in at render
time. So putting four agents on the grid means visiting four sessions and running
the same palette command four times, or turning on a blanket setting that takes
the decision away entirely. There is no middle.

The blanket setting then dead-ends: an auto-detected pane's *Unpin tile* command
is rendered disabled with the hint `auto-pinned; disable auto-pin or it returns`.
The one thing a user does after seeing a grid full of everything — remove the two
they don't want — is the thing the feature refuses.

Three smaller failures compound it:

- **No key opens it.** Every other full-area surface has one — `Ctrl-a I`
  settings, `Ctrl-a W` workflow, `Ctrl-a g` panel, `Ctrl-a b` browser. The
  Command Center is reachable only by clicking the sidebar's first row or walking
  `Ctrl-Shift-Up` to it.
- **Nothing on screen says what its keys do.** The glass is a frameless
  full-screen takeover: no toolbar, no footer, and the tab strip is hidden below
  two tabs. Shift-arrows move tile focus and nothing anywhere tells you.
- **No way back in.** You spot the agent that is waiting, and then have to find
  its session in the sidebar by hand — landing on the session, not on the pane
  you were looking at.

Meanwhile jmux already knows which sessions matter. It has agent state, issue
links, workflow stages, parking, activity recency, and a sidebar that filters,
groups and sorts on all of it. The Command Center ignores every bit of that and
asks the user to re-state it as pins.

## Approach

**Membership is derived from the same answer the sidebar already computed.**
Pins survive as a two-valued exception on top.

```
grid set = buildRenderPlan(…same session inputs…, gridGroup, gridSort, gridFilter).displayOrder
           minus sessions/panes marked force-off
           plus  panes marked force-on
```

`buildRenderPlan` in `sidebar.ts` is already a pure module-level function that
takes sessions plus the three axes and returns `displayOrder` — session indices,
filtered, grouped and sorted. That array *is* the grid's set and order. Reusing
the function rather than re-deriving the rules is the same discipline
`cli/workflow.ts` keeps: agreement with what the human sees is bought by calling
the same module, never by reimplementing it. A grid that computed its own answer
would be a bug waiting to be filed as "the Command Center disagrees with my
sidebar".

Ghosts are excluded and require no code to exclude: `displayOrder` means
*sessions*, and a ghost row has no pane to mirror.

## A tile is a session

Today a tile is a pane. It becomes a session, mirroring that session's
**representative pane**, elected by `resolveAgentPane(sessionId)` — which already
exists, already prefers the session-scoped `@jmux-agent-pane` written by the
hooks, and already falls back to the only trustworthy pane-level identity
(`@jmux-agent-kind`, which has no session-scoped inheritance source). One case is
added at the end of that ladder: **the session's active pane**, so a session with
no agent at all still tiles. That fallback is what lets a dev-server or log-tail
session appear on the grid without a pin.

Three things follow:

- **Tiles line up 1:1 with sidebar rows.** Same identity, same order, same
  grouping. The label becomes the sidebar row's identity — `displaySessionName`
  plus the issue badge — instead of `buildPaneLabel`'s `session › paneTitle`,
  which repeated the session name on every tile from that session and spent the
  width on it.
- **A session hosting several agents in splits shows one tile**, the most urgent
  one, because `resolveAgentPane` answers with one pane. The others are one
  keystroke away.
- **`Ctrl-a x` expands a focused session tile into one tile per agent pane**, in
  place, and collapses it again. Same construction as the sidebar's issue
  disclosure: the sub-tiles are rebuilt with the plan rather than derived at
  paint time, and a session that drops back to one agent pane collapses on its
  own rather than leaving a dead affordance.

Expansion identifies "agent pane" by `@jmux-agent-kind` (pane-scoped, no
inheritance) unioned with `agentPaneRegex` matches — the same two signals
`detectAgentPanes` uses today, minus signal 2, which existed only to serve the
legacy session-scoped writer that the representative-pane election now handles
directly.

## Pins become exceptions

`@jmux-pinned` keeps its per-pane home and ADR 0002's boundary intact — agents
still shape membership through tmux with no IPC, and still cannot force the
user's *view*. Only the value grammar changes:

| Value | Meaning |
| --- | --- |
| `on` — and every legacy value: `1`, `default`, any old tab id | Force this **pane** onto the grid as its own tile, whatever the rules say |
| `off` | Force off, applied at the pane it is set on |
| unset | Derived |

Reading legacy values as `on` is not a shim. It is the honest reading: every one
of them was written by someone saying "put this on the grid", and the tab id
half of that sentence no longer has a referent. `resolveTabId` is deleted;
`parsePinValue(raw): "on" | "off" | null` replaces it and is the single
interpretation shared by the TUI and `cli/pane.ts`.

**One key does both directions, because the subject differs by where you are.**
In the grid, `Ctrl-a P` takes the focused tile *off*. In a session, it puts the
current pane *on*. Both read as "act on the thing in front of me", which is the
same rule the info panel's action bar follows — it describes what you are looking
at, not where the cursor was last. Clearing an exception back to derived is a
palette command (**Clear grid exception**), because it is the rare one and
because a tri-state cycle on one key is a worse question asked more often.

`ctl pane pin` gains `--off`; `ctl pane unpin` clears the option as it does now,
which under the new grammar means "back to derived" rather than "off".

`autoPinAgentPanes` is deleted — auto *is* the baseline now, and a setting that
turns off derived membership would leave an empty grid with no way to fill it.
`agentPaneRegex` survives, moved under agent detection, where it identifies agent
panes for expansion rather than configuring a pin.

## Views replace tabs

`commandCenterTabs: {id, name}[]` becomes:

```ts
interface CommandCenterView {
  id: string;
  name: string;
  filter: FilterMode;   // "all" | "attention" | "active"
  groupBy: GroupMode;   // "none" | "project" | "status" | "stage"
  sortBy: SortMode;     // "name" | "activity" | "status"
}
```

A view is a named preset of the session-list axes — the sidebar's three axes, not
`PanelView`'s issue axes. The strip renders one chip per view with the existing
`summarizeTabState` dot, and the same `packChips` overflow behaviour.

**The grid holds its own copy of the axes.** `Ctrl-a f` / `G` / `s` inside the
grid nudge the grid's axes, not the sidebar's; the sidebar keeps what it had.
That is a deliberate acceptance of two states that mean the same thing, bought
for a real capability: a wide sidebar and a tight grid at once. The cost is paid
down by never letting them silently diverge on screen — when the grid's axes stop
matching the selected view, the chip is marked (`Backend ·`) rather than
continuing to name a view you are not in.

The grid's axes persist across entries. They seed from the sidebar's axes only
when there is nothing stored, since a saved view that reset every time you left
would not be saved at all.

Existing `commandCenterTabs` entries are dropped rather than migrated. A
hand-assigned bucket has no referent under derived membership; the pins
themselves survive, as force-on. This is user config, not persisted product data,
and jmux owns the file.

`glass/tabs.ts` keeps `normalizeViews` (the same defensive parse, seeding one
default view) and `summarizeTabState`. `addTab` / `renameTab` / `deleteTab` /
`moveTab` / `slugifyTabName` / `validateTabName` / `resolveTabId` and the six
tab-CRUD palette commands are deleted. View CRUD is: **Save current axes as
view…**, **Rename view…**, **Delete view**, reached from the palette — three
commands where there were six, and none of them can fail on "tab is not empty",
because a view has no members to be non-empty of.

## Keys

Five new chords. Four are glass-scoped, so they shadow tmux only where tmux has
no pane to act on: inside the grid there is no tmux pane to kill (`x`), zoom
(`z`) or cycle (`o`).

| Chord | Scope | Action |
| --- | --- | --- |
| `Ctrl-a C` | everywhere | Toggle the Command Center |
| `Ctrl-a ↵` | in grid | Open the focused tile's session full-size |
| `Ctrl-a x` | in grid | Expand / collapse the focused session into its agent panes |
| `Ctrl-a z` | in grid | Zoom the focused tile to the full area / restore |
| `Ctrl-a P` | grid + session | Take the focused tile off the grid / put the current pane on it |

`Ctrl-a C` shadows nothing: tmux binds no default `C`, and jmux's own prefix arm
is free of it. It toggles — pressed inside the grid it leaves, returning to
`preGlassSessionId`, which is the session `enterGlass` captured before parking
rewrote `currentSessionId`.

`Ctrl-a ↵` is the triage payoff and must land on the *pane*, not just the
session: `exitGlass()`, `switchSession(sessionId)`, then `select-window` and
`select-pane` on the tile's own coordinates. Landing on the session and leaving
the user to find the pane again is the failure this key exists to remove.

Shift-arrows, `Ctrl-a 1…9`, `Ctrl-a [` / `]`, `Ctrl-a d` and every other
glass-arm chord are untouched; the digits now select views.

`keymap.test.ts` regexes the glass arm out of `input-router.ts` and asserts it
against `keymap.ts` in both directions, so each chord lands in both files or the
suite fails.

## The focused tile says what it does

The bottom border of the focused tile carries its actions, mirroring the label
chip already drawn on the top border:

```
┌─ TRA-412 fix the retry backoff ────────────────┐
│                                                │
└─ ⇧↔ focus · ⌃a↵ open · ⌃a x panes · ⌃a P hide ─┘
```

Left-aligned after the corner, in the frame-rule tone, on the focused tile only —
so exactly one hint is ever on screen and it moves with attention. Hints drop
from the tail as the tile narrows: the first hint or nothing, never a truncated
one. Every glyph is width-1, for the same reason the drift marker is `!` and not
`⚠`: a width-2 glyph whose terminals disagree leaves ghost gaps, and this string
is measured with `cellWidth` and written into a `CellGrid` like every other row.

`Ctrl-a P` renders as `hide` in the grid and `add to grid` in a session's palette,
because the key's subject differs there and a hint that named the other case
would be wrong half the time.

The empty state has to be rewritten regardless, since nothing is "pinned" any
more. It names the view, says what did not match, and gives the key that widens
it:

```
No sessions match "Needs you"
⌃a f  all sessions      ⌃a 1…9  switch view
```

## What is deleted

`commandCenterTabs`; `addTab` / `renameTab` / `deleteTab` / `moveTab` /
`slugifyTabName` / `validateTabName` / `resolveTabId`; the tab id inside
`@jmux-pinned`; `openInputModalForNewTab` / `openInputModalForRenameTab` /
`tryDeleteActiveTab` / `persistTabs`'s tab half; the six tab-CRUD palette
commands and `NEW_TAB_OPTION_ID`; `autoPinAgentPanes` and its settings entry;
`detectAgentPanes`'s signal 2 and `buildPaneLabel`; `--tab` on `ctl pane pin` and
`loadTabRegistry` / `resolveTabFlagToId` in `cli/pane.ts`.

ADR 0003 is superseded. A new ADR records derived membership and why pins became
exceptions rather than being deleted outright.

Net: two membership systems and a bespoke tab registry become one derived set
plus a two-valued exception.

## Risks taken deliberately

**Tile count is bounded only by the filter.** With `filter=all` and 25 sessions
that is 25 attached tmux clients and 25 xterm.js bridges. Off-screen tiles
already pause parsing (ADR 0001), but spawn cost is paid on entry. Mitigation:
the grid's first-run filter defaults to `active` (waiting + running) rather than
inheriting the sidebar's `all`, and `planTiles`' existing lazy keep-warm means
only the visible set spawns.

**`Ctrl-a z` overlaps conceptually with expansion.** Zoom shows one tile full
area; expansion shows one session's panes. They are different questions and both
are cheap, but if only one survives review it should be expansion, which answers
something the sidebar cannot.

**The grid's axes can differ from the sidebar's.** Accepted, with the diverged
marker as the disclosure — the same obligation the workflow screen took on when
`showUnstartedInSidebar` could make a per-stage toggle moot.

## Verification

- `session-grid.test.ts` — the member function returns exactly
  `buildRenderPlan(...).displayOrder` for the same inputs across every
  group × sort × filter combination; force-on adds a pane the rules excluded;
  force-off removes a session the rules included; a force-off on a non-member is
  inert.
- `glass/tile-plan.test.ts` extended — representative-pane election through
  `@jmux-agent-pane`, then `@jmux-agent-kind`, then the active pane; expansion
  produces one tile per agent pane and collapses at one.
- `glass/tabs.test.ts` → view normalization: malformed entries dropped, a
  non-empty result always returned, axes clamped to legal enum values.
- `glass/strip.test.ts` — view chips, the diverged-axes marker, overflow with the
  marker present.
- `tile-hints.test.ts` — tail-dropping under narrowing widths; a partial hint is
  never drawn; total width matches `cellWidth`.
- `cli/pane.test.ts` — `parsePinValue` over `on` / `off` / `1` / a legacy tab id
  / empty; `--off` writes the right option.
- `keymap.test.ts` — passes only when all five chords exist in both files.
- Manual under `bun run dev`: force-on a dev-server pane, force-off a noisy
  session, `Ctrl-a ↵` and confirm the pane selection lands on the tile's pane,
  `Ctrl-a C` from a session and from the grid.
- `bun run typecheck`, `bun test`, and `boot-smoke` / `binary-boot-smoke`
  unaffected but run.
