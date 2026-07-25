import { resolve, dirname } from "path";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { homedir } from "os";
import type { AdapterConfig } from "./adapters/types";
import type { PanelView } from "./panel-view";
import type { TabEntry } from "./glass/tabs";
import type { RepoSettings, WorkStage } from "./repo-settings";
import type { UnparkTrigger } from "./parking";
import { migrateLegacyConfig } from "./repo-settings";
import { logError } from "./log";

/**
 * Cross-repo routing only. Everything that is a property of a *repo* rather
 * than of the workspace now lives in `repoDefaults` / `repos` — see
 * docs/adr/0004-per-repo-settings-keyed-on-repo-root.md. `teamRepoMap` stays
 * here because it is precisely the index that maps a tracker team onto a repo,
 * so it cannot itself be per-repo.
 */
export interface IssueWorkflowConfig {
  teamRepoMap?: Record<string, string>;  // Linear team name → repo directory
}

/**
 * Global pipeline behaviour. Deliberately NOT per-repo: which stages park and
 * what unparks them are properties of how the user works, and mixing "parked
 * in repo A but not repo B" produces an incoherent single sidebar. What a
 * *state* means per repo lives in RepoSettings instead.
 */
export interface PipelineConfig {
  parkStages?: WorkStage[];
  unparkOn?: UnparkTrigger[];
  autoParkIdleDays?: number | null;
  /** Confirmation policy for writes back to the issue tracker. */
  transitionConfirm?: "always" | "undo-toast" | "never";
  /** Ordered panel-view ids the "Up next" row pulls from. */
  upNext?: string[];
}

export interface SnapshotConfig {
  enabled: boolean;
  scrollbackIntervalMs: number;
  scrollbackMaxBytes: number;
  dir: string | null;
}

/**
 * Agent-state indicator colors, stored as ANSI color names (e.g. "green") or
 * the special value "neutral" (a finished agent recedes rather than taking
 * on a palette color). Resolution + validation lives in state-colors.ts; any
 * unset or invalid name falls back to that state's default there.
 */
export interface StateColorConfig {
  running?: string;
  waiting?: string;
  complete?: string;
}

export interface JmuxConfig {
  sidebarWidth?: number;
  infoPanelWidth?: number;
  /** Info panel list/detail split, as a fraction of the splittable rows. */
  infoPanelSplitRatio?: number;
  cacheTimers?: boolean;
  windowBranches?: boolean;
  pinnedSessions?: string[];
  /** Auto-surface every detected Claude/Codex pane on the Command Center. */
  autoPinAgentPanes?: boolean;
  /** Case-insensitive regex matched against pane_current_command for auto-pin (e.g. Codex). */
  agentPaneCommandRegex?: string;
  projectDirs?: string[];
  diffPanel?: {
    splitRatio?: number;
    hunkCommand?: string;
  };
  adapters?: AdapterConfig;
  panelViews?: PanelView[];
  issueWorkflow?: IssueWorkflowConfig;
  snapshot?: SnapshotConfig;
  /** Per-state indicator colors (ANSI color names). */
  stateColors?: StateColorConfig;
  /** Sidebar grouping axis. Persists across restarts (filter deliberately does not). */
  sidebarGroupBy?: "none" | "project" | "status";
  /** Sidebar member-sort axis. Persists across restarts. */
  sidebarSortBy?: "name" | "activity" | "status";
  /** @deprecated Pre-split single sort axis; read once to migrate onto
   * sidebarGroupBy + sidebarSortBy, then never written again. */
  sidebarSort?: "project" | "status" | "activity" | "name";
  /** Ordered Command Center tab registry; index 0 is the protected default. */
  commandCenterTabs?: TabEntry[];
  /** Global defaults for per-repo workflow settings. */
  repoDefaults?: RepoSettings;
  /** Per-repo overrides, keyed by canonical repo root (git common dir). */
  repos?: Record<string, RepoSettings>;
  /** Global pipeline behaviour (parking, transition confirmation, queues). */
  pipeline?: PipelineConfig;
}

/**
 * tmux silently rewrites '.' and ':' in session names to '_'. If we let them
 * through, the session is created under the rewritten name but follow-up
 * commands like `switch-client -t name` parse '.' / ':' as window/pane
 * separators and fail with a misleading "can't find pane: X" error. Mirror
 * tmux's sanitization here so callers and tmux agree on the final name.
 */
