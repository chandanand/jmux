import { describe, test, expect } from "bun:test";
import { TitleGenerator, resolveTitleConfig, titleRunnerEnv, titleRunnerCwd } from "../session-title/generator";
import { existsSync } from "fs";
import type { TitleRunner } from "../session-title/generator";

const CFG = { command: ["fake"], timeoutMs: 100, maxChars: 48, maxConcurrent: 2 };

interface Harness {
  gen: TitleGenerator;
  titles: Array<{ session: string; title: string; signature: string }>;
  failures: Array<{ session: string; reason: string }>;
  calls: string[];
  peakActive: number;
}

function harness(run: TitleRunner): Harness {
  const h: Harness = { gen: null as never, titles: [], failures: [], calls: [], peakActive: 0 };
  h.gen = new TitleGenerator(
    CFG,
    async (argv, stdin, timeout) => {
      h.calls.push(stdin);
      return run(argv, stdin, timeout);
    },
    (session, title, signature) => h.titles.push({ session, title, signature }),
    (session, reason) => h.failures.push({ session, reason }),
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

  // "A naming failure is silent" governs the runs jmux starts on its own
  // initiative. A run the human asked for by name was a question, and the
  // model call takes tens of seconds — with no answer it is indistinguishable
  // from a key that did nothing.
  describe("explicit requests report their failures", () => {
    test("an automatic run stays silent", async () => {
      const h = harness(async () => { throw new Error("ENOENT"); });
      h.gen.request("tra-123", "sig", "name this");
      await settle();
      expect(h.failures).toEqual([]);
    });

    test("an explicit run reports why, verbatim", async () => {
      const h = harness(async () => { throw new Error("title command exited 127"); });
      h.gen.request("tra-123", "sig", "name this", true);
      await settle();
      expect(h.failures).toEqual([
        { session: "tra-123", reason: "title command exited 127" },
      ]);
    });

    test("an explicit run that produced no usable line reports that too", async () => {
      const h = harness(async () => "   \n");
      h.gen.request("tra-123", "sig", "name this", true);
      await settle();
      expect(h.failures).toEqual([
        { session: "tra-123", reason: "the command printed nothing usable" },
      ]);
    });

    test("a successful explicit run reports a title and no failure", async () => {
      const h = harness(async () => "Fix cache\n");
      h.gen.request("tra-123", "sig", "name this", true);
      await settle();
      expect(h.titles.length).toBe(1);
      expect(h.failures).toEqual([]);
    });

    test("a session forgotten mid-flight gets no failure report either", async () => {
      let release: (() => void) | null = null;
      const gate = new Promise<void>((r) => { release = r; });
      const h = harness(async () => { await gate; throw new Error("boom"); });
      h.gen.request("a", "sig-a", "a", true);
      await settle();
      h.gen.forget("a");
      release!();
      await settle();
      expect(h.failures).toEqual([]);
    });
  });
});

