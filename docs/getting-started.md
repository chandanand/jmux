# Getting Started with jmux

jmux orchestrates your terminal tools — tmux for sessions, hunk for diffs, wtm for worktrees — without replacing any of them. This guide walks you through the basics. No prior tmux knowledge needed.

---

## Install

```bash
curl -fsSL https://jmux.build/install | sh
```

jmux will check for dependencies and offer to install them automatically. If you prefer to install manually:

```bash
# macOS
brew install tmux

# Ubuntu/Debian
sudo apt install tmux

# Fedora
sudo dnf install tmux

# Arch
pacman -S tmux
```

No runtime needed — that installs a self-contained binary. Two other ways:

```bash
brew install jarredkenny/tap/jmux    # also installs tmux for you
bun install -g @jx0/jmux             # needs Bun 1.3.8+; the only option on Alpine/musl
```

Optionally install [git](https://git-scm.com/) — jmux uses it for worktrees, the diff panel, and (once you set `sessionTitle`) naming sessions from your branch's commits.

---

## First launch

```bash
jmux
```

You'll see a terminal split into two areas:

```
+--sidebar--+--Command Center----------------+
| jmux      |                                 |
| ────────  |        No sessions yet          |
|           |                                 |
| Overview  |  Ctrl-Space n  new session      |
|           |                                 |
+-----------+---------------------------------+
```

On a true first run, the setup flow appears over this surface. You can complete
it or skip it; either way, jmux does not create a throwaway session named `0`.
Press `Ctrl-Space n` to create your first real session. Once you choose its
directory and name, jmux lands in that session and the main area becomes your
normal terminal.

- **Sidebar** (left): shows all your real sessions, grouped by project
- **Command Center** (right, while empty): creates or surveys sessions
- **Main area** (after choosing a session): your normal terminal — run commands, edit files, whatever you'd normally do

If you later exit or kill your final session, jmux stays open and returns to
this same empty Command Center; setup does not run again. When another session
still exists, tmux moves you to it as usual. `Ctrl-Space d` remains an explicit
detach and exits jmux normally.

---

## Core concepts

### Sessions = projects

A **session** is a project. Each session has its own set of windows and remembers what you were doing — think of sessions like browser profiles, completely separate environments.

Create one session per project:
- `myapp` — your main project
- `docs-site` — a separate project
- `infra` — your infrastructure repo

### Windows = concerns within a project

A **window** is a tab within a session. Window tabs appear in the toolbar at the top of the screen — click one to switch. Each window is a full-screen terminal.

Use windows to separate the things you're doing inside a project:
- One window for your editor
- One window for an AI coding agent
- One window for a dev server or test runner

### Panes = multiplexing within a window

A **pane** splits a window into multiple terminals side by side. Useful when you want to see two things at once — like a server's output while you're editing code in the same window, or two log streams next to each other.

---

## Essential keybindings

jmux uses `Ctrl-Space` as the **prefix key**. Some actions require pressing `Ctrl-Space` first, then the next key. Others work directly.

### Navigating sessions

| Action | Keys |
|--------|------|
| Next session | `Ctrl-Space` then `)` |
| Previous session | `Ctrl-Space` then `(` |
| Switch to session | Click it in the sidebar |

`Ctrl-Shift-Down/Up` remain direct compatibility aliases.

### Creating things

| Action | Keys |
|--------|------|
| New session | `Ctrl-Space` then `n` |
| New window (tab) | `Ctrl-Space` then `c` |
| Split pane left / right | `Ctrl-Space` then `\|` |
| Split pane top / bottom | `Ctrl-Space` then `-` |

The split keys look like what they do: `|` gives you a vertical divider, `-` a
horizontal one. "Horizontal" and "vertical" are avoided on purpose — tmux uses
them to describe how the *panes* sit and jmux's own button ids use them to
describe the *divider*, so the words point opposite ways depending on who is
talking.

### Navigating windows and panes

| Action | Keys |
|--------|------|
| Next window | `Ctrl-Right` |
| Previous window | `Ctrl-Left` |
| Switch pane | `Ctrl-Space` then `h/j/k/l` (left/down/up/right) |
| Resize pane | `Ctrl-Space` then `H/J/K/L` (repeatable) |
| Toggle pane zoom | `Ctrl-Space` then `z` |

### Info panel

| Action | Keys |
|--------|------|
| Toggle info panel | `Ctrl-Space` then `g` |
| Cycle tabs (Diff/Issues/MRs/Review) | `[` / `]` (when panel is focused) |
| Zoom panel (split ↔ full) | `Ctrl-Space` then `z` (when panel is focused) |
| Switch focus (tmux ↔ panel) | `Ctrl-Space` then `Tab` |
| Focus panel from rightmost pane | `Ctrl-Space` then `l` |
| Return focus to tmux | `Ctrl-Space` then `h` (from panel) |

The Diff tab is powered by [hunk](https://github.com/modem-dev/hunk) — install with `npm i -g hunkdiff`. It's the only tab that needs no setup; the Issues and MRs tabs appear once an adapter connects — see [connecting.md](connecting.md).

### Utilities

| Action | Keys |
|--------|------|
| Keyboard shortcuts | `Ctrl-Space` then `?` (or click `?` in the toolbar) |
| Command palette | `Ctrl-Space` then `p` |
| Settings | `Ctrl-Space` then `i` |
| Clear pane | `Ctrl-Space` then `Ctrl-l` |
| Copy pane to clipboard | `Ctrl-Space` then `y` |
| Rename session | `Ctrl-Space` then `p`, "Rename session" |
| Move window to session | `Ctrl-Space` then `p`, "Move window to session" |

---

## Common workflows

### Setting up a project session

1. Start jmux: `jmux`
2. You're in your first session — this is your first project
3. Open your editor in the default window
4. Create a new window for your agent: `Ctrl-Space` then `c`
5. Start your agent: `claude`
6. Create another window for your dev server: `Ctrl-Space` then `c`
7. Switch between windows with `Ctrl-Right` / `Ctrl-Left` or click the tabs

Now you have one project with an editor, an agent, and a dev server — each in its own tab.

### Working on multiple projects

1. Create a new session: `Ctrl-Space` then `n`
2. Pick a project directory, name the session
3. Set up windows for that project (editor, agent, etc.)
4. Repeat for more projects
5. Switch between projects with `Ctrl-Space (` / `Ctrl-Space )` or click the sidebar

### Parallel agents with worktrees (recommended)

The most powerful workflow: give each agent its own git branch in an isolated worktree. No conflicts, no stashing, agents can't step on each other.

**One-time setup:**

```bash
bun install -g @jx0/wtm
wtm init git@github.com:you/repo.git
```

This creates a bare repo with [wtm](https://github.com/jarredkenny/worktree-manager) — a git worktree manager built for this workflow.

**Daily workflow:**

1. Press `Ctrl-Space` then `n` to create a new session
2. Select your wtm-managed project
3. Choose **+ new worktree**
4. Pick a base branch (e.g., `main`) and name your branch
5. jmux creates the worktree and opens a split-pane session
6. Start your agent: `claude`
7. Repeat for more features — each gets its own branch

The sidebar groups worktrees by project; a new worktree's session is named after its branch, so row 1 shows that until you name it something else — see [Session titles](configuration.md#session-titles-sessiontitle). When an agent finishes (orange `!`), switch to it, review the diff, and merge if it's good.

**Example:** 5 agents, 5 branches, all working off `main` simultaneously:

```
myproject (sidebar)
  ● feature-auth        1w
    feature-auth
  ! feature-search      1w
    feature-search
  ● fix-validation      1w
    fix-validation
  ● refactor-api        1w
    refactor-api
    add-tests           1w
    add-tests
```

### Reviewing agent changes with the info panel

When an agent finishes work and the `!` flag appears:

1. Switch to that session
2. Press `Ctrl-Space g` to open the info panel in split mode — you'll see the agent's terminal on the left and its code changes on the right (Diff tab)
3. Click the panel or press `Ctrl-Space l` from the rightmost pane to focus it, then use `j`/`k` to scroll and `h`/`l` to jump between tabs
4. Press `Ctrl-Space z` to zoom the panel to full-screen for thorough review
5. Press `Ctrl-Space z` again to unzoom, or `Ctrl-Space g` to close the panel entirely

The Diff tab shows the working tree changes for whichever session is active. Switch sessions in the sidebar and the diff updates automatically. The Issues and MRs tabs show your tracked items across all sessions — see [issue-tracking.md](issue-tracking.md).

### Monitoring multiple agents

When you have several agents running in different sessions:

- **Green dot** `●` — this session has new output since you last looked
- **Orange bang** `!` — an agent finished and needs your review
- **Green bar** `▎` — you're currently viewing this session

Switch to a session to check on it. The indicators clear when you type something in that session — not when you're just passing through.

For a bird's-eye view, open the **Command Center** — `Ctrl-Space C`, or the entry at
the top of the sidebar: a grid of live, drivable tiles, one per session, with
borders colored by agent state. It's non-destructive — panes stay in their own
sessions. You don't pin anything to populate it: membership is **derived**, the
same way the sidebar's own rows are — the grid shows whichever sessions the
active view's filter would put in front of you, automatically, as agents start
and finish. A session with several agent panes still gets one tile; `Ctrl-Space x`
cycles which pane it's showing.

When the derived set isn't quite what you want, two per-session overrides are a
keystroke away: `Ctrl-Space P` on a session removes it from the grid (or, from
inside a session, adds it, showing the pane you're on); a hidden session stays
off the grid until you bring it back from the palette's **Show hidden sessions
(N)…**. Switch between saved presets of the grid's own filter/group/sort with
`Ctrl-Space <number>` or `Ctrl-Space [` / `Ctrl-Space ]`, or save your current narrowing as
a new one with **Save current axes as view…** in the palette.

---

## Claude Code integration

Set up attention notifications so jmux tells you when Claude Code finishes:

```bash
jmux --install-agent-hooks
```

Now when Claude Code completes a response in any session, that session gets an orange `!` in the sidebar. Switch to it, review the work, move on.

---

## Issue tracking with Linear and GitLab or GitHub

Connect your issue tracker and code host to see issues, MRs, and pipeline status directly in jmux.

### 1. Connect

Export a token, name the adapters, restart. In brief:

```bash
export LINEAR_API_KEY="lin_api_..."    # from linear.app/settings/api
export GITLAB_TOKEN="glpat-..."        # api scope — or GH_TOKEN for GitHub
```

Then `Ctrl-Space I` → **Integrations** → set **Code host** (`gitlab` or `github`)
and **Issue tracker** (`linear`), and **restart jmux** — adapters are the one
setting that doesn't hot-reload.

Press `Ctrl-Space g` and use `[`/`]` to reach the Issues or MRs tab. If a tab isn't
there, the adapter didn't connect.

**Full setup, self-hosted hosts, and what to check when a tab doesn't appear:
[connecting.md](connecting.md).** Want to see it before getting credentials?
`jmux --demo`.

### 2. Map your teams to repos (optional)

If you want to create sessions directly from issues (press `n` on an issue), tell jmux which Linear team maps to which local repository:

In settings (`Ctrl-Space I` > **Repo** > **Team → repo mappings**), add entries like:
- `Platform` → `~/repos/backend`
- `Frontend` → `~/repos/frontend`

Now selecting an issue and pressing `n` will create a worktree, open a session, and optionally launch Claude Code with the issue context — all in one step.

### 3. Define your workflow (optional)

Your tracker probably has more statuses than you have steps. Press `Ctrl-Space W` and
define **your own stages** — Urgent, To do, In Progress, Waiting — each covering
one or many of your tracker's statuses.

If you've configured nothing yet, the first row offers **⚑ Suggest a starting
layout**, which builds `To do` / `In progress` / `Done` stages from your
tracker's own categories. Press `Enter` on it and you have a working setup.

From there, each status in the table has two settings:

- **`Enter`** — which stage it belongs to.
- **`space`** — whether it **parks**. Tick the statuses that mean "someone else
  has this now" (merged, in QA, awaiting review). Sessions whose issue reaches
  one collapse into a single `Parked (n)` row at the bottom of the sidebar,
  untouched, and come straight back out when the issue moves, someone comments,
  the MR is touched, or a pipeline fails.

Two keystrokes worth knowing once that's set up:

| Key | Action |
|-----|--------|
| `Ctrl-Space u` | Start the next issue from your stage rotation (press `u` on a stage to add it) |
| `Ctrl-Space a` | Capture a new issue — `Enter` files it, `Ctrl-S` files it *and* starts work |

See [workflow.md](workflow.md) for the full pipeline reference — stages, parking,
`Ctrl-Space u`, and status writes back to your tracker — and
[issue-tracking.md](issue-tracking.md) for custom views, pipeline glyphs and
manual linking.

---

## Settings

Press `Ctrl-Space` then `I` (capital) to open the settings screen:

- **Display** — sidebar width, panel width, cache timers, state colours
- **Integrations** — code host (GitLab or GitHub), issue tracker (Linear)
- **Repo** — base branch, worktree creation, agent launch, team-to-repo mapping
- **Project** — project directories for session creation
- **Workflow** — opens the workflow screen (below)
- **Diagnostics** — read-only: whether the tracker is connected, and what's parked

The issue pipeline has a screen of its own: `Ctrl-Space W` is where you define your
own workflow stages and map your tracker's statuses onto them — two settings per
status, plus parking and status writes back to your tracker.

Settings are saved to `~/.config/jmux/config.json` and take effect immediately —
with one exception. **Integrations → Code host / Issue tracker needs a restart**;
the row reads `restart to apply` until you relaunch.

---

## Tips

- **Command palette** (`Ctrl-Space` then `p`) lets you fuzzy-search sessions, windows, pane actions, and settings — useful when you can't remember a keybinding
- **Scroll the sidebar** with your mouse wheel when you have many sessions
- **Click the version** at the bottom of the sidebar to see release notes
- **Mouse selection** works — click and drag to select text, it copies to your clipboard
- **Your tmux config** still works. If you have `~/.tmux.conf` (or `~/.config/tmux/tmux.conf`), jmux loads it. Your plugins, themes, and custom bindings carry over — and `userTmuxConfig: false` turns that off if its chrome collides with jmux's
- **Resize panes** with `Ctrl-Space` then `H/J/K/L` (hold for continuous resize)
- **Zoom a pane** with `Ctrl-Space` then `z` — the tab shows ⤢ when zoomed, press again to unzoom
- **Pane borders** auto-show when a window has multiple panes and hide for single-pane windows

---

## Next steps

- Read the [cheat sheet](cheat-sheet.md) for a complete keybinding reference
- Set up [agent integration](agent-integration.md) for live Claude Code / Codex / pi state
- Connect [Linear and GitLab or GitHub](connecting.md) for issue tracking and MR status in the panel
- Shape it around your own process with [workflow stages](workflow.md)
- Try [wtm](https://github.com/jarredkenny/worktree-manager) for git worktree workflows
- See [configuration](configuration.md) for advanced tmux config layering
