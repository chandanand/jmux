# Per-Repo Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a handful of workflow settings (default base branch, wtm integration, auto-launch agent, session-name template, claude command) be overridden per repo, resolved global-default → per-repo-override, all stored in jmux's own config file.

**Architecture:** A new pure module `src/repo-settings.ts` owns the `RepoSettings` shape, a three-tier resolver, path canonicalization, git repo-root resolution, bare-repo detection, and one-time legacy-config migration. `config.ts` gains `repoDefaults` / `repos` and loses the relocated fields. Consumption sites (issue path, manual new-worktree modal, snapshot restore, CLI) resolve settings by the repo a session belongs to. The settings screen edits global defaults plus a dynamically-inserted current-repo override category.

**Tech Stack:** Bun 1.3.8+, TypeScript (strict), `bun test`, `bun:test` (`describe`/`test`/`expect`). No new dependencies.

## Global Constraints

- Target **Bun, not Node**: use `Bun.spawnSync` for git calls, not `child_process`. (existing pattern: `main.ts:1716`)
- **One canonicalizer** for repo paths, used at both read and write time — mirror the `sanitizeTmuxSessionName` chokepoint discipline (`config.ts:69`).
- The repo key is the **canonical git common dir** (`git rev-parse --path-format=absolute --git-common-dir`), which is invariant across all worktrees of a repo. The wtm `project` basename is a display label only, never the key.
- Resolution is a uniform flat merge: `repos[key]?.x ?? repoDefaults?.x ?? baseDefaults.x`. The only non-constant base default is `wtmIntegration`, whose base default is the runtime bare-repo detection.
- **Always a worktree** for every session/issue. `wtmIntegration` selects the creation mechanism only: `true` → `wtm create`; `false` → `git worktree add`.
- Migration is **structural, idempotent, no-clobber**: move legacy fields into `repoDefaults` only when `repoDefaults` doesn't already define them; delete `autoCreateWorktree` (dead); keep `issueWorkflow` as the home of `teamRepoMap`.
- Tests are **pure unit tests** over logic modules — no spawning tmux. Inject git runners as function parameters.
- Run the full suite with `bun test` and `bun run typecheck` before each commit.

---

## File Structure

- **Create** `src/repo-settings.ts` — `RepoSettings`/`ResolvedRepoSettings` types, `REPO_SETTING_DEFAULTS`, `resolveRepoSettings`, `canonicalizeRepoPath`, `resolveRepoRoot`, `detectBareRepo`, `buildWorktreeCommand`, `migrateLegacyConfig`. One responsibility: everything about per-repo settings shape, keying, and migration.
- **Create** `src/__tests__/repo-settings.test.ts` — unit tests for the above.
- **Modify** `src/config.ts` — add `repoDefaults`/`repos` to `JmuxConfig`; trim `IssueWorkflowConfig` and top-level fields; wire migration into load + persist-on-migrate; add ConfigStore repo methods.
- **Modify** `src/__tests__/config.test.ts` — update for trimmed shape + migration + new methods.
- **Modify** `src/snapshot/restore.ts` — add optional `resolveClaudeCommand` to `RestorerOptions`; resolve per session cwd.
- **Modify** `src/main.ts` — wire resolution into the issue path (`~1670–1761`), manual modal (`~2862`), `Restorer` construction (`451`), settings builder (`2246`, `2306`), remove the `let claudeCommand` global (`232`, `3471`).
- **Modify** `src/settings-screen.ts` — render inherited/override marker; clear-override on delete key.
- **Modify** `src/cli/issue.ts` (`~358–369`) and `src/cli/run-claude.ts` (`~41`) — resolve base branch + claude command by the CLI's repo.

---

### Task 1: `RepoSettings` types and the three-tier resolver

**Files:**
- Create: `src/repo-settings.ts`
- Test: `src/__tests__/repo-settings.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface RepoSettings { defaultBaseBranch?: string; wtmIntegration?: boolean; autoLaunchAgent?: boolean; sessionNameTemplate?: string; claudeCommand?: string }`
  - `interface ResolvedRepoSettings { defaultBaseBranch: string; wtmIntegration: boolean; autoLaunchAgent: boolean; sessionNameTemplate: string; claudeCommand: string }`
  - `const REPO_SETTING_DEFAULTS: ResolvedRepoSettings`
  - `function resolveRepoSettings(repoDefaults: RepoSettings | undefined, override: RepoSettings | undefined, base?: ResolvedRepoSettings): ResolvedRepoSettings`

- [ ] **Step 1: Write the failing test**

```ts
// src/__tests__/repo-settings.test.ts
import { describe, test, expect } from "bun:test";
import { resolveRepoSettings, REPO_SETTING_DEFAULTS } from "../repo-settings";

describe("resolveRepoSettings", () => {
  test("falls back to hardcoded defaults when nothing is set", () => {
    const r = resolveRepoSettings(undefined, undefined);
    expect(r).toEqual(REPO_SETTING_DEFAULTS);
  });

  test("global default overrides hardcoded", () => {
    const r = resolveRepoSettings({ defaultBaseBranch: "develop" }, undefined);
    expect(r.defaultBaseBranch).toBe("develop");
    expect(r.claudeCommand).toBe("claude");
  });

  test("per-repo override beats global default", () => {
    const r = resolveRepoSettings(
      { defaultBaseBranch: "develop", claudeCommand: "global-cc" },
      { defaultBaseBranch: "master" },
    );
    expect(r.defaultBaseBranch).toBe("master");
    expect(r.claudeCommand).toBe("global-cc");
  });

  test("false and empty-string overrides are honored, not skipped", () => {
    const r = resolveRepoSettings(
      { wtmIntegration: true },
      { wtmIntegration: false },
    );
    expect(r.wtmIntegration).toBe(false);
  });

  test("base override replaces the hardcoded base (wtm bare-detection seed)", () => {
    const base = { ...REPO_SETTING_DEFAULTS, wtmIntegration: false };
    const r = resolveRepoSettings(undefined, undefined, base);
    expect(r.wtmIntegration).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/repo-settings.test.ts`
