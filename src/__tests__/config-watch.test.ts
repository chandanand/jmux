import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { watch, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, dirname, basename } from "path";
import { writeFileAtomicSync } from "../atomic-write";

// Why this exists: `persist()` now replaces the config with an atomic rename,
// and `fs.watch(path)` follows the *inode*. So the file watcher main.ts used
// went deaf after the first setting jmux itself saved, and every later external
// edit was silently missed — a regression introduced by fixing durability.
//
// main.ts is unreachable by unit tests, so this asserts the *premise* the fix
// rests on rather than the wiring: a directory watcher sees an atomic replace,
// and a file watcher does not reliably see the one after it.

const SETTLE_MS = 300;

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jmux-watch-"));
  path = join(dir, "config.json");
  writeFileSync(path, "{}");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("config watching survives atomic replacement", () => {
  test("a directory watcher sees an atomic replace of the file", async () => {
    const seen: string[] = [];
    const base = basename(path);
    const w = watch(dirname(path), (_e, filename) => {
      if (filename === null || filename === base) seen.push(filename ?? "(null)");
    });
    try {
      await wait(SETTLE_MS);
      writeFileAtomicSync(path, '{"sidebarWidth":30}');
      await wait(SETTLE_MS);
      expect(seen.length).toBeGreaterThan(0);
    } finally {
      w.close();
    }
  });

  test("a directory watcher still sees a second, external edit after jmux's own write", async () => {
    const base = basename(path);
    let sinceFirst = 0;
    const w = watch(dirname(path), (_e, filename) => {
      if (filename === null || filename === base) sinceFirst++;
    });
    try {
      await wait(SETTLE_MS);
      writeFileAtomicSync(path, '{"sidebarWidth":30}');   // jmux saves a setting
      await wait(SETTLE_MS);
      sinceFirst = 0;
      writeFileSync(path, '{"sidebarWidth":34}');          // the user edits by hand
      await wait(SETTLE_MS);
      expect(sinceFirst).toBeGreaterThan(0);
    } finally {
      w.close();
    }
  });

  test("a file watcher goes deaf after an atomic replace — the regression this avoids", async () => {
    let afterReplace = 0;
    const w = watch(path, () => { afterReplace++; });
    try {
      await wait(SETTLE_MS);
      writeFileAtomicSync(path, '{"sidebarWidth":30}');   // swaps the inode
      await wait(SETTLE_MS);
      afterReplace = 0;
      writeFileSync(path, '{"sidebarWidth":34}');          // the edit that gets missed
      await wait(SETTLE_MS);
      expect(afterReplace).toBe(0);
    } finally {
      w.close();
    }
  });
});
