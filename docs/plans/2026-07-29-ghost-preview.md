# Ghost Preview Implementation Plan

**Goal:** Clicking an unstarted (ghost) row in the sidebar stops provisioning a worktree on the spot. It *focuses* the ghost and takes over the main area with a preview of the issue — plus the pre-flight of what starting would actually do. From there you start it, move its status, or leave.

**Architecture:** A fourth full-area jmux surface alongside settings, workflow and glass. `GhostPreview` is a `settings-screen`-shaped class (`isOpen` / `open` / `close` / `render(cols, rows)` / `handleInput`) driven by a `GhostPreviewPort` that `main.ts` supplies, exactly as `WorkflowPort` drives `WorkflowScreen`. The issue-detail content is extracted out of `panel-view-renderer.ts` into `src/issue-detail.ts` so the panel's detail pane and the new surface share one builder. Pre-flight resolution and navigation stepping are pure functions, so they unit-test without tmux.

**Tech stack:** TypeScript, Bun, existing `CellGrid`/`writeString` rendering, existing adapter pattern.

**Branch:** `feat/ghost-preview`

**Source idea:** `IDEAS.md` — "When clicking an unstarted/ghost session in the sidebar, it shouldn't launch immediately…"

**Revision:** v2, after an adversarial review returned BLOCK on v1. Twelve findings, all verified against source, are folded in below. The surface, pre-flight, status action and navigation merge survived unchanged; every fix was in integration detail. The changes worth knowing about before reading:

- `closeModal()` clears input routing unconditionally, which would have left the preview painted but deaf (Task 6, Step 0).
- `exitGlass()` deliberately leaves the PTY client parked, so glass → preview needs a remembered return target (decision 9).
- The sidebar rail is written from two places on the authoritative session-change path, so guarding it needs one choke point (decision 7).
- v1 deleted `getDisplayOrderIds()` two tasks before it repointed the caller, leaving the tree unbuildable in between. v2 adds the replacement alongside it and removes it in the same step that repoints the caller (Task 5, Step 2; Task 7, Step 3).
- v1 claimed an optimistic status write was confirmation the write landed. It is not (decision 3).

---

## Design decisions

These are settled; the tasks assume them.

### 1. The surface is a main-area takeover, not a panel or a modal

Rendered through `fullScreenLayout` with an early return in `renderFrame`, exactly as settings (`main.ts:2134`), workflow (`main.ts:2157`) and glass (`main.ts:2176`) already are. Sidebar stays, toolbar hidden, no footer.

Unlike glass, it does **not** park the tmux client of its own accord. Glass parks because it genuinely displaces your context onto mirrored panes; a preview opened from a normal session leaves that session running untouched underneath, so `Esc` drops straight back with no tmux round-trip. (Glass → preview is the exception — see decision 9.)

### 2. The preview shows the issue *and* the pre-flight

Issue detail alone is what the info panel already gives you, just bigger. The value this surface adds is the part nothing in jmux surfaces today: the session/branch name `resolveIssueSessionName` would pick, the worktree path, the base branch, whether the worktree is made by `wtm` or `git worktree add`, and whether an agent auto-launches. Every one of those is computable before you commit to anything.

It also makes the primary action honest: **Start** when nothing exists, **Resume** when a worktree is already on disk, **Switch** when a session already claims the issue — the same three states `startWorkOnIssue` branches on.

### 3. Status changes from the preview; parking comes free

The preview offers the same status action the info panel's `[s]` offers, using the identical mechanism (`main.ts:3193`). Parking needs no separate action: `pipeline.parkedStates` is a set of *statuses*, so parking an issue is setting its status to a parked one, which the same picker already lists.

**The row disappearing is not confirmation that the write landed.** `optimisticIssueStatus` (`poll-coordinator.ts:192`) synchronously mutates the global and per-context issue objects and fires `onUpdate` immediately; `updateStatus` is then sent with no `.catch` and no rollback (`main.ts:3193`). The row therefore vanishes before the remote write is acknowledged, and on failure the wrong local status survives silently until a later refresh overwrites it.

This plan does not fix that for the panel, but it must not repeat it: the preview's status action attaches a `.catch` that surfaces a toast and calls `refreshGlobalItem` to pull the true value back. Anything stronger — real rollback — is out of scope and belongs to whoever owns the panel's copy.

### 4. Ghosts rejoin `displayOrder`

`CLAUDE.md` keeps ghosts out of `displayOrder` because "a Ctrl-Shift-Up/Down that provisioned a worktree would be a destructive surprise." Selection is no longer destructive, so the reason is gone and keeping the exclusion would be cargo-culting a dead constraint.

`switchByOffset` (`main.ts:1611`) walks `[Overview, ...targets]` where a target is now a session *or* a ghost. Landing on a session switches to it; landing on a ghost opens its preview.

