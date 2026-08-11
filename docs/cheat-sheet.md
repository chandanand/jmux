# jmux Cheat Sheet

Quick reference for all keybindings and features. The default prefix is `Ctrl-a`.

---

## Sidebar

| Action | How |
|--------|-----|
| Switch session | Click a session in the sidebar |
| Next/prev session | `Ctrl-Shift-Down` / `Ctrl-Shift-Up` |
| Scroll sidebar | Mouse wheel over the sidebar |
| Hide / show the sidebar | `Ctrl-a \` — the panes take the whole terminal |
| Mouse select & copy | Click-drag in the main area to select, copies to clipboard |

The sidebar shows all sessions with:
- Green `▎` marker + highlighted background on the active session
- Green `●` dot for sessions with new output since you last viewed them
- Orange `!` flag for attention (e.g. Claude Code finished a response)
- `▲` / `▼` indicators when sessions overflow the sidebar

Each session's row 1 is its **title** when one has generated — see
[Session titles](configuration.md#session-titles-sessiontitle) — or its plain
tmux session name otherwise. A titled session then carries its **branch** on
row 2 (for a worktree session that is the same string row 1 used to show, since
the branch, the worktree directory and the session name are one name), and its
linked issue badge (`TRA-123 +4`), stage word, timer and MR on the row below
that. With naming unconfigured there is no branch row: row 1 is already the
name. The branch a **ghost** row would get is spelled out on its pre-flight
preview.

**A session is named once.** The three inputs a title can come from arrive at
different moments, so jmux takes the first one that resolves and then leaves the
name alone — a name that changes while you are reading it is worse than one that
is merely not the best available. Ask for a new one with **Re-name session with
the model** in the palette.

### Grouping, sorting and filtering

Grouping and sorting are two independent axes: grouping decides how sessions
bucket into headers, sorting decides the order *within* a bucket.

| Key | Action | Cycles through |
|-----|--------|----------------|
| `Ctrl-a G` | Cycle grouping | `Flat` → `Project` → `Status` → `Stage` |
| `Ctrl-a s` | Cycle sort within a group | `Name` → `Activity` → `Status` |
| `Ctrl-a f` | Cycle filter | `All` → `Started` → `Needs you` → `Active` |

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
| Filter `Started` | Every session, but no [ghost rows](workflow.md#unstarted-work-in-the-sidebar) — the stage layout of the work that exists. Only bites under `Stage`, where ghosts sit inside each band; on the other axes they collect in one `Up next` band at the bottom and the mode is the same as `All`. |
| Filter `Needs you` | Only sessions whose agent is waiting on you. |
| Filter `Active` | Waiting *or* running — the sessions actually doing something. |

Four bands sit outside the grouping, in fixed positions:

- **Command Center** is always the first row.
- **Pinned** is the top group whenever any *session* is pinned. This is a
  different thing from pinning a *pane* to the Command Center — that one keeps a
  session on the grid and chooses the pane its tile shows, and has no effect on
  sidebar order.
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
  | `Ctrl-a \` | Hide / show the sidebar, as anywhere else |
  | `Ctrl-a g` | Leave the preview and open the panel — the two can't share the frame |
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
| `Ctrl-a b` | Open browser pane |
| `Shift-Left/Right/Up/Down` | Navigate between panes |
| `Ctrl-a Left/Right/Up/Down` | Resize pane (repeatable) |
| `Ctrl-a z` | Toggle pane zoom (⤢ shown in tab) |


Pane borders auto-show when a window has multiple panes and hide for single-pane windows.

### Browser panes

`Ctrl-a b` opens a real browser beside the current pane. The browser is
[terminal-browser](https://github.com/zenbu-labs/terminal-browser) by
[Zenbu Labs](https://github.com/zenbu-labs) (MIT) — a separate program jmux
spawns rather than bundles, so install it yourself:

```bash
curl -fsSl https://terminal-browser.sh/install | bash
```

It needs a terminal that can draw pictures (Ghostty, kitty, WezTerm). The
toolbar's `⊙` button appears only when both the program and the capability are
present; the keybinding always answers and says what is missing.

Once the pane is open, the browser has its own keys — these go to
terminal-browser, not to jmux:

| Key | Action |
|-----|--------|
| `⌘L` | Address bar (or click the active tab) |
| `⌘T` | New tab (or click `+` in the tab strip) |
| `⌘R` | Reload |
| `⌥[` / `⌥]` | Back / forward (`⌘` and `Ctrl` also work) |
| `⌘P` | The browser's own command palette |
| `⌘⇧F` | Find in page |
| `⌘⇧I` or `F12` | DevTools — `⌘⌥J` for the console |
| `⌘+` / `⌘−` | Zoom |

The browser's palette (`⌘P`) is also where mobile/tablet emulation and "close
pane" live. Mouse works throughout: click to navigate, scroll to scroll.

Agents drive browser panes through `jmux ctl browser` — `list`, `open <url>`,
and `action -- <command>` for snapshot/click/fill/eval. That indirection is not
decoration: `isolate` gives each pane a private registry, so `terminal-browser`
run directly from an agent's pane finds nothing. jmux knows which registry
belongs to which pane and points the CLI at it.

`Ctrl-a p` → **Open dev server in a browser pane** finds whatever the current
session is listening on and opens it. `jmux ctl dev-servers` is the same list as
JSON.

Five knobs in `~/.config/jmux/config.json`:

```json
{ "browser": { "paneSize": 0.62, "displayScale": 1, "fps": 60,
              "isolate": true, "openLinks": "system" } }
