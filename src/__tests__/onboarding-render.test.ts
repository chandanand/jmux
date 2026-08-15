import { describe, expect, test } from "bun:test";
import { cellWidth, textCols } from "../cell-grid";
import type { CellGrid } from "../types";
import { deriveStatus, type SetupFacts } from "../onboarding/status";
import { OnboardingFlow } from "../onboarding/flow";
import { renderFlow, wrapProse, GLYPHS, BOTTOM_RESERVED_ROWS } from "../onboarding/render";

const facts: SetupFacts = {
  agentsPresent: ["Claude Code"], agentsStale: ["Claude Code"], skillCurrent: false,
  namingConfigured: false, namingDeclined: false, namingAvailable: ["claude"],
  trackerType: "linear", trackerAuthed: false, trackerDeclined: false,
  projectCount: 0, attachedTeamCount: 0, workflowTabCount: 0, hunkInstalled: false,
};

const flow = (f: Partial<SetupFacts> = {}) => new OnboardingFlow(deriveStatus({ ...facts, ...f }));
const lines = (g: CellGrid): string[] => g.cells.map((r) => r.map((c) => c.char).join(""));
const text = (g: CellGrid): string => lines(g).join("\n");

describe("glyphs", () => {
  // A glyph the column model scores differently from the real cursor shears
  // every cell after it on the row. This is the check that keeps that class of
  // bug out before anything reaches a CellGrid.
  test("every glyph the surface paints is exactly one column wide", () => {
    for (const glyph of GLYPHS) {
      expect([glyph, cellWidth(glyph.codePointAt(0)!)]).toEqual([glyph, 1]);
      expect([glyph, textCols(glyph)]).toEqual([glyph, 1]);
    }
  });
});

describe("wrapProse", () => {
  test("caps at the measure even on a very wide terminal", () => {
    const long = "word ".repeat(120).trim();
    for (const line of wrapProse(long, 400)) {
      expect(textCols(line)).toBeLessThanOrEqual(64);
    }
  });

  test("never splits a word", () => {
    expect(wrapProse("alpha beta gamma", 11)).toEqual(["alpha beta", "gamma"]);
  });

  test("an empty paragraph is one empty line, not nothing", () => {
    expect(wrapProse("", 40)).toEqual([""]);
  });

  test("a word longer than the measure is emitted rather than dropped", () => {
    const word = "x".repeat(90);
    expect(wrapProse(word, 40)).toEqual([word]);
  });
});

describe("renderFlow — geometry", () => {
  test("the grid is exactly the requested size", () => {
    const grid = renderFlow(flow(), 80, 24);
    expect(grid.rows).toBe(24);
    expect(grid.cols).toBe(80);
    expect(grid.cells.length).toBe(24);
    for (const row of grid.cells) expect(row.length).toBe(80);
  });

  test("no row overflows, at any width, on any page", () => {
    const f = flow();
    f.chooseIntent("tracker");
    for (let step = 0; step < 6; step++) {
      for (const w of [40, 52, 61, 80, 120, 200]) {
        const grid = renderFlow(f, w, 24);
        for (const row of grid.cells) expect(row.length).toBe(w);
      }
      f.next();
    }
  });

  test("survives a terminal too short to hold the content", () => {
    const f = flow();
    f.chooseIntent("solo");
    for (const h of [4, 6, 8, 12]) {
      const grid = renderFlow(f, 80, h);
      expect(grid.cells.length).toBe(h);
    }
  });

  // Shared by the painter and anything clamping content: a hint line that
  // moved as the cursor travelled would cost more than the row it saved.
  test("the action bar is on the last row whatever the height", () => {
    const f = flow();
    f.chooseIntent("solo");
    for (const h of [14, 20, 24, 50]) {
      const painted = lines(renderFlow(f, 80, h));
      expect(painted[h - 1]).toContain("next");
      expect(painted[h - BOTTOM_RESERVED_ROWS]).toContain("─");
    }
  });
});

