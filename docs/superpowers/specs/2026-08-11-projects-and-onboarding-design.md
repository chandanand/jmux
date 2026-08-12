# Projects, and the first thirty minutes

Status: approved, not yet implemented
Supersedes: `2026-05-10-projects-sessions-worktrees-ux-design.md` and
`plans/2026-05-10-projects-sessions-worktrees-plan-1-foundation.md`, neither of
which shipped. See §12 for what changed and why.

---

## 1. The failure this comes from

A new user, sitting with the author, tried to configure jmux from nothing. In
order:

1. Set the issue tracker to Linear. No statuses appeared in the workflow
   editor. `adapters` is built once at import time and the config watcher
   deliberately never rebuilds it, so the choice did nothing until relaunch —
   and the only thing that said so was a `getNote` reading "restart to apply"
   on the row they had already moved off.
2. Restarted, then struggled to build a workflow. `panelViews` starts empty, so
   every tracker status is unmapped and the screen is a blank construction job
   for someone who does not yet know what a stage is for.
3. Never set up `teamRepoMap`, so starting a session from an issue did nothing
   at all. Nothing named the missing mapping; the feature was simply inert.

Three failures, one shape: **a setting that looks configured and is not in
force, with nothing on screen willing to say so.** That is the same defect
`sectionedViewNotice`, `parkingSetupWarning` and the "off globally" disclosure
on the workflow screen each exist to prevent, appearing three more times in the
one path every new user must walk.

The settings screen is where two of the three were supposed to be visible, and
it could not help: 27 rows across 7 categories, no search, no explanation of
what any row does, and three separate repo-shaped categories (`Repo`,
`Project`, `This repo · <name>`) that a reader has to hold in their head at
once.

## 2. Non-goals

- Rewriting the workflow screen. It is close to right; its problem is that it
  opens onto nothing (§7).
- Per-Project workflows. Stages, parking and Up-next stay global, because the
  sidebar's stage bands only mean something if every session is ranked on one
  ladder.
- Auto-discovering repo membership. A repo belongs to a Project because
  somebody said so, or because the wizard offered it and they accepted.
- Multi-issue routing rules. One rule, stated in §4.

---

## 3. The Project

```ts
interface ProjectConfig {
  /** Stable slug, derived from `name` at creation and unique across Projects
   *  (a collision gets a numeric suffix). Never re-derived on rename — it is
   *  the key `repoRoutes` and any future reference are resolved against. */
  id: string;
  name: string;
  /** At least one. `root` is canonicalized by the existing repo-key helper. */
  repos: Array<{ root: string; baseBranch?: string }>;
  /** The tracker team this Project claims. At most one, claimed exclusively. */
  teamId?: string;
  /** Linear project id → repo root. Written by "always for X" at Start (§4). */
  repoRoutes?: Record<string, string>;
  settings?: ProjectSettings;
}
```

`ProjectSettings` is today's `RepoSettings` minus everything a machine can
answer for itself:

```ts
interface ProjectSettings {
  sessionNameTemplate?: string;
  agentCommand?: string;          // was claudeCommand
  autoLaunchAgent?: boolean;
  onSessionStartState?: string | null;
  onMrOpenState?: string | null;
  onMrMergedState?: string | null;
}
```

### 3.1 Detected, not configured

`REPO_SETTING_DEFAULTS` currently hardcodes answers to questions the machine
already knows. Each of these stops being a setting:

| Was | Becomes |
| --- | --- |
| `defaultBaseBranch: "main"` | `git symbolic-ref --short refs/remotes/origin/HEAD`, falling back to the checked-out branch, falling back to `main`. Cached in the existing `repoFacts`, which already canonicalizes repo roots. |
| `wtmIntegration: true` | `Bun.which("wtm")` is non-null **and** the root is a wtm-managed bare repo. |
| `claudeCommand: "claude"` | Seeded from `AGENT_INTEGRATIONS.filter(a => a.isPresent())` — the same detector `buildSetupRows` already runs for the checklist. |