```

`paneSize` (0.2–0.95) is the fraction of the current pane the browser takes.

`displayScale` is the device pixel ratio it lays the page out at — jmux asks for
`1` so sites choose a desktop layout, because terminal-browser otherwise uses
the display's scale factor (2 on a Mac), which halves the CSS viewport and puts
a phone layout in a pane wide enough for a desktop one.

`fps` caps the frame rate. Left alone terminal-browser renders at the fastest
refresh rate among *all* attached displays, so a single ProMotion laptop panel
drives a pane on a 60Hz monitor at 120fps — and every frame is a whole-canvas
image the terminal has to decode and blit. Drop it to `30` if a browser pane
still makes the terminal feel heavy.

`isolate` gives each browser pane its own browser process, and is on by default.
Without it terminal-browser hosts every pane as a session of one process and
gives them all the same image id, so two browser panes draw the same page — the
sessions really are separate underneath, only the picture is shared. The cost of
isolating is that `terminal-browser ls` and `terminal-browser action` run from
another pane cannot see these browsers; turn it off to trade working multi-pane
rendering for cross-pane agent control.

`openLinks` decides where a clicked link goes: `"system"` (the default — your
real browser, unchanged) or `"pane"`, which navigates the browser pane in the
current window, opening one if there isn't one. It falls back to the system
browser whenever a pane isn't possible, because a click that opens nothing is
indistinguishable from a click that missed.

`displayScale` and `fps` can each be `"auto"` to hand that choice back to
terminal-browser. `paneSize` is always a number; a value it can't read falls
back to the default rather than to the smallest pane the range allows.

Nothing about this is browser-specific — jmux relays terminal graphics from any
pane, so image previews in file managers, plotting libraries and `imgcat` all
work in a pane too.

Shift-arrow pane navigation is smart-splits.nvim aware — if the active pane is running vim/neovim, the key is forwarded to vim instead.

---

## Command Center

A grid of live, drivable mirror tiles — one per session, borders colored by agent
state. Non-destructive: panes never leave their own session. Membership is
**derived**, not hand-placed: the grid shows whatever sessions the active view's
filter/group/sort would put in the sidebar, the same way the sidebar itself
derives its rows. Open it from the **Command Center** entry at the top of the
sidebar, or `Ctrl-a C` from anywhere.

| Key | Arm | Action |
|-----|-----|--------|
| `Ctrl-a C` | everywhere | Toggle the Command Center |
| `Ctrl-a P` | everywhere | In the grid: remove the focused session from it. In a session: add the current pane's session, showing this pane |
| `Ctrl-a ↵` | in the grid | Open the focused tile's session full-size, on its displayed pane |
| `Ctrl-a x` | in the grid | Cycle the focused tile's face — which pane of a multi-agent session it shows |
| `Ctrl-a z` | in the grid | Zoom the focused tile to full size, or restore |
| `Ctrl-a G` / `s` / `f` | in the grid | Cycle the grid's own grouping / sort / filter — independent of the sidebar's |
| `Ctrl-a D` | in the grid | Cycle tile density: comfortable / compact / overview |
| `Ctrl-a 1…9` | in the grid | Switch to view N |
| `Ctrl-a [` / `Ctrl-a ]` | in the grid | Previous / next view, wrapping |
| `Ctrl-a d` | in the grid | Detach jmux (not the focused tile) |
| Shift-arrows | in the grid | Move focus between tiles |
| Click a view chip | in the grid | Switch to that view |
| Mouse wheel | in the grid | Scroll the tile under the cursor |

**Density** picks the tile-size floor the grid packs against — `Ctrl-a D`
cycles **comfortable** (few large tiles, ~20 lines each — read and type into
one agent), **compact** (a middle ground), and **overview** (many small
tiles, a few lines each — a bird's-eye of what everyone's doing). The active
mode's name sits at the right end of the strip. Comfortable is the default:
one tile size can't serve both triage and driving, so the grid no longer
guesses which job you're doing.

**Why one tile per session:** tmux ties the current window and zoom to the
*session*, not the client, so two tiles can't show two panes of one session at
once by any arrangement of pins. A session with several agent panes shows one at
a time; `Ctrl-a x` cycles between them, and the focused tile's bottom border
names the position (`⌃a x agent 2/3`) so the others are a visible fact before
you press anything.

**Views** replace the old tab strip — a view is a named preset of the grid's own
filter/group/sort axes (not a hand-picked pane list), always visible along the
top as a strip of chips. Switching views adopts that view's axes outright,
discarding any live narrowing (a `·` marks the active chip when its axes have
drifted from what's saved); **Save current axes as view…** in the palette keeps
them instead. The grid ships one seeded view, **Active**.

Two exceptions layer on top of the derived set, both from the command palette
(`Ctrl-a p`) or `jmux ctl`: **Pin to Command Center** keeps a session on the grid
even when the view's axes wouldn't include it, and prefers this pane as the
session's face; **Unpin from Command Center** drops that preference. A session
removed from the grid with `Ctrl-a P` stays off it (via `@jmux-grid-hidden`)
until you bring it back — the palette's **Show hidden sessions (N)…** lists
every session currently hidden this way, so an exception is never invisible.
Hiding a session always wins over a pin left on one of its panes: hide's subject
is the whole session, a pin's subject is one pane in it, so pinning a pane can't
silently undo an explicit "keep this session off my grid".

An empty grid names the active view and how to widen it (`⌃a f  all sessions`,
`⌃a 1…9  switch view`), plus how many sessions are hidden.

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

**Available commands:** switch sessions, switch windows, new session/window, kill session, close window/pane, split a pane either way, open a browser pane, zoom pane, rename session, **re-name session with the model**, move window, open Claude, keyboard shortcuts, setup, Command Center (pin/unpin, save/rename/delete view, switch view, show hidden sessions), sidebar width, Claude command, project directories.

**Re-name session with the model** asks for a fresh title on demand — the
escape hatch for a [git-tier title frozen](configuration.md#session-titles-sessiontitle)
on the branch's first commit, or for retrying after a naming call failed. It
overrides a hand-typed rename too. Always in the list; it tells you instead of
renaming anything when `sessionTitle.command` isn't configured, or when the
session has nothing to name it from yet (no linked issue, no captured prompt,
no commits of its own).

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
| `p` | Send issue prompt to this session's agent |
| `{` / `}` | Previous / next issue in the preview strip |
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
| `Ctrl-a e` | Expand this session's issues in the sidebar |
| `Ctrl-a m` | Move this session's issues where the workflow says they should be |

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
