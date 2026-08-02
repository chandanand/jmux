import { CliError, resolveContext } from "./cli/context";
import { handleSession } from "./cli/session";
import { handleWindow } from "./cli/window";
import { handlePane } from "./cli/pane";
import { handleRunClaude } from "./cli/run-claude";
import { handleAgent, runAgentWatch } from "./cli/agent";
import { handleStatus } from "./cli/status";
import { handleIssue } from "./cli/issue";
import { handleWorkflow } from "./cli/workflow";
import { handleCc } from "./cli/cc";

export interface ParsedCtlArgs {
  group: string;
  action: string | null;
  flags: Record<string, string | boolean>;
  positional: string[];
}

const KNOWN_GROUPS = [
  "session",
  "window",
  "pane",
  "run-claude",
  "agent",
  "issue",
  "workflow",
  "status",
  "cc",
] as const;
const STANDALONE_GROUPS = new Set(["run-claude", "status"]);

// Flags that take a value argument (after group/action, or global)
const GLOBAL_VALUE_FLAGS = new Set(["session", "socket"]);
const VALUE_FLAGS = new Set([
  "name",
  "dir",
  "target",
  "direction",
  "command",
  "message",
  "message-file",
  "file",
  "lines",
  "window",
  "reason",
  "repo",
  "base-branch",
  "issue",
  "worktree",
  "interval",
  "tab",
  "title",
  "description",
  "team",
  "stage",
]);
const BOOL_FLAGS = new Set([
  "force",
  "no-enter",
  "enter",
  "raw",
  "clear",
  "stdin",
  "all",
  "no-launch-agent",
  "launch-agent",
  "start",
]);

const CTL_HELP = `
jmux ctl — programmatic interface to jmux/tmux

USAGE
  jmux ctl [GLOBAL FLAGS] <group> [action] [FLAGS] [args...]

GROUPS
  session    Manage tmux sessions (incl. session attention set/clear)
  window     Manage tmux windows
  pane       Manage tmux panes
  run-claude Run a Claude Code agent in a session
  agent      Inspect agent state (agent state | agent watch)
  issue      Work with issues (issue get|link|unlink|start|create|move)
  workflow   The work pipeline (workflow stages|board|next|statuses)
  status     One-shot orchestration snapshot of the whole workspace
  cc         Command Center tabs (cc tabs)

GLOBAL FLAGS
  --session <name>   Target session name
  --socket <path>    tmux socket path or name (-L)
  -L <name>          Alias for --socket

FLAGS
  --name <val>         Name for created resource
  --dir <val>          Working directory
  --target <val>       tmux target (session, window, or pane)
  --direction <val>    Split direction (horizontal|vertical)
  --command <val>      Command to run
  --message <val>      Message text
  --message-file <val> Path to file containing message
  --file <val>         File path
  --lines <val>        Number of lines
  --window <val>       Window target
  --reason <val>       Attention reason text
  --title <val>        Issue title (issue create)
  --description <val>  Issue description (issue create)
  --team <val>         Team name or id (issue create)
  --repo <val>         Repository path (issue start/link)
  --base-branch <val>  Base branch for new worktree (issue start)
  --interval <val>     Poll interval in ms (agent watch)
  --tab <val>          Command Center tab id or name (pane pin)
  --stage <val>        Narrow to one workflow stage id (workflow board)
  --all                Operate on all sessions (agent state/watch)
  --start              Start the work immediately (issue create, workflow next)
  --no-launch-agent    Don't auto-launch Claude (issue start)
  --force              Skip confirmation prompts
  --no-enter           Don't send Enter after keys
  --enter              Send Enter after keys
  --raw                Raw output mode
  --clear              Clear before running
  --stdin              Read from stdin
`.trim();

