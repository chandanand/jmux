# Issue Tracking & MR Integration

jmux connects to your issue tracker and code host to show issues, merge requests, and pipeline status directly in the terminal. No browser tab required for triage, status updates, or MR approvals.

Currently supported: **Linear** (issue tracking) and **GitLab** (code host / MRs).

---

## Quick Setup

### 1. Set environment variables

```bash
# Linear — either one works
export LINEAR_API_KEY="lin_api_..."
# or
export LINEAR_TOKEN="lin_api_..."

# GitLab — any of these, or glab CLI auth
export GITLAB_TOKEN="glpat-..."
# or
export GITLAB_PRIVATE_TOKEN="glpat-..."
```

### 2. Configure adapters

Add to `~/.config/jmux/config.json` (or press `Ctrl-a I` and navigate to **Integrations**):

```json
{
  "adapters": {
    "codeHost": { "type": "gitlab" },
    "issueTracker": { "type": "linear" }
  }
}
```

### 3. Restart jmux

Adapters authenticate on startup. If auth fails, jmux runs normally without the integration — the panel tabs just won't populate.

---

## The Info Panel

Press `Ctrl-a g` to toggle the info panel. It docks to the right side of the terminal with tabbed views:

| Tab | What it shows |
|-----|---------------|
| **Diff** | hunk diff viewer (same as before — this was the original panel) |
| **Issues** | Your assigned issues from Linear, grouped by team and status |
| **MRs** | Merge requests you authored, with pipeline and approval status |
| **Review** | MRs awaiting your review |

Click the panel or press `Shift-Right` to focus it. Use `[` and `]` to cycle between tabs.

### Navigation

| Key | Action |
|-----|--------|
| `[` / `]` | Cycle tabs |
| `↑` / `↓` | Move selection through items |
| `Enter` | Collapse/expand group headers |
| Mouse wheel | Scroll item list or detail pane |
| Click item | Select it |

### Actions

**On an issue:**

| Key | Action |
|-----|--------|
| `o` | Open in browser |
| `n` | Create a new session from this issue |
| `l` | Link this issue to the current session |
| `s` | Update status (picks from available workflow states) |
| `c` | Copy issue prompt to clipboard (identifier + title + description) |

**On a merge request:**

| Key | Action |
|-----|--------|
| `o` | Open in browser |
| `l` | Link this MR to the current session |
| `a` | Approve the MR |
| `r` | Mark ready (remove Draft prefix) |

### View customization

While focused on an issue or MR tab, you can cycle the view's grouping and sorting:

| Key | Action |
|-----|--------|
| `g` | Cycle group-by: team, project, status, priority, none |
| `G` | Cycle sub-group-by: same options |
| `S` | Cycle sort: priority, updated, created, status |
| `?` | Toggle sort order: ascending / descending |
| `F` | Edit the view's membership filter (states / categories / labels / priority) |
| `/` | Filter the list by typing (transient — not saved) |

`F` is what turns a generic list into a named queue, and it needs no knowledge
of your workspace: the **States** list is pulled live from your tracker, and
**Stages** are jmux's own four. `/` is a throwaway search; `F` is the durable
definition of what belongs in the tab.

Changes persist to `~/.config/jmux/config.json` automatically. Once a view looks
right, **Save current view as tab** in the command palette (`Ctrl-a p`) clones
it under a new name — configuring by demonstration rather than by editing JSON.

---

## Session Linking

jmux automatically links sessions to their issues and MRs using multiple signals:

1. **Branch name** — if your branch is `eng-1234-fix-auth`, jmux finds the Linear issue `ENG-1234`
2. **MR source branch** — the session's git branch is matched to an open MR
3. **MR-to-issue links** — if the MR links to a Linear issue (via Linear attachments), jmux follows it
4. **Transitive links** — if an issue has MR URLs in its attachments, jmux resolves those too
5. **Manual links** — press `l` in the panel or use the command palette to explicitly link items

Linked items show in the sidebar on a third row beneath the branch name:

```
  ● api-server        ✓  3w
    feature-auth
    ENG-1234           1M
```

