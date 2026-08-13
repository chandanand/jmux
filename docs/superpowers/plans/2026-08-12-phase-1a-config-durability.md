# Phase 1a — Config Durability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `~/.config/jmux/config.json` impossible for jmux to destroy — atomic writes, no silent fallback to defaults on a corrupt file, and a watcher that survives the rename atomic writes introduce.

**Architecture:** A new synchronous atomic-write helper (`src/atomic-write.ts`) mirroring the async pattern `src/snapshot/fs.ts` already uses, wired into `ConfigStore.persist()`. Config *reading* gains a three-way result — ok / missing / corrupt — so "file absent" (normal, use defaults) stops being indistinguishable from "file unparseable" (dangerous, never overwrite). A corrupt file at construction throws so `main.ts` can exit before tmux starts; a corrupt file on hot reload latches writes off and keeps the last-known-good in memory.

**Tech Stack:** Bun 1.3.8+, TypeScript strict, `bun:test`. Node `fs` sync APIs (`openSync`, `fsyncSync`, `renameSync`, `writeFileSync`) — this file's write path must stay synchronous, see Global Constraints.

## Global Constraints

- **Target Bun, not Node.** Use `Bun.spawn` / `Bun.which` where subprocesses are needed. Node `fs` is fine and already used throughout `config.ts`.
- **`ConfigStore.persist()` must remain synchronous.** It is called from 11 sites (`config.ts:423, 431, 440, 449, 456, 463, 471, 481, 495, 513, 527`) reached from synchronous UI handlers in `main.ts`. Do **not** reuse `ProductionFileSystem.writeAtomic` from `src/snapshot/fs.ts` — it is `async` and would ripple through every caller.
- **Tests are pure unit tests over logic modules.** `src/__tests__/*` does not spawn tmux. The one exception is boot-smoke, which Task 6 extends.
- **No bundler.** Imports must be valid at runtime under Bun.
- **jmux is a public repo.** No personal paths, no credentials, in code, tests or commit messages.
- **Never attribute work to Claude in git.** No `Co-Authored-By`, no generated-with footer.
- **Run before claiming done:** `bun run typecheck` and `bun test`.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `src/atomic-write.ts` | **Create.** One exported function: a synchronous durable file replace. No config knowledge. |
| `src/__tests__/atomic-write.test.ts` | **Create.** Unit tests for the helper in isolation. |
| `src/config.ts` | **Modify.** Three-way read result, `ConfigCorruptError`, `persist()` returning success, write latch, `schemaVersion`. |
| `src/__tests__/config.test.ts` | **Modify.** Append describes; do not restructure the existing file. |
| `src/main.ts` | **Modify.** Startup catch around `ConfigStore` construction (~`:452`); watcher rearm (~`:8834`). |
| `src/__tests__/boot-smoke.test.ts` | **Modify.** One added test: corrupt config exits nonzero without starting tmux. |

---

## Task 1: Synchronous atomic write

**Files:**
- Create: `src/atomic-write.ts`
- Test: `src/__tests__/atomic-write.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `writeFileAtomicSync(path: string, contents: string): void` — throws on failure, never leaves a temp file behind, never leaves `path` partially written.

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/atomic-write.test.ts`:

```typescript
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, readdirSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { writeFileAtomicSync } from "../atomic-write";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jmux-atomic-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("writeFileAtomicSync", () => {
  test("creates a file that does not exist", () => {
    const p = join(dir, "out.json");
    writeFileAtomicSync(p, '{"a":1}');
    expect(readFileSync(p, "utf-8")).toBe('{"a":1}');
  });

  test("replaces an existing file", () => {
    const p = join(dir, "out.json");
    writeFileSync(p, "old");
    writeFileAtomicSync(p, "new");
    expect(readFileSync(p, "utf-8")).toBe("new");
  });

  test("leaves no temp files behind on success", () => {
    const p = join(dir, "out.json");
    writeFileAtomicSync(p, "x");
    expect(readdirSync(dir)).toEqual(["out.json"]);
  });

  test("creates the parent directory when missing", () => {
    const p = join(dir, "nested", "deep", "out.json");
    writeFileAtomicSync(p, "x");
    expect(readFileSync(p, "utf-8")).toBe("x");
  });

  test("leaves the original intact and no temp behind when the target dir is unwritable", () => {
    const p = join(dir, "blocked-by-a-directory");
    // A directory where the file should be makes rename fail (EISDIR/ENOTEMPTY).
    mkdirSync(p);
    expect(() => writeFileAtomicSync(p, "x")).toThrow();
    // The blocking directory survives, and no .tmp litter remains.
    expect(existsSync(p)).toBe(true);
    expect(readdirSync(dir).filter((n) => n.includes(".tmp"))).toEqual([]);
  });

  test("concurrent writers to the same path do not collide on a shared temp name", () => {
    const p = join(dir, "out.json");
    for (let i = 0; i < 20; i++) writeFileAtomicSync(p, `v${i}`);
    expect(readFileSync(p, "utf-8")).toBe("v19");
    expect(readdirSync(dir)).toEqual(["out.json"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/atomic-write.test.ts`
