# First-run onboarding

Status: design of record.

Supersedes §12 ("Phase 3 — onboarding") of
`2026-08-11-projects-and-onboarding-design.md`, which deferred onboarding and
sketched it as a better checklist. This replaces the checklist.

Revised once after adversarial review. The review killed the first draft's
central argument and two of its pages; where this deletes something the first
draft proposed building, §16 records why.

---

## 1. The failure this comes from

Six diagnosed defects in the current first run (`src/setup-modal.ts`, rows built
at `main.ts:6171`):

1. **Subprocess output corrupts the alt screen.** `installSkill()`
   (`skill.ts:161`) writes with `console.log` — correct for
   `jmux --install-skill`, wrong when the setup modal calls the same function
   from inside the TUI. `jmux-control skill: installed to …`, `Agents running
   inside jmux can now discover 'jmux ctl'.` and `hunk-review skill: hunk not
   found — skipped` land directly on the rendered frame.
2. **Four of eight steps abandon the user.** `project-dirs`, `attach-team`,
   `workflow` and `tracker`-with-no-adapter all `closeModal()` and drop the user
   into the settings or workflow screen with no explanation and no way back.
3. **The progress figure contradicts the list** — `1/5 done` above eight visible
   rows, because the denominator counts only "actionable" rows.
4. **Four unexplained state glyphs** (`✓ ○ · —`), two of which mean different
   kinds of "not yet".
5. **Steps state raw facts, not consequences** — `5 failing`, `none configured`,
   `npm i -g hunkdiff`. One row shows a shell command the user is apparently
   expected to go and run themselves.
6. **No sense of place.** No narrative, no statement of what jmux is, no
   confirmation at the end that anything works.

### 1.1 What actually causes defect 2

`activeModal` is a single slot (`main.ts:6101`), and `SetupModal` reaches for
input by calling `openModal()` with a *new* modal — which evicts it
(`main.ts:6359`). So every step needing input destroys the flow.

**This is a choice, not a constraint.** `NewSessionModal` (`new-session-modal.ts:41`)
already solves it: it owns a `stepStack` of `ListModal | InputModal`, delegates
`handleInput` to `currentInner`, and intercepts Esc to pop back a step — a
multi-step wizard hosting child collectors inside one modal slot.

An earlier draft of this spec claimed a modal structurally could not do this and
used that to justify a fifth full-area surface. **The claim was false and the
surface is not built.** See §16.

## 2. Non-goals

- Rewriting the settings or workflow screens.
- A fifth full-area surface (§3).
- Provisioning sessions from inside onboarding (§7).
- A pre-TUI renderer. The dependency gate gets copy, not chrome (§11.3).
- Interrupting existing users: anyone with a `config.json` sees no new screen on
  upgrade.

---

# Part I — Shape

## 3. A composite modal, on the NewSessionModal pattern

`OnboardingModal` implements `Modal` (`modal.ts:15`) and owns its children
directly, never through `openModal()`. Input flows
`InputRouter → onModalInput → OnboardingModal.handleInput → currentInner`, which
is routing that already exists and needs no change.

What this buys over the rejected surface: no new term in the four full-area
disjunctions, no new render branch, no `inputConsumerActive` question, and no
purpose-specific-predicate refactor. The three surfaces' membership sets
genuinely differ (glass is in some and not others), so a single
`fullAreaSurfaceOpen()` was never one concept — that extraction is dropped.

### 3.1 Module boundaries

`main.ts` cannot be imported by tests, so everything testable lives outside it.

| Module | Owns | Knows nothing about |
| --- | --- | --- |
| `src/onboarding/flow.ts` | State machine: which pages exist, cursor, back/next, busy state. **Pure.** | Rendering, tmux, config, adapters |
| `src/onboarding/pages.ts` | Page table: id, title, prose, status. **Pure over a snapshot.** | The port's implementation |
| `src/onboarding/render.ts` | `CellGrid` painting: rail, measure, action bar | Flow semantics |
| `src/onboarding/modal.ts` | `OnboardingModal`: the `Modal` impl and the child stack | Anything outside `OnboardingPort` |
| `src/onboarding/status.ts` | `SetupStatus`: the snapshot and its invalidation (§4) | Rendering |
| `main.ts` | Wiring: builds the port, owns the status model | — |

