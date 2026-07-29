# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

jmux is a tmux-wrapping TUI for running multiple coding agents in parallel. It replaces tmux's status bar with its own sidebar (session list) and toolbar (window tabs + actions). Target runtime is **Bun 1.3.8+** (uses `Bun.markdown.ansi()`), not Node. Requires tmux 3.2+ at runtime.

~6600 lines of TypeScript across core (`src/`) and CLI (`src/cli/`). No bundler — the `bin/jmux` shim runs `src/main.ts` directly under Bun.

## Commands

```bash
bun run dev                # Run jmux from source (src/main.ts)
bun test                   # Run all tests
bun test src/__tests__/sidebar.test.ts   # Run a single test file
bun test -t "group label"                # Filter tests by name
bun run typecheck          # tsc --noEmit (strict mode)
bun run docker             # Build + run Dockerfile.test for a clean-env sanity check
bun run src/main.ts ctl --help           # Show agent control CLI help
bun run src/main.ts ctl session list     # List sessions (JSON)
```

There is no build step for running — `bin/jmux` is `import "../src/main.ts"`. The `dist/` dir is only produced by `tsc` and is not shipped in the npm package (see `package.json` `files`).

The published binary is installed with `bun install -g @jx0/jmux`. The `jmux --install-agent-hooks` subcommand installs state emitters into every supported agent found on the machine — see "Agent state tracking" below.

## Architecture

jmux is **not** a tmux replacement — it drives a real tmux process via two channels and composites its own UI chrome around tmux's terminal output.

### The two-channel tmux model

Every running jmux instance talks to tmux in two ways simultaneously:

1. **PTY client** (`src/tmux-pty.ts`) — spawns `tmux new-session -A` in a real pty via `bun-pty`. This is the interactive client that receives keystrokes and produces the terminal bytes the user sees.
2. **Control client** (`src/tmux-control.ts`) — a separate `tmux -C attach` subprocess speaking tmux's control-mode protocol (`%begin`/`%end` blocks, `%sessions-changed`, `%client-session-changed`, etc.). Used for structured metadata (list-sessions, list-windows) and real-time events.

These are two different tmux *clients* attached to the same *server*. Several subtleties fall out of this that any change in this area must respect:

- Responses on the control channel carry a `flags` field. `flags=1` means "this is a reply to a command sent by this client"; `flags=0` is noise from other clients or the initial attach. `TmuxControl` filters on `flags === 1` (see `tmux-control.ts:166`).
- `%client-session-changed` is authoritative for the PTY client's current session. `%session-changed` on the control channel refers to the *control* client and is deliberately ignored during normal operation (see the event handler in `main.ts` around line 1711).
- Session switches must target the PTY client by name: `switch-client -c <ptyClientName> -t <session>`. The name is resolved by matching `list-clients` entries against the PTY's PID in `resolveClientName()` (`main.ts:582`).
- `refresh-client -f no-output` is sent at control startup to suppress `%output` notifications so they don't flood the parser.

### The rendering pipeline

jmux owns the terminal surface. Every frame flows through:

```
tmux PTY bytes → ScreenBridge (@xterm/headless) → CellGrid → Renderer → stdout
                                                         ↑
                           Sidebar / Toolbar / Modal overlays composited in
```

