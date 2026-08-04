# Issue Tracking & MR Integration

jmux connects to your issue tracker and code host to show issues, merge requests,
and pipeline status directly in the terminal. No browser tab required for triage,
status updates, or MR approvals.

**Issue tracker:** Linear. **Code host:** GitLab or GitHub (including self-hosted
GitLab and GitHub Enterprise Server).

> **Setup lives on its own page.** Tokens, adapter config, and what to do when a
> tab doesn't appear are all in **[Connecting](connecting.md)**. This page
> assumes it's already working. Shaping the panel around your own process —
> stages, parking, `Ctrl-a u`, status writes — is in **[Workflow](workflow.md)**.
>
> No credentials yet? `jmux --demo` runs the whole panel against mock data.

Throughout this page, "MR" means merge request on GitLab and pull request on
GitHub — jmux treats them as one thing and so do the keybindings.

---

## The Info Panel

Press `Ctrl-a g` to toggle the info panel. It docks to the right side of the
terminal with tabbed views:

| Tab | What it shows |
|-----|---------------|
| **Diff** | hunk diff viewer — always present, needs no adapter |
| **Issues** | Your assigned issues, grouped by team and status |
| **My MRs** | Merge requests you authored, with pipeline and approval status |
| **Review** | MRs awaiting your review |

Those three are the defaults you get before configuring anything. Once you
define workflow stages in `Ctrl-a W`, **the issue tabs become your stages** —
`Urgent`, `To do`, `Waiting` — and the strip reads as your pipeline. See
[Workflow](workflow.md).

A tab appears only if the adapter behind it authenticated: no tracker means no
issue tabs at all, rather than an empty one. Only **Diff** is unconditional.

Click the panel or press `Shift-Right` to focus it. Use `[` and `]` to cycle
between tabs.

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
| `l` | Add this issue to the current session |
| `s` | Update status (picks from available workflow states) |
| `c` | Copy issue prompt to clipboard (identifier + title + description) |

**On a group header** (any grouping axis — project, team, status):

| Key | Action |
|-----|--------|
| `n` | Start every issue under it as **one** session (confirms the name first) |
| `l` | Add every issue under it to the current session (confirms the count first) |

Both ask first, because a group header exists on every grouping axis — `l` on a
status section is otherwise a bulk write of forty links from one keystroke.

**Selecting issues directly** (works on every tab, including ones with no
headers at all):

| Key | Action |
|-----|--------|
| `Space` | Tick / untick the highlighted issue |
| `n` | Start every ticked issue as **one** session |
| `l` | Add every ticked issue to the current session |
| `Esc` | Clear the ticks (then, pressed again, the filter) |

