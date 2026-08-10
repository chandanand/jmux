# Configuration

jmux loads tmux config in three layers:

```
config/defaults.conf      ← jmux defaults (baseline)
~/.tmux.conf              ← your config (overrides defaults)
config/core.conf          ← jmux requirements (sourced last, always wins)
```

jmux defaults are applied first as a baseline. Your `~/.tmux.conf` is sourced next — anything you set there overrides jmux's defaults. Core settings are applied last and cannot be overridden.

Restart jmux to pick up changes. There's no hot-reload.

## Customizing in ~/.tmux.conf

jmux's defaults are sourced first, then your `~/.tmux.conf` overrides them. Anything you set in `~/.tmux.conf` wins over jmux's defaults. Only core settings (listed below) cannot be overridden.

```bash
# Edit your tmux config as usual
vim ~/.tmux.conf
```

### Changing the Prefix Key

```tmux
# ~/.tmux.conf
set -g prefix C-b
unbind C-a
bind-key C-b send-prefix
```

jmux's `prefix + n` (new session) still works — it uses whatever prefix you set.

> **Note:** `Ctrl-Shift-Up/Down` for session switching is handled by jmux directly and doesn't use the prefix. It always works regardless of your prefix setting.

### Adding Keybindings

Standard tmux `bind` syntax in `~/.tmux.conf`:

```tmux
# Open lazygit in a popup
bind-key g display-popup -E -w 80% -h 80% "lazygit"

# Quick ssh to a server
bind-key S command-prompt -p "ssh:" "new-window -n '%1' 'ssh %1'"
```

### Overriding jmux Defaults

jmux sets defaults for things like window behavior and pane borders. Override any of them in `~/.tmux.conf`:

```tmux
# Change pane border colors
set -g pane-border-style 'fg=#3b4261'
set -g pane-active-border-style 'fg=#7aa2f7'

# Disable auto-rename (jmux default is on)
set -g automatic-rename off
```

### Using Plugins

TPM and plugins work normally. Add them to `~/.tmux.conf`:

```tmux
set -g @plugin 'tmux-plugins/tpm'
set -g @plugin 'tmux-plugins/tmux-sensible'
set -g @plugin 'catppuccin/tmux'

run '~/.tmux/plugins/tpm/tpm'
```

## Protected Settings (core.conf)

These settings are required for jmux to function. They're applied last and override anything in your config:

| Setting | Value | Why |
|---------|-------|-----|
| `detach-on-destroy` | `off` | Switch to next session on kill instead of exiting jmux |
| `mouse` | `on` | Sidebar and toolbar click/hover handling |
| `prefix + n` | New session modal | jmux's native session creation |
| `status` | `off` | jmux renders its own toolbar with window tabs |

If you bind `n` to something in `~/.tmux.conf`, jmux's core will override it. All other keys are yours.

## Keys Handled by jmux (Not tmux)

These are intercepted by jmux's input router before reaching tmux. They cannot be rebound in tmux config:

| Key | Action |
|-----|--------|
| `Ctrl-Shift-Up` | Switch to previous session |
| `Ctrl-Shift-Down` | Switch to next session |
| Mouse clicks in sidebar | Switch to that session |
| Mouse clicks on toolbar tabs | Switch to that window |
| Mouse clicks on toolbar buttons | New window, split horizontal, split vertical, toggle panel |
| Mouse hover (sidebar/toolbar) | Visual highlight |

Everything else passes through to tmux normally.

## Editing jmux Defaults

If you want to change jmux's default keybindings (not just override them), edit `config/defaults.conf` in the jmux installation directory:

```bash
# Find where jmux is installed
npm root -g
# Edit the defaults
vim $(npm root -g)/@jx0/jmux/config/defaults.conf
```

Changes here persist until you update jmux. For durable customizations, prefer `~/.tmux.conf` instead.

## jmux Application Config

jmux's own settings (not tmux settings) live in `~/.config/jmux/config.json`. Edit it directly or use the settings screen (`Ctrl-a I` — capital I; lowercase `Ctrl-a i` opens the shorter settings palette). The file is watched and changes are hot-reloaded.

