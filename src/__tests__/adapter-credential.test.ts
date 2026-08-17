import { describe, expect, test } from "bun:test";
import { applyAdapterCredential } from "../adapter-credential";

// Every dependency is injected, so none of this touches a real credentials
// file or a network.

function harness(opts: { verify: () => Promise<boolean>; previous?: string | null }) {
  const writes: Array<string | null> = [];
  let stored: string | null = opts.previous ?? null;
  let persistedType: string | null = null;
  return {
    writes,
    get stored() { return stored; },
    get persistedType() { return persistedType; },
    run: (token: string) =>
      applyAdapterCredential({
        type: "linear",
        token,
        readCredential: () => stored,
        writeCredential: (_type, value) => { writes.push(value); stored = value; },
        persistType: (type) => { persistedType = type; },
        verify: opts.verify,
      }),
  };
}

const ok = () => Promise.resolve(true);
const rejects = () => Promise.resolve(false);

describe("applyAdapterCredential", () => {
  test("a good token is kept, and the adapter type is persisted with it", async () => {
    const h = harness({ verify: ok });
    expect(await h.run("good")).toEqual({ ok: true });
    expect(h.stored).toBe("good");
    // Without the type, createAdapters builds nothing and a stored token
    // connects to nothing, with nothing on screen saying why.
    expect(h.persistedType).toBe("linear");
  });

  // The defect this module exists for: the old flow wrote null on failure, so
  // one mistyped paste over a working setup left the user with no credential
  // at all — strictly worse than before they tried.
  test("a rejected token restores the previous one, never null", async () => {
    const h = harness({ verify: rejects, previous: "the-old-working-token" });
    expect(await h.run("bad")).toEqual({ ok: false });
    expect(h.stored).toBe("the-old-working-token");
    expect(h.writes).toEqual(["bad", "the-old-working-token"]);
  });

  test("a rejected token with no previous credential restores absence", async () => {
    const h = harness({ verify: rejects, previous: null });
    await h.run("bad");
    expect(h.stored).toBeNull();
  });

  test("the adapter type is not persisted when verification fails", async () => {
    const h = harness({ verify: rejects, previous: "old" });
    await h.run("bad");
    // A type pointing at a credential that does not work is a config that
    // looks connected and is not.
    expect(h.persistedType).toBeNull();
  });

  test("a verifier that throws is a rejection, not an escape", async () => {
    const h = harness({
      verify: () => Promise.reject(new Error("network down")),
      previous: "old",
    });
    expect(await h.run("candidate")).toEqual({ ok: false });
    expect(h.stored).toBe("old");
  });

  test("a synchronously throwing verifier also restores", async () => {
    const h = harness({
      verify: () => { throw new Error("boom"); },
      previous: "old",
    });
    expect(await h.run("candidate")).toEqual({ ok: false });
    expect(h.stored).toBe("old");
  });

  test("the candidate is written before verification, because it must be", async () => {
    // Stated rather than hidden: no adapter takes a candidate credential, so
    // there is nowhere to try a token without storing it first.
    const seen: Array<string | null> = [];
    let stored: string | null = "old";
    await applyAdapterCredential({
      type: "linear",
      token: "candidate",
      readCredential: () => stored,
      writeCredential: (_t, v) => { stored = v; },
      persistType: () => {},
      verify: async () => { seen.push(stored); return true; },
    });
    expect(seen).toEqual(["candidate"]);
  });
});
