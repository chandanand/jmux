# Sidebar workflow status and drift

Date: 2026-08-09

## Problem

Two gaps in what the sidebar says about a session's workflow position.

**A collapsed row never names the status.** Row 1 carries the driving issue's
identifier (`TRA-123 +4`); row 2 carries the branch, timer, MR id and pipeline
glyph. The status itself appears only in a stage band header — which exists on
one grouping axis of four — or in the disclosure sub-rows, which cost a
keystroke and vertical space. Grouped by project or by name, the workflow status
is absent from the one surface that is always on screen.

**Nothing reports a status that has stopped being true.** `transitions.ts` fires
on *edges* and never on levels, deliberately: a condition already true when jmux
started must not replay history into a shared tracker. The cost of that
correctness is that every missed edge — jmux restarted, the session was adopted
after the MR merged, the write failed, the event has no configured target —
leaves a permanent silent divergence between the tracker and reality. jmux holds
both facts and says nothing.

## Approach

Both gaps are one field. Row 2's head says where the driving issue sits, and
drift is that same field saying the position disagrees with reality.

jmux writes on edges and reads on levels. A drift marker is the level the edge
missed. Reporting a level is exactly what the "bias toward doing nothing" in
`transitions.ts` forbids *writing* on, so this adds no new write jmux performs
on its own initiative.

## The stage field

A new field at the head of row 2, before the branch.

```
 ▶ auth-refactor    TRA-123
   Review · feat/auth  !88 ✓
```

**It describes the driving issue** — the same issue the row-1 badge names, via
the same `orderedSessionIssues` construction. Field and badge cannot disagree.

**Contents:** the label of the `PanelView` stage whose `states` claim the
issue's status. When no stage claims it, the raw status name. That is the hole
being filled rather than a second rule — `work-stage.ts` already establishes
that stages drive behaviour and raw state names drive display.

**Collapsed is coarse, expanded is precise.** "In Review" and "Awaiting QA" both
read `Review` here; the disclosure sub-rows already show the raw status. This is
the progressive disclosure the sidebar already does, not a new concept.

**`inSidebar: false` does not suppress the word.** Hiding a stage hides its
*header*. This is not a header, and the existing rule — hiding a stage must
never hide its sessions — extends to hiding what those sessions say about
themselves.

**Drop order.** The right-hand cluster (pipeline glyph, MR id, timer, context,
pinned count) is unchanged and still lays out right to left. The branch then
truncates, then drops entirely; then the stage word degrades to its `stateType`
glyph from the table already in `sidebar.ts`; then nothing.

The stage outranks the branch because on the wtm flow the branch name is derived
from the session name one row above. It is the only field on that row repeating
something already on screen.

A middot separates the field from the branch. When the branch drops, so does
the separator — the field is then the row's only left-hand content.

**Attributes.** Non-drift is dim, like the branch beside it: the word is the
signal, not its colour. Drift takes the sidebar's existing attention attributes
(`stateAttrs.waiting`), because drift is news.

## Drift

### Definition

Drift is a level: an event's precondition holds and the ticket never reached the
state configured for that event.

**One statement per session**, strongest event first:

1. `mr-merged` — any of the session's MRs has `status === "merged"`
2. `mr-open` — any has `status` of `"open"` or `"draft"`
3. `session-start` — the session exists

The first whose precondition holds is the only one worth saying. No edge
tracking is involved; that is the point.

**An issue drifts when its stage rank is behind the configured target's stage
rank.** Rank is `panelViews.indexOf(stageForState(panelViews, status))` — the
priority order arranged in the workflow screen. A ticket moved *past* the target
is therefore not flagged.

**Targets resolve per issue**, through
`transitionTarget(event, repoSettingsFor(resolveIssueRepoDir(issue, …)))`.
Transitions are configured per repo and a session's hand-linked issues can come
from teams that map elsewhere, so there is no single target for a session.

**Silent when it cannot be ordered.** No configured target, the issue's status
claimed by no stage, or the target claimed by no stage — any of these produces
no drift for that issue. A drift claim without an ordering is a guess, and a
guess must not displace a fact.

**Finished issues never drift**, the same exemption `checkMrTransitions` already
applies: re-moving a closed ticket because a later MR merged is a write nobody
asked for.

### Display

The field carries it, degrading in this order:

```
Review→Done   →Done   !
```

The target is the actionable half — it is also what the fix key will write — so
the current stage gives way first.

```
 ▶ auth-refactor    TRA-123
   Review→Done  !88 ✓
```

The minimal form is `!` and not `⚠`: this sidebar tracks columns explicitly and
`⚠` is width-ambiguous across terminals, which is exactly the class of drift
between the `cellWidth` table and the real terminal that produces ghost gaps.
`!` already reads as attention here, in column 1.

