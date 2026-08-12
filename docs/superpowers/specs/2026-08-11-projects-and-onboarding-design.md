# Projects, and the first thirty minutes

Status: approved, not yet implemented
Supersedes: `2026-05-10-projects-sessions-worktrees-ux-design.md` and
`plans/2026-05-10-projects-sessions-worktrees-plan-1-foundation.md`, neither of
which shipped. See §13.

Revised after an adversarial review that found four P0s and a claim that turned
out to be backwards. Where this document now proposes *deleting* something it
originally proposed building, that is why — three of the features the first
draft specified already exist in the codebase.

---

## 1. The failure this comes from

A new user, sitting with the author, tried to configure jmux from nothing:

1. Set the issue tracker to Linear. Nothing appeared. `adapters` is built once
   at import time and the config watcher deliberately never rebuilds it.
2. Restarted, then struggled to build a workflow from what looked like a blank
   screen.
3. Never set up `teamRepoMap`, so starting a session from an issue did nothing
   at all, with nothing naming the missing mapping.

**Failure 2 was caused by failure 1**, which the first draft of this document
missed. `suggestLayout()` already exists (`panel-view.ts:521`), already maps the
tracker's state types onto stages, and the workflow screen already offers it as
a seed row (`workflow-screen.ts:213`) — gated on `statuses.length > 0`. With the
adapter not live, `cachedWorkflowStates` was empty, so the one affordance that
would have done the job was invisible. The workflow screen was not
under-designed; it was starved.

That leaves one shape across all three: **a setting that looks configured, is
not in force, and has nothing on screen willing to say so.** The same defect
`sectionedViewNotice`, `parkingSetupWarning` and the workflow screen's "off
globally" disclosure each exist to prevent, appearing three more times in the
one path every new user must walk.

## 2. Non-goals

- Rewriting the workflow screen. §7 is almost entirely deletion.
- Per-Project workflows. Stages, parking and Up-next stay global — the sidebar's
  stage bands only mean something if every session is ranked on one ladder.
- Multiple tracker workspaces. One adapter, one credential. Stated as a limit in
  §12 rather than designed around.
- Monorepo sub-path Projects. A Project's `dir` is where worktree creation runs,
  so it must be a git root or a wtm container, not a package subdirectory.

---

## 3. The Project

**A Project is one repo and at most one tracker team.** This follows t3code,
whose `projection_projects` table has a singular `workspace_root`, indexed but
**not unique** — two projects may share a root — and whose `projection_threads`
carries `project_id NOT NULL` as an explicit foreign key rather than inferring
membership from a path.

```ts
interface ProjectConfig {
  /** Stable, generated once, never re-derived on rename. Routes and sessions
   *  point here, so a renamed or moved Project keeps its wiring. */
  id: string;
  title: string;
  /** OPERATIONAL: the cwd worktree creation runs in. Several Projects may
   *  share one — a monorepo serving two teams is two Projects, one root. */
  dir: string;
  /** Several Projects may claim one team; §4 disambiguates. */
  teamId?: string;
  baseBranch?: string;
  /** Sparse — only what differs from the global defaults. */
  settings?: Partial<ProjectSettings>;
  /** Soft delete, t3code's pattern: a Project whose repo is gone is marked,
   *  not removed, so it can say so instead of failing at provisioning time. */
  deletedAt?: string;
}
```

### 3.1 Identity is derived, never stored

The first draft stored a single `root`, which conflated two different things
and would have provisioned into `.git`.

`resolveRepoRoot` returns `--git-common-dir` (`repo-settings.ts:141`), which is
`<dir>/.git` for a normal checkout and **the repo path itself** for a bare repo.
`worktreeCommandArgv` runs with `cwd = the repo directory` and creates
`./<session>` beside it. So identity and operational location coincide on a
bare/wtm repo and differ by `/.git` on a normal one — which is exactly why the
bug is invisible to a wtm user and certain for everyone else.

