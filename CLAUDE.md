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
- **`src/sidebar.ts`** — the left 26-col (configurable) panel listing sessions with groups, activity dots, attention flags, hover states, scrolling. Grouping prefers a session's wtm `project` (bare-repo basename) over directory path matching. The `stage` grouping axis buckets sessions by the user-defined workflow stage claiming their linked issue's status — resolution needs the tracker poll and `panelViews`, so it happens in `main.ts` (`recomputeSessionBands`) and arrives pre-resolved via `setSessionWorkflow()`, the same shape of dependency as `setParkedSessions()`. `sidebar.ts` itself stays free of tracker and config knowledge.
- **The workflow field and drift (`src/workflow-drift.ts`)** — row 2 of a session leads with the stage its driving issue sits in, and says so on *every* grouping axis: stage bands exist only under `group=stage`, so without this the workflow position is invisible three axes out of four. Five things hold it together:

  **One `SessionWorkflow` carries three answers** — the band, the row-2 word, and the drift — because all three are the same resolution of the same issue. It replaced `StageBucket`, which was only the first of them, and which `recomputeSessionBands` filtered by `inSidebar` before handing over. Hiding a stage must hide its *header*, never what its sessions say about themselves, so the filter now lives in the `band` field alone: `label` is populated either way.

  **Collapsed is coarse, expanded is precise.** The field shows the *stage* label — a word the user chose — not the raw status, which is workspace-defined and unabbreviatable (the same reason the disclosure sub-rows fall back to a `stateType` glyph). Two statuses in one stage read identically here and are spelled out a keystroke away. A status no stage claims prints raw: that is the fallback filling a hole, not a second rule.

  **The field's neighbours are the issue badge to its left and a timer/MR cluster to its right — row 2 no longer carries a branch at all.** The badge is laid out first and never drops, since it is the row's identity; drop order for everything competing with the field is timer → stage word → stage glyph → drift marker → MR id. Under `group=stage` the band header already names the stage, so the word is suppressed and those columns go back to the row's other fields — drift survives it, shortened to `→Done`, because the header supplies where the ticket *is* and nothing supplies where it should be. The predicate is `stageInHeader`, **stamped on the `RenderItem` where the row is placed rather than re-derived at paint time**: a session under `group=stage` can still land in Pinned or Parked, whose headers name neither, and a rule evaluated twice is a rule that can disagree with itself.

  **Drift is the level `transitions.ts` refuses to act on.** Transitions fire on edges only — a condition already true at startup must not replay history into a shared tracker — so every missed edge (a restart, a session adopted after its MR merged, a failed write, an unconfigured event) leaves a permanent silent divergence. jmux writes on edges and reads on levels. An issue drifts when its stage *rank* is behind the configured target's, which is why a ticket moved past the target isn't flagged; where either side can't be ranked, the answer is an honest blank rather than a guess. The strongest event that actually produces a move wins — falling through `mr-merged` when it has no target configured, rather than letting it mask a correctly-configured `session-start` underneath.

  **`Ctrl-a m` and the marker read the same function.** `detectDrift` serves both, so the key cannot move a set the row never claimed — the same construction as `itemsInGroup` reading its answer back off `buildViewNodes`. It writes through `applyStatusPick`, not `applyTransition`: the target was named on screen before the key was pressed, so this is a status the user picked and `transitionConfirm` does not gate it (the reasoning `ctl issue move` already uses). The optimistic update that primitive carries is what clears the marker on the next frame instead of the next poll. The minimal drift form is `!` and not `⚠`, whose width varies between terminals — exactly the class of drift against `cellWidth` that leaves ghost gaps. **`workflowFieldText` returns `{ text, terse }` rather than a bare string** because the field's last-resort forms are markers, not words: `·` is both the `backlog`/`unknown` glyph *and* the character inside the ` · ` separator, so a terse field followed by the word separator renders `· · feat/x` — three visual tokens on a row saying two things. Reachable whenever the badge and the right-hand timer/MR cluster leave less room than the stage label needs, which "In Progress" and "In Review" both can hit at the sidebar's default width.
