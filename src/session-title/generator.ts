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

  constructor(
    private readonly cfg: TitleGeneratorConfig,
    private readonly run: TitleRunner,
    private readonly onTitle: (sessionName: string, title: string, signature: string) => void,
  ) {}

  private static key(sessionName: string, signature: string): string {
    return `${sessionName}\0${signature}`;
  }

  /** Ask for a title, unless this exact input has already been tried. */
  request(sessionName: string, signature: string, prompt: string): void {
    const key = TitleGenerator.key(sessionName, signature);
    if (this.attempted.has(key)) return;
    this.attempted.add(key);
    this.queue.push({ sessionName, signature, prompt });
    this.pump();
  }

  /**
   * Drop everything about a session that has gone away.
   *
   * Also clears its signature cache: a session name that comes back is a new
   * session, and refusing to name it because a dead one of the same name was
   * once named would be a cache outliving the thing it described.
   */
  forget(sessionName: string): void {
    this.queue = this.queue.filter((q) => q.sessionName !== sessionName);
    for (const key of this.attempted) {
      if (key.startsWith(`${sessionName}\0`)) this.attempted.delete(key);
    }
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
    this.run(this.cfg.command, req.prompt, this.cfg.timeoutMs)
      .then((raw) => {
        const title = parseTitle(raw, this.cfg.maxChars);
        if (title) this.onTitle(req.sessionName, title, req.signature);
      })
      // A naming failure is silent. It never raises the session's attention
      // flag — that flag means the human's work needs them, and a model that
      // did not answer is not the human's work.
      .catch(() => {})
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
