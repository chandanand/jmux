import { describe, test, expect } from "bun:test";
import {
  BUILTIN_SIGNATURES,
  classifyPaneScreen,
  compileSignatures,
  hasSignatureFor,
  type ScreenSignature,
} from "../agent-screen";

const SIGS: ScreenSignature[] = [
  {
    command: "demoagent",
    waiting: ["Do you want to proceed\\?", "\\[y/n\\]"],
    running: ["esc to interrupt"],
    complete: ["Ask anything"],
  },
];

const compiled = compileSignatures(SIGS);

describe("classifyPaneScreen", () => {
  test("matches waiting", () => {
    expect(classifyPaneScreen("demoagent", "Do you want to proceed?", compiled)).toBe("waiting");
  });

  test("matches running", () => {
    expect(classifyPaneScreen("demoagent", "Thinking... (esc to interrupt)", compiled)).toBe("running");
  });

  test("matches complete", () => {
    expect(classifyPaneScreen("demoagent", "Ask anything...", compiled)).toBe("complete");
  });

  test("waiting outranks running and complete on a mixed screen", () => {
    const screen = "Ask anything...\nesc to interrupt\nDo you want to proceed?";
    expect(classifyPaneScreen("demoagent", screen, compiled)).toBe("waiting");
  });

  test("running outranks complete", () => {
    expect(classifyPaneScreen("demoagent", "Ask anything\nesc to interrupt", compiled)).toBe("running");
  });

  test("returns null when the command does not match any signature", () => {
    expect(classifyPaneScreen("vim", "Do you want to proceed?", compiled)).toBeNull();
  });

  test("returns null when nothing in the table matches the screen", () => {
    expect(classifyPaneScreen("demoagent", "just some output", compiled)).toBeNull();
  });

  test("empty command or screen classifies as nothing", () => {
    expect(classifyPaneScreen("", "Do you want to proceed?", compiled)).toBeNull();
    expect(classifyPaneScreen("demoagent", "", compiled)).toBeNull();
  });

  test("command matching is case-insensitive", () => {
    expect(classifyPaneScreen("DemoAgent", "Ask anything", compiled)).toBe("complete");
  });

  test("screen matching is case-insensitive", () => {
    expect(classifyPaneScreen("demoagent", "ASK ANYTHING", compiled)).toBe("complete");
  });
});

describe("compileSignatures", () => {
  test("drops an entry with no command", () => {
    expect(compileSignatures([{ command: "" }])).toHaveLength(0);
  });

  test("drops an entry whose command regex is invalid", () => {
    expect(compileSignatures([{ command: "(" }])).toHaveLength(0);
  });

  test("an invalid state pattern disables only itself", () => {
    // User config must not be able to crash startup with a stray paren.
    const out = compileSignatures([{ command: "x", waiting: ["(", "ok"] }]);
    expect(out).toHaveLength(1);
    expect(out[0].waiting).toHaveLength(1);
    expect(classifyPaneScreen("x", "ok", out)).toBe("waiting");
  });

  test("absent state lists compile to empty, not undefined", () => {
    const out = compileSignatures([{ command: "x" }]);
    expect(out[0].waiting).toEqual([]);
    expect(out[0].running).toEqual([]);
    expect(out[0].complete).toEqual([]);
  });

  test("earlier signatures win when two match the same command", () => {
    const out = compileSignatures([
      { command: "dup", complete: ["hit"] },
      { command: "dup", waiting: ["hit"] },
    ]);
    expect(classifyPaneScreen("dup", "hit", out)).toBe("complete");
  });
});