- **Session titles (`src/session-title/`)** — row 1 shows a model-generated phrase in front of the session name, which never changes: `resolveIssueSessionName` still owns the name, the branch and the worktree directory, and the title is a second string layered over it. Four rules are easy to undo:

  **The options are the protocol**, for the same reason as the agent-state options: `ctl` has no IPC into the running TUI, so anything both halves need to agree on has to live where tmux holds it. `@jmux-session-title` and `@jmux-title-signature` are **session**-scoped — one session, one row, one name, nothing to roll up — unlike `@jmux-agent-state`, which is pane-scoped because several agents can share a session and a session-scoped write would let the last one clobber its siblings. `@jmux-prompt` is **pane**-scoped for exactly that reason in reverse: the `UserPromptSubmit` hook that writes it knows a pane and nothing else.

  **`title ?? name`, in `displaySessionName`, is the only fallback and there is no second rendering path.** The sidebar, the command palette and the Command Center's `buildPaneLabel` all call through it, so no command configured, no title generated yet, a call that failed, and a model that returned nothing all render identically — exactly what shipped before the feature existed. `ctl session list`/`info` deliberately don't: they return `name` and `title` as separate JSON fields and leave combining them to the caller, because a machine consumer needs the one that actually addresses a tmux session. A second trim-and-fallback anywhere else would be the same decision living in two places, able to disagree with the first the moment either one changes.

  **The signature is the cache key, and it caches failures too.** `TitleGenerator` never re-asks the same `(session, input)` pair — the rule the image store already follows for a failed URL fetch — because `requestSessionTitles` runs on every poll, and a model that timed out once would otherwise be asked again on every tick forever. A new signature (a grown issue set, a changed prompt, new commits) is a new attempt; the same one is not. The git tier compounds this: `gitTitleInputs` is keyed on `(session.id, branch)`, not `HEAD`, so a title freezes on the branch's first commit rather than re-reading `git log` on every poll — a `HEAD` key would cost a subprocess per session per refresh. The escape hatch is the palette's **"Re-name session with the model"** (`retitleCurrentSession`), which clears all three things that would otherwise suppress a re-ask: the git memo, the generator's attempted-signature cache, and the `manual` sentinel below, in that order — dropping the git memo *before* resolving, since resolving first would only benefit the next press.

  **The capture is gated on `@jmux-title-capture`**, a global option jmux writes at startup from `sessionTitle.command`. Hooks are installed once and cannot read jmux's config, so the option is how they ask. Without it, installing agent hooks would store a user's first prompt whether or not they use titling at all — a user who has never configured `sessionTitle` never has a prompt captured, full stop.

  **`@jmux-title-signature` carries the literal `manual` for a hand-renamed session**, which is what makes "a rename wins" survive a restart: the sentinel lives in a tmux option rather than an in-memory set, and `requestSessionTitles` skips any session carrying it, unconditionally. `Ctrl-a p` → **Rename session** stamps it; only the retitle command above ever clears it, because asking for a generated title is the one action that means to supersede an explicit one.
- **The issue disclosure** — a session carrying more than one issue expands in place to list them, on a click of its badge or `Ctrl-a e`. The badge's `+N` says how many; this says which, without leaving the one surface always on screen. Four rules:

  **The rows are sub-rows, not peers.** They are absent from `displayOrder` (the session cycle) and from `getNavOrder()` — Ctrl-Shift-Down walking through five tickets to reach the next session would break navigation in exactly the sessions the feature is for. Contrast ghost rows, which *are* nav stops: a ghost is somewhere to go, a disclosed issue is a detail of somewhere you already are. Clicking one still switches to its session and puts *that* issue in the panel, which is what makes the row worth drawing.

  **The badge and the first row are the same issue by construction.** `orderedSessionIssues` in `session-view.ts` puts `drivingIssue` first and `formatIssueBadge` takes its head, so the badge naming one ticket while the row below shows another is unrepresentable rather than merely unlikely. Beyond that the order is resolution order — re-sorting by status would move rows under the cursor every time a ticket advanced.

  **The disclosure appears only above one issue.** With a single issue the badge already names it, so a chevron would promise a reveal and show the same identifier a row lower. A session that drops back to one collapses on its own rather than leaving a dead affordance.

  **Rows are rebuilt with the plan, not read at paint time.** `setSessionContexts` receives the poll coordinator's live map, which is mutated in place, so deriving row counts at layout and row content at paint could disagree — hence `setSessionContexts` does a full `rebuildPlan()`, where it used to only re-clamp scroll. Fields drop right-to-left as the sidebar narrows, like row 2's branch/timer/MR cluster: the status name gives way to a `stateType` glyph (status *names* are workspace-defined and unabbreviatable) and the title goes entirely, before the identifier is touched.

