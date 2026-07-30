import { afterEach, describe, expect, test } from "bun:test";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";

import { claudeConfigDir, detectSkill, installSkillTo, skillTarget } from "../../agent-hooks/skill";

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