`dir` is therefore the only location stored. **`commonDir` is never persisted**;
it is needed only by the one-time migration (§5.1), which uses the existing
async, `proc.kill()`-bounded `gitOutput` rather than the synchronous
`RepoFactsCache`.

Nothing on the render path shells out, because **session → Project is an
explicit link, not a path inference** (§4.4).

### 3.2 What is detected

Much less than the first draft claimed, because more already exists.

| Field | Reality |
| --- | --- |
| `defaultBaseBranch` | **`resolveBaseBranch` already exists** (`main.ts:3450`): async, bounded, tries configured → `main` → `master`, and *verifies the ref exists*. It gains `origin/HEAD` as a candidate ahead of `main`, and provisioning starts calling it instead of reading the raw config value. It must never fall back to "the checked-out branch" — opening settings from a feature worktree would make that feature the base for every new branch. |
| `wtmIntegration` | **Already detected.** `resolveForRepo` seeds the base with `facts.bare` (`repo-settings.ts:219`). The first draft's claim that it was hardcoded was wrong. |
| `agentCommand` | **Not derivable.** `AgentIntegration` exposes no command field, and `isPresent()` can be true from a config directory existing with no executable on `PATH`. It stays a setting, defaulted per §3.3. |

### 3.3 Three tiers, following t3code

`built-in → global defaults → sparse per-Project override`.

t3code uses this shape three times: `backgroundActivity` is
`{ profile, overrides, schemaVersion }`, `sidebarProjectGrouping` is
`Mode` + `Overrides`, and `projection_projects.default_model_selection_json`
sits under a global `defaultThreadEnvMode`.

**Sparse storage is the whole point.** Only what actually differs is written, so
`inherited` / `override` stays legible forever and the provenance markers the
current per-repo rows already draw keep working. The first draft dropped the
global tier and copied `repoDefaults` onto every Project, which would have
destroyed the distinction permanently — no later migration could reconstruct
which values were inherited and which were chosen. That was a one-way door sold
as reversible.

```ts
interface ProjectSettings {
  sessionNameTemplate: string;
  agentCommand: string;
  autoLaunchAgent: boolean;
  onSessionStartState: string | null;
  onMrOpenState: string | null;
  onMrMergedState: string | null;
}
```

### 3.4 Ids, not names

`ISSUE_FIELDS` (`adapters/linear.ts`) fetches `team { name }` and
`project { name }`; both gain `id`. `startIssueGroup` carries a documented bug
from exactly this — two same-named Linear projects in different teams merge on
the grouping axis. A route keyed on a name would inherit that bug and provision
into the wrong repo, which is worse than grouping oddly.

---

## 4. Resolution: issue → Project

One repo per Project collapses the first draft's two-function ladder into one.
The question is no longer "which repo inside this Project" but "which Project
claims this team", and `resolveIssueRepo` is deleted.

It lives in a new `project-routing.ts`, not `issue-session.ts` — that module
takes an already-resolved `repoDir` and owns issue→session naming and existence
precedence, which is a different concern.

```
resolveIssueProject(issue, projects, evidence):
  candidates = live Projects claiming issue.teamId
  0                                   → { unclaimed, teamName }
  1                                   → that one
  >1 → first of:
         existing session for this issue     (evidence)
         routes.issue[issue.id]              (learned, exact)
         linked MR's repo                    (evidence)
         routes.linearProject[issue.projectId] unless ambiguous (§4.3)
       else                            → { ambiguous, candidates }
```

**Existing sessions win before any routing**, which the current resolver already
requires (`issue-session.ts:334`). A learned route must never relocate work that
already exists.

### 4.1 In the TUI

`ghost-preflight.ts` already resolves session name, branch, worktree path, base
branch, tool and agent before anything is provisioned, and `ghost-preview.ts`
shows it with a modal picker already hosted. Project becomes one more resolved
field, and it **names the evidence, not just the answer** — `api · linked MR`,
`api · only project for Core Engineering`, `api · you chose this for Billing`.

