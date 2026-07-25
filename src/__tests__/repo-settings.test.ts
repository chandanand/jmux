import { describe, test, expect } from "bun:test";
import {
  resolveRepoSettings,
  REPO_SETTING_DEFAULTS,
  canonicalizeRepoPath,
  resolveRepoRoot,
  detectBareRepo,
  buildWorktreeCommand,
  migrateLegacyConfig,
  RepoFactsCache,
  resolveForRepo,
  type GitRun,
} from "../repo-settings";

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

describe("RepoFactsCache", () => {
  test("resolves key and bare flag, then serves from cache", () => {
    let calls = 0;
    const run: GitRun = (args) => {
      calls++;
      if (args.includes("--git-common-dir")) return "/code/jmux/.git\n";
      if (args.includes("--is-bare-repository")) return "true\n";
      return null;
    };
    const cache = new RepoFactsCache(run);
    expect(cache.get("/code/jmux/feat-x")).toEqual({ key: "/code/jmux/.git", bare: true });
    const after = calls;
    expect(cache.get("/code/jmux/feat-x")).toEqual({ key: "/code/jmux/.git", bare: true });
    expect(calls).toBe(after); // second lookup hits the cache
  });

  test("non-repo dirs resolve to a null key and are not bare", () => {
    const cache = new RepoFactsCache(() => null);
    expect(cache.get("/tmp/x")).toEqual({ key: null, bare: false });
  });
});

describe("resolveForRepo", () => {
  const facts = { key: "/code/jmux/.git", bare: false };

  test("per-repo override beats global default beats bare-seeded base", () => {
    const r = resolveForRepo(
      {
        repoDefaults: { defaultBaseBranch: "develop" },
        repos: { "/code/jmux/.git": { defaultBaseBranch: "master" } },
      },
      facts,
    );
    expect(r.defaultBaseBranch).toBe("master");
  });

  test("wtmIntegration base default is the runtime bare detection", () => {
    expect(resolveForRepo({}, { key: "/x", bare: true }).wtmIntegration).toBe(true);
    expect(resolveForRepo({}, { key: "/x", bare: false }).wtmIntegration).toBe(false);
  });

  test("an explicit setting still beats bare detection", () => {
    const r = resolveForRepo({ repoDefaults: { wtmIntegration: true } }, { key: "/x", bare: false });
    expect(r.wtmIntegration).toBe(true);
  });

  test("a null key (not a repo) falls back to global defaults", () => {
    const r = resolveForRepo(
      { repoDefaults: { defaultBaseBranch: "develop" }, repos: { "/other/.git": { defaultBaseBranch: "zzz" } } },
      { key: null, bare: false },
    );
    expect(r.defaultBaseBranch).toBe("develop");
  });
});
