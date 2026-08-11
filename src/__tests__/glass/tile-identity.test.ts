import { describe, test, expect } from "bun:test";
import { GlassView, type GlassTileSpec, type GlassViewOptions, type TilePty } from "../../glass/view";
import { resolveDisplayedRepresentative } from "../../glass/view";
import type { PaneRow } from "../../glass/representative";
import type { AgentState } from "../../types";

// ── Harness ──────────────────────────────────────────────────────────────────
// GlassView needs a live tmux server for exactly one thing — attaching a mirror
// client — so the pty is injected and the tmux side is a recording runner.

class FakePty implements TilePty {
  killed = false;
  writes: string[] = [];
  sizes: [number, number][] = [];
  write(data: string): void { this.writes.push(data); }
  resize(cols: number, rows: number): void { this.sizes.push([cols, rows]); }
  kill(): void { this.killed = true; }
  onData(): void { /* nothing ever arrives in a unit test */ }
}

interface WindowFacts { windowId: string; paneCount: number; zoomed: boolean }

function makeView(options: {
  windows?: Record<string, WindowFacts>;
  opts?: Partial<GlassViewOptions>;
} = {}) {
  const commands: string[][] = [];
  const ptys: { session: string; pty: FakePty }[] = [];
  const windows = options.windows ?? {};

  const view = new GlassView({
    runner: (args) => {
      commands.push(args);
      if (args[0] === "display-message") {
        const facts = windows[args[3] ?? ""] ?? { windowId: "@1", paneCount: 1, zoomed: false };
        return { ok: true, lines: [`${facts.windowId} ${facts.paneCount} ${facts.zoomed ? "1" : "0"}`] };
      }
      return { ok: true, lines: [] };
    },
    minTileWidth: 20,
    minTileHeight: 5,
    onFrame: () => {},
    spawnPty: (o) => {
      const pty = new FakePty();
      ptys.push({ session: o.sessionName ?? "", pty });
      return pty;
    },
    ...options.opts,
  });
  view.resize(80, 24);
  return { view, commands, ptys, clear: () => { commands.length = 0; } };
}

const spec = (over: Partial<GlassTileSpec> & { sessionId: string }): GlassTileSpec => ({
  paneId: `%${over.sessionId.replace("$", "")}`,
  windowId: "@1",
  label: over.sessionId,
  tabId: "default",
  ...over,
});

const pane = (paneId: string, over: Partial<PaneRow> = {}): PaneRow => ({
  paneId,
  kind: "claude",
  command: "claude",
  forcedOn: false,
  sessionActive: false,
  state: null,
  since: null,
  ...over,
});

// ── Identity ─────────────────────────────────────────────────────────────────

describe("a tile is a session", () => {
  test("two panes of one session are one tile, not two", () => {
    const { view, ptys } = makeView();
    view.setTiles([
      spec({ sessionId: "$1", paneId: "%1" }),
      spec({ sessionId: "$1", paneId: "%2" }),
      spec({ sessionId: "$2", paneId: "%3" }),
    ], "default");

    expect(ptys.map((p) => p.session)).toEqual(["$1", "$2"]);
    // The first spec in membership order supplies the face.
    expect(view.focusedSessionId()).toBe("$1");
    expect(view.focusedPaneId()).toBe("%1");
  });

  test("focus is a key, so it survives the set reordering", () => {
    const { view } = makeView();
    const a = spec({ sessionId: "$1" });
    const b = spec({ sessionId: "$2" });
    const c = spec({ sessionId: "$3" });
    view.setTiles([a, b, c], "default");
    view.moveFocus("right");
    expect(view.focusedSessionId()).toBe("$2");

    // A waiting agent sorts to the front: the same tile must stay focused.
    view.setTiles([b, c, a], "default");
    expect(view.focusedSessionId()).toBe("$2");
  });

  test("a vanished tile hands focus to its successor", () => {
    const { view } = makeView();
    const a = spec({ sessionId: "$1" });
    const b = spec({ sessionId: "$2" });
    const c = spec({ sessionId: "$3" });
    view.setTiles([a, b, c], "default");
    view.moveFocus("right");
    expect(view.focusedSessionId()).toBe("$2");

    view.setTiles([a, c], "default");
    expect(view.focusedSessionId()).toBe("$3"); // the successor, at the same index

    view.setTiles([a], "default");
    expect(view.focusedSessionId()).toBe("$1"); // nothing after it: the last survivor

    view.setTiles([], "default");
    expect(view.focusedSessionId()).toBeNull();
  });
});

// ── Retarget ─────────────────────────────────────────────────────────────────

