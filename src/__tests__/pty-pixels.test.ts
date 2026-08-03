import { describe, test, expect } from "bun:test";
import { PtyPixels, HELPER_SOURCE, type PtyPixelsDeps } from "../pty-pixels";

/** A spawn that records what it was asked to run and what was written to it. */
function recorder(opts: { have?: string[]; stdin?: boolean } = {}) {
  const have = new Set(opts.have ?? ["python3"]);
  const spawned: string[][] = [];
  const written: string[] = [];
  let killed = false;
  let resolveExit: (code: number) => void = () => {};
  const exited = new Promise<number>((r) => { resolveExit = r; });
  const deps: PtyPixelsDeps = {
    which: (cmd) => (have.has(cmd) ? `/usr/bin/${cmd}` : null),
    spawn: (cmd) => {
      spawned.push(cmd);
      return {
        stdin: opts.stdin === false ? null : { write: (s: string) => written.push(s) },
        kill: () => { killed = true; },
        exited,
      };
    },
  };
  return { deps, spawned, written, die: () => resolveExit(1), wasKilled: () => killed };
}

const CELL = { w: 9, h: 19 };

describe("PtyPixels.start", () => {
  test("runs an interpreter against the client tty", () => {
    const rec = recorder();
    const px = PtyPixels.start("/dev/ttys004", rec.deps);
    expect(px).not.toBeNull();
    expect(rec.spawned[0][0]).toBe("python3");
    expect(rec.spawned[0].at(-1)).toBe("/dev/ttys004");
  });

  test("falls back to `python` when `python3` is absent", () => {
    const rec = recorder({ have: ["python"] });
    expect(PtyPixels.start("/dev/ttys004", rec.deps)).not.toBeNull();
    expect(rec.spawned[0][0]).toBe("python");
  });

  // Off is a path that already ships: with no helper the caller keeps using
  // bun-pty's resize, which is exactly what jmux did before this existed.
  test("returns null when no interpreter is available", () => {
    const rec = recorder({ have: [] });
    expect(PtyPixels.start("/dev/ttys004", rec.deps)).toBeNull();
    expect(rec.spawned).toEqual([]);
  });

  test("returns null when the process gives no stdin to write to", () => {
    expect(PtyPixels.start("/dev/ttys004", recorder({ stdin: false }).deps)).toBeNull();
  });

  test("refuses anything that is not a device path", () => {
    // tmux names control-mode clients things like `client-1234`, which are not
    // ttys and must never be opened as one.
    expect(PtyPixels.start("client-1234", recorder().deps)).toBeNull();
    expect(PtyPixels.start("", recorder().deps)).toBeNull();
  });

  test("refuses a path that only starts out looking like a device", () => {
    // A `startsWith("/dev/")` check passes all of these. It reads like
    // validation, which is worse than no check at all — the next reader
    // believes it.
    expect(PtyPixels.start("/dev/../etc/passwd", recorder().deps)).toBeNull();
    expect(PtyPixels.start("/dev/tty; rm -rf /", recorder().deps)).toBeNull();
    expect(PtyPixels.start("/dev/tty$(id)", recorder().deps)).toBeNull();
    // ...and still accepts the real thing.
    expect(PtyPixels.start("/dev/ttys004", recorder().deps)).not.toBeNull();
  });
});

describe("when the helper dies", () => {
  // apply() writes into a pipe, so a size handed to a helper that died before
  // draining it is simply gone — and resizeTmuxPty has already skipped
  // pty.resize() on the strength of a `true` return. Without this callback
  // exactly one resize vanishes, which on a lone SIGWINCH is a frame that
  // never corrects itself.
  test("tells its owner, so the swallowed resize can be replayed", async () => {
    const rec = recorder();
    let deaths = 0;
    PtyPixels.start("/dev/ttys004", rec.deps, () => { deaths++; });
    expect(deaths).toBe(0);
    rec.die();
    await Bun.sleep(1);
    expect(deaths).toBe(1);
  });

  test("says so only once", async () => {
    const rec = recorder();
    let deaths = 0;
    const px = PtyPixels.start("/dev/ttys004", rec.deps, () => { deaths++; })!;
    rec.die();
    await Bun.sleep(1);
    px.apply(80, 24, CELL); // already dead — must not re-fire
    expect(deaths).toBe(1);
  });

  test("stays quiet when the owner is the one stopping it", async () => {
    // stop() is deliberate shutdown. Replaying a resize there would fight
    // whatever is tearing down.
    const rec = recorder();
    let deaths = 0;
    const px = PtyPixels.start("/dev/ttys004", rec.deps, () => { deaths++; })!;
    px.stop();
    await Bun.sleep(1);
    expect(deaths).toBe(0);
  });

  test("reports death when the write throws, not just when the process exits", async () => {
    let deaths = 0;
    const deps: PtyPixelsDeps = {
      which: () => "/usr/bin/python3",
      spawn: () => ({ stdin: { write: () => { throw new Error("EPIPE"); } }, kill: () => {} }),
    };
    const px = PtyPixels.start("/dev/ttys004", deps, () => { deaths++; })!;
    expect(px.apply(80, 24, CELL)).toBe(false);
    expect(deaths).toBe(1);
  });
});

