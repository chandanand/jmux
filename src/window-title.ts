// Deterministic window names.
//
// A session title answers "what work is this?" and may need issue/prompt/commit
// context. A window name answers the smaller question "what is open here?".
// The foreground command, its argv when the executable is ambiguous, and the
// pane cwd are enough for that job; involving a model would add latency and
// churn without adding useful information.

/** Per-window value consumed by tmux's automatic-rename-format. */
export const AUTO_WINDOW_TITLE_OPTION = "@jmux-auto-window-title";

/**
 * The classifier writes the first branch. The cwd fallback keeps naming useful
 * before jmux's first classification pass and on a server with no live TUI.
 */
export const AUTOMATIC_WINDOW_TITLE_FORMAT =
  `#{?${AUTO_WINDOW_TITLE_OPTION},#{${AUTO_WINDOW_TITLE_OPTION}},#{b:pane_current_path}}`;

export interface WindowProcess {
  pid: number;
  ppid: number;
  argv: string;
}

export interface WindowTitleInput {
  command: string;
  cwd: string;
  /** Full foreground-process argv when it was cheap and possible to resolve. */
  argv?: string | null;
}

const SHELLS = new Set([
  "bash", "dash", "elvish", "fish", "ksh", "nu", "sh", "tcsh", "xonsh", "zsh",
]);
const EDITORS = new Set(["emacs", "helix", "hx", "nvim", "vi", "vim"]);
const REVIEWERS = new Set(["hunk", "hunkdiff"]);
const TEST_RUNNERS = new Set([
  "ava", "bats", "cypress", "jest", "mocha", "playwright", "pytest", "rspec", "tap", "vitest",
]);
const SERVERS = new Set([
  "astro", "gatsby", "gunicorn", "next", "nuxt", "rails", "remix", "uvicorn", "vite",
  "webpack-dev-server",
]);
const AGENTS = new Map([
  ["aider", "aider"],
  ["claude", "claude"],
  ["codex", "codex"],
  ["opencode", "opencode"],
  ["pi", "pi"],
]);

// These executables say too little on their own. One `ps` snapshot lets the
// classifier distinguish `bun test` from `bun dev`, or a Node-hosted Claude
// CLI from an ordinary Node program. Everything else stays subprocess-free.
const ARG_SENSITIVE = new Set([
  "bundle", "bun", "cargo", "deno", "go", "java", "just", "make", "node", "nodejs",
  "npm", "npx", "pnpm", "poetry", "python", "python3", "ruby", "uv", "yarn",
]);

function commandName(raw: string): string {
  const token = raw.trim().split(/\s+/, 1)[0] ?? "";
  return token
    .replace(/^['"]|['"]$/g, "")
    .replace(/\\/g, "/")
    .split("/")
    .pop()!
    .replace(/^-/, "")
    .replace(/\.exe$/i, "")
    .toLowerCase();
}

function cwdName(cwd: string): string {
  const trimmed = cwd.replace(/[\\/]+$/, "");
  if (!trimmed && cwd) return "/";
  return trimmed.split(/[\\/]/).pop() || "shell";
}

/** Whether resolving argv can improve the answer for this executable. */
export function needsWindowProcessArgv(command: string): boolean {
  return ARG_SENSITIVE.has(commandName(command));
}

/** Parse portable `ps -Ao pid=,ppid=,args=` output. */
export function parseWindowProcesses(output: string): WindowProcess[] {
  const out: WindowProcess[] = [];
  for (const line of output.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
    out.push({ pid, ppid, argv: match[3]!.trim() });
  }
  return out;
}

/**
 * Find the foreground command's argv under a pane's root process.
 *
 * `pane_pid` is normally the shell, while `pane_current_command` is the leaf
 * tmux sees in the foreground. Match that command among the shell's descendants
 * and take the deepest match; wrappers commonly produce both a parent and a
 * child with the same executable name.
 */
export function windowProcessArgv(
  panePid: number,
  currentCommand: string,
  processes: readonly WindowProcess[],
): string | null {
  if (!Number.isInteger(panePid) || panePid <= 0) return null;
  const wanted = commandName(currentCommand);
  if (!wanted) return null;

  const byPid = new Map(processes.map((p) => [p.pid, p]));
  const children = new Map<number, number[]>();
  for (const process of processes) {
    const list = children.get(process.ppid);
    if (list) list.push(process.pid);
    else children.set(process.ppid, [process.pid]);
  }

  let best: { depth: number; argv: string } | null = null;
  const seen = new Set<number>();
  const queue: Array<{ pid: number; depth: number }> = [{ pid: panePid, depth: 0 }];
  while (queue.length > 0) {
    const next = queue.shift()!;
    if (seen.has(next.pid)) continue;
    seen.add(next.pid);
    const process = byPid.get(next.pid);
    if (process && commandName(process.argv) === wanted && (!best || next.depth >= best.depth)) {
      best = { depth: next.depth, argv: process.argv };
    }
    for (const child of children.get(next.pid) ?? []) {
      queue.push({ pid: child, depth: next.depth + 1 });
    }
  }
  return best?.argv ?? null;
}

function agentFrom(command: string, argv: string): string | null {
  const direct = AGENTS.get(command);
  if (direct) return direct;
  // Agent CLIs are often Node/Python entry points, so the process name is the
  // interpreter and the useful identity lives in a script path.
  if (/(?:^|[\s/])claude(?:-code)?(?:[\s/.]|$)/i.test(argv)) return "claude";
  if (/(?:^|[\s/])codex(?:[\s/.]|$)/i.test(argv)) return "codex";
  if (/(?:^|[\s/])opencode(?:[\s/.]|$)/i.test(argv)) return "opencode";
  if (/(?:^|[\s/])aider(?:[\s/.]|$)/i.test(argv)) return "aider";
  return null;
}

/** A short, stable label for the active pane of one automatically named window. */
export function deriveAutomaticWindowTitle(input: WindowTitleInput): string {
  const command = commandName(input.command);
  const argv = (input.argv ?? "").trim();
  const haystack = `${command} ${argv}`.toLowerCase();

  const agent = agentFrom(command, argv);
  if (agent) return agent;
  if (EDITORS.has(command)) return "editor";
  if (REVIEWERS.has(command)) return "review";

  if (
    TEST_RUNNERS.has(command) ||
    /(?:^|[\s/])(vitest|jest|pytest|rspec|mocha|playwright|cypress)(?:[\s/.]|$)/.test(haystack) ||
    /\b(?:bun|npm|pnpm|yarn)(?:\s+run)?\s+test(?::[^\s]+)?(?:\s|$)/.test(haystack) ||
    /\b(?:cargo|go)\s+test(?:\s|$)/.test(haystack)
  ) {
    return "tests";
  }

  if (
    SERVERS.has(command) ||
    /\b(?:bun|npm|pnpm|yarn)(?:\s+run)?\s+(?:dev|serve|start)(?:\s|$)/.test(haystack) ||
    /(?:^|[\s/])(vite|webpack-dev-server|uvicorn|gunicorn)(?:[\s/.]|$)/.test(haystack) ||
    /(?:^|[\s/])(?:dev-?server|server)\.(?:c?js|mjs|ts|py|rb)(?:\s|$)/.test(haystack)
  ) {
    return "server";
  }

  if (!command || SHELLS.has(command)) return cwdName(input.cwd);
  return command;
}
