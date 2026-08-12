# Projects, and the first thirty minutes

Status: design of record. Phase 1 specified to implementation depth; phases 2
and 3 carry the model and their open questions, and get their own specs when
reached.

Supersedes: `2026-05-10-projects-sessions-worktrees-ux-design.md` and its
foundation plan, neither of which shipped. See §14.

Revised twice after adversarial review. Where this proposes *deleting* something
an earlier draft proposed building, that is because the feature already exists —
that happened three times.

---

## 1. The failure this comes from

A new user configuring jmux from nothing:

1. Set the tracker to Linear. Nothing appeared. `adapters` is built once at
   import time and the config watcher never rebuilds it.
2. Restarted, then struggled to build a workflow from an apparently blank screen.
3. Never set up `teamRepoMap`, so starting a session from an issue did nothing,
   with nothing naming the missing mapping.

**Failure 2 was caused by failure 1.** `suggestLayout()` already exists
(`panel-view.ts:521`), already maps the tracker's state types onto stages, and
the workflow screen already offers it as a seed row (`workflow-screen.ts:213`) —
gated on `statuses.length > 0`. With the adapter dead, `cachedWorkflowStates` was
empty and the one affordance that would have done the job was invisible. The
screen was starved, not under-designed.

One shape across all three: **a setting that looks configured, is not in force,
and has nothing on screen willing to say so** — the defect
`sectionedViewNotice`, `parkingSetupWarning` and the workflow screen's "off
globally" disclosure each exist to prevent, recurring in the one path every new
user must walk.

## 2. Non-goals

- Rewriting the workflow screen. §7 is almost entirely deletion.
- Per-Project workflows. Stages, parking and Up-next stay global.
- Multiple tracker workspaces (§13).
- Monorepo sub-path Projects: `dir` is where worktree creation runs, so it must
  be a git root or wtm container.

---

# Part I — The model

## 3. The Project

**One repo, at most one team.** Following t3code's `projection_projects`:
singular `workspace_root`, indexed but **not unique** so two projects may share
a root, and `projection_threads.project_id NOT NULL` as an explicit foreign key
rather than membership inferred from a path.

```ts
interface ProjectConfig {
  id: string;            // stable, generated once, never re-derived on rename
  title: string;
  dir: string;           // OPERATIONAL cwd for worktree creation; may be shared
  teamId?: string;       // several Projects may claim one team; §4 disambiguates
  /** Held by the migration until the first authenticated resolve (§5.1). */
  legacyTeamName?: string;
  settings?: ProjectSettings;   // sparse by KEY PRESENCE (§3.3)
  deletedAt?: string;           // soft delete, t3code's pattern
}
```

Routes are **not** on the Project — see §4.3.

### 3.1 Identity is derived, never stored

`resolveRepoRoot` returns `--git-common-dir` (`repo-settings.ts:141`): `<dir>/.git`
for a normal checkout, **the repo path itself** for a bare repo.
`worktreeCommandArgv` runs with `cwd = the repo directory` and creates
`./<session>` beside it. Identity and operational location therefore coincide on
a wtm/bare repo and differ by `/.git` everywhere else — which is why storing one
`root` was invisible to a wtm user and catastrophic for everyone else.

`dir` is the only location stored. `commonDir` is computed only by the migration
(§5.1), using the existing async, `proc.kill()`-bounded `gitOutput`. Nothing on
the render path shells out, because session → Project is an explicit link (§4.4).

### 3.2 What is detected

| Field | Reality |
| --- | --- |
| `defaultBaseBranch` | **`resolveBaseBranch` exists** (`main.ts:3450`): async, bounded, configured → `main` → `master`, verifying the ref exists. It gains `origin/HEAD` ahead of `main`, and provisioning calls it instead of reading raw config. It must **never** fall back to the checked-out branch — that would make a feature worktree the base for every new branch. |
| `wtmIntegration` | **Already detected**: `resolveForRepo` seeds the base with `facts.bare` (`repo-settings.ts:219`). Detection supplies the *base*, and the field stays overridable. |
| `agentCommand` | **Not derivable.** `AgentIntegration` has no command field and `isPresent()` can be true from a config directory with no executable on `PATH`. |

### 3.3 Three tiers, sparse by key presence

`built-in → global defaults → per-Project override`. t3code uses this shape
three times (`backgroundActivity`, `sidebarProjectGrouping`,
`projection_projects.default_model_selection_json` under a global
`defaultThreadEnvMode`).

