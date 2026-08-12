# Phase 2 — the Project primitive

Status: approved model (see `2026-08-11-projects-and-onboarding-design.md`
Part I). This document resolves the seven open questions that spec deferred, so
the work can be planned without an implementer inventing answers.

Every resolution below is a **stated assumption**, not a decision taken with the
user in the room. Each says what it assumes and what would change if the
assumption is wrong.

---

## 0. Recap of the settled model

```ts
interface ProjectConfig {
  id: string;            // stable slug, never re-derived on rename
  title: string;
  dir: string;           // OPERATIONAL cwd for worktree creation; may be shared
  teamId?: string;       // several Projects may claim one team
  legacyTeamName?: string;
  settings?: ProjectSettings;   // sparse by KEY PRESENCE
  deletedAt?: string;
}

// Top-level, not per-Project — one table, no two maps able to disagree.
routes?: {
  issue?: Record<issueId, projectId>;
  linearProject?: Record<linearProjectId, projectId>;
}
```

`resolveIssueProject` returns one of five outcomes: `resolved`, `unclaimed`,
`ambiguous`, `conflict`, `orphaned`. Existing sessions are consulted **before**
candidate cardinality. Session → Project is `@jmux-project`, durable via the
snapshot.

---

## 1. `Ctrl-a n` selects a Project, not a path

**Resolution.** The new-session modal lists **Projects**, not `projectDirs`
entries. Two Projects sharing a `dir` appear as two rows, distinguished by
title. Choosing one stamps `@jmux-project` on the session it creates.

A repo on disk that belongs to no Project still appears, under a
**"Not in a project"** group, and choosing it creates a session with **no**
`@jmux-project` stamp — which `resolveIssueProject` will later report as
`orphaned` rather than guessing. It also offers "Add to a project…".

**Assumption:** people want to start plain sessions in repos they have not
adopted. Removing that would make Projects mandatory before jmux is usable at
all, which contradicts "Projects always exist; the tracker is optional".

## 2. Group start requires one resolved Project

**Resolution.** `startIssueGroup` (`main.ts:7408`) currently merges issues that
resolve to the same *path*. It resolves each issue through
`resolveIssueProject` and requires exactly one `resolved` Project across the
set. Anything else refuses and names the reason, reusing the existing
"issues already in a session are dropped and reported" treatment:

- several Projects → "these 3 issues route to Payments, these 2 to Web"
- any `unclaimed` / `ambiguous` / `conflict` → named per issue, group refused

**Assumption:** a group start that silently split across two repos would be
worse than a refusal, because it creates real branches and worktrees. This
matches the existing four refusals that function already makes.

## 3. Attaching an issue to an existing session

**Resolution.** Attaching (`main.ts` link flow) does **not** write a route and
does **not** move the session. It links the issue, and if that issue's team
resolves to a different Project than the session's `@jmux-project`, the sidebar
shows **drift** on that row — reusing `workflow-drift.ts`'s existing vocabulary
rather than inventing a second one.

Rejected alternatives, and why:

- *Write an exact route*: the user linked an issue to a session, which is a
  statement about this issue, not a rule about its Linear project. Turning it
  into a rule is the "correction writes the rule" principle applied where the
  user made no correction.
- *Refuse a cross-team link*: a feature filed under two teams is ordinary, and
  the link store has always been many-to-one.

**Assumption:** drift is the right signal because it already exists and already
means "these two facts disagree and nobody has acted".

## 4. `ctl status` and `ctl workflow board`

**Resolution.** `STATUS_FORMAT` (`cli/status.ts:40`) gains `#{@jmux-project}`,
and the typed output gains:

```jsonc
"project": { "id": "payments", "title": "Payments" }   // resolved
"project": null                                         // no stamp
"project": { "id": "payments", "state": "deleted" }     // stamp names a dead Project
```

`null` and `deleted` are deliberately different: the first is a session nobody
adopted, the second is a dangling reference an agent can report.

