import { parseTitle } from "./prompt";

/**
 * The queue in front of the naming command.
 *
 * Three properties are the whole module, and each of them is a rule about *not*
 * calling:
 *
 *  - **The signature is the cache key, and a failure caches under it too.** This
 *    is the rule the image store already follows — never re-enter a call for an
 *    input already seen, including a failed one. The poll runs continuously, so
 *    a model that timed out once would otherwise be asked again every tick,
 *    forever. A new signature is a new attempt; the same one is not.
 *  - **One call in flight per session.** A second request for the same session
 *    queues behind the first rather than racing it, so two calls cannot write
 *    two titles in an order nobody chose.
 *  - **A global concurrency cap.** A first run against twenty existing sessions
 *    drains rather than forking twenty subprocesses.
 *
 * The runner is injected, so the whole thing tests against a fake that returns a
 * canned line, hangs, or throws.
 */

export interface TitleGeneratorConfig {
  /** argv for the naming command; stdin gets the prompt, stdout gives the name. */
  command: readonly string[];
  timeoutMs: number;
  maxChars: number;
  maxConcurrent: number;
}

export type TitleRunner = (
  argv: readonly string[],
  stdin: string,
  timeoutMs: number,
) => Promise<string>;

interface QueuedRequest {
  sessionName: string;
  signature: string;
  prompt: string;
  /** The session's generation at request time — see `generation` below. */
  generation: number;
}

export class TitleGenerator {
  /**
   * Keys are `${sessionName}\0${signature}`. NUL is the separator because
   * neither a tmux session name nor a `titleSignature()` output can ever
   * contain one, so two different (session, signature) pairs can never
   * collide into the same key.
   */
  private readonly attempted = new Set<string>();
  private readonly inFlight = new Set<string>();
  private queue: QueuedRequest[] = [];
  private active = 0;
  /**
   * Bumped by `forget()`. A request captures its session's generation when it
   * is queued; `start()` checks it again when the call resolves, so a call
   * already dispatched when `forget()` fires still finishes (there is no way
   * to cancel a running subprocess-await) but its result is discarded rather
   * than reported for a session that has gone away. Never deleted on forget —
   * only bumped — because a stale entry has to keep outranking generation 0,
   * the value any in-flight request from before the first forget still carries.
   */
  private readonly generation = new Map<string, number>();

  constructor(
    private readonly cfg: TitleGeneratorConfig,
    private readonly run: TitleRunner,
    private readonly onTitle: (sessionName: string, title: string, signature: string) => void,
  ) {}

  private static key(sessionName: string, signature: string): string {
    return `${sessionName}\0${signature}`;
  }

  private currentGeneration(sessionName: string): number {
    return this.generation.get(sessionName) ?? 0;
  }

  /** Ask for a title, unless this exact input has already been tried. */
  request(sessionName: string, signature: string, prompt: string): void {
    const key = TitleGenerator.key(sessionName, signature);
    if (this.attempted.has(key)) return;
    this.attempted.add(key);
    this.queue.push({ sessionName, signature, prompt, generation: this.currentGeneration(sessionName) });
    this.pump();
  }

  /**
   * Drop everything about a session that has gone away.
   *
   * Clears its signature cache: a session name that comes back is a new
   * session, and refusing to name it because a dead one of the same name was
   * once named would be a cache outliving the thing it described.
   *
   * Also bumps its generation, which is what stops a call already in flight
   * for this session from reporting a title after this returns — the queue
   * filter below only reaches work that hasn't been dispatched yet.
   */
  forget(sessionName: string): void {
    this.queue = this.queue.filter((q) => q.sessionName !== sessionName);
    for (const key of this.attempted) {
      if (key.startsWith(`${sessionName}\0`)) this.attempted.delete(key);
    }
    this.generation.set(sessionName, this.currentGeneration(sessionName) + 1);
  }

  /** Queued plus running, for tests and diagnostics. */
  pending(): number {
    return this.queue.length + this.active;
  }

  private pump(): void {
    while (this.active < this.cfg.maxConcurrent) {
      const idx = this.queue.findIndex((q) => !this.inFlight.has(q.sessionName));
      if (idx === -1) return;
      const [req] = this.queue.splice(idx, 1);
      this.start(req);
    }
  }

  private start(req: QueuedRequest): void {
    this.active += 1;
    this.inFlight.add(req.sessionName);
    // `run` is invoked inside `.then()`, not called directly, so a `TitleRunner`
    // that throws synchronously (the type promises nothing about that; only
    // `spawnTitleRunner`'s `async` keyword happens to convert it) still becomes
    // a rejection instead of unwinding out through `pump()` and `request()`,
    // which would otherwise leak this session's `inFlight` slot forever.
    Promise.resolve()
      .then(() => this.run(this.cfg.command, req.prompt, this.cfg.timeoutMs))
      .then((raw) => parseTitle(raw, this.cfg.maxChars))
      // A naming failure is silent. It never raises the session's attention
      // flag — that flag means the human's work needs them, and a model that
      // did not answer is not the human's work. Scoped to just the run+parse
      // step: a bug in the caller's own `onTitle` below must not be mistaken
      // for one of these and vanish with it.
      .catch(() => null)
      .then((title) => {
        // A `forget()` between dispatch and this resolving means the session
        // is gone; the subprocess had already been started and there is no
        // way to cancel it, so the only thing left to do is not report it.
        if (title && this.currentGeneration(req.sessionName) === req.generation) {
          this.onTitle(req.sessionName, title, req.signature);
        }
      })
      .finally(() => {
        this.active -= 1;
        this.inFlight.delete(req.sessionName);
        this.pump();
      });
  }
}

/**
 * The real runner. A thin `Bun.spawn` wrapper, kept beside the queue rather
 * than in main.ts so the module is self-contained, and injected rather than
 * called directly so the queue above never needs a subprocess to test.
 *
 * A non-zero exit is a failure even with output on stdout: a command that
 * printed a usage message and exited 1 has not named anything.
 */
export const spawnTitleRunner: TitleRunner = async (argv, stdin, timeoutMs) => {
  const proc = Bun.spawn([...argv], {
    stdin: new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "ignore",
  });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  try {
    const out = await new Response(proc.stdout).text();
    const code = await proc.exited;
    if (code !== 0) throw new Error(`title command exited ${code}`);
    return out;
  } finally {
    clearTimeout(timer);
  }
};