- `unclaimed` is the **ordinary** state for a new user, not an error. The action
  is **Create a project for this team**, pre-filled with the team and a repo
  scan. Starting work is where people discover they need a Project.
- `ambiguous` blocks Start and asks. The answer offers **"just this issue"** or
  **"always for Billing"**, and the second is withheld when §4.3 says it would
  be a lie.

### 4.2 In the CLI

`ctl issue start` cannot ask. On `unclaimed` or `ambiguous` it raises a
`CliError` naming the candidates and the `--repo` flag it gains. `--repo` is
**one-shot and teaches nothing** — the CLI cannot write config while a running
TUI holds it in memory, the same hazard that already forces `@jmux-linear-issue`
to exist beside `state.json`. Its help says so, the same deliberate asymmetry as
"the CLI does not `switch-client`".

### 4.3 Routes

Both maps live in `config.json` on the Project, and **only the TUI writes them**.
They are durable rules, and a rule written by a keystroke you may not remember
making has to be inspectable and deletable — which the Projects screen does.

- `routes.linearProject: Record<linearProjectId, projectId>` — from "always".
- `routes.issue: Record<issueId, projectId>` — from "just this issue". This is
  the first draft's stated limit, removed. An issue-id override cannot
  ambiguously match another issue, so the "two rules can disagree" argument
  never applied to it; without it, every issue with no Linear project is asked
  about forever, and triage, bugs and chores commonly have none.

**Issue routes prune themselves.** A route only has to survive the gap between
answering the question and the session existing — after that `@jmux-project` on
the session is the record. So a route whose issue is completed or canceled is
dropped on the poll that already fetches that state. Bounded, from data already
in hand.

**Ambiguity is detected, not assumed.** If issues in one Linear project have
resolved to two different Projects, "always for Billing" is withheld and the
observed split is shown. A Linear project legitimately spanning an API and a
frontend is common, and one confirmation writing a permanent 1:1 rule would
silently misroute every issue after it — the exact outcome this design exists to
prevent.

### 4.4 Session → Project is an explicit link

`@jmux-project` is written on the session at provision time. Following
t3code's `project_id NOT NULL`, and required here for two independent reasons:
two Projects may share a `dir`, so path containment is genuinely ambiguous; and
`ctl status` needs the answer with no IPC to the TUI, which is what CLAUDE.md's
"the options are the protocol" already establishes.

Path containment against `dir` demotes to a fallback for sessions jmux did not
create. Where it is ambiguous it resolves to **no Project** and says so, rather
than picking: grouping falls back to the repo, settings fall to the global tier.

---

## 5. What this deletes

| Gone | Absorbed by |
| --- | --- |
| `issueWorkflow.teamRepoMap` | `ProjectConfig.dir` + `teamId` |
| `repos[key]` | `ProjectConfig.settings`, now 1:1 with a repo |
| Settings categories `Repo`, `Project`, `This repo · <name>` | one `Projects…` row opening the Projects screen |
| `adapterRestartNote` and its plumbing | §6 |
| `resolveIssueRepo`, `repoRoutes`-within-a-Project | §4, one function |

`repoDefaults` **survives** as the global tier (§3.3). `projectDirs` survives but
demotes: `Ctrl-a n` offers the Projects' repos, and it becomes only the scan
root for *finding* a repo to add. One of the three reported failures disappears
by construction.

### 5.1 Migration

1. Each `teamRepoMap` entry → a Project with that `dir` and team, the team held
   by name in `legacyTeamName` until the first authenticated resolve. The
   schema carries that field explicitly; the first draft described the state
   without giving it anywhere to live.
2. Each `repos[key]` → its Project, matched by resolving `commonDir` for each
   candidate `dir` via `gitOutput`. Keys that match nothing become their own
   teamless Project rather than being dropped.
