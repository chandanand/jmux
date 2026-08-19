import { CliError, resolveContext } from "./cli/context";
import { handleSession } from "./cli/session";
import { handleWindow } from "./cli/window";
import { handlePane } from "./cli/pane";
import { handleRunClaude } from "./cli/run-claude";
import { handleAgent, runAgentWatch } from "./cli/agent";
import { handleStatus } from "./cli/status";
import { handleIdentity } from "./cli/identity";
import { handleIssue } from "./cli/issue";
import { handleWorkflow } from "./cli/workflow";
import { handleBrowser } from "./cli/browser";
import { handleDevServers } from "./cli/dev";
import { handleCc } from "./cli/cc";
import { handleRaise } from "./cli/raise";

export interface ParsedCtlArgs {
  group: string;
  action: string | null;
  /** Last-wins, exactly as before — every existing command reads this unchanged. */
  flags: Record<string, string | boolean>;
  positional: string[];
  /**
   * Every value a value flag or optional-numeric flag actually carried, in
   * the order given, additive alongside `flags`. A flag given once still
   * gets a single-element entry here, so a caller that wants "all of them"
   * never has to special-case the common case of exactly one. An
   * optional-numeric flag given bare (no value, e.g. `--wait`) gets no entry
   * here — there is no value to accumulate — but `--wait 30` and `--wait=30`
   * both do. Boolean flags never appear — `flags` remains the only source
   * for those.
   */
  repeated: Record<string, string[]>;
}

const KNOWN_GROUPS = [
  "browser",
  "dev-servers",
  "session",
  "window",
  "pane",
  "run-claude",
  "agent",
  "issue",
  "workflow",
  "status",
  "identity",
  "cc",
  "raise",
] as const;
const STANDALONE_GROUPS = new Set(["run-claude", "status", "identity"]);

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
  "pane",
  "repo",
  "base-branch",
  "issue",
  "worktree",
  "interval",
  "title",
  "description",
  "team",
  "stage",
  "status",
  "assignee",
]);
/**
 * Value flags that exist only for one group. The global `VALUE_FLAGS` set is
 * applied after every group, so a name added there changes how every existing
 * command consumes the token after it. These names are common enough
 * (`option`, `note`, `context`, `reason`) that doing so would be a behaviour
 * change in published software.
 */
const GROUP_VALUE_FLAGS: Record<string, ReadonlySet<string>> = {
  raise: new Set([
    "session", "issue", "question", "option", "recommend",
    "why", "authority", "context", "note", "reason", "attempt", "state",
  ]),
  issue: new Set(["append-prompt"]),
};
/**
 * Flags whose value is optional and always numeric, so `--wait` and `--wait 60`
 * both work. The next token is consumed only when it parses as a number —
 * without that guard `issue start --wait TRA-1580` would eat the issue id as
 * the flag's value and leave the command with no positional at all, the same
 * class of silent misparse the `--` handling below exists to prevent.
 */
const OPTIONAL_NUMERIC_FLAGS = new Set(["wait"]);
const BOOL_FLAGS = new Set([
  "force",
  "no-enter",
  "enter",
  "raw",
  "clear",
  "stdin",
  "all",
  "new",
  "no-launch-agent",
  "launch-agent",
  "start",
]);

