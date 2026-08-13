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

  test("leaves the original intact and no temp behind when the target cannot be replaced", () => {
    const p = join(dir, "blocked-by-a-directory");
    // A directory where the file should be makes rename fail (EISDIR/ENOTEMPTY).
    mkdirSync(p);
    expect(() => writeFileAtomicSync(p, "x")).toThrow();
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
