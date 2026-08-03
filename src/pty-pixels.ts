// src/pty-pixels.ts
//
// Telling tmux how big a character actually is.
//
// tmux learns its cell geometry from exactly one place: the `ws_xpixel` /
// `ws_ypixel` fields of its client tty's window size. Nothing else feeds it —
// it answers a pane's `CSI 16 t` query itself, from that figure, and never
// forwards the query to the terminal. With those fields at zero it falls back
// to a hardcoded 16×32, and every program in every pane is told a character is
// 16×32 device pixels no matter what the terminal is really doing. For anything
// drawing pictures that is the difference between a canvas whose aspect matches
// its pane and one that doesn't.
//
// jmux knows the true figure — it probes the terminal for it already
// (`CELL_SIZE_PROBE`, see images/kitty.ts). What it cannot do is *write* it.
// `TIOCSWINSZ` needs an `ioctl`, `ioctl` is variadic, and on arm64 Darwin the
// ABI passes variadic arguments on the stack while Bun's FFI passes them in
// registers — the callee then reads a garbage pointer and the process
// segfaults. That is measured, not assumed. bun-pty exposes no descriptor to
// work with either, and a compiled shim would break the no-build-step rule the
// whole package rests on.
//
// The way through is that tmux's client tty is not a private handle: it is a
// device file with a path (`/dev/ttysNNN`, the same string tmux reports as
// `#{client_name}`). Any process that can open it can set its window size. So
// jmux keeps one small long-lived helper alive and hands it sizes to apply.
//
// Three things about this are load-bearing:
//
//   - **tmux only re-reads the window size when rows or columns change.** A
//     pixel-only write is silently ignored, which is why priming an
//     already-correct size has to bounce a column and come back.
//   - **A resize that omits the pixel fields resets tmux to 16×32.** bun-pty's
//     `resize()` writes zeros there, so once this is running it must own the
//     resize outright rather than patching up afterwards — otherwise every
//     relayout re-breaks it and races whatever is reading.
//   - **Off is a path that already ships.** No helper, no interpreter, a helper
//     that dies — all fall back to `bun-pty`'s resize, which is exactly what
//     jmux did before this file existed. There is no degraded third mode.

/** Cell geometry in device pixels, as probed from the real terminal. */
export interface CellPixels {
  w: number;
  h: number;
}

/**
 * The helper, as source. It holds the tty open and applies sizes off stdin so
 * a drag costs a pipe write rather than a process spawn.
 *
 * `O_NOCTTY` matters: without it, opening a tty could make it this process's
 * controlling terminal, which is not ours to claim.
 */
export const HELPER_SOURCE = `
import sys, os, time, fcntl, termios, struct
fd = os.open(sys.argv[1], os.O_RDWR | os.O_NOCTTY)
def put(c, r, x, y):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', r, c, x, y))
def cur():
    r, c, x, y = struct.unpack('HHHH', fcntl.ioctl(fd, termios.TIOCGWINSZ, b'\\0'*8))
    return c, r
for line in sys.stdin:
    parts = line.split()
    if len(parts) != 4:
        continue
    c, r, x, y = (int(v) for v in parts)
    # Read the tty rather than remembering what we last sent: tmux ignores a
    # window-size write whose rows and columns are unchanged, so if the size is
    # already right the pixel fields would go nowhere. Give it a column to
    # notice, then land on the true size carrying the geometry. Reading the
    # real size makes this correct on the first write too, which is exactly the
    # case that matters — at startup the size is already what we want.
    if cur() == (c, r):
        put(max(1, c - 1), r, max(1, x - (x // max(1, c))), y)
        # tmux reads the size once per SIGWINCH. Without a pause it reads after
        # both writes, sees the size it already had, and ignores the geometry.
        time.sleep(0.12)
    put(c, r, x, y)
    sys.stdout.write("ok\\n")
    sys.stdout.flush()
`.trim();

/** Interpreters that can do the ioctl, best first. */
const INTERPRETERS = ["python3", "python"];

export interface PtyPixelsDeps {
  which: (cmd: string) => string | null;
  spawn: (cmd: string[]) => {
    stdin: { write: (s: string) => void } | null;
    kill: () => void;
    exited?: Promise<number>;
  } | null;
}

/**
 * Owns the helper process. Construct it with the tty path once tmux has
 * reported a client; call `apply()` in place of the pty's own resize.
 */
/**
 * A tty path we are willing to open read-write.
 *
 * `startsWith("/dev/")` reads like validation and isn't — `/dev/../etc/passwd`
 * passes it. The value comes from our own tmux so this is defence in depth
 * rather than a live hole, but a check that only looks like one is worse than
 * none, because the next reader believes it.
 *
 * `/` stays in the class because Linux ttys live at `/dev/pts/3`, which is
 * exactly what lets `..` back in — hence the lookahead. A first attempt at this
 * regex without it still accepted `/dev/../etc/passwd`.
 */
const TTY_PATH = /^\/dev\/(?!.*\.\.)[A-Za-z0-9._\/-]+$/;

export class PtyPixels {
  private proc: ReturnType<PtyPixelsDeps["spawn"]> = null;
  private dead = false;

  private constructor(
    private readonly deps: PtyPixelsDeps,
    private readonly tty: string,
    private readonly onDead?: () => void,
  ) {}

  /**
   * Start a helper for `tty`, or return null if nothing on this machine can run
   * one. Null is the ordinary case on a minimal box and is not an error — the
   * caller keeps using the pty's own resize.
   *
   * `onDead` fires when the helper stops being usable. The caller owes the
   * resize a reply there: `apply()` writes into a pipe, so a size handed to a
   * helper that died before draining it is simply gone, and the caller has
   * already skipped the fallback on the strength of a `true` return.
   */
  static start(tty: string, deps: PtyPixelsDeps, onDead?: () => void): PtyPixels | null {
    if (!TTY_PATH.test(tty)) return null;
    const instance = new PtyPixels(deps, tty, onDead);
    return instance.spawnHelper() ? instance : null;
  }

  private spawnHelper(): boolean {
    for (const name of INTERPRETERS) {
      if (!this.deps.which(name)) continue;
      const proc = this.deps.spawn([name, "-u", "-c", HELPER_SOURCE, this.tty]);
      if (!proc?.stdin) continue;
      this.proc = proc;
      proc.exited?.then(() => this.markDead()).catch(() => this.markDead());
      return true;
    }
    return false;
  }

  /** Once, and only while the caller still thinks we're live. */
  private markDead(): void {
    if (this.dead) return;
    this.dead = true;
    this.onDead?.();
  }

  /** True while the helper is alive and worth writing to. */
  get alive(): boolean {
    return !this.dead && this.proc?.stdin != null;
  }

  /**
   * Resize the client tty, carrying the cell geometry.
   *
   * Returns false if the helper is gone, which is the caller's signal to fall
   * back to the pty's own resize for this and every later call.
   */
  apply(cols: number, rows: number, cell: CellPixels): boolean {
    if (!this.alive) return false;
    if (cols <= 0 || rows <= 0 || cell.w <= 0 || cell.h <= 0) return false;
    try {
      this.proc!.stdin!.write(`${cols} ${rows} ${cols * cell.w} ${rows * cell.h}\n`);
      return true;
    } catch {
      this.markDead();
      return false;
    }
  }

  /** Deliberate shutdown: no `onDead`, because the caller is the one stopping us. */
  stop(): void {
    this.dead = true;
    try { this.proc?.kill(); } catch {}
    this.proc = null;
  }
}