- **`src/screen-bridge.ts`** — feeds raw PTY bytes into a headless xterm.js terminal and reads back a `CellGrid` (2D array of `Cell` with fg/bg/mode/bold/italic/underline/dim). This is the ground truth for what tmux thinks the screen looks like.
- **`src/cell-grid.ts`** — owns the `Cell` shape, the `cellWidth` Unicode width table, and grid construction helpers. The width table must agree with `charDisplayWidth` in `renderer.ts`; they're both used for column tracking and drift here causes visible ghost gaps.
- **`src/renderer.ts`** — composites the main grid + sidebar + toolbar + optional modal overlay into a single frame, then diff-free emits SGR codes to stdout. Only re-emits SGR when attributes change between adjacent cells. After wide (width=2) cells it explicitly repositions the cursor to prevent drift between xterm.js's width model and the real terminal. Terminal graphics are emitted from the *finished* composite, after its text and before the cursor is parked — see "Terminal graphics" below; a frame that can't be diffed is a resize, which is why the plane is reset there.
- **`src/sidebar.ts`** — the left 26-col (configurable) panel listing sessions with groups, activity dots, attention flags, hover states, scrolling. Grouping prefers a session's wtm `project` (bare-repo basename) over directory path matching. The `stage` grouping axis buckets sessions by the user-defined workflow stage claiming their linked issue's status — resolution needs the tracker poll and `panelViews`, so it happens in `main.ts` (`recomputeSessionBands`) and arrives pre-resolved via `setSessionStages()`, the same shape of dependency as `setParkedSessions()`. `sidebar.ts` itself stays free of tracker and config knowledge.
- **Ghost rows (`src/ghosts.ts`)** — the sidebar's one deliberate exception to being a truthful mirror of tmux: rows for issues that have *no* session yet. They earn that by being convertible — clicking one opens the **ghost preview** (`src/ghost-preview.ts`), whose Enter runs the same `startWorkOnIssue` flow as `n` in the issues panel, turning the row into the row it was already drawn as (which is why a ghost uses a session row's exact two-row geometry).

  **There are two placements, and the grouping axis picks between them.** Grouped by stage, every stage band shows the work sitting in it that nobody has picked up, below that stage's sessions. On every other axis there are no stage bands, and an issue with no session has no project, no agent status and no activity to bucket on, so the rows collect into one flat "Up next" band fed by `pipeline.upNext`. `recomputeGhosts` reads `sidebar.getGroupMode()` to decide, so changing the axis has to rebuild the set, not just re-place it. One `selectGhosts` serves both: **the cap is per stage on either placement** and rows are always stage-tagged, so the sidebar files them by tag when banding by stage and ignores the tag when not. The cap briefly differed by placement, which made one setting mean two things — "3" read as three altogether or three *each* depending on a grouping mode the setting never mentioned. Hence `formatGhostCap` saying "3 per stage" outright.

  Four things are load-bearing. **A ghost carries its stage's label and rank**, because a stage holding only ghosts still gets a band and there is no session there to name its header. **Ordering is stage rank, never `upNext` order** — `upNext` records add-sequence, and letting it drive the sidebar would put two contradictory orders of the same stages on one screen. **Done and parked issues are never ghosts**, or a "Done" stage accumulates rows forever with no way to clear them. **The count is the on switch** (`pipeline.showUnstartedInSidebar` — a number, `"all"`, or null/0 for off; off by default), so no second boolean can disagree with it; `"all"` is stored as a literal, not `Infinity`, because `JSON.stringify` writes `Infinity` as `null` — this field's "off" — so the setting would silently switch itself off on the next save.

  **Per-stage, two flags on the `PanelView` gate this** (`s` and `space` in the workflow screen): `inSidebar` decides whether the stage draws a band at all, and `showUnstarted` — nested under it — whether that band carries ghost rows. Both default to on, and only `false` is ever stored, so an untouched config and a config that says "the default" are the same file. Hiding a stage hides its *header*, never its sessions: `recomputeSessionBands` simply declines to assign them a stage, so they fall to the flat remainder exactly like a session whose status no stage claims. A stage setting must never be able to make a waiting agent vanish from the one always-visible surface.

  **`showUnstartedInSidebar` is the master switch and the per-stage flags are exceptions to it**, which means the master can make a per-stage toggle moot — press `space`, watch the row change, and the sidebar does nothing. That is the exact failure the workflow screen exists to prevent, so the screen reads the cap back through `WorkflowPort.unstartedCap()` and a stage row states "off globally" (naming the setting and where it is) instead of reporting a preference that currently has no effect. The per-stage opt-out is preserved while the master is off, not cleared, so switching the master back on restores what the user chose. Any future setting that can be overridden by another owes the same disclosure.

  Ghosts stay out of `displayOrder` — that array means *sessions*, and callers asking for it get sessions — but they are full stops in `getNavOrder()`, which is what Ctrl-Shift-Up/Down walks. They were once excluded from navigation too, because landing on one provisioned a worktree and a nav key that did that would be a destructive surprise; the preview removed the destructiveness, and with it the only justification the exclusion ever had. **When a constraint's stated reason stops being true, delete the constraint rather than inheriting it.** Ghosts are still suppressed entirely under a filter (both filters select on agent state, which a ghost has none of), and an unemitted row is not a nav stop. Selection, ordering and cap all resolve in `main.ts` and arrive via `setGhostSessions()`, the same boundary as `setSessionStages()`.
