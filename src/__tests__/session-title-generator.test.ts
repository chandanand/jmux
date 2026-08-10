import { describe, test, expect } from "bun:test";
import { TitleGenerator } from "../session-title/generator";
import type { TitleRunner } from "../session-title/generator";

const CFG = { command: ["fake"], timeoutMs: 100, maxChars: 48, maxConcurrent: 2 };

interface Harness {
  gen: TitleGenerator;
  titles: Array<{ session: string; title: string; signature: string }>;
  calls: string[];
  peakActive: number;
}

function harness(run: TitleRunner): Harness {
  const h: Harness = { gen: null as never, titles: [], calls: [], peakActive: 0 };
  h.gen = new TitleGenerator(
    CFG,
    async (argv, stdin, timeout) => {
      h.calls.push(stdin);
      return run(argv, stdin, timeout);
    },
    (session, title, signature) => h.titles.push({ session, title, signature }),
  );
  return h;
}

/** Let the generator's queue drain. */
const settle = () => new Promise((r) => setTimeout(r, 20));

describe("TitleGenerator", () => {
  test("generates a title and reports it with its signature", async () => {
    const h = harness(async () => "Fix stale cache headers\n");
    h.gen.request("tra-123", "i-tra-123", "name this");
    await settle();
    expect(h.titles).toEqual([
      { session: "tra-123", title: "Fix stale cache headers", signature: "i-tra-123" },
    ]);
  });

  test("does not ask twice for the same signature", async () => {
    const h = harness(async () => "A title");
    h.gen.request("tra-123", "i-tra-123", "name this");
    await settle();
    h.gen.request("tra-123", "i-tra-123", "name this");
    await settle();
    expect(h.calls.length).toBe(1);
  });

  test("a failure caches too, so a broken command is not retried forever", async () => {
    const h = harness(async () => { throw new Error("boom"); });
    h.gen.request("tra-123", "i-tra-123", "name this");
    await settle();
    h.gen.request("tra-123", "i-tra-123", "name this");
    await settle();
    expect(h.calls.length).toBe(1);
    expect(h.titles).toEqual([]);
  });

  test("output with nothing usable in it reports no title and is not retried", async () => {
    const h = harness(async () => "   \n");
    h.gen.request("tra-123", "i-tra-123", "name this");
    await settle();
    h.gen.request("tra-123", "i-tra-123", "name this");
    await settle();
    expect(h.calls.length).toBe(1);
    expect(h.titles).toEqual([]);
  });

  test("a new signature for the same session is asked again", async () => {
    const h = harness(async () => "A title");
    h.gen.request("tra-123", "i-tra-123", "one");
    await settle();
    h.gen.request("tra-123", "i-tra-123.tra-9", "two");
    await settle();
    expect(h.calls).toEqual(["one", "two"]);
  });

  test("one call in flight per session", async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((r) => { release = r; });
    const h = harness(async () => { await gate; return "A title"; });
    h.gen.request("tra-123", "sig-a", "one");
    h.gen.request("tra-123", "sig-b", "two");
    await settle();
    expect(h.calls).toEqual(["one"]);
    release!();
    await settle();
    expect(h.calls).toEqual(["one", "two"]);
  });

  test("never exceeds maxConcurrent across sessions", async () => {
    let active = 0;
    let peak = 0;
    let release: (() => void) | null = null;
    const gate = new Promise<void>((r) => { release = r; });
    const h = harness(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await gate;
      active -= 1;
      return "A title";
    });
    for (const n of ["a", "b", "c", "d", "e"]) h.gen.request(n, `sig-${n}`, n);
    await settle();
    expect(peak).toBe(2);
    release!();
    await settle();
    expect(h.titles.length).toBe(5);
  });

  test("forget drops queued work for a session that has gone away", async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((r) => { release = r; });
    const h = harness(async () => { await gate; return "A title"; });
    h.gen.request("a", "sig-a", "a");
    h.gen.request("b", "sig-b", "b");
    h.gen.request("c", "sig-c", "c");
    await settle();
    h.gen.forget("c");
    release!();
    await settle();
    expect(h.titles.map((t) => t.session).sort()).toEqual(["a", "b"]);
  });

  test("forget clears the signature cache, so a re-created session is titled again", async () => {
    const h = harness(async () => "A title");
    h.gen.request("a", "sig-a", "first");
    await settle();
    h.gen.forget("a");
    h.gen.request("a", "sig-a", "second");
    await settle();
    expect(h.calls).toEqual(["first", "second"]);
  });

  test("forget while a call is in flight drops the result, not just the queue", async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((r) => { release = r; });
    const h = harness(async () => { await gate; return "A title"; });
    h.gen.request("a", "sig-a", "a");
    await settle();
    h.gen.forget("a");
    release!();
    await settle();
    expect(h.titles).toEqual([]);
  });

  test("a runner that throws synchronously does not throw out of request() or deadlock the session", async () => {
    const calls: string[] = [];
    const titles: Array<{ session: string; title: string; signature: string }> = [];
    const syncThrowRunner: TitleRunner = (_argv, stdin) => {
      calls.push(stdin);
      throw new Error("sync boom");
    };
    const gen = new TitleGenerator(CFG, syncThrowRunner, (session, title, signature) =>
      titles.push({ session, title, signature }),
    );

    expect(() => gen.request("tra-123", "i-tra-123", "name this")).not.toThrow();
    await settle();
    expect(calls.length).toBe(1);
    expect(titles).toEqual([]);

    // The session's in-flight slot was released, so a later request for the
    // same session (a different signature, since the first is now cached as
    // a failure) still runs rather than deadlocking forever.
    gen.request("tra-123", "i-tra-123.tra-9", "name this again");
    await settle();
    expect(calls.length).toBe(2);
  });
});
