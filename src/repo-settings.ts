// Per-repo settings: shape, keying, and resolution.
//
// Several workflow settings are properties of a *repo*, not of the user or the
// UI — the trunk branch, whether the repo is wtm-managed, the agent command.
// This module owns the whole story: the `RepoSettings` shape (which holds both
// the global-default tier and the per-repo override tier), the flat three-tier
// resolver, the single path canonicalizer that derives the repo key, and the
// one-time migration of legacy config layouts.
//
// See docs/adr/0004-per-repo-settings-keyed-on-repo-root.md.

import { homedir } from "os";
import { realpathSync } from "fs";

/**
 * Which lifecycle stage a tracker state means. Behaviour keys off the stage;
 * the raw state name is only ever used for display. See src/work-stage.ts.
 */
export type WorkStage = "idea" | "active" | "parked" | "done";

/**
 * Workflow settings that can be set globally (repoDefaults) or per-repo (repos[key]).
 *
 * Every field is scalar or an array — deliberately never a nested object. The
 * resolver merges per *field*, so an object-valued field would have a repo
 * override silently replace the whole map rather than merging entries. Keying
 * the stage lists by stage (rather than a `Record<stateName, stage>`) keeps
 * "replace wholesale" the semantics a reader actually expects.
 */
export interface RepoSettings {
  defaultBaseBranch?: string;
  /** true → `wtm create`; false → `git worktree add`. */
  wtmIntegration?: boolean;
  autoLaunchAgent?: boolean;
  sessionNameTemplate?: string;
  claudeCommand?: string;


  // Status writes. null means "never write on this event" — the default, so
  // jmux touches nobody's tracker until explicitly told to.
  onSessionStartState?: string | null;
  onMrOpenState?: string | null;
  onMrMergedState?: string | null;
}

/** Fully-resolved settings — every field present. */
export interface ResolvedRepoSettings {
  defaultBaseBranch: string;
  wtmIntegration: boolean;
  autoLaunchAgent: boolean;
  sessionNameTemplate: string;
  claudeCommand: string;
  onSessionStartState: string | null;
  onMrOpenState: string | null;
  onMrMergedState: string | null;
}

export const REPO_SETTING_DEFAULTS: ResolvedRepoSettings = {
  defaultBaseBranch: "main",
  wtmIntegration: true,
  autoLaunchAgent: true,
  sessionNameTemplate: "{identifier}",
  claudeCommand: "claude",
  onSessionStartState: null,
  onMrOpenState: null,
  onMrMergedState: null,
};

/**
 * Three-tier resolution: per-repo override, else global default, else base.
 *
 * Only `undefined` counts as "not set". `null`, `false` and `""` are real
 * values that win — `null` in particular is load-bearing for the transition
 * fields, where it means "never write" and must not fall through to a lower
 * tier that says otherwise.
 *
 * Fields are enumerated from `base`, so adding one to RepoSettings needs no
 * change here — only an entry in REPO_SETTING_DEFAULTS.
 *
 * `base` lets the caller swap the hardcoded base for a per-repo seed
 * (e.g. wtmIntegration seeded from runtime bare-repo detection).
 */
export function resolveRepoSettings(
  repoDefaults: RepoSettings | undefined,
  override: RepoSettings | undefined,
  base: ResolvedRepoSettings = REPO_SETTING_DEFAULTS,
): ResolvedRepoSettings {
  const out = {} as Record<string, unknown>;
  for (const key of Object.keys(base)) {
    const o = (override as Record<string, unknown> | undefined)?.[key];
    if (o !== undefined) { out[key] = o; continue; }
    const d = (repoDefaults as Record<string, unknown> | undefined)?.[key];
    if (d !== undefined) { out[key] = d; continue; }
    out[key] = (base as unknown as Record<string, unknown>)[key];
  }
  return out as unknown as ResolvedRepoSettings;
}

export type GitRun = (args: string[]) => string | null;

/** Default git runner — Bun, not Node. Returns trimmed stdout, or null on nonzero exit. */
const defaultGitRun: GitRun = (args) => {
  const p = Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "ignore" });
  if (p.exitCode !== 0) return null;
  const out = p.stdout.toString().trim();
  return out.length > 0 ? out : null;
};

