import type { CliContext } from "./context";
import { CliError } from "./context";
import type { ParsedCtlArgs } from "../cli";

export function handleRaise(ctx: CliContext, parsed: ParsedCtlArgs): unknown {
  switch (parsed.action) {
    default:
      throw new CliError(
        `Unknown raise action "${parsed.action}". Known actions: create, list, answer, delivering, delivery-failed, applied, ack, resolve`,
      );
  }
}
