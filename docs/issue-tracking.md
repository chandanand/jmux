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

Add to `~/.config/jmux/config.json` (or press `Ctrl-a i` and navigate to **Integrations**):

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
| `/` | Cycle sort: priority, updated, created, status |
| `?` | Toggle sort order: ascending / descending |

Changes persist to `~/.config/jmux/config.json` automatically.

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

Configure it in settings (`Ctrl-a i` > **Issue Workflow** > **Team -> repo mappings**) or edit the config file directly. The inline picker shows your project directories for quick selection.

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

jmux projects your tracker's own workflow states onto four **stages**, and
behaves differently for each. Stages drive behaviour; the raw state name is
what you actually see on screen.

| Stage | Behaviour |
|-------|-----------|
| `idea` | Captured, not started — absent from the sidebar |
| `active` | Normal sidebar row |
| `parked` | Handed off — collapsed into one row at the bottom |
| `done` | Finished |

With no configuration, stages come from the tracker's own category
(`triage`/`backlog` → idea, `unstarted`/`started` → active,
`completed`/`canceled` → done). **Nothing maps to `parked` by default**, so
parking is inert until you opt in. Name the states that diverge under
**Settings → Stages** (or `repoDefaults.parkedStates` etc.) — these are
per-repo, because repos differ in workflow vocabulary.

### Parking (the back burner)

Work that is merged and sitting in QA still owns a session you might need
again, but it should not take up sidebar space. Set **Park stages** to
`parked` and any session whose issue reaches a parked state collapses into a
single `Parked (n)` row at the bottom of the sidebar. The session, its
worktree and its scrollback are all untouched.

Parking is only safe because it reverses itself. Any configured signal pulls a
session straight back out, flagged:

| Trigger | Fires when |
|---------|-----------|
| `state-regression` | The issue's stage changes — this is your **QA Failed** case |
| `issue-comment` | A new comment lands on the issue |
| `mr-activity` | The MR is touched (comment, push, review) |
| `pipeline-failed` | A pipeline goes red |
| `agent-attention` | The agent in that session wants you |

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
| `stages` | Lifecycle stages — tracker-agnostic |
| `labels` | Any matching label name |
| `priorityAtMost` | Keep issues at least this urgent (1=urgent … 4=low) |

Rather than writing that by hand, shape a view live with the panel's `g` / `G`
/ `/` / `?` keys and then run **Save current view as tab** from the palette.

`pipeline.upNext` is an ordered list of view ids. `Ctrl-a u` takes the first
item from the first non-empty queue and starts work on it, so the daily ritual
is one keystroke.

### Transitions (writes to your tracker)

jmux can move an issue along as a byproduct of what you already did:

| Event | Setting |
|-------|---------|
| Session created from an issue | `onSessionStartState` |
| An MR appears on the session's branch | `onMrOpenState` |
| That MR merges | `onMrMergedState` |

All default to `null` — **jmux never writes to your tracker until you set
these.** They are per-repo, since they name states. Every transition is an
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

All issue tracking settings are available in the settings screen (`Ctrl-a i`) under **Integrations**, **Issue Workflow**, **Pipeline**, **Stages**, **Transitions** and **This repo**, or in `~/.config/jmux/config.json`:

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
    "parkedStates": ["In Review", "QA"],
    "onMrMergedState": "QA"
  },
  "pipeline": {
    "parkStages": ["parked"],
    "unparkOn": ["state-regression", "issue-comment", "mr-activity", "pipeline-failed"],
    "transitionConfirm": "undo-toast",
    "upNext": ["release-blockers", "qa-failed", "todo"]
  },
  "panelViews": []
}
```

Settings are hot-reloaded — changes take effect without restarting jmux.