**Sparse means "only explicitly set keys", never "only values that differ".**
Provenance is key *presence* — which is how `config.ts:466` already works.
Pinning `agentCommand = "codex"` while the global also happens to be `"codex"`
is a deliberate override; storing only differences would erase that intent and
let a later global change silently move the Project. Setting a value creates the
key; Clear removes it.

`ProjectSettings` is **exactly today's `RepoSettings`** with one rename, so the
migration is lossless:

```ts
interface ProjectSettings {
  defaultBaseBranch?: string;
  wtmIntegration?: boolean;
  autoLaunchAgent?: boolean;
  sessionNameTemplate?: string;
  agentCommand?: string;        // was claudeCommand
  onSessionStartState?: string | null;
  onMrOpenState?: string | null;
  onMrMergedState?: string | null;
}
```

### 3.4 Ids, not names

`ISSUE_FIELDS` gains `id` on `team` and `project`. `startIssueGroup` carries a
documented bug from name-keying — two same-named Linear projects in different
teams merge. A route keyed on a name inherits that bug and provisions into the
wrong repo.

## 4. Resolution: issue → Project

One repo per Project collapses the earlier two-function ladder into one.
`resolveIssueRepo` is deleted. This lives in a new `project-routing.ts`, not
`issue-session.ts` — that module takes an already-resolved `repoDir` and owns
issue→session naming and existence precedence, a different concern.

```
resolveIssueProject(issue, projects, routes, evidence):

  # Existing work is evaluated FIRST, before candidate cardinality.
  session = session already linked to this issue
  if session:
      stamped = @jmux-project on it
      stamped resolves, live       → { resolved, project, via: "existing session" }
      missing / deleted / drifted  → { orphaned, session, stamped }

  candidates = live Projects claiming issue.teamId
  0  → { unclaimed, teamName }
  1  → { resolved, via: "sole claimant" }   # unless evidence disagrees → conflict
  >1 → first of:
         routes.issue[issue.id]
         linked MR's repo
         routes.linearProject[issue.projectId]   unless ambiguous (§4.3)
       agreeing sources → resolved, naming the evidence
       disagreeing      → { conflict, evidence[] }
       none             → { ambiguous, candidates }
```

Five outcomes, not two: `resolved`, `unclaimed`, `ambiguous`, `conflict`,
`orphaned`. **Disagreement is a distinct result from absence** — a stored route
contradicting a linked MR is a different problem from having no information, and
collapsing them produces a confident wrong answer.

`orphaned` never remaps existing work to a new Project. It reports, and offers
re-stamping as a deliberate act.

### 4.1 In the TUI

`ghost-preflight.ts` already resolves session name, branch, worktree path, base,
tool and agent before provisioning; `ghost-preview.ts` shows it with a modal
picker already hosted. Project becomes one more resolved field and **names its
evidence**: `api · linked MR`, `api · sole project for Core Engineering`,
`api · you chose this for Billing`.

- `unclaimed` is the **ordinary** state for a new user. Its action is **Create a
  project for this team**, pre-filled. Starting work is where people discover
  they need a Project.
- `ambiguous` and `conflict` block Start and ask, `conflict` listing what
  disagrees. The answer offers "just this issue" or "always for Billing", the
  second withheld when §4.3 says it would be a lie.

### 4.2 In the CLI

`ctl issue start` cannot ask. Every non-`resolved` outcome raises a `CliError`
naming the candidates and the evidence. It gains **`--project`**, not `--repo`:
a path cannot identify a Project when two share a `dir`, and the option to stamp
must be determined. `--project` is **one-shot and teaches nothing** — the CLI
cannot write config under a running TUI, the hazard that already forces
`@jmux-linear-issue` to exist beside `state.json`.

### 4.3 Routes

**One top-level table, not per-Project.** Maps on each Project would leave "which
Project's map is searched" undefined and let two maps disagree.

```ts
routes?: {
  issue?: Record<issueId, projectId>;          // "just this issue"
  linearProject?: Record<linearProjectId, projectId>;  // "always for Billing"
}
```

In `config.json`, TUI-writes-only, shown and deletable on the Projects screen — a
rule written by a keystroke you may not remember making has to be inspectable.

Issue routes exist because the alternative is asking forever: triage, bugs and
chores commonly have no Linear project. An issue-id override cannot ambiguously
match another issue, so the "two rules can disagree" objection never applied.

**Pruning is post-stamp, not completion-based.** `getMyIssues` filters
`state.type nin ["completed","canceled"]` (`linear.ts:126`), so the poll *never
observes* a completed issue and a completion trigger would never fire.

1. Drop an issue route as soon as session creation **and** `@jmux-project`
   stamping both succeed — after that the session is the record.
