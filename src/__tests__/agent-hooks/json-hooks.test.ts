import { describe, test, expect } from "bun:test";
import { buildHookBlock, hookCommands } from "../../agent-hooks/commands";
import { detectInstalledKind, installHooks } from "../../agent-hooks/json-hooks";
import { CLAUDE_EVENTS } from "../../agent-hooks/claude";
import { CODEX_EVENTS } from "../../agent-hooks/codex";
import type { HookEntry, HookSettings } from "../../agent-hooks/types";

const EVENTS = CLAUDE_EVENTS;

function commandsIn(entries: HookEntry[] | undefined): string[] {
  return (entries ?? []).flatMap((e) => e.hooks.map((h) => h.command));
}

describe("buildHookBlock", () => {
  test("returns the five-hook spec", () => {
    const block = buildHookBlock("claude", EVENTS);
    expect(Object.keys(block).sort()).toEqual([
      "PermissionRequest",
      "PreToolUse",
      "SessionEnd",
      "Stop",
      "UserPromptSubmit",
    ]);
  });

  test("every state-writing hook sets state, since and kind together", () => {
    const block = buildHookBlock("claude", EVENTS);
    for (const event of ["UserPromptSubmit", "PermissionRequest", "Stop"] as const) {
      const cmd = block[event][0].hooks[0].command;
      expect(cmd).toContain("@jmux-agent-state");
      expect(cmd).toContain("@jmux-agent-state-since");
      expect(cmd).toContain("@jmux-agent-kind claude");
    }
  });

  test("state writes are pane-scoped, so split agents cannot clobber each other", () => {
    const block = buildHookBlock("codex", EVENTS);
    const cmd = block.UserPromptSubmit[0].hooks[0].command;
    expect(cmd).toContain('set-option -p -t "$TMUX_PANE" @jmux-agent-state running');
  });

  test("all writes ride one tmux invocation", () => {
    // Cost matters: PreToolUse fires per tool call and Codex runs hooks through
    // a login shell. Four `tmux` processes per fire would be four fork+execs.
    const cmd = buildHookBlock("claude", EVENTS).Stop[0].hooks[0].command;
    expect(cmd.match(/(^|[^-])\btmux /g)?.length).toBe(1);
    expect(cmd).toContain("\\;");
  });

  test("@jmux-agent-pane stays session-scoped for `ctl agent state`", () => {
    const cmd = buildHookBlock("claude", EVENTS).Stop[0].hooks[0].command;
    expect(cmd).toContain('set-option -t "$TMUX_PANE" @jmux-agent-pane "$TMUX_PANE"');
  });

  test("PreToolUse is idempotent and reads without inheriting", () => {
    const cmd = buildHookBlock("claude", EVENTS).PreToolUse[0].hooks[0].command;
    // `show-option -p` does NOT fall back to the session value, unlike a format
    // expansion. That is what lets a legacy session-scoped install promote
    // itself to pane scope on the first tool call.
    expect(cmd).toContain('show-option -p -t "$TMUX_PANE" -qv @jmux-agent-state');
    expect(cmd).toContain('= "running" ] ||');
  });

  test("SessionEnd unsets rather than writing a terminal state", () => {
    const cmd = buildHookBlock("claude", EVENTS).SessionEnd[0].hooks[0].command;
    expect(cmd).toContain("set-option -pu");
    expect(cmd).toContain("@jmux-agent-kind");
    expect(cmd).not.toContain("complete");
  });

  test("kind is baked per agent", () => {
    expect(hookCommands("codex").Stop).toContain("@jmux-agent-kind codex");
    expect(hookCommands("pi").Stop).toContain("@jmux-agent-kind pi");
  });
});

describe("detectInstalledKind", () => {
  test("empty settings → none", () => {
    expect(detectInstalledKind({}, "claude", EVENTS)).toBe("none");
    expect(detectInstalledKind({ hooks: {} }, "claude", EVENTS)).toBe("none");
  });

  test("legacy @jmux-attention Stop hook → legacy", () => {
    const settings: HookSettings = {
      hooks: {
        Stop: [
          {
            hooks: [
              { type: "command", command: "tmux set-option @jmux-attention 1 2>/dev/null || true", timeout: 5 },
            ],
          },
        ],
      },
    };
    expect(detectInstalledKind(settings, "claude", EVENTS)).toBe("legacy");
  });

  test("freshly built block → current", () => {
    const settings = { hooks: buildHookBlock("claude", EVENTS) };
    expect(detectInstalledKind(settings, "claude", EVENTS)).toBe("current");
  });

  test("partial install → partial", () => {
    const block = buildHookBlock("claude", EVENTS);
    const settings = { hooks: { Stop: block.Stop, UserPromptSubmit: block.UserPromptSubmit } };
    expect(detectInstalledKind(settings, "claude", EVENTS)).toBe("partial");
  });

  test("a stale session-scoped jmux hook reads as partial, not current", () => {
    // The upgrade case that matters: right marker, outdated command text. If
    // this returned `current` the user would keep an emitter writing into the
    // wrong scope forever, with no way to notice.
    const block = buildHookBlock("claude", EVENTS);
    const stale = structuredClone(block) as Record<string, HookEntry[]>;
    stale.Stop[0].hooks[0].command =
      "tmux set-option @jmux-agent-state complete 2>/dev/null || true";
    expect(detectInstalledKind({ hooks: stale }, "claude", EVENTS)).toBe("partial");
  });

  test("a block built for another agent is not current for this one", () => {
    const settings = { hooks: buildHookBlock("codex", CODEX_EVENTS) };
    expect(detectInstalledKind(settings, "claude", EVENTS)).toBe("partial");
  });
});

