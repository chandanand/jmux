# First-run onboarding

Status: design of record.

Supersedes §12 ("Phase 3 — onboarding") of
`2026-08-11-projects-and-onboarding-design.md`. That section deferred onboarding
and sketched it as a better checklist; this replaces the checklist entirely.

---

## 1. The failure this comes from

Six diagnosed defects in the current first-run experience
(`src/setup-modal.ts`, rows built in `main.ts:6116`):

1. **Subprocess output corrupts the alt screen.** `installSkill()` writes with
   `console.log` — correct for `jmux --install-skill`, wrong when the setup
   modal calls the same function from inside the TUI. `jmux-control skill:
   installed to …`, `Agents running inside jmux can now discover 'jmux ctl'.`
   and `hunk-review skill: hunk not found — skipped` land directly on the
   rendered frame.
2. **Four of eight steps abandon the user.** `project-dirs`, `attach-team`,
   `workflow` and `tracker`-with-no-adapter all `closeModal()` and drop the
   user into the settings or workflow screen with no explanation and no way
   back.
3. **The progress figure contradicts the list** — `1/5 done` above eight visible
   rows, because the denominator counts only "actionable" rows.
4. **Four unexplained state glyphs** (`✓ ○ · —`) with no legend, two of which
   mean different kinds of "not yet".
5. **Steps state raw facts, not consequences** — `5 failing`, `none
   configured`, `npm i -g hunkdiff`. One row shows a shell command the user is
   apparently expected to run themselves.
6. **No sense of place.** No narrative, no statement of what jmux is, no
   confirmation at the end that anything works.

### 1.1 The mechanical root cause of defect 2

`activeModal` is a **single slot** (`main.ts:6046`). A modal that needs to
collect input must destroy itself to open the collector — which is literally
what the tracker row does today (`main.ts:6303`: it constructs an `InputModal`
and calls `openModal` over the setup modal, evicting it).

This is not a copy problem or a routing bug. **Every step needing user input is
structurally forced to abandon the flow**, and no amount of care inside the
modal vocabulary fixes it. It is the argument for §3.

## 2. Non-goals

- Rewriting the settings or workflow screens. The workflow screen keeps its
  authoring role; onboarding seeds and confirms, it does not re-implement.
- A pre-TUI renderer. The dependency gate gets copy, not chrome (§9.3).
- Mouse support. No full-area surface has it (`2026-08-11` §13); this one does
  not break that tie.
- Interrupting existing users. Anyone with a `config.json` sees no new screen on
  upgrade.

---

# Part I — Shape

## 3. A fifth full-area surface, and why it earns it

`CLAUDE.md` requires a new full-area surface to argue for itself. The argument
is §1.1: onboarding must collect a token, a path and a pick, and a modal cannot
host a modal.

Settings, workflow, ghost-preview and glass are already this vocabulary. A fifth
is **not a fifth idiom — it is a fourth instance of the third idiom.**
`ghost-preview` is the precedent that a full-area surface can host a real
`ListModal` over itself (`main.ts:4734`, and the `closeModal()` comment at
`main.ts:6057`, which exists because of it).

### 3.1 Module boundaries

`main.ts` cannot be imported by tests, so everything testable lives outside it.

| Module | Owns | Knows nothing about |
| --- | --- | --- |
| `src/onboarding/flow.ts` | The state machine: intent → page sequence, cursor, back/next, reachability. **Pure.** | Rendering, tmux, config, adapters |
| `src/onboarding/pages.ts` | The page table: id, title, prose, status. **Pure over a snapshot.** | The port's implementation |
| `src/onboarding/render.ts` | `CellGrid` painting: frame, rail, measure, action bar | Flow semantics |
| `src/onboarding/screen.ts` | `OnboardingScreen`: `open/close/render(cols,rows)/handleInput` | Anything outside `OnboardingPort` |
| `main.ts` | Wiring only: builds the port, adds the surface to the render and route switches | — |

`OnboardingPort` follows `GhostPreviewPort`: the screen never touches
`configStore`, `adapters` or tmux directly. That is what makes `flow.ts` and
`pages.ts` testable against a fabricated snapshot.

### 3.2 The snapshot rule

`setup-modal` re-derives rows on open and after activation, never per frame,
because every detector hits the filesystem and `getGrid` runs at ~60fps (its
comment at `setup-modal.ts:288`). Same rule, tightened.

