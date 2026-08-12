import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { sanitizeTmuxSessionName, buildOtelResourceAttrs, loadUserConfig, ConfigStore, defaultConfig, ConfigCorruptError, readConfigFile, CONFIG_SCHEMA_VERSION } from "../config";
import { writeFileSync, unlinkSync, existsSync, mkdirSync, rmSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

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

describe("ConfigStore durability", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = join(tmpdir(), `jmux-cfg-${process.pid}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    path = join(dir, "config.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("a successful write leaves no temp files", () => {
    writeFileSync(path, "{}");
    const store = new ConfigStore(path);
    store.set("sidebarWidth", 30);
    expect(readdirSync(dir)).toEqual(["config.json"]);
    expect(store.lastWriteError).toBeNull();
  });

  test("the written file is valid JSON containing the new value", () => {
    writeFileSync(path, "{}");
    const store = new ConfigStore(path);
    store.set("sidebarWidth", 31);
    expect(JSON.parse(readFileSync(path, "utf-8")).sidebarWidth).toBe(31);
  });

  test("lastWriteError reports a failed write instead of throwing", () => {
    writeFileSync(path, "{}");
    const store = new ConfigStore(path);
    rmSync(path);
    mkdirSync(path);
    store.set("sidebarWidth", 32);
    expect(store.lastWriteError).not.toBeNull();
  });
});

describe("readConfigFile", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = join(tmpdir(), `jmux-read-${process.pid}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    path = join(dir, "config.json");
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("missing file reports missing, not corrupt", () => {
    expect(readConfigFile(path)).toEqual({ kind: "missing" });
  });

  test("valid JSON reports ok with the parsed object", () => {
    writeFileSync(path, '{"sidebarWidth":40}');
    const r = readConfigFile(path);
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") expect(r.raw.sidebarWidth).toBe(40);
  });

  test("truncated JSON reports corrupt", () => {
    writeFileSync(path, '{"sidebarWidth":4');
    expect(readConfigFile(path).kind).toBe("corrupt");
  });

  test("a JSON array reports corrupt", () => {
    writeFileSync(path, "[]");
    expect(readConfigFile(path).kind).toBe("corrupt");
  });

  test("a bare JSON scalar reports corrupt", () => {
    writeFileSync(path, "42");
    expect(readConfigFile(path).kind).toBe("corrupt");
  });
});

describe("ConfigStore construction on a corrupt file", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = join(tmpdir(), `jmux-corrupt-${process.pid}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    path = join(dir, "config.json");
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("throws ConfigCorruptError rather than falling back to defaults", () => {
    writeFileSync(path, "{ not json");
    expect(() => new ConfigStore(path)).toThrow(ConfigCorruptError);
  });

  test("does not overwrite the corrupt file", () => {
    writeFileSync(path, "{ not json");
    try { new ConfigStore(path); } catch { /* expected */ }
    expect(readFileSync(path, "utf-8")).toBe("{ not json");
  });

  test("a missing file still constructs with defaults", () => {
    const store = new ConfigStore(path);
    expect(store.config.snapshot?.enabled).toBe(true);
  });
});

describe("ConfigStore hot reload of a corrupt file", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = join(tmpdir(), `jmux-hot-${process.pid}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    path = join(dir, "config.json");
    writeFileSync(path, '{"sidebarWidth":42}');
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("reload does not throw", () => {
    const store = new ConfigStore(path);
    writeFileSync(path, "{ broken");
    expect(() => store.reload()).not.toThrow();
  });

  test("keeps the last known good value in memory", () => {
    const store = new ConfigStore(path);
    writeFileSync(path, "{ broken");
    store.reload();
    expect(store.config.sidebarWidth).toBe(42);
  });

  test("reports the load error", () => {
    const store = new ConfigStore(path);
    writeFileSync(path, "{ broken");
    store.reload();
    expect(store.loadError).not.toBeNull();
    expect(store.writesDisabled).toBe(true);
  });

  test("a latched store refuses to write over the corrupt file", () => {
    const store = new ConfigStore(path);
    writeFileSync(path, "{ broken");
    store.reload();
    store.set("sidebarWidth", 99);
    expect(readFileSync(path, "utf-8")).toBe("{ broken");
  });

  test("a valid reload clears the latch", () => {
    const store = new ConfigStore(path);
    writeFileSync(path, "{ broken");
    store.reload();
    writeFileSync(path, '{"sidebarWidth":43}');
    store.reload();
    expect(store.loadError).toBeNull();
    expect(store.writesDisabled).toBe(false);
    expect(store.config.sidebarWidth).toBe(43);
  });

  test("in-memory changes still apply while latched, so the UI stays responsive", () => {
    const store = new ConfigStore(path);
    writeFileSync(path, "{ broken");
    store.reload();
    store.set("sidebarWidth", 99);
    expect(store.config.sidebarWidth).toBe(99);
  });
});

describe("forward compatibility", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = join(tmpdir(), `jmux-fwd-${process.pid}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    path = join(dir, "config.json");
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  // Load-bearing: an older jmux must carry a newer jmux's config through
  // untouched rather than deleting what it does not understand. Phase 2 ships
  // `projects` and relies on exactly this.
  test("a key this version knows nothing about survives a write", () => {
    writeFileSync(path, JSON.stringify({ sidebarWidth: 26, projects: [{ id: "x" }] }));
    const store = new ConfigStore(path);
    store.set("sidebarWidth", 30);
    const written = JSON.parse(readFileSync(path, "utf-8"));
    expect(written.projects).toEqual([{ id: "x" }]);
    expect(written.sidebarWidth).toBe(30);
  });

  test("writes stamp the current schema version", () => {
    writeFileSync(path, "{}");
    const store = new ConfigStore(path);
    store.set("sidebarWidth", 30);
    expect(JSON.parse(readFileSync(path, "utf-8")).schemaVersion).toBe(CONFIG_SCHEMA_VERSION);
  });

  test("a newer schemaVersion is preserved and does not block startup", () => {
    writeFileSync(path, JSON.stringify({ schemaVersion: 999, sidebarWidth: 26 }));
    const store = new ConfigStore(path);
    expect(store.config.sidebarWidth).toBe(26);
    store.set("sidebarWidth", 30);
    // Not downgraded: this jmux migrated nothing, so claiming its own version
    // would be a lie about the contents.
    expect(JSON.parse(readFileSync(path, "utf-8")).schemaVersion).toBe(999);
  });
});

describe("ConfigStore projects", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = join(tmpdir(), `jmux-proj-${process.pid}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    path = join(dir, "config.json");
    writeFileSync(path, "{}");
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("upsertProject adds and then replaces by id", () => {
    const store = new ConfigStore(path);
    store.upsertProject({ id: "api", title: "API", dir: "/code/api" });
    expect(store.config.projects).toHaveLength(1);
    store.upsertProject({ id: "api", title: "API v2", dir: "/code/api" });
    expect(store.config.projects).toHaveLength(1);
    expect(store.config.projects?.[0].title).toBe("API v2");
  });

  // Soft delete, so a session still stamped with the id can report `orphaned`
  // rather than silently re-routing to whatever else claims its team.
  test("deleteProject marks rather than removes", () => {
    const store = new ConfigStore(path);
    store.upsertProject({ id: "api", title: "API", dir: "/code/api" });
    store.deleteProject("api");
    expect(store.config.projects).toHaveLength(1);
    expect(store.config.projects?.[0].deletedAt).toBeDefined();
  });

  test("setProjectSetting stores by key presence and clearProjectSetting removes the key", () => {
    const store = new ConfigStore(path);
    store.upsertProject({ id: "api", title: "API", dir: "/code/api" });
    store.setProjectSetting("api", "agentCommand", "codex");
    expect(store.config.projects?.[0].settings?.agentCommand).toBe("codex");
    store.clearProjectSetting("api", "agentCommand");
    expect("agentCommand" in (store.config.projects?.[0].settings ?? {})).toBe(false);
  });

  test("an explicit null is stored as a present key, not dropped", () => {
    const store = new ConfigStore(path);
    store.upsertProject({ id: "api", title: "API", dir: "/code/api" });
    store.setProjectSetting("api", "onMrMergedState", null);
    expect("onMrMergedState" in (store.config.projects?.[0].settings ?? {})).toBe(true);
  });

  test("routes are written and cleared by kind", () => {
    const store = new ConfigStore(path);
    store.setRoute("issue", "I1", "api");
    store.setRoute("linearProject", "LP1", "web");
    expect(store.config.routes?.issue?.I1).toBe("api");
    expect(store.config.routes?.linearProject?.LP1).toBe("web");
    store.clearRoute("issue", "I1");
    expect(store.config.routes?.issue?.I1).toBeUndefined();
  });

  test("everything persists across a reload", () => {
    const store = new ConfigStore(path);
    store.upsertProject({ id: "api", title: "API", dir: "/code/api" });
    store.setProjectSetting("api", "agentCommand", "codex");
    store.setRoute("issue", "I1", "api");
    const reloaded = new ConfigStore(path);
    expect(reloaded.config.projects?.[0].settings?.agentCommand).toBe("codex");
    expect(reloaded.config.routes?.issue?.I1).toBe("api");
  });
});
