# Kickoff: revamp the workflow-configuration UX

You are picking up work on **jmux** with no prior context. This document is the
handoff. Read it fully before touching code.

**Your job:** the *configuration UX* for the issue-workflow feature described
below is confusing and needs redesigning. The underlying data model and
behaviour are sound and recently settled — **do not redesign those**. Redesign
how a human sets them up.

---

## 1. Orientation

jmux is a tmux-wrapping TUI for running coding agents in parallel. It renders its
own sidebar (sessions) and toolbar (windows) around a real tmux process. Bun
1.3.8+, TypeScript strict, no bundler, ~7k lines.

Read first, in order:

1. `CLAUDE.md` — architecture, the two-channel tmux model, rendering pipeline,
   input routing. Non-negotiable constraints live here.
2. `docs/issue-tracking.md` — the feature this document is about, from a user's
   point of view.
3. `docs/adr/0004-per-repo-settings-keyed-on-repo-root.md` — the per-repo
   settings model.

```bash
bun test           # 1851 tests, all passing. Keep it that way.
bun run typecheck  # tsc --noEmit, strict. Keep it clean.
bun run dev        # runs from source
```

Work is on branch `feat/work-pipeline` (28 commits ahead of `main`, +6112/-699
across 52 files). Nothing is pushed.

---

## 2. What the feature does

jmux integrates with Linear (issues) and GitLab (MRs). This branch added a
"work pipeline": issues flow through named queues, sessions park when work is
handed off, and status writes happen as a byproduct of what you already did.

### The domain model

```
Repo ──belongs to──▶ Team
Team ──has─────────▶ Issues
Issue ──via status─▶ Section
Section ──belongs to─▶ Tab
Tab ──renders──────▶ one header per Section
```

- A **tab** is a container in the info panel (`Urgent`, `To do`, `Waiting`).
  User-named; there is nothing in Linear to derive the name from.
- A **section** is the unit of classification. It lists the tracker statuses
  that land in it, and declares what they **mean** (`stage`).
- A **stage** is one of `idea | active | parked | done`. Behaviour keys off the
  stage; the raw status name is only ever used for display.

