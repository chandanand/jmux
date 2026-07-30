/**
 * Which channel installed this jmux.
 *
 * jmux ships a live update check whose result renders in the footer. Once the
 * binary channels exist, "an update is available" without a way to apply it is
 * a dead end — and the right command differs per channel.
 *
 * The detection is two-step for a reason. Under Bun, `process.execPath` is
 * **Bun's own executable**, not the script or the npm shim, so a Homebrew
 * install of Bun running jmux from a checkout would path-sniff as a Homebrew
 * install of jmux. Compiled-mode is therefore established first, and only a
 * compiled binary's path is ever sniffed.
 */

export type Channel = "brew" | "installer" | "npm" | "unknown";

export const UPGRADE_DOCS_URL = "https://jmux.build/#install";

/**
 * True when running as a `bun build --compile` binary.
 *
 * The compiled runtime serves the bundle from a virtual filesystem, so
 * `import.meta.dir` is under `/$bunfs`. Passed in rather than read directly so
 * this is testable without compiling.
 */
export function isCompiled(metaDir: string): boolean {
  return metaDir.startsWith("/$bunfs") || metaDir.startsWith("B:\\~BUN");
}

export function detectChannel(metaDir: string, execPath: string): Channel {
  // Not compiled → this is the source/npm channel, whatever Bun's own path
  // happens to look like. Sniffing here is what produced the brew false
  // positive: /opt/homebrew/bin/bun is a Homebrew *Bun*, not a Homebrew jmux.
  if (!isCompiled(metaDir)) return "npm";

  if (execPath.includes("/Cellar/") || execPath.startsWith("/opt/homebrew/") || execPath.startsWith("/home/linuxbrew/")) {
    return "brew";
  }
  if (execPath.includes("/.local/bin/") || execPath.startsWith("/usr/local/bin/")) {
    return "installer";
  }
  return "unknown";
}

/** What to tell a user who has an update waiting. */
export function upgradeCommand(channel: Channel): string {
  switch (channel) {
    case "brew":
      return "brew upgrade jmux";
    case "installer":
      return "curl -fsSL https://jmux.build/install | sh";
    case "npm":
      return "bun install -g @jx0/jmux";
    case "unknown":
      return UPGRADE_DOCS_URL;
  }
}

/** Convenience for the running process. */
export function currentChannel(metaDir: string = import.meta.dir): Channel {
  return detectChannel(metaDir, process.execPath);
}
