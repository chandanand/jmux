import { describe, test, expect } from "bun:test";
import {
  PROJECT_SETTING_DEFAULTS,
  resolveProjectSettings,
  projectSettingScope,
  makeProjectId,
  liveProjects,
  projectsClaimingTeam,
  type ProjectConfig,
  type ProjectSettings,
  PROJECT_OPTION,
  isWritableProjectId,
  projectForDir,
  projectById,
  resolveSettingsFor,
} from "../project";

function project(over: Partial<ProjectConfig> = {}): ProjectConfig {
  return { id: "p1", title: "Payments", dir: "/code/payments", ...over };
}

describe("makeProjectId", () => {
  test("slugifies a title", () => {
    expect(makeProjectId("Payments Service", new Set())).toBe("payments-service");
  });

  test("strips characters that would be awkward in a config key", () => {
    expect(makeProjectId("Web (v2)!", new Set())).toBe("web-v2");
  });

  test("suffixes on collision rather than overwriting", () => {
    expect(makeProjectId("Payments", new Set(["payments"]))).toBe("payments-2");
    expect(makeProjectId("Payments", new Set(["payments", "payments-2"]))).toBe("payments-3");
  });

  test("falls back for a title with nothing slug-able in it", () => {
    expect(makeProjectId("···", new Set())).toBe("project");
    expect(makeProjectId("···", new Set(["project"]))).toBe("project-2");
  });
});

describe("resolveProjectSettings", () => {
  test("falls through to the built-in defaults when nothing is set", () => {
    const r = resolveProjectSettings(undefined, undefined);
    expect(r).toEqual(PROJECT_SETTING_DEFAULTS);
  });

  test("a global default beats the built-in", () => {
    const r = resolveProjectSettings({ agentCommand: "codex" }, undefined);
    expect(r.agentCommand).toBe("codex");
  });

  test("a project override beats the global", () => {
    const r = resolveProjectSettings({ agentCommand: "codex" }, { agentCommand: "claude" });
    expect(r.agentCommand).toBe("claude");
  });

  // `null` on the transition fields means "never write", which must not fall
  // through to a lower tier that says otherwise.
  test("an explicit null is a real value and wins", () => {
    const r = resolveProjectSettings({ onMrMergedState: "Done" }, { onMrMergedState: null });
    expect(r.onMrMergedState).toBeNull();
  });

  test("false is a real value and wins", () => {
    const r = resolveProjectSettings({ autoLaunchAgent: true }, { autoLaunchAgent: false });
    expect(r.autoLaunchAgent).toBe(false);
  });

  test("a caller-supplied base seeds fields nothing else sets", () => {
    const base: ProjectSettings = { wtmIntegration: true };
    const r = resolveProjectSettings(undefined, undefined, base);
    expect(r.wtmIntegration).toBe(true);
  });

  test("a project override beats a caller-supplied base", () => {
    const r = resolveProjectSettings(undefined, { wtmIntegration: false }, { wtmIntegration: true });
    expect(r.wtmIntegration).toBe(false);
  });
});

describe("projectSettingScope", () => {
  // Provenance is KEY PRESENCE, not value difference. Pinning a value that
  // happens to equal the global is a deliberate override, and treating it as
  // inherited would let a later global change silently move the Project.
  test("a key that is present is an override even when it equals the global", () => {
    const p = project({ settings: { agentCommand: "codex" } });
    expect(projectSettingScope(p, "agentCommand", { agentCommand: "codex" })).toBe("override");
  });

  test("an absent key is inherited", () => {
    const p = project({ settings: {} });
    expect(projectSettingScope(p, "agentCommand", { agentCommand: "codex" })).toBe("inherited");
  });

  test("no settings object at all is inherited", () => {
    expect(projectSettingScope(project(), "agentCommand", undefined)).toBe("inherited");
  });

  test("an explicitly stored null is an override, not an absence", () => {
    const p = project({ settings: { onMrMergedState: null } });
    expect(projectSettingScope(p, "onMrMergedState", {})).toBe("override");
  });
});

describe("liveProjects", () => {
  test("drops soft-deleted entries", () => {
    const all = [project(), project({ id: "p2", deletedAt: "2026-08-01T00:00:00Z" })];
    expect(liveProjects(all).map((p) => p.id)).toEqual(["p1"]);
  });

  test("keeps everything when nothing is deleted", () => {
    expect(liveProjects([project(), project({ id: "p2" })])).toHaveLength(2);
  });
});

describe("projectsClaimingTeam", () => {
  test("returns every live Project claiming the team", () => {
    const all = [
      project({ id: "api", teamId: "T1" }),
      project({ id: "web", teamId: "T1" }),
      project({ id: "other", teamId: "T2" }),
    ];
    expect(projectsClaimingTeam(all, "T1").map((p) => p.id)).toEqual(["api", "web"]);
  });

  test("a soft-deleted claimant does not count", () => {
    const all = [
      project({ id: "api", teamId: "T1" }),
      project({ id: "dead", teamId: "T1", deletedAt: "2026-08-01T00:00:00Z" }),
    ];
    expect(projectsClaimingTeam(all, "T1").map((p) => p.id)).toEqual(["api"]);
  });

  test("an unresolved legacy team name does not match a team id", () => {
    const all = [project({ id: "api", legacyTeamName: "Core Engineering" })];
    expect(projectsClaimingTeam(all, "Core Engineering")).toEqual([]);
  });

  test("no team id yields nothing rather than every teamless Project", () => {
    const all = [project({ id: "a" }), project({ id: "b" })];
    expect(projectsClaimingTeam(all, undefined)).toEqual([]);
  });
});

