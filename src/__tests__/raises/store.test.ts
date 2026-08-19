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

  test("a correct-version file with no raises field is an error, not an empty list", () => {
    writeFileSync(path, JSON.stringify({ version: 1 }));
    expect(readRaises(path).kind).toBe("error");
  });

  test("a correct-version file whose raises field is not an array is an error", () => {
    writeFileSync(path, JSON.stringify({ version: 1, raises: "not-an-array" }));
    expect(readRaises(path).kind).toBe("error");
  });
});

// One malformed record inside an otherwise-valid store used to reach
// `RaisesScreen.render` as a bare `Raise` and throw — `renderFrame` runs in a
// bare `setTimeout`, and main.ts's `uncaughtException` handler calls
// `process.exit(1)`, so opening the inbox exited the whole application. The
// envelope (`version`, `raises` is an array) was already validated; the
// records inside it were not. This validates what consumers actually rely
// on — `id`, `state`, `scope`, `options`, `recommendation` — and treats a
// bad one as the same kind of `error` result as an unparseable file, never a
// silently shortened list.
describe("a malformed record inside an otherwise-valid envelope is an error, not a crash waiting to happen downstream", () => {
  test("an unrecognised state is an error", () => {
    writeFileSync(path, JSON.stringify({ version: 1, raises: [{ ...raise(), state: "bogus-state" }] }));
    const r = readRaises(path);
    expect(r.kind).toBe("error");
    expect(r.kind === "error" && r.why).toContain("bogus-state");
  });

  test("a scope that is neither a well-formed session scope nor an issue scope is an error", () => {
    writeFileSync(
      path,
      JSON.stringify({ version: 1, raises: [{ ...raise(), scope: { kind: "session", sessionName: "x" } }] }),
    );
    expect(readRaises(path).kind).toBe("error");
  });

  test("options that are not an array of {id, text} is an error", () => {
    writeFileSync(path, JSON.stringify({ version: 1, raises: [{ ...raise(), options: ["not-an-option-object"] }] }));
    expect(readRaises(path).kind).toBe("error");
  });

  test("a recommendation that matches none of the raise's options is an error", () => {
    writeFileSync(path, JSON.stringify({ version: 1, raises: [{ ...raise(), recommendation: "not-an-option-id" }] }));
    expect(readRaises(path).kind).toBe("error");
  });

  test("a missing or blank id is an error", () => {
    writeFileSync(path, JSON.stringify({ version: 1, raises: [{ ...raise(), id: "" }] }));
    expect(readRaises(path).kind).toBe("error");
  });

  // The failure this guards against: a queue that quietly discards the one
  // question it cannot read and tells the operator nothing is waiting on
  // them. One good record plus one bad one must fail the whole read, not
  // read back as "one raise, all fine".
  test("one malformed record among otherwise-valid ones fails the whole read, not a silently shortened list", () => {
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        raises: [raise({ id: "good" }), { ...raise({ id: "bad" }), state: "bogus-state" }],
      }),
    );
    const r = readRaises(path);
    expect(r.kind).toBe("error");
    expect(r.kind === "error" && r.why).toContain("bad");
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
  test("only resolved raises are pruned, ordered by resolvedAt, not createdAt", () => {
    const rs = [
      // Raised long ago but answered recently: createdAt and resolvedAt disagree
      // on purpose. Sorting by createdAt would discard this one, even though it
      // was the most recently resolved.
      raise({ id: "old-question-answered-recently", createdAt: 1, state: "resolved", resolvedAt: 20 }),
      raise({ id: "new-question-resolved-long-ago", createdAt: 2, state: "resolved", resolvedAt: 10 }),
      raise({ id: "open-but-ancient", createdAt: 0, state: "open" }),
    ];
    const kept = pruneResolved(rs, 1).map((r) => r.id).sort();
    // The open raise survives regardless of age. Of the two resolved raises,
    // the one resolved more recently is kept — the one with the newer
    // createdAt is not, because pruning orders by resolvedAt.
    expect(kept).toEqual(["old-question-answered-recently", "open-but-ancient"]);
  });
});
