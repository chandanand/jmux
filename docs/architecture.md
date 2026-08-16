# Architecture

jmux is **not** a tmux replacement. It drives a real tmux process and composites its own UI chrome — a sidebar and toolbar — around tmux's terminal output. Your panes, windows, and sessions are ordinary tmux; jmux owns the surface they're drawn on.

```
Terminal (Ghostty, iTerm, etc.)
  +-- jmux (owns the terminal surface)
       +-- Sidebar (26 cols) -- session groups, indicators, pipeline glyphs
       +-- Border (1 col)
       +-- Main area (remaining cols)
       |    +-- Toolbar (row 0) -- window tabs (left), action buttons (right)
       |    +-- tmux PTY (remaining rows)
       |         +-- PTY client ---- @xterm/headless for VT emulation
       |         +-- Control client - tmux -C for real-time metadata
       +-- Info Panel (optional, split/full)
       |    +-- Tab bar ------------ Diff | Issues | MRs | Review
       |    +-- hunk PTY ----------- @xterm/headless (Diff tab)
       |    +-- Panel views -------- grouped/sorted item lists (other tabs)
       +-- Adapters
       |    +-- Linear ------------- issues, statuses, comments (GraphQL)
       |    +-- GitLab ------------- MRs, pipelines, approvals (REST)
       |    +-- GitHub ------------- PRs, check runs, approvals (REST + GraphQL)
       |    +-- Poll coordinator --- tiered polling, rate-limit backoff
       +-- jmux ctl (JSON API, used by agents inside sessions)
            +-- session / window / pane / run-claude
```

## The two-channel tmux model

Every running jmux instance talks to tmux in two ways at once:

1. **PTY client** — spawns `tmux new-session -A` in a real pty. Restored and explicitly named sessions are targeted directly; with no user sessions, the target is the hidden `__jmux_park` session so jmux can open the Command Center without fabricating a visible session `0`. This is the interactive client that receives keystrokes and produces the terminal bytes the user sees.
2. **Control client** — a separate `tmux -C attach` subprocess speaking tmux's control-mode protocol. Used for structured metadata (list-sessions, list-windows) and real-time events.

These are two different tmux *clients* attached to the same *server*.

## The rendering pipeline

```
tmux PTY bytes -> ScreenBridge (@xterm/headless) -> CellGrid -> Renderer -> stdout
                                                       ^
                         Sidebar / Toolbar / Modal overlays composited in
```

jmux feeds raw PTY bytes into a headless xterm.js terminal, reads back a grid of cells, then composites the main grid + sidebar + toolbar + optional overlays into a single frame and emits SGR codes to stdout.

Because jmux is the **outermost** program on the terminal — tmux runs inside a pty it owns — it can also speak the terminal's graphics protocol directly, with no multiplexer passthrough in the way. That is what lets a screenshot attached to an issue render as an actual picture in the info panel; see [Images in issue previews](issue-tracking.md#images-in-issue-previews). Images ride the same cell grid as everything else: a picture reserves cells that carry a mark, and the graphics layer reads its work back off the finished frame — so scrolling, clipping and occlusion by a modal are handled by the code that already does those things to text.

No opinions about what you run inside tmux. If it runs tmux, it runs jmux.

For a deeper tour of the internals — the control-mode subtleties, input routing, modals, adapters, and the agent-control CLI — see [`CLAUDE.md`](../CLAUDE.md) at the repo root.
