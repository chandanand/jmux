import { afterEach, describe, expect, test } from "bun:test";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";

import {
  claudeConfigDir,
  detectSkill,
  hunkSkillSource,
  installSkillTo,
  installSkills,
  installedSkillPaths,
  skillTarget,
} from "../../agent-hooks/skill";

const roots: string[] = [];

function scratch(): string {
  const dir = mkdtempSync(resolve(tmpdir(), "jmux-skill-"));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

const SHIPPED = "---\nname: jmux-control\n---\n\nbody\n";

function envWith(dir: string): NodeJS.ProcessEnv {
  return { CLAUDE_CONFIG_DIR: dir } as NodeJS.ProcessEnv;
}

describe("claudeConfigDir", () => {
  // The whole reason this function exists: a user who relocated their Claude
  // config gets an install that never fires if we hardcode ~/.claude.
  test("honors CLAUDE_CONFIG_DIR", () => {
    expect(claudeConfigDir({ CLAUDE_CONFIG_DIR: "/elsewhere", HOME: "/home/u" } as NodeJS.ProcessEnv)).toBe(
      "/elsewhere",
    );
  });

  test("falls back to ~/.claude", () => {
    expect(claudeConfigDir({ HOME: "/home/u" } as NodeJS.ProcessEnv)).toBe("/home/u/.claude");
  });

  test("target is the discoverable SKILL.md path", () => {
    expect(skillTarget({ CLAUDE_CONFIG_DIR: "/c" } as NodeJS.ProcessEnv)).toBe(
      "/c/skills/jmux-control/SKILL.md",
    );
  });
});

describe("detectSkill", () => {
  test("absent when nothing is there", () => {
    expect(detectSkill(SHIPPED, envWith(scratch()))).toBe("absent");
  });

  test("current when byte-identical", () => {
    const env = envWith(scratch());
    installSkillTo(SHIPPED, env);
    expect(detectSkill(SHIPPED, env)).toBe("current");
  });

  test("stale when a differing regular file exists", () => {
    const env = envWith(scratch());
    const target = skillTarget(env);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, "an older copy\n");
    expect(detectSkill(SHIPPED, env)).toBe("stale");
  });

  test("symlink is its own state", () => {
    const root = scratch();
    const env = envWith(root);
    const target = skillTarget(env);
    const source = resolve(root, "checkout.md");
    writeFileSync(source, SHIPPED);
    mkdirSync(dirname(target), { recursive: true });
    symlinkSync(source, target);
    expect(detectSkill(SHIPPED, env)).toBe("symlink");
  });
});

describe("installSkillTo", () => {
  test("writes the skill where Claude Code looks for it", () => {
    const env = envWith(scratch());
    const outcome = installSkillTo(SHIPPED, env);

    expect(outcome.wrote).toBe(true);
    expect(readFileSync(outcome.target, "utf-8")).toBe(SHIPPED);
  });

  test("is idempotent", () => {
    const env = envWith(scratch());
    installSkillTo(SHIPPED, env);
    const second = installSkillTo(SHIPPED, env);

    expect(second.state).toBe("current");
    expect(second.wrote).toBe(false);
  });

  test("replaces an older copy and says so", () => {
    const env = envWith(scratch());
    const target = skillTarget(env);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, "an older copy\n");

    const outcome = installSkillTo(SHIPPED, env);
    expect(outcome.wrote).toBe(true);
    expect(outcome.notes[0]).toContain("replaced an older copy");
    expect(readFileSync(target, "utf-8")).toBe(SHIPPED);
  });

  // A symlink is a developer pointing the skill at a working tree — this
  // repo's own author does exactly that. Overwriting it would silently detach
  // their edits, so it is reported and left alone.
  test("never clobbers a symlink", () => {
    const root = scratch();
    const env = envWith(root);
    const target = skillTarget(env);
    const source = resolve(root, "checkout.md");
    writeFileSync(source, "live working tree\n");
    mkdirSync(dirname(target), { recursive: true });
    symlinkSync(source, target);

    const outcome = installSkillTo(SHIPPED, env);

    expect(outcome.wrote).toBe(false);
    expect(lstatSync(target).isSymbolicLink()).toBe(true);
    expect(readFileSync(source, "utf-8")).toBe("live working tree\n");
  });
});

