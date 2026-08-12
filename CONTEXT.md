# jmux — Domain Context

This file captures the domain language of jmux: the terms that are meaningful
when reasoning about the product, independent of implementation detail. Keep it
honest and current — when a term's meaning sharpens during design, update it here.

## Glossary

### Membership

Which sessions the Command Center shows. It is **derived, not curated**: the set
is the same one the sidebar would emit under the grid's own filter/group/sort,
so the two surfaces cannot disagree about what exists. There is nothing to set
up — an agent you start appears on the grid because it is a session, not because
anyone registered it.

**One tile per session, always.** Not a preference: a tile is a second tmux
client attached to the session, and two clients attached to one session share
that session's current window, while tmux's zoom is window-global. So the grid
physically cannot show two panes of one session at once. Seeing a session's
other agents is a *cycle* within its one tile, not a second tile.

### Pin (force-on)

An explicit "keep this session on the grid, and show me **this** pane in it".
Pane-scoped and non-destructive: `@jmux-pinned` on a pane, which does two things
— its session is a member whatever the current view's filter says, and that pane
is preferred as the session's **face**.

Note what a pin is *not*, since it used to be: it does not add a tile. Under one
tile per session it cannot. Pinning a second pane of an already-visible session
changes which pane you are looking at, not how many tiles there are.

### Hide (force-off)

The mirror of a pin: `@jmux-grid-hidden`, a **session**-scoped option meaning
"keep this session off the grid". Session-scoped because its subject is a
session; a pane-scoped hide would evaporate the moment the face moved to another
pane.

**Hide beats a pin in the same session.** The two exceptions have different
subjects — hide names the whole session, a pin names one pane in it — so "more
specific wins" does not apply. A rule where pinning any pane silently defeated
an explicit "keep this session off my grid" would make the hide untrustworthy.

### Face

The one pane a session's tile is currently mirroring. Elected from the session's
panes: an explicitly declared agent pane, else a pinned one, else the most urgent
pane that declares an agent kind, else the active pane. Within a tier, urgency
decides, then the active pane, then the lowest pane id.

The election is **stateless** — it answers "who represents this session right
now". Deciding when to *ask it again* is a separate, sticky rule: a tile keeps
its face until that pane dies, the user cycles it, or the pin set changes, so a
sibling agent changing state never moves the picture out from under someone
reading it.

### View

A **named preset of the session-list axes** — filter, grouping, sort — that the
grid is showing. `Active`, `Needs you`, whatever the user saves. Views live in
`~/.config/jmux/config.json` under `commandCenterViews`; the live axes are
`commandCenterAxes`, which can be nudged away from the selected view, at which
point the strip marks it as changed rather than continuing to name a view you
are not in.

A view is a **filter, not a bucket**. Nothing belongs *to* a view: switching one
re-selects from the same derived set. This is the distinction that replaced
Command Center *tabs*, which were hand-assigned buckets a pane was placed into.

**Agent surface.** Agents shape membership via the CLI — `jmux ctl pane
pin`/`unpin`/`pinned` and `ctl session hide`/`unhide`/`hidden` — riding the
existing "talk only to tmux" model, no IPC to the TUI. The boundary is
deliberate: **agents control Command Center *membership*, never the user's
*view*.** Pinning makes a session appear; it does not force the user's screen
into the grid. Looking at the Command Center is always the human's choice.

### Command Center

A single view that renders *all currently pinned panes at once*, so the user can
watch and **drive** several parallel agents without switching between them one at
a time. Contrast with the default single-session view, where exactly one session
occupies the main area and the user toggles between sessions via the sidebar or
hotkeys.

Every tile is fully **live and interactive** (not a snapshot): each is a real
attached tmux client, so keystrokes routed to the focused tile drive that pane
for real. (This is the deliberately harder of the two possible designs; a
read-only polling dashboard was rejected — driving the agents is the point.)

### Command Center entry

A permanent, synthetic entry at the **very top of the sidebar** — always present.
It is *not* a session; it is a view selector. Selecting it enters the Command
Center. Selecting any real session leaves the glass and shows that session
full-screen. This makes the sidebar's "active selection" no longer always a
session id: it is either a session id **or** the Command Center sentinel.

The entry's sidebar block shows **counts only — never a per-pane list**:

- A bold header `⌘ Command Center · N` where `N` is the number of pinned/surfaced
  panes.
- A colored **agent-state breakdown** line — `n RUN / n WAIT / n DONE` — using
  the sidebar agent-state palette (running = green, waiting = yellow,
  complete = blue).

While the Command Center is selected the entry gets the active-selection chrome
(the `ACTIVE_BG` highlight and the `▎` marker), exactly like a selected session.

### Tile

One cell of the Command Center. A tile is a **live mirror** of one pinned pane: a
second real tmux client attached directly to that pane's **own session**
(`TmuxPty` strictAttach → `tmux attach-session`), with its own xterm.js
`ScreenBridge`. The pane is shown full-bleed via a **transient zoom**
(`resize-pane -Z`) applied only while in the Command Center and only when the
pane's window has sibling panes; the zoom is restored on teardown. Teardown only
**detaches** the client — it never runs `new-session` or `kill-session` — which
is what keeps tiles non-destructive.

