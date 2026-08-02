# jmux Cheat Sheet

Quick reference for all keybindings and features. The default prefix is `Ctrl-a`.

---

## Sidebar

| Action | How |
|--------|-----|
| Switch session | Click a session in the sidebar |
| Next/prev session | `Ctrl-Shift-Down` / `Ctrl-Shift-Up` |
| Scroll sidebar | Mouse wheel over the sidebar |
| Mouse select & copy | Click-drag in the main area to select, copies to clipboard |

The sidebar shows all sessions with:
- Green `▎` marker + highlighted background on the active session
- Green `●` dot for sessions with new output since you last viewed them
- Orange `!` flag for attention (e.g. Claude Code finished a response)
- `▲` / `▼` indicators when sessions overflow the sidebar

### Grouping, sorting and filtering

Grouping and sorting are two independent axes: grouping decides how sessions
bucket into headers, sorting decides the order *within* a bucket.

| Key | Action | Cycles through |
|-----|--------|----------------|
| `Ctrl-a G` | Cycle grouping | `Flat` → `Project` → `Status` → `Stage` |
| `Ctrl-a s` | Cycle sort within a group | `Name` → `Activity` → `Status` |
| `Ctrl-a f` | Cycle filter | `All` → `Needs you` → `Active` |

The current modes show as chips at the top of the sidebar (`⊞ Status  ⇅ Activity`),
alongside a count of sessions wanting your attention. `Ctrl-a s` deliberately
shadows tmux's `choose-session`, which the sidebar already replaces.

