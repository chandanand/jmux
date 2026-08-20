/**
 * Thin wrapper around Bun.spawnSync for running tmux commands with the
 * correct socket flags and returning structured output.
 */

import { statSync } from "node:fs";
import { join } from "node:path";

/**
 * Parse the socket path from the $TMUX environment variable.
 * Format: /path/to/socket,PID,INDEX
 */
export function parseTmuxSocket(tmuxEnv: string | undefined): string | null {
  if (!tmuxEnv) return null;
  const comma = tmuxEnv.indexOf(",");
  if (comma === -1) return null;
  const path = tmuxEnv.slice(0, comma);
  return path || null;
}

export interface TmuxResult {
  ok: boolean;
  /** Trimmed, non-empty lines — suitable for structured format-string output. */
  lines: string[];
  /** Unprocessed stdout — preserves blank lines and indentation (for capture-pane). */
  rawOutput: string;
  error: string;
}

/**
 * Run a tmux command synchronously with a pre-built argument array.
 * Bypasses `sh -c` — arguments are passed directly to tmux via execvp,
 * eliminating shell injection risk from user-controlled values.
 */
export function runTmuxDirect(args: string[], socket: string | null): TmuxResult {
  const socketArgs: string[] = socket
    ? socket.includes("/")
      ? ["-S", socket]
      : ["-L", socket]
    : [];

  const result = Bun.spawnSync(["tmux", ...socketArgs, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const exitCode = result.exitCode ?? 1;

  if (exitCode !== 0) {
    const stderr = result.stderr.toString().trim();
    return {
      ok: false,
      lines: [],
      rawOutput: "",
      error: stderr || `tmux exited with code ${exitCode}`,
    };
  }

  const rawOutput = result.stdout.toString();
  const lines = rawOutput
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  return { ok: true, lines, rawOutput, error: "" };
}

/**
 * A Unix domain socket path has a much smaller ceiling than the
 * filesystem's own path-length limit — `sizeof(sockaddr_un.sun_path)`, 104
 * bytes on macOS, 108 on Linux — and it is *that* limit tmux's `connect()`
 * enforces, not the filesystem's. A path just past it can still `stat()`
 * cleanly with a plain `ENOENT`, so a stat's `ENOENT` alone is not proof of
 * absence once the path is this long: tmux was never going to reach the
 * point of telling us either way. Deliberately conservative versus both
 * platform limits.
 */
const MAX_PLAUSIBLE_SOCKET_PATH_BYTES = 100;

/**
 * Where tmux itself would put the server socket for this connection
 * target. `-S <path>` (a socket argument containing `/`, matching
 * {@link runTmuxDirect}'s own test for which flag to use) names the socket
 * file directly. `-L <name>` — and no socket argument at all, which tmux
 * treats as `-L default` — resolves under `$TMUX_TMPDIR` (or `/tmp` when
 * that is unset), in a directory named `tmux-<uid>`: tmux's own documented
 * convention. `null` when the current platform has no `getuid`
 * (`process.getuid` is POSIX-only): with no way to compute the path,
 * absence can never be positively established, only assumed, which is
 * exactly what {@link tmuxServerDefinitelyAbsent} exists to avoid doing.
 */
function tmuxServerSocketPath(socket: string | null): string | null {
  if (socket && socket.includes("/")) return socket;
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (uid === null) return null;
  const base = process.env.TMUX_TMPDIR && process.env.TMUX_TMPDIR.length > 0 ? process.env.TMUX_TMPDIR : "/tmp";
  return join(base, `tmux-${uid}`, socket ?? "default");
}

/**
 * Whether tmux's server socket for this connection target can be *proven*
 * absent — the only condition under which a failed tmux query is safe to
 * read as "no server, so certainly no sessions," rather than as a query
 * that could not be answered. Proof means a stat on tmux's own socket path
 * fails with `ENOENT`, *and* the path is short enough that such a stat is
 * actually meaningful (see {@link MAX_PLAUSIBLE_SOCKET_PATH_BYTES}).
 * Nothing else counts — not a permission error on a socket that does
 * exist, and not an implausibly long path, whether or not `stat` itself
 * complains about it: either would read a query this function cannot
 * trust as a definitely-empty world.
 *
 * Deliberately mirrors the orchestrator's `tmuxSocketDefinitelyAbsent`
 * (`src/provision.ts` in the orchestrator repository): the two
 * repositories need one shared notion of "no server," or the orchestrator
 * can never provision into a socket neither process has started yet, while
 * `--require-new` refuses forever with `session-query-failed`.
 */
export function tmuxServerDefinitelyAbsent(socket: string | null): boolean {
  const path = tmuxServerSocketPath(socket);
  if (path === null) return false;
  if (Buffer.byteLength(path, "utf8") >= MAX_PLAUSIBLE_SOCKET_PATH_BYTES) return false;
  try {
    statSync(path);
    return false;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT";
  }
}
