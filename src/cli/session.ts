import { sanitizeTmuxSessionName, buildOtelResourceAttrs } from "../config";
import { INTERNAL_SESSION_FILTER } from "../glass/internal-sessions";
import { runTmuxDirect } from "./tmux";
import { resolveCurrentSession, tmuxOrThrow, CliError, type CliContext } from "./context";
import type { ParsedCtlArgs } from "../cli";
import { US, splitFields } from "../tmux-fields";
import { SESSION_TITLE_OPTION, TITLE_SIGNATURE_OPTION, MANUAL_SIGNATURE } from "../session-title/display";
import { isGridHiddenValue } from "../glass/exceptions";

export interface SessionEntry {
  id: string;
  name: string;
  activity: number;
  attached: boolean;
  windows: number;
  path: string;
  /** A model-generated phrase, additional to `name` — see displaySessionName. */
  title?: string;
}

/**
 * US-separated, not colon-separated: `path` was already free-form (a Windows
 * path carries colons of its own) and a rejoin-from-index-N trick only works
 * when the free-form field is last. `title` is a sentence a model wrote and
 * would routinely contain a colon too, and it has to sit ahead of `path` to
 * share this format with `info`'s -f filter construction — so there is no
 * "last field" to lean on any more. tmux session/pane names can't contain the
 * US byte, which is what makes it safe as a delimiter (see tmux-fields.ts).
 */
export const SESSION_FIELDS_FORMAT = [
  "#{session_id}",
  "#{session_name}",
  "#{session_activity}",
  "#{session_attached}",
  "#{session_windows}",
  "#{pane_current_path}",
  `#{${SESSION_TITLE_OPTION}}`,
].join(US);

export function parseSessionListOutput(lines: string[]): SessionEntry[] {
  return lines
    .filter((l) => l.length > 0)
    .map((line) => {
      const [id, name, activity, attached, windows, path, title] = splitFields(line);
      return {
        id: id ?? "",
        name: name ?? "",
        activity: parseInt(activity ?? "0", 10),
        attached: attached === "1",
        windows: parseInt(windows ?? "0", 10),
        path: path ?? "",
        ...(title ? { title } : {}),
      };
    });
}

export interface AttentionCommand {
  args: string[];
  /** When true, a tmux failure aborts; when false (clearing an option that may
   * not be set), failure is ignored. */
  required: boolean;
}

/**
 * Pure builder for the tmux commands that set/clear the orchestration attention
 * flag (`@jmux-attention` / `@jmux-attention-reason`). Kept pure so the exact
 * option semantics are testable without a live tmux server.
 *
 * - `set` always sets `@jmux-attention 1`; with a reason it sets the reason,
 *   without one it clears any stale reason.
 * - `clear` unsets both options (idempotent — `-u` on an unset option is fine).
 *
 * The flag moves last on `set` and first on `clear`, because every reader
 * watches the flag and each command is a separate round trip to the server.
 * Ordered the other way, `set` briefly reads as flagged with no reason (or with
 * the *previous* reason), and `clear` as unflagged-but-still-explained. The
 * flag is the trigger, so it is written once the payload beside it is already
 * true — the same rule the setup pane's own writes follow in
 * `buildSetupCommand`.
 */
export function buildAttentionCommands(
  verb: string,
  target: string,
  reason: string | null,
): AttentionCommand[] {
  if (verb === "set") {
    const cmds: AttentionCommand[] =
      reason !== null
        ? [
            {
              args: ["set-option", "-t", target, "@jmux-attention-reason", reason],
              required: true,
            },
          ]
        : [
            {
              args: ["set-option", "-t", target, "-u", "@jmux-attention-reason"],
              required: false,
            },
          ];
    cmds.push({ args: ["set-option", "-t", target, "@jmux-attention", "1"], required: true });
    return cmds;
  }
  if (verb === "clear") {
    return [
      { args: ["set-option", "-t", target, "-u", "@jmux-attention"], required: true },
      {
        args: ["set-option", "-t", target, "-u", "@jmux-attention-reason"],
        required: false,
      },
    ];
  }
  throw new CliError(
    `Unknown attention verb "${verb}". Use: set | clear`,
  );
}

export const SESSION_REPORT_OUTCOME_OPTION = "@jmux-session-report-outcome";
export const SESSION_REPORT_REASON_OPTION = "@jmux-session-report-reason";

/**
 * The four outcomes `ctl session report` accepts. Exhaustive on purpose: a
 * report's outcome is read back by a consumer whose type covers exactly
 * these four, so nothing else may ever be persisted (see
 * `buildSessionReportCommands`'s refusal below).
 */
export const SESSION_REPORT_OUTCOMES = ["shipped", "blocked", "needs-human", "failed"] as const;
export type SessionReportOutcome = (typeof SESSION_REPORT_OUTCOMES)[number];