### 3.2 Resize must not destroy the flow

SIGWINCH unconditionally closes `activeModal` (`main.ts:10473`) — modals size
themselves at open, so this is right for every existing one. For onboarding it
would discard the whole flow, including a half-typed token, on a window drag.

**`Modal` gains an optional `onResize(cols, rows): void`.** SIGWINCH calls it
when present and closes the modal when absent, so every existing modal keeps
today's behaviour byte for byte and only onboarding opts in. A small, general
change with one caller — not a speculative abstraction, because the defect it
fixes is real and reachable by dragging a window.

Tested: resize on every input-bearing page preserves the draft.

## 4. The status model lives above the modal

The snapshot — agent presence, skill state, tracker auth, Projects, workflow
tabs, `hunk` on PATH — is owned by `main.ts`, **not** by the modal. Two reasons:

- The **toolbar dot needs it when no modal is open.** `setupStepsOutstanding()`
  (`main.ts:1140`) runs per frame from `makeToolbar` and today rebuilds rows
  behind a 5s cache.
- The **config watcher** (`main.ts:10487`) can reload Projects, project dirs,
  workflow views and `setup` state while the flow is open. A snapshot owned by
  the modal and refreshed only on its own actions would go stale under the
  user's own edit.

Invalidation is explicit and complete: **on open, after any onboarding action
resolves, on adapter-epoch change, and on config-watcher reload.** `pages.ts` is
a pure function of the snapshot, so a page's state and its copy cannot disagree,
and no test touches a filesystem.

`buildSetupRows()` (`main.ts:6171`) is replaced by the snapshot builder;
`setupStepsOutstanding()` reads the snapshot rather than rebuilding rows.

## 5. Deletions

- `src/setup-modal.ts` with `SetupRow` / `SetupState` / `SetupProviders`.
- `src/__tests__/setup-modal.test.ts`. Its behavioural coverage — scroll
  clamping, cursor wrap over painted rows, activation refusing inert rows — is
  **ported** to `flow.test.ts`, not dropped. Enumerated in the plan so the port
  is verifiable rather than asserted.
- `buildSetupRows()`.

`runSetupPreflight()` / `runDeepPreflight()` survive in substance: they are the
honest read-only "does it work" check, and the comment at `main.ts:1166` argues
correctly against the throwaway-session alternative. They become the finish
page's data.

---

# Part II — The model

## 6. Three states, one deleted by geometry

- **`blocked` is deleted.** "Something else must happen first" is what a
  sequence is. A page needing the tracker comes after the tracker page.
- **`unavailable` stops being a glyph and becomes prose on a page you are
  standing on.** "Install Claude Code, Codex or pi and this will light up" is a
  sentence, not a `—`.

`satisfied | pending | unavailable` remain, and none ever appears as a bare
glyph needing a legend: sentences on a page, words in a column on the map.

**The rail carries position only** — a segmented bar plus `Step 2 of 3`. Filled
is behind you, hollow ahead. It never duplicates state, which is what stops
defect 3 reappearing in a new costume.

## 7. What earns a page

A step earns a page when **the user must make a decision jmux cannot make for
them** — and can be *completed* inside the flow.