export function sanitizeTmuxSessionName(name: string): string {
  const cleaned = name.replace(/[.:]/g, "_");
  // Reserve the jmux-internal prefix so user sessions can never collide with
  // the pane-of-glass holding/park/tile sessions. Collapse a leading underscore
  // run to one so "__jmux_glass" → "_jmux_glass" (no longer internal).
  if (cleaned.startsWith("__jmux_")) {
    return cleaned.replace(/^_+/, "_");
  }
  return cleaned;
}

/**
 * Build the OTEL_RESOURCE_ATTRIBUTES value for a given tmux session name.
 */
export function buildOtelResourceAttrs(sessionName: string): string {
  return `tmux_session_name=${sessionName}`;
}

const DEFAULT_CONFIG_PATH = resolve(homedir(), ".config", "jmux", "config.json");

export const defaultConfig: JmuxConfig = {
  snapshot: {
    enabled: true,
    scrollbackIntervalMs: 5000,
    scrollbackMaxBytes: 2 * 1024 * 1024,
    dir: null,
  },
};

/**
 * Deep merge a partial snapshot config with defaults.
 * Preserves default values for fields not provided in the partial config.
 */
function mergeSnapshot(
  defaults: SnapshotConfig,
  partial: Partial<SnapshotConfig> | undefined,
): SnapshotConfig {
  if (!partial) return { ...defaults };
  return {
    enabled: partial.enabled ?? defaults.enabled,
    scrollbackIntervalMs: partial.scrollbackIntervalMs ?? defaults.scrollbackIntervalMs,
    scrollbackMaxBytes: partial.scrollbackMaxBytes ?? defaults.scrollbackMaxBytes,
    dir: partial.dir ?? defaults.dir,
  };
}

/**
 * Merge user config with defaults, handling nested objects.
 * Shallow merge at the top level, but deep merge known nested configs.
 */
function mergeConfigWithDefaults(userConfig: JmuxConfig, defaults: JmuxConfig): JmuxConfig {
  const merged: JmuxConfig = { ...defaults, ...userConfig };

  // Deep merge snapshot config
  if (defaults.snapshot) {
    merged.snapshot = mergeSnapshot(defaults.snapshot, userConfig.snapshot);
  }

  return merged;
}

/**
 * Load jmux user config from ~/.config/jmux/config.json.
 * Merges with defaults to ensure all required fields are present.
 * Returns merged config, or just defaults if the file is missing or unparseable.
 */
export function loadUserConfig(configPath?: string): JmuxConfig {
  const path = configPath ?? DEFAULT_CONFIG_PATH;
  let raw: JmuxConfig = {};
  try {
    if (existsSync(path)) {
      raw = JSON.parse(readFileSync(path, "utf-8")) as JmuxConfig;
    }
  } catch {
    // Invalid config — use defaults
  }
  const { config } = migrateLegacyConfig(raw);
  return mergeConfigWithDefaults(config, defaultConfig);
}

/**
 * Centralized config store that owns both the in-memory config and
 * disk persistence. Eliminates the dual-state problem where some
 * settings updated in-memory while others only wrote to disk.
 */
export class ConfigStore {
  private data: JmuxConfig;
  private readonly path: string;

  constructor(configPath?: string) {
    this.path = configPath ?? DEFAULT_CONFIG_PATH;
    let raw: JmuxConfig = {};
    try {
      if (existsSync(this.path)) {
        raw = JSON.parse(readFileSync(this.path, "utf-8")) as JmuxConfig;
      }
    } catch {
      // Invalid config — use defaults
    }
    // Rewrite the file once when the on-disk shape predates repoDefaults/repos,
    // so no consumption site ever has to check two locations for a field.
    const { config, changed } = migrateLegacyConfig(raw);
    this.data = mergeConfigWithDefaults(config, defaultConfig);
    if (changed) this.persist();
  }

  /** Current in-memory config snapshot. */
  get config(): Readonly<JmuxConfig> {
    return this.data;
  }

  /** Path to the config file on disk. */
  get configPath(): string {
    return this.path;
  }

  /**
   * Set a top-level config key and persist to disk.
   * Updates in-memory state first, then writes to disk.
   */
  set<K extends keyof JmuxConfig>(key: K, value: JmuxConfig[K]): void {
    this.data[key] = value;
    this.persist();
  }

  /**
   * Delete a top-level config key and persist to disk.
   */
  delete<K extends keyof JmuxConfig>(key: K): void {
    delete this.data[key];
    this.persist();
  }

