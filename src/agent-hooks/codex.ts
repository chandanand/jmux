import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { AgentState } from "../types";
import { ensureHooksFeature } from "./codex-toml";
import { detectInstalledKind, installHooks, uninstallHooks } from "./json-hooks";
import type {
  AgentIntegration,
  HookEvent,
  HookSettings,
  InstallKind,
  InstallOutcomeKind,
} from "./types";

/**
 * Codex 0.145 ships a hook engine that is schema-compatible with Claude Code's:
 * the same PascalCase event names in the same `{hooks: {...}}` document, just in
 * a dedicated `hooks.json` rather than sharing a settings file. That is why this
 * integration is mostly configuration and not code.
 *
 * Two things are Codex-specific:
 *  - the engine is gated behind `[features] hooks = true` in config.toml, and
 *  - every hook entry must be *trusted* before it runs. Codex records a
 *    `trusted_hash` under `[hooks.state]` once the user approves. jmux
 *    deliberately does not synthesise those hashes — that would forge a
 *    security decision on the user's behalf — so install() tells the user to
 *    expect the prompt instead.
 */

export const CODEX_EVENTS: readonly HookEvent[] = [
  "UserPromptSubmit",
  "PermissionRequest",
  "PreToolUse",
  "Stop",
  "SessionEnd",
];

function codexHome(): string {
  return process.env.CODEX_HOME ?? resolve(homedir(), ".codex");
}

function hooksPath(): string {
  return resolve(codexHome(), "hooks.json");
}

function configPath(): string {
  return resolve(codexHome(), "config.toml");
}

function readHooks(): HookSettings {
  const path = hooksPath();
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf-8")) as HookSettings;
}

export const codexIntegration: AgentIntegration = {
  id: "codex",
  label: "Codex CLI",
  // PermissionRequest is also emitted for automatically-reviewed requests, so
  // Codex cannot honestly distinguish "needs the human" from "review is in
  // progress" through hooks. Reporting WAITING would manufacture attention.
  reports: new Set<AgentState>(["running", "complete"]),
  get configPath(): string {
    return hooksPath();
  },

  // config.toml as well: the hooks document alone does nothing until
  // `[features] hooks = true` is spliced in beside it.
  writeTargets(): string[] {
    return [hooksPath(), configPath()];
  },

  isPresent(): boolean {
    return existsSync(codexHome()) || Bun.which("codex") !== null;
  },

  detect(): InstallKind {
    try {
      return detectInstalledKind(readHooks(), "codex", CODEX_EVENTS);
    } catch {
      return "none";
    }
  },

  install(): { kind: InstallOutcomeKind; notes: string[] } {
    const outcome = installHooks(readHooks(), "codex", CODEX_EVENTS);
    const notes: string[] = [];

    if (outcome.kind !== "noop") {
      mkdirSync(codexHome(), { recursive: true });
      writeFileSync(hooksPath(), JSON.stringify(outcome.settings, null, 2) + "\n");
    }

    // The feature flag is checked even on a hooks noop: the user may have
    // installed hooks with an older jmux and never enabled the engine, in which
    // case nothing has ever fired and the sidebar has been silently empty.
    notes.push(...ensureFeatureFlag());

    if (outcome.kind !== "noop") {
      notes.push(
        "Codex will ask you to approve these hooks the first time you launch it.",
        "Until you approve them, Codex sessions report no state.",
      );
    }
    return { kind: outcome.kind, notes };
  },

  uninstall(): { removed: boolean; paths: string[]; notes: string[] } {
    const path = hooksPath();
    if (!existsSync(path)) return { removed: false, paths: [], notes: [] };

    const { removed, settings } = uninstallHooks(readHooks(), CODEX_EVENTS);
    if (!removed) return { removed: false, paths: [], notes: [] };

    writeFileSync(path, JSON.stringify(settings, null, 2) + "\n");
    // `[features] hooks = true` in config.toml is deliberately left: it is a
    // Codex-wide setting the user may rely on for their own hooks, and jmux
    // cannot know it was not already wanted.
    return {
      removed: true,
      paths: [`${path} (jmux hooks)`],
      notes: ["left [features] hooks = true in config.toml — it may not be ours"],
    };
  },
};

function ensureFeatureFlag(): string[] {
  const path = configPath();
  const text = existsSync(path) ? readFileSync(path, "utf-8") : "";
  const result = ensureHooksFeature(text);

  switch (result.status) {
    case "already-enabled":
      return [];
    case "enabled":
      mkdirSync(codexHome(), { recursive: true });
      writeFileSync(path, result.text);
      return ["Enabled [features] hooks = true in ~/.codex/config.toml."];
    case "explicitly-disabled":
      return [
        "~/.codex/config.toml sets [features] hooks = false — jmux left it alone.",
        "Set it to true for Codex sessions to report state.",
      ];
    case "unsafe":
      return [
        "Could not safely edit ~/.codex/config.toml. Add this yourself:",
        "  [features]",
        "  hooks = true",
      ];
  }
}
