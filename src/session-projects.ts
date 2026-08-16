// Resolve the display Project for each live session.
//
// Kept outside main.ts so both halves of session discovery can share one rule:
// the list-sessions response arrives first, while cwd/branch lookup completes
// asynchronously. A Project resolved only in the first half stays blank until
// an unrelated tmux event forces another list refresh.

import type { ProjectConfig } from "./project";
import { liveProjects, projectById, projectForDir, projectLabel } from "./project";
import type { SessionInfo } from "./types";

/**
 * Apply resolved Project labels to `sessions` and return the sidebar's
 * session-name → label map.
 *
 * `directoryFor` may return candidates in priority order. The live TUI uses
 * `[pane cwd, git common root]`: an exact worktree Project wins, while an old
 * un-stamped worktree can still inherit the Project configured at its repo.
 *
 * Mutation is deliberate: `SessionInfo.projectName` is also the grouping key
 * consumed by session-order, while the returned map supplies rows extracted
 * into bands (Pinned/Parked) whose headers do not name their Project.
 */
export function applySessionProjects(
  sessions: SessionInfo[],
  projects: readonly ProjectConfig[],
  directoryFor: (
    session: SessionInfo,
  ) => string | null | undefined | readonly (string | null | undefined)[],
  teamName: (teamId: string) => string | null = () => null,
): Map<string, string> {
  const live = liveProjects(projects);
  const labels = new Map<string, string>();

  for (const session of sessions) {
    const resolvedDirectories = directoryFor(session);
    const directories = Array.isArray(resolvedDirectories)
      ? resolvedDirectories
      : [resolvedDirectories];
    const project = projectById(projects, session.projectId)
      ?? directories.reduce<ProjectConfig | null>(
        (found, directory) => found ?? projectForDir(projects, directory),
        null,
      );
    if (!project) {
      delete session.projectName;
      continue;
    }

    const label = projectLabel(project, live, teamName);
    session.projectName = label;
    labels.set(session.name, label);
  }

  return labels;
}