Detection can be wrong, so `repos[].baseBranch` is a per-repo escape hatch. Its
row is only drawn when detection failed or the user has set it — a row that
merely restates a detected fact is a question the user has to answer for no
reason.

This is the mechanism by which the tier count drops (§3.2). A detected trunk
needs no tier to live in, because it is not config.

### 3.2 Two tiers, not three

Today: built-in base → `repoDefaults` → `repos[key]`. This becomes built-in →
Project. `repoDefaults` is deleted.

**Stated cost:** a user with five Projects who wants Codex everywhere sets it
five times rather than once. The argument for accepting that is §3.1 — with the
agent command seeded from what is actually installed, they set it zero times.
If that turns out to be wrong in practice, re-adding a global tier is cheap;
removing one after people depend on it is not. Recorded here so the reversal is
a decision and not a discovery.

### 3.3 Ids, not names

`ISSUE_FIELDS` in `adapters/linear.ts` fetches `team { name }` and
`project { name }`. Both gain `id`, and `ProjectConfig` claims by id.

This is not tidiness. `startIssueGroup` carries a documented bug from exactly
this — two same-named Linear projects in different teams merge on the grouping
axis, because `Issue.project` is a name. `repoRoutes` keyed on a name would
inherit that bug and route an issue into the wrong repo, which is worse than
grouping it oddly. `Issue.project` / `Issue.team` keep their name fields for
display; the ids are additive.

---

## 4. Resolution: issue → Project → repo

One module, `issue-session.ts`, beside `resolveIssueSession` — for the reason
already recorded there: these rules lived in two places once, disagreed, and
made a session `ctl issue start` created invisible to the sidebar.

```
resolveIssueProject(issue, projects):
  the single Project whose teamId === issue.teamId
  two claimants → { kind: "conflict", projects }   // never last-writer-wins
  none          → { kind: "unclaimed", teamName }

resolveIssueRepo(issue, project):
  project.repos.length === 1        → { root, via: "only" }
  repoRoutes[issue.projectId]       → { root, via: "route" }
  otherwise                         → null      // refuses to guess
```

`via` exists so the surface can name the rule, not just the answer. A resolved
repo the user cannot explain is the same class of thing as a setting that looks
configured and is not.

`resolveIssueProject` returns a *reason* rather than a bare `null` for the same
reason. "Unclaimed" and "conflict" are different problems with different
remedies, and a caller that cannot tell them apart can only say "it didn't
work" — which is the whole complaint in §1.

**`unclaimed` is the ordinary state, not an error.** A user with a tracker
connected and no Projects yet hits it on every issue. So it is the primary
route into creating one: the preview reads *"No project claims team Core
Engineering"* and its action is **Create a project for this team**, which opens
the Projects screen pre-filled with the team and the repo scan. Starting work
on an issue is the most common moment a user discovers they need a Project, so
it is where creating one has to be reachable.

### 4.1 In the TUI

`ghost-preflight.ts` already resolves session name, branch, worktree path, base
branch, tool and agent before anything is provisioned, and `ghost-preview.ts`
shows all of it with a modal picker already hosted on it. Repo becomes one more
resolved field on a surface built for resolved fields.

- Resolved: `api · Linear project "Billing"`, or `api` alone when it is the
  Project's only repo.
- `null`: **Start is blocked.** The preview reads *"No repo resolved — Payments
  has 3 repos and nothing routes ENG-412."* `r` opens the picker.
- Picking offers **"just this issue"** or **"always for Billing"**. The second
  writes `repoRoutes[projectId]`.

That second option is the load-bearing one. **A correction at the point of use
writes the rule, not an exception.** It is how a Project gets configured — by
starting work and being corrected once — rather than by filling in a map before
anything has shown you why it matters. Which is the precise failure mode of
`teamRepoMap`: a mapping you had to know existed, before anything told you.

### 4.2 In the CLI

`ctl issue start` cannot ask a human. On `null` it raises a `CliError` naming
the Project, its repos, and the `--repo` flag it gains. It does not pick.

Both halves call the same two functions. A CLI that computed its own answer
here is a bug waiting to be filed as "the CLI disagrees with my sidebar" — the
rule already written at the top of `cli/workflow.ts`.

