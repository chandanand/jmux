import { resolve, dirname } from "path";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { homedir } from "os";
import type { AdapterConfig } from "./adapters/types";
import type { PanelView } from "./panel-view";
import type { TabEntry } from "./glass/tabs";
import type { RepoSettings } from "./repo-settings";
import type { UnparkTrigger } from "./parking";
import type { ScreenSignature } from "./agent-screen";
import type { ProjectConfig, ProjectSettings } from "./project";
import type { ProjectRoutes } from "./project-routing";
import { migrateLegacyConfig, canonicalizeRepoPath } from "./repo-settings";
import { logError } from "./log";
import { writeFileAtomicSync } from "./atomic-write";
import { migrateToProjects } from "./project-migration";

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
  /** Statuses whose sessions park. Empty by default, so parking is opt-in. */
  parkedStates?: string[];
  unparkOn?: UnparkTrigger[];
  autoParkIdleDays?: number | null;
  /** Confirmation policy for writes back to the issue tracker. */
  transitionConfirm?: "always" | "undo-toast" | "never";
  /** Ordered panel-view ids the "Up next" row pulls from. */
  upNext?: string[];
  /**
   * How many unstarted issues to show as ghost rows in the sidebar's Up next
   * band: a count, `"all"` for every one of them, or null/0 for none. The value
   * *is* the switch — there is no separate boolean that could disagree with it.
   * Off by default: the sidebar is otherwise a truthful mirror of tmux, and rows
   * for sessions that don't exist are something the user opts into.
   *
   * `"all"` is a literal rather than a magic number (-1, 0, Infinity) because it
   * has to survive a JSON round-trip and still say what it means to someone
   * reading the config file. `Infinity` in particular does not: JSON.stringify
   * writes it as `null`, which is this field's "off".
   */
  showUnstartedInSidebar?: number | "all" | null;
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

/**
 * Session titling. Global rather than per-repo: which model the user can reach
 * is a property of their machine, not of a repo.
 */
export interface SessionTitleConfig {
  /**
   * The argv jmux runs to name a session. It receives the prompt on stdin and
   * must print the name on stdout. Unset is off, and **the value is the
   * switch** — there is no separate boolean that could disagree with it.
   *
   * An array rather than a shell string so there is no quoting question and no
   * parser: `["claude", "-p", "--model", "haiku"]`, `["codex", "exec"]`,
   * `["ollama", "run", "qwen2.5"]`. Model choice is a flag the user already
   * controls, which is why jmux has no provider registry.
   */
  command?: string[];
  /** Hard bound on one naming call. */
  timeoutMs?: number;
  /**
   * Cap on a stored title. A *storage* cap, not a display one: a 26-column
   * sidebar shows around twenty characters and truncates, while the palette and
   * `ctl` have room for the whole thing. Capping at the sidebar's width would
   * throw away the words the wider surfaces exist to show.
   */
  maxChars?: number;
}