// Every way this config can be wrong fails silently and identically — no
// title, forever, which is also exactly what "off" looks like. That is what
// makes validating it worth code rather than a doc line.
describe("resolveTitleConfig", () => {
  const never = (): string | null => null;
  const found = (c: string): string | null => `/usr/bin/${c}`;

  const collect = (raw: unknown, lookup = found) => {
    const warnings: string[] = [];
    const cfg = resolveTitleConfig(raw, (m) => warnings.push(m), lookup);
    return { cfg, warnings };
  };

  test("unset is off, and says nothing about it", () => {
    expect(collect(null).cfg).toBeNull();
    expect(collect(undefined).cfg).toBeNull();
    expect(collect({}).cfg).toBeNull();
    expect(collect({}).warnings).toEqual([]);
  });

  test("a shell string is refused and named as the mistake it is", () => {
    const { cfg, warnings } = collect({ command: "claude -p" });
    expect(cfg).toBeNull();
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("argv array");
  });

  test("an empty or non-string array is refused", () => {
    expect(collect({ command: [] }).cfg).toBeNull();
    expect(collect({ command: [""] }).cfg).toBeNull();
    expect(collect({ command: ["claude", 3] }).cfg).toBeNull();
    expect(collect({ command: [] }).warnings.length).toBe(1);
  });

  test("a command missing from PATH still runs, but warns — it can never succeed", () => {
    const { cfg, warnings } = collect({ command: ["nope"] }, never);
    expect(cfg?.command).toEqual(["nope"]);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("PATH");
  });

  test("a good command yields the documented defaults and no complaint", () => {
    const { cfg, warnings } = collect({ command: ["claude", "-p"] });
    expect(cfg).toEqual({
      command: ["claude", "-p"],
      timeoutMs: 60_000,
      maxChars: 32,
      maxConcurrent: 2,
    });
    expect(warnings).toEqual([]);
  });

  // maxChars 0 stores a bare "…" — a title that is only an ellipsis is worse
  // than no title, because it looks like a bug in the sidebar rather than a
  // setting the user typed.
  test("out-of-range numbers are clamped, not obeyed", () => {
    expect(collect({ command: ["x"], maxChars: 0 }).cfg?.maxChars).toBe(8);
    expect(collect({ command: ["x"], maxChars: -5 }).cfg?.maxChars).toBe(8);
    expect(collect({ command: ["x"], maxChars: 100_000 }).cfg?.maxChars).toBe(200);
    expect(collect({ command: ["x"], timeoutMs: 1 }).cfg?.timeoutMs).toBe(1_000);
    expect(collect({ command: ["x"], timeoutMs: 9e9 }).cfg?.timeoutMs).toBe(120_000);
  });

  test("a non-number falls back to the default rather than becoming NaN", () => {
    const { cfg } = collect({ command: ["x"], timeoutMs: "20s", maxChars: null });
    expect(cfg?.timeoutMs).toBe(60_000);
    expect(cfg?.maxChars).toBe(32);
  });

  test("a fractional value is rounded, so it can never reach parseTitle as one", () => {
    expect(collect({ command: ["x"], maxChars: 32.7 }).cfg?.maxChars).toBe(33);
  });
});

// The naming command is an agent CLI, and jmux installs state-emitting hooks
// into every agent CLI on the machine. A spawned `claude -p` that inherits
// TMUX_PANE fires UserPromptSubmit -> running, PreToolUse -> running,
// Stop -> complete, SessionEnd -> clear against the human's own pane: the
// sidebar flaps through the whole cycle for every title generated, the
// agent-state subscription fires on each write, and `fetchAgentState` calls
// `requestSessionTitles` again. It also lets the naming prompt land in
// `@jmux-prompt` as that pane's "first prompt".
describe("titleRunnerEnv", () => {
  test("removes the two variables the hooks address a pane with", () => {
    const env = titleRunnerEnv({ PATH: "/usr/bin", TMUX: "/tmp/sock,123,0", TMUX_PANE: "%42" });
    expect(env.TMUX).toBeUndefined();
    expect(env.TMUX_PANE).toBeUndefined();
  });

  test("keeps everything else, because the command needs the user's environment", () => {
    const env = titleRunnerEnv({
      PATH: "/usr/bin", HOME: "/home/x", ANTHROPIC_API_KEY: "not-a-real-key", TMUX_PANE: "%1",
    });
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/x");
    expect(env.ANTHROPIC_API_KEY).toBe("not-a-real-key");
  });

  test("does not mutate the environment it was handed", () => {
    const parent = { TMUX_PANE: "%1", PATH: "/usr/bin" };
    titleRunnerEnv(parent);
    expect(parent.TMUX_PANE).toBe("%1");
  });
});

// The naming command inherits jmux's working directory unless told otherwise,
// and an agent CLI auto-discovers project context from its cwd. Spawned in the
// jmux repo, `claude -p` read that repo's CLAUDE.md and answered "naming
// subprocess isolation" — this branch's work — for an issue about tenant
// subdomains. Measured 9.4s in-repo against 7.6s in a neutral directory, so it
// is a correctness bug first and a latency one second.
describe("titleRunnerCwd", () => {
  test("is not the directory jmux happens to be running in", () => {
    expect(titleRunnerCwd()).not.toBe(process.cwd());
  });

  test("is a real, absolute directory the command can start in", () => {
    const dir = titleRunnerCwd();
    expect(dir.startsWith("/")).toBe(true);
    expect(existsSync(dir)).toBe(true);
  });
});
