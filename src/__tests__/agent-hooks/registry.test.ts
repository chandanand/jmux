import { describe, test, expect } from "bun:test";
import {
  AGENT_INTEGRATIONS,
  agentReports,
  integrationFor,
  screenTierMayWrite,
} from "../../agent-hooks/registry";
import { AGENT_KINDS } from "../../types";

describe("AGENT_INTEGRATIONS", () => {
  test("covers every declared agent kind, exactly once", () => {
    const ids = AGENT_INTEGRATIONS.map((a) => a.id).sort();
    expect(ids).toEqual([...AGENT_KINDS].sort());
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("integrationFor resolves each kind", () => {
    for (const kind of AGENT_KINDS) {
      expect(integrationFor(kind)?.id).toBe(kind);
    }
  });

  test("every integration declares at least running and complete", () => {
    for (const a of AGENT_INTEGRATIONS) {
      expect(a.reports.has("running")).toBe(true);
      expect(a.reports.has("complete")).toBe(true);
    }
  });
});

describe("agentReports", () => {
  test("Claude Code and Codex report all three states", () => {
    for (const kind of ["claude", "codex"] as const) {
      expect(agentReports(kind, "running")).toBe(true);
      expect(agentReports(kind, "waiting")).toBe(true);
      expect(agentReports(kind, "complete")).toBe(true);
    }
  });

  test("pi cannot report waiting — its extension API has no permission event", () => {
    expect(agentReports("pi", "running")).toBe(true);
    expect(agentReports("pi", "complete")).toBe(true);
    expect(agentReports("pi", "waiting")).toBe(false);
  });

  test("an unknown kind reports nothing on its own", () => {
    expect(agentReports("aider", "running")).toBe(false);
  });
});

describe("screenTierMayWrite", () => {
  test("owns panes no agent has claimed", () => {
    for (const state of ["running", "waiting", "complete"] as const) {
      expect(screenTierMayWrite("", state)).toBe(true);
    }
  });

  test("never overrides a state the agent reports itself", () => {
    // The central rule: a guess must not overwrite a fact.
    for (const state of ["running", "waiting", "complete"] as const) {
      expect(screenTierMayWrite("claude", state)).toBe(false);
      expect(screenTierMayWrite("codex", state)).toBe(false);
    }
  });

  test("fills only the gap an agent structurally cannot observe", () => {
    expect(screenTierMayWrite("pi", "waiting")).toBe(true);
    expect(screenTierMayWrite("pi", "running")).toBe(false);
    expect(screenTierMayWrite("pi", "complete")).toBe(false);
  });

  test("a pane claiming an unrecognised kind is treated as unintegrated", () => {
    expect(screenTierMayWrite("some-future-agent", "waiting")).toBe(true);
  });
});