**A tile must look and behave like a native tmux pane.** Specifically:

- **jmux draws the tile chrome itself** (tmux cannot, because the tiles span
  separate sessions): a border box per tile.
- **A label chip top-left** showing `session › pane-title` (or
  `command · cwd-basename`), styled like the toolbar tabs.
- **The border color encodes the pane's agent state** — running = green,
  waiting = yellow, complete = blue (matching the sidebar palette); a pane with
  no agent state uses bright-white. **Focus is shown via weight**: the focused
  tile's border is **bold**, unfocused tiles are **dim** (bright-white panes use
  bright-white focused / gray unfocused).
- **Each tile scrolls independently.** Because every tile is its own attached
  tmux client, scrollback / copy-mode is naturally per-tile — wheeling over one
  tile scrolls only that tile.

**Deterministic order.** Tiles are ordered by **session name, then pane id**, so
the grid stays stable across detach/reattach and refreshes.

### Tile focus & navigation

The Command Center is navigated as if the tiles were tmux panes:

- **Click a tile → it gets focus** (input-router hit-tests tile rectangles).
- **`Shift+arrows` move focus between tiles**, directionally. jmux *intercepts*
  these while the glass is up.
- **Keystrokes route to the focused tile's client**, driving that agent for real.
- **Mouse events (wheel + press / drag / release) forward to the tile under the
  cursor**, so scrollback and tmux copy-mode text selection work per-tile.

### Layout (width-floored columns)

Tiles are arranged in `columns = floor(mainWidth / minTileWidth)` columns
(`minTileWidth` ≈ 80 to keep agent TUIs legible), clamped to the tile count, with
rows added as needed. A narrow terminal degenerates to a single full-width column
(vertical stack); an ultrawide terminal uses 2–3 columns. Tiles never shrink
below the width floor; when tiles overflow the screen, **the grid scrolls
vertically** and the focused tile is kept in view. Only **visible** tiles parse
(P2) — off-screen tiles are paused.

### Auto-pin agent panes

An optional setting, "Auto-pin agent panes to Command Center". When enabled, the
grid auto-surfaces every detected agent pane without a manual pin:

- the **active pane of any session that has `@jmux-agent-state` set** (catches
  Claude), plus
- panes whose `pane_current_command` matches a configurable, case-insensitive
  regex (default `codex`) (catches Codex).

Auto-detected panes are **unioned with manual pins on each refresh** and are
**never written to `@jmux-pinned`**, so the option stays a clean record of
explicit pins. Auto-pin is a convenience layer on top of the core model, which is
that users pin panes explicitly.

### Agent state

Per-pane agent state (`@jmux-agent-state`: running / waiting / complete, set by
the agent hooks) is not a *pinning* mechanism, but it drives three things in the
Command Center: the **breakdown line** on the Command Center entry, each **tile's
border color**, and **auto-detection** of agent panes when auto-pin is enabled.

### Mutually-exclusive viewing rule

A pane's session is shown **either** in the Command Center **or** full-screen in
the single-session view — never both at once. This is enforced structurally by
the singular sidebar selection (Command Center sentinel **xor** session id) and
by **parking**: while the glass is up the real (main) client is parked on a
hidden `__jmux_park` session, so the tile clients' window sizes don't constrain
the real sessions. On exit the main client is restored. There is no state in
which both views are live.

### Repo settings

The small set of workflow settings that describe **how work is spun up and run
in a given repo**, rather than how the jmux UI looks. A repo's settings are
resolved through three tiers, each overriding the one above:

```
hardcoded default  →  repo defaults (global)  →  repo override (this repo)
```

The overridable settings are: **default base branch**, **wtm integration**,
**auto-launch agent**, **session name template**, and **claude command**. The
global tier (`repoDefaults`) is what applies to every repo that has no explicit
override; the per-repo tier (`repos`) holds overrides for one specific repo.

A repo is identified by the **canonical path of its main worktree root** — every
worktree of a repo resolves to the *same* key, so an override set on a repo
applies no matter which worktree session you're in. The wtm **project** name
(bare-repo basename) is only a display label, never the key. **Nothing is stored
in the repo itself** — all repo settings live in jmux's own config file, exactly
like every other setting.

Settings that are about the jmux **UI/chrome** (sidebar width, colors, tabs,
panels, …) and the cross-repo **routing/discovery** index (`projectDirs`,
`teamRepoMap`) are *not* repo-overridable — a per-repo override of "where do I
scan for repos" or "which team maps to which repo" is a contradiction. The code
host / issue tracker **adapters** are also global: they are constructed and
authenticated once at startup and drive a single cross-repo issue/MR panel that
has no "current repo".

### wtm integration (per-repo)

Whether a repo is a **wtm-managed bare repo with worktrees**. This is a property
of the repo, not a global preference, so it is a repo setting. It governs *how* a
new worktree is created for that repo:

- **on** — `wtm create <session> --from <baseBranch>` (wtm manages the bare repo
  and its worktrees).
- **off** — `git worktree add` against the repo directly (isolated worktrees,
  without wtm's bare-repo management).

Every session/issue always gets its **own worktree** — wtm integration selects
the creation mechanism, never whether a worktree exists.