2. Routes whose session was never created are polled by explicit issue id.
3. Prune only on observed terminal state or authoritative not-found. Retain on
   auth failure, outage, unassignment or team movement — **absence is not
   completion**.

**Ambiguity detection is advisory, and says so.** If issues in one Linear project
have resolved to two Projects, "always" is withheld and the split shown. The
evidence is unstable — the issue universe is assigned, non-terminal issues only,
so the split can appear and vanish between polls. It may therefore suppress the
offer, never silently rewrite a route.

### 4.4 Session → Project is an explicit link

`@jmux-project` is stamped at provision time, following t3code's
`project_id NOT NULL`. Required for two independent reasons: two Projects may
share a `dir`, so path containment is ambiguous; and `ctl status` needs the
answer with no IPC to the TUI.

**It must also be durable.** tmux options die with the server, and jmux has
durable sessions. `SnapshotSession` already carries `links` and `projectGroup`
(`snapshot/schema.ts:48`), so `projectId` joins it as an **optional, defaulted**
field — the pattern `agentState` and `otel.contextTokens` used without bumping
`formatVersion` — and restore re-stamps the option **before** Project-aware
settings or polling run. An old snapshot without it yields `orphaned`, which is
honest, rather than a silent path remap.

Path containment against `dir` is only a fallback for sessions jmux did not
create. Where ambiguous it resolves to **no Project** and says so: grouping falls
back to the repo, settings to the global tier.

## 5. What this deletes

| Gone | Absorbed by |
| --- | --- |
| `issueWorkflow.teamRepoMap` | `ProjectConfig.dir` + `teamId` |
| `repos[key]` | `ProjectConfig.settings`, now 1:1 with a repo |
| Settings categories `Repo`, `Project`, `This repo · <name>` | one `Projects…` row |
| `adapterRestartNote` | §6 |
| `resolveIssueRepo` | §4 |

`repoDefaults` **survives** as the global tier. `projectDirs` demotes to the scan
root for finding a repo to add.

### 5.1 Migration (phase 2)

Runs in an **explicit async bootstrap phase** — `ConfigStore` construction and
`migrateLegacyConfig` are synchronous today (`config.ts:390`) and this needs
`gitOutput`. It computes the complete new document before touching disk, writes a
durable backup first, and is idempotent.

1. Each `teamRepoMap` entry → a Project with that `dir`, team held in
   `legacyTeamName` until the first authenticated resolve.
2. Each `repos[key]` → matched by resolving `commonDir` for each candidate `dir`.
   **Where several Projects share a `dir`, the override applies to all of them** —
   it was a property of the repo. Keys matching nothing become their own teamless
   Project rather than being dropped.
3. Every present legacy key is copied, **including values equal to the global**
   (§3.3). `claudeCommand` → `agentCommand`.
4. `repoDefaults` stays as the global tier, not copied into Projects.
5. Legacy keys removed only after the new file is durably on disk.

**Downgrade is explicitly not supported, and that is a decision.** Unknown-key
preservation (§11.3) means an older jmux carries `projects` through intact, so
nothing is destroyed and upgrading restores everything — but it will not
*understand* them, so routing and per-repo overrides are inert until you upgrade
again. Version gating was considered and rejected: a multiplexer that refuses to
attach is holding running work hostage.

---

# Part II — Phase 1 (implementation depth)

Phase 1 is config durability, live adapters, and the settings screen. It removes
two of §1's three failures and makes the third visible. It is **not** fully
independent: it fixes *applying* a tracker choice, not *supplying* a token, so a
genuinely new user still waits for phase 3 unless their token is in the
environment.

## 6. The adapter epoch

A swap is an **app-wide transaction**, not a coordinator setter. `adapters` is a
module-scope const (`main.ts:1545`); `cachedWorkflowStates` and team caches live
in `main.ts` and assign after `await` (`main.ts:1634`); status writes, issue
creation and modal continuations capture adapters independently
(`main.ts:2012`, `4435`, `6512`, `8335`). A coordinator-only generation leaves
every one of those able to write old-workspace data into new-workspace state.

- **One mutable active adapter set plus an `epoch`**, shared by the coordinator,
  the caches in `main.ts`, modal callbacks and writes. Every async consumer
  captures the epoch at invocation and re-checks it immediately after each
  `await`, **before** any success mutation, catch-side auth/rate mutation, or
  `onUpdate`.
- **`drainBackfill` needs more than an epoch**: an old `finally` can delete a new
  epoch's `inFlight` marker. Track `(epoch, promise)` per session.
