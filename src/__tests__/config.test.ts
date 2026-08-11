import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  sanitizeTmuxSessionName, buildOtelResourceAttrs, loadUserConfig, ConfigStore, defaultConfig,
  migrateCommandCenterConfig,
} from "../config";
import { writeFileSync, unlinkSync, existsSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { DEFAULT_MAX_CLIENTS } from "../glass/view";
import { DEFAULT_VIEW_SEED_ID, DEFAULT_VIEW_SEED_NAME } from "../glass/views";

describe("sanitizeTmuxSessionName", () => {
  test("replaces dots with underscores", () => {
    expect(sanitizeTmuxSessionName("my.project")).toBe("my_project");
  });

  test("replaces colons with underscores", () => {
    expect(sanitizeTmuxSessionName("my:project")).toBe("my_project");
  });

  test("replaces mixed dots and colons", () => {
    expect(sanitizeTmuxSessionName("a.b:c.d")).toBe("a_b_c_d");
  });

  test("leaves clean names unchanged", () => {
    expect(sanitizeTmuxSessionName("my-project")).toBe("my-project");
    expect(sanitizeTmuxSessionName("myproject")).toBe("myproject");
    expect(sanitizeTmuxSessionName("my_project")).toBe("my_project");
  });

  test("handles empty string", () => {
    expect(sanitizeTmuxSessionName("")).toBe("");
  });
});

describe("buildOtelResourceAttrs", () => {
  test("returns correct format", () => {
    expect(buildOtelResourceAttrs("my-session")).toBe("tmux_session_name=my-session");
  });

  test("includes sanitized session name as-is", () => {
    expect(buildOtelResourceAttrs("my_project")).toBe("tmux_session_name=my_project");
  });
});

describe("loadUserConfig", () => {
  test("returns defaults for nonexistent path", () => {
    const result = loadUserConfig("/nonexistent/path/config.json");
    expect(result.snapshot).toBeDefined();
    expect(result.snapshot?.enabled).toBe(true);
  });

  test("returns defaults for directory that does not exist", () => {
    const result = loadUserConfig("/tmp/__jmux_does_not_exist__/config.json");
    expect(result.snapshot).toBeDefined();
    expect(result.snapshot?.enabled).toBe(true);
  });
});

describe("loadUserConfig adapter config", () => {
  test("parses adapter config from valid JSON", () => {
    const tmpPath = `/tmp/jmux-test-config-${Date.now()}.json`;
    const config = {
      sidebarWidth: 30,
      adapters: {
        codeHost: { type: "gitlab" },
        issueTracker: { type: "linear" },
      },
    };
    writeFileSync(tmpPath, JSON.stringify(config));
    const result = loadUserConfig(tmpPath);
    expect(result.adapters).toBeDefined();
    expect(result.adapters!.codeHost!.type).toBe("gitlab");
    expect(result.adapters!.issueTracker!.type).toBe("linear");
    unlinkSync(tmpPath);
  });

  test("returns undefined adapters when not configured", () => {
    const tmpPath = `/tmp/jmux-test-config-${Date.now()}.json`;
    writeFileSync(tmpPath, JSON.stringify({ sidebarWidth: 26 }));
    const result = loadUserConfig(tmpPath);
    expect(result.adapters).toBeUndefined();
    unlinkSync(tmpPath);
  });
});

describe("migrateCommandCenterConfig", () => {
  test("seeds the view registry alongside unrelated keys, leaving them untouched", () => {
    const { config, changed } = migrateCommandCenterConfig({
      sidebarWidth: 30,
    });
    expect(changed).toBe(false); // nothing present-but-wrong; seeding alone never dirties
    expect(config.sidebarWidth).toBe(30); // untouched
    expect(config.commandCenterViews).toEqual([
      { id: DEFAULT_VIEW_SEED_ID, name: DEFAULT_VIEW_SEED_NAME, filter: "active", groupBy: "status", sortBy: "status" },
    ]);
    expect(config.commandCenterActiveViewId).toBe(DEFAULT_VIEW_SEED_ID);
    expect(config.commandCenterAxes).toEqual({ filter: "active", groupBy: "status", sortBy: "status" });
    expect(config.commandCenter).toEqual({ maxTiles: DEFAULT_MAX_CLIENTS });
  });

  // Transitional invariant, not a permanent guarantee: `commandCenterTabs` and
  // `autoPinAgentPanes` are dead in the target design but still read by live
  // code — `main.ts` builds the tab registry from `commandCenterTabs` via
  // `normalizeTabs`, and `autoPinAgentPanes` gates whether agent panes are
  // unioned into Command Center membership. Deleting either here before that
  // code moves would be a silent regression: named tabs collapsing to the
  // default, auto-pin quietly turning off. This test is deleted in phase 9
  // (`main.ts`/`cli/cc.ts` off `commandCenterTabs`; `autoPinAgentPanes`
  // retired) — its deletion is the signal that the transition finished, not
  // a loosening of coverage.
  test("leaves commandCenterTabs and autoPinAgentPanes untouched — main.ts still reads both", () => {
    const raw = {
      commandCenterTabs: [{ id: "default", name: "Main" }, { id: "backend", name: "Backend" }],
      autoPinAgentPanes: true,
    };
    const { config, changed } = migrateCommandCenterConfig(raw);
    expect(config.commandCenterTabs).toEqual(raw.commandCenterTabs);
    expect(config.autoPinAgentPanes).toBe(true);
    // Seeding the new fields alone still shouldn't dirty an otherwise-fine config.
    expect(changed).toBe(false);
  });

  test("populates every new field in-memory from nothing, but reports no change", () => {
    // Absence alone must not flip `changed` — see the ConfigStore test below:
    // a `changed:true` here would make the constructor persist immediately,
    // before main.ts's ensureExists() ever runs, which would permanently hide
    // the first-run setup checklist for every brand-new install.
    const { config, changed } = migrateCommandCenterConfig({});
    expect(changed).toBe(false);
    expect(config.commandCenterViews).toHaveLength(1);
    expect(config.commandCenterActiveViewId).toBe(DEFAULT_VIEW_SEED_ID);
    expect(config.commandCenter?.maxTiles).toBe(DEFAULT_MAX_CLIENTS);
  });

  test("clamps an illegal live axis to the active view's own value", () => {
    const { config } = migrateCommandCenterConfig({
      commandCenterViews: [
        { id: "v1", name: "V1", filter: "all", groupBy: "project", sortBy: "name" },
      ],
      commandCenterActiveViewId: "v1",
      commandCenterAxes: { filter: "bogus", groupBy: "project", sortBy: "name" },
    });
    expect(config.commandCenterAxes).toEqual({ filter: "all", groupBy: "project", sortBy: "name" });
  });

  test("clamps a vanished active view id to the first view", () => {
    const { config } = migrateCommandCenterConfig({
      commandCenterViews: [
        { id: "v1", name: "V1", filter: "all", groupBy: "project", sortBy: "name" },
      ],
      commandCenterActiveViewId: "ghost",
    });
    expect(config.commandCenterActiveViewId).toBe("v1");
  });

  test("is idempotent — an already-migrated config reports no change", () => {
    const migrated = {
      commandCenterViews: [
        { id: DEFAULT_VIEW_SEED_ID, name: DEFAULT_VIEW_SEED_NAME, filter: "active", groupBy: "status", sortBy: "status" },
      ],
      commandCenterActiveViewId: DEFAULT_VIEW_SEED_ID,
      commandCenterAxes: { filter: "active", groupBy: "status", sortBy: "status" },
      commandCenter: { maxTiles: DEFAULT_MAX_CLIENTS },
    };
    const { changed } = migrateCommandCenterConfig(migrated);
    expect(changed).toBe(false);
  });

  test("a mistyped/invalid maxTiles is replaced with the default", () => {
    const { config, changed } = migrateCommandCenterConfig({ commandCenter: { maxTiles: 0 } });
    expect(changed).toBe(true);
    expect(config.commandCenter.maxTiles).toBe(DEFAULT_MAX_CLIENTS);
  });
});

describe("ConfigStore", () => {
  let tmpDir: string;
  let cfgPath: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `jmux-config-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
    cfgPath = join(tmpDir, "config.json");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("initializes with defaults when file missing", () => {
    const store = new ConfigStore(cfgPath);
    expect(store.config.snapshot?.enabled).toBe(true);
    expect(store.config.snapshot?.scrollbackIntervalMs).toBe(5000);
  });

  test("loads existing config from disk", () => {
    writeFileSync(cfgPath, JSON.stringify({ sidebarWidth: 30, agentPaneCommandRegex: "cc" }));
    const store = new ConfigStore(cfgPath);
    expect(store.config.sidebarWidth).toBe(30);
    expect(store.config.agentPaneCommandRegex).toBe("cc");
  });

  test("set persists to disk and updates in-memory", () => {
    const store = new ConfigStore(cfgPath);
    store.set("sidebarWidth", 40);
    expect(store.config.sidebarWidth).toBe(40);

    // Verify on disk
    const fromDisk = JSON.parse(require("fs").readFileSync(cfgPath, "utf-8"));
    expect(fromDisk.sidebarWidth).toBe(40);
  });

  test("set preserves other keys", () => {
    writeFileSync(cfgPath, JSON.stringify({ sidebarWidth: 30, agentPaneCommandRegex: "cc" }));
    const store = new ConfigStore(cfgPath);
    store.set("sidebarWidth", 40);
    expect(store.config.agentPaneCommandRegex).toBe("cc");
  });

  test("delete removes key and persists", () => {
    writeFileSync(cfgPath, JSON.stringify({ sidebarWidth: 30, agentPaneCommandRegex: "cc" }));
    const store = new ConfigStore(cfgPath);
    store.delete("agentPaneCommandRegex");
    expect(store.config.agentPaneCommandRegex).toBeUndefined();

    const fromDisk = JSON.parse(require("fs").readFileSync(cfgPath, "utf-8"));
    expect(fromDisk.agentPaneCommandRegex).toBeUndefined();
  });

  test("merge shallow-merges and persists", () => {
    writeFileSync(cfgPath, JSON.stringify({ sidebarWidth: 30 }));
    const store = new ConfigStore(cfgPath);
    store.merge({ agentPaneCommandRegex: "cc", cacheTimers: false });
    expect(store.config.sidebarWidth).toBe(30);
    expect(store.config.agentPaneCommandRegex).toBe("cc");
    expect(store.config.cacheTimers).toBe(false);
  });

  test("setWorkflow creates issueWorkflow if missing", () => {
    const store = new ConfigStore(cfgPath);
    store.setWorkflow("teamRepoMap", { core: "/code/core" });
    expect(store.config.issueWorkflow?.teamRepoMap?.core).toBe("/code/core");

    const fromDisk = JSON.parse(require("fs").readFileSync(cfgPath, "utf-8"));
    expect(fromDisk.issueWorkflow.teamRepoMap.core).toBe("/code/core");
  });

  test("loadUserConfig migrates legacy fields into repoDefaults", () => {
    writeFileSync(cfgPath, JSON.stringify({
      claudeCommand: "cc",
      issueWorkflow: { defaultBaseBranch: "develop", teamRepoMap: { core: "/c" } },
    }));
    const store = new ConfigStore(cfgPath);
    expect(store.config.repoDefaults?.claudeCommand).toBe("cc");
    expect(store.config.repoDefaults?.defaultBaseBranch).toBe("develop");
    expect(store.config.issueWorkflow?.teamRepoMap?.core).toBe("/c");
    // migration persisted to disk
    const onDisk = JSON.parse(require("fs").readFileSync(cfgPath, "utf-8"));
    expect(onDisk.claudeCommand).toBeUndefined();
    expect(onDisk.repoDefaults.claudeCommand).toBe("cc");
  });

  // Transitional — see the same-titled note on migrateCommandCenterConfig's
  // own test above. Deleted in phase 9 once main.ts/cli/cc.ts no longer read
  // either key.
  test("loadUserConfig leaves commandCenterTabs and autoPinAgentPanes on disk untouched", () => {
    writeFileSync(cfgPath, JSON.stringify({
      commandCenterTabs: [{ id: "default", name: "Main" }, { id: "backend", name: "Backend" }],
      autoPinAgentPanes: true,
    }));
    const store = new ConfigStore(cfgPath);
    expect(store.config.commandCenterTabs).toEqual([
      { id: "default", name: "Main" }, { id: "backend", name: "Backend" },
    ]);
    expect(store.config.autoPinAgentPanes).toBe(true);
    expect(store.config.commandCenterViews).toHaveLength(1);
    expect(store.config.commandCenterActiveViewId).toBe(DEFAULT_VIEW_SEED_ID);
    expect(store.config.commandCenterAxes).toEqual({ filter: "active", groupBy: "status", sortBy: "status" });
    expect(store.config.commandCenter?.maxTiles).toBe(DEFAULT_MAX_CLIENTS);
  });

  test("loadUserConfig repairs a present-but-invalid Command Center config and persists once", () => {
    writeFileSync(cfgPath, JSON.stringify({
      commandCenterViews: [
        { id: "v1", name: "V1", filter: "all", groupBy: "project", sortBy: "name" },
      ],
      commandCenterActiveViewId: "ghost", // vanished — must clamp to v1
      commandCenterAxes: { filter: "bogus", groupBy: "project", sortBy: "name" },
      commandCenter: { maxTiles: 0 }, // invalid — must fall back to the default
    }));
    const store = new ConfigStore(cfgPath);
    expect(store.config.commandCenterActiveViewId).toBe("v1");
    expect(store.config.commandCenterAxes).toEqual({ filter: "all", groupBy: "project", sortBy: "name" });
    expect(store.config.commandCenter?.maxTiles).toBe(DEFAULT_MAX_CLIENTS);

    const onDisk = JSON.parse(require("fs").readFileSync(cfgPath, "utf-8"));
    expect(onDisk.commandCenterActiveViewId).toBe("v1");
    expect(onDisk.commandCenterAxes).toEqual({ filter: "all", groupBy: "project", sortBy: "name" });
    expect(onDisk.commandCenter.maxTiles).toBe(DEFAULT_MAX_CLIENTS);
  });

  test("setRepoDefault writes under repoDefaults and persists", () => {
    const store = new ConfigStore(cfgPath);
    store.setRepoDefault("defaultBaseBranch", "develop");
    expect(store.config.repoDefaults?.defaultBaseBranch).toBe("develop");
    const onDisk = JSON.parse(require("fs").readFileSync(cfgPath, "utf-8"));
    expect(onDisk.repoDefaults.defaultBaseBranch).toBe("develop");
  });

  test("setRepoOverride and clearRepoOverride manage repos[key]", () => {
    const store = new ConfigStore(cfgPath);
    store.setRepoOverride("/code/jmux/.git", "wtmIntegration", false);
    expect(store.config.repos?.["/code/jmux/.git"]?.wtmIntegration).toBe(false);
    store.clearRepoOverride("/code/jmux/.git", "wtmIntegration");
    expect(store.config.repos?.["/code/jmux/.git"]).toBeUndefined(); // emptied entry pruned
  });

  test("setTeamRepo adds and removes mappings", () => {
    const store = new ConfigStore(cfgPath);
    store.setTeamRepo("frontend", "/code/frontend");
    expect(store.config.issueWorkflow?.teamRepoMap?.frontend).toBe("/code/frontend");

    store.setTeamRepo("backend", "/code/backend");
    expect(store.config.issueWorkflow?.teamRepoMap?.backend).toBe("/code/backend");

    store.setTeamRepo("frontend", null);
    expect(store.config.issueWorkflow?.teamRepoMap?.frontend).toBeUndefined();
    expect(store.config.issueWorkflow?.teamRepoMap?.backend).toBe("/code/backend");
  });

  test("setAdapter sets and removes adapter config", () => {
    const store = new ConfigStore(cfgPath);
    store.setAdapter("codeHost", { type: "gitlab" });
    expect(store.config.adapters?.codeHost?.type).toBe("gitlab");

    store.setAdapter("issueTracker", { type: "linear" });
    expect(store.config.adapters?.issueTracker?.type).toBe("linear");

    store.setAdapter("codeHost", null);
    expect(store.config.adapters?.codeHost).toBeUndefined();
    expect(store.config.adapters?.issueTracker?.type).toBe("linear");
  });

  test("setAdapter cleans up empty adapters object", () => {
    const store = new ConfigStore(cfgPath);
    store.setAdapter("codeHost", { type: "gitlab" });
    store.setAdapter("codeHost", null);
    expect(store.config.adapters).toBeUndefined();
  });

  test("saveView upserts panel views", () => {
    const store = new ConfigStore(cfgPath);
    const view = {
      id: "v1", label: "Test", source: "issues" as const,
      filter: { scope: "assigned" as const },
      groupBy: "team" as const, subGroupBy: "status" as const,
      sortBy: "priority" as const, sortOrder: "asc" as const,
      sessionLinkedFirst: true,
    };
    store.saveView(view);
    expect(store.config.panelViews).toHaveLength(1);
    expect(store.config.panelViews![0].label).toBe("Test");

    // Update existing
    store.saveView({ ...view, label: "Updated" });
    expect(store.config.panelViews).toHaveLength(1);
    expect(store.config.panelViews![0].label).toBe("Updated");

    // Add second
    store.saveView({ ...view, id: "v2", label: "Second" });
    expect(store.config.panelViews).toHaveLength(2);
  });

  test("reload picks up external changes", () => {
    const store = new ConfigStore(cfgPath);
    store.set("sidebarWidth", 30);

    // External write
    writeFileSync(cfgPath, JSON.stringify({ sidebarWidth: 50, agentPaneCommandRegex: "external" }));
    const reloaded = store.reload();
    expect(reloaded.sidebarWidth).toBe(50);
    expect(store.config.agentPaneCommandRegex).toBe("external");
  });

  test("ensureExists creates file when missing", () => {
    const newPath = join(tmpDir, "sub", "config.json");
    const store = new ConfigStore(newPath);
    const created = store.ensureExists();
    expect(created).toBe(true);
    expect(existsSync(newPath)).toBe(true);

    const again = store.ensureExists();
    expect(again).toBe(false);
  });

  test("constructing against a config with no Command Center history writes nothing (first-run detection)", () => {
    // main.ts builds ConfigStore at module scope and only checks
    // ensureExists() much later, at first-run, to decide whether to open the
    // setup checklist. If the Command Center migration wrote seeded defaults
    // to disk eagerly, the file would already exist by the time that check
    // runs and the checklist would never show for a new install.
    const newPath = join(tmpDir, "sub", "config.json");
    const store = new ConfigStore(newPath);
    expect(existsSync(newPath)).toBe(false);
    // The in-memory config is still fully populated.
    expect(store.config.commandCenterViews).toHaveLength(1);
    expect(store.config.commandCenterActiveViewId).toBe(DEFAULT_VIEW_SEED_ID);
    expect(store.config.commandCenter?.maxTiles).toBe(DEFAULT_MAX_CLIENTS);
  });

  test("configPath returns the path", () => {
    const store = new ConfigStore(cfgPath);
    expect(store.configPath).toBe(cfgPath);
  });
});

describe("snapshot config defaults", () => {
  test("snapshot.enabled defaults to true", () => {
    expect(defaultConfig.snapshot?.enabled).toBe(true);
  });

  test("snapshot.scrollbackIntervalMs defaults to 5000", () => {
    expect(defaultConfig.snapshot?.scrollbackIntervalMs).toBe(5000);
  });

  test("snapshot.scrollbackMaxBytes defaults to 2 MiB", () => {
    expect(defaultConfig.snapshot?.scrollbackMaxBytes).toBe(2 * 1024 * 1024);
  });

  test("snapshot.dir defaults to null", () => {
    expect(defaultConfig.snapshot?.dir).toBeNull();
  });
});

describe("snapshot config merging", () => {
  let tmpDir: string;
  let cfgPath: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `jmux-snapshot-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
    cfgPath = join(tmpDir, "config.json");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("loadUserConfig merges partial snapshot config with defaults", () => {
    writeFileSync(cfgPath, JSON.stringify({
      snapshot: {
        scrollbackIntervalMs: 10000,
      },
    }));
    const loaded = loadUserConfig(cfgPath);
    expect(loaded.snapshot?.enabled).toBe(true);
    expect(loaded.snapshot?.scrollbackIntervalMs).toBe(10000);
    expect(loaded.snapshot?.scrollbackMaxBytes).toBe(2 * 1024 * 1024);
    expect(loaded.snapshot?.dir).toBeNull();
  });

  test("loadUserConfig applies snapshot defaults when omitted", () => {
    writeFileSync(cfgPath, JSON.stringify({ sidebarWidth: 30 }));
    const loaded = loadUserConfig(cfgPath);
    expect(loaded.snapshot?.enabled).toBe(true);
    expect(loaded.snapshot?.scrollbackIntervalMs).toBe(5000);
    expect(loaded.snapshot?.scrollbackMaxBytes).toBe(2 * 1024 * 1024);
    expect(loaded.snapshot?.dir).toBeNull();
  });

  test("loadUserConfig merges all snapshot fields", () => {
    writeFileSync(cfgPath, JSON.stringify({
      snapshot: {
        enabled: false,
        scrollbackIntervalMs: 3000,
        scrollbackMaxBytes: 1024 * 1024,
        dir: "/custom/path",
      },
    }));
    const loaded = loadUserConfig(cfgPath);
    expect(loaded.snapshot?.enabled).toBe(false);
    expect(loaded.snapshot?.scrollbackIntervalMs).toBe(3000);
    expect(loaded.snapshot?.scrollbackMaxBytes).toBe(1024 * 1024);
    expect(loaded.snapshot?.dir).toBe("/custom/path");
  });

  test("ConfigStore persists and loads snapshot config", () => {
    const store = new ConfigStore(cfgPath);
    store.set("snapshot", {
      enabled: false,
      scrollbackIntervalMs: 8000,
      scrollbackMaxBytes: 3 * 1024 * 1024,
      dir: "/data",
    });
    expect(store.config.snapshot?.enabled).toBe(false);
    expect(store.config.snapshot?.scrollbackIntervalMs).toBe(8000);

    const reloaded = new ConfigStore(cfgPath);
    expect(reloaded.config.snapshot?.enabled).toBe(false);
    expect(reloaded.config.snapshot?.scrollbackIntervalMs).toBe(8000);
    expect(reloaded.config.snapshot?.scrollbackMaxBytes).toBe(3 * 1024 * 1024);
    expect(reloaded.config.snapshot?.dir).toBe("/data");
  });
});