/**
 * The single chokepoint for turning any repo-ish path into a stable key:
 * strip surrounding whitespace, expand a leading ~, resolve symlinks via
 * realpath, strip a trailing slash. realpath failures (path doesn't exist yet)
 * fall back to the un-realpathed string.
 *
 * The whitespace strip is not cosmetic: raw `git rev-parse` output arrives
 * newline-terminated, and a key that differs only by a trailing "\n" silently
 * misses every lookup. Trimming here rather than at each call site is the same
 * one-chokepoint discipline the rest of this function exists for.
 */
export function canonicalizeRepoPath(
  p: string,
  opts?: { home?: string; realpath?: (p: string) => string },
): string {
  const home = opts?.home ?? homedir();
  const realpath = opts?.realpath ?? ((x: string) => {
    try { return realpathSync(x); } catch { return x; }
  });
  let out = p.trim();
  if (out === "~") out = home;
  else if (out.startsWith("~/")) out = home + out.slice(1);
  out = realpath(out);
  if (out.length > 1 && out.endsWith("/")) out = out.slice(0, -1);
  return out;
}

/**
 * The repo key: the canonical git common dir, which is identical for the main
 * checkout and every linked worktree of a repo, so any session resolves to one key.
 * Returns null when cwd is not inside a git repo.
 */