describe("renderFlow — pages", () => {
  test("welcome offers all three intents with their costs", () => {
    const out = text(renderFlow(flow(), 90, 26));
    expect(out).toContain("Just run agents");
    expect(out).toContain("Agents, wired to my issue tracker");
    expect(out).toContain("I'll do it myself");
    expect(out).toContain("3 steps, about a minute");
  });

  test("the intent cursor marks the selected row", () => {
    const f = flow();
    const first = lines(renderFlow(f, 90, 26)).findIndex((l) => l.includes("▸"));
    f.moveIntent(1);
    const second = lines(renderFlow(f, 90, 26)).findIndex((l) => l.includes("▸"));
    expect(second).toBeGreaterThan(first);
  });

  test("the page title and step label both appear", () => {
    const f = flow();
    f.chooseIntent("solo");
    const out = text(renderFlow(f, 90, 26));
    expect(out).toContain("Where your code lives");
    expect(out).toContain("Step 1 of 3");
  });

  test("welcome carries no step label", () => {
    expect(text(renderFlow(flow(), 90, 26))).not.toContain("Step 1 of");
  });

  test("the projects page says so when nothing is configured", () => {
    const f = flow();
    f.chooseIntent("solo");
    expect(text(renderFlow(f, 90, 26, { projectDirs: [] }))).toContain("Nothing yet.");
  });

  test("the projects page lists configured directories", () => {
    const f = flow();
    f.chooseIntent("solo");
    const out = text(renderFlow(f, 90, 26, { projectDirs: ["~/Code/personal", "~/work"] }));
    expect(out).toContain("~/Code/personal");
    expect(out).toContain("~/work");
  });

  test("the agents page renders its write list from the targets it is given", () => {
    const f = flow();
    f.chooseIntent("solo");
    f.openStep("agents");
    const out = text(renderFlow(f, 90, 30, {
      writeTargets: ["/custom/claude/settings.json", "/custom/codex/config.toml"],
    }));
    expect(out).toContain("Will write to");
    expect(out).toContain("/custom/claude/settings.json");
    expect(out).toContain("/custom/codex/config.toml");
  });

  test("no agents reads as honest, not as a failure", () => {
    const f = flow({ agentsPresent: [], agentsStale: [] });
    f.chooseIntent("solo");
    f.openStep("agents");
    const out = text(renderFlow(f, 90, 26));
    expect(out).toContain("No coding agents found");
    expect(out).toContain("jmux works fine without one");
  });

  // Every one of these strings is text that lands raw on the frame today.
  test("install results render as a table, not as printed output", () => {
    const f = flow();
    f.chooseIntent("solo");
    f.openStep("agents");
    const out = text(renderFlow(f, 90, 30, {
      reports: [
        { label: "Claude Code", kind: "installed", notes: [] },
        { label: "hunk-review skill", kind: "skipped", notes: ["hunk not installed"] },
      ],
    }));
    expect(out).toContain("Claude Code");
    expect(out).toContain("set up");
    expect(out).toContain("hunk not installed");
  });

  test("the finish page ticks what was achieved", () => {
    const f = flow();
    f.chooseIntent("solo");
    for (let i = 0; i < 10; i++) f.next();
    const out = text(renderFlow(f, 90, 26, { achievements: ["Two projects — jmux, hunk"] }));
    expect(out).toContain("You're set up");
    expect(out).toContain("Two projects — jmux, hunk");
    expect(out).toContain("✓");
  });

  test("a busy action says so", () => {
    const f = flow();
    f.chooseIntent("tracker");
    f.openStep("tracker");
    expect(text(renderFlow(f, 90, 26, { busy: "checking…" }))).toContain("checking…");
  });
});

describe("renderFlow — the map", () => {
  test("lists every step with a word rather than a bare glyph", () => {
    const f = flow({ projectCount: 2 });
    f.chooseIntent("solo");
    f.zoomOut();
    const out = text(renderFlow(f, 90, 26));
    expect(out).toContain("Where your code lives");
    expect(out).toContain("2 projects");
    expect(out).toContain("Letting jmux see your agents");
  });

  test("an unavailable step still says what it is waiting for", () => {
    const f = flow();
    f.chooseIntent("solo");
    f.zoomOut();
    expect(text(renderFlow(f, 90, 26))).toContain("needs a tracker");
  });

  test("only satisfied rows carry a tick", () => {
    const f = flow({ projectCount: 0 });
    f.chooseIntent("solo");
    f.zoomOut();
    const projectRow = lines(renderFlow(f, 90, 26))
      .find((l) => l.includes("Where your code lives"))!;
    expect(projectRow).not.toContain("✓");
  });
});