describe("installHooks", () => {
  test("none → installs every event", () => {
    const out = installHooks({}, "claude", EVENTS);
    expect(out.kind).toBe("installed");
    expect(detectInstalledKind(out.settings, "claude", EVENTS)).toBe("current");
  });

  test("legacy → migrates, dropping the legacy entry", () => {
    const settings: HookSettings = {
      hooks: {
        Stop: [
          {
            hooks: [
              { type: "command", command: "tmux set-option @jmux-attention 1 2>/dev/null || true", timeout: 5 },
            ],
          },
        ],
      },
    };
    const out = installHooks(settings, "claude", EVENTS);
    expect(out.kind).toBe("migrated");
    expect(detectInstalledKind(out.settings, "claude", EVENTS)).toBe("current");
    expect(commandsIn(out.settings.hooks!.Stop).some((c) => c.includes("@jmux-attention"))).toBe(false);
  });

  test("current → noop, settings untouched", () => {
    const settings = { hooks: buildHookBlock("claude", EVENTS) };
    const out = installHooks(settings, "claude", EVENTS);
    expect(out.kind).toBe("noop");
    expect(out.settings).toEqual(settings);
  });

  test("stale jmux hook is replaced, not duplicated", () => {
    const stale = structuredClone(buildHookBlock("claude", EVENTS)) as Record<string, HookEntry[]>;
    stale.Stop[0].hooks[0].command = "tmux set-option @jmux-agent-state complete || true";
    const out = installHooks({ hooks: stale }, "claude", EVENTS);
    expect(detectInstalledKind(out.settings, "claude", EVENTS)).toBe("current");
    expect(commandsIn(out.settings.hooks!.Stop)).toHaveLength(1);
  });

  test("preserves unrelated entries and unrelated top-level keys", () => {
    const unrelated = { hooks: [{ type: "command" as const, command: "echo hi", timeout: 5 }] };
    const settings: HookSettings = { model: "opus", hooks: { Stop: [unrelated] } };
    const out = installHooks(settings, "claude", EVENTS);
    expect(out.settings.model).toBe("opus");
    expect(out.settings.hooks!.Stop).toContainEqual(unrelated);
    expect(commandsIn(out.settings.hooks!.Stop).some((c) => c.includes("@jmux-agent-state"))).toBe(true);
  });

  test("does not mutate the caller's settings", () => {
    const settings: HookSettings = { hooks: {} };
    installHooks(settings, "claude", EVENTS);
    expect(settings.hooks).toEqual({});
  });

  test("Codex installs the same event set under its own kind", () => {
    const out = installHooks({}, "codex", CODEX_EVENTS);
    expect(detectInstalledKind(out.settings, "codex", CODEX_EVENTS)).toBe("current");
    expect(commandsIn(out.settings.hooks!.Stop)[0]).toContain("@jmux-agent-kind codex");
  });
});

describe("UserPromptSubmit prompt capture", () => {
  const cmd = hookCommands("claude").UserPromptSubmit;

  test("writes the agent state before it reads stdin", () => {
    const stateAt = cmd.indexOf("@jmux-agent-state running");
    const captureAt = cmd.indexOf("@jmux-prompt");
    expect(stateAt).toBeGreaterThanOrEqual(0);
    expect(captureAt).toBeGreaterThan(stateAt);
  });

  test("the state write precedes the stdin read specifically", () => {
    expect(cmd.indexOf("@jmux-agent-state running"))
      .toBeLessThan(cmd.indexOf("head -c 4000"));
  });

  test("is gated on the capture switch, so an unconfigured user stores nothing", () => {
    expect(cmd).toContain("@jmux-title-capture");
  });

  test("is gated on the prompt being unset, so it stores the first prompt not the latest", () => {
    expect(cmd).toContain("show-option -p");
    expect(cmd).toContain("@jmux-prompt");
  });

  test("truncates what it stores, at the size we chose", () => {
    expect(cmd).toContain("head -c 4000");
  });

  test("can never fail the hook", () => {
    expect(cmd.trimEnd().endsWith("|| true")).toBe(true);
  });

  test("still carries the marker the installer detects jmux hooks by", () => {
    expect(cmd).toContain("@jmux-agent-state");
  });
});

describe("detectInstalledKind / hook timeout", () => {
  test("a stale timeout is partial, not current", () => {
    // Regression: detection compared command text only, so the SessionEnd
    // timeout fix (Codex caps it at 3s and warns above that) could never reach
    // an existing install — it reported "already up to date" forever.
    const block = structuredClone(buildHookBlock("codex", CODEX_EVENTS)) as Record<string, HookEntry[]>;
    block.SessionEnd[0].hooks[0].timeout = 5;
    expect(detectInstalledKind({ hooks: block }, "codex", CODEX_EVENTS)).toBe("partial");
  });

  test("installing over a stale timeout rewrites it to the shipped value", () => {
    const stale = structuredClone(buildHookBlock("codex", CODEX_EVENTS)) as Record<string, HookEntry[]>;
    stale.SessionEnd[0].hooks[0].timeout = 5;
    const out = installHooks({ hooks: stale }, "codex", CODEX_EVENTS);
    expect(out.kind).toBe("installed");
    expect(out.settings.hooks!.SessionEnd![0].hooks[0].timeout).toBe(3);
    expect(detectInstalledKind(out.settings, "codex", CODEX_EVENTS)).toBe("current");
  });

  test("SessionEnd ships at 3s, other events at 5s", () => {
    const block = buildHookBlock("codex", CODEX_EVENTS);
    expect(block.SessionEnd[0].hooks[0].timeout).toBe(3);
    expect(block.Stop[0].hooks[0].timeout).toBe(5);
  });
});