3. `repoDefaults` stays where it is and becomes the global tier — **not** copied
   into Projects. Overrides are written only where a repo genuinely differed.
4. A timestamped backup is written immediately before the migration.
5. Legacy keys are removed only after the new file is on disk (§11 makes this
   reportable, which it is not today).

---

## 6. Live adapters

A swap is a transaction, not a setter. `PollCoordinator` owns provider-derived
state well beyond the two references: `contexts`, `resolvedLinkSignatures`,
`globalIssues` / `globalMrs` / `globalReviewMrs`, `_rateLimitState`,
`degradedSessions`, `pending` and `inFlight`.

- `PollCoordinator.setAdapters(set)` bumps a **generation**, checked on every
  async completion path — global, active, background, refresh and
  `resolveContext` — not just one.
- Provider-scoped caches are **cleared**, and every session re-enqueued.
  `enqueueBackfill` returns early for in-flight sessions, so a swap during
  `resolveContext` must mark them dirty rather than rely on re-enqueue, or the
  stamped link signature leaves them looking permanently fresh.
- `reportAuthFailure` and rate-limit state become **adapter-identity-scoped**. A
  late 401 or 429 from the retired adapter currently marks the *current* one.
- **`authenticate()` gains a real identity query** — `viewer { id name
  organization { name urlKey } }`. Today it only checks that an env string is
  non-empty (`linear.ts:31`), so a revoked or wrong-workspace token reports `ok`
  and "swap only on success" would have been a guarantee that did not exist.
- The new adapter is staged, verified, then published atomically; a failed
  verification leaves the working adapter in place and the row states why, from
  `authHint`. Today that string goes to stderr, which the alt screen eats.

---

## 7. Workflow: mostly deletion

`suggestLayout()` exists, covers all **seven** `IssueStateType`s including
`duplicate`, appends to existing views rather than replacing them, and is
already offered by the workflow screen as a seed row. The adapter method is
`listWorkflowStates()`.

So this section is not a feature. It is:

- The seed row appears because §6 makes statuses arrive without a relaunch.
- The checklist's **Your workflow** step routes to that same row, rather than
  owning a second copy.
- Seeding stays an **explicit accept**, never an automatic write on token
  presence. Workflow-state fetches can return partial data, and a partial write
  under a non-empty guard would freeze the gap in place forever.

---

## 8. Onboarding

`SetupModal` is already the right shape — derived state, no dismissed flag, each
row working in-process. The changes:

- **`SetupState` gains `blocked`**, and `SetupRow` gains `dependsOn`. A blocked
  row names what must come first. `buildChrome`'s actionable count excludes it,
  or the checklist reports steps as available that cannot be taken.
- **`onActivate` becomes async**, and the modal refreshes on resolve. It is
  `void` today (`setup-modal.ts:46`), so a credential write or an auth
  round-trip could never tick its own row over — the wizard would appear dead at
  its most important step.
- **The list scrolls.** It bounds rows to the terminal today and tells you to
  resize; with more steps that is a real wall on a short terminal.
- **Intent is persisted, because no filesystem inspection can discover it.**
  "Derived, never stored" is right for machine truth — *is hunk installed* — and
  wrong for preference. The first question is "how do you work", the tracker
  choice is `Linear / later / never`, and `never` removes those rows and the
  toolbar dot for good. Picked once, written as concrete values, then
  forgotten — the rule `suggestLayout` already states: *a seeded config and a
  hand-built one are indistinguishable, and there is nothing to un-learn.*
- **A dot on the toolbar's settings button** while any step is `todo` or
  `blocked` — never for a capability declined with `never`.
- **The last step is a dry-run Start**: provision a throwaway session, verify
  repo, base branch, worktree tool, agent launch, hooks and tracker link, then
  tear it down. Green configuration rows prove configuration; this proves
  function. Same reason `--wait` polls for the setup pane exiting rather than
  trusting that a directory exists.

