import { tmpdir } from "os";

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
/**
 * Generous, because a timeout here is not a retry — it caches as a failure
 * under the input's signature and that input is never asked about again. An
 * agent CLI is a whole harness booting before it answers: `claude -p` measured
 * 7-22s on a warm machine for a five-word reply, so the previous 20s tripped on
 * ordinary variance and permanently gave up on a session that would have been
 * named fine a second later. The cost of waiting is nothing — the call is
 * async, off the render path, and capped at two concurrent.
 */
const TIMEOUT_DEFAULT_MS = 60_000;
const TIMEOUT_MIN_MS = 1_000;
const TIMEOUT_MAX_MS = 120_000;
/**
 * The default budget, chosen against the sidebar rather than against what a
 * model can write. A 26-column sidebar shows about twenty characters of row 1
 * before it truncates, and a wider one still reads better with a short phrase
 * than a long one cut off — so this is deliberately near the surface that
 * constrains it. The palette and `ctl` have more room, and a title that fits
 * everywhere beats one that fits only where there is space.
 */
export const MAX_CHARS_DEFAULT = 32;
/** Below this a title is not a phrase; `maxChars: 0` stores a bare `…`. */
export const MAX_CHARS_MIN = 8;
export const MAX_CHARS_MAX = 200;

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
  // Only argv[0] must be non-empty. Empty later arguments are valid argv and
  // sometimes meaningful — the shipped Claude preset uses `--tools ""` to
  // disable tools. Rejecting that argument made the preset disable the title
  // generator it was meant to configure.
  if (
    cfg.command.length === 0 ||
    typeof cfg.command[0] !== "string" ||
    cfg.command[0].length === 0 ||
    !cfg.command.every((a) => typeof a === "string")
  ) {
    warn("jmux: sessionTitle.command must have a non-empty executable followed by string arguments — session naming is off");
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

  /**
   * The resolved, clamped character budget, for callers building the prompt.
   *
   * Exposed rather than re-read from config at the call site, because the raw
   * config value is neither defaulted nor clamped: a caller reading it directly
   * would ask the model for a budget this class then enforces a different one
   * for, and every title would come back one character too long and truncated.
   */
  maxChars(): number {
    return this.cfg.maxChars;
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
/**
 * The environment the naming command runs in.
 *
 * `TMUX` and `TMUX_PANE` are removed, and that is not tidiness — it is the
 * whole reason this function exists. The naming command is an agent CLI, and
 * `jmux --install-agent-hooks` installs jmux's own state emitters into every
 * agent CLI on the machine. A `claude -p` that inherits `TMUX_PANE` therefore
 * fires them against the pane jmux itself was launched from: `UserPromptSubmit`
 * writes `running`, `PreToolUse` writes `running`, `Stop` writes `complete`,
 * `SessionEnd` clears — so the sidebar flaps through the entire agent lifecycle
 * once per title generated, on a session that is doing nothing of the kind.
 *
 * It compounds twice over. Each of those writes fires the agent-state
 * subscription, which runs `fetchAgentState`, which calls
 * `requestSessionTitles` — so naming feeds itself work. And because the capture
 * gate is on whenever titling is configured, the naming prompt itself lands in
 * `@jmux-prompt` as that pane's "first prompt", which is then what the pane
 * gets named after.
 *
 * Stripping the two variables is enough: they are the only way the hook
 * addresses a pane, and with them gone `tmux set-option -p -t ""` cannot
 * resolve a target and the `|| true` on every hook swallows it.
 */
export function titleRunnerEnv(parent: Record<string, string | undefined>): Record<string, string | undefined> {
  const env = { ...parent };
  delete env.TMUX;
  delete env.TMUX_PANE;
  return env;
}

/**
 * The directory the naming command runs in.
 *
 * Deliberately not jmux's own, for the same class of reason `titleRunnerEnv`
 * strips `TMUX_PANE`: an agent CLI auto-discovers project context from its
 * working directory, and jmux's is whatever repo it was started in. Spawned
 * there, `claude -p` read that repo's `CLAUDE.md` and answered with what *that
 * checkout* was working on — "naming subprocess isolation" for an issue about
 * tenant subdomains. Everything the model legitimately needs is in the prompt;
 * anything it picks up from the cwd is another session's context leaking into
 * this one's name. It costs latency too (9.4s in-repo against 7.6s neutral),
 * but the wrong answer is the reason.
 */
export function titleRunnerCwd(): string {
  return tmpdir();
}

export const spawnTitleRunner: TitleRunner = async (argv, stdin, timeoutMs) => {
  const proc = Bun.spawn([...argv], {
    stdin: new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "ignore",
    env: titleRunnerEnv(process.env),
    cwd: titleRunnerCwd(),
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
