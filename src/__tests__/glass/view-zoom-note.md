# Manual regression: zoom ownership across a face move

GlassView attaches real tmux clients, so this can't be a unit test (project
rule: tests never spawn tmux). The tile lifecycle either side of the attach —
identity, the cap, retarget's command order — *is* covered, by
`tile-identity.test.ts` against an injected pty. What is left here is the part
only a real server answers: whether the user's windows are handed back intact.

Run it by hand after any change to GlassView tiling.

## Setup
1. Create a session with TWO panes in ONE window: `tmux split-window`.
2. Pin BOTH panes: `jmux ctl pane pin --target %A`, `jmux ctl pane pin --target %B`.
3. Open the Command Center.

## Steps
- One tile appears, not two: a tile is a session, so the second pane is another
  face for the same tile rather than a tile of its own. It renders full-bleed.
- Move the face to the other pane. The tile keeps its place, its size and its
  border; only the picture inside it changes.
- Leave the Command Center.

## Pass criteria
- No window is left zoomed: both panes are side-by-side again. This is the one
  that catches a retarget which unzooms the wrong pane — teardown must undo the
  zoom the tile *ended* with, not the one it started on.
- No pane is moved, killed or reparented (the non-destructive invariant).
- Re-entering the Command Center shows the same face it was left on.

## Second window
Repeat with the two panes in DIFFERENT windows of one session. The face move
then also changes which window the session has selected — on leaving, the
session should be looking at a window with nothing zoomed.