| Today's row | Verdict |
| --- | --- |
| Project directories | **Earns one**, but it must adopt **Projects**, not scan roots. See §8. |
| Agent hooks + `ctl` skill | **Earns one, jointly.** No decision, but it writes into another tool's config, so it needs consent — and it is one idea. |
| Tracker credential | **Earns one**, tracker arm only. |
| Team ↔ project | **Earns one**, tracker arm only. |
| Session naming | **Earns one.** Only the user knows whether they want a model naming their sessions, and it costs a subprocess per session. Reuses `TITLE_PRESETS`, offering only presets whose binary is on `PATH`. |
| Workflow stages | **Earns a pre-answered page.** `suggestLayout()` (`panel-view.ts:521`) already guesses. `↵` accepts. |
| "Check it all works" | **Not a page.** It is the finish. |
| Install the diff viewer | **Not a page.** One line on the finish page — never a shell command handed over mid-flow. |
| *(first draft's)* Start your first session | **Cut. See below.** |

### 7.1 Why session provisioning is cut

The first draft ended each arm by provisioning a real session, arguing that a
real session is safer than a throwaway because nothing needs cleaning up. Three
facts kill it:

- **The generic creation path does not launch an agent** (`main.ts:9607`), so
  the promised "an agent already running inside" was undeliverable as specified.
- **Failed provisioning deliberately leaves debris** — session, setup pane and
  partial worktree are kept visible for diagnosis (`issue-provision.ts` and its
  header comment). Making that mandatory during setup manufactures the debris
  the argument claimed to avoid.
- **Creating a session needs directory, standard-vs-worktree, base branch and
  name** (`new-session-modal.ts:144`); the tracker arm additionally needs issue
  selection, route resolution and prompt construction. Reproducing either inside
  onboarding is a second copy of a flow that already exists and works.

So the finish page **hands off**: `↵` closes onboarding and opens the existing
`NewSessionModal`, or the issues panel on the tracker arm. The user's first
session is created by the machinery that is good at it, one keystroke later.

## 8. Projects, not project dirs

`projectDirs?: string[]` (`config.ts:184`) are **scan roots**. `projects?:
ProjectConfig[]` (`config.ts:115`) are what team attachment operates on, and
what `ProjectConfig` requires — id, title, dir — is not derivable from a scan
root alone.

The first draft's page 1 wrote the former and its team page read the latter, so
the tracker arm was structurally broken: attach-team would have found no
Projects to attach to.

**Page 1 therefore does both.** It takes a directory, scans it, and lets the
user adopt repositories found under it as Projects — id generated once, title
defaulting to the basename, `dir` the repo directory. The scan root is still
stored (`Ctrl-a n` reads it), but adoption is what the page is *for*, and the
copy says so.

## 9. The intent branch is derived, never persisted

```
solo      Welcome → Code → Agents → Naming → Done
tracker   Welcome → Code → Agents → Naming → Tracker → Team → Workflow → Done
manual    Welcome → Map. Nothing configured, nothing claimed.
```

The first draft persisted `config.setup.intent`. Cut, for the reason
`setup-modal.ts`'s own header states: **machine truth is derived, never
stored.** A stored route intent is a second source of truth that can disagree
with what is actually configured, and `config.ts:570` casts the parsed document
to `JmuxConfig` without validating it, so a TypeScript union buys nothing
against a hand-edited file.

Intent is in-memory flow state for the current visit. On re-entry the map
derives which steps are in play from what is true — tracker connected, or
`setup.tracker === "never"` (`config.ts:128`, which already exists and is
already the file's home for declared preference no filesystem check can
discover).

## 10. Navigation

`←` back · `→` next · `↵` acts on the selected thing within the page ·
`esc` zooms out.

1. **`→` never requires completion.** Blocking next is how a wizard becomes a
   hostage situation, and it is what would make "no tracker account today"
   unrecoverable. The map records what was skipped; the finish page names it.
2. **`esc` zooms out.** From a page to the map; from the map, close. One
   gesture, one meaning — and `NewSessionModal` already implements exactly this
   pop-a-step-then-close behaviour (`new-session-modal.ts:106`).
3. **An unavailable page is still shown**, with prose and a `→`. Silently
   dropping it would make `Step 2 of 3` lie. A page the intent did not ask for
   is never created at all — a different thing, needing no explanation.

## 11. Async actions have a contract

Token verification, agent installation and repository scanning all outlive a
render and can fail or receive a duplicate `↵`. `GhostPreview` needs a `starting`
guard and typed outcomes for the same reason.

Every async action declares: a **busy** state that locks input on that page and
renders as such; a **typed outcome** (`ok | failed`, with a message); and
**idempotence** — a second `↵` while busy is ignored, not queued. Cancellation
is out of scope; the actions are short and bounded.

---

# Part III — The pages

## 12. Copy

### 12.1 Typographic rules

- **Prose measure caps at `space.measure` (64)**, whatever the modal's width.
- **One vertical rhythm:** title · hairline · blank · prose · blank ·
  interactive block · (flex) · hairline · action bar.
- **The action bar is bottom-pinned via a shared `BOTTOM_RESERVED_ROWS`**, read
  by both render and scroll-clamp — the settings screen's rule, for the reason
  stated there.
- **The accent appears in exactly three places:** page title, cursor row, filled
  rail segment. `tokens.affirmative` for `✓`; `tokens.textTertiary` for keys and
  asides. Nothing else is coloured.

### 12.2 Welcome

```
   jmux                                                     first run

   Run several coding agents at once, and see what they're all doing.

   Every piece of work gets its own tmux session, its own worktree and
   its own agent. The sidebar on your left is the answer to "who needs
   me?".

   What do you want to set up?

   ▸ Just run agents                           3 steps, about a minute
     Somewhere to work, and agent status in the sidebar.

     Agents, wired to my issue tracker                       6 steps
     All of the above, plus start work straight from a ticket.

     I'll do it myself
     Skip all of this. Nothing configured, nothing claimed.

   ───────────────────────────────────────────────────────────────────
   ↑↓ choose   ↵ start
```

Step counts are stated before the commitment.

### 12.3 Where your code lives

```
   Set up jmux                    ━━━●───────────────  Step 1 of 3

   Where your code lives
   ─────────────────────

   jmux works one repository at a time — a session, a worktree and an
   agent per piece of work. Tell it where to look and it will offer
   these when you press Ctrl-a n.

     ~/Code/personal
       ✓ jmux                    ✓ hunk                  wtm
         tracktile-web

   ───────────────────────────────────────────────────────────────────
   ↑↓ move   space adopt   ↵ add a directory   → next   esc overview
```

Ticked repositories become Projects (§8). Adding a directory hosts an
`InputModal`; the scan is async and shows the busy state from §11.

### 12.4 Letting jmux see your agents

```
   Letting jmux see your agents
   ────────────────────────────

   jmux can show RUNNING, WAITING and COMPLETE beside each session, so
   you can tell at a glance which agent is stuck waiting on you. That
   needs a small hook in each agent's own config. It also installs a
   skill, so agents inside jmux can drive sibling sessions themselves.

     Claude Code                         found, not hooked up yet
     Codex                               found, hooks out of date
     pi                                           not installed

   Will write to
     ~/.claude/settings.json
     ~/.codex/hooks.json, ~/.codex/config.toml
   Undo any time with  jmux --uninstall-integrations

   ───────────────────────────────────────────────────────────────────
   ↵ set these up   → skip   ← back   esc overview
```

**The write list is rendered from installer metadata, never hard-coded.** Claude
honours `CLAUDE_CONFIG_DIR` (`agent-hooks/claude.ts`), Codex touches
`config.toml` as well as `hooks.json`, and pi writes two files of its own — so
prose naming `~/.claude/settings.json` unconditionally is wrong on any relocated
config. `AgentIntegration` gains a `writeTargets(): string[]`, and consent
displays what will actually be touched. Consent to edit another tool's config is
only real if it names the true target and the reversal.

**After `↵`** — every line here is text that lands raw on the frame today:

```
     Claude Code                                 ✓ hooked up
     Codex                                       ✓ hooked up
     jmux ctl skill                              ✓ installed
     hunk review skill                hunk not installed, skipped
```

**No agents on this machine** — honest, and not a failure:

```
     No coding agents found on this machine.

   jmux works fine without one: you drive tmux yourself and the sidebar
   shows sessions rather than agent status. Install Claude Code, Codex
   or pi and this page will have something to do.
```

### 12.5 The tracker arm

```
   Connect your issue tracker
   ──────────────────────────

   With a tracker connected your issues appear in the info panel, and
   you can start a session from one — branch, worktree and agent, all
   named after the ticket.

     Tracker                                            Linear
     Token                              ••••••••••••  checking…

   Verified before it's saved, so a bad paste says so rather than
   sitting there looking connected. Stored in
   ~/.config/jmux/credentials.json, mode 0600.
```

resolving to `✓ connected as jarred@tracktile.com` or
`✗ Linear rejected that token`.

```
   Point a project at a team
   ─────────────────────────

   An issue has to become a branch in a repository, and jmux needs to
   know which. Without this, starting work from an issue does nothing
   at all — the most common way a new setup looks broken.

     Core Engineering        →   jmux
     Design                  →   not routed
```

```
   How your work moves
   ───────────────────

   Your tracker has 12 statuses. jmux has grouped them into three
   stages, which drive the sidebar's bands and the info panel's tabs.

     To do            Triage, Backlog
     In progress      Todo, In Progress, In Review
     Done             Done, Cancelled, Duplicate

   Change these any time in the workflow screen — Ctrl-a W.

   ───────────────────────────────────────────────────────────────────
   ↵ use these   → skip   ← back   esc overview
```

**Three stages, not four, and no `e` key.** `SUGGESTED_TABS` (`panel-view.ts:515`)
is exactly To do / In progress / Done; `unstarted` and `started` both fold into
In progress and there is no Blocked stage. The first draft's four-stage table
was fabricated.

The first draft also offered `e` to jump to the workflow screen. Cut:
`openWorkflowScreen()` (`main.ts:7949`) hard-codes settings as the only possible
origin, so `surfaceReturn` would be set to `null` and the return path would
silently not exist — and `returnFromSurface()` runs only when no input consumer
remains, which an open onboarding modal prevents. Seeding plus a pointer to
`Ctrl-a W` costs the user one keystroke later and removes the whole hazard.

### 12.6 Done

```
   You're set up
   ─────────────

   ✓  Two projects — jmux, hunk
   ✓  Claude Code and Codex report their state
   ✓  Linear connected as jarred@tracktile.com

   Three things worth knowing

      Ctrl-a n      start a new piece of work
      Ctrl-a p      the command palette — everything is in here
      Ctrl-a ?      every key jmux binds

   Not set up, and that's fine

      The diff viewer      npm i -g hunkdiff, then Ctrl-a g

   ───────────────────────────────────────────────────────────────────
   ↵ start your first session      esc close
```

`↵` closes onboarding and opens `NewSessionModal` (§7.1). No animation: the
first draft staggered the `✓` lines, which buys a moment of delight for timers,
deadlines, interruption state and a test clock. Rendered immediately.

### 12.7 The map

```
   Set up jmux                                            overview

   ✓   Where your code lives                        2 projects
   ✓   Letting jmux see your agents         Claude Code, Codex
       Connect an issue tracker                        not yet

   ───────────────────────────────────────────────────────────────────
   ↑↓ move   ↵ open   esc close
```

**One glyph, one meaning.** `✓` means done; its absence means not done, with the
right-hand column saying what that amounts to in words. Defect 4 deleted rather
than documented.

---

# Part IV — Engineering

## 13. Installers

`installSkill()` **keeps its `console.log`s** — it is the `jmux --install-skill`
entry point (`skill.ts:161`) and printing is correct there. It stops being the
only way to do the work:

```ts
export function installSkills(): InstallReport[]   // new, silent, both skills
export function installSkill(): boolean            // unchanged CLI wrapper
```

It returns `InstallReport` (`registry.ts:42`) **itself**, not a parallel type —
including the `"migrated"` member the first draft's `SkillReport` dropped. One
outcome union, so the agents page renders both tables with one function and the
two cannot drift.

`installSkillTo()` already returns a structured `SkillOutcome` (`skill.ts:126`),
so this is assembly, not redesign.

### 13.1 The guardrail, two-layered

One layer cannot see this failure:

1. A unit test spying `console.log` / `process.stdout.write` around
   `installSkills()`, asserting **zero calls**.
2. The pty integration test asserting `jmux-control skill:` and `hunk not found`
   appear **nowhere in the rendered frame** after the agents page runs.

The audit found no other TUI-reachable offender: `installAllAgents()` already
returns `InstallReport[]` and `main.ts:6336` already uses them. Everything else
in the sweep is pre-TUI arg parsing and the dependency gate, which run before
the alt screen exists.

## 14. The credential transaction

Three defects, all inherited from the current flow:

- **The rollback destroys a previously valid token.** `main.ts:6371` writes the
  candidate, verifies, then writes `null` on failure — so a bad paste over a
  working Linear setup leaves the user with no credential at all. **Snapshot the
  previous value and restore it exactly**, never `null`.
- **The adapter type is never persisted.** `createAdapters`
  (`adapters/registry.ts:11`) builds nothing without
  `config.adapters.issueTracker.type`, so a token written against an unset type
  connects nothing. Type and token are persisted **together**, and only after
  verification.
- **In-memory probe verification is not available.** `IssueTrackerAdapter` has
  no candidate-credential parameter and `LinearAdapter.authenticate()` reads the
  global resolver, so "verify before write" cannot be done without an interface
  change this design does not need. **Write-verify-restore is what ships**, and
  this spec says so plainly rather than claiming a guarantee it does not
  deliver. The window is one HTTP round trip, and the restore is exact.

## 15. The token must be masked

`InputModal` renders the entered value directly and has no secret mode. Onboarding
would put a Linear API token in cleartext on a terminal that may be shared,
screen-recorded or scrolled back.

**`InputModal` gains a `secret` option**: rendering substitutes `•` per
character, the value itself is unchanged, and `getCursorPosition()` still tracks
the real column. Tested for masking and for cursor position under multi-byte
input.

## 16. What the review changed

Recorded because the first draft argued the opposite in each case.

| First draft | Now | Why |
| --- | --- | --- |
| Fifth full-area surface, justified as structurally necessary | Composite modal | The necessity claim was false: `NewSessionModal` already hosts child collectors in one slot |
| `fullAreaSurfaceOpen()` extraction | Dropped | The membership sets genuinely differ; it was never one concept |
| Provision a real first session | Hand off to `NewSessionModal` | Generic creation launches no agent; failed provisioning leaves debris by design |
| Page 1 writes `projectDirs` | Page 1 adopts Projects | Team attachment operates on `ProjectConfig`, which a scan root cannot supply |
| `config.setup.intent` persisted | Derived per visit | Contradicts "derived, never stored"; config is cast, not validated |
| `e` to the workflow screen | Seed, and point at `Ctrl-a W` | `openWorkflowScreen()` hard-codes settings as the origin; the return path would not exist |
| Four workflow stages incl. Blocked | Three | `SUGGESTED_TABS` has no Blocked stage |
| `SkillReport`, a new union | `InstallReport` reused | The new union silently dropped `"migrated"` |
| Staggered `✓` animation | Rendered immediately | Timers and a test clock for a moment of delight |

## 17. Hazards

- **Temporal dead zone.** `openOnboarding()` occupies the site `openSetup()` has
  today (`main.ts:12035`), inside the async boot block — no new exposure. The
  one that does: the status model backing `setupStepsOutstanding()`
  (`main.ts:1140`) runs per frame from `makeToolbar` and must be declared above
  its first call. `boot-smoke.test.ts` is the net.
- **Glyph width.** `!` beat `⚠` in `workflow-drift` because `⚠`'s width varies
  between terminals and drift against `cellWidth` leaves ghost gaps. **Every
  glyph here must be width-1 under `cellWidth`, asserted by a test enumerating
  them.** `✓ ▸ ━ ─ · •` need that check; anything failing it does not ship.
- **Wide characters generally.** Anything written to a `CellGrid` handles
  width-2 cells with a width-0 continuation.
- **Citations.** Every `file:line` in this document was re-verified against
  `t3code/rebuild-onboarding` at revision `3fb2339`+. The first draft's were
  taken on a branch one commit behind and were uniformly ~55 lines stale.

## 18. Verification

| Layer | Covers |
| --- | --- |
| `flow.test.ts` | Page set per intent; back/next bounds; `→` on an incomplete page; skips recorded; busy-state input lock; duplicate `↵` ignored; **ported `setup-modal.test.ts` coverage** |
| `pages.test.ts` | Status and prose per fabricated snapshot; no-agents and no-tracker unavailable states |
| `render.test.ts` | Column bookkeeping; bottom-pinned action bar; measure cap; **glyph widths** |
| `input-modal.test.ts` | `secret` masking; cursor position under multi-byte input |
| `skill.test.ts` | `installSkills()` writes nothing to stdout |
| `credentials` | Failed verification **restores** the previous token; type and token persist together |
| `modal.test.ts` | `onResize` present → modal survives SIGWINCH; absent → closes as before |
| `onboarding-integration.test.ts` | Boot under a pty with a scratch `HOME`; drive the flow; resize mid-token; **assert no subprocess text on the frame** |
| `bun run docker` | The genuinely clean machine, including the dependency gate |
| Screenshots | Every page from a real client — per `CLAUDE.md`, or it didn't happen |

Escape sequences in the pty harness are written as a **single** write;
byte-by-byte makes a lone `\x1b` read as Escape.

## 18.1 What driving it actually found

Five defects the tests could not see, recorded because each is a rule:

- **A placeholder is not a default.** Hint text where the value goes reads as a
  filled field, and `InputModal` silently consumes Enter on an empty buffer, so
  the flow looked hung. Collectors open on a real value; `requiredHint` makes an
  empty commit say why.
- **A refusal belongs on the page that caused it.** `showToast` reaches only the
  toolbar's status chip — far from a centred modal, and transient — so a
  rejected directory read as nothing having happened.
- **Every step must be answerable.** "Leave sessions unnamed" stored no command,
  which is indistinguishable from never having answered, so the step nagged
  forever with no way to satisfy it.
- **A tick means somebody chose.** `presetForCommand(undefined)` is `off`, so an
  unanswered naming step ticked "unnamed" while the map said `not yet`.
- **Name what you are connecting to.** The tracker step asked for "your token"
  without saying Linear is the only adapter jmux has, so a GitHub Issues user
  had no way to learn their token would not work before pasting it.

## 19. Known limits, stated

- **The team page explains but does not route.** It is the one step that cannot
  be completed inside the flow: it renders its prose and its `↵` is inert.
  Deliberately *not* advertised — its action bar offers only `→ ← esc`, so no
  key silently does nothing — but a user reaching it must attach the team from
  the Projects screen. The routing shape wants confirming against
  `ProjectConfig.teamId` and the tracker's team list before it is wired, and
  inventing a mutation path to close the gap on paper would have been worse
  than naming it. This is the first thing to finish.
- **Existing users never see the flow naturally.** It opens on
  `configStore.ensureExists()` — an absent `config.json`. Deliberate (§2), but
  it means the real audience is reached only through the palette and toolbar dot.
- **Write-verify-restore, not verify-then-write** (§14). Named rather than
  papered over.
- **The map is the only re-entry.** No deep link to a single page from outside.
- **One tracker workspace**, inherited from the credentials file's shape.