Every step hands off to the surface reachable from the palette later, so it
owns no second copy of any field and cannot drift.

### 8.1 Credentials

Two sources, **file first, env as fallback**:

1. `~/.config/jmux/credentials.json`, mode `0600`, written by the wizard.
2. The environment variable named in `authHint`.

File wins because it is the more deliberate and more recent act — someone who
typed a token into jmux meant it — and because the inverse silently masks the
wizard's own final step with a years-old shell export, which is a wizard that
lies. When both exist and resolve to **different organizations**, the row says
so; a disclosure, not an error.

Not `config.json`: that file is watched, rewritten on every setting change, and
pasted into bug reports. Following t3code, which keeps secrets as discrete files
under `userdata/secrets/` and never inline in settings. Never logged, never in
`jmux.log`, never in a snapshot. The connected state shows the **organization**,
not a boolean, which §6's identity query makes possible.

---

## 9. The settings screen

| Change | Note |
| --- | --- |
| Explain line for the selected row | `SettingDef.describe` **already exists** and is ignored here. Highest value per line in the plan. |
| **`/` to search**, not type-to-filter | Bare typing cannot work: `q` closes and `d` clears an override in navigation mode (`settings-screen.ts:287`). |
| Input parity | `j/k`, mouse click and scroll, `◂ ▸` driving `onStep`. The only chrome surface with no mouse. |
| Validation feedback | `onTextCommit` returns `string \| null`; a non-null result draws on the row. `sidebar width: 200` is silently discarded today. The workflow screen consumes the same callback and must be updated with it. |
| Categories | `Repo` / `Project` / `This repo` collapse into one `Projects…` row. |

Orphaned config — `sessionTitle`, `diffPanel.*`, `agentScreenDetection`,
`browser.*` — is surfaced in **topical categories**, not an "Advanced" bucket.
They differ in kind: prompt capture is a privacy question, browser isolation a
resource one, screen detection a correctness one. Filing them together by how
rarely they are touched is a junk drawer, and search does not repair bad
information architecture.

### 9.1 The Projects screen

Lists Projects with repo, team, route count and **health**: does `dir` exist,
which trunk was detected and from where, which worktree tool and why, an
unresolved `legacyTeamName`, dangling routes, and a dry-run Start. A Project
whose repo has been deleted is marked (`deletedAt`) and says so, rather than
looking complete until provisioning fails.

Rows use `drawSettingRow`, the shared dialect the workflow screen already
paints with.

---

## 10. Naming

Three "project"s, so each gets a fixed name:

| Thing | Name |
| --- | --- |
| repo + team | **Project** |
| Linear's project field | **Linear project** — the panel's group-by axis is relabelled |
| `Session.project`, the wtm bare-repo basename | renamed **`repoName`** |

**`Session.project` is not repurposed.** It feeds session-title generation as
the repository name (`main.ts:3652`), so overloading it would make model prompts
lie about the repo. New `projectId` / `projectName` fields are added beside it,
and **sidebar buckets key on `projectId`, never the label** — two Projects
titled `api` must not merge.

Ghosts gain a Project, which lets unstarted work group under the same Project it
will join after Start. Today they carry none and stay flat off the stage axis.

---

## 11. Config durability

Live today, no versions involved: `persist()` is a bare `writeFileSync`
(`config.ts:551`), and a parse failure is swallowed with `catch {}` into
defaults (`config.ts:374`). So a crash mid-write creates invalid JSON, the next
launch silently discards the user's entire config, and the next setting change
makes it permanent.

1. **Atomic write** — temp file + `rename`, the pattern `assets.ts` already uses.
2. **Never silently fall back to defaults on a parse error.** Keep the file,
   refuse to write, say so on screen. The swallow is what turns a recoverable
   file into a destroyed one.
