// The naming commands jmux offers, and the mapping between argv and a name.
//
// `sessionTitle.command` was reachable only by hand-editing config.json, and
// the setup hint said so outright. `resolveTitleConfig` exists because every
// way that value can be wrong fails silently and identically — a string
// instead of an array spreads into argv `["c","l","a",…]` and ENOENTs into the
// silent-failure rule. Validation turns a malformed value into a message; it
// cannot help the user who never found the setting.
//
// **A preset stores full argv, never its own name.** The row reads back which
// preset is in force by matching the stored `string[]` against this table, so
// `sessionTitle.command` keeps exactly the shape it has today,
// `resolveTitleConfig` is untouched, there is no migration, no second source of
// truth, and config.json stays legible to someone who has never seen the
// picker. This table is an authoring convenience over a value that stays argv.
//
// See docs/superpowers/specs/2026-08-12-settings-editor-controls-design.md.

import { shellArg } from "../shell-quote";

/** Sentinel rungs. Neither is a preset — both are answers about one. */
export const TITLE_OFF = "off";
export const TITLE_CUSTOM = "custom";

export interface TitlePreset {
  id: string;
  /** argv. The prompt arrives on stdin; the title is read from stdout. */
  command: readonly string[];
  /** Shown on the explain line while the row is selected. */
  note: string;
}

/**
 * Only commands run end to end against a real terminal ship here.
 *
 * This is the rule `agent-screen.ts` already states for its signature table:
 * only add a built-in you have read off a real terminal, because an unverified
 * entry produces a confident wrong answer instead of an honest blank. `pi`,
 * `gemini` and `opencode` expose the right flags in their own `--help` but
 * their output shape could not be checked without credentials; `grok` was not
 * installed at all. Every one of them is still reachable through `custom`.
 *
 * Both entries below were measured naming a real session: claude 11.5s, codex
 * 6.1s, against a 60s default timeout.
 */
export const TITLE_PRESETS: readonly TitlePreset[] = [
  {
    id: "claude",
    // --tools "" leaves the model nothing to do but answer: the prompt carries
    // everything it needs, and a naming subprocess that can read files is a
    // naming subprocess that can be slow for no reason.
    command: ["claude", "-p", "--model", "haiku", "--effort", "low", "--tools", ""],
    note: "Claude Code, smallest model, no tools. Around 11s.",
  },
  {
    id: "codex",
    // --skip-git-repo-check is load-bearing rather than defensive:
    // titleRunnerCwd() returns tmpdir(), which is not a repository, and codex
    // refuses to start in one without it. Everything but the final message
    // goes to stderr, which spawnTitleRunner already ignores.
    command: [
      "codex", "exec", "--skip-git-repo-check", "--ephemeral",
      "-s", "read-only", "-c", "model_reasoning_effort=none", "-",
    ],
    note: "Codex, no reasoning, sandboxed read-only. Around 6s.",
  },
];

function sameArgv(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/**
 * Which rung the stored command sits on.
 *
 * Anything that is not exactly a preset's argv is `custom` — a near-match
 * reported as the preset would let the row name a command that is not the one
 * being run, and saying which one it is happens to be the row's entire job.
 */
export function presetForCommand(command: readonly string[] | undefined): string {
  if (!command || command.length === 0) return TITLE_OFF;
  const hit = TITLE_PRESETS.find((p) => sameArgv(p.command, command));
  return hit ? hit.id : TITLE_CUSTOM;
}

/** What a chosen rung stores. `custom` stores nothing — the editor supplies it. */
export function commandForPreset(id: string): string[] | undefined {
  const hit = TITLE_PRESETS.find((p) => p.id === id);
  return hit ? [...hit.command] : undefined;
}

/**
 * The ◂ ▸ ladder: off, then each preset, then the stored custom command when
 * there is one.
 *
 * `custom` is a rung only when it is already a value. Every press must land on
 * something that is now in force, so an *authoring* entry cannot sit on the
 * cycle — stepping onto it would either pop a text editor mid-press or leave
 * the row naming an option that is not a setting. Enter's picker offers it
 * unconditionally, because choosing it there is a deliberate act.
 */
export function titlePresetOptions(command: readonly string[] | undefined): string[] {
  const options = [TITLE_OFF, ...TITLE_PRESETS.map((p) => p.id)];
  if (presetForCommand(command) === TITLE_CUSTOM) options.push(TITLE_CUSTOM);
  return options;
}

/**
 * argv as one editable line. Quotes only what would otherwise be mangled, via
 * the same helper the worktree commands use — which quotes an empty string
 * explicitly, because bare it vanishes from the argv rather than arriving as
 * an empty argument. `--tools ""` losing its `""` would silently re-enable
 * every tool for the naming subprocess.
 */
export function formatTitleCommand(command: readonly string[] | undefined): string {
  return (command ?? []).map(shellArg).join(" ");
}

/**
 * The line back into argv.
 *
 * Handles single and double quotes so the form above round-trips; it is
 * deliberately not a shell — no expansion, no substitution, no operators. The
 * value is argv for `Bun.spawn`, which runs no shell either, so a parser that
 * pretended otherwise would accept input that cannot work.
 */
export function parseTitleCommand(line: string): string[] | undefined {
  const argv: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let started = false;

  for (const ch of line) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; started = true; continue; }
    if (/\s/.test(ch)) {
      if (started) { argv.push(current); current = ""; started = false; }
      continue;
    }
    current += ch;
    started = true;
  }
  if (started) argv.push(current);

  return argv.length > 0 ? argv : undefined;
}