The screen holds an immutable **`SetupSnapshot`** — agent presence, skill state,
tracker auth, project dirs, workflow tabs, `hunk` on PATH — rebuilt at exactly
three moments: **open, after an action resolves, and on adapter-epoch change.**
`pages.ts` is a pure function of it, so a page's state and its copy cannot
disagree, and no test touches a filesystem.

### 3.3 Integration into main.ts, and the debt cleared

Four sites enumerate the full-area surfaces as a disjunction (`main.ts:3699`,
`3762`, `5400`, `8089`); three more branch to render them (`4692`, `4715`,
`4734`). Adding a fourth term to a four-way `||` repeated seven times is how
these drift.

**Extract the predicate only** — `fullAreaSurfaceOpen()` — and leave the render
and close-all branches alone, since each does genuinely different work. Debt in
the path of the work; the render switch is deliberately not unified.

### 3.4 Deletions

- `src/setup-modal.ts`, with `SetupRow` / `SetupState` / `SetupProviders` and
  the four-glyph vocabulary.
- `buildSetupRows()` (`main.ts:6116`), replaced by the snapshot builder.
- `setupStepsOutstanding()` survives in spirit — the toolbar dot still needs an
  answer — but reads the snapshot rather than rebuilding rows.

`runSetupPreflight()` / `runDeepPreflight()` **survive in substance.** They are
the honest read-only "does it work" check, and the comment at `main.ts:1166`
argues correctly against the throwaway-session alternative. They become the data
behind the finish page rather than a checklist row.

---

# Part II — The model

## 4. Three states, one of them deleted by geometry

`blocked` and `unavailable`-as-glyph both go:

- **`blocked` is deleted outright.** "Something else must happen first" is what
  a *sequence* is. A page needing the tracker comes after the tracker page.
  Nothing is left for the glyph to say.
- **`unavailable` becomes prose on a page you are standing on.** "Install Claude
  Code, Codex or pi and this will light up" is a sentence, not a `—`.

What remains is `satisfied | pending | unavailable`, and none ever appears as a
bare glyph needing a legend: sentences on a page, words in a column on the map.

**The rail carries position only** — a segmented bar plus `Step 2 of 4`. Filled
is behind you, hollow is ahead; both self-evident from where the cursor is. The
rail never duplicates state, which is what stops defect 3 reappearing in a new
costume.

## 5. What earns a page

A step earns a page when **the user must make a decision jmux cannot make for
them.**

| Today's row | Verdict |
| --- | --- |
| Project directories | **Earns one.** Only they know where their code is. |
| Agent hooks + `ctl` skill | **Earns one, jointly.** No decision, but it writes into *another tool's config*, so it needs consent — and it is one idea (jmux and your agents seeing each other), so two rows become one page. |
| Tracker credential | **Earns one**, tracker intent only. |
| Team ↔ project | **Earns one**, tracker intent only. Nothing on disk implies the mapping. |
| Workflow stages | **Earns a pre-answered page.** `suggestLayout()` (`panel-view.ts:521`) already guesses well from the tracker's state types, so the page arrives with the answer filled in and `↵` accepts. A page only ever *confirmed* is cheap; authoring four stages by hand on day one is why people quit. |
| "Check it all works" | **Not a page.** It is the finish (§8). |
| Install the diff viewer | **Not a page.** jmux cannot do it and it is not needed to work. One line on the finish page under "worth knowing" — never a shell command the user is told to go and run mid-flow. |

## 6. The intent branch

```
intent = solo      0 Welcome → 1 Code → 2 Agents → 3 First session → 4 Done
intent = tracker   0 Welcome → 1 Code → 2 Agents → 3 Tracker → 4 Team
                             → 5 Workflow → 6 First issue → 7 Done
intent = manual    0 Welcome → Map. Nothing configured, nothing claimed.
```

`intent` persists as `config.setup.intent`, a closed union — the same tier as
the existing `setup.tracker: "never"`, which is already the file's home for
**declared preference no filesystem check can discover**. Re-entry after a
choice lands on the **map**, not page 0. Intent is changeable from the map, which
re-derives the sequence.

The third option exists so that "none of this" is a first-class answer given in
the flow's own vocabulary, rather than an Escape that reads as failure.

## 7. Navigation

`←` back · `→` next · `↵` acts on the selected thing *within* the page ·
`esc` zooms out.