### 5. Ghost-only caller, one issue-detail renderer

Only ghost rows open the surface in this effort. But `buildIssueDetailLines` gets exactly one home so the panel's detail pane and the new surface cannot drift. The info panel adopting the full surface is explicitly out of scope.

### 6. The poll never closes the preview

**Only the user closes the preview.** This single invariant kills a whole class of "the screen vanished while I was reading it" bugs.

The preview pins an **issue id**, not a ghost row, and re-resolves its content each frame. So:

| What happens | What the preview does |
|---|---|
| Issue gains a session *that jmux can see* | Stays open; the action re-reads as **Switch** |
| Issue moves to a done/parked status | Stays open; the sidebar row disappears underneath |
| Ghost cap or grouping axis changes | Stays open; focus is reconciled (decision 7) |
| A filter is applied (ghosts suppressed) | Stays open; the row is gone but the surface is not |
| Issue leaves the global list entirely | Renders a "no longer available" state; only `Esc` works |
| Another tmux client moves the PTY client | Stays open, and keeps the rail (decision 7) |

**Known limitation, pre-existing and not introduced here.** "A session jmux can see" is narrower than "a session exists". `getIssueSessionStates()` (`main.ts:4433`) reads only the in-memory `SessionState` links plus workflow-derived session names. `jmux ctl issue link` writes its link to the `@jmux-linear-issue` tmux option (`cli/issue.ts:315`), which is read by `cli/status.ts` and **never by `main.ts`**; the CLI also names sessions via `computeBranchName` (`cli/issue.ts:113`) — the tracker's suggested `branchName` when present, else `<issueId>-<title-slug>` — rather than the TUI's configured `sessionNameTemplate`, so name matching will not reliably recover it either.

A session created from another pane via the CLI is therefore invisible to the preview, which will still offer Start. This is exactly as true of the info panel's `n` key today — the preview inherits the gap rather than creating it. Unifying session discovery on the tmux option is worth doing and is **out of scope**; it must not be silently assumed fixed.

### 7. The preview claims the sidebar rail, and keeps it

Settings and workflow leave the session highlight alone — they have no sidebar row to claim. Glass clears it and marks Overview instead. The preview has a row, so it takes the rail (`setActiveSession("")` + `setFocusedGhost(id)`) and restores it on close.

The rule across all four surfaces: **the rail marks the row the main area is showing, when the main area is showing a row's content.**

Two consequences the implementation must honour:

**The rail is written from two places on the authoritative path.** `resolveClientName()` writes `sidebar.setActiveSession(sessionId)` at `main.ts:2053`, and the `client-session-changed` handler writes it again at `main.ts:5629`. An external tmux client moving the PTY client would otherwise pull the rail onto a session while the main area still shows the ghost. Both writes must go through one choke point that respects preview ownership (Task 6, Step 3). `currentSessionId` still updates — only the *rail* is withheld.

**"Focused issue" is not the same as "emitted rail row".** A filter, a cap change, a collapsed group, a status change, or a terminal too narrow for the sidebar at all (`SIDEBAR_MIN_TERM_COLS`) can each leave the preview open with no row on screen to carry the rail. That is allowed — the surface outlives its row. Two things follow: rebuilds must re-scroll to the focused ghost when it *is* emitted (`setGroupMode` and `setSortMode` reset `scrollOffset` to zero before rebuilding — `sidebar.ts:806` and `:813`), and navigation must handle the focused issue being absent from nav order (Task 7, Step 3).

### 8. Facts confirmed while planning

- Linear is the only `IssueTrackerAdapter` **in the registry** (`adapters/registry.ts`); GitHub is a code host only. Demo mode supplies a mock tracker, whose `seed-data.ts` issues carry descriptions and comments, so demo previews render with real content.
- `ISSUE_FIELDS` (`adapters/linear.ts:9`) already fetches `description` and 20 comments on every poll, so **the preview needs no on-demand fetch and no loading state**.
- `src/snapshot/` persists tmux session state and enumerates no UI surfaces; it needs no changes. The preview owns no process, timer or subprocess, so jmux's exit path needs no preview cleanup.

### 9. Glass → preview replaces glass wholesale, and owns the unpark

`exitGlass()` (`main.ts:6215`) tears down the tiles but deliberately does **not** switch sessions — its contract puts that on the caller, or the main view renders `PARK_SESSION`. A ghost is not a session target, so `leaveGlass(sessionId)` cannot be used to reach one.

The preview takes this over. Opening a preview from glass calls `exitGlass()` and **leaves the client parked** — the preview draws the entire main area, so a parked client is invisible and costs nothing. The unpark happens once, when the preview closes, targeting a remembered real session.