The `✓` is the pipeline status glyph, `ENG-1234` is the linked issue, and `1M` means one linked merge request.

### Manual linking from the command palette

Press `Ctrl-a p` and search for:
- **"Link issue"** — fuzzy search Linear issues and link one to the current session
- **"Link MR"** — fuzzy search MRs and link one to the current session
- **"Unlink issue"** / **"Unlink MR"** — remove a manual link

Manual links are stored in `~/.config/jmux/state.json` and survive restarts.

---

## Issue-to-Session Workflow

The most powerful feature: select an issue in the panel and press `n` to create a fully provisioned session.

### What happens

1. jmux looks up the issue's team in your `teamRepoMap` config to find the repository
2. Creates a git worktree (or branch) from your configured base branch
3. Creates a new tmux session in that worktree
4. Links the session to the issue
5. Optionally launches Claude Code with the issue's title and description as context

### Configuration

```json
{
  "issueWorkflow": {
    "teamRepoMap": {
      "Platform": "~/repos/backend",
      "Frontend": "~/repos/frontend",
      "Mobile": "~/repos/mobile-app"
    }
  },
  "repoDefaults": {
    "defaultBaseBranch": "main",
    "wtmIntegration": true,
    "autoLaunchAgent": true,
    "sessionNameTemplate": "{identifier}",
    "claudeCommand": "claude"
  }
}
```

| Key | Tier | Default | Description |
|-----|------|---------|-------------|
| `teamRepoMap` | global | `{}` | Maps Linear team names to local repo directories |
| `defaultBaseBranch` | per-repo | `"main"` | Branch to create worktrees from |
| `wtmIntegration` | per-repo | bare-repo detection | `true` → `wtm create`; `false` → `git worktree add` |
| `autoLaunchAgent` | per-repo | `true` | Launch Claude Code with issue context |
| `sessionNameTemplate` | per-repo | `"{identifier}"` | Template for session names. Supports `{identifier}` and `{title}` |
| `claudeCommand` | per-repo | `"claude"` | Command used to launch the agent |

Per-repo keys go in `repoDefaults` (global default) and may be overridden per
repo under `repos` — see [Configuration](configuration.md). Every issue always
gets a worktree; `wtmIntegration` only picks the mechanism. The old
`autoCreateWorktree` toggle was removed because it could never be turned off.

### Team-to-repo mapping

The `teamRepoMap` is what enables the automated flow. Without it, pressing `n` on an issue opens the standard new-session modal where you pick a directory manually.

Configure it in settings (`Ctrl-a I` > **Repo** > **Team → repo mappings**) or edit the config file directly. The inline picker shows your project directories for quick selection.

### Three-state workflow

Issues in the panel show their session state:

| State | Meaning | Action on `n` |
|-------|---------|---------------|
| No session | No worktree or session exists | Creates worktree + session + launches agent |
| Worktree exists | Worktree on disk but no tmux session | Creates session in existing worktree |
| Session exists | Tmux session is running | Switches to that session |

---

## Polling & Rate Limits

jmux polls adapters on a tiered schedule to stay responsive without hammering APIs:

| Tier | Interval | What's polled |
|------|----------|---------------|
| Active session | 20 seconds | MRs and issues linked to the focused session |
| Background sessions | 3 minutes | MRs and issues for all other sessions |
| Global data | 5 minutes | Your full issue list and MR lists |

If jmux detects a rate limit (HTTP 429), it backs off:
- Active polling slows to 60 seconds
- Background and global polling pause entirely
- Normal polling resumes automatically when the limit clears

Auth failures (401/403) disable the affected adapter until jmux restarts.

---

## Pipeline Status

When a session has a linked MR with a CI pipeline, the sidebar shows a glyph:

| Glyph | Color | Meaning |
|-------|-------|---------|
| `✓` | Green | Pipeline passed |
| `⟳` | Yellow | Pipeline running |
| `✗` | Red | Pipeline failed |
| `◆` | Purple | MR merged |
| `—` | Dim | Pipeline canceled |

If a session has multiple MRs, the worst status wins (failed > running > pending > passed).

---

## Custom Panel Views