export function parseCtlArgs(argv: string[]): ParsedCtlArgs {
  if (argv.length > 0 && (argv[0] === "--help" || argv[0] === "-h")) {
    console.log(CTL_HELP);
    process.exit(0);
  }

  const flags: Record<string, string | boolean> = {};
  let i = 0;

  // Parse global flags before the group
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === "-L") {
      if (i + 1 >= argv.length) {
        throw new CliError("Flag -L requires a value");
      }
      flags.socket = argv[++i];
      i++;
    } else if (arg === "--session") {
      if (i + 1 >= argv.length) {
        throw new CliError("Flag --session requires a value");
      }
      flags.session = argv[++i];
      i++;
    } else if (arg === "--socket") {
      if (i + 1 >= argv.length) {
        throw new CliError("Flag --socket requires a value");
      }
      flags.socket = argv[++i];
      i++;
    } else {
      // Not a global flag — must be the group
      break;
    }
  }

  if (i >= argv.length) {
    throw new CliError("Missing required group (session|window|pane|run-claude)");
  }

  const group = argv[i++];
  if (!(KNOWN_GROUPS as readonly string[]).includes(group)) {
    throw new CliError(
      `Unknown group "${group}". Known groups: ${KNOWN_GROUPS.join(", ")}`,
    );
  }

  // Standalone groups have no sub-action
  let action: string | null = null;
  if (!STANDALONE_GROUPS.has(group)) {
    if (i < argv.length && !argv[i].startsWith("-")) {
      action = argv[i++];
    }
  }

  // Parse remaining flags and positional args
  const positional: string[] = [];
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === "-L") {
      // Also accepted after the group. `--socket` already was (it is in
      // GLOBAL_VALUE_FLAGS), so `-L` landing in `positional` instead meant
      // `ctl workflow board -L other` silently read the *default* server —
      // a wrong answer rather than an error, which is the worst shape for a
      // command an agent is going to act on.
      if (i + 1 >= argv.length) {
        throw new CliError("Flag -L requires a value");
      }
      flags.socket = argv[++i];
      i++;
    } else if (arg.startsWith("--")) {
      const name = arg.slice(2);
      if (BOOL_FLAGS.has(name)) {
        flags[name] = true;
        i++;
      } else if (VALUE_FLAGS.has(name) || GLOBAL_VALUE_FLAGS.has(name)) {
        if (i + 1 >= argv.length) {
          throw new CliError(`Flag --${name} requires a value`);
        }
        flags[name] = argv[++i];
        i++;
      } else {
        // Unknown flag — treat as boolean (permissive)
        flags[name] = true;
        i++;
      }
    } else {
      // Positional
      positional.push(arg);
      i++;
    }
  }

  return { group, action, flags, positional };
}

export async function runCtl(argv: string[]): Promise<void> {
  let parsed: ParsedCtlArgs;
  try {
    parsed = parseCtlArgs(argv);
  } catch (err) {
    if (err instanceof CliError) {
      process.stderr.write(JSON.stringify({ error: err.message }) + "\n");
      process.exit(1);
    }
    throw err;
  }

  const ctx = resolveContext({ env: process.env as Record<string, string | undefined>, flags: parsed.flags });

  try {
    // `agent watch` is the one long-running, streaming command: it emits JSONL
    // directly to stdout and only returns on SIGINT, so it bypasses the
    // single-JSON-envelope path below.
    if (parsed.group === "agent" && parsed.action === "watch") {
      await runAgentWatch(ctx, parsed);
      return;
    }

    let result: unknown;
    switch (parsed.group) {
      case "session":
        result = handleSession(ctx, parsed);
        break;
      case "window":
        result = handleWindow(ctx, parsed);
        break;
      case "pane":
        result = handlePane(ctx, parsed);
        break;
      case "run-claude":
        result = handleRunClaude(ctx, parsed);
        break;
      case "agent":
        result = await handleAgent(ctx, parsed);
        break;
      case "issue":
        result = await handleIssue(ctx, parsed);
        break;
      case "workflow":
        result = await handleWorkflow(ctx, parsed);
        break;
      case "status":
        result = handleStatus(ctx, parsed);
        break;
      case "cc":
        result = handleCc(ctx, parsed);
        break;
      default:
        throw new CliError(`Unknown group: ${parsed.group}`);
    }
    process.stdout.write(JSON.stringify(result ?? null) + "\n");
  } catch (err) {
    if (err instanceof CliError) {
      process.stderr.write(JSON.stringify({ error: err.message }) + "\n");
      process.exit(1);
    }
    if (err instanceof Error) {
      process.stderr.write(JSON.stringify({ error: err.message }) + "\n");
      process.exit(1);
    }
    throw err;
  }
}