describe("retarget", () => {
  const windows: Record<string, WindowFacts> = {
    "%1": { windowId: "@1", paneCount: 2, zoomed: false },
    "%2": { windowId: "@2", paneCount: 2, zoomed: false },
  };

  test("gives the old window back before selecting the new one", () => {
    const { view, commands, ptys, clear } = makeView({ windows });
    view.setTiles([spec({ sessionId: "$1", paneId: "%1" })], "default");
    expect(commands).toEqual([
      ["display-message", "-p", "-t", "%1", "#{window_id} #{window_panes} #{window_zoomed_flag}"],
      ["select-window", "-t", "$1:@1"],
      ["resize-pane", "-Z", "-t", "%1"],
    ]);
    clear();

    // The face moves to a pane in another window of the same session.
    view.setTiles([spec({ sessionId: "$1", paneId: "%2" })], "default");

    expect(commands).toEqual([
      // Unzoom first: after select-window this would give back a window the
      // session is no longer looking at, and leave the new one unzoomed too.
      ["resize-pane", "-Z", "-t", "%1"],
      ["display-message", "-p", "-t", "%2", "#{window_id} #{window_panes} #{window_zoomed_flag}"],
      ["select-window", "-t", "$1:@2"],
      ["resize-pane", "-Z", "-t", "%2"],
    ]);
    expect(view.focusedPaneId()).toBe("%2");
  });

  test("keeps the client, the pty and the bridge", () => {
    const { view, ptys } = makeView({ windows });
    view.setTiles([spec({ sessionId: "$1", paneId: "%1" })], "default");
    view.setTiles([spec({ sessionId: "$1", paneId: "%2" })], "default");

    expect(ptys).toHaveLength(1);
    expect(ptys[0]!.pty.killed).toBe(false);
  });

  test("teardown undoes the zoom the tile ended with, not the one it started with", () => {
    const { view, commands, clear } = makeView({ windows });
    view.setTiles([spec({ sessionId: "$1", paneId: "%1" })], "default");
    view.setTiles([spec({ sessionId: "$1", paneId: "%2" })], "default");
    clear();

    view.teardown();
    expect(commands).toEqual([["resize-pane", "-Z", "-t", "%2"]]);
  });

  test("a window it never zoomed is never unzoomed", () => {
    const { view, commands, clear } = makeView({
      windows: { "%1": { windowId: "@1", paneCount: 1, zoomed: false } },
    });
    view.setTiles([spec({ sessionId: "$1", paneId: "%1" })], "default");
    clear();
    view.teardown();
    expect(commands).toEqual([]);
  });

  test("an already-zoomed window is left alone on both ends", () => {
    const { view, commands, clear } = makeView({
      windows: { "%1": { windowId: "@1", paneCount: 2, zoomed: true } },
    });
    view.setTiles([spec({ sessionId: "$1", paneId: "%1" })], "default");
    expect(commands.filter((c) => c[0] === "resize-pane")).toEqual([]);
    clear();
    view.teardown();
    expect(commands).toEqual([]);
  });
});

// ── The face ─────────────────────────────────────────────────────────────────

describe("resolveDisplayedRepresentative", () => {
  const running = (id: string, since: number) => pane(id, { state: "running" as AgentState, since });

  test("keeps the current pane while it lives", () => {
    const panes = [running("%1", 100), pane("%2", { state: "waiting", since: 200 })];
    const face = resolveDisplayedRepresentative({
      panes, override: null, current: { paneId: "%1", forcedSignature: "" }, commandRegex: null,
    });
    // %2 is waiting and would win a fresh election; stickiness outranks it.
    expect(face?.paneId).toBe("%1");
  });

  test("re-elects when the current pane dies", () => {
    const panes = [pane("%2", { state: "waiting", since: 200 })];
    const face = resolveDisplayedRepresentative({
      panes, override: null, current: { paneId: "%1", forcedSignature: "" }, commandRegex: null,
    });
    expect(face?.paneId).toBe("%2");
  });

  test("re-elects when the force-on set changes underneath it", () => {
    const panes = [running("%1", 100), pane("%2", { forcedOn: true })];
    const face = resolveDisplayedRepresentative({
      panes, override: null, current: { paneId: "%1", forcedSignature: "" }, commandRegex: null,
    });
    expect(face?.paneId).toBe("%2");
    expect(face?.forcedSignature).toBe("%2");
  });

  test("an explicit cycle outranks stickiness", () => {
    const panes = [running("%1", 100), pane("%2")];
    const face = resolveDisplayedRepresentative({
      panes, override: "%2", current: { paneId: "%1", forcedSignature: "" }, commandRegex: null,
    });
    expect(face?.paneId).toBe("%2");
  });

  test("a session with no panes has no face", () => {
    expect(resolveDisplayedRepresentative({
      panes: [], override: null, current: null, commandRegex: null,
    })).toBeNull();
  });
});