- **Ghost preview (`src/ghost-preview.ts`)** — the fourth full-area surface, alongside settings, workflow and glass. Shows an unstarted issue *and* its pre-flight: the session/branch name, worktree path, base branch, worktree tool and agent that Start would use, all resolved by `ghost-preflight.ts` before anything is provisioned. The primary action reads Start / Resume / Switch from the same three states `startWorkOnIssue` branches on, so the label cannot disagree with the behaviour.

  Four rules hold it together, and each was a bug first:

  **The poll never closes the preview — only the user does.** It pins an issue *id*, not a ghost row, and re-resolves content each frame. The issue gaining a session, changing status, being filtered away, or leaving the ghost set entirely all leave the surface open; only the last is even visible, as a "no longer available" state. Any other rule produces "the screen vanished while I was reading it".

  **The rail marks the row whose content fills the main area** — not the attached session. That is why a ghost can own it (`setFocusedGhost`) and why `applySessionRail()` exists: the rail is written from *two* places on the authoritative `%client-session-changed` path, and guarding one but not the other is indistinguishable from guarding neither. `currentSessionId` still tracks tmux; only the rail is withheld. The focused issue may have no emitted row at all (filtered, collapsed, or sidebar hidden below `SIDEBAR_MIN_TERM_COLS`) — the surface deliberately outlives its row.

  **`closeModal()` must hand routing back to `inputConsumerActive()`, not clear it.** The preview is the first surface to host a real modal (the status picker); settings and workflow paint their own prompts, which is why blindly clearing had never fired before. Modal results call `closeModal()` before their callback and SIGWINCH calls it too, so both paths left the surface painted and deaf with the next keystroke leaking to the pty.

  **The preview owns the unpark when it is opened out of glass.** `exitGlass()` deliberately does not switch sessions — its contract puts that on the caller — and a ghost is not a session target, so `leaveGlass()` cannot reach one. Opening from glass therefore leaves the client parked (invisible, since the preview paints the whole main area) and settles the debt on close, targeting `preGlassSessionId`, which `enterGlass()` captures *before* parking because parking rewrites `currentSessionId` to the internal session.

- **`src/main.ts` `makeToolbar()` / renderer's toolbar logic** — the top row: window tabs on the left, action buttons (new window, splits, Claude, settings) on the right.

Rendering is coalesced to ~60fps via `scheduleRender()`. `writesPending` gates rendering while `ScreenBridge.write()` promises are still resolving, otherwise we'd render mid-write and tear frames.

### Input routing

**`src/input-router.ts`** sits between raw stdin and the PTY. It:

- Parses SGR mouse sequences (`\x1b[<...M`) and dispatches clicks/hovers to sidebar / toolbar / main area based on x-coordinate relative to `sidebarCols`. Mouse events in the main area have their x translated and forwarded to tmux so tmux's own mouse support keeps working.
- Implements a **soft prefix intercept**: `Ctrl-a` is forwarded to tmux as normal, *but* if the next byte is `p` / `n` / `i` within a short window, jmux intercepts it to open the palette / new-session modal / settings instead of letting tmux handle it. This is why the prefix key is still customizable via `~/.tmux.conf` — we piggyback on whatever tmux's prefix is by listening for the literal `\x01` byte that `Ctrl-a` produces. If a user rebinds their tmux prefix, the intercept needs to be thought about.
- Handles `Ctrl-Shift-Up/Down` (`\x1b[1;6A` / `\x1b[1;6B`) directly for session switching — these never reach tmux.
- Owns **drag** on three resize handles via `src/drag.ts`: the sidebar border column, the split panel divider, and the info panel's list/detail separator. The first two are vertical lines that move horizontally; the third is horizontal and moves vertically (`handleAxis`), which is why the controller tracks a single scalar `pos` rather than a column. Three invariants hold this together and are easy to break by accident:
  1. **Press decides ownership, and commits nothing.** A press on a handle is genuinely ambiguous between a click and a drag until the next event arrives, so a handle's click behaviour fires on release-without-motion — that's why the divider's focus toggle lives in `dispatchDrag`'s `click` case and *not* at the press site it used to occupy.
  2. **A live drag bypasses all column routing.** One drag routinely crosses the sidebar, main, and panel; every mouse event goes to the drag until release, checked before row classification. Without this a drag reads as a sidebar click or leaks into the pty.
  3. **Live resize is throttled, and `applyChromeLayout()` must not cancel the drag.** A drag relayouts on each tracked movement, coalesced to ~30fps by `scheduleDragResize()` so a fast drag can't fire a tmux resize per pointer event. Because those relayouts run *through* `applyChromeLayout()`, cancelling a drag there would abort it on its own first motion — SIGWINCH cancels instead. `main.ts` assigns the module-level width *before* `configStore.set`, so the config watcher sees no change and doesn't fire a second resize.

  Note that drag needs no new terminal capability: `?1003h` is already enabled at startup, so motion events were always arriving — they were simply discarded.

  The panel split is the one handle whose geometry isn't in `FrameLayout` — the panel owns its own internal row layout — so main.ts supplies it through the `panelSplit` option, the same shape of dependency as `glassStripRows`. That layout lives in `computeViewLayout` (`panel-view-renderer.ts`), which is the single source of truth for the `[filter bar] | list | separator | detail | action bar` bands; main.ts used to re-derive it with a formula that ignored the filter bar, so clicks near the boundary mis-routed whenever a filter was active.

  Related: `handleInput` splits merged mouse chunks up front (`parseSgrMouseChunk`). The kernel merges mouse reports into one read whenever jmux falls behind — which a live drag reliably causes — and every mouse path matches a *single* anchored report, so an unsplit chunk would leak raw escape bytes to the pty.

### Modals

Modals implement the `Modal` interface in `src/modal.ts` and are rendered as an overlay by the main renderer. When a modal is open, `InputRouter` routes input to `onModalInput` instead of the PTY. Existing modals: `CommandPalette`, `InputModal`, `ListModal`, `ContentModal`, `NewSessionModal`. Each returns `{type: "consumed" | "closed" | "result"}` from `handleInput`.

### Agent control CLI

`src/cli/*.ts` implements the `jmux ctl` subcommand — a structured JSON API for agents running inside jmux sessions to manage sibling sessions, windows, and panes programmatically. Subcommands: `session` (list/create/kill/rename/switch), `window` (list/create/select/kill), `pane` (list/split/send-keys/capture/kill), `run-claude` (dispatch Claude Code in a new session).

All output is JSON to stdout. Context resolution (`src/cli/context.ts`) auto-detects the current tmux socket and session from the environment, or accepts `--socket` / `--session` flags.

The skill file `skills/jmux-control.md` documents usage patterns for agents — it's loaded as a Claude Code skill so agents inside jmux can discover and use the CLI.

### Diff panel

**`src/diff-panel.ts`** provides an integrated hunk diff viewer that docks to the right side of the terminal or zooms to full width. It spawns an external `hunk` process and captures its output. The panel has focus toggling (keyboard input routes to hunk when focused) and survives session switches by re-spawning.

### Agent state tracking

The sidebar's RUNNING / WAITING / COMPLETE badges come from four tmux user
options. **The options are the protocol** — nothing downstream knows which agent
wrote them, so supporting a new agent means adding an emitter, never touching
the tracker.

| Option | Scope | Written by | Meaning |
| --- | --- | --- | --- |
| `@jmux-agent-state` | **pane** | agent emitter | `running` / `waiting` / `complete` |
| `@jmux-agent-state-since` | **pane** | agent emitter | epoch seconds, drives the elapsed timer |
| `@jmux-agent-kind` | **pane** | agent emitter | `claude` / `codex` / `pi` |
| `@jmux-agent-pane` | session | agent emitter | the pane to send keys to (`ctl agent state`) |

Three things about this are easy to break:

- **State is pane-scoped, and that is load-bearing.** A session can host several
  agents in splits; a session-scoped option would let the last writer clobber
  its siblings. `AgentStateTracker` keys on pane id and rolls panes up to a
  session with `outranks()` (`agent-state-rollup.ts`) — waiting > running >
  complete, ties to the earliest `since` so the timer tracks the oldest agent.
  That helper is shared with `cli/agent.ts` and `cli/status.ts` so a session is
  never summarised two different ways depending on who asked.
