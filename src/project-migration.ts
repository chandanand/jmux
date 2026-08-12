// One-time migration from teamRepoMap + repoDefaults + repos[key] onto Projects.
//
// This is persisted user data at a boundary, so it needs a real migration path
// rather than a deletion — the rule in CLAUDE.md, and the pattern
// `migrateLegacyConfig` already establishes for the previous config reshape.
//
// Pure: the caller supplies the dir → git-common-dir resolution, because doing
// it here would make this module spawn git and stop being testable.

import { basename } from "path";
import type { RepoSettings } from "./repo-settings";
import {
  makeProjectId,
  type ProjectConfig,
  type ProjectSettings,
} from "./project";

/** Just the parts of the config this migration reads. */
export interface LegacyShape {
  projects?: ProjectConfig[];
  repoDefaults?: RepoSettings;
  repos?: Record<string, RepoSettings>;
  issueWorkflow?: { teamRepoMap?: Record<string, string> };
}

export interface MigrationResult {
  projects: ProjectConfig[];
  /** The global tier. `repoDefaults` stays where it is — it is not copied. */
  globalDefaults: ProjectSettings | undefined;
  changed: boolean;
}

/** `claudeCommand` → `agentCommand`; everything else carries across verbatim. */
function toProjectSettings(legacy: RepoSettings | undefined): ProjectSettings | undefined {
  if (!legacy) return undefined;
  const out: ProjectSettings = {};
  // Enumerated by key *presence*, so an override whose value equals the global
  // is still copied — provenance is presence, and dropping it would erase the
  // user's intent permanently.
  if ("defaultBaseBranch" in legacy) out.defaultBaseBranch = legacy.defaultBaseBranch;
  if ("wtmIntegration" in legacy) out.wtmIntegration = legacy.wtmIntegration;
  if ("autoLaunchAgent" in legacy) out.autoLaunchAgent = legacy.autoLaunchAgent;
  if ("sessionNameTemplate" in legacy) out.sessionNameTemplate = legacy.sessionNameTemplate;
  if ("claudeCommand" in legacy) out.agentCommand = legacy.claudeCommand;
  if ("onSessionStartState" in legacy) out.onSessionStartState = legacy.onSessionStartState;
  if ("onMrOpenState" in legacy) out.onMrOpenState = legacy.onMrOpenState;
  if ("onMrMergedState" in legacy) out.onMrMergedState = legacy.onMrMergedState;
  return out;
}

/**
 * Build the Projects a legacy config implies.
 *
 * `resolveCommonDir` maps an operational directory to its git common dir, which
 * is what joins the two legacy key spaces: `teamRepoMap` values are operational
 * paths and `repos[key]` keys are common dirs. Returning null just means the
 * directory could not be resolved, and its override stays unmatched rather than
 * being applied to the wrong Project.
 */
export function migrateToProjects(
  legacy: LegacyShape,
  resolveCommonDir: (dir: string) => string | null,
): MigrationResult {
  const globalDefaults = toProjectSettings(legacy.repoDefaults);

  // Already migrated. Deliberately checked first and unconditionally: running
  // again would re-create Projects the user may since have deleted.
  if (legacy.projects !== undefined) {
    return { projects: legacy.projects, globalDefaults, changed: false };
  }

  const teamMap = legacy.issueWorkflow?.teamRepoMap ?? {};
  const repos = legacy.repos ?? {};
  if (Object.keys(teamMap).length === 0 && Object.keys(repos).length === 0) {
    return { projects: [], globalDefaults, changed: false };
  }

  const taken = new Set<string>();
  const projects: ProjectConfig[] = [];

  // One Project per team → dir mapping. Two teams on one dir is two Projects:
  // that is exactly the monorepo case the model exists to express, and merging
  // them would route one team's issues into the other's work.
  for (const [teamName, dir] of Object.entries(teamMap)) {
    const title = basename(dir) || dir;
    const id = makeProjectId(title, taken);
    taken.add(id);
    projects.push({ id, title, dir, legacyTeamName: teamName });
  }

  // Per-repo overrides, matched by resolving each Project's dir to its common
  // dir. A shared dir fans one override out to every Project on it, because the
  // override was a property of the *repo*.
  const matched = new Set<string>();
  for (const p of projects) {
    const key = resolveCommonDir(p.dir);
    const override = key ? repos[key] : undefined;
    if (!override) continue;
    matched.add(key!);
    const settings = toProjectSettings(override);
    if (settings && Object.keys(settings).length > 0) p.settings = settings;
  }

  // A `repos[key]` matching no Project still describes a repo the user
  // configured, so it becomes its own teamless Project rather than being
  // silently dropped along with whatever they set on it.
  for (const [key, override] of Object.entries(repos)) {
    if (matched.has(key)) continue;
    const dir = key.replace(/\/\.git$/, "");
    const title = basename(dir) || dir;
    const id = makeProjectId(title, taken);
    taken.add(id);
    const settings = toProjectSettings(override);
    projects.push({
      id,
      title,
      dir,
      ...(settings && Object.keys(settings).length > 0 ? { settings } : {}),
    });
  }

  return { projects, globalDefaults, changed: projects.length > 0 };
}