describe("renderFlow — the finish page teaches the keys", () => {
  const done = () => {
    const f = flow();
    f.chooseIntent("solo");
    for (let i = 0; i < 10; i++) f.next();   // to the end, however long it is
    return f;
  };

  // A finish that only ticks boxes has said nothing about what to do next, and
  // this is the last moment anyone is reading.
  test("names three keys and what they do", () => {
    const out = text(renderFlow(done(), 90, 30, { achievements: ["Two projects ready"] }));
    expect(out).toContain("Three things worth knowing");
    expect(out).toContain("Ctrl-Space n");
    expect(out).toContain("start a new piece of work");
    expect(out).toContain("Ctrl-Space p");
    expect(out).toContain("Ctrl-Space ?");
  });

  test("drops the keys rather than overrunning a short terminal", () => {
    const grid = renderFlow(done(), 90, 12, {
      achievements: ["a", "b", "c", "d", "e", "f"],
    });
    expect(grid.cells.length).toBe(12);
    for (const row of grid.cells) expect(row.length).toBe(90);
  });
});

describe("renderFlow — the action bar follows the page's state", () => {
  // "set these up" after installing invites a press that would only repeat
  // work already done.
  test("the agents hint changes once the install has run", () => {
    const f = flow();
    f.chooseIntent("solo");
    f.openStep("agents");
    const before = lines(renderFlow(f, 90, 26)).at(-1)!;
    expect(before).toContain("set these up");

    const after = lines(renderFlow(f, 90, 26, {
      reports: [{ label: "Claude Code", kind: "installed", notes: [] }],
    })).at(-1)!;
    expect(after).not.toContain("set these up");
    expect(after).toContain("next");
  });
});

describe("renderFlow — the map has a visible cursor", () => {
  const onMap = () => {
    const f = flow();
    f.chooseIntent("solo");
    f.zoomOut();
    return f;
  };

  // ↑↓ that move a cursor nobody can see, and an Enter that then opens a step
  // the user did not knowingly choose.
  test("marks the row the cursor is on", () => {
    const first = lines(renderFlow(onMap(), 90, 26, { mapIndex: 0 }))
      .findIndex((l) => l.includes("▸"));
    const third = lines(renderFlow(onMap(), 90, 26, { mapIndex: 2 }))
      .findIndex((l) => l.includes("▸"));
    expect(first).toBeGreaterThan(0);
    expect(third).toBe(first + 2);
  });

  test("the marked row is the one the label sits on", () => {
    const painted = lines(renderFlow(onMap(), 90, 26, { mapIndex: 1 }));
    const marked = painted.find((l) => l.includes("▸"))!;
    expect(marked).toContain("Letting jmux see your agents");
  });

  test("lists all five steps, including ones outside the current arm", () => {
    const out = text(renderFlow(onMap(), 90, 26, { mapIndex: 0 }));
    expect(out).toContain("Connect an issue tracker");
    expect(out).toContain("Point a project at a team");
    expect(out).toContain("How your work moves");
  });
});