Expected: FAIL — `Cannot find module '../atomic-write'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/atomic-write.ts`:

```typescript
import { mkdirSync, openSync, writeSync, fsyncSync, closeSync, renameSync, unlinkSync } from "fs";
import { dirname } from "path";

// Unique per write, so two writers to one path never share a temp name. Mirrors
// the counter in src/snapshot/fs.ts, which solves the same race asynchronously.
let writeCounter = 0;

/**
 * Replace `path` with `contents`, durably and atomically.
 *
 * Synchronous on purpose: `ConfigStore.persist()` is reached from synchronous
 * UI handlers throughout main.ts, and making it async would ripple through
 * every one of them. That rules out reusing `ProductionFileSystem.writeAtomic`
 * from src/snapshot/fs.ts, which is otherwise the same algorithm.
 *
 * The steps are load-bearing in this order: write the bytes to a temp file,
 * fsync *that file* so its contents are on disk, rename over the target (atomic
 * within a filesystem), then fsync the *parent directory* so the rename's
 * directory entry survives power loss. Skipping the file fsync can leave a
 * renamed-but-empty file, which is worse than the partial write it replaced.
 */
export function writeFileAtomicSync(path: string, contents: string): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });

  const tmp = `${path}.tmp.${process.pid}.${++writeCounter}`;
  let wroteTmp = false;
  try {
    const fd = openSync(tmp, "w");
    try {
      writeSync(fd, contents);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    wroteTmp = true;
    renameSync(tmp, path);
  } catch (err) {
    if (wroteTmp) {
      try { unlinkSync(tmp); } catch { /* already gone */ }
    } else {
      try { unlinkSync(tmp); } catch { /* never created */ }
    }
    throw err;
  }

  // Best-effort: not every platform or filesystem supports directory fsync,
  // and failing here would undo a write that has already succeeded.
  try {
    const dh = openSync(dir, "r");
    try { fsyncSync(dh); } finally { closeSync(dh); }
  } catch { /* unsupported */ }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/__tests__/atomic-write.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Typecheck and commit**

```bash
bun run typecheck
git add src/atomic-write.ts src/__tests__/atomic-write.test.ts
git commit -m "feat(config): a synchronous durable file replace

ConfigStore.persist() is reached from synchronous UI handlers in eleven
places, so the async writeAtomic the snapshot subsystem already has cannot
be reused without rippling through all of them. Same algorithm, sync: temp
file, fsync the file, rename, fsync the parent directory."
```

---

## Task 2: `persist()` writes atomically and reports success

**Files:**
- Modify: `src/config.ts:551-558` (`persist`), and the 11 call sites listed in Global Constraints only if they need the return value (they do not — `persist` stays private).
- Test: `src/__tests__/config.test.ts`

**Interfaces:**
- Consumes: `writeFileAtomicSync` from Task 1.
- Produces: `ConfigStore.persist(): boolean` (private), and public `get lastWriteError(): string | null` — null when the last write succeeded.

- [ ] **Step 1: Write the failing test**

Append to `src/__tests__/config.test.ts`:

```typescript
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
    // Replace the file with a directory so rename cannot succeed.
    rmSync(path);
    mkdirSync(path);
    store.set("sidebarWidth", 32);
    expect(store.lastWriteError).not.toBeNull();
  });
});
```

Add `readdirSync` and `readFileSync` to the existing `fs` import at the top of the file.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/config.test.ts -t "ConfigStore durability"`
Expected: FAIL — `store.lastWriteError` is not a property.