- **Ghost rows (`src/ghosts.ts`)** — the sidebar's one deliberate exception to being a truthful mirror of tmux: rows for issues that have *no* session yet. They earn that by being convertible — clicking one opens the **ghost preview** (`src/ghost-preview.ts`), whose Enter runs the same `startWorkOnIssue` flow as `n` in the issues panel, turning the row into the row it was already drawn as (which is why a ghost uses a session row's exact two-row geometry).

  **There are two placements, and the grouping axis picks between them.** Grouped by stage, every stage band shows the work sitting in it that nobody has picked up, below that stage's sessions. On every other axis there are no stage bands, and an issue with no session has no project, no agent status and no activity to bucket on, so the rows collect into one flat "Up next" band fed by `pipeline.upNext`. `recomputeGhosts` reads `sidebar.getGroupMode()` to decide, so changing the axis has to rebuild the set, not just re-place it. One `selectGhosts` serves both: **the cap is per stage on either placement** and rows are always stage-tagged, so the sidebar files them by tag when banding by stage and ignores the tag when not. The cap briefly differed by placement, which made one setting mean two things — "3" read as three altogether or three *each* depending on a grouping mode the setting never mentioned. Hence `formatGhostCap` saying "3 per stage" outright.

  Four things are load-bearing. **A ghost carries its stage's label and rank**, because a stage holding only ghosts still gets a band and there is no session there to name its header. **Ordering is stage rank, never `upNext` order** — `upNext` records add-sequence, and letting it drive the sidebar would put two contradictory orders of the same stages on one screen. **Done and parked issues are never ghosts**, or a "Done" stage accumulates rows forever with no way to clear them. **The count is the on switch** (`pipeline.showUnstartedInSidebar` — a number, `"all"`, or null/0 for off; off by default), so no second boolean can disagree with it; `"all"` is stored as a literal, not `Infinity`, because `JSON.stringify` writes `Infinity` as `null` — this field's "off" — so the setting would silently switch itself off on the next save.

  **Per-stage, two flags on the `PanelView` gate this** (`s` and `space` in the workflow screen): `inSidebar` decides whether the stage draws a band at all, and `showUnstarted` — nested under it — whether that band carries ghost rows. Both default to on, and only `false` is ever stored, so an untouched config and a config that says "the default" are the same file. Hiding a stage hides its *header*, never its sessions: `recomputeSessionBands` simply declines to assign them a stage, so they fall to the flat remainder exactly like a session whose status no stage claims. A stage setting must never be able to make a waiting agent vanish from the one always-visible surface.

  **`showUnstartedInSidebar` is the master switch and the per-stage flags are exceptions to it**, which means the master can make a per-stage toggle moot — press `space`, watch the row change, and the sidebar does nothing. That is the exact failure the workflow screen exists to prevent, so the screen reads the cap back through `WorkflowPort.unstartedCap()` and a stage row states "off globally" (naming the setting and where it is) instead of reporting a preference that currently has no effect. The per-stage opt-out is preserved while the master is off, not cleared, so switching the master back on restores what the user chose. Any future setting that can be overridden by another owes the same disclosure.

  Ghosts stay out of `displayOrder` — that array means *sessions*, and callers asking for it get sessions — but they are full stops in `getNavOrder()`, which is what Ctrl-Shift-Up/Down walks. They were once excluded from navigation too, because landing on one provisioned a worktree and a nav key that did that would be a destructive surprise; the preview removed the destructiveness, and with it the only justification the exclusion ever had. **When a constraint's stated reason stops being true, delete the constraint rather than inheriting it.** Ghosts are still suppressed entirely under a filter (both filters select on agent state, which a ghost has none of), and an unemitted row is not a nav stop. Selection, ordering and cap all resolve in `main.ts` and arrive via `setGhostSessions()`, the same boundary as `setSessionWorkflow()`.
- **Ghost preview (`src/ghost-preview.ts`)** — the fourth full-area surface, alongside settings, workflow and glass. Shows an unstarted issue *and* its pre-flight: the session/branch name, worktree path, base branch, worktree tool and agent that Start would use, all resolved by `ghost-preflight.ts` before anything is provisioned. The primary action reads Start / Resume / Switch from the same three states `startWorkOnIssue` branches on, so the label cannot disagree with the behaviour.

  Four rules hold it together, and each was a bug first:

  **The poll never closes the preview — only the user does.** It pins an issue *id*, not a ghost row, and re-resolves content each frame. The issue gaining a session, changing status, being filtered away, or leaving the ghost set entirely all leave the surface open; only the last is even visible, as a "no longer available" state. Any other rule produces "the screen vanished while I was reading it".

  **The rail marks the row whose content fills the main area** — not the attached session. That is why a ghost can own it (`setFocusedGhost`) and why `applySessionRail()` exists: the rail is written from *two* places on the authoritative `%client-session-changed` path, and guarding one but not the other is indistinguishable from guarding neither. `currentSessionId` still tracks tmux; only the rail is withheld. The focused issue may have no emitted row at all (filtered, collapsed, or sidebar hidden below `SIDEBAR_MIN_TERM_COLS`) — the surface deliberately outlives its row.

  **`closeModal()` must hand routing back to `inputConsumerActive()`, not clear it.** The preview is the first surface to host a real modal (the status picker); settings and workflow paint their own prompts, which is why blindly clearing had never fired before. Modal results call `closeModal()` before their callback and SIGWINCH calls it too, so both paths left the surface painted and deaf with the next keystroke leaking to the pty.

  **The preview owns the unpark when it is opened out of glass.** `exitGlass()` deliberately does not switch sessions — its contract puts that on the caller — and a ghost is not a session target, so `leaveGlass()` cannot reach one. Opening from glass therefore leaves the client parked (invisible, since the preview paints the whole main area) and settles the debt on close, targeting `preGlassSessionId`, which `enterGlass()` captures *before* parking because parking rewrites `currentSessionId` to the internal session.

- **`src/main.ts` `makeToolbar()` / renderer's toolbar logic** — the top row: window tabs on the left, action buttons (new window, splits, Claude, settings) on the right.

