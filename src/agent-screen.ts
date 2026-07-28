import type { AgentState } from "./types";

/**
 * Screen-signature detection: the fallback tier for agents that expose no
 * integration surface at all (no hooks, no extension bus). It reads a pane's
 * visible text and matches it against per-agent patterns.
 *
 * This is how competing multiplexers detect *every* agent. jmux uses it only
 * where nothing better exists, because it is strictly worse than a push-based
 * hook in three ways: it lags by up to a poll interval, it can be defeated by a
 * theme or a narrow pane wrapping a phrase, and — unlike a hook, which reports
 * a transition the agent actually made — it can be confidently wrong.
 *
 * Two rules keep that contained:
 *
 *  - A pane that declares `@jmux-agent-kind` is already reporting for itself.
 *    The screen tier may only contribute states that agent *cannot* observe
 *    (see `agentReports`), so it never overrides a fact with a guess.
 *  - Signatures are data, not code. The built-in table is deliberately thin —
 *    a pattern is only shipped once it has been observed on a real screen —
 *    and users extend it through config without waiting for a jmux release.
 */

export interface ScreenSignature {
  /** Regex source matched case-insensitively against `pane_current_command`. */
  command: string;
  /** Regex sources; any match claims the state. */
  waiting?: string[];
  running?: string[];
  complete?: string[];
}

export interface CompiledSignature {
  command: RegExp;
  waiting: RegExp[];
  running: RegExp[];
  complete: RegExp[];
}

/**
 * Built-in signatures. Every pattern here was read off a real terminal, not
 * inferred from documentation — an unverified pattern is worse than none,
 * because it produces a confident wrong answer instead of an honest blank.
 */
export const BUILTIN_SIGNATURES: readonly ScreenSignature[] = [
  {
    command: "opencode",
    // The idle composer: placeholder text plus the shortcut hint row. Both are
    // present only when opencode is sitting waiting for the user to type.
    complete: ["Ask anything\\.\\.\\.", "ctrl\\+p\\s+commands"],
  },
];

function compileList(sources: unknown): RegExp[] {
  const out: RegExp[] = [];
  if (!Array.isArray(sources)) return out;
  for (const src of sources) {
    if (typeof src !== "string" || src === "") continue;
    try {
      out.push(new RegExp(src, "i"));
    } catch {
      // A bad pattern disables itself rather than taking the whole table down;
      // these come from user config and must not be able to crash startup.
    }
  }
  return out;
}

/**
 * Compile a signature table. Takes `unknown` deliberately: this data comes
 * straight from hand-edited `config.json`, and the compiled result is built at
 * module scope, so *any* throw here is a boot failure with a raw stack trace
 * and no path to recovery. A malformed table degrades to an empty one; a
 * malformed entry drops only itself.
 *
 * Callers must not pre-spread the raw config value either — a non-iterable like
 * `{}` or `5` throws before this function is ever reached. Pass it in raw.
 */
export function compileSignatures(signatures: unknown): CompiledSignature[] {
  const out: CompiledSignature[] = [];
  if (!Array.isArray(signatures)) return out;
  for (const raw of signatures) {
    if (raw === null || typeof raw !== "object") continue;
    const sig = raw as Partial<ScreenSignature>;
    if (typeof sig.command !== "string" || sig.command === "") continue;
    let command: RegExp;
    try {
      command = new RegExp(sig.command, "i");
    } catch {
      continue;
    }
    out.push({
      command,
      waiting: compileList(sig.waiting),
      running: compileList(sig.running),
      complete: compileList(sig.complete),
    });
  }
  return out;
}

/**
 * Whether any signature could possibly apply to this pane's foreground command.
 *
 * Callers use this to avoid capturing pane content they will certainly discard.
 * Capturing is the expensive part — a full screen buffer per pane per tick over
 * the control channel — and the command is already free in the row.
 */
export function hasSignatureFor(
  command: string,
  signatures: readonly CompiledSignature[],
): boolean {
  if (!command) return false;
  return signatures.some((sig) => sig.command.test(command));
}

/**
 * Classify one pane. `screen` is the pane's *visible* text (no scrollback — a
 * permission prompt from twenty minutes ago is not the current state).
 *
 * Precedence matches the session rollup: waiting beats running beats complete,
 * so a screen showing both a spinner and a prompt reports the prompt.
 */
export function classifyPaneScreen(
  command: string,
  screen: string,
  signatures: readonly CompiledSignature[],
): AgentState | null {
  if (!command || !screen) return null;
  for (const sig of signatures) {
    if (!sig.command.test(command)) continue;
    if (sig.waiting.some((re) => re.test(screen))) return "waiting";
    if (sig.running.some((re) => re.test(screen))) return "running";
    if (sig.complete.some((re) => re.test(screen))) return "complete";
  }
  return null;
}
