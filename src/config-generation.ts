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
 *
 * The stamp carries a second half for the same reason. Which tmux config jmux
 * sources on the user's behalf (`userTmuxConfig`) is decided before the server
 * starts and reaches tmux through `$JMUX_USER_CONF`, so changing it against a
 * running server does nothing at all — and it moves no asset hash, because
 * nothing on disk changed. Without the second half that toggle would be
 * silently inert, which is the failure `sectionedViewNotice` and the ghost-cap
 * disclosure exist to prevent.
 */

import { createHash } from "node:crypto";

export const GENERATION_OPTION = "@jmux-config-generation";

/** The tmux command that stamps this jmux's generation onto the server. */
export function stampCommand(jmuxDir: string, userConfPath: string): string {
  return `set-option -g ${GENERATION_OPTION} ${generationOf(jmuxDir, userConfPath)}`;
}

/** The hash component of a materialized asset dir. */
export function hashOf(jmuxDir: string): string {
  const parts = jmuxDir.split("/");
  return parts[parts.length - 1] ?? "";
}

/**
 * The user-config half of the stamp: the resolved path, hashed, or `none`.
 *
 * Hashed rather than stored literally so the option value has a fixed shape and
 * carries neither whitespace nor the user's home directory. `none` is a value
 * and not an absence — "jmux sourced nothing" is a decision the next attach has
 * to be able to compare against.
 */
export function confTag(userConfPath: string): string {
  if (!userConfPath) return "none";
  return createHash("sha256").update(userConfPath).digest("hex").slice(0, 8);
}

function generationOf(jmuxDir: string, userConfPath: string): string {
  return `${hashOf(jmuxDir)}.${confTag(userConfPath)}`;
}

export type GenerationVerdict =
  /** No stamp: a server jmux has not attached to before, or one from before this feature. */
  | { kind: "unstamped" }
  /** The server loaded exactly this config. */
  | { kind: "current" }
  /** The server started with different config and cannot be reloaded in place. */
  | {
      kind: "stale";
      /** Which half diverged, and so which sentence the user needs. */
      cause: "assets" | "user-config";
      running: string;
      expected: string;
    };

/**
 * Compare the stamp a server carries against the config this jmux would use.
 *
 * An unstamped server is *not* reported as stale. jmux may legitimately be the
 * first to attach to a server a user started themselves, and crying wolf on a
 * server that was never ours would train the warning to be ignored.
 *
 * A stamp with no user-config half was written before that half existed, and
 * cannot say what the server sourced. It is judged on its assets alone rather
 * than guessed at — the same refusal. In practice it is moot: the release that
 * added the half also edited `config/tmux.conf`, so the asset half of any such
 * stamp differs anyway and reports itself.
 */
export function compareGeneration(
  running: string,
  jmuxDir: string,
  userConfPath: string,
): GenerationVerdict {
  const trimmed = running.trim();
  if (trimmed === "") return { kind: "unstamped" };

  const expected = generationOf(jmuxDir, userConfPath);
  if (trimmed === expected) return { kind: "current" };

  const [runningAssets = "", runningConf] = trimmed.split(".");
  const staleAssets = runningAssets !== hashOf(jmuxDir);
  if (!staleAssets && runningConf === undefined) return { kind: "current" };

  // Two causes, one remedy. The version is the larger fact — a server on old
  // assets is also on the old config-loading behaviour — so it takes priority
  // rather than earning a third message nobody would read differently.
  return {
    kind: "stale",
    cause: staleAssets ? "assets" : "user-config",
    running: trimmed,
    expected,
  };
}

const RESTART = [
  "",
  "To pick it up, exit every jmux session and run:",
  "  tmux kill-server",
];

/** What the user is told, and what to do about it. */
export function staleGenerationNotice(verdict: GenerationVerdict): string[] {
  if (verdict.kind !== "stale") return [];

  if (verdict.cause === "user-config") {
    return [
      "This tmux server was started with a different `userTmuxConfig` setting",
      "and is still loading the config it started with. tmux only reads its",
      "config file when the server starts, so the change cannot apply to a",
      "server that is already running.",
      ...RESTART,
    ];
  }

  return [
    "This tmux server was started by a different version of jmux and is still",
    "running that version's config. tmux only reads its config file when the",
    "server starts, so an upgrade cannot apply to a server already running.",
    ...RESTART,
  ];
}

/** The modal title, which differs by cause for the same reason the body does. */
export function staleGenerationTitle(verdict: GenerationVerdict): string {
  return verdict.kind === "stale" && verdict.cause === "user-config"
    ? "tmux is running a different config"
    : "tmux is running an older config";
}