**`adapters` is the exception.** A live adapter owns polling state and in-flight
requests, so jmux builds the pair once at startup and the watcher deliberately
leaves them alone — changing a code host or issue tracker needs a restart, and
the settings row says `restart to apply` until you do. See
[Connecting](connecting.md#3-restart-jmux).

```json
{
  "sidebarWidth": 26,
  "infoPanelWidth": 80,
  "infoPanelSplitRatio": 0.5,
  "cacheTimers": true,
  "stateColors": {
    "running": "green",
    "waiting": "yellow",
    "complete": "blue"
  },
  "pinnedSessions": [],
  "commandCenterTabs": [
    { "id": "default", "name": "Main" }
  ],
  "projectDirs": ["~/Code", "~/Projects"],
  "diffPanel": {
    "splitRatio": 0.4,
    "hunkCommand": "hunk",
    "watch": true,
    "transparentBg": true,
    "controlPlane": true,
    "clearNotesOnSend": true
  },
  "adapters": {
    "codeHost": { "type": "gitlab" },
    "issueTracker": { "type": "linear" }
  },
  "issueWorkflow": {
    "teamRepoMap": {}
  },
  "repoDefaults": {
    "defaultBaseBranch": "main",
    "wtmIntegration": true,
    "autoLaunchAgent": true,
    "sessionNameTemplate": "{identifier}",
    "claudeCommand": "claude"
  },
  "repos": {},
  "pipeline": {
    "parkedStates": [],
    "unparkOn": ["state-regression", "issue-comment", "mr-activity", "pipeline-failed"],
    "autoParkIdleDays": null,
    "transitionConfirm": "undo-toast",
    "upNext": [],
    "showUnstartedInSidebar": null
  },
  "panelViews": [],
  "images": {
    "maxRows": 16
  }
}
```

`diffPanel.theme` is absent from the example for the same kind of reason:
unset, jmux gives hunk the light or dark theme matching the terminal background
it detected at startup. hunk has its own `--theme auto` for this and it cannot
work inside the panel — hunk runs in a pty whose output jmux only reads, so its
startup query gets no reply and always falls back to dark, which is unreadable
on a light terminal once `transparentBg` removes the surface it was drawn for.
Set a theme id to pin one regardless of the terminal, or `false` to pass no
theme at all and leave hunk's own config in charge. See
[Diff panel](diff-panel.md).

`showUnstartedInSidebar` decides how many unstarted issues each workflow stage
shows in the sidebar as startable rows: a count, `"all"`, or `null` for off.
Per-stage exceptions (`inSidebar`, `showUnstarted`) live on the stage's own entry
in `panelViews`. Both are edited on the workflow screen (`Ctrl-a W`) — see
[Unstarted work in the sidebar](workflow.md#unstarted-work-in-the-sidebar).

`images` controls inline pictures in issue previews. `enabled` is deliberately
absent from the example: left unset, jmux asks the terminal whether it speaks
the kitty graphics protocol and uses the answer, which is right on every
terminal that answers honestly. Set it to `true` or `false` only to overrule
that. `maxRows` caps how tall one image may be. See
[Images in issue previews](issue-tracking.md#images-in-issue-previews).

### Per-repo settings (`repoDefaults` / `repos`)

Some settings are properties of a **repo**, not of you or the UI — the trunk
branch, whether the repo is wtm-managed, the agent command. Those live in
`repoDefaults` (the global default) and `repos` (per-repo overrides), resolved
as:

```
repos[repoKey].x  ??  repoDefaults.x  ??  built-in default
```

The repo key is the canonical **git common dir**, which is identical for a
repo's main checkout and every one of its worktrees, so all sessions in a repo
resolve to one entry. jmux migrates older configs into this shape once, on
first launch — the previous `claudeCommand` / `wtmIntegration` top-level keys
and the `issueWorkflow` workflow keys move to `repoDefaults` automatically.

The settings screen (`Ctrl-a I`) shows both tiers: the global rows under
**Repo**, and a **This repo** category for the repo your active session lives
in, where each row is marked `(inherited)` or `(override)` and `d` clears an
override back to inherited.

The transition states (`onSessionStartState`, `onMrOpenState`,
`onMrMergedState`) are per-repo too, but they are edited on the workflow screen
(`Ctrl-a W`) alongside everything else the pipeline does. It shows the value in
force for the repo you are in, with the same `(inherited)` / `(override)`
markers; `g` switches to the global defaults.

`teamRepoMap` deliberately stays under `issueWorkflow`: it is the cross-repo
routing index that maps a tracker team *onto* a repo, so it cannot itself be
per-repo.

See `docs/adr/0004-per-repo-settings-keyed-on-repo-root.md`.

### Resizing the sidebar and the info panel with the mouse

`sidebarWidth`, `infoPanelWidth` and `infoPanelSplitRatio` can all be set by
dragging, as well as from the settings screen or by editing the file. Each
handle is the separator line you would expect:

- **The sidebar border** — the line between the sidebar and the terminal.
  Drag left/right.
- **The panel divider** — the line between the terminal and the diff/info
  panel, when the panel is docked in split mode (`Ctrl-a g`). Drag left/right.
  In full-width mode there is no divider, so there is nothing to drag.
- **The panel's list/detail split** — the horizontal line between the item
  list and the detail pane in the Issues / MRs / Review views. Drag up/down.
  The diff tab has no such split, and neither does a panel too short to show
  a detail pane at all.

Hover a handle and it highlights in the accent color; drag it and the frame
resizes live, following the pointer. Releasing writes the new width to
`~/.config/jmux/config.json`, so it survives a restart.

Sizes are clamped to what the frame can actually accommodate: the sidebar to
10–60 columns (and never so wide that the terminal area drops below 40), the
panel to at least 20 columns with at least 20 left for the terminal, and the
list/detail split to at least 3 list rows and 4 detail rows. A drag held past
a limit simply stops there.

The list/detail split is stored as a ratio rather than a row count, so the
proportions you pick survive resizing the terminal or the panel.

A single click on the divider — press and release without moving — still
toggles keyboard focus between the terminal and the panel, exactly as before.
Pressing a key or scrolling during a drag ends it and keeps the size the drag
had reached, rather than snapping back.

### Browser panes (`browser`)

Settings for `Ctrl-a b`. All optional; the defaults are what jmux uses when the
key is absent.

```json
{
  "browser": {
    "paneSize": 0.62,
    "displayScale": 1,
    "fps": 60,
    "isolate": true,
    "openLinks": "system"
  }
}
```

| Key | Default | What it does |
|-----|---------|--------------|
| `paneSize` | `0.62` | Fraction of the current pane the browser takes (0.2–0.95) |
| `displayScale` | `1` | Device pixel ratio the page is laid out at, or `"auto"` |
| `fps` | `60` | Frame-rate cap, or `"auto"` |
| `isolate` | `true` | Give each browser pane its own browser process |
| `openLinks` | `"system"` | Where a clicked link goes — `"system"` or `"pane"` |

`displayScale` decides which layout a site picks: left alone, terminal-browser
uses the display's scale factor (2 on a Mac), which halves the CSS viewport and
puts a phone layout in a pane wide enough for a desktop one.

`fps` is worth knowing about — uncapped, terminal-browser renders at the fastest
refresh among *all* attached displays, so one ProMotion panel drives a pane on a
60Hz monitor at 120fps, and it does not stop when the page is static.

`isolate` off means one shared browser: `terminal-browser`'s own CLI works
across panes, but two browser panes render the same page. Full explanation in
**[Browser panes](browser-panes.md#isolation)**.

### Agent-state colors

`stateColors` sets the color used for each agent state across every indicator —
sidebar dots/flags/checkmarks, the Command Center `n RUN / n WAIT / n DONE`
breakdown, and the Command Center tile borders. Each value is a named ANSI color:
`black`, `red`, `green`, `yellow`, `blue`, `magenta`, `cyan`, `white`, and their
`bright*` variants (e.g. `brightblue`). Unset or unrecognized names fall back to
the defaults (`running` green, `waiting` yellow, `complete` blue). The bold/dim
emphasis per state is fixed; only the hue is configurable. Set these from the
settings screen (`Ctrl-a I` → Display) or the command palette (`Ctrl-a p`).

### Command Center tabs

`commandCenterTabs` is an ordered array of `{ "id": string, "name": string }`
entries that define the named tab buckets inside the Command Center. The first
entry (index 0) is the **default tab** — it is protected: non-deletable and always
first. Its seeded id is `"default"` and its default name is `"Main"`.

Each pinned pane stores the **id** of its assigned tab in the per-pane tmux option
`@jmux-pinned`. Renaming or reordering tabs only updates this config field — no
pane options are rewritten. Any pane whose stored id is not found in the registry
(including legacy `"1"` values from older versions) is silently routed to the
default tab.

Manage tabs from the command palette (`Ctrl-a p`): create, rename, delete, reorder,
pin a pane to a tab, or move a pane between tabs. While the Command Center is open,
switch tabs with `Ctrl-a <number>` (jump to tab N), or `Ctrl-a [` / `Ctrl-a ]`
(previous / next, wrapping around) — these chords are scoped to the Command Center,
so they don't affect tmux copy-mode/paste in normal panes. The config file is
hot-reloaded — edits applied externally take effect immediately without restarting jmux.

### Session titles (`sessionTitle`)

Row 1 of a session normally shows its tmux session name — a slug like
`tra-123`, or whatever you typed at `Ctrl-a n`. Set `sessionTitle.command` and
jmux asks a model to name the session instead, from whatever it knows about
the work:

```json
{
  "sessionTitle": {
    "command": ["claude", "-p", "--model", "haiku"],
    "timeoutMs": 20000,
    "maxChars": 32
  }
}
```

`command` is absent from the example config above for the same reason
`diffPanel.theme` is: **unset is off, and the value is the switch** — there is
no separate boolean that could disagree with it. It is an argv array, not a
shell string: jmux spawns it directly and writes the prompt to its stdin, so
there is no quoting question and no command-line parser to get wrong.
`["codex", "exec"]`, `["ollama", "run", "qwen2.5"]`, or a shell script you
wrote all work — the model choice is a flag you already control, and jmux
keeps no provider registry and no second credentials story.

**What jmux sends it leaves your machine if the command does.** The prompt
carries your issue identifiers, titles and descriptions, your first prompt to
the agent, or your branch name and commit subjects — see the three tiers below.
Point `command` at a hosted model and all of that goes to that provider under
their terms; point it at a local one (`["ollama", "run", "qwen2.5"]`) and it
does not leave the machine. jmux itself makes no network call for this and
stores nothing beyond the resulting title.

jmux names a session from the strongest of three inputs it has, in order:

1. **Linked issues** — identifier, title and description, once the session
   has any.
2. **The first prompt you gave the agent** — captured by the `UserPromptSubmit`
   hook, so it only exists once **you have re-run
   `jmux --install-agent-hooks`** after turning titling on. An install from
   before this feature does not capture prompts; `--install-agent-hooks`
   detects the stale hook body and rewrites it.
3. **Git** — the repo name, the branch, and the commits your branch has that
   its base branch doesn't. A fresh worktree with no commits of its own has
   nothing here, so a session can still fall through with no title at all.

A generated title is requested again only when the input it would come from
changes — a session growing from one linked issue to five re-titles, retyping
the same prompt does not. A failed or timed-out call is cached exactly like a
successful one, under the same input, so a model that didn't answer once isn't
asked again on every poll.

**Git-tier titles freeze on the branch's first commit.** The title is resolved
once per branch and kept for the life of that branch, not re-read on every
commit — the input is keyed on `(session, branch)`, not on `HEAD`, because a
`HEAD` key would cost a subprocess per session on every sidebar refresh. A
session titled from three early commits keeps that title as you add forty
more; this is expected, not a bug. Re-run naming on demand from the command
palette — **"Re-name session with the model"** — which re-resolves the
current input regardless of what's cached.

`maxChars` is **both** the budget jmux asks the model for and the cap it
enforces on the answer — one number, stated in the prompt and applied to the
reply. Two numbers would drift, and the symptom would be every title coming
back one character too long and truncated.

The default is 32, chosen against the sidebar rather than against what a model
can write. A 26-column sidebar shows about twenty characters of row 1 before it
truncates, and even a wide sidebar reads better with a short phrase than a long
one cut off. Raise it if your sidebar is wide and you want more words — the
command palette and `ctl session list`/`info` have room for whatever you store.
It is clamped to 8–200, and `timeoutMs` to 1000–120000, because there is no
useful title in four characters and `maxChars: 0` would store a bare `…`.

Note this is a budget, not a guarantee: the model is asked for it and told why,
but a model that overshoots is still truncated at the cap.

`command` is checked at startup and on every config reload: a shell string
instead of an argv array, an empty array, or a binary that isn't on `PATH`
each print one line to stderr and to `jmux.log` and leave naming off. Without
that check all three fail the same way a working setup that simply hasn't
named anything yet looks — nothing on screen, ever, with no way to tell which.

Renaming a session by hand (`Ctrl-a p` → **Rename session**) always wins: it
clears any generated title and marks the session so titling never overwrites
your name again, even across a restart.

See [connecting.md](connecting.md) for adapter setup, [issue-tracking.md](issue-tracking.md) for the info panel, and [workflow.md](workflow.md) for the pipeline.