- **A pane-context read of a session option inherits; `show-option -p` does
  not.** This asymmetry is used deliberately in both directions. Inheritance is
  what lets a session-scoped writer (an old install, or the snapshot restore
  path) keep working with no flag day — every pane reports the session value and
  the rollup collapses it back. The non-inheriting `show-option -p` is what the
  idempotent `PreToolUse` guard reads, so a legacy install promotes itself to
  pane scope on the first tool call.
- **`@jmux-agent-kind` is the only trustworthy pane-level identity.** Because
  `@jmux-agent-state` inherits, "session has state" is true of every pane in
  that session including editors and shells. Nothing writes `kind` at session
  scope, so it has no inheritance source. `glass/auto-detect.ts` depends on this.

Emitters live in `src/agent-hooks/`. Claude Code and Codex share
`json-hooks.ts` outright — Codex 0.145 accepts the same PascalCase event names
in the same document shape, just at `~/.codex/hooks.json`. Codex additionally
needs `[features] hooks = true` (`codex-toml.ts` splices it in and re-parses to
verify before writing) and prompts the user to trust new hooks; jmux does not
synthesise those `trusted_hash` values. pi has no shell hooks at all, so
`pi-extension.ts` is shipped as an asset and registered in pi's
`settings.extensions`. **pi cannot report `waiting`** — its extension API
exposes no permission event — which is what `AgentIntegration.reports` records.

`agent-screen.ts` is the last-resort tier for agents with no integration at all:
it reads pane text and matches per-agent regex signatures. It is opt-in
(`agentScreenDetection`), its table is config-extendable, and `screenTierMayWrite`
forbids it from overwriting a state the agent reports itself — a guess must
never displace a fact. Only add a built-in signature you have read off a real
terminal; an unverified pattern produces a confident wrong answer instead of an
honest blank.

### Terminal graphics (inline images)

`src/images/` draws real pictures for standalone images in issue descriptions
and comments, using the kitty graphics protocol. It works at all because **jmux
is the outermost program**: it composites its own chrome and writes to the real
terminal, with tmux inside a pty it owns. None of this goes through tmux, so
none of tmux's passthrough rules apply. jmux launched inside *another*
multiplexer simply gets no answer to its probe and the feature stays off, which
is the correct outcome rather than a case to special-case.

**One switch, no degraded mode.** `setImagePort(null)` is the entire off state,
and with no port `renderMarkdownBlocks` doesn't extract images, so the fallback
is the *same* linkify path that predates any of this. A terminal that can't
draw, one that never answers, and a user who turned it off are all one code
path — there is no second rendering mode to keep working.

**Marks live on cells, and that is load-bearing.** An image is `rows` ordinary
`DetailLine`s, each painting `cols` blank cells that carry an `ImageMark`
(`types.ts`). `images/plane.ts` then reads the placements back off the
*finished composite*. This is why scrolling, clipping at a pane edge, the
blit offset and occlusion by a modal all work with no image-specific code:
they already work on cells. Two consequences to preserve:

- **Writing text over a cell clears its mark** (`writeCell`/`writeString`), and
  the modal dimming loop clears marks outright. That is the occlusion signal.
  Terminals draw graphics *over* text, so an image a modal half-covered would
  render on top of the modal; and since an image can't be dimmed, one left
  behind a dimmed screen would be the only bright thing on it.
- **The cells under a picture carry its URL**, so the existing link-click path
  (`getLinkAt` over the composited frame) opens it with no knowledge that images
  exist. Drawing an image must never remove an affordance the link had.
- **A whole image row must survive to be drawn.** `scanFrameForImages` requires
  every cell of a row to carry the same mark, so a partly occluded row drops
  out and the surviving rows — always contiguous — become a crop. Partial
  scroll and partial occlusion are the same case, handled once.

