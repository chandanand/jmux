import { describe, test, expect } from "bun:test";
import {
  resolveIssueProject,
  prunableIssueRoutes,
  mayOfferLinearProjectRoute,
} from "../project-routing";
import type { ProjectConfig } from "../project";

function p(id: string, over: Partial<ProjectConfig> = {}): ProjectConfig {
  return { id, title: id, dir: `/code/${id}`, ...over };
}

const issue = (over = {}) => ({ id: "I1", teamId: "T1", teamName: "Core", ...over });

describe("resolveIssueProject — existing work first", () => {
  // A learned route must never relocate work that exists on disk.
  test("an existing stamped session wins over every route", () => {
    const all = [p("api", { teamId: "T1" }), p("web", { teamId: "T1" })];
    const r = resolveIssueProject(
      issue(),
      all,
      { issue: { I1: "web" } },
      { hasSession: true, sessionProjectId: "api" },
    );
    expect(r.kind).toBe("resolved");
    if (r.kind === "resolved") {
      expect(r.project.id).toBe("api");
      expect(r.via).toBe("existing session");
    }
  });

  test("a session whose stamp names a deleted Project is orphaned, never re-routed", () => {
    const all = [p("api", { teamId: "T1" }), p("dead", { teamId: "T1", deletedAt: "x" })];
    const r = resolveIssueProject(issue(), all, {}, { hasSession: true, sessionProjectId: "dead" });
    expect(r.kind).toBe("orphaned");
    if (r.kind === "orphaned") expect(r.stampedId).toBe("dead");
  });

  test("a session with no stamp at all is orphaned, not assigned to the sole claimant", () => {
    const all = [p("api", { teamId: "T1" })];
    const r = resolveIssueProject(issue(), all, {}, { hasSession: true, sessionProjectId: null });
    expect(r.kind).toBe("orphaned");
  });
});

describe("resolveIssueProject — cardinality", () => {
  test("no claimant reports unclaimed and names the team", () => {
    const r = resolveIssueProject(issue(), [p("other", { teamId: "T2" })]);
    expect(r.kind).toBe("unclaimed");
    if (r.kind === "unclaimed") expect(r.teamName).toBe("Core");
  });

  test("a sole claimant resolves without asking", () => {
    const r = resolveIssueProject(issue(), [p("api", { teamId: "T1" })]);
    expect(r.kind).toBe("resolved");
    if (r.kind === "resolved") expect(r.via).toBe("sole claimant");
  });

  test("several claimants with no evidence is ambiguous", () => {
    const all = [p("api", { teamId: "T1" }), p("web", { teamId: "T1" })];
    const r = resolveIssueProject(issue(), all);
    expect(r.kind).toBe("ambiguous");
    if (r.kind === "ambiguous") expect(r.candidates).toHaveLength(2);
  });

  test("a soft-deleted claimant does not count toward ambiguity", () => {
    const all = [p("api", { teamId: "T1" }), p("gone", { teamId: "T1", deletedAt: "x" })];
    const r = resolveIssueProject(issue(), all);
    expect(r.kind).toBe("resolved");
  });
});

describe("resolveIssueProject — evidence", () => {
  const two = [p("api", { teamId: "T1" }), p("web", { teamId: "T1" })];

  test("an exact issue route resolves an otherwise ambiguous set", () => {
    const r = resolveIssueProject(issue(), two, { issue: { I1: "web" } });
    expect(r.kind).toBe("resolved");
    if (r.kind === "resolved") expect(r.via).toBe("issue route");
  });

  test("a linked MR resolves an otherwise ambiguous set", () => {
    const r = resolveIssueProject(issue(), two, {}, { mrProjectId: "api" });
    expect(r.kind).toBe("resolved");
    if (r.kind === "resolved") expect(r.via).toBe("linked MR");
  });

  test("a linear-project route resolves an otherwise ambiguous set", () => {
    const r = resolveIssueProject(
      issue({ linearProjectId: "LP1" }),
      two,
      { linearProject: { LP1: "web" } },
    );
    expect(r.kind).toBe("resolved");
    if (r.kind === "resolved") expect(r.via).toBe("linear project route");
  });

  // Disagreement is a distinct problem from absence.
  test("two sources naming different Projects is a conflict, not a silent pick", () => {
    const r = resolveIssueProject(issue(), two, { issue: { I1: "web" } }, { mrProjectId: "api" });
    expect(r.kind).toBe("conflict");
    if (r.kind === "conflict") {
      expect(r.candidates).toHaveLength(2);
      expect(r.evidence.join(" ")).toContain("linked MR");
      expect(r.evidence.join(" ")).toContain("issue route");
    }
  });

  test("two sources agreeing is not a conflict", () => {
    const r = resolveIssueProject(issue(), two, { issue: { I1: "api" } }, { mrProjectId: "api" });
    expect(r.kind).toBe("resolved");
  });

  test("a route pointing outside the issue's team is ignored as stale", () => {
    const all = [p("api", { teamId: "T1" }), p("web", { teamId: "T1" }), p("other", { teamId: "T2" })];
    const r = resolveIssueProject(issue(), all, { issue: { I1: "other" } });
    expect(r.kind).toBe("ambiguous");
  });

  test("a route pointing at a deleted Project is ignored", () => {
    const all = [p("api", { teamId: "T1" }), p("web", { teamId: "T1" }), p("gone", { teamId: "T1", deletedAt: "x" })];
    const r = resolveIssueProject(issue(), all, { issue: { I1: "gone" } });
    expect(r.kind).toBe("ambiguous");
  });
});

describe("prunableIssueRoutes", () => {
  const routes = { issue: { A: "api", B: "api", C: "api" } };

  test("prunes a route whose session now exists and is stamped", () => {
    expect(prunableIssueRoutes(routes, { stamped: new Set(["A"]), terminal: new Set() })).toEqual(["A"]);
  });

  test("prunes a route whose issue was observed terminal", () => {
    expect(prunableIssueRoutes(routes, { stamped: new Set(), terminal: new Set(["B"]) })).toEqual(["B"]);
  });

  // getMyIssues filters completed and canceled out, so absence from a poll says
  // nothing — the issue may be unassigned, moved team, or the tracker down.
  test("does not prune merely because an issue is absent from the poll", () => {
    expect(prunableIssueRoutes(routes, { stamped: new Set(), terminal: new Set() })).toEqual([]);
  });
});

describe("mayOfferLinearProjectRoute", () => {
  test("offers when every observed issue in that Linear project used one Project", () => {
    const observed = [
      { linearProjectId: "LP1", projectId: "api" },
      { linearProjectId: "LP1", projectId: "api" },
    ];
    expect(mayOfferLinearProjectRoute(observed, "LP1")).toBe(true);
  });

  test("withholds when the Linear project has spanned two Projects", () => {
    const observed = [
      { linearProjectId: "LP1", projectId: "api" },
      { linearProjectId: "LP1", projectId: "web" },
    ];
    expect(mayOfferLinearProjectRoute(observed, "LP1")).toBe(false);
  });

  test("an issue with no Linear project has no durable key, so nothing is offered", () => {
    expect(mayOfferLinearProjectRoute([], undefined)).toBe(false);
  });

  test("other Linear projects' history is not consulted", () => {
    const observed = [
      { linearProjectId: "LP2", projectId: "api" },
      { linearProjectId: "LP2", projectId: "web" },
    ];
    expect(mayOfferLinearProjectRoute(observed, "LP1")).toBe(true);
  });
});