export interface JmuxConfig {
  /** See CONFIG_SCHEMA_VERSION. Absent on files written before it existed. */
  schemaVersion?: number;
  /**
   * One repo and at most one tracker team, each. Written by the migration off
   * `teamRepoMap`/`repos`, and by the Projects screen. Its presence is what
   * suppresses the migration, so a Project the user deleted stays deleted.
   */
  projects?: ProjectConfig[];
  /** The global settings tier that per-Project overrides sit on top of. */
  projectDefaults?: ProjectSettings;
  /** Learned routes. One table — two could disagree. */
  routes?: ProjectRoutes;
  /**
   * Declared intent about optional capabilities.
   *
   * "Derived, never stored" is right for machine truth — *is hunk installed* —
   * and wrong for preference, which no amount of filesystem inspection can
   * discover. Without this a user who will never connect a tracker is nagged by
   * a `todo` row and a toolbar dot forever.
   */
  setup?: {
    /** `never` removes the tracker steps and the dot; `later` only quiets the dot. */
    tracker?: "later" | "never";
    hunk?: "later" | "never";
    agentHooks?: "later" | "never";
  };
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
  /**
   * Derive agent state by reading pane text, for agents with no hook or
   * extension integration. Off by default: a screen signature can be
   * confidently wrong in a way a hook cannot, so it is opt-in.
   */
  agentScreenDetection?: boolean;
  /**
   * Extra screen signatures, merged ahead of the built-in table so a user entry
   * wins for the same command. Patterns are case-insensitive regex sources.
   */
  agentScreenSignatures?: ScreenSignature[];
  sessionTitle?: SessionTitleConfig;
  projectDirs?: string[];
  diffPanel?: {
    splitRatio?: number;
    hunkCommand?: string;
    /**
     * Launch hunk with `--watch` so the panel follows the working tree instead
     * of being a snapshot from whenever it opened. On by default; the only
     * reason to turn it off is a filesystem where hunk's watcher misbehaves.
     */
    watch?: boolean;
    /**
     * Launch hunk with `--transparent-bg` so the panel reads as part of jmux's
     * frame rather than a rectangle pasted onto it. On by default.
     */
    transparentBg?: boolean;
    /**
     * The hunk theme the panel is launched with.
     *
     * Unset — the default — follows the terminal background jmux detected at
     * startup, picking the same light/dark pair hunk's own `--theme auto`
     * would. jmux resolves it rather than passing `auto` because hunk's probe
     * gets no answer from inside the panel's pty and would always fall back to
     * dark; on a light terminal that leaves hunk's own text unreadable, and
     * `transparentBg` (on by default) makes it worse by removing the dark
     * surface that text was drawn for.
     *
     * A theme id pins the panel to that theme regardless of the terminal.
     * `false` passes no theme at all, which is the setting to use when hunk's
     * own config should decide — jmux otherwise overrides it, the same way it
     * already asserts `--transparent-bg` over hunk's config.
     */
    theme?: string | false;
    /**
     * Talk to hunk's session daemon for diff stats, review notes and the
     * review-to-agent send. On by default; off falls back to exactly the
     * behaviour jmux had before the daemon existed — a hunk pty and nothing
     * more — which is also what happens when no daemon answers.
     */
    controlPlane?: boolean;
    /**
     * Delete review notes from hunk once they have been sent to an agent, so
     * the note badge always means "written but not yet sent". Off keeps them as
     * a record, at the cost of every send re-sending everything.
     */
    clearNotesOnSend?: boolean;
  };
  adapters?: AdapterConfig;
  panelViews?: PanelView[];
  issueWorkflow?: IssueWorkflowConfig;
  snapshot?: SnapshotConfig;
  /** Per-state indicator colors (ANSI color names). */
  stateColors?: StateColorConfig;
  /** Sidebar grouping axis. Persists across restarts (filter deliberately does not). */
  sidebarGroupBy?: "none" | "project" | "status" | "stage";
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
  /** Inline image rendering in issue previews. */
  images?: ImagesConfig;
  /** Browser panes (Ctrl-a b), powered by terminal-browser. */
  browser?: BrowserConfig;
}

export interface BrowserConfig {
  /**
   * Fraction of the current pane a browser pane takes, 0.2–0.95.
   *
   * Wider than an even split by default. A browser is the thing you are
   * reading while the terminal beside it is the thing you are typing into, and
   * half of an area that is already short a sidebar leaves a page rendering in
   * a column.
   */
  paneSize?: number;
  /**
   * Device pixel ratio the browser renders at, or `"auto"` for its own default.
   *
   * This decides the CSS viewport, and so which layout a site chooses. Left to
   * itself terminal-browser uses the display's scale factor — 2 on a Mac — which
   * halves the viewport and puts a phone layout in a pane wide enough for a
   * desktop one. jmux asks for 1 instead, which is the same picture at the same
   * sharpness, laid out for the width it is actually being shown at.
   *
   * `"auto"` restores terminal-browser's own choice. A number forces one.
   */
  displayScale?: number | "auto";
  /**
   * Frames per second a browser pane renders at, or `"auto"` for its own.
   *
   * terminal-browser otherwise picks the fastest refresh rate among *all*
   * attached displays, so a single ProMotion laptop panel drives a pane on a
   * 60Hz external at 120fps. Each frame is a whole-canvas image the terminal
   * decodes and blits, and the stream does not stop when the page is static, so
   * the machine pays for it continuously — and a resize has to push through the
   * backlog before its own frames land, which is what makes catching up feel
   * slow. 60 is a no-op on a 60Hz display and a halving on a ProMotion one.
   */
  fps?: number | "auto";
  /**
   * Give each browser pane its own browser process. On by default.
   *
   * terminal-browser otherwise runs one process hosting a *session* per pane,
   * and derives its kitty image id from the process id — so every pane in a
   * jmux window transmits under the same id, and the terminal draws whichever
   * frame arrived last in all of them. Two browser panes show one page. The
   * sessions are genuinely separate underneath (separate tabs, separate input),
   * which is what makes it so confusing: only the picture is shared.
   *
   * jmux forces separation by handing each pane its own `XDG_RUNTIME_DIR`,
   * which is where terminal-browser keeps the daemon socket it would otherwise
   * attach to. The cost is real: the instance registry lives under that
   * directory too, so `terminal-browser ls` and `terminal-browser action` run
   * from another pane cannot see these browsers. Turn this off to trade working
   * multi-pane rendering for cross-pane agent control.
   *
   * The actual fix belongs upstream — an image id per session rather than per
   * process — at which point this can go.
   */
  isolate?: boolean;
  /**
   * Where a clicked link goes: the system browser, or a jmux browser pane.
   *
   * `"system"` by default, and deliberately so — links have opened in the
   * user's real browser for as long as jmux has rendered them, and silently
   * redirecting that would break every flow that depends on the browser you are
   * already signed into. `"pane"` reuses the browser pane in the current window
   * if there is one, and opens one otherwise.
   */
  openLinks?: "system" | "pane";
}

