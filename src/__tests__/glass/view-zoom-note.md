# Manual regression: the Command Center against a real tmux server

`GlassView` attaches real tmux clients, so none of this can be a unit test
(project rule: tests never spawn tmux). The tile lifecycle either side of the
attach — identity, the cap, retarget's command order, the reconcile state
machine — *is* covered, by `tile-identity.test.ts`, `tile-plan.test.ts` and
`reconcile-loop.test.ts` against injected fakes. What's left here is the part
only a real server answers: whether the user's windows and zoom come back
intact, and whether an agent's `ctl pane pin` from an unfocused window is
actually seen.

Run it by hand after any change to `GlassView`, `glass/representative.ts`, or
the reconcile wiring in `main.ts`.

## 1. Two agent panes in one window — `Ctrl-a x` cycles them in one tile

Setup: one session, `tmux split-window` so it has two panes in one window; get
both panes reporting an agent kind (or `jmux ctl pane pin --target <id>` on
both, to force-on both — either qualifies them for the cycle).

- Open the Command Center (`Ctrl-a C`). **One tile appears, not two** — a tile
  is a session, so the second pane is another face for the same tile, not a
  tile of its own. It renders full-bleed.
- Focus the tile and press `Ctrl-a x`. The tile keeps its place, size and
  border; only the picture inside it changes, and the bottom border's hint
  updates its position (`⌃a x agent 2/3`). Press again to cycle back.
- Leave the Command Center (`Ctrl-a C` again). **No window is left zoomed** —
  both panes are side-by-side again, exactly as before entering. This is the
  one that catches a retarget that unzoomed the wrong pane — teardown must
  undo the zoom the tile *ended* on, not the one it started on.
- Re-enter the Command Center: the tile shows the same face it was left on.

## 2. Panes in two windows — one tile, no window fighting

Repeat with the session's two agent panes in *different* windows (`tmux
new-window` inside the session rather than a split).

- Same as above: one tile, `Ctrl-a x` cycles between the two panes. Cycling
  changes which window the session has selected — after cycling, the pane you
  were on before is no longer the one showing.
- Leave the Command Center. The session's currently-selected window has nothing
  zoomed. Switch to that session directly (outside the grid) and confirm its
  layout is exactly what it was before any of this — no pane moved, killed, or
  reparented.

## 3. More sessions than `commandCenter.maxTiles`

Set `commandCenter.maxTiles` low (e.g. `2`) in `~/.config/jmux/config.json`,
or start enough sessions to exceed the default (12), all matching the active
view's filter.

- Open the Command Center. Only `maxTiles` tiles render. The strip shows
  `+N not shown` for the rest — never silent truncation.
- Pin one of the excluded sessions (`Ctrl-a P` from inside it, or `jmux ctl
  pane pin`). It should now be admitted ahead of an unpinned session at the
  boundary — forced (pinned) tiles are kept first under overflow — without the
  rest of the grid visibly reordering itself.
- Let an admitted session go idle/complete past the view's filter. Within one
  reconcile it should be replaced by one of the previously dropped sessions,
  and `+N not shown` should decrement.

## 4. `Ctrl-a ↵` lands on the displayed pane

With at least one multi-pane-agent tile from step 1 or 2, cycle its face with
`Ctrl-a x` to the *non-default* pane, then focus it and press `Ctrl-a ↵`
(Enter).

- jmux should leave the grid and land you directly on the pane the tile was
  showing — not the session's otherwise-active pane, and not pane 0 of its
  window.
- Repeat after killing the pane the tile was showing (from another window,
  `tmux kill-pane -t <id>`) while still in the grid, *then* pressing
  `Ctrl-a ↵` on that tile. It should fall back to the session and its current
  active pane, with a notice rather than an error, rather than pointing at a
  pane that no longer exists.

## 5. `Ctrl-a C` with the pre-glass session killed

Enter the Command Center from a specific session (`Ctrl-a C`), then — from
another terminal or `jmux ctl session kill` — kill that originating session
while still in the grid.

- Press `Ctrl-a C` to leave. jmux must not strand the client on the internal
  `__jmux_park` session (an empty screen with no chrome). It should land on
  another live session (first in the current sidebar order) and show a notice
  that the original session is gone, or — if no session exists at all — stay in
  the grid with a notice rather than showing a blank screen.

## 6. `ctl pane pin` from an unfocused window

With a session that has two or more windows, run `jmux ctl pane pin --target
<pane-id>` against a pane in a window that is **not** the session's currently
selected one (and is not the window currently attached-to by any client).

- Without touching anything else, the Command Center should pick this up
  within one reconcile (no periodic poll exists — this is the nested `#{S:#{W:
  #{P:…}}}` pin subscription, which enumerates the whole server rather than
  only the current window). A tile for that session should appear (or, if it
  was already a tile, its face should move to the pinned pane) with no manual
  refresh, resize, or session switch required to trigger it.