const CTL_HELP = `
jmux ctl — programmatic interface to jmux/tmux

USAGE
  jmux ctl [GLOBAL FLAGS] <group> [action] [FLAGS] [args...]

GROUPS
  session    Manage tmux sessions (incl. attention set/clear, hide/unhide/hidden)
  window     Manage tmux windows
  pane       Manage tmux panes (incl. pin/unpin/pinned)
  run-claude Run a Claude Code agent in a session
  agent      Inspect agent state (agent state | agent watch)
  issue      Work with issues (issue get|link|unlink|start|create|move)
  workflow   The work pipeline (workflow stages|board|next|statuses)
  status     One-shot orchestration snapshot of the whole workspace
  identity   The tracker's authenticated account
  cc         Command Center views (cc views)
  browser    Browser panes (browser list|open|action)
  dev-servers What is listening in a session, and on which port

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
  --pane <val>         Target a specific browser pane (browser)
  --new                Force a new browser pane instead of reusing one (browser open)
  --stage <val>        Narrow to one workflow stage id (workflow board)
  --all                Operate on all sessions (agent state/watch, dev-servers)
  --start              Start the work immediately (issue create, workflow next)
  --no-launch-agent    Don't auto-launch Claude (issue start)
  --append-prompt <file> Append a contract file's contents to the seed prompt
                       (issue start). Refused when the effective agent-launch
                       value is false, or when the resulting prompt would be
                       too large for the launch command to carry.
  --wait [seconds]     Block until the worktree is provisioned (issue start).
                       Off by default: the session and agent are created up
                       front and the worktree lands in a setup pane beside
                       them. Bounded — a timeout returns, it does not fail.
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
  const repeated: Record<string, string[]> = {};
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
    } else if (arg === "--") {
      // End of jmux's flags. Everything after belongs to whoever we are handing
      // it to — `browser action` passes it to agent-browser — and parsing it as
      // ours drops the flag *names* and leaves their values as bare positionals.
      // `click --ref e2` became `click e2`: a different command, delivered to a
      // real browser without complaint.
      positional.push(...argv.slice(i + 1));
      break;
    } else if (arg.startsWith("--")) {
      const name = arg.slice(2);
      // `--flag=value` reaches us as one token once the shell strips the
      // quotes around `--status="QA Failed"`. Value flags and optional-numeric
      // flags gain `=` support here — `BOOL_FLAGS` is still matched against
      // the untouched `name` below, exactly as before, so e.g. `--force=true`
      // still falls through to the permissive branch rather than silently
      // taking on a new meaning.
      const eq = name.indexOf("=");
      const valueFlagName = eq === -1 ? name : name.slice(0, eq);
      if (BOOL_FLAGS.has(name)) {
        flags[name] = true;
        i++;
      } else if (OPTIONAL_NUMERIC_FLAGS.has(valueFlagName)) {
        let value: string | boolean;
        if (eq !== -1) {
          // `=` removes the ambiguity the space form has to sniff around —
          // `--wait=abc` is unambiguously a value, so it is taken literally
          // and left for parseWaitFlag to reject, rather than silently
          // degrading to the bare-boolean default.
          value = name.slice(eq + 1);
          i++;
        } else {
          const next = argv[i + 1];
          const numeric = next !== undefined && next.trim() !== "" && Number.isFinite(Number(next));
          value = numeric ? argv[++i] : true;
          i++;
        }
        flags[valueFlagName] = value;
        if (typeof value === "string") {
          (repeated[valueFlagName] ??= []).push(value);
        }
      } else if (
        VALUE_FLAGS.has(valueFlagName) ||
        GLOBAL_VALUE_FLAGS.has(valueFlagName) ||
        (GROUP_VALUE_FLAGS[group]?.has(valueFlagName) ?? false)
      ) {
        let value: string;
        if (eq !== -1) {
          // Split only on the first `=` — a value that itself contains one
          // (`--command=FOO=bar`) must not be truncated.
          value = name.slice(eq + 1);
          i++;
        } else {
          if (i + 1 >= argv.length) {
            throw new CliError(`Flag --${valueFlagName} requires a value`);
          }
          value = argv[++i];
          i++;
        }
        // Last-wins, exactly as every existing command has always seen it.
        flags[valueFlagName] = value;
        // Additive: every occurrence, in order, alongside the last-wins value
        // above — `issue list --status a --status b` needs both, and nothing
        // that reads `flags[name]` directly is affected by this array existing.
        (repeated[valueFlagName] ??= []).push(value);
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

  return { group, action, flags, positional, repeated };
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
      case "identity":
        result = await handleIdentity(parsed);
        break;
      case "cc":
        result = handleCc(ctx, parsed);
        break;
      case "raise":
        result = handleRaise(ctx, parsed);
        break;
      case "browser":
        result = await handleBrowser(ctx, parsed);
        break;
      case "dev-servers":
        result = await handleDevServers(ctx, parsed);
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