### 4.3 A stated limit

An issue with **no Linear project** has no durable routing key. Only "just this
issue" is offered, and the modal says why. Those issues are asked about every
time.

The alternative was a second rule keyed on labels. Two rules that can disagree
about one issue is worse than one rule with a hole in it, and the hole is
visible every time it is hit.

---

## 5. What this deletes

| Gone | Absorbed by |
| --- | --- |
| `issueWorkflow.teamRepoMap` | `ProjectConfig.teamId` + `repos` |
| `repoDefaults` | built-in defaults, made right by detection (§3.1) |
| `repos[key]` | `ProjectConfig.settings` |
| Settings categories `Repo`, `Project`, `This repo · <name>` | one `Projects…` row opening a Projects screen |
| `adapterRestartNote` and its `getNote` plumbing | §6 |

`projectDirs` survives but **demotes**. It stops being load-bearing for
`Ctrl-a n`, which now offers the Projects' repos directly, and becomes only the
scan root used when *finding* a repo to add to a Project. One of the three
reported failures disappears by construction rather than by warning.

### 5.1 Migration

Persisted user data, so this needs a real migration path — the boundary rule in
CLAUDE.md, and the pattern `migrateLegacyConfig` in `repo-settings.ts` already
establishes.

1. Each `teamRepoMap` entry → a Project named for the repo basename, with that
   repo and that team. The team is resolved from name to id on the first
   successful tracker auth; until then it is held as a name and the Project
   reports itself as unresolved rather than silently matching nothing.
2. Each `repos[key]` with no team → a single-repo Project.
3. `repoDefaults` values are copied onto **every** synthesized Project, so no
   behaviour changes on upgrade.
4. Legacy keys are removed after a successful write, not left beside the new
   ones. Two sources for one answer is how they come to disagree.

---

## 6. Live adapters

`PollCoordinator` snapshots `codeHost`/`issueTracker` into `opts` at
construction. `adapters` in `main.ts` is a mutable two-field object that
everything else reads through. So "restart to apply" is a missing setter, not a
constraint.

- `PollCoordinator.setAdapters(set)`, plus a generation counter. In-flight
  results from a replaced adapter are dropped rather than landing in the new
  adapter's contexts — the same discipline as `issueLinkSignature`.
- Changing the tracker builds the new adapter, `authenticate()`s it, and
  **swaps only on success.** A failed auth leaves the working adapter in place.
- On failure the row states the reason inline from `authHint` — *"not connected
  — set `$LINEAR_API_KEY`"*. Today that string goes to stderr, which the alt
  screen eats, so the one message that would have unblocked the user was
  written to a place they could not look.
- `refreshPanelViews()` runs on the swap, which is what makes the tabs appear
  without a relaunch.

---

## 7. Workflow derived, not built

Configuring a workflow was hard because `panelViews` starts empty: every status
unmapped, and a blank screen for someone who does not yet know what a stage is.

Linear reports `state { name type }`, and `getWorkflowStates()` already exists.
`stateType` gives six buckets — triage, backlog, unstarted, started, completed,
canceled.

On the **first successful tracker auth with no `panelViews` configured**, seed
stages from the tracker's own statuses grouped by type. Every status is mapped
on day one, so the settings row reading *"N statuses unmapped"* reads zero from
the start, and the workflow screen becomes an edit of something real.

Parking stays opt-in and empty. It is a claim about how the user works, and
guessing it would put sessions in a band nobody asked for. The wizard offers it
as a step (§8).

Seeding is conditional on `config.panelViews` being **absent or empty** — the
stored value, not the parsed-with-defaults one, so a user who has built their
own tabs never has them replaced by a poll. The seed writes config once; every
later poll sees a non-empty `panelViews` and does nothing.

---

## 8. Onboarding: the checklist, sequenced

`SetupModal` is already the right shape — it opens on first run, derives every
row's state from the machine with no "dismissed" flag, and runs each step
in-process. The structural change is small.

