import { describe, test, expect } from "bun:test";
import {
  AGENT_INTEGRATIONS,
  agentReports,
  integrationFor,
  screenTierMayWrite,
} from "../../agent-hooks/registry";
import { AGENT_KINDS } from "../../types";
import { piExtensionTarget } from "../../agent-hooks/pi";

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
  test("Claude Code reports all three states", () => {
    expect(agentReports("claude", "running")).toBe(true);
    expect(agentReports("claude", "waiting")).toBe(true);
    expect(agentReports("claude", "complete")).toBe(true);
  });

  test("Codex does not equate automatically-reviewed permission requests with human attention", () => {
    expect(agentReports("codex", "running")).toBe(true);
    expect(agentReports("codex", "waiting")).toBe(false);
    expect(agentReports("codex", "complete")).toBe(true);
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
    }
    expect(screenTierMayWrite("codex", "running")).toBe(false);
    expect(screenTierMayWrite("codex", "complete")).toBe(false);
    expect(screenTierMayWrite("codex", "waiting")).toBe(true);
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

// Consent to write into another tool's config is only real if it names what
// will actually be touched. `configPath` is the primary file and under-reports
// two of the three agents, and every path resolves from the environment
// (CLAUDE_CONFIG_DIR, CODEX_HOME), so prose in a page cannot state them.
describe("writeTargets", () => {
  test("every integration reports at least its own configPath", () => {
    for (const integration of AGENT_INTEGRATIONS) {
      expect(integration.writeTargets()).toContain(integration.configPath);
    }
  });

  test("no integration reports a duplicate or an empty path", () => {
    for (const integration of AGENT_INTEGRATIONS) {
      const targets = integration.writeTargets();
      expect(targets.length).toBeGreaterThan(0);
      expect(new Set(targets).size).toBe(targets.length);
      for (const t of targets) expect(t.length).toBeGreaterThan(0);
    }
  });

  // Codex needs `[features] hooks = true` spliced into config.toml as well as
  // the hooks document itself, so naming only hooks.json understates it.
  test("codex reports config.toml as well as hooks.json", () => {
    const codex = AGENT_INTEGRATIONS.find((a) => a.id === "codex")!;
    const targets = codex.writeTargets();
    expect(targets.some((t) => t.endsWith("hooks.json"))).toBe(true);
    expect(targets.some((t) => t.endsWith("config.toml"))).toBe(true);
  });

  // pi has no shell hooks: the extension is a file jmux copies out, and
  // registering it edits pi's settings. Two files, one step.
  test("pi reports the extension it copies as well as its settings", () => {
    const pi = AGENT_INTEGRATIONS.find((a) => a.id === "pi")!;
    expect(pi.writeTargets()).toContain(piExtensionTarget());
  });

  test("claude follows CLAUDE_CONFIG_DIR rather than assuming ~/.claude", () => {
    const claude = AGENT_INTEGRATIONS.find((a) => a.id === "claude")!;
    const before = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = "/tmp/jmux-writetargets-probe";
    try {
      expect(claude.writeTargets()).toEqual(["/tmp/jmux-writetargets-probe/settings.json"]);
    } finally {
      if (before === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = before;
    }
  });
});
