import type { CliContext } from "./context";
import { CliError } from "./context";
import { runTmuxDirect } from "./tmux";
import { US, splitFields } from "../tmux-fields";
import {
  GROUNDCREW_MANAGED_OPTION,
  groundcrewActionGuidance,
  sessionManagerFromGroundcrewOption,
  type GroundcrewGuardedAction,
} from "../session-ownership";

const TARGET_OWNERSHIP_FORMAT = [
  "#{session_name}",
  `#{${GROUNDCREW_MANAGED_OPTION}}`,
].join(US);

/** Resolve a pane, window, session id, or session name to its owning session. */
export function parseTargetOwnership(
  lines: string[],
): { task: string; managedBy: "groundcrew" } | null {
  const [task, marker] = splitFields(lines[0] ?? "");
  if (!task || sessionManagerFromGroundcrewOption(marker) !== "groundcrew") return null;
  return { task, managedBy: "groundcrew" };
}

/** Refuse destructive CLI mutations against topology that Groundcrew owns. */
export function assertGroundcrewDoesNotOwn(
  target: string,
  ctx: CliContext,
  action: GroundcrewGuardedAction,
): void {
  const result = runTmuxDirect(
    ["display-message", "-t", target, "-p", TARGET_OWNERSHIP_FORMAT],
    ctx.socket,
  );
  if (!result.ok) return;

  const owner = parseTargetOwnership(result.lines);
  if (!owner) return;
  const guidance = groundcrewActionGuidance(action, owner.task);
  throw new CliError(`${guidance.message} ${guidance.hint}`);
}