`Stage` groups sessions by the workflow stages you defined in `Ctrl-a W` — a
session sits under the stage that claims its linked issue's status, with headers
in your own stage order. Sessions with no linked issue, or whose status no stage
claims, list flat below the stage groups. See [Workflow](workflow.md#your-stages-in-the-sidebar).

| Mode | Meaning |
|------|---------|
| Group `Project` | One header per repo — every worktree of it together. Headers are alphabetical. |
| Group `Status` | One header per agent state, ordered by urgency rather than alphabetically: **Needs you → Running → Active → Done → Idle**. That order is fixed and does not follow the sort mode. |
| Sort `Activity` | Most recent signal of life first — an agent-state change, an OTEL request, or tmux output. |
| Sort `Status` | Same urgency rank as the status grouping, then recency, then name. |
| Filter `Needs you` | Only sessions whose agent is waiting on you. |
| Filter `Active` | Waiting *or* running — the sessions actually doing something. |

Four bands sit outside the grouping, in fixed positions:

- **Command Center** is always the first row.
- **Pinned** is the top group whenever any pane is pinned.
- **Up next** holds unstarted issues — work with no session yet — when the
  sidebar is grouped by anything other than `Stage`. Under `Stage` those rows sit
  in their own stage's band instead. Off until you set a count on the workflow
  screen; see
  [Unstarted work in the sidebar](workflow.md#unstarted-work-in-the-sidebar).
  Selecting one opens a **preview** rather than starting it:

  | Key | Action |
  |-----|--------|
  | `↵` | Start / Resume / Switch — whichever the pre-flight says applies |
  | `s` | Change the issue's status (park it, or move it along) |
  | `o` | Open the issue in your browser |
  | `↑` `↓` `PgUp` `PgDn` | Scroll the issue body |
  | `Esc` / `q` | Back to what you were doing |

  The preview shows the issue *and* what starting it would do — the session and
  branch name, the worktree path, the base branch, whether `wtm` or plain
  `git worktree add` creates it, and which agent launches. Nothing is
  provisioned until you press `↵`.
- **Parked** is always last and **collapsed by default**, showing its count
  (`Parked (9)`). It holds sessions whose issue reached a status you marked as
  parked on the workflow screen — see
  [Parking](workflow.md#parking-the-back-burner). Press `Enter` on the
  header to expand it.

---

## Sessions

| Key | Action |
|-----|--------|
| `Ctrl-Shift-Up` | Move to previous sidebar row |
| `Ctrl-Shift-Down` | Move to next sidebar row |
| `Ctrl-a n` | New session / new worktree (auto-detects wtm projects) |
| `Ctrl-a p` → "Rename session" | Rename current session |
| `Ctrl-a p` → "Move window to session" | Move current window to another session |

`Ctrl-Shift-Up` / `Ctrl-Shift-Down` walk every row the sidebar draws, not only
sessions: landing on a session switches to it, landing on an unstarted issue
opens its preview (below). The Command Center is the first stop in the cycle.

Park a handed-off session (or bring one back) from the palette: **Park session**
/ **Unpark session**. Parked sessions collapse into a single row at the bottom of
the sidebar and pop back out automatically when their issue, MR or agent needs
you — see [Parking](workflow.md#parking-the-back-burner).

---

## Windows

| Key | Action |
|-----|--------|
| `Ctrl-a c` | New window (starts in `~`) |
| `Ctrl-Right` | Next window |
| `Ctrl-Left` | Previous window |
| `Ctrl-Shift-Right` | Move window right |
| `Ctrl-Shift-Left` | Move window left |

---

## Panes

| Key | Action |
|-----|--------|
| `Ctrl-a \|` | Split pane left / right |
| `Ctrl-a -` | Split pane top / bottom |
| `Shift-Left/Right/Up/Down` | Navigate between panes |
| `Ctrl-a Left/Right/Up/Down` | Resize pane (repeatable) |
| `Ctrl-a z` | Toggle pane zoom (⤢ shown in tab) |


Pane borders auto-show when a window has multiple panes and hide for single-pane windows.

Shift-arrow pane navigation is smart-splits.nvim aware — if the active pane is running vim/neovim, the key is forwarded to vim instead.

---

## Command Center

A grid of live, drivable mirror tiles of pinned panes — borders colored by agent state. Non-destructive: panes never leave their own session. Open it from the **Command Center** entry at the top of the sidebar.

| Key | Action |
|-----|--------|
| `Ctrl-a <number>` | Switch to tab N (when open) |
| `Ctrl-a [` / `Ctrl-a ]` | Previous / next tab, wrapping (when open) |
| Click a tab chip | Switch to that tab |
| Shift-arrows | Move focus between tiles |
| Mouse wheel | Scroll the tile under the cursor |

Pin panes and manage tabs from the command palette (`Ctrl-a p`): **Pin to Command Center**, **Move tile to tab…**, **Unpin tile**, **New / Rename / Delete tab**, **Switch to tab…**. Tabs let you group pinned panes from *different sessions* into named buckets; a pane lives in exactly one tab and tabs persist in `~/.config/jmux/config.json`. The `Ctrl-a [` / `]` chords are scoped to the Command Center, so copy-mode/paste in normal panes is untouched.

---

## Command Palette

Press `Ctrl-a p` to open the command palette — a floating overlay for fuzzy-searching all actions.

| Key | Action (inside palette) |
|-----|--------|
| Type | Fuzzy filter commands |
| `↑` / `↓` | Navigate results (scrolls with long lists) |
| `Enter` | Execute command or drill into setting sub-list |
| `Escape` | Back out of sub-list, or close palette |
| `Ctrl-a p` | Close palette |

**Available commands:** switch sessions, switch windows, new session/window, kill session, close window/pane, split a pane either way, zoom pane, rename session, move window, open Claude, keyboard shortcuts, setup, Command Center (pin/unpin, move tile to tab, switch tab, new/rename/delete/reorder tab), sidebar width, Claude command, project directories.

Commands that also have a keybinding show it beside the row, so you can stop
reaching for the palette once you have learned the chord.

---

## Info Panel

| Key | Action |
|-----|--------|
| `Ctrl-a g` | Toggle info panel on/off |
| `[` / `]` | Cycle tabs (Diff, Issues, MRs, Review) |
| `Ctrl-a z` | Zoom panel (split ↔ full, when focused) |
| `Ctrl-a Tab` | Switch focus between tmux and panel |
| `Ctrl-a v` | Choose what the Diff tab shows |
| `Ctrl-a r` | Send your review notes to this session's agent |
| `Shift-Right` | Focus panel from rightmost pane |
| `Shift-Left` | Return focus to tmux from panel |
| Click panel | Focus panel for keyboard navigation |
| Click divider | Toggle focus between panels |

The **Diff** tab is powered by [hunk](https://github.com/modem-dev/hunk). Install with `npm i -g hunkdiff`.

In split mode, the panel docks to the right (~40% width). In full mode, it replaces the main area. The panel follows the working tree as an agent edits it, and switching sessions repoints it.

### Reviewing an agent's work

hunk 0.17+ runs a local session daemon, which lets jmux read the diff's shape
and the notes you write on it. See [diff-panel.md](diff-panel.md) for the whole
loop; the short version:

1. `Ctrl-a g` — open the panel. The tab shows live `+N −M` for the changeset.
2. `c` in the panel — write a note on the hunk under the cursor.
3. `Ctrl-a r` — jmux shows what it will send, and on Enter types the notes into
   the pane running this session's agent. Sent notes are cleared, so the `●N`
   count on the tab always means "written but not sent yet".

`Ctrl-a v` repoints the panel: working tree, staged, last commit, or everything
your branch has added since it forked.

### Issue & MR views (when on Issues/MRs/Review tab)

| Key | Action |
|-----|--------|
| `↑` / `↓` | Navigate items |
| `Enter` | Collapse/expand group |
| `o` | Open in browser |
| `n` | Start session from issue |
| `l` | Link to current session |
| `s` | Update issue status |
| `a` | Approve MR |
| `c` | Copy issue prompt |
| `C` | Create an issue |
| `r` | Refresh from the tracker |
| `/` | Filter by text |
| `F` | Filter by state, stage, label or priority |
| `g` / `G` | Cycle group-by / sub-group-by |
| `S` / `?` | Cycle sort field / reverse sort order |

See [connecting.md](connecting.md) for setup, [issue-tracking.md](issue-tracking.md) for the panel, and [workflow.md](workflow.md) for stages and parking.

---

## Utilities

| Key | Action |
|-----|--------|
| `Ctrl-a ?` | Keyboard shortcuts — every binding on this page, in the app |
| `Ctrl-a p` | Command palette (fuzzy search all actions) |
| `Ctrl-a k` | Clear pane content + scrollback |
| `Ctrl-a y` | Copy entire pane content to clipboard |
| `Ctrl-a i` | Settings palette (quick one-shot toggles) |
| `Ctrl-a I` | Settings screen (display, integrations, repo, project) |
| `Ctrl-a W` | Workflow screen (your stages, and a table of statuses → stage + parks) |

---

## Work Pipeline

| Key | Action |
|-----|--------|
| `Ctrl-a W` | Define your workflow stages and map statuses onto them |
| `Ctrl-a a` | Capture a new issue (`Enter` files it, `Ctrl-S` files it and starts work) |
| `Ctrl-a u` | Start the next issue from your stage rotation |
| `Ctrl-a Z` | Undo the last status write to your tracker |

`Ctrl-a W` is where you define **your own workflow stages** — Urgent, To do,
In Progress, Waiting — each sitting on top of one or many of your tracker's
statuses. Two blocks: your stages, then a table of every status. Each status has
two settings: which stage it belongs to (`↵`) and whether it parks (`space`).
The line above the keys says what the selected row will actually do.

On a **stage** row:

| Key | Action |
|-----|--------|
| `↵` | Rename the stage |
| `⇧↑` `⇧↓` | Reorder it — this order drives the panel's tabs and the sidebar's bands |
| `s` | Show / hide the stage in the sidebar (its sessions stay either way) |
| `space` | Show / hide its unstarted work as startable rows |
| `u` | Add to / drop from the `Ctrl-a u` rotation |
| `d` | Delete the stage (asks first) |

`◂` `▸` step a counted setting in place — including **how many unstarted issues
each stage shows**, under the *Unstarted work* band.

A stage holding more than one status groups its issues under those status names
in the panel; a stage holding one draws no subheading. Nothing to configure.

With the info panel focused (`Shift-Right`), `F` narrows the focused tab by
label or priority, and the palette's **Save current view as tab** clones it
under a new name.

---

## Claude Code Integration

```bash
jmux --install-agent-hooks
```

Adds a hook so that when Claude Code finishes a response, the session gets an orange `!` attention flag in the sidebar. Switch to the session to dismiss it.

---

## Configuration

Config loads in three layers:

```
config/defaults.conf      <- jmux defaults (baseline)
~/.tmux.conf              <- your config (overrides defaults)
config/core.conf          <- jmux core (always wins)
```

Override any default in your `~/.tmux.conf` — prefix key, colors, keybindings, plugins. Only a few core settings are enforced: `detach-on-destroy off`, `mouse on`, `allow-rename off` with automatic window naming, and `status off` (jmux renders its own toolbar). jmux's own chords (`Ctrl-a p`, `n`, `?` and the rest) are not tmux binds at all — jmux's input router intercepts them before tmux sees them, so they are unaffected by anything in your tmux config.

See [configuration.md](configuration.md) for the full guide.