**`SetupState` gains `blocked`**, and `SetupRow` gains `dependsOn: string[]`. A
blocked row names the step that must come first, instead of sitting there
looking like an equal `todo`.

```
✓ Agent status in the sidebar          Claude Code, Codex
✓ Teach agents the jmux CLI
○ Your first project                   <repo> detected
— Connect an issue tracker             needs a token
· Attach a team to <project>           after the tracker
· Your workflow                        after the tracker
— Install the diff viewer              npm i -g hunkdiff
```

Every step hands off to the **same surface** reachable from the palette later.
It owns no second copy of any field, so it cannot drift from what it
configures — the failure mode a standalone wizard has by construction.
Quitting halfway is free, because state is derived: reopening shows exactly
what is still undone. It stays useful forever as the "what is not set up"
screen.

**One addition beyond first run:** while any step is `todo` or `blocked`, the
toolbar's settings button carries a dot. Today the checklist opens once and is
then invisible to anyone who does not know `Ctrl-a p` → Setup exists — which is
every new user, since nothing has told them.

### 8.1 Credentials

Two sources, in order:

1. The environment variable the adapter already names in `authHint`. Existing
   users are untouched.
2. `~/.config/jmux/credentials.json`, mode `0600`, written by the wizard step.

Deliberately **not** `config.json`: that file is watched, rewritten by jmux on
every setting change, and is the file people paste into bug reports. jmux is a
public repo. Same secret, much larger blast radius.

The credentials file is never logged, never written to `jmux.log`, and never
included in a snapshot. It is the reason the wizard can complete in one sitting
— an env var cannot propagate into a running process, so an env-only design
makes this one step, and only this step, require a relaunch. Which is the exact
friction that broke the reported flow.

---

## 9. The settings screen

| Change | Note |
| --- | --- |
| Explain line for the selected row | `SettingDef.describe` **already exists** and is explicitly ignored by this screen. Highest value per line of code in the plan. |
| Type-to-filter | 27 rows / 7 categories → the few that match |
| Input parity | `j/k`, mouse click and scroll, `◂ ▸` driving `onStep`. It is the only chrome surface with no mouse, in an app whose sidebar, toolbar and panel are all mouse-driven. |
| Validation feedback | `onTextCommit` returns `string \| null`; a non-null result is drawn on the row. Today `sidebar width: 200` is silently discarded — the same defect as the three in §1, inside the screen meant to fix them. |
| 7 categories → 5 | Display, Integrations, **Projects…**, Workflow, Diagnostics — `Projects…` opening its own screen, the precedent `Configure workflow…` already sets. |
| New **Advanced**, collapsed | `sessionTitle`, `diffPanel.*`, `agentScreenDetection`, `browser.*` — reachable today only by reading source and hand-editing JSON. |

Advanced adds rows, which cuts against reducing concepts. The trade is
deliberate: config that exists but is undiscoverable is worse than config that
is listed, and search plus explain lines make the extra rows cheap to skip.

### 9.1 The Projects screen

One full-area surface, reached from the `Projects…` row and the palette. Lists
Projects with their repos, team, and route count; a Project with no team says
so on its row rather than looking complete. Add/remove repos, attach/detach a
team, edit `ProjectSettings`, review and delete `repoRoutes`.

A repo's row carries its **detected** trunk, dimmed, with the override
available on it — so the escape hatch of §3.1 has exactly one home, and the
detected value is legible without being a question.

Routes are visible and deletable because §4.1 writes them as a side effect of
starting work. A rule written by a keystroke the user may not remember making
must be inspectable, or the answer to "why did it pick that repo" is nowhere.

Rows use `drawSettingRow` from `settings-screen.ts`, the shared dialect the
workflow screen already paints with, rather than a third copy of the
arithmetic.

---

## 10. Naming

jmux will have three "project"s, so each gets a fixed name:

| Thing | Name | Where |
| --- | --- | --- |
| repo set + team | **Project** | this document |
| Linear's project field | **Linear project** | `Issue.project`; the panel's group-by axis is relabelled |
| `Session.project` (wtm bare-repo basename) | folded into **Project** | the sidebar's group-by-project axis becomes the Project name |

