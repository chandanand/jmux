import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

import { dataHome, materializeAssets, skillIn } from "../assets";
import { uninstallAllAgents, type InstallReport } from "./registry";

/**
 * The jmux agent skill.
 *
 * Shipping `skills/jmux-control.md` in the npm package never worked: Claude
 * Code discovers skills at `<config-dir>/skills/<name>/SKILL.md`, so a markdown
 * file sitting inside a package install dir is never found. The README claimed
 * agents auto-discovered it; on every machine but the author's — which had a
 * hand-made symlink — they did not.
 */

const SKILL_NAME = "jmux-control";

/**
 * hunk's own review skill, installed alongside jmux's.
 *
 * jmux does not write this file — hunk ships it and prints its path with
 * `hunk skill path`. It is installed here because jmux is what puts a hunk
 * session in front of the user in the first place: an agent in a jmux session
 * can navigate and annotate the diff its human is reading, but only if it knows
 * the `hunk session` CLI exists. Copied rather than symlinked so that
 * `--uninstall-integrations` can remove it, and so an upgrade of hunk is picked
 * up by re-running the install rather than changing under jmux silently.
 */
const HUNK_SKILL_NAME = "hunk-review";

/**
 * Appended to hunk's shipped skill. Its text tells an agent to "ask the user to
 * launch Hunk in their terminal", which is a dead end for someone whose hunk is
 * a jmux panel — this says which key does that.
 */
const HUNK_SKILL_JMUX_NOTE = `
## Inside jmux

jmux runs Hunk as its Diff panel. If \`hunk session list\` is empty, ask the
user to press \`Ctrl-Space g\` to open it rather than running \`hunk diff\` yourself.

The panel is pointed at the jmux session's own worktree, so \`--repo\` selection
usually resolves without an explicit id. Notes you add appear inline for the
user; notes *they* write (\`c\` in the panel) are sent back to you when they
press \`Ctrl-Space r\`, so there is no need to poll \`comment list\` for them.
`;

/**
 * `$CLAUDE_CONFIG_DIR` when set, else `~/.claude`.
 *
 * The same rule `claude.ts` follows, for the same reason: writing to
 * `~/.claude` for a user who relocated their config installs something that
 * never fires. Resolved per call so tests and relocated configs both work.
 */
export function claudeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_CONFIG_DIR ?? resolve(env.HOME ?? homedir(), ".claude");
}

export function skillTarget(env: NodeJS.ProcessEnv = process.env, name: string = SKILL_NAME): string {
  return resolve(claudeConfigDir(env), "skills", name, "SKILL.md");
}

/**
 * hunk's shipped skill plus jmux's addendum, or null when hunk can't supply it
 * — an older hunk with no `skill path`, or none installed at all. Null is a
 * normal outcome, not a failure: hunk is an optional dependency.
 */
export function hunkSkillSource(hunkCommand = "hunk"): string | null {
  try {
    const which = Bun.spawnSync([hunkCommand, "skill", "path"], { stdout: "pipe", stderr: "ignore" });
    if ((which.exitCode ?? 1) !== 0) return null;
    const path = which.stdout.toString().trim();
    if (!path) return null;
    return `${readFileSync(path, "utf-8").trimEnd()}\n${HUNK_SKILL_JMUX_NOTE}`;
  } catch {
    return null;
  }
}

export type SkillState =
  /** Nothing there. */
  | "absent"
  /** Byte-identical to what we ship. */
  | "current"
  /** A regular file that differs — an older jmux, or a user edit. */
  | "stale"
  /** A symlink. Someone wired this up deliberately; it is not ours to replace. */
  | "symlink";

export function detectSkill(
  shipped: string,
  env: NodeJS.ProcessEnv = process.env,
  name: string = SKILL_NAME,
): SkillState {
  const target = skillTarget(env, name);
  let stat;
  try {
    stat = lstatSync(target);
  } catch {
    return "absent";
  }
  if (stat.isSymbolicLink()) return "symlink";
  try {
    return readFileSync(target, "utf-8") === shipped ? "current" : "stale";
  } catch {
    return "stale";
  }
}

export interface SkillOutcome {
  state: SkillState;
  target: string;
  wrote: boolean;
  notes: string[];
}

/**
 * Install the skill, and say what happened.
 *
 * A symlink is left alone: that is a developer pointing the skill at a working
 * tree (this repo's own author does exactly that), and clobbering it would
 * silently detach their edits. Everything else converges on the shipped copy.
 */
export function installSkillTo(
  shipped: string,
  env: NodeJS.ProcessEnv = process.env,
  name: string = SKILL_NAME,
): SkillOutcome {
  const target = skillTarget(env, name);
  const state = detectSkill(shipped, env, name);

  if (state === "current") {
    return { state, target, wrote: false, notes: ["already up to date"] };
  }
  if (state === "symlink") {
    return {
      state,
      target,
      wrote: false,
      notes: [
        `${target} is a symlink — leaving it alone.`,
        "Delete it and re-run if you want the shipped copy.",
      ],
    };
  }

  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, shipped);

  return {
    state,
    target,
    wrote: true,
    notes: state === "stale" ? [`replaced an older copy at ${target}`] : [`installed to ${target}`],
  };
}

/**
 * Install both skills and report what happened, without printing anything.
 *
 * `installSkill()` below writes with `console.log`, which is correct for
 * `jmux --install-skill` and wrong from inside the TUI: on an alt screen those
 * lines land directly on the rendered frame, over whatever was there. So the
 * work lives here and presentation belongs to the caller.
 *
 * Returns `InstallReport` — the type the *agent* installer already returns —
 * rather than a parallel one, so a caller renders hooks and skills through a
 * single path and the two vocabularies cannot drift apart.
 *
 * `env` is a parameter for the same reason every other function in this module
 * takes one: a test that installed into the real `~/.claude` would rewrite the
 * developer's own config.
 */