`ctl workflow board` groups by Project when `--group project` is passed, and
resolves membership through the same `project-routing.ts` the TUI uses — never
its own copy, per the rule at the top of `cli/workflow.ts`.

**Assumption:** agents want the id for addressing and the title for reporting,
so both are returned rather than making callers join.

## 5. Pinned and Parked bands

**Resolution.** Those bands are extracted **before** Project grouping
(`sidebar.ts:538`), so their rows carry no Project header. Each row therefore
shows the Project **title as a dim suffix on row 2**, in the same cluster that
already degrades right-to-left (MR id, timer, context figure).

It is the **first** thing dropped as the sidebar narrows — before the timer and
the MR id — for the same reason the workflow field is: under `group=project`
the band header already names it, so it is suppressed there and those columns
return to the row's other fields.

**Assumption:** someone looking at Pinned wants to know which Project a row
belongs to, but less than they want the timer. If that is wrong the priority
order is one constant.

## 6. Ghosts carry a Project outcome

**Resolution.** `GhostIssue` (`ghosts.ts:109`) gains
`project: { kind: "resolved"; id; title } | { kind: "unclaimed" } | { kind: "ambiguous" } | null`.
`orphaned` cannot occur for a ghost — it has no session by definition.

- Under `group=project`, `resolved` ghosts file under their Project's band;
  `unclaimed` and `ambiguous` collect in a single **"Unassigned"** band at the
  bottom rather than being hidden, because an issue nobody can route is exactly
  the thing the user needs to see.
- Under every other axis, behaviour is unchanged — ghosts already gather into
  one flat "Up next" band and the stage axis already works.

**Assumption:** showing unroutable work is better than hiding it. The opposite
choice would make a misconfigured team map silently reduce the ghost list,
which is the original reported failure in a new costume.

## 7. Snapshot restore's cwd-only callback

**Resolution.** `SnapshotSession` gains `projectId?: string` (optional and
defaulted, the pattern `agentState` and `otel.contextTokens` already used
without bumping `formatVersion`). Restore re-stamps `@jmux-project` **before**
any Project-aware settings resolution or polling runs.

`restore.ts:14`'s agent-command callback currently receives only a cwd. It gains
the `projectId` from the snapshot, so it resolves `ProjectSettings.agentCommand`
through the same three-tier resolver as everything else. Where the snapshot
predates the field, it falls back to the global tier — which is exactly what a
session with no Project gets anyway, so there is one behaviour, not two.

**Assumption:** an old snapshot restoring with global settings is acceptable for
one upgrade. The alternative — refusing to restore — would lose sessions.

---

## 8. What phase 2 does *not* do

- No mouse on full-screen surfaces (phase 1 finding; belongs to all three at
  once).
- No multi-workspace credentials.
- No monorepo sub-path Projects.
- No automatic Project creation from a scan. Projects come from the migration,
  from `Ctrl-a n`'s "Add to a project…", and from the ghost preview's
  "Create a project for this team". A background scanner that adopted repos
  would be the one thing the user cannot undo by not clicking.

## 9. Verification

- `resolveIssueProject`: all five outcomes; existing-session precedence ahead of
  cardinality; a stamp naming a deleted Project yields `orphaned`, never a
  re-route.
- Route pruning: post-stamp, and **never** on absence (`getMyIssues` filters
  completed/canceled, so absence is not completion).
- Migration: `teamRepoMap` + `repoDefaults` + `repos[key]` in, Projects out;
  equal-valued overrides preserved by key presence; shared-`dir` fan-out applies
  one legacy override to every Project on that dir; unmatched keys become their
  own teamless Project rather than being dropped.
- Sparse overrides at three tiers, with `inherited`/`override` correct when a
  Project's value equals the global.
- Group start refuses a set spanning two Projects and names both.
- Snapshot round-trip carries `projectId`; a snapshot without one restores to
  the global tier rather than failing.
- `ctl status` distinguishes `null` from `deleted`.