Two rules keep it from trapping anyone:

1. **`→` never requires completion.** Blocking next on a satisfied page is how a
   wizard becomes a hostage situation, and it is exactly what would make "no
   tracker account today" unrecoverable. You may always leave a page unfinished;
   the map records it and the finish page names it in plain words.
2. **`esc` is one gesture with one meaning: zoom out.** From a page, to the map;
   from the map, close. Not two different escapes — and consistent with what
   `c08da9f` established for the settings and workflow screens.

**An unavailable page is still shown.** It explains why and offers `→`. Silently
dropping it would make `Step 2 of 4` lie and hide a fact the user needs. A page
the intent did not ask for is never created at all — a different thing, needing
no explanation.

---

# Part III — The pages

## 8. Copy

Widths assume a 26-col sidebar and a ~100-col terminal.

### 8.1 Typographic rules

- **Prose measure caps at `space.measure` (64)** even on a 200-col terminal.
  Ghost-preview caps at 100 for issue bodies; explanatory prose wants narrower.
  Long lines are the fastest way to make a terminal read as a log.
- **One vertical rhythm:** title · hairline · blank · prose · blank ·
  interactive block · (flex) · hairline · action bar.
- **The action bar is bottom-pinned via a shared `BOTTOM_RESERVED_ROWS`**, read
  by both `render()` and `ensureVisible()` — the settings screen's rule, for the
  reason stated there: a hint line that moves as the cursor travels costs more
  than the blank row it saves.
- **The accent appears in exactly three places:** page title, cursor row, filled
  rail segment. `tokens.affirmative` for `✓`; `tokens.textTertiary` for keys and
  asides. Nothing else is coloured.

### 8.2 Page 0 — Welcome

```
   jmux                                                        first run

   Run several coding agents at once, and see what they're all doing.

   Every piece of work gets its own tmux session, its own worktree and
   its own agent. The sidebar on your left is the answer to "who needs
   me?".

   What do you want to set up?

   ▸ Just run agents                              3 steps, about a minute
     Somewhere to work, and agent status in the sidebar.

     Agents, wired to my issue tracker                          6 steps
     All of the above, plus start work straight from a ticket.

     I'll do it myself
     Skip all of this. Nothing configured, nothing claimed.

   ──────────────────────────────────────────────────────────────────────
   ↑↓ choose   ↵ start
```

Step counts are stated before the commitment — the cheapest thing a wizard can
do to earn trust.

### 8.3 Page 1 — Where your code lives

```
   Set up jmux                       ━━━●───────────────────  Step 1 of 3

   Where your code lives
   ─────────────────────

   When you press Ctrl-a n, jmux offers you the repositories it finds
   under these directories. Without one, that key has nothing to show
   you.

     ~/Code/personal                                          3 repos
     ~/work                                                  11 repos

   + Add a directory

   ──────────────────────────────────────────────────────────────────────
   ↑↓ move   ↵ add   ⌫ remove   → next   ← back   esc overview
```

### 8.4 Page 2 — Agents

```
   Letting jmux see your agents
   ────────────────────────────

   jmux can show RUNNING, WAITING and COMPLETE beside each session, so
   you can tell at a glance which agent is stuck waiting on you. That
   needs a small hook in each agent's own config. It also installs a
   skill, so agents inside jmux can drive sibling sessions themselves.

     Claude Code                            found, not hooked up yet
     Codex                                  found, hooks out of date
     pi                                              not installed

   Writes to ~/.claude/settings.json and ~/.codex/hooks.json.
   Undo any time with  jmux --uninstall-integrations

   ──────────────────────────────────────────────────────────────────────
   ↵ set these up   → skip   ← back   esc overview
```

Consent to write into another tool's config is only real if the reversal is
named at the moment of asking — hence the `--uninstall-integrations` line.

**After `↵`** — every line here is text that lands raw on the frame today:

```
     Claude Code                                    ✓ hooked up
     Codex                                          ✓ hooked up
     jmux ctl skill                                  ✓ installed
     hunk review skill                    hunk not installed, skipped
```

**No agents on this machine** — honest, explicitly not a failure:

```
     No coding agents found on this machine.

   jmux works fine without one: you drive tmux yourself and the sidebar
   shows sessions rather than agent status. Install Claude Code, Codex
   or pi and this page will have something to do.

   ──────────────────────────────────────────────────────────────────────
   → next   ← back   esc overview
```