That target must be captured before glass parks the client: `%client-session-changed` fires on the park switch, so by the time the preview opens, `currentSessionId` is the park session's id. `enterGlass()` records `preGlassSessionId = currentSessionId` at its top, before the switch at `main.ts:6121`.

This also means `Esc` from a glass-opened preview returns you to the session you were on before entering glass — not to glass. That is the right behaviour: you left glass when you chose a specific piece of work to look at.

---

## Task 1: Extract the shared issue-detail renderer

**Files:**
- Create: `src/issue-detail.ts`
- Modify: `src/panel-view-renderer.ts`
- Modify: `src/__tests__/chrome-token-lint.test.ts`
- Create: `src/__tests__/issue-detail.test.ts`

- [ ] **Step 1: Create `src/issue-detail.ts` with a composition seam**

Move `DetailLine` (`panel-view-renderer.ts:655`), `buildIssueDetailLines` (`:659`) and the generic painter out of `renderDetail` (`:739`).

`DetailLine` is an untagged union with no section markers, so v1's "splice the pre-flight in after the metadata and before the description" had nothing to splice against. Give the builder an explicit insertion point rather than making callers pattern-match on rendered strings:

```typescript
export type DetailLine =
  | { text: string; attrs: CellAttrs; indent?: number }
  | { segments: StyledLine; indent?: number };

export interface IssueDetailOptions {
  /** Lines injected between the metadata block and the description. The
   *  preview uses this for its pre-flight; the panel passes nothing. */
  afterMetadata?: readonly DetailLine[];
}

export function buildIssueDetailLines(
  issue: Issue,
  cols: number,
  opts?: IssueDetailOptions,
): DetailLine[];

export function paintDetailLines(
  grid: CellGrid,
  startRow: number,
  startCol: number,
  cols: number,
  maxRows: number,
  lines: readonly DetailLine[],
  scrollOffset: number,
): void;
```

Note the signature change: `buildIssueDetailLines` takes an `Issue`, not a `RenderableItem`. The panel's item wrapper is panel-specific and the preview has no items.

`buildMrDetailLines` **stays** in `panel-view-renderer.ts` — MRs get no preview, so hoisting code with one caller buys nothing.

- [ ] **Step 2: Rewire the panel**

`renderDetail` becomes a thin dispatch: pick the builder by `item.type`, hand the lines to `paintDetailLines`. The issue branch passes `item.raw as Issue`.

- [ ] **Step 3: Register with the chrome lint**

Add `"issue-detail.ts"` to `CHROME_MODULES` in `src/__tests__/chrome-token-lint.test.ts`. It composites jmux chrome, so the no-RGB-literals rule applies; attribute constants come from `chrome-tokens.ts` / `theme.ts`.

- [ ] **Step 4: Tests**

`issue-detail.test.ts`: `afterMetadata` lines land after the metadata block and before `Description:`; passing no options reproduces the pre-refactor line sequence exactly; `paintDetailLines` clips at the region edge and emits scroll indicators at both ends.

**Verify:** `bun test src/__tests__/issue-detail.test.ts src/__tests__/panel-view-renderer.test.ts src/__tests__/chrome-token-lint.test.ts`. The panel tests must pass **unmodified** — this task is behaviour-preserving.

---

## Task 2: Pre-flight resolution (pure)

**Files:**
- Create: `src/ghost-preflight.ts`
- Modify: `src/main.ts` (extract a per-issue resolver)
- Create: `src/__tests__/ghost-preflight.test.ts`

- [ ] **Step 1: Define the model**

```typescript
/** What pressing the primary action will do. Mirrors startWorkOnIssue's three
 *  states so the label can never disagree with the behaviour. */
export type PreviewAction = "start" | "resume" | "switch";

export type PreflightPlan =
  | {
      kind: "automated";
      sessionName: string;   // doubles as the branch name (the one-name rule)
      worktreePath: string;
      baseBranch: string;
      worktreeTool: "wtm" | "git";
      agentCommand: string | null;   // null → no agent will run
    }
  | { kind: "manual"; team: string | null }   // no teamRepoMap entry
  | { kind: "existing"; sessionName: string };

export interface Preflight { action: PreviewAction; plan: PreflightPlan; }
```

- [ ] **Step 2: Implement `buildPreflight`**

```typescript
export function buildPreflight(input: {
  issueState: "none" | "worktree" | "session";
  linkedSessionName: string | undefined;
  repoDir: string | null;          // already home-expanded
  sessionName: string | null;
  team: string | null;
  settings: ResolvedRepoSettings;
  trackerPresent: boolean;
}): Preflight;
```

Rules, in order, mirroring `startWorkOnIssue` (`main.ts:4195`) branch for branch:

1. `issueState === "session"` **and** `linkedSessionName` → `{ action: "switch", plan: { kind: "existing", … } }`. Checked first, before the repo lookup, because an explicit `L`-key link must work even for a team with no `teamRepoMap` entry.
2. No `repoDir` or no `sessionName` → `{ action: "start", plan: { kind: "manual", team } }`.
3. Otherwise `automated`, `action: issueState === "worktree" ? "resume" : "start"`, `worktreePath = ${repoDir}/${sessionName}`, `baseBranch = settings.defaultBaseBranch`, `worktreeTool = settings.wtmIntegration ? "wtm" : "git"`, `agentCommand = settings.autoLaunchAgent && trackerPresent ? settings.claudeCommand : null`.

The `agentCommand` condition is `shouldLaunchAgent` from `main.ts:4234` verbatim. If they drift the preview starts lying — keep them textually identical and cross-reference in a comment.

- [ ] **Step 3: Extract a per-issue session-state resolver**

`getIssueSessionStates()` (`main.ts:4433`) loops **every** global issue and calls `existsSync()` on each candidate worktree path (`main.ts:4471`). Calling it from the render path would stat the whole backlog on every repaint, and pty output drives frames frequently.

Extract the per-issue body as `issueSessionStateFor(issue): IssueSessionInfo | undefined` and have `getIssueSessionStates()` call it in its loop, so there is one implementation. The preview's port calls the single-issue form.

Cache the result on the preview's side per `(issueId, poll generation)` if profiling shows the single `existsSync` still costs at frame rate; do not pre-optimise past the extraction.

- [ ] **Step 4: Implement `buildPreflightLines`**

```typescript
export function buildPreflightLines(pf: Preflight, cols: number): DetailLine[];
```

Label/value pairs under a "Starting will create" heading, labels padded to a fixed width, stacking label-above-value when `cols < 40`. For `manual`, one dim line: `No repo mapped for ${team ?? "this issue's team"} — Start opens the session picker.` For `existing`, one line naming the session it will switch to.

- [ ] **Step 5: Tests**