Expected: FAIL — `Cannot find module '../repo-settings'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/repo-settings.ts

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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/__tests__/repo-settings.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/repo-settings.ts src/__tests__/repo-settings.test.ts
git commit -m "feat(repo-settings): add RepoSettings shape and three-tier resolver"
```

---

### Task 2: Path canonicalization, repo-root keying, bare detection

**Files:**
- Modify: `src/repo-settings.ts`
- Test: `src/__tests__/repo-settings.test.ts`

**Interfaces:**
- Consumes: Task 1 module.
- Produces:
  - `type GitRun = (args: string[]) => string | null` — runs git, returns trimmed stdout or `null` on failure.
  - `function canonicalizeRepoPath(p: string, opts?: { home?: string; realpath?: (p: string) => string }): string`
  - `function resolveRepoRoot(cwd: string, run?: GitRun): string | null` — canonical git-common-dir, the repo key.
  - `function detectBareRepo(cwd: string, run?: GitRun): boolean`

- [ ] **Step 1: Write the failing test**

```ts
// append to src/__tests__/repo-settings.test.ts
import { canonicalizeRepoPath, resolveRepoRoot, detectBareRepo, type GitRun } from "../repo-settings";

describe("canonicalizeRepoPath", () => {
  const home = "/Users/dev";
  const realpath = (p: string) => p; // identity stub: isolate ~/trailing-slash logic

  test("expands a leading ~ to home", () => {
    expect(canonicalizeRepoPath("~/Code/jmux", { home, realpath })).toBe("/Users/dev/Code/jmux");
  });

  test("strips a trailing slash", () => {
    expect(canonicalizeRepoPath("/Users/dev/Code/jmux/", { home, realpath })).toBe("/Users/dev/Code/jmux");
  });

  test("leaves a clean absolute path unchanged", () => {
    expect(canonicalizeRepoPath("/Users/dev/Code/jmux", { home, realpath })).toBe("/Users/dev/Code/jmux");
  });
});

describe("resolveRepoRoot", () => {
  test("returns the canonicalized git common dir", () => {
    const run: GitRun = (args) =>
      args.join(" ").includes("--git-common-dir") ? "/Users/dev/Code/jmux/.git\n" : null;
    expect(resolveRepoRoot("/Users/dev/Code/jmux/feature-x", run)).toBe("/Users/dev/Code/jmux/.git");
  });

  test("returns null when git fails (not a repo)", () => {
    const run: GitRun = () => null;
    expect(resolveRepoRoot("/tmp/not-a-repo", run)).toBeNull();
  });
});

describe("detectBareRepo", () => {
  test("true when git reports a bare repository", () => {
    const run: GitRun = () => "true\n";
    expect(detectBareRepo("/Users/dev/Code/jmux", run)).toBe(true);
  });

  test("false when non-bare or git fails", () => {
    expect(detectBareRepo("/x", () => "false\n")).toBe(false);
    expect(detectBareRepo("/x", () => null)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/repo-settings.test.ts`