describe("PROJECT_OPTION", () => {
  test("is the documented session option name", () => {
    expect(PROJECT_OPTION).toBe("@jmux-project");
  });
});

describe("isWritableProjectId", () => {
  // Validated at the write, not guessed at the read — the same rule
  // isWritableLinkId follows, and the reason a malformed value cannot silently
  // become two links.
  test("accepts an ordinary slug", () => {
    expect(isWritableProjectId("payments-api")).toBe(true);
  });

  test("refuses whitespace, which would split the option value", () => {
    expect(isWritableProjectId("two words")).toBe(false);
    expect(isWritableProjectId("tab\there")).toBe(false);
  });

  test("refuses quotes, which would break the set-option command", () => {
    expect(isWritableProjectId("it's")).toBe(false);
    expect(isWritableProjectId('say"what')).toBe(false);
  });

  test("refuses empty", () => {
    expect(isWritableProjectId("")).toBe(false);
  });
});

describe("projectForDir", () => {
  test("resolves the single Project on a directory", () => {
    const all = [project({ id: "api", dir: "/code/api" }), project({ id: "web", dir: "/code/web" })];
    expect(projectForDir(all, "/code/api")?.id).toBe("api");
  });

  // A shared dir is exactly what the explicit stamp exists for. Guessing one of
  // two here would resolve settings against a Project the session may not be in.
  test("a shared directory is null, not a guess", () => {
    const all = [project({ id: "core", dir: "/code/mono" }), project({ id: "web", dir: "/code/mono" })];
    expect(projectForDir(all, "/code/mono")).toBeNull();
  });

  test("an unclaimed directory is null", () => {
    expect(projectForDir([project({ dir: "/code/api" })], "/code/other")).toBeNull();
  });

  test("a soft-deleted Project does not claim its directory", () => {
    const all = [project({ id: "gone", dir: "/code/api", deletedAt: "x" })];
    expect(projectForDir(all, "/code/api")).toBeNull();
  });

  test("null and undefined are null", () => {
    expect(projectForDir([project()], null)).toBeNull();
    expect(projectForDir([project()], undefined)).toBeNull();
  });
});

describe("projectById", () => {
  test("finds a live Project", () => {
    expect(projectById([project({ id: "api" })], "api")?.id).toBe("api");
  });

  test("a soft-deleted id resolves to null, so the caller can report orphaned", () => {
    expect(projectById([project({ id: "api", deletedAt: "x" })], "api")).toBeNull();
  });

  test("an unknown id is null", () => {
    expect(projectById([project({ id: "api" })], "nope")).toBeNull();
  });
});

describe("resolveSettingsFor — the post-migration path", () => {
  // The migration deletes `repos` and `repoDefaults`. Anything still resolving
  // through them would silently drop every per-repo setting a user had the
  // moment they upgraded — their agent command, their base branch.
  const config = {
    projects: [
      project({ id: "api", dir: "/code/api", settings: { agentCommand: "cc" } }),
      project({ id: "core", dir: "/code/mono" }),
      project({ id: "web", dir: "/code/mono" }),
    ],
    projectDefaults: { autoLaunchAgent: false },
  };

  test("a migrated per-repo override still applies", () => {
    expect(resolveSettingsFor(config, { dir: "/code/api" }).agentCommand).toBe("cc");
  });

  test("the global tier still applies", () => {
    expect(resolveSettingsFor(config, { dir: "/code/api" }).autoLaunchAgent).toBe(false);
  });

  test("an unknown directory gets the global tier, not nothing", () => {
    const r = resolveSettingsFor(config, { dir: "/code/elsewhere" });
    expect(r.autoLaunchAgent).toBe(false);
    expect(r.agentCommand).toBe(PROJECT_SETTING_DEFAULTS.agentCommand);
  });

  test("a shared directory falls to the global tier rather than guessing", () => {
    expect(resolveSettingsFor(config, { dir: "/code/mono" }).agentCommand)
      .toBe(PROJECT_SETTING_DEFAULTS.agentCommand);
  });

  test("a stamp settles a shared directory", () => {
    const withSetting = {
      ...config,
      projects: config.projects.map((p) =>
        p.id === "web" ? { ...p, settings: { agentCommand: "codex" } } : p),
    };
    expect(resolveSettingsFor(withSetting, { dir: "/code/mono", projectId: "web" }).agentCommand)
      .toBe("codex");
  });

  test("runtime bare detection still seeds wtmIntegration", () => {
    expect(resolveSettingsFor(config, { dir: "/code/api", bare: true }).wtmIntegration).toBe(true);
    expect(resolveSettingsFor(config, { dir: "/code/api", bare: false }).wtmIntegration).toBe(false);
  });

  test("a Project override beats runtime detection", () => {
    const c = { projects: [project({ id: "api", dir: "/code/api", settings: { wtmIntegration: false } })] };
    expect(resolveSettingsFor(c, { dir: "/code/api", bare: true }).wtmIntegration).toBe(false);
  });
});