Rendering is coalesced via `scheduleRender()`, at `RENDER_INTERVAL_ACTIVE` while something is happening and `RENDER_INTERVAL_IDLE` when nothing is. **"Something is happening" counts pane output as well as keystrokes** (`markOutputActivity`, called in `pty.onData` *before* the write so the burst that triggers the render is itself the activity). Keying the cadence on stdin alone meant a pane repainting on its own — a browser after a resize, an agent printing a result — could sit finished-but-undrawn for the whole idle interval: measured at ~220ms from the bytes arriving to jmux emitting them, against ~55ms once output counted. `writesPending` gates rendering while `ScreenBridge.write()` promises are still resolving, otherwise we'd render mid-write and tear frames.

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

`src/cli/*.ts` implements the `jmux ctl` subcommand — a structured JSON API for agents running inside jmux sessions to manage sibling sessions, windows, and panes programmatically. Subcommands: `session` (list/create/kill/rename/switch), `window` (list/create/select/kill), `pane` (list/split/send-keys/capture/kill), `run-claude` (dispatch Claude Code in a new session), `issue` (get/link/unlink/start/create/move), `workflow` (stages/board/next/statuses), `status`, `agent`, `cc`.

All output is JSON to stdout. Context resolution (`src/cli/context.ts`) auto-detects the current tmux socket and session from the environment, or accepts `--socket` / `--session` flags.

