/**
 * Config generation — detecting a tmux server running yesterday's config.
 *
 * `-f <file>` is honored **only when tmux starts a server**. jmux passes it on
 * every attach, but an attach to an already-running server ignores it, and
 * `main.ts` deliberately never `source-file`s over the control channel (doing so
 * scrambles the FIFO pending-queue matching).
 *
 * So upgrading jmux while a server is detached leaves that server running the
 * *previous* version's keybindings and options, indefinitely, with no symptom
 * beyond "the new binding doesn't work". The materialized asset hash is
 * recorded on the server, and a mismatch on a later attach is reported rather
 * than left to be discovered.
 */

export const GENERATION_OPTION = "@jmux-config-generation";

/** The tmux command that stamps this jmux's asset hash onto the server. */
export function stampCommand(jmuxDir: string): string {
  return `set-option -g ${GENERATION_OPTION} ${hashOf(jmuxDir)}`;
}

/** The hash component of a materialized asset dir. */
export function hashOf(jmuxDir: string): string {
  const parts = jmuxDir.split("/");
  return parts[parts.length - 1] ?? "";
}

export type GenerationVerdict =
  /** No stamp: a server jmux has not attached to before, or one from before this feature. */
  | { kind: "unstamped" }
  /** The server loaded exactly these assets. */
  | { kind: "current" }
  /** The server started with different config and cannot be reloaded in place. */
  | { kind: "stale"; running: string; expected: string };

/**
 * Compare the stamp a server carries against the assets this jmux would use.
 *
 * An unstamped server is *not* reported as stale. jmux may legitimately be the
 * first to attach to a server a user started themselves, and crying wolf on a
 * server that was never ours would train the warning to be ignored.
 */
export function compareGeneration(running: string, jmuxDir: string): GenerationVerdict {
  const expected = hashOf(jmuxDir);
  const trimmed = running.trim();
  if (trimmed === "") return { kind: "unstamped" };
  if (trimmed === expected) return { kind: "current" };
  return { kind: "stale", running: trimmed, expected };
}

/** What the user is told, and what to do about it. */
export function staleGenerationNotice(verdict: GenerationVerdict): string[] {
  if (verdict.kind !== "stale") return [];
  return [
    "This tmux server was started by a different version of jmux and is still",
    "running that version's config. tmux only reads its config file when the",
    "server starts, so an upgrade cannot apply to a server already running.",
    "",
    "To pick up the new config, exit every jmux session and run:",
    "  tmux kill-server",
  ];
}