describe("apply", () => {
  test("sends the size and the pixel geometry derived from it", () => {
    const rec = recorder();
    const px = PtyPixels.start("/dev/ttys004", rec.deps)!;
    expect(px.apply(80, 24, CELL)).toBe(true);
    expect(rec.written).toEqual([`80 24 ${80 * 9} ${24 * 19}\n`]);
  });

  test("refuses a nonsensical size rather than writing zeros", () => {
    // Zero pixel fields are precisely what resets tmux to its 16×32 fallback,
    // so writing them would be worse than not writing at all.
    const rec = recorder();
    const px = PtyPixels.start("/dev/ttys004", rec.deps)!;
    expect(px.apply(0, 24, CELL)).toBe(false);
    expect(px.apply(80, 0, CELL)).toBe(false);
    expect(px.apply(80, 24, { w: 0, h: 19 })).toBe(false);
    expect(px.apply(80, 24, { w: 9, h: 0 })).toBe(false);
    expect(rec.written).toEqual([]);
  });

  test("reports failure once the helper exits, so the caller can fall back", async () => {
    const rec = recorder();
    const px = PtyPixels.start("/dev/ttys004", rec.deps)!;
    expect(px.alive).toBe(true);
    rec.die();
    await Bun.sleep(1);
    expect(px.alive).toBe(false);
    expect(px.apply(80, 24, CELL)).toBe(false);
  });

  test("reports failure when the write itself throws", () => {
    const deps: PtyPixelsDeps = {
      which: () => "/usr/bin/python3",
      spawn: () => ({ stdin: { write: () => { throw new Error("EPIPE"); } }, kill: () => {} }),
    };
    const px = PtyPixels.start("/dev/ttys004", deps)!;
    expect(px.apply(80, 24, CELL)).toBe(false);
    expect(px.alive).toBe(false);
  });

  test("stop() kills the helper and stops accepting writes", () => {
    const rec = recorder();
    const px = PtyPixels.start("/dev/ttys004", rec.deps)!;
    px.stop();
    expect(rec.wasKilled()).toBe(true);
    expect(px.apply(80, 24, CELL)).toBe(false);
  });
});

describe("the helper source", () => {
  // Each of these encodes something that was wrong at least once, and that a
  // well-meaning tidy-up would remove.
  test("opens the tty without claiming it as a controlling terminal", () => {
    expect(HELPER_SOURCE).toContain("O_NOCTTY");
  });

  test("compares against the tty's real size, not a remembered one", () => {
    // tmux ignores a size write whose rows and columns are unchanged. At
    // startup the size is already correct, so a helper trusting its own memory
    // never bounces and the geometry never lands.
    expect(HELPER_SOURCE).toContain("TIOCGWINSZ");
    expect(HELPER_SOURCE).toContain("if cur() == (c, r):");
  });

  test("pauses between the bounce and the real size", () => {
    // tmux reads the size once per SIGWINCH. Back-to-back writes are read
    // after both, look like no change at all, and are dropped.
    expect(HELPER_SOURCE).toMatch(/time\.sleep\(0\.\d+\)/);
  });

  test("is valid python that a real interpreter accepts", () => {
    const python = Bun.which("python3") ?? Bun.which("python");
    if (!python) return; // not a reason to fail a clean checkout
    const out = Bun.spawnSync([python, "-c", `compile(open(0).read(), 'h', 'exec')`], {
      stdin: new TextEncoder().encode(HELPER_SOURCE),
    });
    expect(new TextDecoder().decode(out.stderr)).toBe("");
    expect(out.exitCode).toBe(0);
  });
});