3. **Unknown-key preservation is a stated invariant with a test.**
   `mergeConfigWithDefaults` is `{ ...defaults, ...userConfig }`, so unknown keys
   already survive — an older jmux carries `projects` through untouched rather
   than destroying it. That property is currently an accident of using a spread;
   the test stops someone later "tidying" it into an explicit field list.
4. **`schemaVersion` is recorded for diagnostics and migration, not for
   gating.** A newer config starts and writes normally, which 1–3 make safe.

## 12. Known limits, stated

- **One tracker workspace.** One adapter, one credential. Contractors with
  several Linear workspaces are not served; the credential file's shape leaves
  room for named profiles later without a migration.
- **A monorepo package is not a Project.** `dir` is where worktree creation
  runs, so it must be a git root or wtm container.
- **`ctl --repo` teaches nothing**, because the CLI cannot write config under a
  running TUI (§4.2).

## 13. Verification

Pure unit tests over logic modules. `main.ts` is unreachable by unit tests;
`boot-smoke` and `binary-boot-smoke` cover that gap.

- `resolveIssueProject` — every ladder rung, `unclaimed`, `ambiguous`, and
  existing-session-wins ahead of every route.
- Route ambiguity detection, and route pruning on issue completion.
- Migration — `teamRepoMap` + `repoDefaults` + `repos[key]` in, Projects out,
  behaviour preserved, `legacyTeamName` held, unmatched keys not dropped.
- Sparse overrides — only divergent fields written; `inherited`/`override`
  correct at three tiers.
- Config durability — atomic write, parse failure does **not** yield defaults,
  unknown keys survive a round trip.
- `PollCoordinator.setAdapters` — results from a retired adapter dropped; a late
  401/429 does not mark the new adapter; in-flight sessions re-resolve.
- Setup rows — `blocked` excluded from the actionable count, navigation refusing
  a blocked row, async activation refreshing.
- Settings — `/` search, and a rejected `onTextCommit` surfacing its message.

`cli/issue.ts` and `cli/workflow.ts` must be shown to call `project-routing.ts`,
not their own copies.

An ADR supersedes `0004-per-repo-settings-keyed-on-repo-root.md`.

## 14. What changed from the 2026-05-10 spec

Written, planned, never implemented; `teamRepoMap` shipped instead. Two
decisions are reversed deliberately.

**Its Project was a Linear project**, keyed on the tracker uuid. This one is a
repo plus a team, defined locally. Linear projects are short-lived — "Q1 Auth
Migration" — so opting in per project means reconfiguring every quarter. The
Linear project keeps a job here as a routing key (§4.3), which is what it is
genuinely good at.

**It resolved multi-repo with `defaultRepoIndex`**, silently picking repo 0.
This spec refuses to guess. A silent default is how work lands in the wrong repo
and is not noticed until a branch exists.

## 15. Staging

**Stage 1 — config durability and the silent failures.** §11 first, because
every later stage rewrites config and none of them should run against a writer
that can destroy it. Then live adapters (§6), which makes the workflow seed row
reachable (§7), and the settings screen's explain line, `/` search, input parity
and validation (§9). Removes two of §1's three failures and makes the third
visible.

Stage 1 is **not** fully independent, and the first draft claimed otherwise: a
genuinely new user still cannot connect a tracker until credentials arrive in
stage 3, because §6 only fixes *applying* a choice, not *supplying* a token.
What stage 1 delivers alone is a working path for anyone whose token is already
in their environment.

**Stage 2 — the Project.** `ProjectConfig`, the three tiers, migration,
`project-routing.ts`, `@jmux-project`, the Projects screen, the settings
collapse, and the `Session.project` rename. The ADR lands here.

**Stage 3 — onboarding.** The sequenced checklist, `blocked`, async activation,
scrolling, credentials, persisted intent, the toolbar dot and the dry-run Start.
Last, because it narrates the other two, and narrating a flow that is still
changing is how wizard-drift gets in through the back door.
