/**
 * jmux agent-state reporter, as a pi extension.
 *
 * pi has no shell-hook mechanism — its integration surface is an in-process
 * extension event bus — so unlike Claude Code and Codex this emitter is code
 * rather than config. `piIntegration.install()` copies this file to
 * `~/.config/jmux/pi-extension.ts` and registers that path in pi's
 * `settings.extensions`.
 *
 * NOTE: this module is never imported by jmux itself. It is a shipped asset
 * that happens to be valid TypeScript, kept under `src/` so it is typechecked
 * and published with the package rather than rotting in an untyped assets
 * folder. It deliberately has no external imports: it is loaded by *pi's*
 * runtime, which knows nothing of jmux's dependencies.
 *
 * pi reports `running` and `complete` only. Its extension API exposes no
 * permission-request event — approvals are never surfaced to extensions — so a
 * WAITING from a pi pane could only be invented. `piIntegration.reports` is
 * declared to match, and the sidebar renders accordingly.
 */

import { spawn } from "node:child_process";

/**
 * Structural subset of pi's `ExtensionAPI`. Typed locally rather than imported
 * from `@earendil-works/pi-coding-agent` so this file compiles inside jmux,
 * which does not depend on pi.
 */
interface PiExtensionApi {
  on(event: string, handler: () => void): void;
}

type AgentState = "running" | "complete";

const KIND = "pi";

/**
 * Serialises the tmux writes. pi's events are synchronous but our writes are
 * not, and a fast agent_start → agent_end pair could otherwise land out of
 * order and strand the pane on RUNNING.
 */
let queue: Promise<void> = Promise.resolve();

function tmux(args: string[]): Promise<void> {
  return new Promise((resolve) => {
    try {
      const child = spawn("tmux", args, { stdio: "ignore" });
      child.on("error", () => resolve());
      child.on("close", () => resolve());
    } catch {
      resolve();
    }
  });
}

function enqueue(args: string[]): void {
  queue = queue.then(() => tmux(args)).catch(() => {});
}

function writeState(pane: string, state: AgentState): void {
  const since = String(Math.floor(Date.now() / 1000));
  // Chained into a single tmux invocation, so the four options move together
  // and a reader can never observe a new state against a stale timestamp.
  enqueue([
    "set-option", "-p", "-t", pane, "@jmux-agent-state", state,
    ";", "set-option", "-p", "-t", pane, "@jmux-agent-state-since", since,
    ";", "set-option", "-p", "-t", pane, "@jmux-agent-kind", KIND,
    ";", "set-option", "-t", pane, "@jmux-agent-pane", pane,
  ]);
}

function clearState(pane: string): void {
  enqueue([
    "set-option", "-pu", "-t", pane, "@jmux-agent-state",
    ";", "set-option", "-pu", "-t", pane, "@jmux-agent-state-since",
    ";", "set-option", "-pu", "-t", pane, "@jmux-agent-kind",
  ]);
}

export default function jmuxAgentState(pi: PiExtensionApi): void {
  const pane = process.env.TMUX_PANE;
  // Outside tmux there is nothing to report to, and every write would spawn a
  // doomed subprocess on each turn.
  if (!pane) return;

  // A fresh session is idle, not running: claim the pane so it is identifiable
  // as a pi agent immediately, without pretending work is in flight.
  pi.on("session_start", () => writeState(pane, "complete"));
  pi.on("agent_start", () => writeState(pane, "running"));
  pi.on("agent_end", () => writeState(pane, "complete"));
  pi.on("session_shutdown", () => clearState(pane));
}
