# Sidebar filter: "started only"

## Problem

Under `group=stage` the sidebar interleaves ghost rows — issues nobody has
started — into every stage band, below that band's sessions. That placement is
the point of ghosts, but it means there is no way to see the stage layout of the
work that *exists* without also seeing the work that doesn't. The only lever
today is `pipeline.showUnstartedInSidebar`, a config setting: turning ghosts off
to read the board and back on afterwards is a round trip through a JSON file for
what is a moment-to-moment question.

`Ctrl-a f` already narrows the sidebar, but both of its non-`all` modes select on
agent state, so both drop sessions as well as ghosts. Neither answers "every
session, no ghosts".

## Scope

Add a fourth `FilterMode`, `started`, second in the `Ctrl-a f` cycle:

```
All → Started → Needs you → Active → All
```

`started` shows **every** session — it is `all` for sessions — and suppresses
ghost rows **under `group=stage` only**.

Out of scope: persistence (filter stays ephemeral, resetting to `all` on launch,
per the original filter design), and any change to how ghosts are selected,
capped, or ordered.

### Decisions (approved)

- **Named `started`, positioned second.** The word names what the surviving rows
  have in common — work that exists — rather than what they are. Second in the
  cycle puts it one press from `all`, the mode it is most often reached from.
- **It bites only on the stage axis.** On `none`/`project`/`status` there are no
  stage bands; ghosts collect into one flat "Up next" band at the bottom, where
  they are neither interleaved nor in the way. There `started` is deliberately
  identical to `all`.
- **That inertness is disclosed, not hidden.** See "The toast" below.
- **The mode does not refuse to be set off the stage axis.** Unlike `g` on a
  sectioned view, this is not permanently inert — it starts acting the moment
  the user switches to `group=stage`. Refusing it would mean the mode could not
  be armed before switching axes.

## Design

### `src/sidebar-sort.ts` — the policy, pure

```ts
export type FilterMode = "all" | "started" | "attention" | "active";
export const FILTER_MODES: readonly FilterMode[] = ["all", "started", "attention", "active"];
```

Labels: `FILTER_LABELS.started = "started only"` (palette submenu, long form),
`FILTER_SHORT.started = "Started"` (the sidebar header chip).

`matchesFilter(status, "started")` returns `true` for every `SessionStatus`.
Sessions are exactly what `all` shows; the whole difference is in ghosts.

Ghost visibility moves out of `sidebar.ts` and into this module, because it is
now a function of two axes rather than one equality:

```ts
/**
 * Whether ghost rows are emitted at all, given the filter and the grouping axis.
 *
 * "needs you"/"active" select on agent state, which a ghost has none of — it can
 * neither match one nor be honestly excluded by it, so a filter that selects on
 * state suppresses ghosts on every axis.
 *
 * "started only" is a statement about the *stage* axis specifically, where ghosts
 * sit inside every band. On the other axes they collect into one flat "Up next"
 * band, so there the mode is deliberately identical to "all".
 */
export function filterShowsGhosts(filter: FilterMode, group: GroupMode): boolean {
  if (filter === "all") return true;
  if (filter === "started") return group !== "stage";
  return false;
}
```

### `src/sidebar.ts` — one call site

`buildRenderPlan`'s ghost gate (`sidebar.ts:608`) changes from
`if (filterMode === "all")` to `if (filterShowsGhosts(filterMode, groupMode))`.
The comment above it, which currently asserts that a filter suppresses ghosts
everywhere, is rewritten to state the two-axis rule.

Nothing else in the sidebar changes. The header chip already renders any filter
that is not `all` (`sidebar.ts:1358`), so it reads `· Started` with no edit.
Ghosts drop out of `navOrder` for free — an unemitted row is not a nav stop.

### `src/main.ts` — the toast

On `group=project`/`status`/`none`, `started` and `all` draw an identical
sidebar while the header chip reads `· Started`: a filter announcing it is
filtering while filtering nothing. That is the failure `sectionedViewNotice()`
and the workflow screen's "off globally" row exist to prevent — a setting that
looks configured and is inert, with no feedback but the chip.

So landing on `started` while the grouping axis is not `stage` shows a toast:

> `started only: hides unstarted work when grouped by stage (Ctrl-a G)`

It names the setting and where to change it, in the same shape as
`sectionedViewNotice`. The chip still reports the true state — the mode *is*
set; the toast says where it bites.

The key and the palette route through one new `applySidebarFilter(mode)` (mirroring
the existing `applySidebarGroup`/`applySidebarSort`, minus their config write,
since filter is ephemeral), so the two entry points cannot disagree about
whether the disclosure appears:

- `onFilterCycle` (`main.ts:4643`) → `applySidebarFilter(sidebar.cycleFilterMode())`
- the `sidebar-filter` palette sublist handler (`main.ts:7879`) →
  `applySidebarFilter(id as FilterMode)`

Cycling the *group* axis while `started` is set does not toast: the ghost rows
visibly appear or disappear, which is its own feedback. The toast exists only
where nothing changes.

## Testing

`src/__tests__/sidebar-sort.test.ts` (pure):

- `cycleFilter` yields `all → started → attention → active → all`.
- `matchesFilter(s, "started")` is `true` for all five `SessionStatus` values.
- `filterShowsGhosts` truth table over 4 filters × 4 group modes: `all` true
  everywhere; `started` true except `stage`; `attention`/`active` false
  everywhere.
- `filterModeLabel("started")` / `filterModeShort("started")`.

`src/__tests__/sidebar.test.ts` (render plan):

- `group=stage` + `started`: stage bands are emitted, every session appears
  (including ones `attention` would drop), no ghost row appears, and a stage
  holding only ghosts emits no band at all.
- `group=project` + `started`: the flat "Up next" ghost band is still emitted —
  the plan is identical to the same fixture under `all`.
- The header chip reads `Started` under the new mode.

## Documentation

- `docs/cheat-sheet.md:48` — the `Ctrl-a f` cycle row gains `Started`.
- `docs/cheat-sheet.md:65` — a `Filter Started` row beside `Filter Needs you`.
- `CLAUDE.md`, the ghost-rows paragraph — it currently states that ghosts are
  "suppressed entirely under a filter (both filters select on agent state)".
  That becomes the two-axis rule, and records why `started` is inert off the
  stage axis and why the toast exists.