- **`resolveContext` stamps the link signature before its await**, so a swap must
  clear signatures and mark in-flight sessions dirty, or they look permanently
  fresh and never re-resolve.
- **After `getGitBranch` in the active poll, reacquire the context** — the
  captured object may have been detached by a swap.
- **`reportAuthFailure` and rate-limit state become adapter-identity-scoped.** A
  late 401 or 429 from the retired adapter currently marks the *current* one.
- On commit: invalidate provider-bound modals and pending actions, clear every
  provider cache synchronously, publish one coherent "reloading" frame.
- **Optimistic status writes are coordinator-only** and their late rollbacks are
  the dangerous case (issue/MR links are recoverable because `SessionState` is
  written first). A retired epoch's rollback is dropped.

**Every adapter gets a real identity probe**, not just Linear. `authenticate()`
today checks token presence in all three (`linear.ts:31`, `github.ts:105`,
`gitlab.ts:36`), so a revoked or wrong-account credential publishes as healthy.
Linear uses `viewer { id name organization { name urlKey } }`. **Invalid
credentials must be distinguished from transient network failure** — a blip at
startup must not permanently latch `failed`, which `github.ts:107` already warns
about.

## 7. Workflow: deletion

`suggestLayout()` exists, covers all **seven** `IssueStateType`s including
`duplicate`, and appends rather than replaces. The adapter method is
`listWorkflowStates()`.

- The seed row appears because §6 makes statuses arrive without a relaunch.
- Seeding stays an **explicit accept**, never an automatic write on token
  presence: workflow-state fetches can return partial data, and a partial write
  under a non-empty guard freezes the gap forever.

## 8. The settings screen

| Change | Note |
| --- | --- |
| Explain line | `SettingDef.describe` **exists** and is ignored here. Highest value per line in the plan. |
| **`/` to search** | Bare typing cannot work: `q` closes and `d` clears an override in navigation mode (`settings-screen.ts:287`). |
| Input parity | `j/k`, mouse click and scroll, `◂ ▸` driving `onStep`. The only chrome surface with no mouse. |
| Validation feedback | `onTextCommit` returns `string \| null`. `sidebar width: 200` is silently discarded today. The workflow screen consumes the same callback and must be updated with it. |

Orphaned config — `sessionTitle`, `diffPanel.*`, `agentScreenDetection`,
`browser.*` — goes into **topical categories, not an "Advanced" bucket**. Prompt
capture is a privacy question, browser isolation a resource one, screen detection
a correctness one; filing them together by how rarely they are touched is a junk
drawer, and search does not repair bad information architecture.

## 9. Credentials

**One resolver, used by every construction path.** CLI commands construct
`LinearAdapter({})` directly (`cli/issue.ts:697`, `cli/workflow.ts:494`) and
adapters read `process.env` internally, so a token stored only in the file would
work in the TUI and fail in `ctl`. That is the whole implementation risk here.

Order: `~/.config/jmux/credentials.json` (mode `0600`), then the environment
variable named in `authHint`. File first because it is the more deliberate and
more recent act, and because the inverse silently masks the wizard's own final
step with a years-old shell export.

Not `config.json` — watched, rewritten on every setting change, pasted into bug
reports. Following t3code, which keeps secrets as discrete files under
`userdata/secrets/`. Never logged, never in `jmux.log`, never in a snapshot.

**Cross-organization is a rebinding, not a disclosure.** Team ids, route keys and
durable issue links are workspace-scoped, so pointing jmux at a different
organization invalidates all of them. Switching organizations requires explicit
confirmation naming what will be re-bound. When both sources exist and resolve to
different organizations, the row says so; when the shadowed env credential is
invalid or unreachable, the file's identity stands and the row notes the shadowed
source could not be verified.

## 10. Config durability

Live today, unrelated to any of this: `persist()` is a bare `writeFileSync`
(`config.ts:551`) and a parse failure is swallowed into defaults
(`config.ts:374`). A crash mid-write creates invalid JSON, the next launch
silently discards the entire config, and the next setting change makes it
permanent.

1. **Atomic write** reusing `snapshot/fs.ts:24`'s pattern — unique temp file,
   file fsync, rename, parent-directory fsync — not merely temp+rename.
2. **The watcher must survive rename.** `watch(configStore.configPath, …)`
   (`main.ts:8834`) watches the inode; an atomic replace kills it. Watch the
   parent directory filtered by basename, or re-arm after each rename. Without
   this, phase 1 silently breaks the hot-reload sidebar-width depends on.