export function installSkills(
  env: NodeJS.ProcessEnv = process.env,
  hunkCommand = "hunk",
): InstallReport[] {
  const reports: InstallReport[] = [];

  try {
    const shipped = readFileSync(skillIn(materializeAssets()), "utf-8");
    const outcome = installSkillTo(shipped, env);
    reports.push({
      label: "jmux-control skill",
      kind: outcome.wrote ? "installed" : "noop",
      notes: outcome.notes,
    });
  } catch (err) {
    reports.push({
      label: "jmux-control skill",
      kind: "failed",
      notes: [(err as Error).message],
    });
  }

  // hunk's skill is a bonus, never a requirement: no hunk means no Diff panel
  // to drive, so its absence is `skipped` and not `failed`.
  const hunkShipped = hunkSkillSource(hunkCommand);
  if (hunkShipped === null) {
    reports.push({
      label: "hunk-review skill",
      kind: "skipped",
      notes: ["hunk not installed"],
    });
    return reports;
  }
  try {
    const outcome = installSkillTo(hunkShipped, env, HUNK_SKILL_NAME);
    reports.push({
      label: "hunk-review skill",
      kind: outcome.wrote ? "installed" : "noop",
      notes: outcome.notes,
    });
  } catch (err) {
    reports.push({
      label: "hunk-review skill",
      kind: "failed",
      notes: [(err as Error).message],
    });
  }
  return reports;
}

/** What each skill unlocks, printed by the CLI once it has actually landed. */
const SKILL_PAYOFF: Record<string, string> = {
  "jmux-control skill": "Agents running inside jmux can now discover `jmux ctl`.",
  "hunk-review skill": "Agents can now drive the Diff panel with `hunk session`.",
};

/**
 * CLI entry point for `jmux --install-skill`. Returns success.
 *
 * Printing only — the work is `installSkills()`. Keeping the two as one
 * implementation is what stops the CLI and the TUI reporting different things
 * about the same install, which is exactly the drift that let the TUI inherit
 * this function's `console.log`s onto its own frame.
 */
export function installSkill(): boolean {
  let ok = true;
  for (const report of installSkills()) {
    if (report.kind === "failed") {
      process.stderr.write(`Could not install the ${report.label}: ${report.notes[0]}\n`);
      ok = false;
      continue;
    }
    if (report.kind === "skipped") {
      console.log(`${report.label}: hunk not found — skipped`);
      continue;
    }
    console.log(`${report.label}: ${report.notes[0]}`);
    for (const note of report.notes.slice(1)) console.log(`  ${note}`);
    if (report.kind === "installed") {
      console.log("");
      console.log(SKILL_PAYOFF[report.label] ?? "");
    }
  }
  return ok;
}

/** Exposed for the uninstall path, which must know what jmux created. */
export function installedSkillPaths(env: NodeJS.ProcessEnv = process.env): string[] {
  const paths: string[] = [];
  for (const name of [SKILL_NAME, HUNK_SKILL_NAME]) {
    const target = skillTarget(env, name);
    if (existsSync(target)) paths.push(target, dirname(target));
  }
  return paths;
}

/**
 * Reverse what jmux installed into other tools' config.
 *
 * Neither `brew uninstall` nor deleting the binary touches any of this — the
 * hooks live in Claude Code's, Codex's and pi's own settings, and the skill
 * lives under Claude Code's config dir. Without this, uninstalling jmux leaves
 * three agents referencing a binary that is gone.
 *
 * A symlinked skill is left alone here for the same reason install refuses to
 * overwrite it: jmux did not create it.
 */
export function uninstallIntegrations(env: NodeJS.ProcessEnv = process.env): boolean {
  let ok = true;
  const removed: string[] = [];

  // Both skills jmux installs — its own and the copy of hunk's. Leaving the
  // second behind would point agents at a CLI for a panel that is gone.
  for (const name of [SKILL_NAME, HUNK_SKILL_NAME]) {
    const target = skillTarget(env, name);
    try {
      // lstat, not existsSync: existsSync follows symlinks, so a *broken* symlink
      // reads as absent — and a broken symlink is exactly what an uninstalled
      // working tree leaves behind.
      let stat: ReturnType<typeof lstatSync> | null = null;
      try {
        stat = lstatSync(target);
      } catch {
        stat = null;
      }
      if (stat?.isSymbolicLink()) {
        console.log(`skill: ${target} is a symlink you created — left alone`);
      } else if (stat) {
        rmSync(dirname(target), { recursive: true, force: true });
        removed.push(target);
      }
    } catch (err) {
      console.error(`skill: could not remove ${target}: ${(err as Error).message}`);
      ok = false;
    }
  }

  for (const line of uninstallAllAgents()) {
    if (line.removed) removed.push(...line.paths);
    for (const note of line.notes) console.log(`${line.label}: ${note}`);
  }

  if (removed.length === 0) console.log("Nothing to remove.");
  else for (const path of removed) console.log(`removed ${path}`);

  console.log("");
  console.log("jmux's own data is left in place. To remove it too:");
  console.log(`  rm -rf ${resolve(dataHome(env), "jmux")}`);
  console.log(`  rm -rf ${resolve(env.XDG_CONFIG_HOME ?? resolve(env.HOME ?? homedir(), ".config"), "jmux")}`);

  return ok;
}