The default tabs (Issues, MRs, Review) can be customized via `panelViews` in config:

```json
{
  "panelViews": [
    {
      "id": "my-issues",
      "label": "Issues",
      "source": "issues",
      "filter": { "scope": "assigned" },
      "groupBy": "team",
      "subGroupBy": "status",
      "sortBy": "priority",
      "sortOrder": "asc",
      "sessionLinkedFirst": true
    },
    {
      "id": "my-mrs",
      "label": "MRs",
      "source": "mrs",
      "filter": { "scope": "authored" },
      "groupBy": "none",
      "sortBy": "updated",
      "sortOrder": "desc"
    },
    {
      "id": "review",
      "label": "Review",
      "source": "mrs",
      "filter": { "scope": "reviewing" },
      "groupBy": "none",
      "sortBy": "updated",
      "sortOrder": "desc"
    }
  ]
}
```

**View options:**

| Field | Values | Description |
|-------|--------|-------------|
| `source` | `"issues"`, `"mrs"` | Data source |
| `filter.scope` | `"assigned"`, `"authored"`, `"reviewing"` | Which items to show |
| `groupBy` | `"team"`, `"project"`, `"status"`, `"priority"`, `"none"` | Primary grouping |
| `subGroupBy` | Same as `groupBy` | Secondary grouping within groups |
| `sortBy` | `"priority"`, `"updated"`, `"created"`, `"status"` | Sort field |
| `sortOrder` | `"asc"`, `"desc"` | Sort direction |
| `sessionLinkedFirst` | `true`, `false` | Float items linked to the current session to the top |

---

## Authentication

### Linear

Set one of these environment variables:

| Variable | Description |
|----------|-------------|
| `LINEAR_API_KEY` | Personal API key from Linear Settings > API |
| `LINEAR_TOKEN` | Same — either name works |