Stage lives on the **section**, not the tab — deliberately, and recently
changed. A tab is only a container, so one tab can legitimately hold
`Dev Confirm` (still yours → active) beside `In QA` (someone else's → parked).
Putting stage on the tab made that impossible and forced the layout.

### Behaviour driven by stage

- **Parking** — a session whose issue reaches a stage in `pipeline.parkStages`
  collapses into a single `Parked (n)` row at the bottom of the sidebar. It
  un-parks automatically on any configured signal (`state-regression`,
  `issue-comment`, `mr-activity`, `pipeline-failed`, `agent-attention`).
- **Up next** (`Ctrl-a u`) — pulls the top item from the first non-empty queue
  in `pipeline.upNext`.
- **Transitions** — optional writes back to the tracker on session-start /
  MR-opened / MR-merged, with an undo toast.

### Config shape (`~/.config/jmux/config.json`)

```jsonc
{
  "panelViews": [                       // the tabs, in order
    { "id": "urgent", "label": "Urgent", "source": "issues",
      "filter": { "scope": "assigned" },
      "sections": [                     // in order = priority within the tab
        { "label": "QA Failed", "stage": "active", "states": ["QA Failed"] }
      ],
      "groupBy": "none", "sortBy": "priority", "sortOrder": "asc" }
  ],
  "pipeline": {
    "parkStages": ["parked"],
    "unparkOn": ["state-regression", "issue-comment", "mr-activity", "pipeline-failed"],
    "autoParkIdleDays": 2,
    "transitionConfirm": "undo-toast",
    "upNext": ["urgent", "todo"]
  },
  "repoDefaults": { "defaultBaseBranch": "prerelease", "onSessionStartState": "In Progress", … },
  "repos": { "<canonical git common dir>": { … } },
  "issueWorkflow": { "teamRepoMap": { "Core Engineering": "/path/to/repo" } }
}
```

---

## 3. THE PROBLEM — this is your assignment

The owner's words, after using it:

> "I still find the entire configuration confusing."

Configuring this feature currently means understanding **seven concepts** —
tabs, sections, statuses, stages, park-stages, unpark-triggers, transitions —
spread across **four settings categories plus a three-level modal stack**, with
no single view of how they connect.

### Concrete evidence gathered this session

Each of these was a real, observed failure. They've been individually patched,
but they're symptoms of one underlying problem: *the settings surface doesn't
match the shape of the thing being configured.*

| Observed | Cause |
|---|---|
| "Nothing changes when I press enter on this one" | The settings screen consumed all input; a modal opened from a settings row rendered nothing and never received a key. |
| Parking silently did nothing | It required two settings in two different categories; only one had been set, and nothing said so. |
| Two state→X mappings drifted | Statuses were classified twice (once for display, once for behaviour). A status sitting in the "To do" tab was being parked anyway. |
| "Where are the settings to control which state rolls up into which tab?" | The docs named the wrong key (`Ctrl-a i` is a palette, `Ctrl-a I` is the screen) and the feature was JSON-only at the time. |
| "Why is it asking me to raw type sections?" | Section creation prompted for a name before asking which statuses it covers — backwards, since a section is *defined by* its statuses. |
| "I don't see the configurability" | Editing lived in a place the owner didn't think to look. |

### Where configuration lives today

`Ctrl-a I` opens the settings screen (`Ctrl-a i` is a different, smaller
palette — a known confusion). Current categories:

```
Display        sidebar width · panel width · cache timers · state colours
Integrations   code host · issue tracker
Repo           team → repo mappings · base branch · wtm · agent cmd · auto-launch
Project        project directories
Queues         Manage queues…                     ← opens a 3-level modal stack
Automation     park stages · unpark on · up next order · auto-park idle
Transitions    confirmation · on-start / on-MR-open / on-MR-merged   (collapsed)
Diagnostics    parking status · tracker states available
```

"Manage queues…" closes the settings screen and opens nested `ListModal`s:

```
Queues                  →  <tab>                        →  <tab> / <section>
  Urgent  2 sections         In QA   parked · 6              Statuses…   6 selected
  To do   2 sections         Rename / Move / Delete          Means…      Parked
+ New tab                  + Add section from a status…      Rename / Move / Delete
```

**Problems with this surface:**

- Queue config is in `Queues`, but the things that *act* on it
  (`parkStages`, `upNext`) are in `Automation`, and status writes are in
  `Transitions`. The chain tabs → sections → stages → parking is split across
  three categories.
- The editor is a stack of modals. There is no overview: you cannot see all
  statuses and where they go at once, which is exactly the question people ask.
- Around 25 Linear statuses must each be routed, one at a time, through three
  levels of menu.
- The settings screen's primitives (`text | boolean | list | map | multiselect |
  action`) are a poor fit for editing a two-level tree.
- Nothing shows the *consequence* of a mapping ("this parks 43 sessions").

### A starting hypothesis (not a mandate)

A dedicated full-screen workflow editor — the settings screen is already a
frameless full-screen takeover, so the precedent exists — showing every tracker
status on one side and the tab/section tree on the other, with assignment as a
direct move and live counts. One surface, one mental model, the whole mapping
visible. **Explore alternatives before committing**; the owner values design
exploration over speed.

---

## 4. Where the code is

| File | Role |
|---|---|
| `src/panel-view.ts` | `PanelView` / `PanelViewSection` types, `parseViews`, all queue CRUD (`createView`, `createSection`, `moveSection`, `assignStateToGroup`, …), `stagesFromViews`. **Pure and fully tested — reuse it.** |
| `src/panel-view-renderer.ts` | Turns views + issues into `ViewNode[]` and paints the panel. `buildViewNodes` honours explicit sections. |
| `src/work-stage.ts` | `WorkStage`, `projectStage`, `stageFromStateType` fallback. |
| `src/parking.ts` | `isParked` precedence, unpark signal detection, `parkingSetupWarning`. |
| `src/transitions.ts` | Edge detection for MR open/merge; `transitionTarget`. |
| `src/repo-settings.ts` | Per-repo settings, three-tier resolver, **all config migrations**. |
| `src/settings-screen.ts` | The settings screen and its `SettingDef` primitives. |
| `src/main.ts` | Wiring. `buildSettingsCategories` ~line 3649; queue editor ~line 2322. ~6200 lines — the least pleasant file to work in. |
| `src/adapters/linear.ts` | `listWorkflowStates()` returns every status across teams. |

Tests live in `src/__tests__/*` and are **pure unit tests over logic modules** —
they never spawn tmux. Match that: put new logic in a pure module and test it
there rather than testing through `main.ts`.

---

## 5. Constraints — do not break these

1. **Behaviour and data model are settled.** Sections own the stage. Tabs are
   containers. Stage drives behaviour; status names drive display. If you think
   one of these is wrong, raise it before changing it.
2. **One status has exactly one home.** `assignStateToGroup` removes it from
   everywhere else first. A status in two sections would resolve via a
   first-wins tie-break, which is a safety net, not a feature.
3. **Config migrations are one-time and structural**, in
   `migrateLegacyConfig` (`src/repo-settings.ts`). No permanent dual-read.
   If you change the config shape, migrate it there and test it.
4. **The settings screen consumes all input while open.** Opening a modal from
   it requires closing it first *and* not clobbering the modal's input routing
   — see `handleSettingsInput` in `main.ts`. This bug has been hit twice.
5. **Every prefix chord you add steals a key from tmux.** Check
   `config/*.conf` first. `Ctrl-a c` (new-window) and `Ctrl-a z` (zoom) were
   stolen once and had to be moved; there's a regression test in
   `src/__tests__/input-router.test.ts` pinning them.
6. **Nothing may write to the user's tracker without explicit configuration.**
   All transition fields default to `null`.
7. **Wide characters and column bookkeeping** — see CLAUDE.md. Any new grid
   writing must handle width-2 cells.
8. **Target Bun, not Node.**

---

## 6. Settled decisions — don't relitigate

- **Sections own the stage, not tabs.** Reason in §2.
- **`states` vs `stages` in filters** — `states` is exact but breaks on rename;
  `stages` is portable. Both are supported deliberately.
- **`teamRepoMap` stays global** — it's the cross-repo routing index that maps a
  team onto a repo, so it can't itself be per-repo.
- **Stage mapping is global, not per-repo.** Tabs are global; per-repo stage
  vocabulary was removed as unused over-engineering.
- **Empty sections keep their header with a `0` count** — "nothing is blocked"
  is information.
- **Capture stays where you are** (`Enter`) or starts work (`Ctrl-S`); it does
  not navigate you to the new issue.

### Known open items (fair game, but not the assignment)

- `teamRepoMap` is `team → one repo`; it cannot express one team owning several
  repos. Fine for the owner today (monorepo).
- Park baselines are in-memory, so unpark signals raised while jmux was closed
  aren't replayed. Stage-derived unparking still works.
- No MR tabs in the owner's config; `source: "mrs"` tabs can't be created from
  the UI.
- Per-tab `sortBy` / `sortOrder` / `sessionLinkedFirst` are JSON-only (though
  `S` / `?` cycle them live in the panel).

---

## 7. Definition of done

- One coherent place to configure the whole chain, discoverable without being
  told where to look.
- A person can answer "where does status X go, and what will that do?" without
  opening more than one screen.
- Setting it up from scratch for a fresh Linear workspace is walkable without
  reading docs.
- `bun test` and `bun run typecheck` clean; new logic covered by pure unit tests.
- `docs/issue-tracking.md` updated to match.
- Config migrated automatically if the shape changes.

## 8. How the owner works

- Wants the design explored and tradeoffs surfaced **before** implementation.
- Values being told when a premise is wrong.
- Expects TDD where practical, zero known bugs left behind, zero tech debt.
- Do not commit or sign off as Claude.
- Verify TUI changes by actually running them: boot jmux on an isolated socket
  (`bun run src/main.ts --demo -L <name>` inside a detached tmux, then
  `capture-pane`). Several bugs this session were only visible that way —
  unit tests passed while the screen was wrong.