export function resolveRepoRoot(cwd: string, run: GitRun = defaultGitRun): string | null {
  const out = run(["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (!out) return null;
  return canonicalizeRepoPath(out);
}

/** Runtime bare-repo detection — the base default for wtmIntegration when unset. */
export function detectBareRepo(cwd: string, run: GitRun = defaultGitRun): boolean {
  return run(["-C", cwd, "rev-parse", "--is-bare-repository"])?.trim() === "true";
}

/**
 * Build the worktree-creation command, run with cwd = the repo directory.
 * wtm on  → `wtm create <session> --from <base>` (wtm manages the bare repo).
 * wtm off → `git worktree add ./<session> -b <session> <base>` (sibling dir,
 *           same `<repo>/<session>` layout wtm produces, no bare-repo management).
 * Always creates a worktree — never an in-place checkout.
 */
export function buildWorktreeCommand(o: {
  wtm: boolean;
  session: string;
  baseBranch: string;
  noShell?: boolean;
}): string {
  if (o.wtm) {
    const base = `wtm create ${o.session} --from ${o.baseBranch}`;
    return o.noShell ? `${base} --no-shell` : base;
  }
  return `git worktree add ./${o.session} -b ${o.session} ${o.baseBranch}`;
}

/** The git-derived facts about a directory that settings resolution needs. */
export interface RepoFacts {
  /** Canonical git common dir — the repo key. null when not inside a repo. */
  key: string | null;
  /** Whether the repo is bare, which seeds the wtmIntegration base default. */
  bare: boolean;
}

/**
 * Caches the *git* facts about a directory — deliberately not the resolved
 * settings. Git facts (which repo a dir belongs to, whether it is bare) are
 * stable for the life of a process; the config layered on top of them changes
 * whenever the user edits a setting. Caching only the stable half means a
 * settings change takes effect immediately without any invalidation protocol.
 */
export class RepoFactsCache {
  private byDir = new Map<string, RepoFacts>();

  constructor(private readonly run: GitRun = defaultGitRun) {}

  get(dir: string): RepoFacts {
    const hit = this.byDir.get(dir);
    if (hit) return hit;
    const key = resolveRepoRoot(dir, this.run);
    const facts: RepoFacts = { key, bare: key ? detectBareRepo(dir, this.run) : false };
    this.byDir.set(dir, facts);
    return facts;
  }

  /** Drop cached facts — used when worktrees are created or removed. */
  clear(): void {
    this.byDir.clear();
  }
}

/**
 * The one place config + git facts become effective settings: seed the base
 * with runtime bare detection, then apply global defaults and the per-repo
 * override for this repo's key.
 */
export function resolveForRepo(
  config: { repoDefaults?: RepoSettings; repos?: Record<string, RepoSettings> },
  facts: RepoFacts,
): ResolvedRepoSettings {
  const base: ResolvedRepoSettings = { ...REPO_SETTING_DEFAULTS, wtmIntegration: facts.bare };
  const override = facts.key ? config.repos?.[facts.key] : undefined;
  return resolveRepoSettings(config.repoDefaults, override, base);
}

const RELOCATED_TOP_LEVEL = ["claudeCommand", "wtmIntegration"] as const;
const RELOCATED_WORKFLOW = ["defaultBaseBranch", "autoLaunchAgent", "sessionNameTemplate"] as const;

/**
 * One-time, idempotent, no-clobber migration from the pre-repo-settings shape.
 * Moves relocated fields into repoDefaults (unless already set there), drops the
 * dead `autoCreateWorktree`, and prunes emptied containers. Pure: returns the new
 * object plus whether anything changed (the caller persists only when changed).
 */
export function migrateLegacyConfig(raw: any): { config: any; changed: boolean } {
  const config = structuredClone(raw ?? {});
  let changed = false;
  const repoDefaults = { ...(config.repoDefaults ?? {}) };

  for (const key of RELOCATED_TOP_LEVEL) {
    if (config[key] !== undefined) {
      if (repoDefaults[key] === undefined) repoDefaults[key] = config[key];
      delete config[key];
      changed = true;
    }
  }

  // Stage lists moved onto the queue tabs that now own them (one mapping, not
  // two). Fold them in, then drop them from every settings tier.
  const stageKeys = ["ideaStates", "activeStates", "parkedStates", "doneStates"] as const;
  // `repoDefaults` (the local copy) is what gets written back at the end, so it
  // must be cleaned alongside the live objects or the keys reappear.
  const tiers = [repoDefaults, config.repoDefaults, ...Object.values(config.repos ?? {})].filter(Boolean) as any[];
  const lists: Record<string, string[]> = {};
  for (const tier of tiers) {
    for (const key of stageKeys) {
      if (Array.isArray(tier[key])) lists[key] = [...(lists[key] ?? []), ...tier[key]];
    }
  }
  if (Object.keys(lists).length > 0) {
    const migrated = migrateStagesIntoViews(config.panelViews ?? [], lists);
    if (Array.isArray(config.panelViews)) config.panelViews = migrated.views;
    for (const tier of tiers) for (const key of stageKeys) delete tier[key];
    changed = true;
  }

  // `groups` became `sections`, and the lifecycle stage moved from the tab down
  // onto each section — a section is the unit of classification, so one tab can
  // legitimately mix "still mine" with "someone else's".
  // Statuses collected on the way through, from every shape parking has had.
  const parked: string[] = [];
  for (const view of (Array.isArray(config.panelViews) ? config.panelViews : []) as any[]) {
    if (Array.isArray(view.groups) && !Array.isArray(view.sections)) {
      view.sections = view.groups;
      delete view.groups;
      changed = true;
    }
    if (view.stage) {
      for (const section of view.sections ?? []) {
        if (!section.stage) section.stage = view.stage;
      }
      delete view.stage;
      changed = true;
    }

    // ...and then out of the tabs entirely, into one flat list of the statuses
    // that park. A section's `stage` was a four-way choice of which only
    // `parked` did anything observable, so classifying a status was mostly a
    // decision with no consequence; the other three stages need no
    // configuration at all, because `stageFromStateType` already derives them
    // from the tracker's own categories.
    const sections = Array.isArray(view.sections) ? view.sections : [];
    for (const section of sections) {
      if (section?.stage === undefined) continue;
      if (section.stage === "parked") parked.push(...(section.states ?? []));
      delete section.stage;
      changed = true;
    }
    // The intermediate shape, where parking was one flag on the tab.
    if (view.parks !== undefined) {
      if (view.parks === true) parked.push(...sections.flatMap((sec: any) => sec.states ?? []));
      delete view.parks;
      changed = true;
    }

    // Sections collapse to a flat, ordered status list. A section was a named
    // bucket you maintained by hand, and in practice its name only ever
    // restated the status inside it; where one genuinely held several, the
    // panel now groups by status name instead, which reads the same with
    // nothing to configure. Order is priority order, so it is preserved.
    if (Array.isArray(view.sections)) {
      const flat: string[] = [];
      const seen = new Set<string>();
      for (const section of view.sections) {
        for (const state of section?.states ?? []) {
          const key = String(state).trim().toLowerCase();
          if (!key || seen.has(key)) continue;
          seen.add(key);
          flat.push(state);
        }
      }
      if (flat.length > 0) view.states = [...(view.states ?? []), ...flat];
      delete view.sections;
      changed = true;
    }
  }

  if (parked.length > 0) {
    const pipeline = { ...(config.pipeline ?? {}) };
    const seen = new Set((pipeline.parkedStates ?? []).map((s: string) => s.trim().toLowerCase()));
    const merged = [...(pipeline.parkedStates ?? [])];
    for (const state of parked) {
      const key = state.trim().toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(state);
    }
    pipeline.parkedStates = merged;
    config.pipeline = pipeline;
    changed = true;
  }

  // The switch that said "the stages that mean parked should park" — a
  // tautology that could be turned off, which is how parking came to look
  // configured while doing nothing. The status says so directly now.
  if (config.pipeline && typeof config.pipeline === "object"
      && config.pipeline.parkStages !== undefined) {
    delete config.pipeline.parkStages;
    changed = true;
  }

  const wf = config.issueWorkflow;
  if (wf && typeof wf === "object") {
    for (const key of RELOCATED_WORKFLOW) {
      if (wf[key] !== undefined) {
        if (repoDefaults[key] === undefined) repoDefaults[key] = wf[key];
        delete wf[key];
        changed = true;
      }
    }
    if (wf.autoCreateWorktree !== undefined) {
      delete wf.autoCreateWorktree; // dead config — drop, never migrate
      changed = true;
    }
    if (Object.keys(wf).length === 0) delete config.issueWorkflow;
  }

  if (Object.keys(repoDefaults).length > 0) config.repoDefaults = repoDefaults;
  return { config, changed };
}

const STAGE_LIST_KEYS = [
  ["idea", "ideaStates"],
  ["active", "activeStates"],
  ["parked", "parkedStates"],
  ["done", "doneStates"],
] as const;

/**
 * Fold the old per-repo stage lists into the queue tabs that now own them.
 *
 * Each tab takes the stage most of its states belonged to; ties go to the
 * earlier lifecycle stage, which matches how the tabs are named in practice (a
 * tab called "To do" holding one parked state still means active). States that
 * had a stage but live in no tab are reported rather than silently dropped —
 * they lose their mapping and fall back to the tracker's own category.
 */
export function migrateStagesIntoViews(
  views: any[],
  lists: Record<string, string[] | undefined>,
): { views: any[]; orphaned: string[] } {
  const stageOf = new Map<string, WorkStage>();
  for (const [stage, key] of STAGE_LIST_KEYS) {
    for (const name of lists[key] ?? []) stageOf.set(name.trim().toLowerCase(), stage);
  }
  if (stageOf.size === 0) return { views, orphaned: [] };

  const claimed = new Set<string>();
  const nextViews = views.map((view) => {
    const states: string[] = (view.groups ?? []).flatMap((g: any) => g.states ?? []);
    for (const n of states) if (stageOf.has(n.trim().toLowerCase())) claimed.add(n.trim().toLowerCase());
    if (view.stage) return view;

    const tally = new Map<WorkStage, number>();
    for (const n of states) {
      const stage = stageOf.get(n.trim().toLowerCase());
      if (stage) tally.set(stage, (tally.get(stage) ?? 0) + 1);
    }
    if (tally.size === 0) return view;
    let best: WorkStage | undefined;
    for (const [stage] of STAGE_LIST_KEYS) {
      const n = tally.get(stage) ?? 0;
      if (n > 0 && (best === undefined || n > (tally.get(best) ?? 0))) best = stage;
    }
    return best ? { ...view, stage: best } : view;
  });

  const orphaned = [...stageOf.keys()]
    .filter((k) => !claimed.has(k))
    .map((k) => {
      for (const [, key] of STAGE_LIST_KEYS) {
        const hit = (lists[key] ?? []).find((n) => n.trim().toLowerCase() === k);
        if (hit) return hit;
      }
      return k;
    });
  return { views: nextViews, orphaned };
}