Generate a key at [linear.app/settings/api](https://linear.app/settings/api).

### GitLab

Set one of these, or authenticate via `glab`:

| Variable | Description |
|----------|-------------|
| `GITLAB_TOKEN` | Personal access token with `api` scope |
| `GITLAB_PRIVATE_TOKEN` | Same — either name works |
| `GITLAB_PERSONAL_ACCESS_TOKEN` | Same — either name works |

If no env var is set, jmux falls back to `glab auth status` to extract a token from the GitLab CLI.

For self-hosted GitLab, add a `url` field to the adapter config:

```json
{
  "adapters": {
    "codeHost": {
      "type": "gitlab",
      "url": "https://gitlab.yourcompany.com/api/v4"
    }
  }
}
```

### Auth status

The sidebar and panel show auth state. If authentication fails, jmux logs the error and continues without the integration. Check `~/.config/jmux/jmux.log` for details.

---

## The Work Pipeline

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
*sessions* in the sidebar (`Ctrl-a G` → `Stage`), not just your issues.

Every status then has exactly two settings and no more:

```
which stage it belongs to  —  where it shows in the panel, and which
                              sidebar group its session lands in
whether it parks           —  whether its session leaves the sidebar
```

Both are independent, so a status can park while belonging to no stage at all —
which is the right answer for something like **Done**.

### The workflow screen (`Ctrl-a W`)

Press `Ctrl-a W` (also: `Ctrl-a I` → **Workflow**, or "Configure workflow" in
the palette). It is two blocks: your stages, then a table of every status your
tracker offers.

```
Workflow                                    Linear · 25 statuses · 9 unmapped

  Your workflow ────────────────────────────────────────────────────────
    Urgent ····································· 1st up next  2 statuses
    To do ······································ 2nd up next  3 statuses
    In Progress ············································· 3 statuses
    Waiting ············································ ⏸ 8  8 statuses
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

Every row in the table is the same kind of thing and takes the same keys. The
line above the keys says what the row under the cursor **will actually do**,
including when it will do nothing.

| Key | In **Statuses** | In **Your workflow** | On a setting |
|-----|-----------------|----------------------|--------------|
| `↑` `↓` | move the cursor | | |
| `Enter` | choose its stage | rename the stage | edit |
| `space` | park / don't park | — | — |
| `u` | — | add to / drop from the `Ctrl-a u` rotation | — |
| `d` | take it out of its stage | delete the stage (asks first) | clear a repo override |
| `⇧↑` `⇧↓` | reorder within its stage | reorder the stage | — |
| `g` | | | switch between this repo and the global defaults |
| `Esc` | close | | |

Order is priority order, top to bottom, for both stages and the statuses inside
one. The order you add stages with `u` is the order `Ctrl-a u` checks them.

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

### Your stages in the sidebar

The panel groups your *issues* by stage. `Ctrl-a G` cycles the sidebar's
grouping axis on to `Stage` and groups your *sessions* the same way — so the
left rail reads as your pipeline, with the work in progress under `In Progress`
and the handed-off work under `Waiting`:

```
  ⊞ Stage  ⇅ Name

  URGENT (1)
    TRA-1387 · payment-retry

  IN PROGRESS (2)
    TRA-1402 · search-index
    TRA-1399 · session-replay

  jmux
  dotfiles
```

A session lands in the stage that claims its linked issue's status. Headers come
out in your own stage order, not alphabetically — `Urgent` is above `In Progress`
because that is where you put it in `Ctrl-a W`.

Sessions with no linked issue (`jmux`, `dotfiles` above), or whose status no
stage claims, list flat below the groups rather than under a "no stage" header:
grouping should not give the work you have *not* classified a heading of its own,
above the work you have. Pinned sessions still float to the top and parked ones
still sink to the bottom band, in this mode as in every other.

With no tracker connected, or before the first poll returns, no session resolves
to a stage and the mode is simply a flat list.

### Tracker categories

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

### Parking (the back burner)

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

`Ctrl-a p` → **Park session** / **Unpark session** overrides the derived
answer for sessions with no issue, or when you disagree with your tracker. An
override is remembered against the stage it was made at and drops once the
issue moves on, so it can't silently suppress parking forever.

Sessions with no linked issue can auto-park on idleness instead
(`pipeline.autoParkIdleDays`).

### Capture (`Ctrl-a a`)

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

### Queues and Up next (`Ctrl-a u`)

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

**You don't have to write that by hand.** `Ctrl-a W` lists every status in a
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
/ `/` / `?` keys and then run **Save current view as tab** from the palette.

`pipeline.upNext` is an ordered list of stage ids. `Ctrl-a u` takes the first item
from the first non-empty stage in that order and starts work on it, so the daily
ritual is one keystroke. Press `u` on a stage in the workflow screen to add or
remove it; the order you add them is the order they are checked, and each stage
shows its place (`1st up next`).

### Transitions (writes to your tracker)

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
| `undo-toast` (default) | Writes, then shows `TRA-123 → QA  ^a Z undo` in the toolbar for 20s |
| `always` | Asks before every write |
| `never` | Writes silently |

`Ctrl-a Z` takes the last write back while the toast is up.

---

## Settings Reference

The pipeline — your stages, their statuses, parking, up next and tracker writes —
is configured on the workflow screen (`Ctrl-a W`). Everything else lives in the
settings screen (`Ctrl-a I` — capital I) under **Display**, **Integrations**,
**Repo**, **Project** and **This repo**. Both write to
`~/.config/jmux/config.json`:

```json
{
  "adapters": {
    "codeHost": { "type": "gitlab" },
    "issueTracker": { "type": "linear" }
  },
  "issueWorkflow": {
    "teamRepoMap": { "Platform": "~/repos/backend" }
  },
  "repoDefaults": {
    "defaultBaseBranch": "main",
    "autoLaunchAgent": true,
    "sessionNameTemplate": "{identifier}",
    "claudeCommand": "claude",
    "onMrMergedState": "QA"
  },
  "pipeline": {
    "parkedStates": ["QA (PROD WEB)", "MR Review"],
    "unparkOn": ["state-regression", "issue-comment", "mr-activity", "pipeline-failed"],
    "autoParkIdleDays": 2,
    "transitionConfirm": "undo-toast",
    "upNext": ["urgent", "todo"]
  },
  "panelViews": []
}
```

Settings are hot-reloaded — changes take effect without restarting jmux.