describe("no page advertises an action it cannot perform", () => {
  // A key that silently does nothing is indistinguishable from a key that is
  // broken. suggestLayout over an empty status list returns its input
  // untouched, so "use these" with no tracker would look like it worked.
  test("the workflow page drops its Enter hint when there is no tracker", () => {
    const f = flow({ trackerAuthed: false });
    f.chooseIntent("tracker");
    f.openStep("workflow");
    const bar = lines(renderFlow(f, 90, 26)).at(-1)!;
    expect(bar).not.toContain("use these");
  });

  test("and keeps it once a tracker is connected", () => {
    const f = flow({ trackerAuthed: true, trackerType: "linear" });
    f.chooseIntent("tracker");
    f.openStep("workflow");
    expect(lines(renderFlow(f, 90, 26)).at(-1)!).toContain("use these");
  });

  test("the workflow page says why there is nothing to group", () => {
    const f = flow({ trackerAuthed: false });
    f.chooseIntent("tracker");
    f.openStep("workflow");
    expect(text(renderFlow(f, 90, 26))).toContain("needs a tracker connected first");
  });

  test("the team page says why there is nothing to route", () => {
    const f = flow({ trackerAuthed: false });
    f.chooseIntent("tracker");
    f.openStep("team");
    expect(text(renderFlow(f, 90, 26))).toContain("needs a tracker connected first");
  });

  test("both read normally once a tracker is connected", () => {
    const f = flow({ trackerAuthed: true, trackerType: "linear" });
    f.chooseIntent("tracker");
    f.openStep("team");
    const out = text(renderFlow(f, 90, 26));
    expect(out).toContain("An issue has to become a branch");
    expect(out).not.toContain("needs a tracker connected first");
  });
});

describe("the naming step", () => {
  const naming = (f: Partial<SetupFacts> = {}) => {
    const fl = flow(f);
    fl.chooseIntent("solo");
    fl.openStep("naming");
    return fl;
  };

  test("is a step on both arms, and the counts say so", () => {
    const solo = flow(); solo.chooseIntent("solo"); solo.openStep("naming");
    expect(solo.stepLabel()).toBe("Step 3 of 3");
    const tr = flow(); tr.chooseIntent("tracker"); tr.openStep("naming");
    expect(tr.stepLabel()).toBe("Step 3 of 6");
  });

  test("lists the commands that will actually run here", () => {
    const out = text(renderFlow(naming(), 90, 26, {
      namingOptions: [
        { id: "claude", label: "claude", note: "Around 11s." },
        { id: "off", label: "Leave sessions unnamed", note: "the branch name" },
      ],
      namingChosen: "off",
    }));
    expect(out).toContain("claude");
    expect(out).toContain("Around 11s.");
    expect(out).toContain("Leave sessions unnamed");
  });

  test("ticks the one in force", () => {
    const painted = lines(renderFlow(naming(), 90, 26, {
      namingOptions: [
        { id: "claude", label: "claude", note: "Around 11s." },
        { id: "off", label: "Leave sessions unnamed", note: "the branch name" },
      ],
      namingChosen: "claude",
    }));
    const row = painted.find((l) => l.includes("claude"))!;
    expect(row).toContain("✓");
  });

  // The presets are the agent CLIs, so a machine with neither has nothing to
  // choose between — and must not advertise a key that opens an empty picker.
  test("says why there is nothing to choose, and drops its Enter hint", () => {
    const f = naming({ namingAvailable: [] });
    const out = text(renderFlow(f, 90, 26));
    expect(out).toContain("Nothing to name with yet");
    expect(lines(renderFlow(f, 90, 26)).at(-1)!).not.toContain("↵ choose");
  });
});

describe("the naming page ticks only a real choice", () => {
  const opts = [
    { id: "claude", label: "claude", note: "Around 11s." },
    { id: "off", label: "Leave sessions unnamed", note: "the branch name" },
  ];
  const naming = () => {
    const f = flow();
    f.chooseIntent("solo");
    f.openStep("naming");
    return f;
  };

  // presetForCommand(undefined) is "off", so ticking it directly showed
  // "leave sessions unnamed" as a deliberate choice on a step the map was
  // reporting as "not yet" — the same fact with two answers.
  test("nothing is ticked before the step is answered", () => {
    const painted = lines(renderFlow(naming(), 90, 26, {
      namingOptions: opts, namingChosen: "",
    }));
    for (const row of painted.filter((l) => l.includes("Leave sessions unnamed") || l.includes("claude"))) {
      expect(row).not.toContain("✓");
    }
  });

  test("declining explicitly does tick", () => {
    const painted = lines(renderFlow(naming(), 90, 26, {
      namingOptions: opts, namingChosen: "off",
    }));
    expect(painted.find((l) => l.includes("Leave sessions unnamed"))!).toContain("✓");
  });
});
