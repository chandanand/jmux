// The Project: one repo, at most one tracker team.
//
// Shape, identity, and the three-tier settings resolver. Deliberately free of
// tracker, tmux and filesystem knowledge — routing lives in project-routing.ts
// and the migration in project-migration.ts, so this module stays a pure data
// layer that both the TUI and `jmux ctl` can depend on.
//
// See docs/superpowers/specs/2026-08-11-projects-and-onboarding-design.md.

/**
 * Workflow settings, per Project. Exactly the old `RepoSettings` with
 * `claudeCommand` renamed, so the migration off `repos[key]` is lossless.
 *
 * Every field is scalar — never a nested object. The resolver merges per
 * *field*, and an object-valued field would have an override silently replace a
 * whole map rather than merging it.
 */
export interface ProjectSettings {
  defaultBaseBranch?: string;
  /** true → `wtm create`; false → `git worktree add`. */
  wtmIntegration?: boolean;
  autoLaunchAgent?: boolean;
  sessionNameTemplate?: string;
  agentCommand?: string;
  /** null means "never write on this event" — a real value, not an absence. */
  onSessionStartState?: string | null;
  onMrOpenState?: string | null;
  onMrMergedState?: string | null;
}

/** Fully-resolved settings — every field present. */
export interface ResolvedProjectSettings {
  defaultBaseBranch: string;
  wtmIntegration: boolean;
  autoLaunchAgent: boolean;
  sessionNameTemplate: string;
  agentCommand: string;
  onSessionStartState: string | null;
  onMrOpenState: string | null;
  onMrMergedState: string | null;
}

export const PROJECT_SETTING_DEFAULTS: ResolvedProjectSettings = {
  defaultBaseBranch: "main",
  wtmIntegration: true,
  autoLaunchAgent: true,
  sessionNameTemplate: "{identifier}",
  agentCommand: "claude",
  onSessionStartState: null,
  onMrOpenState: null,
  onMrMergedState: null,
};

export interface ProjectConfig {
  /**
   * Stable slug, generated once from the title and never re-derived on rename —
   * routes and `@jmux-project` stamps are resolved against it, so a rename must
   * not orphan them.
   */
  id: string;
  title: string;
  /**
   * The *operational* directory: the cwd worktree creation runs in. Several
   * Projects may share one — a monorepo serving two teams is two Projects and
   * one root, which is why session → Project is an explicit stamp rather than a
   * path lookup.
   *
   * Deliberately not the git common dir. That is identity, it is `<dir>/.git`
   * for a normal checkout, and building `<dir>/<session>` from it would create
   * worktrees inside `.git`.
   */
  dir: string;
  /** Several Projects may claim one team; routing disambiguates. */
  teamId?: string;
  /**
   * Held by the migration until the first authenticated resolve, because
   * `teamRepoMap` keyed on team *names* and this keys on ids. Never matched
   * against a team id — an unresolved Project claims nothing.
   */
  legacyTeamName?: string;
  /** Sparse: only keys the user explicitly set. See projectSettingScope. */
  settings?: ProjectSettings;
  /**
   * Soft delete. A Project whose repo is gone says so rather than looking
   * complete until provisioning fails.
   */
  deletedAt?: string;
}

/**
 * Three-tier resolution: project override, else global default, else base.
 *
 * Only `undefined` counts as "not set". `null`, `false` and `""` are real
 * values that win — `null` in particular is load-bearing for the transition
 * fields, where it means "never write" and must not fall through to a lower
 * tier that says otherwise.
 *
 * Fields are enumerated from the resolved default set, so adding one to
 * `ProjectSettings` needs no change here — only an entry in
 * `PROJECT_SETTING_DEFAULTS`.
 */
export function resolveProjectSettings(
  global: ProjectSettings | undefined,
  project: ProjectSettings | undefined,
  base: ProjectSettings = {},
): ResolvedProjectSettings {
  const out = { ...PROJECT_SETTING_DEFAULTS } as Record<string, unknown>;
  for (const key of Object.keys(PROJECT_SETTING_DEFAULTS)) {
    const b = (base as Record<string, unknown>)[key];
    const g = (global as Record<string, unknown> | undefined)?.[key];
    const p = (project as Record<string, unknown> | undefined)?.[key];
    if (p !== undefined) out[key] = p;
    else if (g !== undefined) out[key] = g;
    else if (b !== undefined) out[key] = b;
  }
  return out as unknown as ResolvedProjectSettings;
}

/**
 * Where a row's effective value came from.
 *
 * **Provenance is key presence, never value difference.** Pinning
 * `agentCommand: "codex"` while the global also happens to be `"codex"` is a
 * deliberate override; reporting it as inherited would let a later global
 * change silently move the Project, and no migration could reconstruct which
 * values had been chosen.
 */
export function projectSettingScope(
  project: ProjectConfig,
  field: keyof ProjectSettings,
  _global: ProjectSettings | undefined,
): "inherited" | "override" {
  return project.settings !== undefined && field in project.settings
    ? "override"
    : "inherited";
}

/**
 * A config-safe id from a title, unique against ids already in use.
 *
 * Suffixes rather than overwriting: two Projects called "Payments" in different
 * teams is ordinary, and silently merging them would route one team's issues
 * into the other's repo.
 */
