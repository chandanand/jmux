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

/**
 * Settings that prove config/core.conf ran to completion.
 *
 * The generation stamp alone cannot prove this. jmux writes that stamp after
 * attaching, so a user config that blocks halfway through loading can still
 * have the current asset hash while tmux retains its default prefix and status
 * bar. These are all of core.conf's options; checking the complete set also
 * catches a later reload that only partially overwrote jmux's invariants.
 */
export const CORE_OPTION_REQUIREMENTS = [
  { option: "prefix", expected: "C-Space" },
  { option: "detach-on-destroy", expected: "off" },
  { option: "mouse", expected: "on" },
  { option: "allow-rename", expected: "off" },
  { option: "automatic-rename", expected: "on" },
  { option: "automatic-rename-format", expected: "#{b:pane_current_path}" },
  { option: "status", expected: "off" },
] as const;

export type CoreOptionName = (typeof CORE_OPTION_REQUIREMENTS)[number]["option"];
export type CoreOptionValues = Partial<Record<CoreOptionName, string>>;

export interface CoreOptionMismatch {
  option: CoreOptionName;
  expected: string;
  running: string;
}

export type CoreConfigHealth =
  | { kind: "healthy" }
  | { kind: "unhealthy"; mismatches: CoreOptionMismatch[] };

/** Compare live tmux options with the invariants sourced last by core.conf. */
export function compareCoreOptions(values: CoreOptionValues): CoreConfigHealth {
  const mismatches = CORE_OPTION_REQUIREMENTS.flatMap(({ option, expected }) => {
    const running = (values[option] ?? "").trim();
    return running === expected ? [] : [{ option, expected, running }];
  });
  return mismatches.length === 0 ? { kind: "healthy" } : { kind: "unhealthy", mismatches };
}

/**
 * The one `core.conf` setting jmux writes again on attach rather than reporting
 * as stale.
 *
 * Reporting is right for the rest of `core.conf`: a server running yesterday's
 * keybindings is wrong but usable, and the notice says how to fix it. This
 * setting differs in kind, because without it jmux does not live long enough to
 * show the notice twice.
 *
 * A jmux session is one window holding one pane, so anything that closes that
 * pane — `Ctrl-Space x`, `Ctrl-d`, typing `exit` — destroys the session. At tmux's
 * default (`on`) the client on it then *detaches*, which closes jmux's pty and
 * drops the whole TUI while every other session keeps running. At `off` tmux
 * moves the client to another session, which is what the sidebar is built
 * around. So on a server jmux did not start, closing a pane quits jmux.
 *
 * One `set-option`, never a `source-file`: sourcing over the control channel
 * emits nested %begin/%end blocks that scramble the FIFO pending-queue matching
 * (see the module comment above).
 *
 * Note the asymmetry with `userTmuxConfig`, which is *not* re-applied this way:
 * that one decides whether a whole config file is sourced, and only tmux itself
 * can do that, at server start. There is no single `set-option` that stands in
 * for it, which is why it is reported instead.
 */
export const DETACH_ON_DESTROY_COMMAND = "set-option -g detach-on-destroy off";

/** The tmux command that stamps this jmux's generation onto the server. */
export function stampCommand(jmuxDir: string, userConfPath: string): string {
  return `set-option -g ${GENERATION_OPTION} ${generationOf(jmuxDir, userConfPath)}`;
}

/** Remove a stamp that claims the current assets produced an unhealthy server. */
export function clearStampCommand(): string {
  return `set-option -gu ${GENERATION_OPTION}`;
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

export type GenerationAction = "stamp" | "clear" | "keep";

/**
 * Decide how the server stamp may change after inspecting both signals.
 *
 * A stale stamp is evidence and must remain stale until a real restart or
 * repair. A current stamp on unhealthy core options is actively misleading,
 * so remove it. Only an unstamped, healthy server earns the current stamp.
 */
export function generationAction(
  verdict: GenerationVerdict,
  health: CoreConfigHealth,
): GenerationAction {
  if (health.kind === "unhealthy") return verdict.kind === "current" ? "clear" : "keep";
  return verdict.kind === "unstamped" ? "stamp" : "keep";
}

/**
 * Compare the stamp a server carries against the config this jmux would use.
 *
 * An unstamped server is *not* reported as stale. jmux may legitimately be the
 * first to attach to a server a user started themselves. The independent core
 * health check still reports one whose required settings are not active.
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

/** Explain a half-loaded or subsequently overwritten core configuration. */
export function unhealthyCoreNotice(health: CoreConfigHealth): string[] {
  if (health.kind === "healthy") return [];
  return [
    "tmux did not finish loading jmux's required configuration.",
    "The following required settings are wrong:",
    ...health.mismatches.map(({ option, expected, running }) =>
      `  ${option}: expected ${expected}, found ${running || "<unset>"}`
    ),
    "",
    "Exit every jmux session, then restart tmux:",
    "  tmux kill-server",
    "If that command hangs, terminate the tmux server process from another shell.",
  ];
}

export const UNHEALTHY_CORE_TITLE = "tmux configuration is incomplete";
