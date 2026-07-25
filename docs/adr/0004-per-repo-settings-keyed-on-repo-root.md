# Per-repo settings, keyed on the canonical repo root, resolved global → override

## Status

accepted

## Context & decision

Several workflow settings are really properties of a **repo**, not of the user
or the jmux UI: the default base branch (`main` vs `master` vs `develop`),
whether the repo is a wtm-managed bare repo, the agent command, the session-name
template, and whether to auto-launch the agent for an issue. Until now these were
single global values (mostly under `issueWorkflow`, plus top-level
`claudeCommand` / `wtmIntegration`), so working across repos with different
trunks or layouts meant editing one global before each context switch.

We introduced a **global-default → per-repo-override** model. The same
`RepoSettings` shape holds both tiers, and resolution is a uniform flat merge:

```
resolve(repoKey, field) = repos[repoKey]?.[field]   // this repo
                       ?? repoDefaults?.[field]      // global default
                       ?? HARDCODED[field]           // built-in default
```

Two structural decisions matter most:

**The key is the canonical main-worktree root path.** A running session's cwd is
a *worktree subdir* (`…/jmux/my-feature`), not the repo root, so every read first
resolves cwd → repo root via git (`--show-toplevel`, then the **main** worktree
root via `--git-common-dir`) so all worktrees of a repo map to one key. The path
is pushed through a **single canonicalizer** (expand `~`, `realpath` to resolve
symlinks, strip trailing slash) at *both* read and write time — the same
"one chokepoint" discipline as `sanitizeTmuxSessionName`, for the same reason:
drift between two spellings of a path silently breaks lookups.

**Membership is scoped to settings that are genuinely per-repo.** UI/chrome
settings and the cross-repo routing index (`projectDirs`, `teamRepoMap`) stay
global. The `adapters` (code host / issue tracker) also stay global — they are
constructed and authenticated once at startup and power a single cross-repo
issue/MR panel that has no "current repo", so a per-repo adapter would require
re-architecting the adapter lifecycle for no in-scope benefit.

Existing configs are **migrated once on load** (structural detection, no version
field): old-location fields move into `repoDefaults` without clobbering anything
already there, and the file is rewritten — consistent with how `ConfigStore`
already rewrites the whole file on any change. `issueWorkflow` is kept as the home
for its sole remaining member, `teamRepoMap`.

`wtmIntegration` was wired to actually gate worktree creation (`wtm create` when
on, `git worktree add` when off) — previously it gated nothing. `autoCreateWorktree`
was **deleted** as dead config: every session/issue always gets a worktree, so the
toggle could never be flipped.

## Considered alternatives

- **Key on the wtm project name (bare-repo basename).** Already attached to every
  session and human-readable, but **not globally unique** — two `api` repos under
  different parents collide. Kept as the *display label*, rejected as the *key*.
- **Key on the git remote URL.** Globally unique and survives moves, but breaks
  for local-only repos (no remote) and is the least convenient to display/edit.
- **Per-repo `adapters`.** Genuinely valuable (different repos on GitHub vs
  GitLab, Linear vs Jira), but the issue/MR panel is a union across teams/repos
  with no single current repo, and adapters auth once at startup. Deferred to a
  separate feature with its own design.
- **Permanent dual-read instead of a one-time migration.** Never rewrite the
  file; resolver checks new location then falls back to old. Rejected: every
  consumption site carries a "check both places" branch forever — exactly the
  tech debt to avoid.
- **A repo-picker + nested settings sub-screen** so any repo can be edited from
  anywhere. Rejected: the TUI edits overrides for the **current** repo (resolved
  from the active session's cwd); for a single-user tool you are always sitting in
  the repo you care about, and the config file remains the source of truth for the
  rest.

## Consequences

- Per-repo settings have **one resolution path** (flat three-tier merge) and
  **one key derivation** (canonicalize + git repo-root resolution), cached per
  session. New per-repo settings are a one-field addition to `RepoSettings`.
- The TUI exposes overrides as a **dynamically-inserted category for the current
  repo** (shown only when settings is opened from a repo-backed session); each row
  shows the effective value plus an `(inherited)` / `(override)` marker, and the
  delete key clears an override back to inherited — reusing the map-entry delete
  pattern. Global defaults are the existing rows, retargeted to `repoDefaults`.
- `claudeCommand` is no longer a cached module global: the snapshot-restore engine
  resolves it **per restored session** from that session's dir → repo root.
- A user's `config.json` is rewritten once on first launch after upgrade; the old
  `issueWorkflow.{defaultBaseBranch,autoLaunchAgent,sessionNameTemplate}`,
  top-level `claudeCommand`/`wtmIntegration`, and the deleted `autoCreateWorktree`
  no longer appear in their original places.