**There is no IPC to the running TUI**, so `workflow` re-derives the whole work pipeline from config + tmux + tracker. Agreeing with what the human sees is therefore bought by reusing the *same modules* the TUI renders from — `effectiveFilter`/`matchesIssueFilter` then `transformIssues`/`buildViewNodes` for membership and order, `stageForState` for which stage claims a status, `isParked`, `selectGhosts` — never by reimplementing their rules. A new pipeline command that computes its own answer is a bug waiting to be reported as "the CLI disagrees with my sidebar". The two honest gaps (parking's four poll-driven unpark signals, and session→issue links only reachable by MR traversal) are documented at the top of `cli/workflow.ts` and in the skill file.

**`src/issue-session.ts` is the one implementation of issue→session**, shared by the TUI and the CLI: the session name (`sessionNameTemplate`, or the tracker's own `branchName`), the worktree path (`<repoDir>/<session>`), and the resolution to `none`/`worktree`/`session`. It exists because those rules lived in two places and disagreed, so a session `ctl issue start` created was invisible to the sidebar, which kept offering to start the same work. Two link stores feed it and neither adopts the other's key: `state.json` holds the tracker's id (the TUI can't move off it) and `@jmux-linear-issue` holds identifiers (the CLI can't use `state.json` — a running TUI holds it in memory and would clobber the write). `linkKey` normalizes both and `resolveIssueSession` looks up both forms.

**Every consumer reads both stores, and for a long time only `resolveIssueSession` did.** That asymmetry made an issue linked by `ctl issue link` a half citizen: it suppressed the ghost row (`explicitIssueLinks` reads both) and then had no sidebar badge, no stage band, no linked dot and no MR transition, because `PollCoordinator` built the session context from `state.json` alone. `mergeIssueLinkIds` is the one union and `isIssueLinkFor` / `withoutIssueLink` the one match — the latter tries *both* of an issue's names, because testing the UUID alone silently leaves a `TRA-123` link in place and the issue reappears on the next poll, an unlink that reports success and does nothing.

The union alone is not enough to make a CLI link *appear*: neither the active poll nor the background sweep re-reads the link set — both refresh the issues a context already has, by id — and the CLI cannot reach the optimistic mutators the TUI's own `L` key uses. So `PollCoordinator` stamps an `issueLinkSignature` at resolve time and re-resolves when it changes, on the same footing as the branch-drift check beside it. The signature sorts and normalizes, or re-ordering or re-spelling the same set would re-resolve every session on every list refresh.

**The link is many-to-one, and only one half of that is an invariant.** An issue belongs to at most one session — `resolveIssueSession` returns a single session, so a second claimant would make the sidebar, `ctl status` and `workflow board` disagree depending on which they read first. A *session* carries any number, because a feature filed as five tickets is one branch, one worktree and one MR. The CLI used to enforce both halves and reject the second as a "1:1 invariant" — a state the TUI's own store had always been able to create, since `sessionLinks[name]` was a list from the start.

Three things fall out, and each replaced a rule that was really an accident:

- **`drivingIssue()` decides which issue represents a session** — least advanced unfinished by `stateType`, unknown `stateType` ranked between unfinished and finished (a guess must not displace a fact), ties on array order. That last clause is what makes an adapter populating no `stateType` behave exactly as the `issues[0]` this replaced. It drives the sidebar badge (`TRA-123 +4`), the stage band, parking and the workflow screen's parked counts, so a session leaves a stage only when its *last* ticket does.
- **`@jmux-linear-issue` holds a space-separated list**, and space is only safe because `isWritableLinkId` refuses whitespace at the write. Validating there rather than guessing at the read is what stops a malformed value silently becoming two links. `ISSUE_LINK_OPTION` / `parseIssueLinkOption` / `formatIssueLinkOption` are the one encoding, used by all four readers.
- **Transitions fan out** (`requestTransitions`), with the target resolved *per issue* — transitions are configured per repo and hand-linked issues can come from teams that map elsewhere, so there is no single "→ Done" for a header. Several issues get a checklist (`ListModal`'s `multiSelect`, everything pre-checked); a single issue keeps the yes/no modal it always had, because rewriting the common case as a one-row checklist would be a worse question asked more often.

**Selection is ticks first, group headers second, and the order matters.** `ViewState.checkedIds` (`Space` in the panel) is the primary way to name a set, because grouping *cannot* name one on the configuration jmux steers users toward: a view with `states` is sectioned by those statuses and `buildViewNodes` never consults `groupBy` at all, so a stage-based workflow has only status headers — and two of a typical seven tabs have no headers whatsoever (a single-status stage returns bare items). "Every ticket in To do" is never the set anybody meant. Ticks also express "these three of those five", which no header can. `n` and `l` therefore read ticks before the highlighted row, and the checkbox column is drawn only when something is ticked so an untouched list costs no width. The group-header path is kept because it is correct where headers exist and costs nothing.

**The detail pane's preview strip is the panel's second cursor, and the rules keeping that tolerable are the whole design.** It draws a tab per issue in the current set — ticks when there are any, else the focused session's linked issues — and `ViewState.previewIssueId` pins which one fills the pane.

- **It has its own cursor because it must show what the list cannot.** A session's linked issues routinely include ones absent from *every* queue tab: a finished ticket while you are on "In Progress", or one assigned to a teammate and so missing from `getMyIssues()` entirely. A strip that could only point at emitted rows would silently carry fewer tabs than the sidebar's `+N` promises. So items for the session source are built with `transformIssues` from the context, not looked up in `rawItems`.
- **The newer cursor yields to the older on any deliberate move of the older.** `moveSelection()` exists for exactly this: it sets the index, resets the detail scroll, and clears the pin. It replaced nine bare `selectedIndex` assignments, and a tenth added without it would strand the pane on an issue the user had cursored away from.
- **The session source is contextual, the tick source is not.** A strip only appears from session links while the cursor (or the pin) is on one of that session's issues — otherwise anyone holding a multi-issue session would carry a permanent strip through every unrelated queue. Ticks win when both apply: a tick is an explicit act performed just now, links are ambient and true all day.
- **The action bar follows the preview, not the cursor.** It sits under the detail pane and describes what the keys will do, and the keys act on what you are reading. `o` is deliberately *not* a set action — five ticked issues would mean five browser tabs from one keystroke.
- **Windowing, not truncation.** `packChips` drops what does not fit from the end, which would hide the active tab exactly when it sat past the budget — the one tab the strip exists to show. `layoutPreviewTabs` slides a window to keep it in, with overflow arrows for the rest, and the click hit-test resolves against the chips that were actually drawn.

Related debt cleared with it: `onPanelItemClick` treated a click's row as a list index directly, ignoring `listStartRow`, so every click selected the row above the pointer for as long as a filter bar was open.

The same asymmetry produced a second bug worth remembering: `g` on a sectioned view used to cycle `groupBy`, persist it to `config.json`, and change nothing on screen — a setting that looked configured and was inert, with no feedback at all. `sectionedViewNotice()` now says so and declines. It deliberately does **not** strip values already stored (they are merely inert); rewriting a config as a side effect of a key that now refuses to act would be its own surprise.

**Group start (`startIssueGroup`) is four refusals to guess.** Issues already in a session are dropped and reported, never moved out of somebody's running work. Every remaining issue must route to one repo, or the error names the repos — which is also what catches two same-named projects in different teams being merged by the grouping axis, since `Issue.project` is a name and not an id. The session name is confirmed in an `InputModal` rather than derived, because it is also the branch and worktree name and there is no tracker `branchName` to inherit for a group. And the count is in the modal header, because `n` on a 40-issue team header is a group start too. Membership comes from `itemsInGroup`, which reads the answer back off `buildViewNodes` with nothing collapsed rather than re-deriving it — the two grouping mechanisms (a view's `states` sections and the `groupBy` axis) file items by different rules, and a caller acting on a header should not have to know which produced it.

**`src/issue-provision.ts` is the one implementation of "provision a session for this issue"**, and the ordering in it is the whole point: the session is created *first*, with the agent parked on a wait loop, and the worktree tool runs in a 30% setup pane beside it. That makes the work observable to the sidebar, `ctl status` and `workflow board` the instant provisioning starts, and it means nothing has to block.

This existed twice and the copies had drifted into different failure modes. The CLI ran the worktree tool with a blocking `Bun.spawnSync` and created the session afterwards, so a wtm repo with install hooks gave a minute of silence with no session, no pane and nothing in `ctl status` — reported as a hang and interrupted as one, which left an orphan worktree that the *next* `issue start` mistook for a finished one (`existsSync` was standing in for "ready"). It also built its agent command with `claude -p` — print mode, headless, exits — where the human got a seeded interactive session.

Four rules hold it together:

- **A worktree directory means "resumable", never "ready".** It appears before install hooks run. Readiness is the setup pane *exiting*, which is what `--wait` polls and what the human reads off their screen.
- **Failure raises the session's attention flag before `exec $SHELL`.** `exec` never returns, so ordering is load-bearing. The flag is the only way a caller who didn't wait ever learns setup died; the shell is what keeps the tool's own error on screen, and without it the main pane waits forever for a worktree that isn't coming.
- **Waiting is opt-in and always bounded.** A timeout returns a live session, not an exception — a slow install is not a failed start.
- **The CLI does not `switch-client`.** Starting work in the background must not move the human's cursor. This is the one deliberate difference from the `n` key.

The `session-start` tracker transition fires from both. In the CLI the `transitionConfirm` policy does not apply, for the same reason it doesn't for `issue move`: that policy governs writes jmux makes on its own initiative, and this one was asked for. The result is read back, and a tracker failure never fails the start.

The skill file `skills/jmux-control.md` documents usage patterns for agents — it's loaded as a Claude Code skill so agents inside jmux can discover and use the CLI.

### Diff panel

**`src/diff-panel.ts`** provides an integrated hunk diff viewer that docks to the right side of the terminal or zooms to full width. It spawns an external `hunk` process and captures its output. The panel has focus toggling (keyboard input routes to hunk when focused) and survives session switches by re-spawning.

**`src/hunk/`** talks to hunk's session daemon, which is what makes the panel more than a picture. `protocol.ts` is pure — wire shapes, defensive parsers, the badge and the review-prompt formatter; `client.ts` is the loopback HTTP transport; `view.ts` is the argv table for what the panel shows. Full write-up in `docs/diff-panel.md`; the rules that are easy to undo:

- **The control plane is optional and "off" is a path that already ships.** No daemon, an older hunk, or `controlPlane: false` all land on the pre-daemon behaviour — a hunk pty and nothing more. There is no third mode.
- **Sessions are matched by pid.** The daemon's pid for a jmux-spawned hunk *is* the pty child pid. Repo matching looks equivalent and isn't: dead sessions linger 45s and worktrees share a repo root, so `--repo` is stale-prone and ambiguous. Resolution retries for ~3s because the daemon is started by the TUI and isn't up yet on a cold start.
- **Content changes by respawning, never by `hunk session reload`.** Reload is cheaper and wrong: after it retargets a session `--watch` stops firing, so the panel goes stale while an agent edits. One mechanism therefore covers session switches and view switches alike.
- **Flags are probed, not assumed.** hunk 0.9 has `--watch` but not `--transparent-bg`, and an unknown flag makes hunk exit before drawing — the panel then shows only its "Diff viewer closed" state. `hunk diff --help` is parsed once per binary; presentation flags are dropped silently when absent, content flags (`--staged`, `--exclude-untracked`) refuse the view instead of substituting a different changeset.
- **jmux does not manage hunk's layout, but it does manage hunk's theme.** `--mode auto` re-lays out live on resize and jmux already resizes the diff pty on relayout and drag, so no layout flag is passed. The two presentation flags that are passed are `--transparent-bg` and `--theme`, and the second follows from the first: transparent surfaces put hunk's text on jmux's background, so a dark theme over a light terminal is unreadable. hunk's own `--theme auto` can't do this job here — its startup OSC 11 query dies in a one-way pty feed and always takes the dark fallback — so jmux resolves the light/dark id from the probe it already ran against the real terminal, and respawns the panel when that resolved id changes (never merely when the background does; a respawn costs hunk's scroll position). `diffPanel.theme` pins an id, or `false` passes nothing and leaves hunk's own config in charge.
- **Review notes are deleted by id, never in bulk**, or a note written while the confirm modal was open would be destroyed with the ones being sent.
- **The tab strip appears for a lone Diff tab when the badge has something to say.** Otherwise the stats are invisible to every user with no tracker configured — which is everyone on first run.

Two test paths, for the same reason `main.ts` has boot-smoke: `hunk-integration.test.ts` asserts the handshake inside `bun test` (skipped without tmux/hunk), and `scripts/review-loop-e2e.ts` drives the whole review loop by hand. The unit tests either side of the glue all passed while the feature was broken end to end, which is why the integration test exists.

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

### Graphics from inside a pane (browser panes)

`src/images/passthrough.ts` is the mirror image of everything above. There jmux
authors the picture; here it is a courier for one drawn by a program in a pane —
terminal-browser (`Ctrl-a b`, `src/browser-pane.ts`), but equally an image
previewer or a plotting library. **Nothing in the relay is browser-specific**,
which is why the module is named for the mechanism and not the feature.

**A courier is enough because those programs use virtual placements.** Under
tmux they send the pixels (usually a shared-memory *name* pointing at them, so
the payload stays a few hundred bytes at any frame size) with `U=1`, and put the
*position* in a grid of U+10EEEE placeholder cells written as ordinary text.
Those cells ride the normal path — tmux screen, ScreenBridge, CellGrid,
compositor — so sidebar offset, clipping, scrolling and occlusion work on them
with no image-specific code, exactly as they do for jmux's own `ImageMark`s.
jmux only has to make sure the payload reaches the terminal, because
@xterm/headless has no notion of the protocol and would otherwise swallow it.

Five things hold it together, and each was a bug first:

- **The relay strips the APC rather than copying it.** Leaving it in the feed
  would bet on the headless terminal continuing to *silently discard* an APC it
  does not implement; a parser that fell back to ground state would print
  kilobytes of base64 into the grid. The screen model has no use for the bytes
  either way.
- **A changed placement is preceded by a delete** (`PlacementTracker`). A program
  redefining a virtual placement re-transmits under the same id with a new
  `c`/`r`; whether the terminal re-resolves the geometry from that is not
  something the protocol pins down. terminal-browser only gets away with it
  because *shrinking* takes a path that deletes the image first and growing does
  not — which is exactly why "the browser doesn't resize" looks like it only
  happens one way. jmux relays these, so it makes both cases identical. Costs a
  few bytes per resize and nothing in the steady state, where the geometry is
  unchanged 60 times a second.
- **The introducer itself splits across reads.** At 60fps that is a certainty,
  not an edge case, so a trailing fragment of `ESC _ G` is held back. Holding a
  lone `ESC` is safe *here* precisely where `scanForImageProbe` refuses to —
  this is tmux's output, not the user's input, so the cost is a frame of latency
  rather than swallowing the Escape key.
- **Relayed bytes go straight to stdout, not through the renderer's frame.**
  They are inert with respect to the frame (`U=1` moves no cursor, `q=2`
  suppresses the reply), and the shared-memory slot the sender named gets
  recycled within a few frames — so holding one for the next repaint can relay a
  pointer to pixels that have already been overwritten.
- **ScreenBridge must use unicode `"15-graphemes"`, not `"15"`.** The addon
  registers both: `"15"` is its width tables *without* the cluster joining they
  exist to serve, so every combining mark lands in its own cell. That silently
  broke all decomposed text long before it broke placements, where the row/column
  diacritics *are* the placement.
- **A modal blanks placeholder cells instead of dimming them.** The image id
  lives in the cell's truecolor foreground, so dimming does not weaken the
  placement — it names a different image. Only clearing the char withdraws it.

**tmux learns the real cell geometry from `src/pty-pixels.ts`, and the route it
takes is not the obvious one.** tmux answers a pane's `CSI 16 t` *itself* from
its own figure and never forwards the query, so jmux cannot reply on the
terminal's behalf; that figure comes solely from the client tty's
`ws_xpixel`/`ws_ypixel`, and with them at zero tmux tells every pane a character
is 16×32. Writing them needs `TIOCSWINSZ`, and **Bun cannot make that call** —
`ioctl` is variadic, arm64 Darwin passes variadic arguments on the stack while
Bun's FFI passes them in registers, and the call segfaults the process
(measured). bun-pty exposes no fd either.

The way through is that tmux's client tty is a *device file with a path* — the
same string tmux reports as `#{client_name}` — so a separate process can open it
and set its size. jmux keeps one long-lived interpreter helper alive and hands
it sizes, which is why `resizeTmuxPty()` exists and why nothing calls
`pty.resize()` directly any more. Four things are load-bearing, each of which
silently produced no effect at all when it was wrong:

- **tmux ignores a size write whose rows and columns are unchanged.** At startup
  the size is already right, so priming has to bounce a column and come back.
- **The bounce needs a pause.** tmux reads the size once per SIGWINCH; two
  back-to-back writes are read after both, look like no change, and are dropped.
- **The helper compares against the tty's real size**, not one it remembers, or
  the very first write — the one that matters — never bounces.
- **A resize that omits the pixel fields resets tmux to 16×32.** bun-pty writes
  zeros there, so the helper must *own* the resize rather than patch it up
  afterwards.

**Each browser pane gets its own `XDG_RUNTIME_DIR`, and that is not tidiness.**
terminal-browser keeps its daemon socket there, and without a private one every
pane attaches to the same daemon — one process, one session per pane, and
`frame_image_id` derived from `process::id()`, so every pane transmits under the
*same* kitty image id and the terminal draws the last frame in all of them. Two
browser panes show one page. The sessions are genuinely independent underneath
(separate tabs, separate input), which is what makes it read as a rendering bug
rather than a scoping one. `browser.isolate` turns it off; the honest fix is
upstream, an image id per session rather than per process.

**Two pane options are the protocol for reaching a browser**, for the same
reason the agent-state options are: `ctl` has no IPC to the running TUI, and
isolation makes a browser undiscoverable by any other route — its registry lives
in a runtime directory only jmux knows. `@jmux-browser` marks the pane;
`@jmux-browser-runtime` carries the directory. Both the TUI and `ctl browser
open --new` set them, so a pane an agent made is found by exactly the lookup
that finds one the human made.

Three things there are easy to undo:

- **Browsers are addressed by key, read off the pane title.** terminal-browser
  names its pane `terminal-browser:<key>`, and `--browser <key>` names an
  instance outright. Without it the CLI infers which browser is "here" from
  `TMUX`/`TMUX_PANE`, which belong to whoever ran `ctl` — an agent shelling out
  from one jmux while `ctl` targets another server then resolves confidently to
  the wrong machine's browser, with no error.
- **The runtime directory has to be short.** terminal-browser puts a unix socket
  under it, macOS caps `sun_path` at 104 bytes, and going over fails with a bare
  EINVAL that says nothing about length. `browserRuntimeBase()` follows tmux's
  own `/tmp/tmux-<uid>` convention for exactly this; a runtime root under
  `~/.local/state` is 26 characters before jmux adds anything, and that was
  enough to break `ctl browser action` while `list` kept working.
- **`open` on an existing browser navigates, it does not call
  `terminal-browser open`.** That verb means "give me a browser": it goes to the
  daemon, asks for a new session and waits for registration — which in a private
  runtime directory has no daemon to reach and simply times out.

Dev servers (`src/dev-servers.ts`) are found from **listening sockets, not
scraped output**: `lsof` for ports by pid, `ps` for the process tree, and a
pane's shell as the root. A server that printed its URL before you scrolled is
invisible to scraping, and a URL in a log line is a false positive; a listening
socket is a fact about now. `lsof` costs ~120ms, which is why this is a command
and deliberately not a live sidebar indicator.

Off is a path that already ships: no interpreter, or a helper that dies, falls
back to `pty.resize()` exactly as before. `browser.displayScale` is unrelated
and stays — it chooses which *layout* a page picks, not how big a cell is.

**Focus events cannot reach panes, and the reason is the control channel.**
jmux enables `?1004h` (it previously asked for nothing, so there was nothing to
forward) and `InputRouter` passes `ESC [ I` / `ESC [ O` straight through — both
verified. They still never arrive, because tmux decides a pane is focused by
asking whether *any* client showing it is focused, and jmux's control-mode
client never reports losing focus. It therefore holds every pane permanently
focused, so there is no transition to report. Minimal reproduction: bare tmux
delivers focus events to a pane; bare tmux with a second `tmux -C attach`
client delivers none. No `refresh-client -f` flag governs this (`active-pane`,
`ignore-size`, `no-detach-on-destroy`, `no-detached`, `no-output`,
`pause-after` are the whole list), so the fix would have to be tmux's or a
restructuring of the control channel. The `?1004h` enable is kept because it is
correct and is the half jmux owns.

`allow-passthrough on` lives in `defaults.conf`, not `core.conf`: jmux does not
need it to function, and turning it off simply stops panes drawing pictures.
Note that tmux forwards a passthrough sequence only for a pane the client can
currently *see*, which is why `openBrowserPane` targets the pty client by name —
an untargeted split lands in whichever session tmux last touched, reliably the
parking session rather than the one on screen.

Two test paths, for the same reason the diff panel has two:
`graphics-passthrough-integration.test.ts` boots jmux under a pty and asserts
the relay, the compositing and the modal occlusion against a *synthetic* emitter
(deterministic, no Electron); `scripts/browser-pane-e2e.ts` runs the real
terminal-browser, which is what would catch it changing transport or dropping
virtual placements. The unit tests either side of the glue all passed while the
integration test was finding a targeting bug, which is why it exists.

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
- **No bundler, no transpile-on-publish.** Package `files` ships `bin`, `src`, `config`. `bin/jmux` imports `src/main.ts` directly; users run it under Bun. Imports must stay valid at runtime — don't add build-time-only tricks. The compiled binary (see below) does not violate this: it is a *second* artifact, and npm remains a source-shipping channel.
- **Assets are materialized, never read from the source tree.** `bun build --compile` collapses `import.meta.dir` to `/$bunfs`, and tmux — a separate process — cannot read that. So `src/assets.ts` embeds the three `.conf` files, the pi extension and the agent skill with `with { type: "text" }`, writes them to `${XDG_DATA_HOME:-~/.local/share}/jmux/assets/<content-hash>/`, and `$JMUX_DIR` points there. Three rules hold it together:
  - **There is one mode, not two.** Running from source materializes exactly as the binary does. A source-mode fast path would mean the shipped path was exercised only by CI while the daily driver used something else.
  - **The resolver runs above `main.ts:242`**, because `--install-agent-hooks` and `--install-skill` read materialized assets and are handled there. This is the temporal-dead-zone hazard `boot-smoke.test.ts` exists to catch.
  - **`rename` onto a non-empty directory fails**, so `ENOTEMPTY` is *success* — the loser of a concurrent-start race verifies the winner's tree and adopts it. `assets.test.ts` proves this with real parallel processes, because in-process calls short-circuit before ever reaching `rename`.
- **`-f <config>` is honored only when tmux *starts* a server.** Attaching to a running server ignores it, and jmux deliberately never `source-file`s over the control channel. An upgraded jmux therefore keeps the old config until the server dies — `config-generation.ts` stamps `@jmux-config-generation` and reports the mismatch rather than letting it be silent.
- **Linux is a shipping target.** No `pbcopy`, no bare `open` — use `src/platform.ts`. `tmux-conf.test.ts` fails the build on a macOS-only binary in any `.conf`.
- **Two artifacts, two test paths.** `boot-smoke.test.ts` boots from source; `binary-boot-smoke.test.ts` compiles and boots the real binary, against both a fresh server and one from a different config generation. A change to asset resolution that only passes the first is not verified.