describe("the face inside a tile", () => {
  const windows: Record<string, WindowFacts> = {
    "%1": { windowId: "@1", paneCount: 2, zoomed: false },
    "%2": { windowId: "@2", paneCount: 2, zoomed: false },
  };

  test("urgency moving between panes does not move the picture", () => {
    const { view } = makeView({ windows });
    const withPanes = (over: Partial<PaneRow>[]) => spec({
      sessionId: "$1", paneId: "%1",
      panes: [pane("%1", over[0]), pane("%2", over[1])],
    });

    view.setTiles([withPanes([{ state: "running", since: 10 }, {}])], "default");
    expect(view.focusedPaneId()).toBe("%1");

    view.setTiles([withPanes([{ state: "complete", since: 30 }, { state: "waiting", since: 20 }])], "default");
    expect(view.focusedPaneId()).toBe("%1");
  });

  test("cycling the face retargets at once, not on the next poll", () => {
    const { view, commands, clear } = makeView({ windows });
    view.setTiles([spec({
      sessionId: "$1", paneId: "%1", panes: [pane("%1"), pane("%2")],
    })], "default");
    clear();

    view.setFace("$1", "%2");
    expect(view.focusedPaneId()).toBe("%2");
    expect(commands).toEqual([
      ["resize-pane", "-Z", "-t", "%1"],
      ["display-message", "-p", "-t", "%2", "#{window_id} #{window_panes} #{window_zoomed_flag}"],
      ["select-window", "-t", "$1:@2"],
      ["resize-pane", "-Z", "-t", "%2"],
    ]);
  });

  test("a cycled face survives reconciles, and outlives its pane by nothing", () => {
    const { view } = makeView({ windows });
    const both = spec({ sessionId: "$1", paneId: "%1", panes: [pane("%1"), pane("%2")] });
    view.setTiles([both], "default");
    view.setFace("$1", "%2");

    view.setTiles([both], "default");
    expect(view.focusedPaneId()).toBe("%2"); // the cycle is not undone by a poll

    // %2 dies: the override goes with it and the election answers again.
    view.setTiles([spec({ sessionId: "$1", paneId: "%1", panes: [pane("%1")] })], "default");
    expect(view.focusedPaneId()).toBe("%1");
  });
});

// ── Lifecycle ────────────────────────────────────────────────────────────────

describe("rendered set ≠ client set", () => {
  test("a tile that leaves membership keeps its client through the grace", () => {
    const { view, ptys } = makeView();
    view.setTiles([spec({ sessionId: "$1" }), spec({ sessionId: "$2" })], "default");
    expect(ptys).toHaveLength(2);

    view.setTiles([spec({ sessionId: "$1" })], "default");
    expect(ptys[1]!.pty.killed).toBe(false);   // retained, unrendered
    expect(view.focusedSessionId()).toBe("$1");

    // Coming back is a survivor, not a spawn: no second client, no re-zoom.
    view.setTiles([spec({ sessionId: "$1" }), spec({ sessionId: "$2" })], "default");
    expect(ptys).toHaveLength(2);
  });

  test("the grace expires with no tmux traffic behind it", async () => {
    const { view, ptys } = makeView({ opts: { graceMs: 10 } });
    view.setTiles([spec({ sessionId: "$1" }), spec({ sessionId: "$2" })], "default");
    view.setTiles([spec({ sessionId: "$1" })], "default");
    expect(ptys[1]!.pty.killed).toBe(false);

    await Bun.sleep(60); // nothing calls setTiles again — the armed timer must
    expect(ptys[1]!.pty.killed).toBe(true);
    expect(ptys[0]!.pty.killed).toBe(false);
    view.teardown();
  });

  test("the cap refuses active tiles and says how many", () => {
    const { view, ptys } = makeView({ opts: { maxClients: 1 } });
    view.setTiles([spec({ sessionId: "$1" }), spec({ sessionId: "$2" })], "default");

    expect(ptys).toHaveLength(1);           // no client for a tile never drawn
    expect(ptys[0]!.session).toBe("$1");
    expect(view.getDroppedActive()).toBe(1);
  });

  test("a force-on tile survives the cap and still draws in membership order", () => {
    const { view, ptys } = makeView({ opts: { maxClients: 1 } });
    view.setTiles([
      spec({ sessionId: "$1" }),
      spec({ sessionId: "$2", forced: true }),
    ], "default");

    expect(ptys.map((p) => p.session)).toEqual(["$2"]);
    expect(view.focusedSessionId()).toBe("$2");
    expect(view.getDroppedActive()).toBe(1);
  });

  test("an active tile the cap stops admitting releases its client", () => {
    const { view, ptys } = makeView({ opts: { maxClients: 2 } });
    view.setTiles([spec({ sessionId: "$1" }), spec({ sessionId: "$2" })], "default");
    expect(ptys).toHaveLength(2);

    // $3 is pinned, so it takes a slot from the derived members.
    view.setTiles([
      spec({ sessionId: "$1" }),
      spec({ sessionId: "$2" }),
      spec({ sessionId: "$3", forced: true }),
    ], "default");

    expect(ptys.map((p) => p.session)).toEqual(["$1", "$2", "$3"]);
    expect(ptys[1]!.pty.killed).toBe(true); // refused, not left attached
    expect(view.getDroppedActive()).toBe(1);
  });

  test("teardown releases everything and forgets every key", () => {
    const { view, ptys } = makeView();
    view.setTiles([spec({ sessionId: "$1" }), spec({ sessionId: "$2" })], "default");
    view.teardown();

    expect(ptys.every((p) => p.pty.killed)).toBe(true);
    expect(view.focusedSessionId()).toBeNull();
    expect(view.focusedPaneId()).toBeNull();
    expect(view.getDroppedActive()).toBe(0);
  });
});