Full matrix: three `issueState` values × mapped/unmapped repo × agent on/off × tracker present/absent. Assert specifically that `issueState === "session"` with no `repoDir` still yields `switch` (rule 1's ordering), and that `wtmIntegration: false` yields `worktreeTool: "git"`.

**Verify:** `bun test src/__tests__/ghost-preflight.test.ts` and `bun run typecheck`.

---

## Task 3: Pure navigation stepping

**Files:**
- Create: `src/nav-order.ts`
- Create: `src/__tests__/nav-order.test.ts`

Extracted as its own pure module because v1 got the fallback wrong by asserting from memory, and this is the one part of the wiring a unit test can actually pin down.

- [ ] **Step 1: Define and implement**

```typescript
export type NavTarget =
  | { type: "session"; sessionId: string }
  | { type: "ghost"; issueId: string };

/** Current focus within the virtual cycle [Overview, ...targets]. */
export type NavFocus =
  | { type: "overview" }
  | { type: "session"; sessionId: string }
  | { type: "ghost"; issueId: string };

export function resolveNavStep(
  targets: readonly NavTarget[],
  focus: NavFocus,
  offset: number,
): NavFocus;
```

Semantics preserve today's behaviour at `main.ts:1611-1628`: position `0` is Overview, targets occupy `1..n`. A focus not present in `targets` — the focused ghost left nav order between keypresses, or the current session is filtered out — falls back to `Math.min(1, targets.length)`, which is `0` (Overview) when there are no targets at all. v1 wrote "position 1"; that is wrong for an empty list.

- [ ] **Step 2: Tests**

Empty target list in both directions (must yield Overview, never index into nothing); wrap at both ends; focus absent from targets in both directions; a ghost focus stepping onto a session and vice versa; single-target list.

**Verify:** `bun test src/__tests__/nav-order.test.ts`.

---

## Task 4: The `GhostPreview` screen

**Files:**
- Create: `src/ghost-preview.ts`
- Create: `src/__tests__/ghost-preview.test.ts`
- Modify: `src/__tests__/chrome-token-lint.test.ts`

- [ ] **Step 1: Define the port**

Same dependency shape as `WorkflowPort` — the screen knows nothing about tmux, adapters or config.

```typescript
/** Why a start attempt ended. The caller cannot infer this from a bare
 *  promise: startWorkOnIssue catches its own failures into an error modal
 *  (main.ts:4295) and the unmapped-repo path opens NewSessionModal and
 *  returns (main.ts:4313) — both resolve normally. */
export type StartOutcome =
  | "switched"        // an existing session was targeted
  | "created"         // a session was provisioned
  | "handed-off"      // NewSessionModal opened; the user drives from here
  | "failed"          // an error modal is now up
  | "gone";           // the issue vanished before we could act

export interface GhostPreviewPort {
  getIssue(issueId: string): Issue | null;   // null → the gone state
  getPreflight(issueId: string): Preflight | null;
  onStart(issueId: string): Promise<StartOutcome>;
  onOpenInBrowser(issueId: string): void;
  onChangeStatus(issueId: string): void;
}
```

- [ ] **Step 2: Implement the class**

```typescript
export class GhostPreview {
  get isOpen(): boolean;
  getIssueId(): string | null;
  /** identifier is cached at open: once the issue leaves the global list the
   *  port can no longer supply it, and Issue.id is not human-readable. */
  open(port: GhostPreviewPort, issue: { id: string; identifier: string }): void;
  close(): void;
  render(cols: number, rows: number): CellGrid;
  handleInput(data: string): void;
}
```

Keys: `Esc`/`q` close. `Enter` → `onStart`. `o` → `onOpenInBrowser`. `s` → `onChangeStatus`. `Up`/`Down`/`PgUp`/`PgDn` scroll.

**Start is guarded by an in-flight flag.** `onStart` is async and there is no reentrancy protection anywhere below it; two `Enter` presses would otherwise run overlapping provisioning before `currentSessions` refreshes. While pending, the action bar reads `Starting…` and `Enter` is ignored. On resolution: `switched` and `created` close the surface; `handed-off`, `failed` and `gone` leave it open — there is a modal on top in the first two cases, and closing underneath it would be incoherent.

- [ ] **Step 3: Implement `render`**

Body = `buildIssueDetailLines(issue, contentCols, { afterMetadata: buildPreflightLines(pf, contentCols) })`, painted via `paintDetailLines`. A bottom action bar carries `[↵] Start|Resume|Switch  [s] Status  [o] Open  [Esc] Back`, primary label driven by `pf.action`.

**Clamp `scrollOffset` inside `render`, against the line count just built** — not only when handling keys. Line count is width-dependent (descriptions and comments wrap) and content-dependent (a poll can drop comments), so widening the terminal or a content change can strand the offset past the last line and paint a blank body. The painter trusts whatever offset it is given (`panel-view-renderer.ts:739`) and will not save us.

Layout: left-aligned at `pad = 2` matching the panel's detail pane, capped at 100 columns so a wide terminal does not produce unreadable full-width prose.

When `getIssue` returns null: render the cached identifier, a dim `This issue is no longer available.`, and an action bar reading only `[Esc] Back`.

- [ ] **Step 4: Register with the chrome lint**

Add `"ghost-preview.ts"` to `CHROME_MODULES`.

- [ ] **Step 5: Tests**

Follow `workflow-screen.test.ts` — a stub port, render to a grid, assert on extracted text.

- Each key dispatches to the right port method exactly once; `Esc` and `q` close.
- Action bar reads Start / Resume / Switch across the three `PreviewAction` values.
- Second `Enter` while a start is in flight does not call `onStart` again.
- Each `StartOutcome` produces the specified open/closed result.
- A null issue renders the gone state **with the cached identifier**, and `Enter`/`s`/`o` become no-ops.
- A null `getPreflight` renders without the pre-flight block rather than throwing.
- Rendering at a wider `cols` after scrolling to the bottom still paints content (the clamp).

**Verify:** `bun test src/__tests__/ghost-preview.test.ts src/__tests__/chrome-token-lint.test.ts` and `bun run typecheck`.

---

## Task 5: Sidebar — focused ghost and merged navigation

**Files:**
- Modify: `src/sidebar.ts`
- Modify: `src/__tests__/sidebar.test.ts`

- [ ] **Step 1: Focused-ghost state**

Add `setFocusedGhost(issueId: string | null)` next to `setOverviewActive` (`sidebar.ts:702`).

In `renderGhost` (`sidebar.ts:1325`), compute `isActive = ghost.issueId === this.focusedGhostId` and pass it to both `paintRowChrome` calls, so a focused ghost gets the same rail and `ACTIVE_BG` a focused session gets.

**Rewrite the doc comment.** It currently reads "Never painted as active — a ghost has no session to be attached to, so the `isActive` argument to paintRowChrome is always false." That is about to be false. Replace it with why a ghost *can* now be active: the rail marks what the main area is showing, and the main area can now show a ghost.

- [ ] **Step 2: Add `getNavOrder()` — do not remove `getDisplayOrderIds()` yet**

v1 deleted `getDisplayOrderIds()` here while its only caller lived until Task 6, so the tree could not build in between and Task 6's own verification step was impossible. Add the new method alongside the old one; Task 6 removes the old one in the same commit that repoints the caller.

In `buildRenderPlan`, populate a `navOrder: NavTarget[]` (the type from `nav-order.ts`) wherever a row is emitted — sessions at `sidebar.ts:543` and `:571`, ghosts in the `emitGroup` ghost loop (`:547`) and the flat "Up next" loop (`:596`). Ghosts land in nav order exactly where they render: after their band's sessions on the stage axis, in the flat band otherwise.

Session targets carry `sessionId: string`, resolved from the index at build time — **not** `sessionIndex`. v1 declared the index form and then described resolving to ids and passing them to `switchSession(string)`; one type cannot be both.

Update the comment at `sidebar.ts:579-584` explaining that the flat band is emitted directly "so `displayOrder` stays…" — the flat band now contributes nav entries like every other.

Ghosts suppressed by a filter contribute nothing, because they are never emitted at all. No extra guard needed.

- [ ] **Step 3: Focus reconciliation on rebuild**

`rebuildPlan` resets scroll to zero (`sidebar.ts:806`), and `scrollToActive` (`sidebar.ts:991`) only looks for `activeSessionId`. Extend it to also match a focused ghost row, so that regrouping, a cap change, or keyboard-walking onto an off-screen ghost leaves the focused row visible.

When the focused ghost is not emitted at all — filtered, collapsed, or no longer a ghost — `scrollToActive` is a no-op. That is correct: the surface outlives its row (decision 7).

- [ ] **Step 4: Tests**

- `getNavOrder()` includes ghosts, in render position, on the stage axis **and** the flat axis.
- A filter (`attention` / `active`) removes ghosts from nav order entirely.
- Session targets carry ids that resolve against the session list.
- `setFocusedGhost` paints the rail on both rows of the ghost pair, and clears it on null.
- `setFocusedGhost` on an off-screen ghost scrolls it into view; on a filtered-out ghost it does not throw.
- `getDisplayOrderIds()` still returns exactly what it did before this task (it has not been touched yet).

**Verify:** `bun test src/__tests__/sidebar.test.ts src/__tests__/ghosts.test.ts` and `bun run typecheck` — the tree must build here.

---

## Task 6: Wire the surface into `main.ts`

**Files:**
- Modify: `src/main.ts`

- [ ] **Step 0: Fix `closeModal()` first**

`closeModal()` (`main.ts:3224`) ends with `inputRouter.setModalOpen(false)`, unconditionally. Keyboard input reaches `onModalInput` only while that flag is true (`input-router.ts:735`); otherwise it goes to the pty (`:808`). Modal results call `closeModal()` before their callback (`main.ts:2753`), and the `SIGWINCH` handler calls it too (`main.ts:5410`).

So the moment the status picker closes, the preview would be painted but deaf, and the next `Esc` would leak into tmux.

```typescript
inputRouter.setModalOpen(inputConsumerActive());
```

This is safe for the existing surfaces — settings and workflow paint their own prompts rather than opening modals, which is why the bug has never fired. The preview is the first surface to host a real modal, so it is the first to need this. Do this step first and independently: it is a correctness fix that stands on its own.

- [ ] **Step 1: Instantiate and build the port**

Add `const ghostPreview = new GhostPreview();` and `buildGhostPreviewPort()` alongside `buildWorkflowPort()` (`main.ts:4071`).

`getPreflight(issueId)` composes what exists: `issueSessionStateFor(issue)` (Task 2, Step 3), `resolveIssueRepoDir(issue, configStore.config, homedir())`, `resolveIssueSessionName(issue)`, `repoSettingsFor(repoDir)`, `!!adapters.issueTracker` — then `buildPreflight`.

`onStart` awaits `startGhost(issueId)` and maps its result to a `StartOutcome`. `startGhost` must be changed to report one instead of returning `void`: `gone` when the issue is not in the global list, `switched` when `startWorkOnIssue` took the existing-session branch, `handed-off` when it fell through to `NewSessionModal`, `failed` when the error modal opened, `created` otherwise. Keep `startGhost` as the implementation rather than inlining — its doc comment explains why the session state is looked up rather than assumed, and that reasoning still holds.

- [ ] **Step 2: Open and close**

```typescript
function openGhostPreview(issue: { id: string; identifier: string }): void
function closeGhostPreview(): void
```

`open`:
1. Close settings and workflow (a full-screen surface consumes every keystroke; two at once leaves one painted and deaf — the failure `openWorkflowScreen` already guards at `main.ts:4111`).
2. `closeModal()`.
3. If `inGlass`: `exitGlass()` and set `previewUnparkTarget = preGlassSessionId`. The client stays parked; the preview draws the whole main area (decision 9).
4. `sidebar.setActiveSession("")` + `sidebar.setFocusedGhost(issue.id)`.
5. `inputRouter.setModalOpen(true)`, `applyChromeLayout()`, `scheduleRender()`.

`close`:
1. If `previewUnparkTarget` is set, `switchSession(previewUnparkTarget)` and clear it. Otherwise the client is already on a real session and no tmux round-trip happens.
2. `sidebar.setFocusedGhost(null)` and re-apply the rail via the choke point in Step 3.
3. `inputRouter.setModalOpen(inputConsumerActive())`, `applyChromeLayout()`, `scheduleRender()`.

Add `preGlassSessionId` to `enterGlass()` (`main.ts:6107`), captured at the **top** of the function — the park switch at `main.ts:6121` fires `%client-session-changed`, so by the time the preview opens `currentSessionId` is the park session's id.

- [ ] **Step 3: One choke point for the rail**

Introduce:

```typescript
/** The rail marks the row the main area is showing. While the preview owns the
 *  surface, an authoritative session change updates currentSessionId but must
 *  not pull the rail onto a session the user cannot see. */
function applySessionRail(): void {
  if (ghostPreview.isOpen || inGlass) return;
  sidebar.setActiveSession(currentSessionId ?? "");
}
```

Route both existing writes through it: `resolveClientName()` (`main.ts:2053`) and the `client-session-changed` handler (`main.ts:5629`). `closeGhostPreview` calls it on the way out.

- [ ] **Step 4: Register with every surface-arbitration point**

Each of these currently enumerates full-screen surfaces or needs to start:

1. `inputConsumerActive()` (`main.ts:4154`) — add `ghostPreview.isOpen`. Already enumerates.
2. `activeChromeLayout()` (`main.ts:1915`) — add `ghostPreview.isOpen`. Already enumerates.
3. `openWorkflowScreen()` (`main.ts:4111`) — currently closes only settings; add the preview.
4. `toggleSettingsScreen()` — currently handles only settings; add the preview.
5. `enterGlass()` (`main.ts:6107`) — currently checks no other surface; add the preview.

v1 claimed all four "currently enumerate the full-screen surfaces". Three of them do not — 3, 4 and 5 are additions, not edits to an existing list.

- [ ] **Step 5: Render branch**

In `renderFrame`, after the workflow branch and before the glass branch:

```typescript
if (ghostPreview.isOpen) {
  const sidebarGrid = sidebarShown ? sidebar.getGrid() : null;
  const totalCols = fullScreenLayout.termCols;
  const contentCols = sidebarShown ? totalCols - fullScreenLayout.main.x : totalCols;
  const overlay = computeModalOverlay(fullScreenLayout);
  renderer.render(
    fullScreenLayout,
    ghostPreview.render(contentCols, fullScreenLayout.contentRows),
    { x: 0, y: 0 },
    sidebarGrid,
    null,                        // no toolbar
    overlay?.grid ?? null,       // modals DO composite — see below
    overlay?.cursor ?? null,
    undefined, undefined,
    dragChrome(),
  );
  return;
}
```

**The modal overlay is not optional here.** Settings and workflow pass `null` because they paint their own pickers. The preview opens a real `ListModal` for the status action; passing `null` would open the picker invisibly.

- [ ] **Step 6: Input routing**

In `onModalInput` (`main.ts:2734`), after workflow and settings, guarded on no modal being open:

```typescript
if (ghostPreview.isOpen && !activeModal?.isOpen()) {
  handleGhostPreviewInput(data);
  return;
}
```

The guard is what lets the status picker receive keys. `handleGhostPreviewInput` mirrors `handleWorkflowInput` (`main.ts:4131`): call through, and if the screen closed itself on `Esc`/`q`, run the `closeGhostPreview` re-sync rather than duplicating it inline.

- [ ] **Step 7: Close on session switch**

Add a preview close at the top of `switchSession`, guarded against the unpark in Step 2 re-entering it. One central closer covers sidebar clicks, keyboard navigation and the command palette.

**Verify:** `bun run typecheck`, `bun test`. Then `bun run dev`: open a preview, `Esc` returns to the live session; open the status picker, pick a status, and confirm `Esc` still reaches the preview (the Step 0 fix); resize with the picker open and confirm the same; open a preview from glass and confirm `Esc` lands on the pre-glass session, not the parked one.

---

## Task 7: Replace the click-to-provision behaviour

**Files:**
- Modify: `src/main.ts`
- Modify: `src/sidebar.ts` (remove `getDisplayOrderIds`)

- [ ] **Step 1: Repoint the sidebar click**

At `main.ts:2622` the ghost branch becomes `openGhostPreview({ id, identifier })`, looking the identifier up from the global issue list. `startGhost` is no longer called from here.

Note the mouse path reaches this before any modal or full-screen gate (`input-router.ts:605`), which is why Step 2 of Task 6 handles `inGlass` inside `openGhostPreview` rather than relying on a caller to have cleared it.

- [ ] **Step 2: Status and browser actions**

`onChangeStatus` reuses the panel's flow (`main.ts:3193`) with two additions required by decision 3 and by the stale-picker race:

- A `.catch` on `updateStatus` that toasts the failure and calls `refreshGlobalItem` to pull the true status back.
- A guard on the `getAvailableStatuses().then(...)` callback: if the preview has closed or moved to a different issue since the request was made, drop the result instead of opening a picker over an unrelated screen.

`onOpenInBrowser` calls `adapters.issueTracker.openInBrowser(issueId)`.

The preview stays open after a status change — the issue may leave the ghost set as a direct result of what you just did, and closing the screen out from under you at that moment is the worst possible time to do it.

- [ ] **Step 3: Merge ghosts into `switchByOffset`, and retire `getDisplayOrderIds`**

Rewrite `switchByOffset` (`main.ts:1611`) over `sidebar.getNavOrder()` and `resolveNavStep` from Task 3. Current focus is `{type:"overview"}` when `inGlass`, `{type:"ghost", issueId}` when the preview is open, else `{type:"session", sessionId: currentSessionId}`.

Dispatch on the returned focus: `overview` → `enterGlass`; `session` → `switchSession` (or `leaveGlass`); `ghost` → `openGhostPreview`.

Delete `getDisplayOrderIds()` in this same step, now that its caller is gone.

`startUpNext` (`Ctrl-a u`) is **unchanged** and still starts in one gesture. It is an explicit start command, not a selection; what this plan removes is provisioning as a side effect of *selecting*.

**Verify:** `bun run typecheck`, `bun test`. Then in `bun run dev`: click a ghost and confirm nothing is provisioned; press Enter and confirm the session appears as before; press Enter twice quickly and confirm only one session is created; hold Ctrl-Shift-Down through a band containing both sessions and ghosts, and through an empty sidebar.

---

## Task 8: Documentation

**Files:** `CLAUDE.md`, `docs/cheat-sheet.md`, `docs/issue-tracking.md`, `IDEAS.md`

- [ ] **Step 1: `CLAUDE.md` — the ghost-rows section**

Two claims go false and must be rewritten, not appended to:

- "clicking one runs the same `startWorkOnIssue` flow as `n` in the issues panel" → clicking opens the preview; the preview's Enter runs `startWorkOnIssue`.
- "Ghosts stay out of `displayOrder` in both placements (a Ctrl-Shift-Up/Down that provisioned a worktree would be a destructive surprise)" → ghosts are in nav order; record that the exclusion was justified *only* by selection being destructive.

Add: the "poll never closes the preview" invariant; the rail choke point and why `resolveClientName` must not write it directly; the glass unpark ownership (decision 9); and the `closeModal` routing rule, which is a general trap the next surface will hit.

- [ ] **Step 2: `docs/cheat-sheet.md`** — the preview's keys, and that Ctrl-Shift-Up/Down now walks unstarted work.

- [ ] **Step 3: `docs/issue-tracking.md`** — the preview flow, and the CLI-created-session limitation from decision 6 stated plainly.

- [ ] **Step 4: `IDEAS.md`** — remove the implemented idea.

**Verify:** re-read the ghost-rows section against the shipped code; every claim must still hold.

---

## Definition of done

- [ ] `bun run typecheck` clean **at the end of every task**, not only at the end
- [ ] `bun test` green, including new `issue-detail`, `ghost-preflight`, `nav-order` and `ghost-preview` suites
- [ ] `bun run docker` clean-env sanity check
- [ ] Manual walkthrough — the transitions no unit test reaches, because they live in `main.ts` wiring:
  - [ ] Click a ghost → preview, no worktree created; Enter → session created as before
  - [ ] Status picker: open, pick, and confirm `Esc` still reaches the preview afterwards
  - [ ] Resize the terminal with the status picker open; confirm the preview is still listening
  - [ ] Resize wide while scrolled to the bottom of a long description; body must not go blank
  - [ ] Open a preview from glass; `Esc` lands on the pre-glass session, not the parked one
  - [ ] Switch sessions from a second tmux client while previewing; rail must stay on the ghost
  - [ ] Apply a filter while previewing; the surface stays, the row goes
  - [ ] Double-Enter on Start creates exactly one session
- [ ] No claim in `CLAUDE.md`'s ghost-rows section contradicts the code

## Out of scope

- **Unifying session discovery on `@jmux-linear-issue`** — decision 6's limitation. Real, pre-existing, shared with the info panel's `n` key. Fixing it here would widen this change into the CLI's data model.
- **Rollback for optimistic status writes** — decision 3. The preview adds error surfacing; true rollback belongs to whoever owns the panel's copy of that flow.
- **Editable pre-flight** — `NewSessionModal`'s job; duplicating it would give jmux two ways to configure a new session.
- **The info panel adopting the full surface** — worth doing eventually, roughly doubles this change.
- **Promoting an issue within `pipeline.upNext`** from the preview.
- **Moving the focused ghost into its own sidebar section** while previewing.
- **Hover-to-preview.**