  /**
   * Merge a partial config into the current state and persist.
   * Shallow merge at the top level — nested objects are replaced, not deep-merged.
   */
  merge(partial: Partial<JmuxConfig>): void {
    Object.assign(this.data, partial);
    this.persist();
  }

  /**
   * Set a workflow setting (issueWorkflow sub-key) and persist.
   */
  setWorkflow<K extends keyof IssueWorkflowConfig>(key: K, value: IssueWorkflowConfig[K]): void {
    if (!this.data.issueWorkflow) this.data.issueWorkflow = {};
    this.data.issueWorkflow[key] = value;
    this.persist();
  }

  /** Set a global pipeline setting and persist. */
  setPipeline<K extends keyof PipelineConfig>(key: K, value: PipelineConfig[K]): void {
    if (!this.data.pipeline) this.data.pipeline = {};
    this.data.pipeline[key] = value;
    this.persist();
  }

  /** Set a global repo-default and persist. */
  setRepoDefault<K extends keyof RepoSettings>(key: K, value: RepoSettings[K]): void {
    if (!this.data.repoDefaults) this.data.repoDefaults = {};
    this.data.repoDefaults[key] = value;
    this.persist();
  }

  /** Set a per-repo override and persist. */
  setRepoOverride<K extends keyof RepoSettings>(repoKey: string, key: K, value: RepoSettings[K]): void {
    if (!this.data.repos) this.data.repos = {};
    if (!this.data.repos[repoKey]) this.data.repos[repoKey] = {};
    this.data.repos[repoKey]![key] = value;
    this.persist();
  }

  /** Clear a per-repo override, pruning emptied entries/containers, and persist. */
  clearRepoOverride(repoKey: string, key: keyof RepoSettings): void {
    const entry = this.data.repos?.[repoKey];
    if (!entry) return;
    delete entry[key];
    if (Object.keys(entry).length === 0) delete this.data.repos![repoKey];
    if (this.data.repos && Object.keys(this.data.repos).length === 0) delete this.data.repos;
    this.persist();
  }

  /**
   * Set or remove a team → repo mapping and persist.
   */
  setTeamRepo(team: string, repoDir: string | null): void {
    if (!this.data.issueWorkflow) this.data.issueWorkflow = {};
    if (!this.data.issueWorkflow.teamRepoMap) this.data.issueWorkflow.teamRepoMap = {};
    if (repoDir === null) {
      delete this.data.issueWorkflow.teamRepoMap[team];
    } else {
      this.data.issueWorkflow.teamRepoMap[team] = repoDir;
    }
    this.persist();
  }

  /**
   * Set an adapter config entry (codeHost or issueTracker) and persist.
   * Pass null to remove the entry.
   */
  setAdapter(key: "codeHost" | "issueTracker", value: { type: string } | null): void {
    if (!this.data.adapters) this.data.adapters = {};
    if (value === null) {
      delete this.data.adapters[key];
    } else {
      this.data.adapters[key] = value;
    }
    // Clean up empty adapters object
    if (this.data.adapters && Object.keys(this.data.adapters).length === 0) {
      delete this.data.adapters;
    }
    this.persist();
  }

  /**
   * Upsert a panel view and persist.
   */
  saveView(view: PanelView): void {
    if (!this.data.panelViews) this.data.panelViews = [];
    const idx = this.data.panelViews.findIndex(v => v.id === view.id);
    if (idx >= 0) {
      this.data.panelViews[idx] = view;
    } else {
      this.data.panelViews.push(view);
    }
    this.persist();
  }

  /**
   * Reload config from disk. Used by file watchers to pick up
   * external changes. Returns the new config.
   */
  reload(): JmuxConfig {
    this.data = loadUserConfig(this.path);
    return this.data;
  }

  /**
   * Ensure the config file exists (for first-run).
   * Creates the directory and an empty JSON file if needed.
   */
  ensureExists(): boolean {
    if (existsSync(this.path)) return false;
    const dir = dirname(this.path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(this.path, JSON.stringify({}, null, 2) + "\n");
    return true;
  }

  private persist(): void {
    try {
      const dir = dirname(this.path);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(this.path, JSON.stringify(this.data, null, 2) + "\n");
    } catch (e) {
      logError("ConfigStore", `persist failed: ${(e as Error).message}`);
    }
  }
}
