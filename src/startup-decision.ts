import { isInternalSession, PARK_SESSION } from "./glass/internal-sessions";

export type StartupAttachMode = "createOrAttach" | "strictAttach";

export interface StartupDecisionInput {
  /** A session successfully restored from the durable snapshot. */
  restoredSessionName?: string | null;
  /** The positional `jmux SESSION` argument, when the user supplied one. */
  explicitSessionName?: string | null;
  /**
   * Every session currently on the server, or null when the probe failed in a
   * way that does not prove the server is absent.
   */
  existingSessionNames: readonly string[] | null;
}

export interface StartupDecision {
  attachMode: StartupAttachMode;
  sessionName: string | undefined;
  enterCommandCenter: boolean;
}

/**
 * Choose the interactive client's first tmux target.
 *
 * A restored or explicitly requested session always wins. With an existing
 * user session, leaving the target undefined preserves tmux's ordinary
 * `new-session -A` attachment choice. Only a genuinely empty user server gets
 * the internal park target and the Command Center first-launch surface.
 *
 * An unknown probe result is deliberately conservative: it keeps the old
 * untargeted attach behaviour rather than mistaking an inaccessible server for
 * an empty one and changing where the user lands.
 */
export function decideStartup(input: StartupDecisionInput): StartupDecision {
  if (input.restoredSessionName) {
    return {
      attachMode: "strictAttach",
      sessionName: input.restoredSessionName,
      enterCommandCenter: false,
    };
  }

  if (input.explicitSessionName) {
    return {
      attachMode: "createOrAttach",
      sessionName: input.explicitSessionName,
      enterCommandCenter: false,
    };
  }

  const hasUserSession = input.existingSessionNames?.some(
    (name) => name.length > 0 && !isInternalSession(name),
  );
  if (input.existingSessionNames === null || hasUserSession) {
    return {
      attachMode: "createOrAttach",
      sessionName: undefined,
      enterCommandCenter: false,
    };
  }

  return {
    attachMode: "createOrAttach",
    sessionName: PARK_SESSION,
    enterCommandCenter: true,
  };
}

// `error connecting to` alone proves nothing about absence: tmux uses the same
// prefix for an inaccessible live socket. Only the errno forms that mean the
// socket is missing or has no listening server count as an empty server.
const NO_SERVER_RX =
  /no server running|no sessions|server exited unexpectedly|error connecting to[^\n]*\((?:no such file or directory|connection refused)\)/i;

/** Turn the pre-PTY tmux probe into the tri-state decision input above. */
export function sessionNamesFromProbe(result: {
  stdout: string;
  stderr: string;
  exitCode: number;
}): string[] | null {
  if (result.exitCode === 0) {
    return result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }
  return NO_SERVER_RX.test(result.stderr) ? [] : null;
}