**The field reports the driving issue only**, so that badge, field and
disclosure agree by construction. The drifting *set* can be larger: a session
whose driving issue cannot be ordered while a later one can shows no marker
collapsed. That case is rare — the driving issue is the least advanced — and an
honest blank beats a marker whose row cannot name what it refers to.

The disclosure sub-rows mark every drifting issue, so expanding a session always
shows the full set the fix key will act on. This reuses the sub-row's existing
right-aligned status field, which today shows the raw status and falls back to a
`stateType` glyph. A drifting row extends that chain with the target in front:

```
In Review→Done   →Done   In Review   ◐
```

Naming both is affordable in a sub-row (no branch, no timer, no MR), and the
raw status is the reason to expand in the first place — so it is only the
*target* that drops next, leaving the plain status chain the row already has.

### The fix

`Ctrl-a m` on the focused session applies the configured target to **every**
drifting issue it carries, as one `recordUndo` batch. `Ctrl-a Z` already undoes
it.

It **bypasses `transitionConfirm`**. That policy governs writes jmux makes on
its own initiative; this one was asked for. Same reasoning as `ctl issue move`
and `startWorkOnIssue`.

No drift on the focused session produces a footer notice saying so, in
`sectionedViewNotice()`'s shape. A key that looks like it acts must never
silently no-op.

### Reporting the inert case

Drift needs both a configured transition target and statuses mapped to stages.
Either missing makes it silently do nothing while looking configured — the exact
failure the workflow screen exists to prevent. The workflow screen gains one
line in `parkingSetupWarning`'s shape, naming which half is missing.

## Components

### `src/workflow-drift.ts` (new, pure)

Imports adapter *types* only. Config and tracker lookups are injected:

```ts
interface WorkflowInputs {
  stageOf: (status: string) =>
    { id: string; label: string; rank: number; inSidebar: boolean } | null;
  targetFor: (issue: Pick<Issue, "team">, event: TransitionEvent) => string | null;
}

function detectDrift(
  issues: readonly Issue[],
  mrs: readonly Pick<MergeRequest, "status">[],
  inputs: WorkflowInputs,
): { event: TransitionEvent; moves: Array<{ issue: Issue; target: string }> } | null;

function buildSessionWorkflow(
  issues: readonly Issue[],
  mrs: readonly Pick<MergeRequest, "status">[],
  inputs: WorkflowInputs,
): SessionWorkflow | null;
```

`buildSessionWorkflow` is built on `detectDrift`, setting `drift` only when the
driving issue appears in `moves`. The fix key calls `detectDrift` directly and
acts on every move. That relationship is load-bearing: the marker and the key
read the same function, so the key cannot move a set the row's own rules never
derived. Same reason `itemsInGroup` reads its answer back off `buildViewNodes`
rather than re-deriving it.

`SessionWorkflow.label` equals `band.label` whenever a stage claims the status;
they differ only in the fallback, where `band` is null and `label` is the raw
status name.

### `src/sidebar-sort.ts` — `SessionWorkflow` replaces `StageBucket`

```ts
interface SessionWorkflow {
  /** The band this groups under. Null when no stage claims the status,
   *  or the stage is hidden from the sidebar. */
  band: { id: string; label: string; rank: number } | null;
  /** Row 2's head: the stage label, or the raw status when no stage claims it. */
  label: string;
  /** What the label degrades to when the column runs out. */
  stateType?: IssueStateType;
  /** Where the workflow says it should be, when that disagrees with where it is. */
  drift: { target: string } | null;
}
```

`StageBucket` is deleted rather than kept alongside — this is internal, so no
compatibility shim. Its only consumers are `main.ts` and `sidebar.test.ts`.

### `src/sidebar.ts`

`setSessionStages` becomes `setSessionWorkflow`, taking one entry per session
that has a driving issue. Same boundary as `setParkedSessions`: everything is
pre-resolved by the caller and the sidebar learns nothing about trackers or
config.

Grouping keys on `band`, so `band: null` falls to the flat remainder exactly as
today — that path is unchanged, which keeps "hiding a stage never hides a
session" true without restating it.

`renderSession` writes the field at column 3 on the detail row, then gives the
branch what is left between it and `rightEdge`, separated by a middot.

### `src/main.ts`

`recomputeSessionBands()` already loops every session with its context and its
resolved stage. The `stageView && stageInSidebar(stageView)` block becomes one
`buildSessionWorkflow` call. The result is retained in a module-level map
because the fix key needs it too.

`requestTransitions`'s non-confirm branch — apply each move, collect the results,
`recordUndo` once — extracts to `applyMoves(moves, event)`. Both it and the fix
key call that, so there is one write path and one undo shape.

### `src/keymap.ts`

One entry: `Ctrl-a m`, "Move the issue where the workflow says it should be",
section "Work pipeline".