/** Fraction of the pane a browser split takes when the config doesn't say. */
export const DEFAULT_BROWSER_PANE_SIZE = 0.62;
/** Device pixel ratio a browser pane renders at when the config doesn't say. */
export const DEFAULT_BROWSER_DISPLAY_SCALE = 1;
/** Frame rate a browser pane renders at when the config doesn't say. */
export const DEFAULT_BROWSER_FPS = 60;

export interface ImagesConfig {
  /**
   * Force inline images on or off. Left unset, jmux asks the terminal whether
   * it speaks the kitty graphics protocol and believes the answer — which is
   * the right default, and this is the escape hatch for the terminal that
   * answers wrongly in either direction.
   *
   * Forcing this on does not make an incapable terminal draw pictures; it makes
   * it print the escape sequences. That is the user's call to make, not
   * something to guess at on their behalf.
   */
  enabled?: boolean;
  /**
   * Tallest an inline image may be, in terminal rows. The cap matters more than
   * the width one: a tall screenshot with no limit pushes every word of the
   * issue off the bottom of the pane, and the reader came for the issue.
   */
  maxRows?: number;
}

/** Rows an inline image may claim when the config doesn't say. */
export const DEFAULT_IMAGE_MAX_ROWS = 16;

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

/**
 * Stamped on every write, read for diagnostics and by migrations. Deliberately
 * NOT a gate: a multiplexer that refuses to attach because of a config file is
 * holding running work hostage, and unknown-key preservation (see
 * mergeConfigWithDefaults) already means a newer file survives an older jmux
 * intact rather than being destroyed by it.
 */
export const CONFIG_SCHEMA_VERSION = 1;

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
export class ConfigCorruptError extends Error {
  constructor(readonly path: string, readonly reason: string) {
    super(`config at ${path} is not valid JSON: ${reason}`);
    this.name = "ConfigCorruptError";
  }
}

export type ConfigRead =
  | { kind: "ok"; raw: JmuxConfig }
  | { kind: "missing" }
  | { kind: "corrupt"; error: string };

/**
 * Read the config file, distinguishing "absent" from "unparseable".
 *
 * These were one case for as long as the loader used `catch {}` and fell back
 * to defaults, which is what made a truncated file destructive: the next
 * setting change wrote defaults over a file that was only damaged. Absent is
 * normal and means defaults; corrupt means touch nothing.
 *
 * A non-object (array, scalar, null) is corrupt rather than ok. `JSON.parse`
 * accepts all of them and the spread in mergeConfigWithDefaults would silently
 * produce a config with none of the user's keys.
 */
export function readConfigFile(path: string): ConfigRead {
  if (!existsSync(path)) return { kind: "missing" };
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch (e) {
    return { kind: "corrupt", error: (e as Error).message };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { kind: "corrupt", error: (e as Error).message };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { kind: "corrupt", error: "expected a JSON object" };
  }
  return { kind: "ok", raw: parsed as JmuxConfig };
}