**Two probes, both optional.** The capability probe (`a=q`) is the only command
sent without `q=2`, because it's the one whose reply we want; `stdin-gate.ts`
peels replies out of stdin while armed, and is armed only around a probe —
it holds a partial APC across reads, and an unbounded hold on input is not
something to leave on for the life of the process. A split *CSI* reply is
deliberately *not* held: holding a partial `ESC [` would swallow a lone Escape
keypress, and losing the cell geometry costs an aspect-ratio guess while losing
Escape costs the user their way out of a screen.

**The terminal is half the cache.** An id in `ImageStore` is an id the terminal
holds data under, so ids are never reused and eviction has to tell the terminal
to free the data — hence `takeFreedIds()`, pulled by the plane so the delete
travels in the same write as the rest of the frame. Ids are seeded from the pid
so two jmux instances in one terminal don't transmit over each other.

Lookups happen *during render* (`buildIssueDetailLines` has nowhere to await),
so `request()` is synchronous and must never re-enter a fetch for a URL it has
seen — **including a failed one**, or an open preview would hammer the tracker
at 60fps. Credentials are allowlisted by host, never by which tracker the issue
came from: issue text is written by anyone who can comment.

### OTEL receiver

**`src/otel-receiver.ts`** listens for OpenTelemetry spans from Claude Code to extract cache read/write timing. This drives the cache timer display in the sidebar's session status. It binds a local HTTP server that accepts OTLP trace exports.

### Config layering

jmux's config layering for tmux is **three-tier** and order matters:

```
config/defaults.conf   ← jmux opinionated baseline
~/.tmux.conf           ← user overrides
config/core.conf       ← jmux requirements, sourced LAST, always wins
```

See `config/tmux.conf` for the loader. `core.conf` enforces the small set of settings jmux depends on: `mouse on`, `detach-on-destroy off`, `status off` (we render our own toolbar), pane border titles, and auto window naming. Do not add new settings to `core.conf` unless they're genuinely required for jmux to function.

jmux's own settings live in `~/.config/jmux/config.json` (sidebar width, claude command, project dirs, wtm integration). The file is watched; sidebar-width changes hot-apply without restart.

## Things to know when editing

- **Target Bun, not Node.** Code uses `Bun.spawn`, `Bun.spawnSync`, `Bun.$`, `FileSink`-style stdin writes, and `bun-pty`. Don't replace these with Node equivalents or add a Node-targeted build.
- **The session sanitization rule.** tmux session names reject `.` and `:`. Worktree creation uses `sanitizeTmuxSessionName` once and reuses that single name for the worktree directory, the `wtm create` argument, *and* the tmux session. Splitting these creates drift between the directory on disk and the session name. See `main.ts:1217` and commit `f43c5c1`.
- **Wide characters.** Column bookkeeping is sensitive. Any new code that writes to a `CellGrid` needs to handle width-2 cells by leaving a width-0 continuation cell after them. See existing patterns in `renderer.ts` toolbar rendering and `sidebar.ts`.
- **OSC 52 clipboard passthrough.** `forwardOsc52` in `main.ts` buffers across chunked PTY data so copy sequences survive split reads. Don't replace it with a naive regex scan.
- **`main.ts` is the one file no unit test can reach**, because it spawns tmux at import time and so cannot be imported. `src/__tests__/boot-smoke.test.ts` is the suite's single integration test and covers exactly that gap: it boots jmux under a real pty and asserts it is still alive six seconds later. It exists because the gap shipped a bug — a function defined near the top of main.ts and *called* at module scope reached a `let` declared 1500 lines below and died in its temporal dead zone before the first frame. tsc can't see that (the access is through a call, not a direct reference) and no unit test can either. **Anything called at module scope in main.ts must only touch bindings declared above it**; the established idiom for startup-time work that wants a repaint is `if (stdinReady) scheduleRender()`.
- **Tests are pure unit tests over the logic modules.** `src/__tests__/*` exercises `ControlParser`, `CellGrid`, `InputRouter`, `ScreenBridge`, modals, and the sidebar's render plan. They don't spawn tmux. When adding logic that depends on tmux protocol parsing or grid math, add a test at the same level — don't reach for integration tests.
- **No bundler, no transpile-on-publish.** Package `files` ships `bin`, `src`, `config`. `bin/jmux` imports `src/main.ts` directly; users run it under Bun. Imports must stay valid at runtime — don't add build-time-only tricks.
