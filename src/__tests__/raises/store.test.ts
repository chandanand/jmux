import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, statSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { raisesPathFor, readRaises, mutateRaises, findByKey, pruneResolved } from "../../raises/store";
import type { Raise } from "../../raises/types";

let dir: string;
let path: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "raises-")); path = join(dir, "raises.json"); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function raise(over: Partial<Raise> = {}): Raise {
  return {
    id: "r1", createdAt: 1, idempotencyKey: "k1",
    scope: { kind: "issue", identifier: "AAA-1" },
    question: "q", options: [{ id: "o1", text: "a" }], recommendation: "o1",
    why: "w", context: "c", authority: "developer",
    snapshot: null, state: "open", answer: null, resolvedAt: null,
    ...over,
  };
}

describe("the store follows the active config directory", () => {
  test("the raise file sits beside the config file it was given", () => {
    expect(raisesPathFor("/somewhere/else/config.json")).toBe("/somewhere/else/raises.json");
  });
});

describe("reading is a typed result, never a bare list", () => {
  test("a file that does not exist is missing, not empty", () => {
    expect(readRaises(path).kind).toBe("missing");
  });

  test("a valid file reads its raises", () => {
    mutateRaises(path, (rs) => [...rs, raise()]);
    const r = readRaises(path);
    expect(r.kind).toBe("valid");
    expect(r.kind === "valid" && r.raises).toHaveLength(1);
  });

  test("an unparseable file is an error carrying its reason, NEVER an empty list", () => {
    // Six defects in this project have been "an unreadable thing reported as an
    // empty thing". A raise queue that reads as empty silently drops every
    // question waiting on a human.
    writeFileSync(path, "{ not json");
    const r = readRaises(path);
    expect(r.kind).toBe("error");
    expect(r.kind === "error" && r.why.length).toBeGreaterThan(0);
  });

  test("a file carrying an unknown contract version is an error, not a guess", () => {
    writeFileSync(path, JSON.stringify({ version: 99, raises: [] }));
    expect(readRaises(path).kind).toBe("error");
  });
});

describe("a mutation is refused while the store is unreadable", () => {
  test("the original bytes survive a refused mutation", () => {
    writeFileSync(path, "{ not json");
    const result = mutateRaises(path, (rs) => [...rs, raise()]);
    expect(result.ok).toBe(false);
    expect(readFileSync(path, "utf8")).toBe("{ not json");
  });
});

describe("concurrent mutations", () => {
  test("two real writer processes both survive", async () => {
    // writeFileAtomicSync replaces atomically but holds no lock across
    // read-modify-write, so without one the second rename discards the first.
    // A microtask-scheduled Promise.all cannot exercise this: mutateRaises is
    // fully synchronous, so two microtask calls run to completion one after
    // another and never interleave. Only real subprocesses interleave for real.
    const storeUrl = new URL("../../raises/store.ts", import.meta.url);
    const scriptPath = join(dir, "append-one.ts");
    writeFileSync(
      scriptPath,
      [
        `import { mutateRaises } from ${JSON.stringify(storeUrl.pathname)};`,
        `const id = process.argv[2];`,
        `const result = mutateRaises(process.argv[3], (rs) => [...rs, {`,
        `  id, createdAt: 1, idempotencyKey: "k-" + id,`,
        `  scope: { kind: "issue", identifier: "AAA-1" },`,
        `  question: "q", options: [{ id: "o1", text: "a" }], recommendation: "o1",`,
        `  why: "w", context: "c", authority: "developer",`,
        `  snapshot: null, state: "open", answer: null, resolvedAt: null,`,
        `}]);`,
        `if (!result.ok) { console.error(result.why); process.exit(1); }`,
      ].join("\n"),
    );

    const [a, b] = await Promise.all([
      Bun.spawn(["bun", "run", scriptPath, "a", path], { stdout: "pipe", stderr: "pipe" }).exited,
      Bun.spawn(["bun", "run", scriptPath, "b", path], { stdout: "pipe", stderr: "pipe" }).exited,
    ]);
    expect(a).toBe(0);
    expect(b).toBe(0);

    const r = readRaises(path);
    expect(r.kind === "valid" && r.raises.map((x) => x.id).sort()).toEqual(["a", "b"]);
  });
});

describe("the file is not world-readable", () => {
  test("mode is 0600, because a snapshot holds whatever was on the screen", () => {
    mutateRaises(path, (rs) => [...rs, raise()]);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});

describe("idempotency", () => {
  test("an unresolved raise with the same key is found", () => {
    const rs = [raise({ id: "r1", idempotencyKey: "k1" })];
    expect(findByKey(rs, "k1")?.id).toBe("r1");
  });

  test("a resolved raise with the same key does not block a new one", () => {
    const rs = [raise({ id: "r1", idempotencyKey: "k1", state: "resolved", resolvedAt: 2 })];
    expect(findByKey(rs, "k1")).toBeNull();
  });
});

describe("pruning", () => {
  test("only resolved raises are pruned, ordered by resolvedAt", () => {
    const rs = [
      raise({ id: "old", createdAt: 1, state: "resolved", resolvedAt: 10 }),
      raise({ id: "new", createdAt: 2, state: "resolved", resolvedAt: 20 }),
      raise({ id: "open-but-ancient", createdAt: 0, state: "open" }),
    ];
    const kept = pruneResolved(rs, 1).map((r) => r.id).sort();
    // The open raise survives regardless of age. Only the older resolved one goes.
    expect(kept).toEqual(["new", "open-but-ancient"]);
  });
});
