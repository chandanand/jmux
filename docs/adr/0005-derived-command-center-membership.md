# Command Center membership is derived, sessions get one tile, exceptions are two tmux options

## Status

accepted — supersedes ADR 0003

## Context & decision

Command Center membership was a set of hand-placed pins: `@jmux-pinned` written
per pane, one at a time, from the pane you were currently in, or a blanket
`autoPinAgentPanes` setting that unioned in every detected agent pane and took
the decision away entirely. Putting four agents on the grid meant visiting four
sessions and pinning each one; there was no middle between that and "everything,
with no way to remove one". jmux already computes, for the sidebar, exactly the
set of sessions that matter — agent state, issue links, workflow stage, parking,
activity — and the Command Center ignored all of it and asked the user to
re-state it as pins.

We made **membership derived from the same ordering the sidebar computes**, with
pins surviving as explicit exceptions on top.

**The naive version is wrong, and the reason is load-bearing.** "The grid is
`buildRenderPlan(...).displayOrder`" looks like the obvious shortcut, but
`displayOrder` is populated by sidebar emission, which skips a collapsed
group entirely — and the Parked band is collapsed by default. Reusing
`displayOrder` directly would mean a sidebar disclosure gesture (expanding or
collapsing a group) silently changed which agents the grid mirrors, coupling a
view concern (what's currently expanded) to a membership concern (what's on the
grid). So the shared logic was extracted **one level lower**: `src/session-order.ts`
holds the membership-and-order half of the sidebar's render plan —
`orderSessions()`, returning `SessionBand[]` — with collapse state, ghosts, issue
rows and expansion left behind in `sidebar.ts`'s `buildRenderPlan`, which becomes
a consumer of it. One implementation of "which sessions, in what order", read
two ways, on the same discipline `cli/workflow.ts` keeps by calling
`transformIssues` / `buildViewNodes` instead of restating their rules.

The grid then calls `orderSessions` with `includeParked: false` — parked
(handed-off) work is excluded outright, not banded — and applies two exceptions
on top (`glass/exceptions.ts`), described below.

### One tile per session

**Every session gets at most one tile, and this is a tmux constraint, not a
preference.** A tile is a second real tmux client attached directly to the
session (ADR 0001); tmux ties two properties to the *session*, not the client:

- The **current window** is a session property. Two clients attached to one
  session are looking at the same window — there is no way for two tiles to show
  two different panes of that session's window layout at once without them
  fighting each other's `select-window`.
- **Zoom is window-global.** `resize-pane -Z`, which is how a tile goes
  full-bleed, zooms the whole window. Two panes in one window cannot both be
  full-bleed simultaneously.

So the grid cannot show two panes of one session at once, by any arrangement of
pins — this was true before this design and is unchanged by it, just newly
honest about it. Every tile is therefore a *session* tile: `TileKey` is
`session:$id` and nothing else, membership is a set of sessions, and a pin
chooses a session's **face** (which pane it shows, via
`glass/representative.ts`'s election) rather than adding a second tile. Seeing a
session's other agents is a cycle within its one tile (`Ctrl-a x`), not a second
row on the grid.

Fanning a session out across multiple tiles would need each tile to blit a
sub-rectangle of the mirrored window instead of relying on `resize-pane -Z`,
which also gives up one-client-per-tile sizing. That is a materially larger
change and was not attempted here.

### Two exceptions, two scopes, because they have different subjects

| Option | Scope | Meaning |
| --- | --- | --- |
| `@jmux-pinned` | pane | Keep this pane's **session** on the grid, and prefer this pane as its face |
| `@jmux-grid-hidden` | session | Keep this session off the grid |

`@jmux-pinned` stays pane-scoped, keeping ADR 0002's boundary: agents shape
membership through tmux with no IPC to the running TUI, and still cannot force
the user's *view*. It can no longer mean "add a tile" — under one-tile-per-session
there is nothing to add — so it now means "this session belongs on the grid, and
this is the pane I care about in it", which is what a user pinning a dev-server
pane actually wants and is representable where the old tab-membership model
wasn't.

`@jmux-grid-hidden` is new and is session-scoped, because its subject is a
session's tile. A pane-scoped "off" would evaporate the moment the elected
representative changed to a different pane in the same session — the exception
has to attach to the thing it excludes.

**Hidden beats a force-on pane in the same session.** This is the one place the
two exceptions can disagree, and the rule is not "more specific wins" — that
would be a fine rule if both facts were about the same subject, but they aren't.
Hide's subject is the whole session; a pin's subject is one pane inside it. A
rule where pinning any pane silently defeated an explicit "keep this session off
my grid" would make the hide untrustworthy: the user would have to remember
every pane that might carry a stale pin before trusting that hiding a session
actually hides it. So hidden-plus-pinned resolves to no tile, and the pin's only
remaining effect is to preselect the face if the session is ever unhidden. A
hidden session is never silent about it, either — the palette carries **Show
hidden sessions (N)…** whenever N > 0, so an exception the user forgot about is
always one keystroke from being undone.

## Considered alternatives

- **Keep hand-placed pins, add a "select all agent panes" bulk action.** Rejected
  — this still requires re-stating, in pin form, information jmux already has
  about which sessions matter, and it does nothing about the auto-pin dead end
  (an auto-pinned pane's own "unpin" command was disabled).
- **Let membership stay tab-based, and derive tab contents from a saved
  filter.** Considered, but a tab's whole value under ADR 0003 was manual
  curation of a hand-picked set; deriving its contents removes the reason to have
  a tab-scoped identity for a pane at all. Cleaner to replace tabs with saved
  *views* (named axis presets: filter/group/sort) that describe a rule, not a
  membership list — views are their own change, downstream of this one.
- **"More specific wins" for the hidden-plus-pinned conflict** (a pin on a
  hidden session's pane un-hides it). Rejected per the reasoning above: the two
  options don't share a subject, so specificity isn't the right axis to resolve
  them on, and it makes hiding a session load-bearing only until someone
  (possibly an agent, via `ctl pane pin`) pins one of its panes.
- **Fan-out tiles (sub-rectangle blit) to allow more than one tile per
  session.** Rejected for this design — real but strictly larger than the
  problem being solved, and cycling the face already answers "I have two agents
  in one session" without it.

## Consequences

- **`session-order.ts` is now the one membership-and-order primitive**, read by
  the sidebar (with ghosts, collapse and issue rows layered on) and by the grid
  (with the two tmux-option exceptions layered on instead). A change to grouping
  or sorting rules made in one place is automatically correct in both, and cannot
  drift the way `displayOrder` reuse would have.
- **A session pinned via `ctl pane pin` from an agent still respects a human's
  `@jmux-grid-hidden`.** This is deliberate, not a gap: the hide is the user's
  and an agent's pin cannot override it.
- **`autoPinAgentPanes` is deleted outright.** Derived membership already
  surfaces every session the sidebar would show under `filter: active`, which is
  the auto-pin behaviour without the setting's dead end (an auto-pinned pane's
  unpin action used to be permanently disabled).
- **The Command Center's own axes (filter/group/sort) can differ from the
  sidebar's**, because they are now the membership rule for a *saved view*
  rather than a transient narrowing — see the view-registry design
  (`commandCenterViews` / `commandCenterAxes`) for the follow-on consequences of
  that split.
- Corrects ADR 0001's stale "only visible tiles parse" claim — see the
  correction note added to that ADR.
