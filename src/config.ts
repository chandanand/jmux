import { resolve, dirname } from "path";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { homedir } from "os";
import type { AdapterConfig } from "./adapters/types";
import type { PanelView } from "./panel-view";
import type { RepoSettings } from "./repo-settings";
import type { UnparkTrigger } from "./parking";
import type { ScreenSignature } from "./agent-screen";
import { migrateLegacyConfig } from "./repo-settings";
import { logError } from "./log";
import type { CommandCenterAxes, CommandCenterView } from "./glass/views";
import { normalizeViews, normalizeAxes, resolveActiveViewId } from "./glass/views";
import { DEFAULT_MAX_CLIENTS } from "./glass/view";

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
  sidebarWidth?: number;
  infoPanelWidth?: number;
  /** Info panel list/detail split, as a fraction of the splittable rows. */
  infoPanelSplitRatio?: number;
  cacheTimers?: boolean;
  windowBranches?: boolean;
  pinnedSessions?: string[];
  /**
   * Case-insensitive regex matched against `pane_current_command` to decide
   * which panes are worth *electing* as a session's Command Center face
   * (`eligiblePanes`, `glass/representative.ts`) — the last-resort signal for
   * an agent that declares no `@jmux-agent-kind`.
   */
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
  /** Ordered Command Center view registry; never empty after normalize. */
  commandCenterViews?: CommandCenterView[];
  /** The active view id, clamped to an existing view. */
  commandCenterActiveViewId?: string;
  /**
   * The live, possibly-dirty grid axes — filter, groupBy, sortBy. Unlike the
   * sidebar's own filter, which is a transient narrowing of a list that is
   * always on screen and deliberately does not persist (see `sidebarGroupBy`
   * just above — "filter deliberately does not"), the grid's filter *is* its
   * membership rule and half of what a saved view means, so the whole axes
   * struct persists here.
   */
  commandCenterAxes?: CommandCenterAxes;
  /** Command Center grid settings not part of a view. */
  commandCenter?: CommandCenterConfig;
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

/** Command Center grid settings that belong to the grid itself, not to any one view. */
export interface CommandCenterConfig {
  /**
   * Cap on live tmux mirror clients the grid keeps attached at once
   * (`GlassViewOptions.maxClients`, `glass/tile-plan.ts`). `planTiles` floors
   * this at 1 regardless of what's stored here, so a mistyped 0 can't blank
   * the grid.
   */
  maxTiles?: number;
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
 * One-time, idempotent Command Center migration: seeds `commandCenterViews` /
 * `commandCenterActiveViewId` / `commandCenterAxes` / `commandCenter.maxTiles`
 * when the on-disk shape predates views. Pure: returns the new object plus
 * whether anything changed (the caller persists only when changed), the same
 * contract as `migrateLegacyConfig`.
 *
 * Also drops `commandCenterTabs` and `autoPinAgentPanes` from disk. Both were
 * kept on a previous pass because `main.ts` and `cli/cc.ts` still read them —
 * deleting the key before they moved off it would have silently folded every
 * named tab back to the default. Now that neither reader exists, the key
 * itself is dead weight: `persist()` writes the whole loaded object back
 * (`config.ts:551`), so a dropped TS field alone would never stop either key
 * from re-appearing on the next save.
 */
export function migrateCommandCenterConfig(raw: any): { config: any; changed: boolean } {
  const config = { ...(raw ?? {}) };
  let changed = false;

  if ("commandCenterTabs" in config) {
    delete config.commandCenterTabs;
    changed = true;
  }
  if ("autoPinAgentPanes" in config) {
    delete config.autoPinAgentPanes;
    changed = true;
  }

  // Absence alone is never a reason to flip `changed`: a config with no
  // Command Center history at all (the common case — a brand-new install, or
  // a long-time user who never touched the grid) must not force a disk write
  // the instant `ConfigStore` is constructed. `main.ts` builds it at module
  // scope and only checks `ensureExists()` much later, at first-run — an
  // eager write here would create the file before that check ever runs and
  // permanently hide the setup checklist. So the seeded value always lands in
  // the *returned* config (every consumer sees it), but only a field that was
  // PRESENT and wrong earns a rewrite, the same bar `migrateLegacyConfig`
  // already holds for `{}`.
  const hadViews = config.commandCenterViews !== undefined;
  const rawViews = config.commandCenterViews;
  const views = normalizeViews(rawViews);
  config.commandCenterViews = views;
  if (hadViews && JSON.stringify(rawViews) !== JSON.stringify(views)) changed = true;

  const hadActiveId = config.commandCenterActiveViewId !== undefined;
  const rawActiveId = config.commandCenterActiveViewId;
  const activeViewId = resolveActiveViewId(rawActiveId, views);
  config.commandCenterActiveViewId = activeViewId;
  if (hadActiveId && rawActiveId !== activeViewId) changed = true;

  const activeView = views.find((v) => v.id === activeViewId)!;
  const hadAxes = config.commandCenterAxes !== undefined;
  const rawAxes = config.commandCenterAxes;
  const axes = normalizeAxes(rawAxes, activeView);
  config.commandCenterAxes = axes;
  if (hadAxes && JSON.stringify(rawAxes) !== JSON.stringify(axes)) changed = true;

  const rawMaxTiles = config.commandCenter?.maxTiles;
  const hadMaxTiles = rawMaxTiles !== undefined;
  const maxTilesValid = typeof rawMaxTiles === "number" && Number.isFinite(rawMaxTiles) && rawMaxTiles >= 1;
  config.commandCenter = {
    ...(config.commandCenter ?? {}),
    maxTiles: maxTilesValid ? rawMaxTiles : DEFAULT_MAX_CLIENTS,
  };
  if (hadMaxTiles && !maxTilesValid) changed = true;

  return { config, changed };
}

/** Compose every one-time top-level config migration into a single pass. */
function migrateAll(raw: JmuxConfig): { config: JmuxConfig; changed: boolean } {
  const legacy = migrateLegacyConfig(raw);
  const cc = migrateCommandCenterConfig(legacy.config);
  return { config: cc.config, changed: legacy.changed || cc.changed };
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
  const { config } = migrateAll(raw);
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
    // Rewrite the file once when the on-disk shape predates repoDefaults/repos
    // or Command Center views, so no consumption site ever has to check two
    // locations for a field.
    const { config, changed } = migrateAll(raw);
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
