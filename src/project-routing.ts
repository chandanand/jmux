// Which Project does this issue belong to?
//
// Deliberately its own module rather than living in issue-session.ts: that one
// takes an already-resolved directory and owns issue→session naming and
// existence precedence, which is a different question. Both the TUI and
// `jmux ctl` call this, because a CLI that computed its own answer here is a
// bug waiting to be filed as "the CLI disagrees with my sidebar".
//
// See docs/superpowers/specs/2026-08-12-phase-2-projects-design.md.

import { projectsClaimingTeam, liveProjects, type ProjectConfig } from "./project";

/** Learned routes. One top-level table — two maps could disagree. */
export interface ProjectRoutes {
  /** Exact, from "just this issue". Cannot ambiguously match another issue. */
  issue?: Record<string, string>;
  /** From "always for <Linear project>". */
  linearProject?: Record<string, string>;
}

/** What the caller already knows, independent of configuration. */
export interface RoutingEvidence {
  /** The Project id stamped on a session already linked to this issue. */
  sessionProjectId?: string | null;
  /** True when such a session exists, even if its stamp is missing. */
  hasSession?: boolean;
  /** Project id implied by a linked MR's repository, when one is known. */
  mrProjectId?: string | null;
}

export interface RoutingIssue {
  id: string;
  teamId?: string;
  teamName?: string;
  /** Linear's own project id, used only as a routing key. */
  linearProjectId?: string;
}

export type RoutingOutcome =
  | { kind: "resolved"; project: ProjectConfig; via: RoutingVia }
  | { kind: "unclaimed"; teamName: string | null }
  | { kind: "ambiguous"; candidates: ProjectConfig[] }
  | { kind: "conflict"; candidates: ProjectConfig[]; evidence: string[] }
  /** A session exists whose stamp names no live Project. Never re-routed. */
  | { kind: "orphaned"; stampedId: string | null };

export type RoutingVia =
  | "existing session"
  | "issue route"
  | "linked MR"
  | "linear project route"
  | "sole claimant";

/**
 * Resolve an issue to a Project.
 *
 * **Existing work is evaluated before candidate cardinality.** A session that
 * already exists for this issue is the answer regardless of how many Projects
 * claim its team — the current resolver already requires that precedence, and a
 * learned route must never relocate work that exists on disk.
 *
 * Five outcomes, not two. Disagreement (`conflict`) is deliberately distinct
 * from absence (`ambiguous`): a stored route contradicting a linked MR is a
 * different problem from having no information at all, and collapsing them
 * produces a confident wrong answer.
 */
export function resolveIssueProject(
  issue: RoutingIssue,
  all: readonly ProjectConfig[],
  routes: ProjectRoutes = {},
  evidence: RoutingEvidence = {},
): RoutingOutcome {
  const live = liveProjects(all);
  const byId = new Map(live.map((p) => [p.id, p]));

  // 1. Existing work wins outright.
  if (evidence.hasSession) {
    const stamped = evidence.sessionProjectId ?? null;
    const project = stamped ? byId.get(stamped) : undefined;
    if (project) return { kind: "resolved", project, via: "existing session" };
    // A stamp naming a deleted Project, or no stamp at all, is reported rather
    // than re-routed: silently moving a session that already has a worktree is
    // the one thing this design exists to prevent.
    return { kind: "orphaned", stampedId: stamped };
  }

  const candidates = projectsClaimingTeam(live, issue.teamId);
  if (candidates.length === 0) {
    return { kind: "unclaimed", teamName: issue.teamName ?? null };
  }

  // Gather every source that has an opinion, so a disagreement can be named.
  const opinions: Array<{ via: RoutingVia; project: ProjectConfig }> = [];
  const push = (via: RoutingVia, id: string | null | undefined): void => {
    if (!id) return;
    const p = byId.get(id);
    // A route pointing outside this issue's team is stale, not authoritative.
    if (p && candidates.some((c) => c.id === p.id)) opinions.push({ via, project: p });
  };
  push("issue route", routes.issue?.[issue.id]);
  push("linked MR", evidence.mrProjectId);
  if (issue.linearProjectId) push("linear project route", routes.linearProject?.[issue.linearProjectId]);

  const distinct = new Set(opinions.map((o) => o.project.id));
  if (distinct.size > 1) {
    return {
      kind: "conflict",
      candidates: [...distinct].map((id) => byId.get(id)!),
      evidence: opinions.map((o) => `${o.via} → ${o.project.title}`),
    };
  }
  if (opinions.length > 0) {
    return { kind: "resolved", project: opinions[0].project, via: opinions[0].via };
  }

  if (candidates.length === 1) {
    return { kind: "resolved", project: candidates[0], via: "sole claimant" };
  }
  return { kind: "ambiguous", candidates };
}

/**
 * Routes that are safe to drop.
 *
 * **Never on absence.** `getMyIssues` filters completed and canceled issues
 * out, so an issue vanishing from the poll means nothing — it may have been
 * unassigned, moved team, or the tracker may simply be down. Only an issue
 * observed in a terminal state, or one whose session now exists and carries the
 * stamp, has actually finished with its route.
 */
export function prunableIssueRoutes(
  routes: ProjectRoutes,
  opts: {
    /** Issue ids whose session exists and is stamped — the session is the record now. */
    stamped: ReadonlySet<string>;
    /** Issue ids observed in a terminal state by an explicit lookup. */
    terminal: ReadonlySet<string>;
  },
): string[] {
  return Object.keys(routes.issue ?? {}).filter(
    (id) => opts.stamped.has(id) || opts.terminal.has(id),
  );
}

/**
 * Whether "always for this Linear project" may be offered.
 *
 * Withheld when issues in one Linear project have already resolved to two
 * different Projects: a Linear project legitimately spanning an API and a
 * frontend is common, and one confirmation writing a permanent 1:1 rule would
 * silently misroute every issue after it.
 *
 * Advisory only — it may suppress the offer, never rewrite an existing route.
 * The observed set is unstable (the issue universe is assigned, non-terminal
 * issues only), so a split can appear and vanish between polls.
 */
export function mayOfferLinearProjectRoute(
  observed: ReadonlyArray<{ linearProjectId?: string; projectId: string }>,
  linearProjectId: string | undefined,
): boolean {
  if (!linearProjectId) return false;
  const seen = new Set(
    observed.filter((o) => o.linearProjectId === linearProjectId).map((o) => o.projectId),
  );
  return seen.size <= 1;
}