`m` is tmux's default `mark-pane`, which the soft prefix intercept therefore
takes over. That is not new — jmux already intercepts `n` and `p`, which are
tmux's `next-window` and `previous-window` — and `mark-pane` is a far quieter
loss than either.

## Data flow

```
poll → SessionContext (issues, mrs)
     → recomputeSessionBands()
        → buildSessionWorkflow(issues, mrs, {stageOf, targetFor})
        → sidebar.setSessionWorkflow(map)   [render]
        → sessionWorkflow map               [Ctrl-a m]

Ctrl-a m → detectDrift(same inputs) → applyMoves() → recordUndo()
```

## Failure

Everything fails closed.

- A `degraded` context that lost its MRs reports no merged/open event and falls
  back to `session-start`, whose precondition does not involve MRs — the same
  answer a complete context gives.
- A context that lost its issues has no driving issue and produces no entry at
  all: no field, no band, no drift.
- A stale poll makes the marker exactly as stale as the badge above it. That
  coupling is honest; suppressing it would need state that could itself go
  stale.
- A failed `applyTransition` already returns null and is filtered by
  `recordUndo`. The marker stays up, which is the correct report of a write that
  did not land.
- A transition jmux fires itself may leave a marker visible for at most one poll
  interval before the re-read clears it. Not worth suppressing with state.

## Testing

**`src/__tests__/workflow-drift.test.ts`** (new, pure):

- event precedence: merged beats open beats session-start
- a ticket moved past the target is not flagged
- unorderable returns null in all three ways: no configured target, issue status
  claimed by no stage, target claimed by no stage
- finished issues are exempt
- targets resolve per issue when a session's issues span teams
- `detectDrift` and `buildSessionWorkflow` agree on the drifting set

**`src/__tests__/sidebar.test.ts`** (additions, render plan):

- the field appears at 26 columns
- the branch truncates then drops before the field gives way
- the field degrades to its `stateType` glyph
- the drift chain: `Review→Done` → `→Done` → `!`
- the sub-row chain: `In Review→Done` → `→Done` → `In Review` → glyph
- a drifting non-driving issue is marked in the sub-rows and absent from the
  collapsed field
- `inSidebar: false` still renders the word and draws no band
- existing `setSessionStages` call sites migrate to `setSessionWorkflow`

No integration test. `main.ts` only wires; every rule lives in the pure module,
which is the reason for putting it there.

## Changed during implementation

Five departures from the design above, each recorded here rather than silently
absorbed:

- **The field is suppressed where a header already carries it.** The design had
  row 2 naming the stage on every axis. Under `group=stage` that puts `Review`
  under a `REVIEW` header — redundancy paid for with six columns of branch. The
  word is dropped there and drift shortens to `→Done`, since the header supplies
  where the ticket is and nothing supplies where it should be. The predicate is
  stamped on the `RenderItem` at placement, not re-derived at paint: a session
  under `group=stage` still lands in Pinned or Parked for its own reasons, and
  those headers name neither.

- **`SessionWorkflow` lives in `workflow-drift.ts`, not `sidebar-sort.ts`.**
  It is defined where it is built. `sidebar.ts` imports it `import type`, so the
  runtime coupling is nil and the sidebar still learns nothing about trackers.
  `sidebar-sort.ts` keeps a pointer where `StageBucket` used to be.

- **The strongest event falls through when it produces no move.** The design
  said the first event whose precondition holds is the only one worth saying. In
  practice a merged MR with no `onMrMerged` configured would then mask a
  correctly-configured `onSessionStart` report sitting underneath it. Still one
  statement per session — the strongest one that *exists*.

- **`applyMoves` was not extracted from `requestTransitions`.** `applyStatusPick`
  and `pickStatusFor` already are the user-initiated write path, with the same
  one-undo-per-decision rule. Reusing them is less churn and brings the
  optimistic status update for free, which is what clears the marker on the next
  frame rather than the next poll. `requestTransitions` is untouched.

- **The inert-case line is in the settings screen's Diagnostics, not the
  workflow screen.** That is where `parkingSetupWarning` actually renders, so
  the two sit together. `driftSetupWarning` reports two conditions: no
  transition target configured anywhere, and — outranking it — no linked issues
  to check at all. The second exists because the predicate for the first is
  derived by scanning live sessions' issues, so an empty set made "configured
  and no target found" indistinguishable from "nothing to look at". On a fresh
  install that named a cause the user could act on, and acting on it changed
  nothing. The third part of the setup ("N statuses unmapped") stays on the
  workflow row above it; saying it twice would suggest two settings where there
  is one.

## Out of scope

- `ctl workflow drift`. The module would serve it unchanged, but the CLI is its
  own ask.
- A general status picker on the sidebar. The info panel's `s` already covers
  that; `Ctrl-a m` is deliberately the narrow, unambiguous case where the target
  is already configured.
- Per-stage colour configuration. Drift uses the existing attention colour;
  non-drift is dim.