// hunk ships its own review skill and prints its path; jmux installs a copy so
// an agent in a jmux session can drive the Diff panel the user is reading.
describe("the hunk-review skill", () => {
  const HUNK_SHIPPED = "---\nname: hunk-review\n---\n\nsession CLI\n";

  test("installs under hunk's own name, beside jmux's", () => {
    const env = envWith(scratch());
    installSkillTo(SHIPPED, env);
    installSkillTo(HUNK_SHIPPED, env, "hunk-review");

    expect(skillTarget(env, "hunk-review")).toBe(resolve(env.CLAUDE_CONFIG_DIR!, "skills/hunk-review/SKILL.md"));
    expect(readFileSync(skillTarget(env), "utf-8")).toBe(SHIPPED);
    expect(readFileSync(skillTarget(env, "hunk-review"), "utf-8")).toBe(HUNK_SHIPPED);
  });

  // Two skills, two independent states — installing one must not make the
  // other look current.
  test("each skill tracks its own state", () => {
    const env = envWith(scratch());
    installSkillTo(HUNK_SHIPPED, env, "hunk-review");

    expect(detectSkill(HUNK_SHIPPED, env, "hunk-review")).toBe("current");
    expect(detectSkill(SHIPPED, env)).toBe("absent");
  });

  // hunk upgrades on its own schedule, so a copy from an older hunk has to be
  // replaceable by re-running the install.
  test("a copy from an older hunk is stale and gets replaced", () => {
    const env = envWith(scratch());
    installSkillTo("---\nname: hunk-review\n---\n\nold\n", env, "hunk-review");

    expect(detectSkill(HUNK_SHIPPED, env, "hunk-review")).toBe("stale");
    const outcome = installSkillTo(HUNK_SHIPPED, env, "hunk-review");
    expect(outcome.wrote).toBe(true);
    expect(readFileSync(skillTarget(env, "hunk-review"), "utf-8")).toBe(HUNK_SHIPPED);
  });

  test("installedSkillPaths reports both, so uninstall removes both", () => {
    const env = envWith(scratch());
    installSkillTo(SHIPPED, env);
    installSkillTo(HUNK_SHIPPED, env, "hunk-review");

    const paths = installedSkillPaths(env);
    expect(paths).toContain(skillTarget(env));
    expect(paths).toContain(skillTarget(env, "hunk-review"));
  });

  test("only what is actually installed is reported", () => {
    const env = envWith(scratch());
    installSkillTo(SHIPPED, env);

    const paths = installedSkillPaths(env);
    expect(paths).toContain(skillTarget(env));
    expect(paths).not.toContain(skillTarget(env, "hunk-review"));
  });
});

describe("installSkills", () => {
  // The defect this exists to prevent: installSkill() prints with console.log,
  // which is right for the CLI and lands directly on the rendered frame when
  // the TUI calls it. Nothing reachable from a modal may write to stdout.
  test("writes nothing to stdout or stderr", () => {
    const logged: string[] = [];
    const origLog = console.log;
    const origWrite = process.stdout.write;
    const origErr = process.stderr.write;
    console.log = (...a: unknown[]) => { logged.push(a.join(" ")); };
    process.stdout.write = ((s: string) => { logged.push(String(s)); return true; }) as typeof process.stdout.write;
    process.stderr.write = ((s: string) => { logged.push(String(s)); return true; }) as typeof process.stderr.write;
    try {
      installSkills(envWith(scratch()));
    } finally {
      console.log = origLog;
      process.stdout.write = origWrite;
      process.stderr.write = origErr;
    }
    expect(logged).toEqual([]);
  });

  test("reports one entry per skill, in the InstallReport shape", () => {
    const reports = installSkills(envWith(scratch()));
    expect(reports.map((r) => r.label)).toEqual(["jmux-control skill", "hunk-review skill"]);
    for (const report of reports) {
      expect(["installed", "migrated", "noop", "skipped", "failed"]).toContain(report.kind);
      expect(Array.isArray(report.notes)).toBe(true);
    }
  });

  test("installs jmux's skill into the env it is given", () => {
    const dir = scratch();
    const reports = installSkills(envWith(dir));
    expect(reports[0]!.kind).toBe("installed");
    expect(readFileSync(skillTarget(envWith(dir)), "utf-8").length).toBeGreaterThan(0);
  });

  test("a second run is a noop rather than a rewrite", () => {
    const dir = scratch();
    installSkills(envWith(dir));
    expect(installSkills(envWith(dir))[0]!.kind).toBe("noop");
  });

  test("a missing hunk is skipped, never failed — it is an optional dependency", () => {
    const reports = installSkills(envWith(scratch()), "definitely-not-a-real-binary-xyz");
    const hunk = reports.find((r) => r.label === "hunk-review skill")!;
    expect(hunk.kind).toBe("skipped");
    expect(hunk.notes.join(" ")).toContain("hunk not installed");
  });
});

describe("hunkSkillSource", () => {
  // hunk is an optional dependency: no hunk is a normal outcome the install
  // path reports and shrugs off, not an error.
  test("a missing hunk yields null rather than throwing", () => {
    expect(hunkSkillSource("definitely-not-a-real-binary-xyz")).toBeNull();
  });

  test("a real hunk yields its skill with jmux's addendum appended", () => {
    const real = hunkSkillSource();
    if (real === null) return; // hunk isn't installed on this machine
    expect(real).toContain("name: hunk-review");
    expect(real).toContain("Inside jmux");
    expect(real).toContain("Ctrl-a g");
  });
});
