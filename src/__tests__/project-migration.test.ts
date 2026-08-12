import { describe, test, expect } from "bun:test";
import { migrateToProjects, type LegacyShape } from "../project-migration";

// The migration joins two key spaces that were never the same: teamRepoMap
// values are *operational* paths, repos[key] keys are git common dirs. The
// resolver maps a dir to its common dir so they can be matched.
function resolver(map: Record<string, string>) {
  return (dir: string) => map[dir] ?? null;
}

describe("migrateToProjects", () => {
  test("does nothing when there is nothing legacy to migrate", () => {
    const r = migrateToProjects({}, resolver({}));
    expect(r.changed).toBe(false);
    expect(r.projects).toEqual([]);
  });

  test("a teamRepoMap entry becomes a Project holding the team by name", () => {
    const legacy: LegacyShape = {
      issueWorkflow: { teamRepoMap: { "Core Engineering": "/code/api" } },
    };
    const r = migrateToProjects(legacy, resolver({ "/code/api": "/code/api/.git" }));
    expect(r.changed).toBe(true);
    expect(r.projects).toHaveLength(1);
    expect(r.projects[0].dir).toBe("/code/api");
    expect(r.projects[0].legacyTeamName).toBe("Core Engineering");
    // Not a team id: the name has not been resolved yet, and treating it as one
    // would route on the ambiguous key this field exists to leave behind.
    expect(r.projects[0].teamId).toBeUndefined();
  });

  test("the Project is titled from the repo directory's basename", () => {
    const legacy: LegacyShape = {
      issueWorkflow: { teamRepoMap: { Core: "/code/payments" } },
    };
    const r = migrateToProjects(legacy, resolver({}));
    expect(r.projects[0].title).toBe("payments");
    expect(r.projects[0].id).toBe("payments");
  });

  test("a repos[key] entry with no team becomes its own teamless Project", () => {
    const legacy: LegacyShape = {
      repos: { "/code/solo/.git": { claudeCommand: "codex" } },
    };
    const r = migrateToProjects(legacy, resolver({}));
    expect(r.projects).toHaveLength(1);
    expect(r.projects[0].teamId).toBeUndefined();
    expect(r.projects[0].legacyTeamName).toBeUndefined();
    expect(r.projects[0].settings?.agentCommand).toBe("codex");
  });

  test("a repos[key] override lands on the Project whose dir resolves to that key", () => {
    const legacy: LegacyShape = {
      issueWorkflow: { teamRepoMap: { Core: "/code/api" } },
      repos: { "/code/api/.git": { defaultBaseBranch: "develop" } },
    };
    const r = migrateToProjects(legacy, resolver({ "/code/api": "/code/api/.git" }));
    expect(r.projects).toHaveLength(1);
    expect(r.projects[0].settings?.defaultBaseBranch).toBe("develop");
  });

  // A monorepo serving two teams is two Projects on one dir, and the legacy
  // override was a property of the *repo*, so it applies to both.
  test("a shared dir fans one legacy override out to every Project on it", () => {
    const legacy: LegacyShape = {
      issueWorkflow: { teamRepoMap: { Core: "/code/mono", Web: "/code/mono" } },
      repos: { "/code/mono/.git": { wtmIntegration: false } },
    };
    const r = migrateToProjects(legacy, resolver({ "/code/mono": "/code/mono/.git" }));
    expect(r.projects).toHaveLength(2);
    for (const p of r.projects) expect(p.settings?.wtmIntegration).toBe(false);
  });

  test("two teams on one dir get distinct ids rather than merging", () => {
    const legacy: LegacyShape = {
      issueWorkflow: { teamRepoMap: { Core: "/code/mono", Web: "/code/mono" } },
    };
    const r = migrateToProjects(legacy, resolver({}));
    const ids = r.projects.map((p) => p.id);
    expect(new Set(ids).size).toBe(2);
  });

  test("claudeCommand is renamed to agentCommand", () => {
    const legacy: LegacyShape = {
      repos: { "/code/x/.git": { claudeCommand: "cc" } },
    };
    const r = migrateToProjects(legacy, resolver({}));
    expect(r.projects[0].settings?.agentCommand).toBe("cc");
    expect((r.projects[0].settings as Record<string, unknown>).claudeCommand).toBeUndefined();
  });

  // Provenance: an override equal to the global is still an override.
  test("a legacy override equal to the global default is still copied", () => {
    const legacy: LegacyShape = {
      repoDefaults: { claudeCommand: "codex" },
      repos: { "/code/x/.git": { claudeCommand: "codex" } },
    };
    const r = migrateToProjects(legacy, resolver({}));
    expect(r.projects[0].settings).toHaveProperty("agentCommand");
    expect(r.projects[0].settings?.agentCommand).toBe("codex");
  });

  test("repoDefaults are not copied into Projects — they stay the global tier", () => {
    const legacy: LegacyShape = {
      repoDefaults: { claudeCommand: "codex" },
      issueWorkflow: { teamRepoMap: { Core: "/code/api" } },
    };
    const r = migrateToProjects(legacy, resolver({}));
    expect(r.projects[0].settings ?? {}).toEqual({});
    expect(r.globalDefaults?.agentCommand).toBe("codex");
  });

  test("a repos[key] matching no project dir becomes its own Project rather than being dropped", () => {
    const legacy: LegacyShape = {
      issueWorkflow: { teamRepoMap: { Core: "/code/api" } },
      repos: { "/code/unrelated/.git": { autoLaunchAgent: false } },
    };
    const r = migrateToProjects(legacy, resolver({ "/code/api": "/code/api/.git" }));
    expect(r.projects).toHaveLength(2);
    const orphan = r.projects.find((p) => p.settings?.autoLaunchAgent === false);
    expect(orphan).toBeDefined();
  });

  test("is idempotent — running it on its own output changes nothing", () => {
    const legacy: LegacyShape = {
      issueWorkflow: { teamRepoMap: { Core: "/code/api" } },
      repos: { "/code/api/.git": { claudeCommand: "cc" } },
      repoDefaults: { autoLaunchAgent: false },
    };
    const once = migrateToProjects(legacy, resolver({ "/code/api": "/code/api/.git" }));
    const twice = migrateToProjects(
      { projects: once.projects, repoDefaults: once.globalDefaults },
      resolver({ "/code/api": "/code/api/.git" }),
    );
    expect(twice.changed).toBe(false);
    expect(twice.projects).toEqual(once.projects);
  });

  test("an existing projects array suppresses migration entirely", () => {
    const legacy: LegacyShape = {
      projects: [{ id: "kept", title: "Kept", dir: "/code/kept" }],
      issueWorkflow: { teamRepoMap: { Core: "/code/api" } },
    };
    const r = migrateToProjects(legacy, resolver({}));
    expect(r.changed).toBe(false);
    expect(r.projects.map((p) => p.id)).toEqual(["kept"]);
  });
});