### 8.5 Pages 3–5 — the tracker arm

```
   Connect your issue tracker
   ──────────────────────────

   With a tracker connected your issues appear in the info panel, and
   you can start a session from one — branch, worktree and agent, all
   named after the ticket.

     Tracker                                              Linear
     Token                                        checking… ⠋

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

     Core Engineering        →   ~/Code/personal/jmux
     Design                  →   not routed
```

```
   How your work moves
   ───────────────────

   Your tracker has 12 statuses. jmux has grouped them into four stages,
   which drive the sidebar's bands and the info panel's tabs.

     To do            Backlog, Todo, Triage
     In progress      In Progress, In Review
     Blocked          Blocked
     Done             Done, Cancelled, Released

   ──────────────────────────────────────────────────────────────────────
   ↵ use these   e edit   → skip   ← back   esc overview
```

### 8.6 The last working page — a real session, not a rehearsal

```
   Start your first session
   ────────────────────────

   This is the thing jmux is for. Pick a repository and jmux will make a
   session for it with an agent already running inside.

     ~/Code/personal/jmux
     ~/Code/personal/hunk
     ~/work/tracktile

   Nothing throwaway here — it's a real session, and it's yours to keep.
```

The prior spec proposed a dry-run Start that provisions and tears down a
throwaway session; `main.ts:1166` rejects that correctly, because on a wtm repo
it means creating and deleting a real worktree and branch to answer a question,
and it leaves debris exactly when it fails. Provisioning the user's **actual
first session** sidesteps the objection entirely: nothing is disposable, so
there is nothing to clean up.

### 8.7 Page N — Done

```
   You're set up
   ─────────────

   ✓  Two project directories
   ✓  Claude Code and Codex report their state
   ✓  Linear connected as jarred@tracktile.com
   ✓  jmux/TRA-412 is running — look left

   Three things worth knowing

      Ctrl-a n      start a new piece of work
      Ctrl-a p      the command palette — everything is in here
      Ctrl-a ?      every key jmux binds

   Not set up, and that's fine

      The diff viewer      npm i -g hunkdiff, then Ctrl-a g

   ──────────────────────────────────────────────────────────────────────
   ↵ take me to my session
```

**The one piece of motion.** The `✓` lines land one at a time, ~70ms apart, on
first arrival at this page only; any keypress lands them all instantly. One
deadline and a `scheduleRender()` — no animation framework, no per-frame work
once settled. It is the only moment in the flow where something is celebrated
rather than asked, and staggering is the cheapest way a terminal can say so.

### 8.8 The map

```
   Set up jmux                                                  overview

   Just run agents                                                change

   ✓   Where your code lives                            2 directories
   ✓   Letting jmux see your agents             Claude Code, Codex
       Start your first session                              not yet

   Not in this path

       Issue tracker  ·  Team routing  ·  Workflow stages

   ──────────────────────────────────────────────────────────────────────
   ↑↓ move   ↵ open   esc close
```

**One glyph, one meaning.** `✓` means done; its absence means not done, with the
right-hand column saying what that amounts to in words. Nothing here needs a
legend — defect 4 deleted rather than documented.

---

# Part IV — Engineering

## 9. Installers

### 9.1 The fix

`installSkill()` **keeps its `console.log`s** — it is the `jmux --install-skill`
entry point and printing is correct there. It stops being the only way to do the
work:

```ts
// skill.ts — mirrors installAllAgents()'s InstallReport shape exactly
export interface SkillReport {
  label: string;
  kind: "installed" | "noop" | "skipped" | "failed";
  notes: string[];
}
export function installSkills(): SkillReport[]   // new, silent, both skills
export function installSkill(): boolean          // unchanged CLI wrapper over it
```

`installSkillTo()` already returns a structured `SkillOutcome`
(`skill.ts:126`), so this is assembly, not redesign. The `kind` vocabulary is
copied from `InstallReport` (`registry.ts:42`) rather than invented, so the
agents page renders both tables with one function.

### 9.2 The guardrail, two-layered

One layer cannot see this failure, so there are two:

1. A unit test spying `console.log` / `process.stdout.write` around
   `installSkills()`, asserting **zero calls**.
2. The pty integration test asserting the literal strings `jmux-control skill:`
   and `hunk not found` appear **nowhere in the rendered frame** after the
   agents page runs.

