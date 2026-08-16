import { describe, test, expect } from "bun:test";
import {
  TITLE_PRESETS, TITLE_OFF, TITLE_CUSTOM,
  presetForCommand, commandForPreset, titlePresetOptions, formatTitleCommand, parseTitleCommand,
} from "../session-title/presets";
import { resolveTitleConfig } from "../session-title/generator";

describe("presetForCommand", () => {
  test("no command configured reads as off — the whole off switch is an absent command", () => {
    expect(presetForCommand(undefined)).toBe(TITLE_OFF);
    expect(presetForCommand([])).toBe(TITLE_OFF);
  });

  test("a preset's own argv reads back as that preset", () => {
    for (const preset of TITLE_PRESETS) {
      expect(presetForCommand(preset.command)).toBe(preset.id);
    }
  });

  test("argv nobody ships reads as custom, never as a preset it does not equal", () => {
    expect(presetForCommand(["my-agent", "--fast"])).toBe(TITLE_CUSTOM);
  });

  test("a preset with one flag changed is custom, not the preset", () => {
    // Reporting the preset would let the row name a command that is not the
    // one being run — the row's whole job is saying which it is.
    const claude = TITLE_PRESETS.find((p) => p.id === "claude")!;
    expect(presetForCommand([...claude.command, "--verbose"])).toBe(TITLE_CUSTOM);
    expect(presetForCommand(claude.command.slice(0, -1))).toBe(TITLE_CUSTOM);
  });

  test("argv order is significant", () => {
    expect(presetForCommand(["codex", "exec"])).toBe(TITLE_CUSTOM);
    expect(presetForCommand(["exec", "codex"])).toBe(TITLE_CUSTOM);
  });
});

describe("commandForPreset", () => {
  test("off stores nothing at all", () => {
    expect(commandForPreset(TITLE_OFF)).toBe(undefined);
  });

  test("a preset stores its full argv, not its name", () => {
    // config.json keeps the shape resolveTitleConfig already validates, so
    // there is no migration and no second source of truth.
    const codex = commandForPreset("codex");
    expect(Array.isArray(codex)).toBe(true);
    expect(codex![0]).toBe("codex");
    expect(codex).toContain("--skip-git-repo-check");
  });

  test("custom stores nothing on its own — the editor supplies the argv", () => {
    expect(commandForPreset(TITLE_CUSTOM)).toBe(undefined);
  });
});

describe("round trip", () => {
  test("every preset survives store and read-back", () => {
    for (const preset of TITLE_PRESETS) {
      expect(presetForCommand(commandForPreset(preset.id))).toBe(preset.id);
    }
    expect(presetForCommand(commandForPreset(TITLE_OFF))).toBe(TITLE_OFF);
  });
});

describe("titlePresetOptions", () => {
  test("the ladder is off plus the presets — custom is not on it", () => {
    // ◂ ▸ must only ever land on a value that is now in force. Cycling onto
    // "custom…" would either pop a text editor mid-press or leave the row
    // naming an option that is not a setting.
    expect(titlePresetOptions(undefined)).toEqual([TITLE_OFF, "claude", "codex"]);
  });

  test("a stored custom command joins the ladder as a real rung", () => {
    const opts = titlePresetOptions(["my-agent", "--fast"]);
    expect(opts).toEqual([TITLE_OFF, "claude", "codex", TITLE_CUSTOM]);
  });

  test("a stored preset does not add a custom rung", () => {
    expect(titlePresetOptions(TITLE_PRESETS[0].command)).not.toContain(TITLE_CUSTOM);
  });
});

describe("formatTitleCommand / parseTitleCommand", () => {
  test("argv round-trips through the editor's single-line form", () => {
    const argv = ["claude", "-p", "--model", "haiku"];
    expect(parseTitleCommand(formatTitleCommand(argv))).toEqual(argv);
  });

  test("an empty string is not a command", () => {
    expect(parseTitleCommand("   ")).toBe(undefined);
  });

  test("runs of whitespace collapse rather than producing empty argv entries", () => {
    // Bun.spawn on an argv holding "" is a different failure from the one the
    // user typed, and resolveTitleConfig would accept the array as well-formed.
    expect(parseTitleCommand("claude   -p")).toEqual(["claude", "-p"]);
  });

  test("the empty-string argument a preset uses survives the round trip", () => {
    // `--tools ""` disables every tool. Splitting on spaces would drop it,
    // silently re-enabling file access for the naming subprocess.
    const argv = ["claude", "-p", "--tools", ""];
    expect(parseTitleCommand(formatTitleCommand(argv))).toEqual(argv);
  });
});

describe("shipped presets", () => {
  test("every preset passes the title command validator", () => {
    for (const preset of TITLE_PRESETS) {
      const warnings: string[] = [];
      const resolved = resolveTitleConfig(
        { command: [...preset.command] },
        (message) => warnings.push(message),
        (command) => `/usr/bin/${command}`,
      );
      expect(resolved?.command).toEqual(preset.command);
      expect(warnings).toEqual([]);
    }
  });

  test("codex skips the git repo check, because the runner's cwd is tmpdir", () => {
    // titleRunnerCwd() returns tmpdir(), which is not a repository, and codex
    // refuses to run in one without this flag.
    const codex = TITLE_PRESETS.find((p) => p.id === "codex")!;
    expect(codex.command).toContain("--skip-git-repo-check");
  });

  test("every preset reads its prompt from stdin rather than argv", () => {
    // The generator writes the prompt to stdin; a preset that expected it as
    // an argument would name every session after an empty prompt.
    for (const preset of TITLE_PRESETS) {
      expect(preset.command.join(" ")).not.toContain("{prompt}");
    }
  });
});