/**
 * A session's report, as read back from tmux options or built at write time.
 *
 * `unbound` is always `true` and is not something a caller can set — there is
 * no turn counter anywhere in this repository (see the parent orchestrator
 * design doc: "a report with no turn is unbound and adjudicated, never
 * trusted"). It is stamped explicitly, on every report, so a consumer reading
 * this record can never mistake it for one bound to the turn it describes.
 */
export interface SessionReport {
  outcome: string;
  reason: string;
  readonly unbound: true;
}

/**
 * Parse the two `ctl session report` tmux-option fields into a report, or
 * `null` when the session carries none.
 *
 * Presence is decided by `outcomeField` alone, never by whether `reasonField`
 * looks non-empty. A corrupted or partially-written state — outcome set,
 * reason blank — must surface as a report with an empty reason, not silently
 * read back as "no report": the same "an unreadable thing reported as an
 * empty thing" defect this project's own postmortems call out by name.
 */
export function parseSessionReport(outcomeField: string, reasonField: string): SessionReport | null {
  if (!outcomeField) return null;
  return { outcome: outcomeField, reason: reasonField, unbound: true };
}

/**
 * A reason travels through a tmux `set-option` / `#{...}` round trip that,
 * unlike the option's stored bytes, is read one line at a time on the way
 * back out — `runTmuxDirect` splits `list-panes -F` stdout on `\n`, the same
 * way `tmux-fields.ts`'s own doc comment explains the field separator has to
 * be printable ASCII. tmux is happy to store a raw embedded newline in an
 * option value, so the *write* survives it, but the *read* does not: the
 * server's own `-F` output for that one pane spans several literal stdout
 * lines, this codebase's line-based parsing treats them as several rows, and
 * everything after the first line is silently dropped — proven live against
 * a real server (`show-options -v` returns the reason whole; `list-panes -F`
 * with the same option embedded splits it across three stdout lines).
 *
 * `encodeReportReason` escapes every newline to the two characters `\n`
 * before the value ever reaches tmux, so no raw newline is ever stored.
 * Backslash is escaped first: escaping newline before backslash would take
 * an already-encoded `\n` and re-escape its backslash on a second pass,
 * corrupting a value that was already safe. `decodeReportReason` reverses
 * it, and only it — a literal backslash followed by the letter `n` that was
 * never a newline is, by construction, always paired with an escaped
 * backslash ahead of it (`encodeReportReason` doubles every backslash before
 * it ever escapes a newline), so the decoder cannot mistake one for the
 * other.
 *
 * Together these are the only place a reason's bytes are ever transformed:
 * the write path still returns the caller's reason whole in its own
 * response (built from the same in-process string, never round-tripped
 * through tmux), and this pair is what keeps a *read* of that same reason
 * true to it after a trip through a real server.
 */
export function encodeReportReason(raw: string): string {
  return raw.replace(/\\/g, "\\\\").replace(/\n/g, "\\n");
}

/** Inverse of {@link encodeReportReason}. */
export function decodeReportReason(encoded: string): string {
  let out = "";
  for (let i = 0; i < encoded.length; i++) {
    const ch = encoded[i];
    if (ch === "\\" && i + 1 < encoded.length) {
      const next = encoded[i + 1];
      if (next === "n") {
        out += "\n";
        i++;
        continue;
      }
      if (next === "\\") {
        out += "\\";
        i++;
        continue;
      }
    }
    out += ch;
  }
  return out;
}

export interface SessionReportCommand {
  args: string[];
  required: boolean;
}

/**
 * Pure builder for the tmux commands `ctl session report` issues, plus the
 * two refusals a report must pass before anything is written.
 *
 * Reason is written before outcome — the same "payload before the flag"
 * ordering `buildAttentionCommands` uses (see its doc comment) — because
 * {@link parseSessionReport} treats the outcome field's presence as the
 * signal that a report exists at all; writing it last means a reader never
 * observes an outcome with no reason behind it.
 */
export function buildSessionReportCommands(
  target: string,
  outcome: string,
  reason: string,
): SessionReportCommand[] {
  if (!(SESSION_REPORT_OUTCOMES as readonly string[]).includes(outcome)) {
    throw new CliError(
      `Unknown outcome "${outcome}". Use one of: ${SESSION_REPORT_OUTCOMES.join(", ")}`,
    );
  }
  if (!reason.trim()) {
    throw new CliError("session report requires a non-empty --reason");
  }
  return [
    {
      args: ["set-option", "-t", target, SESSION_REPORT_REASON_OPTION, encodeReportReason(reason)],
      required: true,
    },
    { args: ["set-option", "-t", target, SESSION_REPORT_OUTCOME_OPTION, outcome], required: true },
  ];
}

export interface GridHiddenCommand {
  args: string[];
  required: boolean;
}