That last row is a behaviour change worth stating: under a multi-repo Project,
sessions from all its repos group together in the sidebar. That is the
intended improvement — a platform team's three services read as one body of
work — but it does mean `Session.project` changes meaning, and any code reading
it as "the repo" must be found and corrected.

---

## 11. Verification

Pure unit tests over logic modules, per the repo rule. `main.ts` is unreachable
by unit tests; `boot-smoke` and `binary-boot-smoke` already cover that gap.

- `resolveIssueRepo` — table-driven, both `null` paths explicitly, `via` on
  every success.
- `resolveIssueProject` — the two-claimant conflict returning `null` with both
  named.
- Migration — legacy `teamRepoMap` + `repoDefaults` + `repos[key]` in, Projects
  out, behaviour preserved; legacy keys removed.
- Base-branch detection — `origin/HEAD` present, absent, and pointing at a
  branch that no longer exists.
- Stage derivation from a `WorkflowState[]`, including the "already has
  panelViews, do not touch" guard.
- Setup row sequencing — `blocked` rows, `dependsOn` naming the blocker, and
  navigation refusing to activate a blocked row.
- Settings screen — filter, and a rejected `onTextCommit` surfacing its message
  rather than silently discarding.
- `PollCoordinator.setAdapters` — a result from a replaced adapter is dropped.

`cli/issue.ts` and `cli/workflow.ts` must be shown to call the same resolvers,
not their own.

An ADR supersedes `0004-per-repo-settings-keyed-on-repo-root.md`, whose keying
decision this replaces.

---

## 12. What changed from the 2026-05-10 spec

That spec and its foundation plan were written and never implemented;
`teamRepoMap` shipped instead. No `linearProjects` appears in any source file.
Two of its decisions are reversed here deliberately.

**Its Project was a Linear project**, opted into from the tracker and keyed on
the tracker uuid. This one is a repo set plus a team, defined locally. The
reason is churn: Linear projects are short-lived — "Q1 Auth Migration" — so
opting in per project means reconfiguring every quarter, and a repo would drift
out of every Project the moment its Linear project closed. Teams are stable.
The Linear project keeps a job here, as the routing key *within* a team (§4),
which is the thing it is genuinely good at.

**It resolved multi-repo with `defaultRepoIndex`** — silently picking repo 0.
This spec refuses to guess (§4). Recorded because it is a direct reversal of a
considered position, not an oversight: a silent default is how work lands in
the wrong repo and is not noticed until a branch exists.

---

## 13. Staging

This is more than one plan's worth of work, and the layers below are each
shippable on their own — the smallest version that works end to end first, then
each capability on top of something already working. The order is chosen so
that **no stage leaves jmux worse than it found it**, and so the two cheapest
fixes reach users before the expensive one.

**Stage 1 — the three silent failures, without Projects.** Live adapters (§6),
workflow seeding (§7), and the settings screen's explain line, filter, input
parity and validation feedback (§9). None of this depends on the Project
primitive, all of it is small, and together it removes two of §1's three
failures outright and makes the third *visible*. If the rest of this spec were
abandoned tomorrow, this stage would still have been worth shipping.

**Stage 2 — the Project, replacing `teamRepoMap` only.** `ProjectConfig`,
detection (§3.1), the migration (§5.1), `resolveIssueProject` /
`resolveIssueRepo` (§4), the Projects screen (§9.1), and the settings-category
collapse. This is where the third failure goes, and where the tier count drops.
Multi-repo Projects are supported by the model from the start — the routing
ladder is not a later addition — but a user with one repo per Project never
meets any of it.

**Stage 3 — onboarding.** The sequenced checklist and `blocked` state (§8),
credentials (§8.1), and the toolbar dot. Deliberately last: it is the stage
that *narrates* the other two, and narrating a flow that is still changing is
how the wizard-drift problem gets in through the back door.

Each stage gets its own plan and its own tests. The ADR (§11) lands with
stage 2, which is what actually supersedes `0004`.
