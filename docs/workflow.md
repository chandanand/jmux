# Your Workflow

Everything on this page needs a connected issue tracker — see
[Connecting](connecting.md). What the info panel *is* and how to drive it is in
[Issue tracking](issue-tracking.md); this page is about bending it to the way
you actually work.

---

## The work pipeline

Your tracker has a lot of statuses. Ours has 25 — `QA (PRE-RELEASE WEB)`,
`Promote (RELEASE BR)`, `Need ANDR Build` — most of them shared across teams and
named for someone else's process. You do not think in 25 states. You think in
four or five.

So jmux has you **define your own workflow stages**, and sit each one on top of
one or many of your tracker's statuses:

```
        your stages                    your tracker's statuses

        Urgent        ───────────────  Release Blockers, QA Failed
        To do         ───────────────  To do, Dev Confirm (PRE-RELEASE)
        In Progress   ───────────────  In Progress, In Review, MR Review
        Waiting       ───────────────  QA (PRE-RELEASE WEB), QA (RELEASE BR),
                                       QA PASS, Need ANDR Build,  …
```

A stage shows up as a tab in the info panel, but that is how it *appears*, not
what it *is*. It is one rung on the ladder you actually work by, and its order
in the list is its priority — which is why the same stages also group your
*sessions* in the sidebar (`Ctrl-Space G` → `Stage`), not just your issues.

Every status then has exactly two settings and no more:

```
which stage it belongs to  —  where it shows in the panel, and which
                              sidebar group its session lands in
whether it parks           —  whether its session leaves the sidebar
```

Both are independent, so a status can park while belonging to no stage at all —
which is the right answer for something like **Done**.

---

## The workflow screen (`Ctrl-Space W`)

Press `Ctrl-Space W` (also: `Ctrl-Space I` → **Workflow**, or "Configure workflow" in
the palette). It is two blocks: your stages, then a table of every status your
tracker offers.

```
Workflow                                    Linear · 25 statuses · 9 unmapped

  Your workflow ────────────────────────────────────────────────────────
    Urgent ····································· 1st up next  2 statuses
    To do ······································ 2nd up next  3 statuses
    In Progress ············································· 3 statuses
    Waiting ······································ no unstarted  ⏸ 8  8 statuses
    Done ··················································· hidden  1 status
    + New stage

  Statuses ─────────────────────────────────────────────────────────────
    Status                     Stage                     Parks  Issues
    Release Blockers           Urgent                                0
    To do                      To do                                 5
    In Progress                In Progress                           9
    QA (PRE-RELEASE WEB)       Waiting                     ⏸        19
    QA (RELEASE BR)            Waiting                     ⏸         8
    Backlog                    —                                     5

  QA (RELEASE BR) · 8 issues · Waiting · parks its sessions (3 now)
  ↑↓ move · ↵ stage · space parks · d remove · ⇧↑↓ order · esc close
```

On a stage row the keys and the explain line change to match:

```
  Waiting · 4th of 5 · 8 statuses · 61 issues · in the sidebar, without its
  unstarted work · not in Up next
  ↑↓ move · ⇧↑↓ order · ↵ rename · s hide · space unstarted · u up next · d delete
```

Every row in the table is the same kind of thing and takes the same keys. The
line above the keys says what the row under the cursor **will actually do**,
including when it will do nothing.

| Key | In **Statuses** | In **Your workflow** | On a setting |
|-----|-----------------|----------------------|--------------|
| `↑` `↓` | move the cursor | | |
| `Enter` | choose its stage | rename the stage | edit |
| `space` | park / don't park | show / hide its unstarted work | — |
| `s` | — | show / hide the stage in the sidebar | — |
| `u` | — | add to / drop from the `Ctrl-Space u` rotation | — |
| `d` | take it out of its stage | delete the stage (asks first) | clear a repo override |
| `⇧↑` `⇧↓` | reorder within its stage | reorder the stage | — |
| `◂` `▸` | — | — | step a counted value (e.g. how many unstarted) |
| `g` | | | switch between this repo and the global defaults |
| `Esc` | close | | |

Order is priority order, top to bottom, for both stages and the statuses inside
one. The order you add stages with `u` is the order `Ctrl-Space u` checks them.