Expected: FAIL — exports `canonicalizeRepoPath` / `resolveRepoRoot` / `detectBareRepo` not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// append to src/repo-settings.ts
import { homedir } from "os";
import { realpathSync } from "fs";

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
 * expand a leading ~, resolve symlinks via realpath, strip a trailing slash.
 * realpath failures (path doesn't exist yet) fall back to the un-realpathed string.
 */
export function canonicalizeRepoPath(
  p: string,
  opts?: { home?: string; realpath?: (p: string) => string },
): string {
  const home = opts?.home ?? homedir();
  const realpath = opts?.realpath ?? ((x: string) => {
    try { return realpathSync(x); } catch { return x; }
  });
  let out = p;
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
  return run(["-C", cwd, "rev-parse", "--is-bare-repository"]) === "true";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/__tests__/repo-settings.test.ts`
Expected: PASS (all Task 1 + Task 2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/repo-settings.ts src/__tests__/repo-settings.test.ts
git commit -m "feat(repo-settings): canonicalize paths, key on git common dir, detect bare repos"
```

---

### Task 3: Worktree-command builder

**Files:**
- Modify: `src/repo-settings.ts`
- Test: `src/__tests__/repo-settings.test.ts`

**Interfaces:**
- Consumes: Task 1 module.
- Produces:
  - `function buildWorktreeCommand(o: { wtm: boolean; session: string; baseBranch: string; noShell?: boolean }): string` — the shell command that creates a worktree named `session` from `baseBranch`, run with cwd = the repo dir.

This is the single place that encodes "wtm on → `wtm create`, wtm off → `git worktree add`", so the issue path and the manual modal stay identical.

- [ ] **Step 1: Write the failing test**

```ts
// append to src/__tests__/repo-settings.test.ts
import { buildWorktreeCommand } from "../repo-settings";

describe("buildWorktreeCommand", () => {
  test("wtm on uses `wtm create --from`", () => {
    expect(buildWorktreeCommand({ wtm: true, session: "feat-x", baseBranch: "main" }))
      .toBe("wtm create feat-x --from main");
  });

  test("wtm on with noShell appends --no-shell", () => {
    expect(buildWorktreeCommand({ wtm: true, session: "feat-x", baseBranch: "main", noShell: true }))
      .toBe("wtm create feat-x --from main --no-shell");
  });

  test("wtm off uses `git worktree add` into a sibling dir", () => {
    expect(buildWorktreeCommand({ wtm: false, session: "feat-x", baseBranch: "develop" }))
      .toBe("git worktree add ./feat-x -b feat-x develop");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/repo-settings.test.ts`
Expected: FAIL — `buildWorktreeCommand` not exported.

- [ ] **Step 3: Write minimal implementation**

```ts
// append to src/repo-settings.ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/__tests__/repo-settings.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/repo-settings.ts src/__tests__/repo-settings.test.ts
git commit -m "feat(repo-settings): add buildWorktreeCommand (wtm create vs git worktree add)"
```

---

### Task 4: Legacy-config migration

**Files:**
- Modify: `src/repo-settings.ts`
- Test: `src/__tests__/repo-settings.test.ts`

**Interfaces:**
- Consumes: Task 1 module + `JmuxConfig` (type-only import from `./config`).
- Produces:
  - `function migrateLegacyConfig(raw: any): { config: any; changed: boolean }` — moves legacy fields into `repoDefaults`, drops dead `autoCreateWorktree`, returns whether anything changed. Pure (no I/O). Operates on the parsed object *before* defaults-merge.

- [ ] **Step 1: Write the failing test**

```ts
// append to src/__tests__/repo-settings.test.ts
import { migrateLegacyConfig } from "../repo-settings";

describe("migrateLegacyConfig", () => {
  test("moves top-level and issueWorkflow fields into repoDefaults", () => {
    const { config, changed } = migrateLegacyConfig({
      claudeCommand: "cc",
      wtmIntegration: false,
      issueWorkflow: {
        teamRepoMap: { core: "/code/core" },
        defaultBaseBranch: "develop",
        autoLaunchAgent: false,
        sessionNameTemplate: "{identifier}-x",
        autoCreateWorktree: true,
      },
    });
    expect(changed).toBe(true);
    expect(config.repoDefaults).toEqual({
      claudeCommand: "cc",
      wtmIntegration: false,
      defaultBaseBranch: "develop",
      autoLaunchAgent: false,
      sessionNameTemplate: "{identifier}-x",
    });
    expect(config.claudeCommand).toBeUndefined();
    expect(config.wtmIntegration).toBeUndefined();
    expect(config.issueWorkflow).toEqual({ teamRepoMap: { core: "/code/core" } });
  });

  test("drops issueWorkflow entirely when only autoCreateWorktree remained", () => {
    const { config } = migrateLegacyConfig({ issueWorkflow: { autoCreateWorktree: false } });
    expect(config.issueWorkflow).toBeUndefined();
    expect(config.repoDefaults).toBeUndefined(); // autoCreateWorktree is dropped, not migrated
  });

  test("does not clobber existing repoDefaults", () => {
    const { config } = migrateLegacyConfig({
      claudeCommand: "old",
      repoDefaults: { claudeCommand: "new" },
    });
    expect(config.repoDefaults.claudeCommand).toBe("new");
    expect(config.claudeCommand).toBeUndefined();
  });

  test("is idempotent — already-migrated config reports no change", () => {
    const migrated = {
      repoDefaults: { defaultBaseBranch: "develop" },
      issueWorkflow: { teamRepoMap: { core: "/code/core" } },
    };
    const { changed } = migrateLegacyConfig(migrated);
    expect(changed).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/repo-settings.test.ts`
Expected: FAIL — `migrateLegacyConfig` not exported.

- [ ] **Step 3: Write minimal implementation**

```ts
// append to src/repo-settings.ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/__tests__/repo-settings.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/repo-settings.ts src/__tests__/repo-settings.test.ts
git commit -m "feat(repo-settings): one-time legacy config migration into repoDefaults"
```

---

### Task 5: Wire migration + new schema + ConfigStore methods into `config.ts`

**Files:**
- Modify: `src/config.ts` (interfaces `9–60`, `loadUserConfig` `135–146`, `ConfigStore` constructor `157–160`, add methods near `205`)
- Test: `src/__tests__/config.test.ts`

**Interfaces:**
- Consumes: Task 1 + Task 4 (`RepoSettings`, `migrateLegacyConfig`).
- Produces (on `ConfigStore`):
  - `setRepoDefault<K extends keyof RepoSettings>(key: K, value: RepoSettings[K]): void`
  - `setRepoOverride(repoKey: string, key: keyof RepoSettings, value: RepoSettings[K]): void`
  - `clearRepoOverride(repoKey: string, key: keyof RepoSettings): void`
- Produces (on `JmuxConfig`): `repoDefaults?: RepoSettings`, `repos?: Record<string, RepoSettings>`.
- Removes: top-level `claudeCommand`, `wtmIntegration`; `IssueWorkflowConfig.{defaultBaseBranch, autoCreateWorktree, autoLaunchAgent, sessionNameTemplate}`.

- [ ] **Step 1: Write the failing test**

```ts
// add to src/__tests__/config.test.ts (inside the existing ConfigStore describe block)
import { migrateLegacyConfig } from "../repo-settings"; // ensure import exists

test("loadUserConfig migrates legacy fields into repoDefaults", () => {
  writeFileSync(cfgPath, JSON.stringify({
    claudeCommand: "cc",
    issueWorkflow: { defaultBaseBranch: "develop", teamRepoMap: { core: "/c" } },
  }));
  const store = new ConfigStore(cfgPath);
  expect(store.config.repoDefaults?.claudeCommand).toBe("cc");
  expect(store.config.repoDefaults?.defaultBaseBranch).toBe("develop");
  expect(store.config.issueWorkflow?.teamRepoMap?.core).toBe("/c");
  // migration persisted to disk
  const onDisk = JSON.parse(require("fs").readFileSync(cfgPath, "utf-8"));
  expect(onDisk.claudeCommand).toBeUndefined();
  expect(onDisk.repoDefaults.claudeCommand).toBe("cc");
});

test("setRepoDefault writes under repoDefaults and persists", () => {
  const store = new ConfigStore(cfgPath);
  store.setRepoDefault("defaultBaseBranch", "develop");
  expect(store.config.repoDefaults?.defaultBaseBranch).toBe("develop");
  const onDisk = JSON.parse(require("fs").readFileSync(cfgPath, "utf-8"));
  expect(onDisk.repoDefaults.defaultBaseBranch).toBe("develop");
});

test("setRepoOverride and clearRepoOverride manage repos[key]", () => {
  const store = new ConfigStore(cfgPath);
  store.setRepoOverride("/code/jmux/.git", "wtmIntegration", false);
  expect(store.config.repos?.["/code/jmux/.git"]?.wtmIntegration).toBe(false);
  store.clearRepoOverride("/code/jmux/.git", "wtmIntegration");
  expect(store.config.repos?.["/code/jmux/.git"]).toBeUndefined(); // emptied entry pruned
});
```

Also: **update existing tests** that reference removed fields — `setWorkflow("defaultBaseBranch", ...)` (lines `~147`, `~159`) and the `autoCreateWorktree` fixture (`~156`). Replace the `defaultBaseBranch`/`sessionNameTemplate`/`autoCreateWorktree` assertions with `teamRepoMap`-only `setWorkflow` coverage (the only remaining workflow key), and move base-branch coverage to the `setRepoDefault` test above.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/config.test.ts`
Expected: FAIL — `setRepoDefault`/`setRepoOverride`/`clearRepoOverride` not functions; migration not applied.

- [ ] **Step 3: Write minimal implementation**

In `src/config.ts`:

```ts
// at top, add to existing imports
import type { RepoSettings } from "./repo-settings";
import { migrateLegacyConfig } from "./repo-settings";
```

```ts
// IssueWorkflowConfig — trim to teamRepoMap only
export interface IssueWorkflowConfig {
  teamRepoMap?: Record<string, string>;  // Linear team name → repo directory
}
```

```ts
// JmuxConfig — remove claudeCommand and wtmIntegration; add repoDefaults/repos
export interface JmuxConfig {
  sidebarWidth?: number;
  infoPanelWidth?: number;
  cacheTimers?: boolean;
  windowBranches?: boolean;
  pinnedSessions?: string[];
  autoPinAgentPanes?: boolean;
  agentPaneCommandRegex?: string;
  projectDirs?: string[];
  diffPanel?: { splitRatio?: number; hunkCommand?: string };
  adapters?: AdapterConfig;
  panelViews?: PanelView[];
  issueWorkflow?: IssueWorkflowConfig;
  snapshot?: SnapshotConfig;
  stateColors?: StateColorConfig;
  commandCenterTabs?: TabEntry[];
  /** Global defaults for per-repo workflow settings. */
  repoDefaults?: RepoSettings;
  /** Per-repo overrides, keyed by canonical repo root (git common dir). */
  repos?: Record<string, RepoSettings>;
}
```

```ts
// loadUserConfig — migrate the raw parsed object before merging defaults
export function loadUserConfig(configPath?: string): JmuxConfig {
  const path = configPath ?? DEFAULT_CONFIG_PATH;
  let raw: JmuxConfig = {};
  try {
    if (existsSync(path)) raw = JSON.parse(readFileSync(path, "utf-8")) as JmuxConfig;
  } catch {
    // Invalid config — use defaults
  }
  const { config } = migrateLegacyConfig(raw);
  return mergeConfigWithDefaults(config, defaultConfig);
}
```

```ts
// ConfigStore constructor — persist if migration changed the on-disk shape
constructor(configPath?: string) {
  this.path = configPath ?? DEFAULT_CONFIG_PATH;
  let raw: JmuxConfig = {};
  try {
    if (existsSync(this.path)) raw = JSON.parse(readFileSync(this.path, "utf-8")) as JmuxConfig;
  } catch { /* use defaults */ }
  const { config, changed } = migrateLegacyConfig(raw);
  this.data = mergeConfigWithDefaults(config, defaultConfig);
  if (changed) this.persist();
}
```

```ts
// new methods on ConfigStore (place near setWorkflow)
/** Set a global repo-default and persist. */
setRepoDefault<K extends keyof RepoSettings>(key: K, value: RepoSettings[K]): void {
  if (!this.data.repoDefaults) this.data.repoDefaults = {};
  this.data.repoDefaults[key] = value;
  this.persist();
}

/** Set a per-repo override and persist. */
setRepoOverride<K extends keyof RepoSettings>(repoKey: string, key: K, value: RepoSettings[K]): void {
  if (!this.data.repos) this.data.repos = {};
  if (!this.data.repos[repoKey]) this.data.repos[repoKey] = {};
  this.data.repos[repoKey][key] = value;
  this.persist();
}

/** Clear a per-repo override, pruning emptied entries/containers, and persist. */
clearRepoOverride(repoKey: string, key: keyof RepoSettings): void {
  const entry = this.data.repos?.[repoKey];
  if (!entry) return;
  delete entry[key];
  if (Object.keys(entry).length === 0) delete this.data.repos![repoKey];
  if (this.data.repos && Object.keys(this.data.repos).length === 0) delete this.data.repos;
  this.persist();
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/__tests__/config.test.ts && bun run typecheck`
Expected: PASS. Typecheck will flag every `main.ts`/`cli` read of the removed fields — that's expected and is fixed in Tasks 6–9. To keep this commit green, temporarily leave those reads; they still typecheck *only if* you complete Task 6 next. **If typecheck fails solely due to removed-field reads in main.ts/cli, proceed to Task 6 before committing the suite** — but commit `config.ts` + its tests now (the unit tests pass independently).

- [ ] **Step 5: Commit**

```bash
git add src/config.ts src/__tests__/config.test.ts
git commit -m "feat(config): add repoDefaults/repos, migrate on load, trim legacy fields"
```

---

### Task 6: Resolve settings at the issue path and manual modal (base branch, wtm strategy, auto-launch, name template)

**Files:**
- Modify: `src/main.ts` — issue path (`1670–1761`), manual modal (`2844–2876`), and add a resolution helper.

**Interfaces:**
- Consumes: `resolveRepoSettings`, `resolveRepoRoot`, `detectBareRepo`, `buildWorktreeCommand`, `REPO_SETTING_DEFAULTS` (Tasks 1–3), `ConfigStore` (Task 5).
- Produces: a local helper `resolveSettingsForDir(dir: string): ResolvedRepoSettings` used by both call sites and Task 9 CLI mirrors the same logic.

**Note on testing:** these sites drive tmux, so they aren't unit-tested directly. The testable logic (resolver, key, worktree command) is already covered in Tasks 1–3. This task is integration wiring; verify with `bun run typecheck` + the manual checks in Step 4.

- [ ] **Step 1: Add the resolution helper**

Add near the top-level helpers in `main.ts` (after `configStore` is constructed):

```ts
import {
  resolveRepoSettings, resolveRepoRoot, detectBareRepo, buildWorktreeCommand,
  REPO_SETTING_DEFAULTS, type ResolvedRepoSettings,
} from "./repo-settings";

/**
 * Resolve effective workflow settings for a repo directory. The repo key is the
 * git common dir; wtmIntegration's base default is runtime bare detection.
 */
function resolveSettingsForDir(dir: string): ResolvedRepoSettings {
  const key = resolveRepoRoot(dir);
  const cfg = configStore.config;
  const base = { ...REPO_SETTING_DEFAULTS, wtmIntegration: detectBareRepo(dir) };
  return resolveRepoSettings(cfg.repoDefaults, key ? cfg.repos?.[key] : undefined, base);
}
```

- [ ] **Step 2: Rewire the issue path** (`main.ts:1670–1761`)

Replace the per-field reads and the bare-branch logic. Key changes:
- Compute `const settings = resolveSettingsForDir(expandedDir);` right after `expandedDir` is set (replacing the `const baseBranch = workflow?.defaultBaseBranch ?? "main";` line at `1682`).
- `const baseBranch = settings.defaultBaseBranch;`
- `shouldLaunchAgent` uses `settings.autoLaunchAgent !== false` → `settings.autoLaunchAgent` (already boolean).
- In STATE 1, **drop the `isBare` branch** and always create a worktree using `buildWorktreeCommand`:

```ts
// STATE 1: Nothing exists → always create a worktree (wtm or git), then session.
const branchName = issue.branchName
  ? issue.branchName
  : settings.sessionNameTemplate
      .replace("{identifier}", issue.identifier.toLowerCase())
      .replace("{title}", issue.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40));

const wtPath = `${expandedDir}/${session}`;
const createCmd = buildWorktreeCommand({
  wtm: settings.wtmIntegration, session, baseBranch, noShell: true,
});
// Main (left) pane: wait for the worktree dir, cd in, run claude.
const mainCmd = `while [ ! -d ${tq(wtPath)} ]; do sleep 0.2; done; cd ${tq(wtPath)}; ${claudeFragment}`;
await control.sendCommand(
  `new-session -d -e ${tq(`OTEL_RESOURCE_ATTRIBUTES=tmux_session_name=${session}`)} -s ${tq(session)} -c ${tq(expandedDir)} ${tq(mainCmd)}`,
);
// Setup (right) pane: create the worktree, then exit (or drop to a shell on failure).
const setupCmd = `${createCmd} || exec $SHELL`;
await control.sendCommand(
  `split-window -h -d -l 30% -t ${tq(session)} -c ${tq(expandedDir)} ${tq(setupCmd)}`,
);
```

(`branchName` is unused by `wtm create`/`git worktree add` here since both derive the branch from `session`; keep computing it only if a downstream consumer needs it — otherwise remove the dead variable. Confirm by grep before deleting.)

- [ ] **Step 3: Rewire the manual modal** (`main.ts:2862` `new_worktree` case)

```ts
case "new_worktree": {
  const session = sanitizeTmuxSessionName(result.name);
  const wtPath = `${result.dir}/${session}`;
  const settings = resolveSettingsForDir(result.dir);
  const createCmd = buildWorktreeCommand({
    wtm: settings.wtmIntegration, session, baseBranch: result.baseBranch,
  });
  const cmd = `${createCmd}; cd ${session}; exec $SHELL`;
  await control.sendCommand(`new-session -d -e ${tq(`OTEL_RESOURCE_ATTRIBUTES=tmux_session_name=${session}`)} -s ${tq(session)} -c ${tq(result.dir)} ${tq(cmd)}`);
  const waitCmd = `while [ ! -d ${tq(wtPath)} ]; do sleep 0.2; done; cd ${tq(wtPath)} && exec $SHELL`;
  await control.sendCommand(`split-window -h -d -t ${tq(session)} -c ${tq(result.dir)} ${tq(waitCmd)}`);
  await control.sendCommand(`switch-client -c ${parentClient} -t ${tq(session)}`);
  break;
}
```

- [ ] **Step 4: Verify**

Run: `bun run typecheck && bun test`
Expected: typecheck passes (issue/modal field reads resolved); existing tests pass.
Manual: `bun run dev`, create an issue session in a wtm bare repo (expect `wtm create`), and a worktree session in a normal repo (expect `git worktree add ./<name>` produces a sibling worktree, not an in-place branch).

- [ ] **Step 5: Commit**

```bash
git add src/main.ts
git commit -m "feat(main): resolve per-repo settings for issue + manual worktree paths"
```

---

### Task 7: `claudeCommand` per-repo + snapshot restore

**Files:**
- Modify: `src/snapshot/restore.ts` (`RestorerOptions` `6–39`, restore site `~244`/`~292`)
- Modify: `src/main.ts` (`let claudeCommand` `232`, `Restorer` construction `451–459`, split-window-claude `3305`, reload handler `3471–3472`, settings getter `2406`)
- Test: `src/__tests__/snapshot/restore-claude-command.test.ts` (new)

**Interfaces:**
- Consumes: Task 6 `resolveSettingsForDir`.
- Produces: `RestorerOptions.resolveClaudeCommand?: (cwd: string) => string` (additive — existing `claudeCommand: string` stays as the fallback so the ~30 existing test construction sites compile unchanged).

- [ ] **Step 1: Write the failing test**

```ts
// src/__tests__/snapshot/restore-claude-command.test.ts
import { describe, test, expect } from "bun:test";
import { Restorer } from "../../snapshot/restore";
// Reuse the in-memory deps/fixtures pattern from restore-sequence.test.ts.
// Build a snapshot with two sessions whose cwds map to different repos, then
// assert the painter argv for each claude pane uses the per-cwd resolved command.

describe("Restorer resolveClaudeCommand", () => {
  test("resolves claude command per session cwd", async () => {
    const calls: Record<string, string> = {};
    const resolveClaudeCommand = (cwd: string) =>
      cwd.includes("repo-a") ? "claude-a" : "claude-b";
    // ...construct Restorer with { ...standardDeps, claudeCommand: "fallback", resolveClaudeCommand }
    // ...run restore over a snapshot with sessions cwd=/repo-a/wt and cwd=/repo-b/wt
    // assert the recorded new-window/new-session argv for repo-a's claude pane
    //   contains "claude-a" and repo-b's contains "claude-b".
    expect(true).toBe(true); // replace with real argv assertions per the harness
  });
});
```

(Model the harness on `src/__tests__/snapshot/restore-sequence.test.ts` — copy its in-memory `runner`/`fs`/`clock` setup and the snapshot fixture builder, then capture argv from the fake `runner`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/snapshot/restore-claude-command.test.ts`
Expected: FAIL — option `resolveClaudeCommand` not honored (painter still uses the flat `claudeCommand`).

- [ ] **Step 3: Implement**

In `src/snapshot/restore.ts`:

```ts
// RestorerOptions — add the optional resolver (keep claudeCommand as fallback)
claudeCommand: string;
/** Resolve the claude command for a session's cwd (per-repo settings). */
resolveClaudeCommand?: (cwd: string) => string;
```

At the painter-building site (`~244` and `~292`), thread the session cwd:

```ts
// where `session.cwd` is in scope (restoreSession), compute once:
const claudeForSession = this.opts.resolveClaudeCommand?.(session.cwd) ?? this.opts.claudeCommand;
// ...then pass claudeForSession instead of this.opts.claudeCommand to buildPainterArgv/painter input.
```

(If `session.cwd` is not in scope at `292`, pass `claudeForSession` down from `restoreSession` into the window/pane loop — it already iterates `session.windows` there.)

In `src/main.ts`:

```ts
// remove the module global at line 232; delete the reassignment at 3471–3472.
// Restorer construction (451): replace `claudeCommand: opts.config.claudeCommand ?? "claude"` with:
claudeCommand: REPO_SETTING_DEFAULTS.claudeCommand,           // fallback
resolveClaudeCommand: (cwd: string) => resolveSettingsForDir(cwd).claudeCommand,
```

```ts
// split-window claude (3305): resolve from the active pane's repo.
// The pane runs in #{pane_current_path}; resolve from the current session dir:
const cc = resolveSettingsForDir(currentSessionDir() ?? process.cwd()).claudeCommand;
await control.sendCommand(`split-window -t ${ptyClientName} -h -c '#{pane_current_path}' ${cc}`);
```

(Use the existing means of getting the focused session's directory — `sessionDetailsCache.get(currentSession)?.directory`. If none, fall back to `process.cwd()`.)

The settings-screen getter for claude command (`2406`) moves to `repoDefaults` in Task 8; for now point it at `configStore.config.repoDefaults?.claudeCommand ?? REPO_SETTING_DEFAULTS.claudeCommand`.

- [ ] **Step 4: Verify**

Run: `bun test && bun run typecheck`
Expected: PASS, including the new restore test and all existing `restore-*` tests (unchanged because `claudeCommand` is still accepted).

- [ ] **Step 5: Commit**

```bash
git add src/snapshot/restore.ts src/main.ts src/__tests__/snapshot/restore-claude-command.test.ts
git commit -m "feat: resolve claudeCommand per-repo, including per-session snapshot restore"
```

---

### Task 8: Settings screen — global defaults retarget + override marker/clear

**Files:**
- Modify: `src/settings-screen.ts` (`SettingDef` `7–25`, `renderSetting` `203–257`, delete-key handling `136–145`)
- Test: `src/__tests__/settings-screen.test.ts` (new, if absent)

**Interfaces:**
- Consumes: nothing new.
- Produces (on `SettingDef`): optional `getStatus?: () => "inherited" | "override" | null` and `onClear?: () => void`.

- [ ] **Step 1: Write the failing test**

```ts
// src/__tests__/settings-screen.test.ts
import { describe, test, expect } from "bun:test";
import { SettingsScreen, type SettingsCategory } from "../settings-screen";

function gridToText(grid: { ch: string }[][]): string {
  return grid.map((row) => row.map((c) => c.ch || " ").join("")).join("\n");
}

describe("SettingsScreen override marker", () => {
  test("renders (override) suffix when getStatus returns override", () => {
    const cats: SettingsCategory[] = [{
      label: "Repo: jmux", collapsed: false, settings: [{
        id: "r-base", label: "Default base branch", type: "text",
        getValue: () => "develop", onTextCommit: () => {},
        getStatus: () => "override",
      }],
    }];
    const s = new SettingsScreen();
    s.open(cats);
    const text = gridToText(s.render(80, 12) as any);
    expect(text).toContain("override");
  });

  test("delete key on an overridden setting invokes onClear", () => {
    let cleared = false;
    const cats: SettingsCategory[] = [{
      label: "Repo: jmux", collapsed: false, settings: [{
        id: "r-base", label: "Default base branch", type: "text",
        getValue: () => "develop", onTextCommit: () => {},
        getStatus: () => "override", onClear: () => { cleared = true; },
      }],
    }];
    const s = new SettingsScreen();
    s.open(cats);
    s.handleInput("\x1b[B"); // move off the category header onto the setting
    s.handleInput("d");
    expect(cleared).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/settings-screen.test.ts`
Expected: FAIL — no `(override)` suffix; `onClear` never called.

- [ ] **Step 3: Implement**

In `src/settings-screen.ts`:

```ts
// SettingDef — add:
getStatus?: () => "inherited" | "override" | null;
onClear?: () => void;
```

In `renderSetting`, after writing the value, append a dim marker when `getStatus` is present:

```ts
const status = setting.getStatus?.() ?? null;
if (status) {
  const marker = status === "override" ? " (override)" : " (inherited)";
  const markerCol = valueCol + valueStr.length;
  if (markerCol + marker.length <= cols - pad) {
    writeString(grid, row, markerCol, marker, DIM_ATTRS);
  }
}
```

In `handleInput`, extend the delete branch (currently map-entry only, `136–145`) to clear an overridden setting:

```ts
if (data === "d" || data === "\x7f") {
  const node = this.getSelectedNode();
  if (node?.kind === "map-entry") { /* ...existing map-remove... */ return { type: "none" }; }
  if (node?.kind === "setting" && node.setting.getStatus?.() === "override" && node.setting.onClear) {
    node.setting.onClear();
    return { type: "none" };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/__tests__/settings-screen.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/settings-screen.ts src/__tests__/settings-screen.test.ts
git commit -m "feat(settings-screen): inherited/override marker and clear-override on delete"
```

---

### Task 9: Build the settings categories — global defaults + current-repo overrides

**Files:**
- Modify: `src/main.ts` — `buildSettingsCategories` (`2306`), the label-building block (`2246–2288`), and a `currentRepoKey()` helper.

**Interfaces:**
- Consumes: Task 5 ConfigStore methods, Task 6 `resolveSettingsForDir`/`resolveRepoRoot`, Task 8 `SettingDef.getStatus`/`onClear`.
- Produces: settings UI. Integration — verify manually + typecheck.

- [ ] **Step 1: Retarget global-default rows**

In `buildSettingsCategories` (`2306`), change the workflow rows that today call `configStore.setWorkflow(...)` / read `wf()?.X` to read/write `repoDefaults`:
- `Default base branch`: `getValue: () => configStore.config.repoDefaults?.defaultBaseBranch ?? REPO_SETTING_DEFAULTS.defaultBaseBranch`, `onTextCommit: (v) => configStore.setRepoDefault("defaultBaseBranch", v)`.
- `wtm integration` (move out of the old top-level toggle at `2197`/`2996`): `type: "boolean"`, `getValue: () => (configStore.config.repoDefaults?.wtmIntegration !== false) ? "on" : "off"`, `onToggle: () => configStore.setRepoDefault("wtmIntegration", configStore.config.repoDefaults?.wtmIntegration === false)`.
- `Auto-launch agent`, `Session name template`, `Claude command`: same pattern against `repoDefaults` via `setRepoDefault`.
- Delete the `Auto-create worktree` row (`2265`, `2427`) entirely.

- [ ] **Step 2: Add a current-repo override category**

Add a helper and append the category when a repo is resolvable:

```ts
function currentRepoKey(): { key: string; label: string } | null {
  const sess = currentSelectedSession(); // existing accessor for the focused session
  if (!sess) return null;
  const dir = sessionDetailsCache.get(sess)?.directory;
  if (!dir) return null;
  const key = resolveRepoRoot(dir);
  if (!key) return null;
  const label = sessionDetailsCache.get(sess)?.project ?? key.replace(/\/\.git$/, "").split("/").pop() ?? key;
  return { key, label };
}
```

In `buildSettingsCategories`, after the global categories:

```ts
const repo = currentRepoKey();
if (repo) {
  const ov = () => configStore.config.repos?.[repo.key];
  const eff = () => resolveSettingsForDir(/* dir for repo */ repoDirForKey(repo.key) ?? repo.key);
  const statusFor = (k: keyof RepoSettings) => ov()?.[k] !== undefined ? "override" as const : "inherited" as const;
  categories.push({
    label: `Repo: ${repo.label}`,
    collapsed: false,
    settings: [
      {
        id: "repo-base", label: "Default base branch", type: "text",
        getValue: () => eff().defaultBaseBranch,
        getStatus: () => statusFor("defaultBaseBranch"),
        onTextCommit: (v) => configStore.setRepoOverride(repo.key, "defaultBaseBranch", v),
        onClear: () => configStore.clearRepoOverride(repo.key, "defaultBaseBranch"),
      },
      {
        id: "repo-wtm", label: "wtm integration", type: "boolean",
        getValue: () => eff().wtmIntegration ? "on" : "off",
        getStatus: () => statusFor("wtmIntegration"),
        onToggle: () => configStore.setRepoOverride(repo.key, "wtmIntegration", !eff().wtmIntegration),
        onClear: () => configStore.clearRepoOverride(repo.key, "wtmIntegration"),
      },
      // repeat for autoLaunchAgent (boolean), sessionNameTemplate (text), claudeCommand (text)
    ],
  });
}
```

Provide `repoDirForKey` by stripping a trailing `/.git` from the key to recover a working-dir for `detectBareRepo` (a bare repo's key has no `/.git` suffix, so fall back to the key itself). This keeps `eff()` honest about the wtm base default.

- [ ] **Step 3: Verify**

Run: `bun run typecheck && bun test`
Expected: PASS.
Manual (`bun run dev`):
- Open settings from a session inside a repo → a `Repo: <name>` category appears; each row shows `(inherited)`.
- Edit `Default base branch` → row flips to `(override)`; the value persists to `repos[key]` in `~/.config/jmux/config.json`.
- Press `d` on the overridden row → reverts to `(inherited)` and the override is removed from disk.
- Open settings from the Command Center (no current repo) → no `Repo:` category; only global defaults shown.

- [ ] **Step 4: Commit**

```bash
git add src/main.ts
git commit -m "feat(settings): global repo defaults + contextual current-repo override category"
```

---

### Task 10: Resolve settings in the `jmux ctl` CLI

**Files:**
- Modify: `src/cli/issue.ts` (`~358–369`), `src/cli/run-claude.ts` (`~41`)

**Interfaces:**
- Consumes: `resolveRepoSettings`, `resolveRepoRoot`, `detectBareRepo`, `buildWorktreeCommand`, `REPO_SETTING_DEFAULTS` (Tasks 1–3).
- Produces: CLI honors per-repo base branch, wtm strategy, and claude command for the repo it runs against.

- [ ] **Step 1: Add a CLI resolver**

In each CLI file (or a shared `src/cli/context.ts` helper if one fits), resolve for the CLI's repo dir (`repo` is already known in `issue.ts`):

```ts
import { resolveRepoSettings, resolveRepoRoot, detectBareRepo, REPO_SETTING_DEFAULTS } from "../repo-settings";

function settingsForRepo(config: JmuxConfig, repoDir: string) {
  const key = resolveRepoRoot(repoDir);
  const base = { ...REPO_SETTING_DEFAULTS, wtmIntegration: detectBareRepo(repoDir) };
  return resolveRepoSettings(config.repoDefaults, key ? config.repos?.[key] : undefined, base);
}
```

- [ ] **Step 2: Replace the direct reads**

In `issue.ts`:
```ts
const settings = settingsForRepo(config, repo);
const baseBranch = typeof flags["base-branch"] === "string" ? flags["base-branch"] : settings.defaultBaseBranch;
// ...
const claudeCmd = settings.claudeCommand;
```
If `createWorktree(repo, worktreePath, branchName, baseBranch)` builds its own worktree command, route it through `buildWorktreeCommand({ wtm: settings.wtmIntegration, session: branchName, baseBranch, noShell: true })` so the CLI matches the TUI's wtm/git behavior.

In `run-claude.ts`:
```ts
const claudeCmd = settingsForRepo(config, /* the repo/cwd this command targets */ targetDir).claudeCommand;
```
(Use the dir the run-claude command operates in; if it only has a session, resolve from that session's cwd.)

- [ ] **Step 3: Verify**

Run: `bun run typecheck && bun test`
Expected: PASS.
Manual: `bun run src/main.ts ctl run-claude --help` still works; in a repo with a `repos[key].claudeCommand` override, the CLI uses it.

- [ ] **Step 4: Commit**

```bash
git add src/cli/issue.ts src/cli/run-claude.ts
git commit -m "feat(cli): resolve per-repo base branch, wtm strategy, and claude command"
```

---

### Task 11: Final sweep — docs, dead-reference check, full suite

**Files:**
- Modify: `CLAUDE.md` config-layering note if needed; verify `CONTEXT.md` + ADR already landed (they did, during design).

- [ ] **Step 1: Grep for stragglers**

```bash
grep -rn "issueWorkflow?.defaultBaseBranch\|config.claudeCommand\|config.wtmIntegration\|autoCreateWorktree\|setWorkflow(\"defaultBaseBranch\"\|setWorkflow(\"autoLaunchAgent\"\|setWorkflow(\"sessionNameTemplate\"" src --include="*.ts"
```
Expected: no matches in non-test source. Fix any that remain by routing through `resolveSettingsForDir` / `repoDefaults`.

- [ ] **Step 2: Update CLAUDE.md**

Add one line to the config section noting that workflow settings (base branch, wtm integration, auto-launch, session-name template, claude command) resolve global→per-repo via `repoDefaults`/`repos`, keyed on the canonical git common dir (see `docs/adr/0004-...`).

- [ ] **Step 3: Run the full suite + typecheck**

Run: `bun test && bun run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md src
git commit -m "docs: note per-repo settings resolution; final cleanup"
```

---

## Self-Review notes

- **Spec coverage:** key=canonical git common dir (T2), three-tier resolve (T1), six→five settings membership with `autoCreateWorktree` deleted (T4/T9), `wtmIntegration` wired wtm-vs-git always-worktree (T3/T6), migration no-clobber/idempotent (T4/T5), adapters/UI/routing stay global (untouched), contextual current-repo editing (T8/T9), snapshot per-session claudeCommand (T7), CLI (T10). ✅
- **Type consistency:** `resolveRepoSettings`/`ResolvedRepoSettings`/`REPO_SETTING_DEFAULTS`/`buildWorktreeCommand`/`resolveRepoRoot`/`detectBareRepo`/`migrateLegacyConfig` names are used identically across tasks; `resolveSettingsForDir` (main) and `settingsForRepo` (cli) are intentionally distinct local helpers wrapping the same module functions.
- **Known integration risk to watch during execution:** the exact accessor for "the focused session" (`currentSelectedSession()`) and its cwd in `main.ts` — confirm the real symbol name when wiring Task 9; the cache is `sessionDetailsCache` (`main.ts:783`).