/**
 * Build the tmux command to set/unset the session-scoped `@jmux-grid-hidden`
 * option — the Command Center's "keep this whole session off the grid"
 * exception (`glass/exceptions.ts`). Session-scoped because its subject is a
 * session tile, unlike `@jmux-pinned`'s pane scope. `unhide` deliberately
 * never touches `@jmux-pinned`: per the design's truth table, a pin left
 * behind from before the hide is exactly the face the session should come
 * back showing, not something to clear a second time.
 */
export function buildGridHiddenCommands(
  verb: "hide" | "unhide",
  target: string,
): GridHiddenCommand[] {
  if (verb === "hide") {
    return [{ args: ["set-option", "-t", target, "@jmux-grid-hidden", "1"], required: true }];
  }
  return [{ args: ["set-option", "-t", target, "-u", "@jmux-grid-hidden"], required: true }];
}

export const HIDDEN_LIST_FORMAT = "#{session_id}:#{session_name}:#{@jmux-grid-hidden}";

export interface HiddenSessionEntry {
  id: string;
  name: string;
}

/** Parse `list-sessions -F HIDDEN_LIST_FORMAT` into the sessions reading as
 *  hidden under `isGridHiddenValue`'s strict grammar — exactly `"1"`. */
export function parseHiddenList(lines: string[]): HiddenSessionEntry[] {
  const out: HiddenSessionEntry[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const first = trimmed.indexOf(":");
    const second = trimmed.indexOf(":", first + 1);
    if (first < 0 || second < 0) continue;
    const id = trimmed.slice(0, first);
    const name = trimmed.slice(first + 1, second);
    const hidden = trimmed.slice(second + 1);
    if (isGridHiddenValue(hidden)) out.push({ id, name });
  }
  return out;
}

export function validateSessionCreate(flags: Record<string, string | boolean>): {
  name: string;
  dir: string;
  command?: string;
} {
  if (!flags.name || typeof flags.name !== "string") {
    throw new CliError("--name is required");
  }
  if (!flags.dir || typeof flags.dir !== "string") {
    throw new CliError("--dir is required");
  }
  const name = sanitizeTmuxSessionName(flags.name);
  const dir = flags.dir;
  const command = typeof flags.command === "string" ? flags.command : undefined;
  return { name, dir, ...(command !== undefined ? { command } : {}) };
}

