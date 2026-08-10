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

/** Defaults and the bounds a hand-edited value is pulled back into. */
const TIMEOUT_DEFAULT_MS = 20_000;
const TIMEOUT_MIN_MS = 1_000;
const TIMEOUT_MAX_MS = 120_000;
const MAX_CHARS_DEFAULT = 48;
/** Below this a title is not a phrase; `maxChars: 0` stores a bare `…`. */
const MAX_CHARS_MIN = 8;
const MAX_CHARS_MAX = 200;

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/**
 * Turn the raw `sessionTitle` block out of config.json into something the
 * generator can run, or null.
 *
 * Validated rather than cast, because **every way this can be wrong fails
 * silently and identically**. `config.ts` is a bare `JSON.parse`, so
 * `"command": "claude -p"` — a string, the natural thing to write — survives
 * every structural check jmux had, and `Bun.spawn` on a string spreads it into
 * argv `["c","l","a","u","d","e"," ","-","p"]`: ENOENT, caught by the
 * generator's own "a naming failure is silent" rule, and then nothing happens
 * for the life of the process with no way to find out why. A binary genuinely
 * missing from PATH lands in exactly the same place, which is why `lookup`
 * runs here too — the feature has no other diagnostic surface, and silence is
 * indistinguishable from "off", which is also the default.
 *
 * `warn` and `lookup` are injected so the whole decision table tests without
 * capturing stderr or needing the command to exist.
 */
export function resolveTitleConfig(
  raw: unknown,
  warn: (message: string) => void,
  lookup: (command: string) => string | null = (c) => Bun.which(c),
): TitleGeneratorConfig | null {
  if (raw === null || typeof raw !== "object") return null;
  const cfg = raw as { command?: unknown; timeoutMs?: unknown; maxChars?: unknown };
  if (cfg.command === undefined || cfg.command === null) return null; // unset is off

  if (!Array.isArray(cfg.command)) {
    warn(
      'jmux: sessionTitle.command must be an argv array, not a string — use ["claude", "-p"], not "claude -p"',
    );
    return null;
  }
  if (cfg.command.length === 0 || !cfg.command.every((a) => typeof a === "string" && a.length > 0)) {
    warn("jmux: sessionTitle.command must be a non-empty array of non-empty strings — session naming is off");
    return null;
  }

  const command = cfg.command as string[];
  if (lookup(command[0]!) === null) {
    warn(`jmux: sessionTitle.command "${command[0]}" was not found on PATH — session naming will never produce a title`);
  }

  return {
    command,
    timeoutMs: clampNumber(cfg.timeoutMs, TIMEOUT_DEFAULT_MS, TIMEOUT_MIN_MS, TIMEOUT_MAX_MS),
    maxChars: clampNumber(cfg.maxChars, MAX_CHARS_DEFAULT, MAX_CHARS_MIN, MAX_CHARS_MAX),
    maxConcurrent: 2,
  };
}

interface QueuedRequest {
  sessionName: string;
  signature: string;
  prompt: string;
  /** The session's generation at request time — see `generation` below. */
  generation: number;
  /** The human asked for this one by name — see `onFailure`. */
  explicit: boolean;
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
    /**
     * Reported only for a request the human made by name.
     *
     * "A naming failure is silent" governs the runs jmux starts on its own
     * initiative — the same distinction `transitionConfirm` draws for
     * `ctl issue move`. A run somebody asked for was a question, and a question
     * that gets no answer and no error is indistinguishable from a key that did
     * nothing. Automatic runs stay silent because they are continuous: one
     * unreachable command would otherwise report itself on every poll forever.
     */
    private readonly onFailure?: (sessionName: string, reason: string) => void,
  ) {}

  private static key(sessionName: string, signature: string): string {
    return `${sessionName}\0${signature}`;
  }

  private currentGeneration(sessionName: string): number {
    return this.generation.get(sessionName) ?? 0;
  }

  /** Ask for a title, unless this exact input has already been tried. */
  request(sessionName: string, signature: string, prompt: string, explicit = false): void {
    const key = TitleGenerator.key(sessionName, signature);
    if (this.attempted.has(key)) return;
    this.attempted.add(key);
    this.queue.push({
      sessionName,
      signature,
      prompt,
      generation: this.currentGeneration(sessionName),
      explicit,
    });
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
    // Why the failure is *recorded* rather than only swallowed: an explicit
    // request needs to say what went wrong, and "ENOENT" and "the model
    // returned a blank line" are different problems with different fixes.
    let reason: string | null = null;
    // `run` is invoked inside `.then()`, not called directly, so a `TitleRunner`
    // that throws synchronously (the type promises nothing about that; only
    // `spawnTitleRunner`'s `async` keyword happens to convert it) still becomes
    // a rejection instead of unwinding out through `pump()` and `request()`,
    // which would otherwise leak this session's `inFlight` slot forever.
    Promise.resolve()
      .then(() => this.run(this.cfg.command, req.prompt, this.cfg.timeoutMs))
      .then((raw) => parseTitle(raw, this.cfg.maxChars))
      // A naming failure raises nothing on its own. It never sets the session's
      // attention flag — that flag means the human's work needs them, and a
      // model that did not answer is not the human's work. Scoped to just the
      // run+parse step: a bug in the caller's own `onTitle` below must not be
      // mistaken for one of these and vanish with it.
      .catch((e: unknown) => {
        reason = e instanceof Error ? e.message : String(e);
        return null;
      })
      .then((title) => {
        // A `forget()` between dispatch and this resolving means the session
        // is gone; the subprocess had already been started and there is no
        // way to cancel it, so the only thing left to do is not report it.
        // That guard covers the failure report too — nobody is waiting on an
        // answer about a session that has gone away.
        if (this.currentGeneration(req.sessionName) !== req.generation) return;
        if (title) this.onTitle(req.sessionName, title, req.signature);
        else if (req.explicit) {
          this.onFailure?.(req.sessionName, reason ?? "the command printed nothing usable");
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