The audit found no other TUI-reachable offender: `installAllAgents()` already
returns `InstallReport[]` and `main.ts:6281` already uses them. Everything else
in the `console.log` sweep is pre-TUI arg parsing and the dependency gate, which
run before the alt screen exists.

### 9.3 The pre-TUI dependency gate

Copy only, no new renderer. It must stay plain `console.log`: on a clean machine
it may need to install tmux before jmux can run at all, and there is no alt
screen yet. The rewrite makes it read as step zero of one flow rather than as an
error.

## 10. Delegation: exactly one, opt-in

**One** step leaves the surface: `e` on the workflow page, into the workflow
screen. It earns the exception — that screen is a real authoring surface, and
rebuilding stage editing inside onboarding would be a second copy of it.

Three things make it not an abandonment:

- It is **`e`, not `→`**. The default path (`↵ use these`) never leaves.
- The page **says where you are going and that you will come back**, before you
  go.
- The return uses `surfaceReturn` (`main.ts:7618`), the mechanism `c08da9f`
  added for exactly this. No new machinery.

Everything else runs in place by hosting a modal over the surface — the
capability §3 exists to buy. `InputModal` for a directory path and the tracker
token; `ListModal` for team→project routing. The render path is
ghost-preview's: `computeModalOverlay(fullScreenLayout)` composited, never
`null`, or the picker opens invisibly.

## 11. Nothing persisted invalid

- **Project dirs** are added only after `existsSync` confirms the path.
- **`config.setup.intent`** is a closed union, validated on read like every
  other config field.
- **The tracker token.** Today's flow writes the credential, calls
  `swapAdapters()`, and rolls back on failure (`main.ts:6318`) — leaving a
  window in which an unverified token is on disk. Verify against an in-memory
  probe adapter and write only on success **if the adapter interface permits
  constructing one unregistered**. If it does not, keep write-verify-rollback
  and say so, rather than claim a guarantee that was not delivered. Settled
  against the code during planning.

## 12. Hazards

- **Temporal dead zone.** `openOnboarding()` occupies the exact call site
  `openSetup()` has today (`main.ts:11981`) — inside the async boot block, not
  module scope — so it adds no new exposure. The one that does: the toolbar
  dot's `setupStepsOutstanding()` runs per frame from `makeToolbar`, and its
  snapshot-backed replacement must be declared above its first call.
  `boot-smoke.test.ts` is the net.
- **Glyph width.** The `workflow-drift` lesson is on record: `!` beat `⚠`
  because `⚠`'s width varies between terminals, and drift against `cellWidth`
  leaves ghost gaps. **Every glyph in the onboarder must be width-1 under
  `cellWidth`, asserted by a test enumerating them.** `✓ ▸ ━ ─ ·` and the
  braille spinner have in-tree precedent; anything without precedent does not
  ship.
- **Wide characters generally.** Anything written to a `CellGrid` handles
  width-2 cells with a width-0 continuation, per `CLAUDE.md`.

## 13. Verification

| Layer | Covers |
| --- | --- |
| `flow.test.ts` | Sequence per intent; back/next bounds; `→` on an incomplete page; skips recorded; changing intent re-derives |
| `pages.test.ts` | Status and prose per fabricated snapshot; the no-agents and no-tracker unavailable states |
| `render.test.ts` | Column bookkeeping; bottom-pinned action bar; measure cap; **glyph widths** |
| `skill.test.ts` | `installSkills()` writes nothing to stdout |
| `onboarding-integration.test.ts` | Boot under a pty with a scratch `HOME`; drive the flow; **assert no subprocess text on the frame** |
| `bun run docker` | The genuinely clean machine, including the dependency gate |
| Screenshots | Every page from a real client — per `CLAUDE.md`, or it didn't happen |

Escape sequences in the pty harness are written as a **single** write;
byte-by-byte makes a lone `\x1b` read as Escape.

## 14. Known limits, stated

- **Existing users never see the wizard naturally.** It opens on
  `configStore.ensureExists()`, i.e. an absent `config.json`. That is deliberate
  (§2), but it means the flow's first real audience is reached only through the
  palette and the toolbar dot.
- **The map is the only re-entry.** There is no deep link to a single page from
  outside the surface.
- **One tracker workspace**, inherited from the credentials file's shape
  (`2026-08-11` §13).