export function handleSession(ctx: CliContext, parsed: ParsedCtlArgs): unknown {
  const { action, flags } = parsed;

  switch (action) {
    case "list": {
      const result = runTmuxDirect(
        ["list-sessions", "-f", INTERNAL_SESSION_FILTER, "-F", SESSION_FIELDS_FORMAT],
        ctx.socket,
      );
      // If no sessions exist, tmux exits non-zero — treat as empty list
      const lines = result.ok ? result.lines : [];
      const sessions = parseSessionListOutput(lines);
      return { sessions };
    }

    case "create": {
      const { name, dir, command } = validateSessionCreate(flags);
      const otel = buildOtelResourceAttrs(name);

      const createArgs = ["new-session", "-d", "-e", `OTEL_RESOURCE_ATTRIBUTES=${otel}`, "-s", name, "-c", dir];
      if (command) {
        createArgs.push(command);
      }

      tmuxOrThrow(runTmuxDirect(createArgs, ctx.socket));

      // Resolve the session ID
      const idResult = runTmuxDirect(
        ["list-sessions", "-F", "#{session_id}:#{session_name}", "-f", `#{==:#{session_name},${name}}`],
        ctx.socket,
      );
      let id: string | null = null;
      if (idResult.ok && idResult.lines.length > 0) {
        const parts = idResult.lines[0].split(":");
        id = parts[0];
      }

      return { name, id };
    }

    case "info": {
      if (!flags.target || typeof flags.target !== "string") {
        throw new CliError("--target is required");
      }
      const target = flags.target;

      const sessionResult = runTmuxDirect(
        ["list-sessions", "-F", SESSION_FIELDS_FORMAT, "-f", `#{==:#{session_name},${target}}`],
        ctx.socket,
      );
      tmuxOrThrow(sessionResult);
      const sessions = parseSessionListOutput(sessionResult.lines);
      const session = sessions[0];
      if (!session) {
        throw new CliError(`session "${target}" not found`);
      }

      const windowsResult = runTmuxDirect(
        ["list-windows", "-t", target, "-F", "#{window_id}:#{window_index}:#{window_name}:#{window_active}:#{window_bell_flag}:#{window_zoomed_flag}"],
        ctx.socket,
      );
      tmuxOrThrow(windowsResult);

      const windows_detail = windowsResult.lines.map((line) => {
        const parts = line.split(":");
        return {
          id: parts[0],
          index: parseInt(parts[1], 10),
          name: parts[2],
          active: parts[3] === "1",
          bell: parts[4] === "1",
          zoomed: parts[5] === "1",
        };
      });

      return { ...session, windows_detail };
    }

    case "switch": {
      if (!flags.target || typeof flags.target !== "string") {
        throw new CliError("--target is required");
      }
      if (!ctx.insideTmux) {
        throw new CliError("switch requires an active tmux session (not inside tmux)");
      }
      const target = flags.target;
      tmuxOrThrow(runTmuxDirect(["switch-client", "-t", target], ctx.socket));
      return { switched: target };
    }

    case "kill": {
      if (!flags.target || typeof flags.target !== "string") {
        throw new CliError("--target is required");
      }
      const target = flags.target;

      if (!flags.force) {
        // Self-destruction guard
        const current = resolveCurrentSession(ctx);
        if (current && current === target) {
          throw new CliError(
            `Refusing to kill current session "${target}". Use --force to override.`,
          );
        }

        // Last-session guard
        const listResult = runTmuxDirect(["list-sessions", "-f", INTERNAL_SESSION_FILTER, "-F", "#{session_name}"], ctx.socket);
        if (listResult.ok && listResult.lines.length <= 1) {
          throw new CliError(
            `Refusing to kill the last session "${target}". Use --force to override.`,
          );
        }
      }

      tmuxOrThrow(runTmuxDirect(["kill-session", "-t", target], ctx.socket));
      return { killed: target };
    }

    case "rename": {
      if (!flags.target || typeof flags.target !== "string") {
        throw new CliError("--target is required");
      }
      if (!flags.name || typeof flags.name !== "string") {
        throw new CliError("--name is required");
      }
      const target = flags.target;
      const newName = sanitizeTmuxSessionName(flags.name);
      tmuxOrThrow(runTmuxDirect(["rename-session", "-t", target, newName], ctx.socket));
      // Stamp the same sentinel the TUI's own rename does, so a title
      // generated before this rename (or one already in flight elsewhere)
      // never overwrites a name the caller just set on purpose. `-t` and `-u`
      // are kept as separate argv elements — "-tu" reads as "-t" taking the
      // literal argument "u", which tmux rejects as "invalid option: <target>".
      runTmuxDirect(["set-option", "-t", newName, "-u", SESSION_TITLE_OPTION], ctx.socket);
      runTmuxDirect(
        ["set-option", "-t", newName, TITLE_SIGNATURE_OPTION, MANUAL_SIGNATURE],
        ctx.socket,
      );
      return { renamed: newName, from: target };
    }

    case "attention": {
      const verb = parsed.positional[0] ?? "";
      if (!flags.target || typeof flags.target !== "string") {
        throw new CliError("--target is required");
      }
      const target = flags.target;
      const reason =
        verb === "set" && typeof flags.reason === "string" ? flags.reason : null;

      const commands = buildAttentionCommands(verb, target, reason);
      for (const cmd of commands) {
        const result = runTmuxDirect(cmd.args, ctx.socket);
        if (cmd.required) tmuxOrThrow(result);
      }

      if (verb === "set") {
        return { target, attention: true, reason };
      }
      return { target, attention: false };
    }

    case "hide":
    case "unhide": {
      if (!flags.target || typeof flags.target !== "string") {
        throw new CliError("--target is required");
      }
      const target = flags.target;
      for (const cmd of buildGridHiddenCommands(action as "hide" | "unhide", target)) {
        const result = runTmuxDirect(cmd.args, ctx.socket);
        if (cmd.required) tmuxOrThrow(result);
      }
      return { target, hidden: action === "hide" };
    }

    case "hidden": {
      const result = runTmuxDirect(
        ["list-sessions", "-f", INTERNAL_SESSION_FILTER, "-F", HIDDEN_LIST_FORMAT],
        ctx.socket,
      );
      const lines = result.ok ? result.lines : [];
      return { hidden: parseHiddenList(lines) };
    }

    case "report": {
      if (!flags.target || typeof flags.target !== "string") {
        throw new CliError("--target is required");
      }
      const target = flags.target;
      const outcome = typeof flags.outcome === "string" ? flags.outcome : "";
      const reason = typeof flags.reason === "string" ? flags.reason : "";

      const commands = buildSessionReportCommands(target, outcome, reason);
      for (const cmd of commands) {
        tmuxOrThrow(runTmuxDirect(cmd.args, ctx.socket));
      }

      // `buildSessionReportCommands` already refused any outcome that would
      // make `outcome` empty, so this can never read back `null`.
      const report = parseSessionReport(outcome, reason)!;
      return { target, report };
    }

    default:
      throw new CliError(
        `Unknown session action "${action}". Known actions: list, create, info, switch, kill, rename, attention, hide, unhide, hidden, report`,
      );
  }
}
