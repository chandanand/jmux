/**
 * Which tmux config, if any, jmux sources on the user's behalf.
 *
 * jmux's layering is `defaults.conf` → the user's tmux config → `core.conf`,
 * and only the third tier is non-negotiable. Everything jmux ships in the first
 * is presentation the user is invited to override — which means an elaborate
 * `~/.tmux.conf` lands its own chrome on top of jmux's, and until this module
 * there was no way to decline.
 *
 * The value *is* the switch: a path, or `false`, or nothing. There is no
 * companion boolean that could disagree with it — the same construction as
 * `diffPanel.theme` and `sessionTitle.command`.
 *
 * Pure, with `exists` and the environment injected, because the one thing that
 * must not be guessed here is which file is on disk.
 */

/** What jmux resolved to do about the user's tmux config. */
export type UserTmuxConfig =
  /** Source this file. `origin` is what the settings row discloses. */
  | { kind: "source"; path: string; origin: "auto" | "configured" }
  /** Configured `false` — source nothing. */
  | { kind: "disabled" }
  /** A path was named and is not there. Warned about; sources nothing. */
  | { kind: "missing"; path: string }
  /** Auto-detect found no config to source. */
  | { kind: "none" };

export interface UserTmuxConfigEnv {
  home: string;
  xdgConfigHome?: string | undefined;
}

/**
 * The locations tmux itself documents, in tmux's own order (`man tmux`: "the
 * user configuration file at ~/.tmux.conf or $XDG_CONFIG_HOME/tmux/tmux.conf").
 *
 * jmux checked only the first for its whole life. A user whose config lives at
 * the second had it silently ignored — and a switch named "source the user's
 * tmux config" that consulted one of two documented locations would encode a
 * second, invisible rule that its own name denies.
 */
function autoCandidates(env: UserTmuxConfigEnv): string[] {
  const paths: string[] = [];
  if (env.home) paths.push(`${env.home}/.tmux.conf`);
  const configHome = env.xdgConfigHome || (env.home ? `${env.home}/.config` : "");
  if (configHome) paths.push(`${configHome}/tmux/tmux.conf`);
  return paths;
}

/**
 * `~` only, and only at the front. A hand-edited JSON file will carry one and
 * no shell is involved to expand it. `~user` is deliberately left alone: this
 * is not a shell, and silently mis-resolving someone else's home directory is
 * worse than passing through a path that then reports itself missing.
 */
function expandHome(path: string, home: string): string {
  if (!home) return path;
  if (path === "~") return home;
  if (path.startsWith("~/")) return `${home}${path.slice(1)}`;
  return path;
}

/** The inverse, for display only. */
function contractHome(path: string, home: string): string {
  if (!home) return path;
  if (path === home) return "~";
  if (path.startsWith(`${home}/`)) return `~${path.slice(home.length)}`;
  return path;
}

export function resolveUserTmuxConfig(
  value: string | false | undefined,
  env: UserTmuxConfigEnv,
  exists: (path: string) => boolean,
): UserTmuxConfig {
  if (value === false) return { kind: "disabled" };

  const configured = typeof value === "string" ? value.trim() : "";
  if (configured) {
    // A configured path that is absent resolves to `missing`, never back to
    // auto-detect. Falling through would source a *different file than the one
    // named*, confidently and silently; an honest nothing is the lesser harm.
    const path = expandHome(configured, env.home);
    return exists(path) ? { kind: "source", path, origin: "configured" } : { kind: "missing", path };
  }

  // A blank string is no opinion rather than an empty path: the settings row
  // stores `undefined` for an empty commit, so a `""` on disk was hand-written
  // and reads as "I have not decided".
  for (const path of autoCandidates(env)) {
    if (exists(path)) return { kind: "source", path, origin: "auto" };
  }
  return { kind: "none" };
}

/** The path to hand tmux, or empty for every resolution that sources nothing. */
export function userTmuxConfigPath(resolution: UserTmuxConfig): string {
  return resolution.kind === "source" ? resolution.path : "";
}

/**
 * The one resolution worth interrupting for. Everything else is either what the
 * user asked for or an honest absence; a named file that isn't there is the
 * only case where jmux is doing something other than what the config says.
 */
export function userTmuxConfigWarning(resolution: UserTmuxConfig): string | null {
  if (resolution.kind !== "missing") return null;
  return `userTmuxConfig points at ${resolution.path}, which does not exist — sourcing no user tmux config.`;
}

/** The settings row's displayed value: the outcome, and why it reads that way. */
export function formatUserTmuxConfig(resolution: UserTmuxConfig, home: string): string {
  switch (resolution.kind) {
    case "source":
      return resolution.origin === "auto"
        ? `auto (${contractHome(resolution.path, home)})`
        : contractHome(resolution.path, home);
    case "missing":
      return `${contractHome(resolution.path, home)} (not found)`;
    case "disabled":
      return "off";
    case "none":
      return "auto (none found)";
  }
}

/**
 * The settings row's *editable* value. `formatUserTmuxConfig` puts the
 * resolution in parentheses and does not survive being fed back in, which is
 * precisely what `SettingDef.getEditValue` exists for.
 */
export function editableUserTmuxConfig(value: string | false | undefined): string {
  if (value === false) return "off";
  const configured = typeof value === "string" ? value.trim() : "";
  return configured || "auto";
}

const OFF_WORDS = new Set(["off", "none", "false", "no"]);
const AUTO_WORDS = new Set(["", "auto", "default"]);

/** Parse a committed row back into the stored value. */
export function parseUserTmuxConfig(input: string): string | false | undefined {
  const trimmed = input.trim();
  const word = trimmed.toLowerCase();
  if (OFF_WORDS.has(word)) return false;
  if (AUTO_WORDS.has(word)) return undefined;
  return trimmed;
}
