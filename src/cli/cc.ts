import { CliError, type CliContext } from "./context";
import type { ParsedCtlArgs } from "../cli";
import { loadUserConfig, type JmuxConfig } from "../config";
import { normalizeViews, type CommandCenterView } from "../glass/views";

/**
 * Pure reducer: the on-disk config → the normalized view registry. Split out
 * from `handleCc` so the transformation is testable without touching disk —
 * the same shape `cli/workflow.ts` uses for its config-derived pure functions
 * (`parkingConfig`, `capValue`).
 *
 * Deliberately returns view *definitions* only, never member counts. A count
 * would have to be re-derived from tmux's own pane/session state, and a
 * second derivation of the same membership is exactly the class of
 * disagreement this whole design exists to remove — the TUI is the only
 * place that reads live pane/session state, and it always disagrees with a
 * second reader eventually.
 */
export function resolveCcViews(config: JmuxConfig): CommandCenterView[] {
  return normalizeViews(config.commandCenterViews);
}

export function handleCc(ctx: CliContext, parsed: ParsedCtlArgs): unknown {
  switch (parsed.action) {
    case "views": {
      return { views: resolveCcViews(loadUserConfig()) };
    }
    default:
      throw new CliError(
        `Unknown cc action "${parsed.action}". Known actions: views`,
      );
  }
}
