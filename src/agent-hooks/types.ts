import type { AgentKind, AgentState } from "../types";

/**
 * Hook events jmux installs. These names are shared verbatim by Claude Code and
 * Codex — both accept the same PascalCase event keys and the same entry schema,
 * which is why one installer serves both.
 */
export type HookEvent =
  | "UserPromptSubmit"
  | "PermissionRequest"
  | "PreToolUse"
  | "Stop"
  | "SessionEnd";

export interface HookCommand {
  type: "command";
  command: string;
  timeout: number;
}

export interface HookEntry {
  hooks: HookCommand[];
}

/**
 * The hook-bearing config document. Claude Code keeps it in
 * `~/.claude/settings.json` alongside unrelated settings; Codex keeps it in a
 * dedicated `~/.codex/hooks.json`. Both nest hooks under a `hooks` key, so the
 * same shape describes each and unrelated keys are preserved on write.
 */
export type HookSettings = {
  hooks?: Partial<Record<string, HookEntry[]>>;
  [k: string]: unknown;
};

export type InstallKind = "none" | "legacy" | "partial" | "current";
export type InstallOutcomeKind = "installed" | "migrated" | "noop";

export interface InstallOutcome {
  kind: InstallOutcomeKind;
  settings: HookSettings;
}

/**
 * One agent's integration with jmux's state tracking: where its config lives,
 * how to detect and install jmux's emitters into it, and — critically — which
 * states it is actually capable of reporting.
 */
export interface AgentIntegration {
  readonly id: AgentKind;
  /** Human-facing name, used in installer output. */
  readonly label: string;
  /**
   * States this agent can actually observe and report. pi omits `waiting`: its
   * extension API exposes no permission-request event, so a WAITING from a pi
   * pane could only ever be invented. The sidebar consults this rather than
   * assuming every agent speaks the full vocabulary.
   */
  readonly reports: ReadonlySet<AgentState>;
  /** Absolute path to the config file jmux writes. */
  readonly configPath: string;
  /**
   * Every file `install()` may write, resolved now.
   *
   * `configPath` names the primary one and under-reports two of the three
   * agents: Codex also splices a feature flag into `config.toml`, and pi copies
   * its extension out beside registering it. Asking someone to consent to jmux
   * editing another tool's config is only honest if it names what will actually
   * be touched — and since every path resolves from the environment
   * (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `XDG_CONFIG_HOME`), prose in a page
   * cannot state them without being wrong on a relocated config.
   */
  writeTargets(): string[];
  /** True when this agent looks installed on the current machine. */
  isPresent(): boolean;
  /** Inspect the on-disk config without modifying it. */
  detect(): InstallKind;
  /**
   * Write jmux's emitters into the agent's config. Returns the outcome plus any
   * notes the user must act on (e.g. Codex's hook-trust prompt).
   */
  install(): { kind: InstallOutcomeKind; notes: string[] };
  /**
   * Reverse `install()`. Removing jmux itself never touches these files — they
   * belong to the agents — so without this an uninstalled jmux leaves every
   * agent on the machine invoking a binary that no longer exists.
   */
  uninstall(): { removed: boolean; paths: string[]; notes: string[] };
}