A stage row only reports a sidebar setting when it is *off* its default, which is
why most rows above say nothing about it: `hidden` (no band at all) or
`no unstarted` (band, but no unstarted rows under it). See
[Unstarted work in the sidebar](#unstarted-work-in-the-sidebar).

**Starting from scratch?** With nothing configured the first row offers
**⚑ Suggest a starting layout**, which builds `To do` / `In progress` / `Done`
stages from your tracker's own categories and leaves anything you already have
alone. Nothing it creates parks; that stays a decision you make.

Merge-request tabs (`source: "mrs"`) are listed in the first block too, marked
*not a stage* — they are panel tabs with no statuses to map. The screen shows
them so it matches the panel's tab bar rather than pretending they don't exist.

### Subheadings in the panel

A stage holding more than one status groups its issues under those status names,
with a count each:

```
▾ QA (PRE-RELEASE WEB) (19)
    TRA-1241  Dashboard POC (baseline qa Diana)
    …
▾ QA (RELEASE BR) (8)
    …
```

A stage holding a single status draws no subheading at all — the tab already
names it, and a heading repeating it would be a row that says nothing.

There is nothing to configure here. There used to be a **Heading** you named by
hand, so that several statuses could share one; in practice its name only ever
restated the status inside it, which is one more thing to name, maintain and get
wrong for a result the status names already give you.

---

## Your stages in the sidebar

The panel groups your *issues* by stage. `Ctrl-Space G` cycles the sidebar's
grouping axis on to `Stage` and groups your *sessions* the same way — so the
left rail reads as your pipeline, with the work in progress under `In Progress`
and the handed-off work under `Waiting`:

```
  ⊞ Stage  ⇅ Name

  URGENT (1)
    Retry the payment webhook on 5xx
    TRA-1387

  IN PROGRESS (2)
    Rebuild the search index
    TRA-1402
    Rebuild the session replay index
    TRA-1399

  jmux
  dotfiles
```

(Row 1 is each session's generated title, or its plain name where there is no
`sessionTitle.command` — see [Session titles](configuration.md#session-titles-sessiontitle).
Row 2 would normally carry the stage word after the badge; under `Stage`
grouping the header already says it, so those columns go back to the row.)

A session lands in the stage that claims its linked issue's status. Headers come
out in your own stage order, not alphabetically — `Urgent` is above `In Progress`
because that is where you put it in `Ctrl-Space W`.

Sessions with no linked issue (`jmux`, `dotfiles` above), or whose status no
stage claims, list flat below the groups rather than under a "no stage" header:
grouping should not give the work you have *not* classified a heading of its own,
above the work you have. Pinned sessions still float to the top and parked ones
still sink to the bottom band, in this mode as in every other.

With no tracker connected, or before the first poll returns, no session resolves
to a stage and the mode is simply a flat list.

---

## Where a session sits, on every grouping axis

Stage bands only exist under `Stage` grouping. So that a session says where it
sits no matter how the sidebar is grouped, its second row — right after the
issue badge that leads it — carries the stage its issue is in:

```
  ▶ auth-refactor
    TRA-123 · Review    !88 ✓
```

That is your **stage** label, not the raw tracker status — the word you chose in
`Ctrl-Space W`. Two statuses in the same stage read the same here; press `Ctrl-Space e`
and each disclosed row spells its own status out. A status that no stage claims
has nothing to abbreviate to, so it prints as-is.

The issue badge to its left always keeps its space, and the right-hand cluster
claims what it needs before the field does. Narrow the sidebar and the field
is squeezed first: the stage word gives way to a one-character glyph, then
disappears, while the timer, the MR id and the rest of that cluster are still
there.

**Grouped by `Stage`, the word goes away** — the band header above the row
already says it, and a row reading `Review` under a `REVIEW` header is six
columns the row's other fields could use instead. It comes back for any
session the header does *not* speak for: pinned ones, parked ones, and any
whose stage draws no band.

---

## When the status stops being true

jmux moves your issues on *events* — a session starts, an MR opens, an MR merges
(see [Transitions](#transitions-writes-to-your-tracker)). Firing on events and
never on conditions is what keeps it from rewriting history: attaching to a
six-month-old session must not replay six months of moves into your tracker.

The cost is that a missed event stays missed. jmux restarted while the MR was
merging, the write failed, you linked the issue afterwards — the ticket now says
one thing and your branch says another, forever.

So the same field reports it:

```
  ▶ auth-refactor    TRA-123
    Review→Done  !88 ✓
```

That reads: the MR is merged, your `MR merged` transition says such issues
belong in `Done`, and this one never got there. Grouped by `Stage` it shortens
to just `→Done`, since the header already told you where the ticket is — the
disagreement is about where it should be, which no header carries.
**`Ctrl-Space m` moves it**, with `Ctrl-Space Z` to take it back. Several issues on one session all move together —
each to whatever *its* repo's transition configures, since hand-linked issues
can come from teams that map elsewhere.

Three things it will not do:

- **Flag a ticket you moved past the target.** "Behind" means behind in the
  stage order you arranged in `Ctrl-Space W`, so a ticket in `Released` is not
  behind `Done`.
- **Guess without an ordering.** No configured transition, or a status that no
  stage claims, and jmux says nothing rather than inventing a comparison.
  Settings → Diagnostics → *Drift detection* tells you when that is why the
  feature is quiet.
- **Write anything by itself.** The marker is a report. Only `Ctrl-Space m` writes,
  and because you asked for it, your transition-confirmation setting does not
  gate it.

Expanding a session (`Ctrl-Space e`) marks *every* drifting issue it carries, not
just the one the badge names.

---

## Unstarted work in the sidebar

The sidebar otherwise shows only what exists. Turn this on and it also shows the
work sitting in each stage that **nobody has picked up** — issues with no session
— as dimmed rows you can click to start:

```
  ⊞ Stage  ⇅ Name

  URGENT (2)
  ● Retry the payment webhook on 5xx
    TRA-1387
  ○ Retry storms on the payment webhook
    TRA-1402

  IN PROGRESS (1)
  ● Rebuild the session replay index
    TRA-1399

  IN REVIEW (1)
  ○ Cursor pagination for /events
    TRA-1355
```

A hollow `○` where a live session carries its filled activity dot. The row uses a
session row's exact two-row shape — the issue title where a live session's name
or generated title goes, the identifier where its issue badge goes — because that
is the row it turns into. Starting one leaves the identifier exactly where it was
and replaces the line above it with the model's phrase for the work.

**Clicking one previews it** — it does not start anything. The main area is
replaced by the issue and, above the description, exactly what starting it would
do:

```
  ENG-1255

  ENG-1255 Add audit log for admin actions
  Status: Todo   Priority: P3
  Assignee: Jarred Kenny
  Team: Platform

  Starting will create
    session  eng-1255-add-audit-log
    worktree ~/Code/tracktile/eng-1255-add-audit-log
    branch   eng-1255-add-audit-log (from main)
    tool     wtm create
    agent    claude

  Description:
  Compliance requires an immutable audit trail for all admin actions…

  [↵] Start  [s] Status  [o] Open  [Esc] Back
```

`↵` runs the same flow as `n` in the issues panel: worktree, session, agent,
issue linked. If a worktree already exists from an earlier attempt it is reused
rather than recreated, and the action reads **Resume**; if a session already
claims the issue it reads **Switch**. When the issue's team maps to no repo the
pre-flight says so, and `↵` opens the manual session picker instead.

`s` changes the issue's status without starting anything — which is also how you
park it, since parking is a status. The row re-bands or disappears on its own.

`Esc` returns you to whatever you were doing; the session underneath was never
touched. `Ctrl-Space u` still starts the top item of your first non-empty queue in
one gesture, without previewing — it is an explicit start command, and what
changed here is only that *selecting* a row no longer provisions.

Unstarted rows are also reachable from the keyboard: `Ctrl-Shift-Up` /
`Ctrl-Shift-Down` walk them alongside your sessions, so you can read down your
backlog without touching the mouse.

Work started by an agent counts as started. `jmux ctl issue start` provisions
exactly what `↵` here would — same session name, same worktree, same tool — and
records its link where the sidebar reads it, so an issue an agent picked up stops
being offered as unstarted rather than being offered twice.

Note `IN REVIEW` above: a stage with no sessions still gets a band when it has
unstarted work. And a stage whose work is all in flight simply shows no `○` rows.

**Turn it on** in `Ctrl-Space W` under **Unstarted work**:

```
  Unstarted work ───────────────────────────────────────────────────────
    Show unstarted work in the sidebar ······················ ◂ 3 per stage ▸

  Top 3 unstarted issues in each stage, under its own band. 1 stage opted out
  (space above).
  ↑↓ move · ◂▸ change · ↵ edit · esc close
```

Off by default — the sidebar is otherwise a truthful mirror of tmux, and rows for
sessions that don't exist are something you opt into. `◂` `▸` walk
`never → 1 → 2 … → 99 → all` and wrap, so `all` is one press left of `never`;
`Enter` takes a typed number for anything else. The count is **per stage**, so
`3` with four stages showing is up to twelve rows.

Done and cancelled issues never appear. Nothing gives a completed issue a
session, so those rows would pile up under a `Done` stage with no way to clear
them. Parked statuses are left out for the same reason.

### Which stages participate

Two keys on any stage row in **Your workflow**:

| Key | Setting | Effect when off |
|-----|---------|-----------------|
| `s` | show the stage in the sidebar | no band; its sessions fall to the flat list at the bottom |
| `space` | show its unstarted work | band and sessions stay; no `○` rows |

Both are on for every stage until you say otherwise, and hiding a stage hides its
**heading, never its sessions** — a stage setting must not be able to make an
agent that is waiting on you disappear from the one surface always on screen.
They land under that stage's own row in `panelViews`:

```json
{ "id": "done", "label": "Done", "source": "issues",
  "states": ["Done", "Cancelled"],
  "inSidebar": false }
```

Only `false` is ever written, so a stage you have never touched stays exactly as
it was in your config.

The count is the master switch and the per-stage keys are exceptions to it. With
the count off, a stage row says **off globally** and names the setting rather
than reporting a preference that currently does nothing — and your per-stage
choices are kept, not cleared, so switching the count back on restores them.

### Grouped by something other than stage

Stage bands only exist under `Ctrl-Space G` → `Stage`. On the other axes an issue
with no session has no project, no agent state and no activity to sort under, so
the rows collect into a single **Up next** band above `Parked`, fed by the stages
you marked with `u` for the `Ctrl-Space u` rotation — minus any that opted out above,
so a stage you switched off cannot come back through the other placement:

```
  jmux
  ● Rebuild the session replay index
    TRA-1399

  Up next ───────────────
  ○ Retry storms on the payment webhook
    TRA-1402

  Parked ─────────────(8)
```

Ghost rows behave the same in both placements: clicking one previews it, and
`Ctrl-Shift-↑`/`↓` walks it alongside your sessions.

`Ctrl-Space f` hides them, and which mode does depends on the axis:

| Filter | Effect on unstarted rows |
|--------|--------------------------|
| `Started` | Hidden under `Stage`, where they sit inside every band. Left alone on the other axes, where they are already gathered into one `Up next` band at the bottom — so on those axes the mode is the same as `All`, and jmux says so when you choose it. |
| `Needs you`, `Active` | Hidden on every axis. Both select on agent state, which unstarted work does not have, so it can neither match one nor be honestly excluded by one. |

`Started` is the one to reach for when you want the stage layout of the work that
exists: every session, including the idle ones the other two filters drop.

---

## Tracker categories

Separately from your stages, jmux keeps a four-value view of where a status sits
in *any* tracker's lifecycle. You never author it — it is read from your
tracker's own state types:

| Category | Where it comes from |
|----------|---------------------|
| `idea` | your tracker's `triage` / `backlog` states |
| `active` | your tracker's `unstarted` / `started` states |
| `done` | your tracker's `completed` / `canceled` / `duplicate` states |
| `parked` | the **Parks** column — the one you do control |

This is what makes a shipped default mean something in a workspace jmux has
never seen. Nothing reaches `parked` except a status you ticked, so an
unconfigured jmux never hides anything.

> **Naming wart:** the config key for this is `panelViews[].filter.stages`, from
> before "stage" came to mean *your* workflow stages. The key is unchanged so
> existing configs keep working; read it as "categories".

A stage with statuses is governed entirely by them: a `states` filter set from
the panel's `F` menu is ignored for it, and `F` says so rather than offering a
control that does nothing.

---

## Parking (the back burner)

Work that is merged and sitting in QA still owns a session you might need
again, but it should not take up sidebar space. Tick the **Parks** column for
that status, and any session whose issue reaches it collapses into a single
`Parked (n)` row at the bottom of the sidebar. The session, its worktree and
its scrollback are all untouched.

One tick, in one place. There used to be a second setting listing "the stages
that park", which could be switched off independently — so parking could look
configured and do nothing, and the half-set state was indistinguishable from a
broken feature.

Parking is only safe because it reverses itself. Any configured signal pulls a
session straight back out, flagged:

| Trigger | Fires when |
|---------|-----------|
| the issue moves | Its stage changes — this is your **QA Failed** case |
| someone comments | A new comment lands on the issue |
| the MR is touched | Comment, push or review |
| a pipeline goes red | CI fails |
| the agent wants you | The agent in that session is waiting on you |

`Ctrl-Space p` → **Park session** / **Unpark session** overrides the derived
answer for sessions with no issue, or when you disagree with your tracker. An
override is remembered against the stage it was made at and drops once the
issue moves on, so it can't silently suppress parking forever.

Sessions with no linked issue can auto-park on idleness instead
(`pipeline.autoParkIdleDays`).

---

## Capture (`Ctrl-Space a`)

One composer, two commit keys:

| Key | Action |
|-----|--------|
| `Enter` | File the issue and stay where you are |
| `Ctrl-S` | File it, create the worktree + session, and launch the agent on it |
| `Tab` | Move between title / team / description |

Agents can file issues themselves without any UI at all:

```bash
jmux ctl issue create --title "Auth times out on cold start" \
  --description "Noticed while working TRA-1200" --team Platform
jmux ctl issue create --title "Fix flaky test" --start   # capture and start
```

---

## Queues and Up next (`Ctrl-Space u`)

Tabs are an attention model — **Urgent / To do / In Progress / Waiting** — and
what varies per workspace is which of *your* tracker states roll up into each. A
stage carries an ordered `states` list; which of its statuses park is a separate
list under `pipeline`:

```json
{ "id": "waiting", "label": "Waiting", "source": "issues",
  "filter": { "scope": "assigned" },
  "states": ["QA (PROD WEB)", "QA (RELEASE BR)", "Need ANDR Build"] }
```

When `states` is present it drives **both** membership and the panel's
subheadings, and `groupBy` is ignored. Config order is priority order — rendered
verbatim rather than sorted. A status the stage does not list is not in it at all.

**You don't have to write that by hand.** `Ctrl-Space W` lists every status in a
table with its stage beside it. Assigning a status moves it out of wherever it
was, so a status has exactly one home. Stages show live counts (`Urgent 3`), so
"is anything urgent?" never requires switching tabs.

Panel views can be narrowed into named pull queues:

```json
{
  "id": "qa-failed", "label": "QA Failed", "source": "issues",
  "filter": { "scope": "assigned", "states": ["QA Failed"] },
  "groupBy": "none", "subGroupBy": "none", "sortBy": "priority", "sortOrder": "asc"
}
```

| Filter key | Meaning |
|-----------|---------|
| `states` | Raw tracker state names (case-insensitive) |
| `stages` | Tracker categories (`idea`/`active`/`parked`/`done`) — tracker-agnostic |
| `labels` | Any matching label name |
| `priorityAtMost` | Keep issues at least this urgent (1=urgent … 4=low) |

Rather than writing that by hand, shape a view live with the panel's `g` / `G`
/ `/` / `?` keys and then run **Save current view as tab** from the palette —
see [View customization](issue-tracking.md#view-customization).

`pipeline.upNext` is an ordered list of stage ids. `Ctrl-Space u` takes the first item
from the first non-empty stage in that order and starts work on it, so the daily
ritual is one keystroke. Press `u` on a stage in the workflow screen to add or
remove it; the order you add them is the order they are checked, and each stage
shows its place (`1st up next`).

---

## Transitions (writes to your tracker)

jmux can move an issue along as a byproduct of what you already did:

| Event | Setting |
|-------|---------|
| Session created from an issue | `onSessionStartState` |
| An MR appears on the session's branch | `onMrOpenState` |
| That MR merges | `onMrMergedState` |

All default to `null` — **jmux never writes to your tracker until you set
these.** They are per-repo, since they name states; the workflow screen shows
the value in force for the repo you are sitting in, and `g` switches to the
global defaults. Every transition is an
*edge*: an MR that was already merged the first time jmux sees it never fires,
so attaching to an old session cannot replay history into your tracker.

`pipeline.transitionConfirm` controls how much ceremony a write gets:

| Mode | Behaviour |
|------|-----------|
| `undo-toast` (default) | Writes, then shows `TRA-123 → QA  ^Space Z undo` in the toolbar for 20s |
| `always` | Asks before every write |
| `never` | Writes silently |

`Ctrl-Space Z` takes the last write back while the toast is up.

---

## Pipeline settings reference

The pipeline is configured on the workflow screen (`Ctrl-Space W`), which writes
these keys to `~/.config/jmux/config.json`:

```json
{
  "repoDefaults": {
    "onSessionStartState": null,
    "onMrOpenState": null,
    "onMrMergedState": "QA"
  },
  "pipeline": {
    "parkedStates": ["QA (PROD WEB)", "MR Review"],
    "unparkOn": ["state-regression", "issue-comment", "mr-activity", "pipeline-failed"],
    "autoParkIdleDays": 2,
    "transitionConfirm": "undo-toast",
    "upNext": ["urgent", "todo"],
    "showUnstartedInSidebar": 3
  },
  "panelViews": []
}
```

`showUnstartedInSidebar` is a count *per stage*, `"all"`, or `null` for off (the
default). It is stored as the literal `"all"` rather than a number, because
`Infinity` does not survive a JSON round-trip — it is written as `null`, which is
this field's "off". Per-stage exceptions live on the stage itself
(`inSidebar` / `showUnstarted`); see
[Which stages participate](#which-stages-participate).

Every key here hot-reloads — edit the file and the change lands without a
restart. (The one setting that doesn't is `adapters`; see
[Connecting](connecting.md#3-restart-jmux).)
