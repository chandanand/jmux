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

/** Workflow settings that can be set globally (repoDefaults) or per-repo (repos[key]). */
export interface RepoSettings {
  defaultBaseBranch?: string;
  /** true → `wtm create`; false → `git worktree add`. */
  wtmIntegration?: boolean;
  autoLaunchAgent?: boolean;
  sessionNameTemplate?: string;
  claudeCommand?: string;
}

/** Fully-resolved settings — every field present. */
export interface ResolvedRepoSettings {
  defaultBaseBranch: string;
  wtmIntegration: boolean;
  autoLaunchAgent: boolean;
  sessionNameTemplate: string;
  claudeCommand: string;
}

export const REPO_SETTING_DEFAULTS: ResolvedRepoSettings = {
  defaultBaseBranch: "main",
  wtmIntegration: true,
  autoLaunchAgent: true,
  sessionNameTemplate: "{identifier}",
  claudeCommand: "claude",
};

/**
 * Three-tier resolution: per-repo override ?? global default ?? base default.
 * `??` (not `||`) so explicit `false` / `""` overrides win.
 * `base` lets the caller swap the hardcoded base for a per-repo seed
 * (e.g. wtmIntegration seeded from runtime bare-repo detection).
 */
export function resolveRepoSettings(
  repoDefaults: RepoSettings | undefined,
  override: RepoSettings | undefined,
  base: ResolvedRepoSettings = REPO_SETTING_DEFAULTS,
): ResolvedRepoSettings {
  const pick = <K extends keyof ResolvedRepoSettings>(k: K): ResolvedRepoSettings[K] =>
    (override?.[k] ?? repoDefaults?.[k] ?? base[k]) as ResolvedRepoSettings[K];
  return {
    defaultBaseBranch: pick("defaultBaseBranch"),
    wtmIntegration: pick("wtmIntegration"),
    autoLaunchAgent: pick("autoLaunchAgent"),
    sessionNameTemplate: pick("sessionNameTemplate"),
    claudeCommand: pick("claudeCommand"),
  };
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
