import { describe, expect, test } from "bun:test";
import { applySessionProjects } from "../session-projects";
import type { ProjectConfig } from "../project";
import type { SessionInfo } from "../types";

function session(over: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: "$1",
    name: "api",
    attached: true,
    activity: 0,
    windowCount: 1,
    ...over,
  };
}

const PROJECTS: ProjectConfig[] = [
  { id: "api", title: "API", dir: "/code/api" },
];

describe("applySessionProjects", () => {
  test("fills the Project after an asynchronous directory lookup completes", () => {
    const sessions = [session()];
    let dir: string | null = null;

    expect(applySessionProjects(sessions, PROJECTS, () => dir)).toEqual(new Map());
    expect(sessions[0]!.projectName).toBeUndefined();

    dir = "/code/api";
    expect(applySessionProjects(sessions, PROJECTS, () => dir)).toEqual(
      new Map([["api", "API"]]),
    );
    expect(sessions[0]!.projectName).toBe("API");
  });

  test("an explicit Project stamp wins when a directory is shared", () => {
    const projects: ProjectConfig[] = [
      { id: "core", title: "Platform", dir: "/code/mono", teamId: "T1" },
      { id: "web", title: "Platform", dir: "/code/mono", teamId: "T2" },
    ];
    const sessions = [session({ projectId: "web" })];

    const labels = applySessionProjects(
      sessions,
      projects,
      () => "/code/mono",
      (teamId) => ({ T1: "Core", T2: "Web" })[teamId] ?? null,
    );

    expect(labels).toEqual(new Map([["api", "Platform · Web"]]));
    expect(sessions[0]!.projectName).toBe("Platform · Web");
  });

  test("clears a stale label when the Project no longer resolves", () => {
    const sessions = [session({ projectName: "Old" })];

    expect(applySessionProjects(sessions, [], () => "/code/api")).toEqual(new Map());
    expect(sessions[0]!.projectName).toBeUndefined();
  });
});