export function makeProjectId(title: string, taken: ReadonlySet<string>): string {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "project";
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** Projects that have not been soft-deleted. */
export function liveProjects(all: readonly ProjectConfig[]): ProjectConfig[] {
  return all.filter((p) => p.deletedAt === undefined);
}

/**
 * Every live Project claiming `teamId`.
 *
 * More than one is legal — that is what makes a platform team's three services
 * expressible — and is disambiguated by routing, not here. An unresolved
 * `legacyTeamName` deliberately matches nothing: it is a name awaiting an id,
 * and treating it as an id would route on the ambiguous key the migration
 * exists to leave behind.
 */
export function projectsClaimingTeam(
  all: readonly ProjectConfig[],
  teamId: string | undefined,
): ProjectConfig[] {
  if (!teamId) return [];
  return liveProjects(all).filter((p) => p.teamId === teamId);
}

/**
 * The session → Project link, as a tmux session option.
 *
 * An explicit stamp rather than a path lookup, for two independent reasons:
 * two Projects may share a `dir`, so containment is genuinely ambiguous; and
 * `jmux ctl` needs the answer with no IPC to the running TUI, which is the
 * same constraint that already forces `@jmux-linear-issue` to exist beside
 * `state.json`. Follows t3code's `projection_threads.project_id NOT NULL`.
 *
 * tmux options die with the server, so this is *not* the durable copy — the
 * snapshot carries `projectId` and restore re-stamps it. A session whose stamp
 * is missing resolves to `orphaned`, which is honest, rather than being
 * silently re-routed by path.
 */
export const PROJECT_OPTION = "@jmux-project";

/** An id that is safe to put in a tmux option value. */
export function isWritableProjectId(id: string): boolean {
  return id.length > 0 && !/\s/.test(id) && !id.includes("'") && !id.includes('"');
}

/**
 * The Project a bare directory belongs to, when that is unambiguous.
 *
 * Null when none claims it *and* when several do — a shared `dir` is exactly
 * the case the explicit `@jmux-project` stamp exists for, and guessing one of
 * two here would resolve settings against a Project the session may not be in.
 * The honest answer is "no Project", which falls back to the global tier.
 */
export function projectForDir(
  all: readonly ProjectConfig[],
  dir: string | null | undefined,
): ProjectConfig | null {
  if (!dir) return null;
  const matches = liveProjects(all).filter((p) => p.dir === dir);
  return matches.length === 1 ? matches[0] : null;
}

/** A Project by id, ignoring soft-deleted ones. */
export function projectById(
  all: readonly ProjectConfig[],
  id: string | null | undefined,
): ProjectConfig | null {
  if (!id) return null;
  return liveProjects(all).find((p) => p.id === id) ?? null;
}

/**
 * Effective settings for a directory, resolved through Projects.
 *
 * The one implementation, shared by the TUI and `jmux ctl`. It replaces
 * `resolveForRepo`, which read `config.repos` — a map the migration removes, so
 * continuing to call it would silently drop every per-repo setting a user had
 * the moment they upgraded.
 *
 * `projectId` is the session's stamp when the caller has one. Without it the
 * Project comes from the directory, and a directory claimed by several Projects
 * resolves to none — the ambiguity the stamp exists to settle, answered
 * honestly rather than guessed.
 */
export function resolveSettingsFor(
  config: { projects?: ProjectConfig[]; projectDefaults?: ProjectSettings },
  opts: { dir?: string | null; projectId?: string | null; bare?: boolean },
): ResolvedProjectSettings {
  const all = config.projects ?? [];
  const project = projectById(all, opts.projectId) ?? projectForDir(all, opts.dir);
  return resolveProjectSettings(config.projectDefaults, project?.settings, {
    wtmIntegration: opts.bare ?? false,
  });
}

/**
 * Turn migrated `legacyTeamName` values into real `teamId`s.
 *
 * The migration can only carry the *name*, because `teamRepoMap` was keyed on
 * one and ids need an authenticated tracker. Without this step nothing ever
 * assigns `teamId`, `projectsClaimingTeam` returns the empty array forever, and
 * every issue routes to `unclaimed` — which silently kills group start and
 * leaves the "attach a team" checklist step permanently unsatisfiable.
 *
 * Returns only the Projects that changed, so the caller writes nothing when
 * there is nothing to do. A name matching no team is **kept**, not cleared: the
 * team may have been renamed in the tracker, and dropping the only record of
 * what the user configured makes the misconfiguration unrecoverable rather than
 * merely visible.
 */
export function resolveLegacyTeams(
  projects: readonly ProjectConfig[],
  teams: ReadonlyArray<{ id: string; name: string }>,
): ProjectConfig[] {
  if (teams.length === 0) return [];
  const byName = new Map(teams.map((t) => [t.name.trim().toLowerCase(), t.id]));
  const changed: ProjectConfig[] = [];
  for (const project of projects) {
    if (project.teamId !== undefined || !project.legacyTeamName) continue;
    const id = byName.get(project.legacyTeamName.trim().toLowerCase());
    if (!id) continue;
    changed.push({ ...project, teamId: id });
  }
  return changed;
}
