// src/cli/dev.ts
//
// `jmux ctl dev-servers` — what is listening, and which session it belongs to.
//
// The logic is in src/dev-servers.ts and is pure; this supplies the two
// commands it needs and nothing else. Useful on its own (an agent wanting the
// URL of the thing it just started) and shares that module with the TUI's
// "Open dev server" command, which brings its own transport.

import { runTmuxDirect } from "./tmux";
import { callerLocation } from "./browser";
import { type CliContext } from "./context";
import type { ParsedCtlArgs } from "../cli";
import { devServerUrl, scanDevServers, type DevServerDeps } from "../dev-servers";

/** Commands run through the shell, for the pure scanner. */
export function cliDeps(ctx: CliContext): DevServerDeps {
  return {
    listPanes: async (format) => runTmuxDirect(["list-panes", "-a", "-F", format], ctx.socket).lines,
    run: async (cmd) => {
      try {
        const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore" });
        return await new Response(p.stdout).text();
      } catch {
        return "";
      }
    },
  };
}

export async function handleDevServers(ctx: CliContext, parsed: ParsedCtlArgs): Promise<unknown> {
  // An agent asking about dev servers almost always means its own session; a
  // list including six other sessions' ports is one it has to filter itself.
  // Scoped to the caller's session unless asked otherwise. Without this the
  // default saw every session on the server, which made `--all` a flag that
  // changed nothing — worse than an absent one, because it reads as a
  // guarantee that the default is narrower.
  const session = parsed.flags.all ? undefined : callerLocation(ctx).session;
  const servers = await scanDevServers({ session }, cliDeps(ctx));
  return {
    scope: session ?? "all",
    servers: servers.map((s) => ({ ...s, url: devServerUrl(s) })),
  };
}