- [ ] **Step 3: Write minimal implementation**

In `src/config.ts`, add the import:

```typescript
import { writeFileAtomicSync } from "./atomic-write";
```

Add a field beside `private data` / `private readonly path`:

```typescript
  private _lastWriteError: string | null = null;
```

Add the accessor beside `get configPath()`:

```typescript
  /**
   * Why the last write failed, or null if it succeeded. Exposed so the UI can
   * say so: a persist that fails silently is how a user's setting change looks
   * applied on screen and is gone on the next launch.
   */
  get lastWriteError(): string | null {
    return this._lastWriteError;
  }
```

Replace `persist()`:

```typescript
  private persist(): boolean {
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/__tests__/config.test.ts`
Expected: PASS, including the pre-existing tests.

- [ ] **Step 5: Typecheck and commit**

```bash
bun run typecheck
git add src/config.ts src/__tests__/config.test.ts
git commit -m "fix(config): write config atomically and report failures

persist() was a bare writeFileSync whose failures went to the log and
nowhere else. A crash mid-write left invalid JSON, which the loader then
silently replaced with defaults."
```

---

## Task 3: A corrupt config is never mistaken for an absent one

**Files:**
- Modify: `src/config.ts:367-379` (`loadUserConfig`), `:390-405` (constructor)
- Test: `src/__tests__/config.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `export class ConfigCorruptError extends Error { readonly path: string; readonly cause: string }`
  - `export function readConfigFile(path: string): { kind: "ok"; raw: JmuxConfig } | { kind: "missing" } | { kind: "corrupt"; error: string }`
  - `new ConfigStore(path)` **throws `ConfigCorruptError`** when the file exists and does not parse.

- [ ] **Step 1: Write the failing test**

Append to `src/__tests__/config.test.ts`:

```typescript
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

  test("a JSON array reports corrupt — the config must be an object", () => {
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
```

Add `ConfigCorruptError` and `readConfigFile` to the existing import from `"../config"`.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/config.test.ts -t "readConfigFile"`
Expected: FAIL — `readConfigFile` is not exported.

- [ ] **Step 3: Write minimal implementation**

In `src/config.ts`, above `loadUserConfig`:

```typescript
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
```

Rewrite `loadUserConfig` to use it, preserving its existing "defaults on missing" contract:

```typescript
export function loadUserConfig(configPath?: string): JmuxConfig {
  const path = configPath ?? DEFAULT_CONFIG_PATH;
  const read = readConfigFile(path);
  if (read.kind === "corrupt") throw new ConfigCorruptError(path, read.error);
  const raw = read.kind === "ok" ? read.raw : {};
  const { config } = migrateLegacyConfig(raw);
  return mergeConfigWithDefaults(config, defaultConfig);
}
```

Rewrite the constructor body (`config.ts:390-405`) to match:

```typescript
  constructor(configPath?: string) {
    this.path = configPath ?? DEFAULT_CONFIG_PATH;
    const read = readConfigFile(this.path);
    if (read.kind === "corrupt") throw new ConfigCorruptError(this.path, read.error);
    const raw = read.kind === "ok" ? read.raw : {};
    // Rewrite the file once when the on-disk shape predates repoDefaults/repos,
    // so no consumption site ever has to check two locations for a field.
    const { config, changed } = migrateLegacyConfig(raw);
    this.data = mergeConfigWithDefaults(config, defaultConfig);
    if (changed) this.persist();
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/__tests__/config.test.ts`
Expected: PASS. The pre-existing `loadUserConfig` tests still pass — they cover missing paths and valid files, neither of which now throws.

- [ ] **Step 5: Typecheck and commit**

```bash
bun run typecheck
git add src/config.ts src/__tests__/config.test.ts
git commit -m "fix(config): stop treating an unparseable config as an absent one

Both landed on defaults, so a damaged file was silently discarded and the
next setting change made that permanent. Absent means defaults; corrupt
means touch nothing and say so."
```

---

## Task 4: Hot-reload keeps the last known good and latches writes off

**Files:**
- Modify: `src/config.ts:534-537` (`reload`)
- Test: `src/__tests__/config.test.ts`

**Interfaces:**
- Consumes: `readConfigFile`, `ConfigCorruptError` from Task 3.
- Produces: `ConfigStore.reload(): JmuxConfig` (unchanged signature, never throws), `get loadError(): string | null`, `get writesDisabled(): boolean`.

Rationale for not throwing here: `reload()` is called from the `fs.watch` callback in `main.ts`, where a throw is an unhandled rejection in a running TUI. The startup case (Task 3) can exit cleanly; the running case must degrade.

- [ ] **Step 1: Write the failing test**

Append to `src/__tests__/config.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/config.test.ts -t "hot reload"`
Expected: FAIL — `store.loadError` is not a property; `reload()` throws.

- [ ] **Step 3: Write minimal implementation**

Add the field beside `_lastWriteError`:

```typescript
  private _loadError: string | null = null;
```

Add accessors beside `lastWriteError`:

```typescript
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
```

Guard `persist()` — add as its first statement:

```typescript
    if (this.writesDisabled) return false;
```

Replace `reload()`:

```typescript
  reload(): JmuxConfig {
    const read = readConfigFile(this.path);
    if (read.kind === "corrupt") {
      // Deliberately does not throw: this runs from the fs.watch callback in a
      // live TUI, where a throw is an unhandled rejection. Startup can exit
      // cleanly (see the constructor); a running process has to degrade.
      this._loadError = read.error;
      return this.data;
    }
    const raw = read.kind === "ok" ? read.raw : {};
    const { config } = migrateLegacyConfig(raw);
    this.data = mergeConfigWithDefaults(config, defaultConfig);
    this._loadError = null;
    return this.data;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/__tests__/config.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

```bash
bun run typecheck
git add src/config.ts src/__tests__/config.test.ts
git commit -m "fix(config): latch writes off when the file on disk goes bad

A hot reload of a half-saved file used to replace the whole in-memory
config with defaults, and the next setting change wrote those defaults
back. Memory now keeps the last version that parsed, writes are refused
while the file is broken, and a valid reload clears the latch."
```

---

## Task 5: The watcher survives an atomic rename

**Files:**
- Modify: `src/main.ts:8829-8836` (the `configWatcher` block)
- Test: none — `main.ts` is unreachable by unit tests (see Task 6 for the integration path). Verified manually with the procedure below.

**Interfaces:**
- Consumes: nothing.
- Produces: nothing consumed by later tasks.

Task 2 introduced `renameSync`, which replaces the inode. `fs.watch(path)` follows the *inode*, so after the first atomic write the watcher is attached to a file that no longer has a name — every later external edit is missed, and the sidebar-width hot-apply silently stops working. This is a regression introduced by this plan, so it ships in it.

- [ ] **Step 1: Read the current block**

Run: `sed -n '8829,8845p' src/main.ts`
Confirm it reads `configWatcher = watch(configStore.configPath, () => {`.

- [ ] **Step 2: Replace the watch target with the parent directory**

Change only the `watch(...)` call and its callback signature; leave the callback body exactly as it is.

```typescript
  const { watch } = await import("fs");
  const { dirname: dirOf, basename: baseOf } = await import("path");
  // Watch the *directory*, not the file. persist() replaces the config with an
  // atomic rename (src/atomic-write.ts), which swaps the inode — and fs.watch
  // on a path follows the inode, so a file watcher goes deaf after the first
  // write jmux itself makes. The rename shows up here as a change event for
  // the basename.
  const configDir = dirOf(configStore.configPath);
  const configBase = baseOf(configStore.configPath);
  configWatcher = watch(configDir, (_event, filename) => {
    if (filename !== null && filename !== configBase) return;
    const updated = configStore.reload();
    // ... existing body unchanged ...
```

Note for the implementer: `filename` is `string | null` on some platforms. A `null` filename means "something changed but the OS didn't say what", so it must fall through to the reload rather than be filtered out.

- [ ] **Step 3: Verify manually**

```bash
bun run dev
```

In another pane, with jmux running:

```bash
python3 -c "import json,os;p=os.path.expanduser('~/.config/jmux/config.json');c=json.load(open(p));c['sidebarWidth']=34;json.dump(c,open(p,'w'))"
```

Expected: the sidebar changes width without restarting jmux.

Then, inside jmux, change any setting via `Ctrl-a i` (which triggers an atomic write), and repeat the external edit above with a different width. Expected: it still hot-applies. Before this task, the second edit is ignored.

- [ ] **Step 4: Typecheck and commit**

```bash
bun run typecheck
git add src/main.ts
git commit -m "fix(config): watch the config's directory, not its inode

Atomic writes replace the file by rename, and fs.watch on a path follows
the inode — so the watcher went deaf after the first setting jmux itself
saved, and external edits stopped hot-applying."
```

---

## Task 6: A corrupt config exits before tmux starts

**Files:**
- Modify: `src/main.ts:452` (the `configStore` construction)
- Test: `src/__tests__/boot-smoke.test.ts`

**Interfaces:**
- Consumes: `ConfigCorruptError` from Task 3.
- Produces: a `--config <path>` CLI flag.

`ConfigStore` is constructed at `main.ts:452`, before alt-screen entry, snapshot restore and `TmuxPty` (`main.ts:1092`, `:1198`, `:1230`). So the throw from Task 3 can become a clean diagnostic and a nonzero exit without a half-drawn screen or an orphaned tmux server.

**This task adds a `--config <path>` flag first, and it is not optional.**
`DEFAULT_CONFIG_PATH` is `resolve(homedir(), ".config", "jmux", "config.json")`
(`config.ts:319`) — no env override, no flag, and the only existing override is
`demoCtx?.configPath`. Without a flag this task's behaviour is testable only by
pointing a spawned jmux at the developer's **real** config, which is
unacceptable: jmux is normally run from source here, so a test that corrupts
that file corrupts the machine it is running on. The flag also protects the
developer during phase 2, whose migration rewrites the whole document.

- [ ] **Step 1: Add the `--config` flag**

In the arg loop near `main.ts:591` (`// Parse args: jmux [session] [--socket name] [--demo]`), add a case alongside the existing `-L` / `--socket` handling:

```typescript
    } else if (arg === "--config") {
      configPathOverride = argv[++i] ?? null;
```

Declare `configPathOverride` beside the other parsed-arg bindings, *above* line 452:

```typescript
let configPathOverride: string | null = null;
```

Add it to the help text at `main.ts:281`:

```
  --config <path>          Use a specific config file (default ~/.config/jmux/config.json)
```

Note for the implementer: the flag must be parsed **before** line 452. If the existing arg loop runs later than that, move only the `--config` parse earlier — do not move the whole loop, and do not reference any `let` declared below 452. That temporal-dead-zone hazard is exactly what `boot-smoke.test.ts` exists to catch.

- [ ] **Step 2: Write the failing test**

Append to `src/__tests__/boot-smoke.test.ts`:

```typescript
describe("jmux refuses a corrupt config", () => {
  test("exits nonzero with a diagnostic naming the file", () => {
    const dir = mkdtempSync(join(tmpdir(), "jmux-corrupt-boot-"));
    const cfg = join(dir, "config.json");
    writeFileSync(cfg, "{ this is not json");
    try {
      const proc = Bun.spawnSync(
        ["bun", "run", join(import.meta.dir, "..", "main.ts"), "--config", cfg],
        { stdout: "pipe", stderr: "pipe" },
      );
      expect(proc.exitCode).not.toBe(0);
      const err = new TextDecoder().decode(proc.stderr);
      expect(err).toContain("config.json");
      expect(err).toContain("not valid JSON");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

Add `writeFileSync` to the existing `fs` import in that file.

This test deliberately does **not** need tmux and so is not `skipIf(!TMUX)`: the whole point is that jmux exits before reaching the pty.

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test src/__tests__/boot-smoke.test.ts -t "refuses a corrupt config"`
Expected: FAIL — jmux either starts anyway or crashes with an unhandled `ConfigCorruptError` stack rather than a diagnostic.

- [ ] **Step 4: Write minimal implementation**

At `src/main.ts:452`, wrap the construction:

```typescript
let configStore: ConfigStore;
try {
  configStore = new ConfigStore(demoCtx?.configPath ?? configPathOverride ?? undefined);
} catch (e) {
  if (e instanceof ConfigCorruptError) {
    // Deliberately before the alt screen, the snapshot restore and the tmux
    // pty — all of which start below this line. Exiting here costs the user
    // nothing but a message; exiting later would leave a half-drawn terminal
    // and possibly an orphaned server.
    process.stderr.write(
      `jmux: ${e.message}\n` +
      `jmux: refusing to start rather than overwrite it.\n` +
      `jmux: fix the file, or move it aside and jmux will start with defaults.\n`,
    );
    process.exit(1);
  }
  throw e;
}
```

Add `ConfigCorruptError` to the existing import from `"./config"`.

Note for the implementer: `configStore` becomes a `let`. Anything at module scope that reads it must still appear *below* this block — the temporal-dead-zone hazard `boot-smoke.test.ts` exists to catch. `grep -n "configStore" src/main.ts | head -3` to confirm nothing above line 452 touches it.

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test src/__tests__/boot-smoke.test.ts`
Expected: PASS, including the pre-existing "starts under a real pty and stays up".

- [ ] **Step 6: Typecheck and commit**

```bash
bun run typecheck
git add src/main.ts src/__tests__/boot-smoke.test.ts
git commit -m "feat(config): refuse to start on a corrupt config, before tmux

The store is built before the alt screen, restore and the pty, so a bad
file can be reported and exited on cleanly. Starting anyway meant the
first setting change overwrote a file the user could still have fixed.

Adds --config, without which this is testable only against the developer's
real config file — which, since jmux is normally run from source, is the
machine the test is running on."
```

---

## Task 7: Unknown keys are preserved, and the schema is stamped

**Files:**
- Modify: `src/config.ts` (`JmuxConfig`, `persist`)
- Test: `src/__tests__/config.test.ts`

**Interfaces:**
- Consumes: `readConfigFile` from Task 3.
- Produces: `export const CONFIG_SCHEMA_VERSION = 1`, and `JmuxConfig.schemaVersion?: number`.

`mergeConfigWithDefaults` is `{ ...defaults, ...userConfig }` (`config.ts:352`), so unknown keys already survive a round trip. That property is currently an accident of using a spread, and phase 2's whole downgrade story depends on it. The test is what stops it being "tidied" into an explicit field list later.

- [ ] **Step 1: Write the failing test**

Append to `src/__tests__/config.test.ts`:

```typescript
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
    // Not downgraded to CONFIG_SCHEMA_VERSION: this jmux did not migrate
    // anything, so claiming its own version would be a lie about the contents.
    expect(JSON.parse(readFileSync(path, "utf-8")).schemaVersion).toBe(999);
  });
});
```

Add `CONFIG_SCHEMA_VERSION` to the existing import from `"../config"`.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/config.test.ts -t "forward compatibility"`
Expected: FAIL — `CONFIG_SCHEMA_VERSION` is not exported.

- [ ] **Step 3: Write minimal implementation**

In `src/config.ts`, beside the other exported constants:

```typescript
/**
 * Stamped on every write, read for diagnostics and by migrations. Deliberately
 * NOT a gate: a multiplexer that refuses to attach because of a config file is
 * holding running work hostage, and unknown-key preservation already means a
 * newer file survives an older jmux intact.
 */
export const CONFIG_SCHEMA_VERSION = 1;
```

Add to `JmuxConfig`:

```typescript
  /** See CONFIG_SCHEMA_VERSION. Absent on files written before it existed. */
  schemaVersion?: number;
```

In `persist()`, stamp before serializing — but never lower an existing higher value:

```typescript
  private persist(): boolean {
    if (this.writesDisabled) return false;
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
```

- [ ] **Step 4: Run the full suite**

Run: `bun test && bun run typecheck`
Expected: PASS. The whole suite, not just this file — Task 2 and 4 changed `persist`, which every settings test exercises indirectly.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts src/__tests__/config.test.ts
git commit -m "feat(config): stamp a schema version and pin unknown-key survival

The spread in mergeConfigWithDefaults already carries keys this version
does not know through a round trip, which is what lets an older jmux hold
a newer file without destroying it. That was an accident of the
implementation; the test makes it a decision."
```

---

## Done criteria

- [ ] `bun test` passes in full.
- [ ] `bun run typecheck` is clean.
- [ ] Manual check from Task 5 Step 3 passes: an external config edit hot-applies *after* jmux has itself saved a setting.
- [ ] `bun run dev` with a deliberately broken `config.json` prints the diagnostic and exits 1 without leaving a tmux server (`tmux ls` unchanged).