export function loadUserConfig(configPath?: string): JmuxConfig {
  const path = configPath ?? DEFAULT_CONFIG_PATH;
  const read = readConfigFile(path);
  if (read.kind === "corrupt") throw new ConfigCorruptError(path, read.error);
  const raw = read.kind === "ok" ? read.raw : {};
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
  private _lastWriteError: string | null = null;
  private _loadError: string | null = null;

  constructor(configPath?: string) {
    this.path = configPath ?? DEFAULT_CONFIG_PATH;
    const read = readConfigFile(this.path);
    // Throws rather than falling back: a corrupt file that loads as defaults is
    // one setting change away from being overwritten with them. main.ts catches
    // this above the alt screen and the tmux pty, so it can exit cleanly.
    if (read.kind === "corrupt") throw new ConfigCorruptError(this.path, read.error);
    const raw: JmuxConfig = read.kind === "ok" ? read.raw : {};
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
   * Why the last write failed, or null if it succeeded. Exposed so the UI can
   * say so: a persist that fails silently is how a user's setting change looks
   * applied on screen and is gone on the next launch.
   */
  get lastWriteError(): string | null {
    return this._lastWriteError;
  }

  /**
   * Why the last reload failed, or null. Non-null means the file on disk is
   * unparseable and memory holds the last version that wasn't.
   */
  get loadError(): string | null {
    return this._loadError;
  }

  /**
   * True while the on-disk file is corrupt. Writes are refused rather than
   * queued: persisting now would replace a file the user may still be able to
   * fix by hand with whatever jmux happens to hold in memory.
   */
  get writesDisabled(): boolean {
    return this._loadError !== null;
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
    const read = readConfigFile(this.path);
    if (read.kind === "corrupt") {
      // Deliberately does not throw: this runs from the fs.watch callback in a
      // live TUI, where a throw is an unhandled rejection. Startup can exit
      // cleanly (see the constructor); a running process has to degrade.
      this._loadError = read.error;
      return this.data;
    }
    const raw: JmuxConfig = read.kind === "ok" ? read.raw : {};
    const { config } = migrateLegacyConfig(raw);
    this.data = mergeConfigWithDefaults(config, defaultConfig);
    this._loadError = null;
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

  /**
   * One-time migration off `teamRepoMap` / `repoDefaults` / `repos`.
   *
   * Async and explicit rather than run from the constructor, because resolving
   * a directory to its git common dir spawns git — and the constructor is
   * reached from module scope in main.ts before anything can await.
   *
   * The complete new document is computed before anything is written, a
   * timestamped backup lands first, and the legacy keys are removed only after
   * the new file is durably on disk. Idempotent: `projects` existing is what
   * suppresses it, so a Project the user has since deleted is not re-created.
   */
  async migrateProjects(resolveCommonDir: (dir: string) => string | null | Promise<string | null>): Promise<boolean> {
    if (this.writesDisabled) return false;
    if (this.data.projects !== undefined) return false;

    const dirs = new Set<string>(Object.values(this.data.issueWorkflow?.teamRepoMap ?? {}));
    const resolved = new Map<string, string | null>();
    for (const d of dirs) resolved.set(d, await resolveCommonDir(d));

    const result = migrateToProjects(
      {
        repoDefaults: this.data.repoDefaults,
        repos: this.data.repos,
        issueWorkflow: this.data.issueWorkflow,
      },
      (d) => resolved.get(d) ?? null,
      canonicalizeRepoPath,
    );
    if (!result.changed) return false;

    // Before the rewrite, not after: the point is to survive a failure during
    // the write that follows.
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      writeFileAtomicSync(`${this.path}.backup-${stamp}`, JSON.stringify(this.data, null, 2) + "\n");
    } catch (e) {
      logError("ConfigStore", `migration backup failed, not migrating: ${(e as Error).message}`);
      return false;
    }

    this.data.projects = result.projects;
    if (result.globalDefaults) this.data.projectDefaults = result.globalDefaults;
    delete this.data.repoDefaults;
    delete this.data.repos;
    if (this.data.issueWorkflow) {
      delete this.data.issueWorkflow.teamRepoMap;
      if (Object.keys(this.data.issueWorkflow).length === 0) delete this.data.issueWorkflow;
    }
    return this.persist();
  }

  /**
   * Add or replace several Projects in one write.
   *
   * One `persist()` per Project means one temp file, two fsyncs and a rename
   * each — fine for a keystroke, wasteful for a resolver that may touch every
   * Project at once.
   */
  upsertProjects(projects: readonly ProjectConfig[]): void {
    if (projects.length === 0) return;
    const list = [...(this.data.projects ?? [])];
    for (const project of projects) {
      const at = list.findIndex((p) => p.id === project.id);
      if (at >= 0) list[at] = project;
      else list.push(project);
    }
    this.data.projects = list;
    this.persist();
  }

  /** Add or replace a Project by id. */
  upsertProject(project: ProjectConfig): void {
    const list = [...(this.data.projects ?? [])];
    const at = list.findIndex((p) => p.id === project.id);
    if (at >= 0) list[at] = project;
    else list.push(project);
    this.data.projects = list;
    this.persist();
  }

  /**
   * Soft delete, following t3code's `deleted_at`. A session still stamped with
   * this id must be able to report `orphaned` rather than silently re-routing
   * to whatever else claims its team.
   */
  deleteProject(id: string): void {
    const list = [...(this.data.projects ?? [])];
    const at = list.findIndex((p) => p.id === id);
    if (at < 0) return;
    list[at] = { ...list[at], deletedAt: new Date().toISOString() };
    this.data.projects = list;
    this.persist();
  }

  /**
   * Write one setting on one Project.
   *
   * Stored by key *presence*: `null` and values equal to the global default are
   * real overrides, and dropping either would erase intent the user cannot
   * express any other way.
   */
  setProjectSetting<K extends keyof ProjectSettings>(
    id: string,
    field: K,
    value: ProjectSettings[K],
  ): void {
    const list = [...(this.data.projects ?? [])];
    const at = list.findIndex((p) => p.id === id);
    if (at < 0) return;
    list[at] = { ...list[at], settings: { ...list[at].settings, [field]: value } };
    this.data.projects = list;
    this.persist();
  }

  /** Remove the key entirely, so the row falls back to the global tier. */
  clearProjectSetting(id: string, field: keyof ProjectSettings): void {
    const list = [...(this.data.projects ?? [])];
    const at = list.findIndex((p) => p.id === id);
    if (at < 0) return;
    const settings = { ...list[at].settings };
    delete settings[field];
    list[at] = { ...list[at], settings };
    this.data.projects = list;
    this.persist();
  }

  setProjectDefault<K extends keyof ProjectSettings>(field: K, value: ProjectSettings[K]): void {
    this.data.projectDefaults = { ...this.data.projectDefaults, [field]: value };
    this.persist();
  }

  /** Record a declared preference about an optional capability. */
  setSetupIntent(key: "tracker" | "hunk" | "agentHooks", value: "later" | "never" | null): void {
    const setup = { ...this.data.setup };
    if (value === null) delete setup[key];
    else setup[key] = value;
    this.data.setup = setup;
    this.persist();
  }

  setRoute(kind: "issue" | "linearProject", key: string, projectId: string): void {
    const routes = { ...this.data.routes };
    routes[kind] = { ...routes[kind], [key]: projectId };
    this.data.routes = routes;
    this.persist();
  }

  clearRoute(kind: "issue" | "linearProject", key: string): void {
    const routes = { ...this.data.routes };
    const table = { ...routes[kind] };
    delete table[key];
    routes[kind] = table;
    this.data.routes = routes;
    this.persist();
  }

  private persist(): boolean {
    if (this.writesDisabled) return false;
    // Never lower a higher stamp: a newer jmux wrote it, this one migrated
    // nothing, and claiming its own version would misdescribe the contents.
    if ((this.data.schemaVersion ?? 0) < CONFIG_SCHEMA_VERSION) {
      this.data.schemaVersion = CONFIG_SCHEMA_VERSION;
    }
    try {
      writeFileAtomicSync(this.path, JSON.stringify(this.data, null, 2) + "\n");
      this._lastWriteError = null;
      return true;
    } catch (e) {
      this._lastWriteError = (e as Error).message;
      logError("ConfigStore", `persist failed: ${this._lastWriteError}`);
      return false;
    }
  }
}