3. **Unknown-key preservation is an invariant with a test.**
   `mergeConfigWithDefaults` is `{ ...defaults, ...userConfig }` (`config.ts:352`),
   so unknown keys already survive. The test stops that being "tidied" into an
   explicit field list.
4. **Two error policies.** `ConfigStore` is constructed before alt-screen entry,
   restore and `TmuxPty` (`main.ts:452`), so a startup parse error can print
   path, error and recovery to stderr and **exit nonzero** without disturbing
   tmux. A hot-reload parse error keeps the last-known-good memory state, latches
   writes off, and shows a persistent in-app error until a valid reload.
5. **`schemaVersion` is recorded for diagnostics and migration, not gating.**

---

# Part III — Later phases

## 11. Phase 2 — the Project

`ProjectConfig`, the three tiers, the migration (§5.1), `project-routing.ts`,
`@jmux-project` with snapshot durability, the Projects screen, the settings
collapse, the `Session.project` rename. An ADR supersedes
`0004-per-repo-settings-keyed-on-repo-root.md`.

**Open questions its own spec must answer**, each of which an implementer would
otherwise have to invent:

- `Ctrl-a n` selects a **Project**, not a deduplicated repo path — two Projects
  sharing a `dir` are otherwise indistinguishable.
- Group start requires one resolved **Project**, not one directory
  (`main.ts:7152` merges by path today).
- Attaching an issue to an existing session: does it write an exact route, permit
  a cross-team link, or report drift? (`main.ts:7261` just moves the link.)
- `ctl status` and `ctl workflow board` need Project in their tmux format and
  typed output, plus explicit missing/deleted states.
- Pinned and Parked bands are extracted **before** Project grouping
  (`sidebar.ts:538`), so whether their rows show Project identity is a decision.
- Ghosts carry issue identity and an optional stage only (`ghosts.ts:109`). They
  need `resolved` / `unclaimed` / `ambiguous` / `orphaned` and Project-axis
  bucketing while keeping stage-axis behaviour.
- Snapshot restore's agent-command callback receives only a cwd
  (`restore.ts:14`), so it cannot resolve Project-scoped settings as written.

**`Session.project` is not repurposed.** It feeds session-title generation as the
repository name (`main.ts:3652`); overloading it would make model prompts lie. It
is renamed `repoName`, and `projectId` / `projectName` are added beside it.
Sidebar buckets key on `projectId`, never the label — two Projects titled `api`
must not merge.

## 12. Phase 3 — onboarding

The sequenced checklist (`SetupState` gains `blocked`, `SetupRow` gains
`dependsOn`, `buildChrome`'s actionable count excludes blocked), async
`onActivate` with refresh-on-resolve (it is `void` today, so a credential write
could never tick its own row over), a scrolling list, persisted intent
(`Linear / later / never` — no filesystem inspection can discover intent, so
"derived, never stored" is right for machine truth and wrong for preference), the
toolbar dot, and a **dry-run Start** that provisions and tears down a throwaway
session to prove function rather than configuration.

## 13. Known limits, stated

- **One tracker workspace.** The credentials file's shape leaves room for named
  profiles later without a migration.
- **A monorepo package is not a Project.**
- **`ctl --project` teaches nothing** (§4.2).
- **Downgrade is inert, not lossy** (§5.1).

## 14. What changed from the 2026-05-10 spec

Written, planned, never implemented; `teamRepoMap` shipped instead.

**Its Project was a Linear project**, keyed on the tracker uuid. Linear projects
are short-lived — "Q1 Auth Migration" — so opting in per project means
reconfiguring every quarter. Here the Linear project is a routing key (§4.3),
which is what it is genuinely good at.

**It resolved multi-repo with `defaultRepoIndex`**, silently picking repo 0. A
silent default is how work lands in the wrong repo and is not noticed until a
branch exists.

## 15. Verification

Pure unit tests over logic modules; `boot-smoke` and `binary-boot-smoke` cover
what unit tests cannot reach.

**Phase 1:** atomic write; parse failure does **not** yield defaults; unknown
keys survive a round trip; the watcher survives a rename; a retired epoch's
results, auth failures, rate-limit changes and rollbacks are all dropped;
`drainBackfill`'s `finally` cannot clear a live marker; identity probes
distinguish invalid credentials from network failure; one credential resolver
serves TUI and CLI; `/` search; a rejected `onTextCommit` surfacing its message.

**Phase 2:** every `resolveIssueProject` outcome including `conflict` and
`orphaned`; existing-session precedence ahead of cardinality; route pruning
post-stamp and never on absence; migration losslessness including equal-valued
overrides and shared-`dir` fan-out; sparse overrides by key presence at three
tiers.
