import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import type { AgentState } from "../types";
import { detectInstalledKind, installHooks, uninstallHooks } from "./json-hooks";
import type {
  AgentIntegration,
  HookEvent,
  HookSettings,
  InstallKind,
  InstallOutcomeKind,
} from "./types";

export const CLAUDE_EVENTS: readonly HookEvent[] = [
  "UserPromptSubmit",
  "PermissionRequest",
  "PreToolUse",
  "Stop",
  "SessionEnd",
];

/**
 * Claude Code reads its config from `$CLAUDE_CONFIG_DIR` when set, falling back
 * to `~/.claude`. Resolved per call rather than at module load so the installer
 * follows the same rule Claude Code itself does — writing to `~/.claude` for a
 * user who has relocated their config would install hooks that never fire.
 */
function claudeSettingsPath(): string {
  const dir = process.env.CLAUDE_CONFIG_DIR ?? resolve(homedir(), ".claude");
  return resolve(dir, "settings.json");
}

function readSettings(path: string): HookSettings {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, "utf-8");
  // An unparseable settings.json is the user's file, not ours to overwrite —
  // throwing here surfaces it instead of silently replacing their config.
  return JSON.parse(raw) as HookSettings;
}

export const claudeIntegration: AgentIntegration = {
  id: "claude",
  label: "Claude Code",
  reports: new Set<AgentState>(["running", "waiting", "complete"]),
  get configPath(): string {
    return claudeSettingsPath();
  },

  writeTargets(): string[] {
    return [claudeSettingsPath()];
  },

  isPresent(): boolean {
    return existsSync(dirname(claudeSettingsPath())) || Bun.which("claude") !== null;
  },

  detect(): InstallKind {
    try {
      return detectInstalledKind(readSettings(claudeSettingsPath()), "claude", CLAUDE_EVENTS);
    } catch {
      return "none";
    }
  },

  install(): { kind: InstallOutcomeKind; notes: string[] } {
    const path = claudeSettingsPath();
    const settings = readSettings(path);
    const outcome = installHooks(settings, "claude", CLAUDE_EVENTS);
    if (outcome.kind === "noop") return { kind: "noop", notes: [] };

    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(outcome.settings, null, 2) + "\n");
    return {
      kind: outcome.kind,
      notes: ["Restart Claude Code in any open session to pick the hooks up."],
    };
  },

  uninstall(): { removed: boolean; paths: string[]; notes: string[] } {
    const path = claudeSettingsPath();
    if (!existsSync(path)) return { removed: false, paths: [], notes: [] };

    const { removed, settings } = uninstallHooks(readSettings(path), CLAUDE_EVENTS);
    if (!removed) return { removed: false, paths: [], notes: [] };

    // Rewrite rather than delete: settings.json holds the user's own config
    // alongside our hooks.
    writeFileSync(path, JSON.stringify(settings, null, 2) + "\n");
    return { removed: true, paths: [`${path} (jmux hooks)`], notes: [] };
  },
};
