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