Checkboxes only appear once something is ticked, so an untouched list looks
exactly as it always has.

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
**Stages** are jmux's own four
[tracker categories](workflow.md#tracker-categories). `/` is a throwaway search;
`F` is the durable definition of what belongs in the tab.

Changes persist to `~/.config/jmux/config.json` automatically. Once a view looks
right, **Save current view as tab** in the command palette (`Ctrl-a p`) clones
it under a new name — configuring by demonstration rather than by editing JSON.

### Images in issue previews

When a terminal can draw pictures, jmux draws them: a screenshot pasted into a
Linear issue or a GitHub comment renders inline in the detail pane and in the
[ghost preview](workflow.md#unstarted-work-in-the-sidebar), instead of a link you
would have to open a browser to follow.

This uses the **kitty graphics protocol**, so it works in kitty, Ghostty,
WezTerm, Konsole and anything else that implements it. jmux asks the terminal at
startup whether it speaks the protocol and believes the answer — on a terminal
that doesn't, or one that never replies, images stay the clickable links they
have always been. Nothing to turn on.

Two rules decide what gets drawn, and both are deliberate:

- **An image on a line of its own becomes a picture. An image inside a sentence
  stays a link.** Drawing an image means cutting the document in two and
  rendering the halves separately, which would break any list or table that
  spanned the cut. A flush-left line is the one place no such construct can be
  open. Badges wrapped in a link (`[![build](badge.svg)](ci)`) stay links too —
  the page they point at is the useful destination, not the badge.
- **Anything that can't be drawn falls back to the link, and says why.** A
  private attachment that 403s, an SVG, a format with no converter installed —
  each renders as the same link you'd have got anyway, with the reason beside
  it. You are never left staring at a blank rectangle.

**Clicking a drawn image opens it**, exactly as clicking the link did before —
showing you the picture doesn't take away what the link could do. The whole
image is the target, not just a caption.

PNGs are sent to the terminal as-is. JPEG, GIF, WebP and BMP are re-encoded
first, which needs ImageMagick (`magick`) or, on macOS, the built-in `sips` —
both are looked for automatically, and without either those formats fall back to
links. Fetching an attachment from a private tracker uses the same credential
the tracker adapter does, and only ever sends it to that tracker's own host.

Two settings, both under **Display** in the settings screen (`Ctrl-a I`):

| Setting | Default | Meaning |
|---------|---------|---------|
| `images.enabled` | unset (detect) | Force inline images on or off, overriding detection |
| `images.maxRows` | `16` | Tallest an inline image may be, in terminal rows |

The height cap is the one worth tuning. Without it a tall screenshot pushes
every word of the issue off the bottom of the pane, and you came for the issue.

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

A session can carry **several** issues, and then the badge reads `ENG-1234 +4`.
The identifier shown is the *driving* issue — the least advanced one that isn't
finished — which is also what decides the session's workflow stage band. So a
session drops out of "In Review" only when its last ticket does, and a closed
ticket can't hold a session in Done while four open ones sit under it.

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

### Several issues, one session

Product often files one feature as several tickets. One session, one worktree,
one branch and one merge request is usually the right shape for that, so jmux
lets a session carry any number of issues — while an issue still belongs to
exactly one session, which is what keeps "where is this work?" a question with
one answer.

Three ways in:

- **Tick the issues you want.** `Space` on each, then `n`. This is the one that
  works everywhere — in particular on a **stage tab**, where `groupBy` does not
  apply at all (sections come from the tab's statuses), so there is no project
  header to press `n` on. It is also the only way to say "these three of those
  five". If the ticked issues share a project, its name pre-fills the session
  name.
- **Start a group.** On a tab that groups (`g` cycles; `project` is the useful
  one here) press `n` on the *group header*. jmux confirms the
  session name — it is also the branch and worktree name, and unlike a single
  issue there is no tracker-supplied branch name to inherit — then provisions
  one session and seeds the agent with all of the issues at once. Issues that
  already have a session are left where they are and reported, not moved.
- **Add as you go.** Press `l` on an issue to add it to the session you're in,
  or `a` in the ghost preview to pick a session for an unstarted issue.
- **From an agent.** `jmux ctl issue link <session> <issue-id>` appends rather
  than replacing; `jmux ctl issue unlink <session> [issue-id]` removes one link
  or all of them.

A group start refuses in one case: if the issues route to more than one repo via
`teamRepoMap`, there is no single worktree to put them in, so jmux names the
repos instead of guessing.

When the session's MR merges, jmux offers to move **all** of its unfinished
issues, as a checklist you can untick — a merge request that only covered three
of five tickets is a normal thing to happen. This honours the existing
`transitionConfirm` policy: set to `never` or `undo-toast`, the fan-out is
silent, exactly like every other transition.

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

Auth failures (401/403) disable the affected adapter until jmux restarts — its
tabs disappear from the strip. See
[Troubleshooting](connecting.md#troubleshooting).

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

On GitLab this is the pipeline; on GitHub it's the head commit's check runs,
rolled up the same way.

---

## Custom Panel Views

The default tabs (Issues, My MRs, Review) can be customized via `panelViews` in config:

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
      "label": "My MRs",
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

An issues view can also carry a `states` list, which makes it a
[workflow stage](workflow.md#queues-and-up-next-ctrl-a-u) — membership and
subheadings both come from those statuses, and `groupBy` is ignored.

---

## Next

- **[Connecting](connecting.md)** — tokens, adapter config, troubleshooting
- **[Workflow](workflow.md)** — your stages, parking, `Ctrl-a u`, status writes
- **[Configuration](configuration.md)** — everything else in `config.json`