describe("BUILTIN_SIGNATURES", () => {
  const builtins = compileSignatures(BUILTIN_SIGNATURES);

  test("every built-in compiles", () => {
    expect(builtins).toHaveLength(BUILTIN_SIGNATURES.length);
  });

  test("detects opencode's idle composer from a real captured screen", () => {
    // Captured verbatim from `opencode` 1.17.6 sitting idle in a tmux pane.
    const screen = [
      "             ┃",
      '             ┃  Ask anything... "Fix a TODO in the codebase"',
      "             ┃",
      "             ┃  Build · GPT-5.5 OpenAI · high",
      "             ╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀",
      "                                     tab agents  ctrl+p commands",
      "",
      "  /private/tmp                                          1.17.6",
    ].join("\n");
    expect(classifyPaneScreen("opencode", screen, builtins)).toBe("complete");
  });

  test("does not claim a state for an unrelated program", () => {
    expect(classifyPaneScreen("zsh", "Ask anything...", builtins)).toBeNull();
  });
});

describe("hasSignatureFor", () => {
  const compiled2 = compileSignatures(SIGS);

  test("true only when a signature's command matches", () => {
    expect(hasSignatureFor("demoagent", compiled2)).toBe(true);
    expect(hasSignatureFor("vim", compiled2)).toBe(false);
  });

  test("empty command never matches", () => {
    // Guards the capture-skip path: no command means nothing to classify.
    expect(hasSignatureFor("", compiled2)).toBe(false);
  });

  test("case-insensitive, consistent with classifyPaneScreen", () => {
    expect(hasSignatureFor("DemoAgent", compiled2)).toBe(true);
  });

  test("an empty table matches nothing", () => {
    expect(hasSignatureFor("demoagent", [])).toBe(false);
  });

  test("agrees with classifyPaneScreen — never skips a pane that would classify", () => {
    // The whole point of the pre-filter is to skip only panes that could not
    // possibly produce a state. If this ever disagrees, panes go dark.
    for (const cmd of ["demoagent", "DEMOAGENT", "vim", "zsh", ""]) {
      const classified = classifyPaneScreen(cmd, "Do you want to proceed?", compiled2);
      if (classified !== null) expect(hasSignatureFor(cmd, compiled2)).toBe(true);
    }
  });
});

describe("compileSignatures / malformed user config", () => {
  // These come from hand-edited config.json and are compiled at module scope,
  // so any throw here is a boot failure with a raw stack trace. Every malformed
  // shape must degrade, never throw.
  const malformed: [string, unknown][] = [
    ["undefined", undefined],
    ["null", null],
    ["object instead of array", {}],
    ["number", 5],
    ["string", "codex"],
    ["array containing null", [null]],
    ["array containing undefined", [undefined]],
    ["array of strings", ["codex"]],
    ["array of numbers", [42]],
    ["entry with no command", [{ waiting: ["x"] }]],
    ["entry with non-string command", [{ command: 123 }]],
    ["entry with empty command", [{ command: "" }]],
    ["entry with non-array waiting", [{ command: "x", waiting: "oops" }]],
    ["entry with null waiting", [{ command: "x", waiting: null }]],
    ["entry with non-string patterns", [{ command: "x", waiting: [1, null, {}] }]],
  ];

  for (const [label, value] of malformed) {
    test(`does not throw on ${label}`, () => {
      expect(() => compileSignatures(value as never)).not.toThrow();
    });
  }

  test("non-array input compiles to an empty table", () => {
    expect(compileSignatures({} as never)).toEqual([]);
    expect(compileSignatures(5 as never)).toEqual([]);
    expect(compileSignatures(undefined as never)).toEqual([]);
  });

  test("one bad entry does not discard its valid siblings", () => {
    const out = compileSignatures([
      null,
      { command: "good", complete: ["hit"] },
      "junk",
    ] as never);
    expect(out).toHaveLength(1);
    expect(classifyPaneScreen("good", "hit", out)).toBe("complete");
  });

  test("a non-array pattern list is ignored, not iterated per character", () => {
    // "oops" is iterable — spreading it would compile o/o/p/s as four regexes
    // and match almost anything.
    const out = compileSignatures([{ command: "x", waiting: "oops" }] as never);
    expect(out[0].waiting).toEqual([]);
    expect(classifyPaneScreen("x", "o", out)).toBeNull();
  });
});
