import { describe, test, expect } from "bun:test";
import { GlassView, type GlassTileSpec, type GlassViewOptions, type TilePty } from "../../glass/view";
import { resolveDisplayedRepresentative } from "../../glass/view";
import type { PaneRow } from "../../glass/representative";
import type { AgentState } from "../../types";
import { DENSITIES } from "../../glass/density";

// ── Harness ──────────────────────────────────────────────────────────────────
// GlassView needs a live tmux server for exactly one thing — attaching a mirror
// client — so the pty is injected and the tmux side is a recording runner.

class FakePty implements TilePty {
  killed = false;
  writes: string[] = [];
  sizes: [number, number][] = [];
  private listener: ((data: string) => void) | null = null;
  write(data: string): void { this.writes.push(data); }
  resize(cols: number, rows: number): void { this.sizes.push([cols, rows]); }
  kill(): void { this.killed = true; }
  onData(listener: (data: string) => void): void { this.listener = listener; }
  /** Push output as the real pty would. The bridge write is async. */
  emit(data: string): void { this.listener?.(data); }
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
  ...over,
});

/** `setTiles`' empty-state context — irrelevant to every test here except the
 * ones that actually empty the grid, which don't assert on it. */
const EMPTY_CTX = { viewName: "Active", hiddenCount: 0 };

const pane = (paneId: string, over: Partial<PaneRow> = {}): PaneRow => ({
  paneId,
  kind: "claude",
  command: "claude",
  forcedOn: false,
  sessionActive: false,
  state: null,
  since: null,
  agentPane: null,
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
    ], EMPTY_CTX);

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
    view.setTiles([a, b, c], EMPTY_CTX);
    view.moveFocus("right");
    expect(view.focusedSessionId()).toBe("$2");

    // A waiting agent sorts to the front: the same tile must stay focused.
    view.setTiles([b, c, a], EMPTY_CTX);
    expect(view.focusedSessionId()).toBe("$2");
  });

  test("a vanished tile hands focus to its successor", () => {
    const { view } = makeView();
    const a = spec({ sessionId: "$1" });
    const b = spec({ sessionId: "$2" });
    const c = spec({ sessionId: "$3" });
    view.setTiles([a, b, c], EMPTY_CTX);
    view.moveFocus("right");
    expect(view.focusedSessionId()).toBe("$2");

    view.setTiles([a, c], EMPTY_CTX);
    expect(view.focusedSessionId()).toBe("$3"); // the successor, at the same index

    view.setTiles([a], EMPTY_CTX);
    expect(view.focusedSessionId()).toBe("$1"); // nothing after it: the last survivor

    view.setTiles([], EMPTY_CTX);
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
    view.setTiles([spec({ sessionId: "$1", paneId: "%1" })], EMPTY_CTX);
    expect(commands).toEqual([
      ["display-message", "-p", "-t", "%1", "#{window_id} #{window_panes} #{window_zoomed_flag}"],
      ["select-window", "-t", "$1:@1"],
      ["resize-pane", "-Z", "-t", "%1"],
    ]);
    clear();

    // The face moves to a pane in another window of the same session.
    view.setTiles([spec({ sessionId: "$1", paneId: "%2" })], EMPTY_CTX);

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
    view.setTiles([spec({ sessionId: "$1", paneId: "%1" })], EMPTY_CTX);
    view.setTiles([spec({ sessionId: "$1", paneId: "%2" })], EMPTY_CTX);

    expect(ptys).toHaveLength(1);
    expect(ptys[0]!.pty.killed).toBe(false);
  });

  test("teardown undoes the zoom the tile ended with, not the one it started with", () => {
    const { view, commands, clear } = makeView({ windows });
    view.setTiles([spec({ sessionId: "$1", paneId: "%1" })], EMPTY_CTX);
    view.setTiles([spec({ sessionId: "$1", paneId: "%2" })], EMPTY_CTX);
    clear();

    view.teardown();
    expect(commands).toEqual([["resize-pane", "-Z", "-t", "%2"]]);
  });

  test("a window it never zoomed is never unzoomed", () => {
    const { view, commands, clear } = makeView({
      windows: { "%1": { windowId: "@1", paneCount: 1, zoomed: false } },
    });
    view.setTiles([spec({ sessionId: "$1", paneId: "%1" })], EMPTY_CTX);
    clear();
    view.teardown();
    expect(commands).toEqual([]);
  });

  test("an already-zoomed window is left alone on both ends", () => {
    const { view, commands, clear } = makeView({
      windows: { "%1": { windowId: "@1", paneCount: 2, zoomed: true } },
    });
    view.setTiles([spec({ sessionId: "$1", paneId: "%1" })], EMPTY_CTX);
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

    view.setTiles([withPanes([{ state: "running", since: 10 }, {}])], EMPTY_CTX);
    expect(view.focusedPaneId()).toBe("%1");

    view.setTiles([withPanes([{ state: "complete", since: 30 }, { state: "waiting", since: 20 }])], EMPTY_CTX);
    expect(view.focusedPaneId()).toBe("%1");
  });

  test("cycling the face retargets at once, not on the next poll", () => {
    const { view, commands, clear } = makeView({ windows });
    view.setTiles([spec({
      sessionId: "$1", paneId: "%1", panes: [pane("%1"), pane("%2")],
    })], EMPTY_CTX);
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
    view.setTiles([both], EMPTY_CTX);
    view.setFace("$1", "%2");

    view.setTiles([both], EMPTY_CTX);
    expect(view.focusedPaneId()).toBe("%2"); // the cycle is not undone by a poll

    // %2 dies: the override goes with it and the election answers again.
    view.setTiles([spec({ sessionId: "$1", paneId: "%1", panes: [pane("%1")] })], EMPTY_CTX);
    expect(view.focusedPaneId()).toBe("%1");
  });
});

// ── Cycling the face ─────────────────────────────────────────────────────────

describe("cycling the face", () => {
  const windows: Record<string, WindowFacts> = {
    "%1": { windowId: "@1", paneCount: 3, zoomed: false },
    "%2": { windowId: "@2", paneCount: 3, zoomed: false },
    "%3": { windowId: "@3", paneCount: 3, zoomed: false },
  };

  test("steps through eligible panes and wraps", () => {
    const { view } = makeView({ windows });
    view.setTiles([spec({
      sessionId: "$1", paneId: "%1",
      panes: [pane("%1"), pane("%2"), pane("%3")],
    })], EMPTY_CTX);
    expect(view.focusedPaneId()).toBe("%1");

    view.cycleFace();
    expect(view.focusedPaneId()).toBe("%2");
    view.cycleFace();
    expect(view.focusedPaneId()).toBe("%3");
    view.cycleFace();
    expect(view.focusedPaneId()).toBe("%1"); // wraps back to the start
  });

  test("a single eligible pane refuses to cycle", () => {
    const { view } = makeView();
    view.setTiles([spec({ sessionId: "$1", paneId: "%1", panes: [pane("%1")] })], EMPTY_CTX);
    view.cycleFace();
    expect(view.focusedPaneId()).toBe("%1");
  });

  test("no focused tile is a no-op", () => {
    const { view } = makeView();
    view.setTiles([], EMPTY_CTX);
    expect(() => view.cycleFace()).not.toThrow();
  });
});

// ── Zoom ─────────────────────────────────────────────────────────────────────

describe("zoom", () => {
  test("zooms the focused tile and restores on a second press", () => {
    const { view } = makeView();
    view.setTiles([spec({ sessionId: "$1" }), spec({ sessionId: "$2" })], EMPTY_CTX);
    expect(view.isZoomed()).toBe(false);

    view.toggleZoom();
    expect(view.isZoomed()).toBe(true);

    view.toggleZoom();
    expect(view.isZoomed()).toBe(false);
  });

  test("moveFocus refuses to move away from the zoomed tile", () => {
    const { view } = makeView();
    view.setTiles([spec({ sessionId: "$1" }), spec({ sessionId: "$2" })], EMPTY_CTX);
    view.toggleZoom();
    expect(view.focusedSessionId()).toBe("$1");

    view.moveFocus("right");
    expect(view.focusedSessionId()).toBe("$1"); // still pinned to the zoomed tile
  });

  test("clears when the zoomed tile leaves the rendered set", () => {
    const { view } = makeView();
    const a = spec({ sessionId: "$1" });
    const b = spec({ sessionId: "$2" });
    view.setTiles([a, b], EMPTY_CTX);
    view.toggleZoom();
    expect(view.isZoomed()).toBe(true);

    view.setTiles([b], EMPTY_CTX);
    expect(view.isZoomed()).toBe(false);
  });

  test("a background tile's pty is never resized to fit an invisible rect", () => {
    const { view, ptys } = makeView();
    view.setTiles([spec({ sessionId: "$1" }), spec({ sessionId: "$2" })], EMPTY_CTX);
    const two = ptys.find((p) => p.session === "$2")!.pty;
    two.sizes.length = 0;

    view.toggleZoom(); // zooms $1; $2 leaves the drawn set
    expect(two.sizes).toEqual([]); // never asked to shrink to a rect nobody draws
  });
});

describe("setDensity", () => {
  // 9 tiles on a 214x49 area — the scenario density.ts's module doc measures
  // — starting at the "focus" floor (100x22). Switching to "fit" (60x6)
  // reaches a third column and packs more visible rows, so an
  // already-spawned, still-visible tile's pty must be resized to the new,
  // smaller rect — the live grid re-laying out, not a fresh spawn.
  const nineSpecs = Array.from({ length: 9 }, (_, i) => spec({ sessionId: `$${i + 1}` }));

  test("resizes an already-visible tile's pty and bridge to the new floor's rect", () => {
    const { view, ptys } = makeView({ opts: DENSITIES.focus });
    view.resize(214, 49);
    view.setTiles(nineSpecs, EMPTY_CTX);
    const one = ptys.find((p) => p.session === "$1")!.pty;
    one.sizes.length = 0;

    view.setDensity("fit");

    expect(one.sizes.length).toBeGreaterThan(0);
    const [cols, rows] = one.sizes[one.sizes.length - 1]!;
    // focus at N=9: 2 cols -> 107-wide tiles (105 interior), 24-tall (22
    // interior). fit at N=9: 3 cols -> 71-wide tiles (69 interior), 16-tall
    // (14 interior) — the exact numbers in the module doc's measured table.
    expect(cols).toBeLessThan(105);
    expect(rows).toBeLessThan(22);
  });

  test("requests a frame after re-laying out", () => {
    let frames = 0;
    const { view } = makeView({ opts: { ...DENSITIES.focus, onFrame: () => frames++ } });
    view.resize(214, 49);
    view.setTiles(nineSpecs, EMPTY_CTX);
    frames = 0;

    view.setDensity("fit");

    expect(frames).toBeGreaterThan(0);
  });

  test("toggling twice returns to the original layout — a swap, not a ring", () => {
    const { view, ptys } = makeView({ opts: DENSITIES.focus });
    view.resize(214, 49);
    view.setTiles(nineSpecs, EMPTY_CTX);
    const one = ptys.find((p) => p.session === "$1")!.pty;
    const original = one.sizes[one.sizes.length - 1]!;

    view.setDensity("fit");
    view.setDensity("focus");

    expect(one.sizes[one.sizes.length - 1]!).toEqual(original);
  });

  test("spawns no new client and tears none down — a re-layout, not a reconcile", () => {
    const { view, ptys } = makeView({ opts: DENSITIES.focus });
    view.resize(214, 49);
    view.setTiles(nineSpecs, EMPTY_CTX);
    const before = ptys.length;
    const killedBefore = ptys.filter((p) => p.pty.killed).length;

    view.setDensity("fit");

    expect(ptys.length).toBe(before);
    expect(ptys.filter((p) => p.pty.killed).length).toBe(killedBefore);
  });
});

// ── Lifecycle ────────────────────────────────────────────────────────────────

describe("rendered set ≠ client set", () => {
  test("a tile that leaves membership keeps its client through the grace", () => {
    const { view, ptys } = makeView();
    view.setTiles([spec({ sessionId: "$1" }), spec({ sessionId: "$2" })], EMPTY_CTX);
    expect(ptys).toHaveLength(2);

    view.setTiles([spec({ sessionId: "$1" })], EMPTY_CTX);
    expect(ptys[1]!.pty.killed).toBe(false);   // retained, unrendered
    expect(view.focusedSessionId()).toBe("$1");

    // Coming back is a survivor, not a spawn: no second client, no re-zoom.
    view.setTiles([spec({ sessionId: "$1" }), spec({ sessionId: "$2" })], EMPTY_CTX);
    expect(ptys).toHaveLength(2);
  });

  test("the grace expires with no tmux traffic behind it", async () => {
    const { view, ptys } = makeView({ opts: { graceMs: 10 } });
    view.setTiles([spec({ sessionId: "$1" }), spec({ sessionId: "$2" })], EMPTY_CTX);
    view.setTiles([spec({ sessionId: "$1" })], EMPTY_CTX);
    expect(ptys[1]!.pty.killed).toBe(false);

    await Bun.sleep(60); // nothing calls setTiles again — the armed timer must
    expect(ptys[1]!.pty.killed).toBe(true);
    expect(ptys[0]!.pty.killed).toBe(false);
    view.teardown();
  });

  test("the cap refuses active tiles and says how many", () => {
    const { view, ptys } = makeView({ opts: { maxClients: 1 } });
    view.setTiles([spec({ sessionId: "$1" }), spec({ sessionId: "$2" })], EMPTY_CTX);

    expect(ptys).toHaveLength(1);           // no client for a tile never drawn
    expect(ptys[0]!.session).toBe("$1");
    expect(view.getDroppedActive()).toBe(1);
  });

  test("a force-on tile survives the cap and still draws in membership order", () => {
    const { view, ptys } = makeView({ opts: { maxClients: 1 } });
    view.setTiles([
      spec({ sessionId: "$1" }),
      spec({ sessionId: "$2", forced: true }),
    ], EMPTY_CTX);

    expect(ptys.map((p) => p.session)).toEqual(["$2"]);
    expect(view.focusedSessionId()).toBe("$2");
    expect(view.getDroppedActive()).toBe(1);
  });

  test("an active tile the cap stops admitting releases its client", () => {
    const { view, ptys } = makeView({ opts: { maxClients: 2 } });
    view.setTiles([spec({ sessionId: "$1" }), spec({ sessionId: "$2" })], EMPTY_CTX);
    expect(ptys).toHaveLength(2);

    // $3 is pinned, so it takes a slot from the derived members.
    view.setTiles([
      spec({ sessionId: "$1" }),
      spec({ sessionId: "$2" }),
      spec({ sessionId: "$3", forced: true }),
    ], EMPTY_CTX);

    expect(ptys.map((p) => p.session)).toEqual(["$1", "$2", "$3"]);
    expect(ptys[1]!.pty.killed).toBe(true); // refused, not left attached
    expect(view.getDroppedActive()).toBe(1);
  });

  test("teardown releases everything and forgets every key", () => {
    const { view, ptys } = makeView();
    view.setTiles([spec({ sessionId: "$1" }), spec({ sessionId: "$2" })], EMPTY_CTX);
    view.teardown();

    expect(ptys.every((p) => p.pty.killed)).toBe(true);
    expect(view.focusedSessionId()).toBeNull();
    expect(view.focusedPaneId()).toBeNull();
    expect(view.getDroppedActive()).toBe(0);
  });
});

/**
 * Wait for a condition the ScreenBridge's async write is about to satisfy.
 *
 * A fixed sleep would be the obvious thing and is the wrong one: the assertion
 * that matters here is a *negative* ("no frame was asked for"), and a sleep too
 * short passes it for the wrong reason. Polling for the positive control and
 * failing loudly on timeout keeps the negative honest under load.
 */
async function until(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition never became true");
    await new Promise((r) => setTimeout(r, 1));
  }
}

/** Let any pending bridge writes settle, without asserting anything about them. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 1));
}

describe("only a rendered tile asks for a frame", () => {
  // The event that retires a tile into its grace is an agent finishing a turn,
  // which is exactly when it prints — so an unguarded onFrame turns the grace
  // window into a repaint storm producing an identical picture.
  test("a retained tile's output does not schedule a render", async () => {
    let frames = 0;
    const { view, ptys } = makeView({ opts: { onFrame: () => { frames++; } } });
    view.setTiles([spec({ sessionId: "$1" }), spec({ sessionId: "$2" })], EMPTY_CTX);
    const two = ptys.find((p) => p.session === "$2")!.pty;

    // While rendered, its output is worth a frame. This is also the control:
    // it proves the wait below is long enough for a frame to have arrived.
    frames = 0;
    two.emit("hello");
    await until(() => frames > 0);

    // $2 leaves membership. Its client survives the grace, unrendered.
    view.setTiles([spec({ sessionId: "$1" })], EMPTY_CTX);
    expect(two.killed).toBe(false);

    frames = 0;
    two.emit("still chattering");
    await settle();
    expect(frames).toBe(0);
  });

  test("a retained tile is still fed, so it is current when it returns", async () => {
    const { view, ptys } = makeView();
    view.setTiles([spec({ sessionId: "$1" }), spec({ sessionId: "$2" })], EMPTY_CTX);
    const two = ptys.find((p) => p.session === "$2")!.pty;

    view.setTiles([spec({ sessionId: "$1" })], EMPTY_CTX);
    two.emit("output while retained");
    await settle();

    // Coming back reuses the same client rather than spawning a second one.
    view.setTiles([spec({ sessionId: "$1" }), spec({ sessionId: "$2" })], EMPTY_CTX);
    expect(ptys.filter((p) => p.session === "$2")).toHaveLength(1);
    expect(two.killed).toBe(false);
  });
});

// ── Tile chrome (phase 8) ────────────────────────────────────────────────────

function gridText(view: GlassView): string {
  return view.getGrid().cells.map((row) => row.map((c) => c.char).join("")).join("\n");
}

describe("the empty state", () => {
  test("names the view and states the hidden count", () => {
    const { view } = makeView();
    view.setTiles([], { viewName: "Active", hiddenCount: 3 });
    const text = gridText(view);
    expect(text).toContain('No sessions match "Active"');
    expect(text).toContain("3 hidden");
    expect(text).toContain("⌃a f");
    expect(text).toContain("switch view");
  });

  test("omits the hidden clause when nothing is hidden", () => {
    const { view } = makeView();
    view.setTiles([], { viewName: "Active", hiddenCount: 0 });
    expect(gridText(view)).not.toContain("hidden");
  });
});

describe("the focused tile's bottom-border hint", () => {
  test("a wide tile shows every hint, including the face cycle", () => {
    const { view } = makeView();
    view.resize(64, 10);
    view.setTiles(
      [spec({ sessionId: "$1", panes: [pane("%1"), pane("%2"), pane("%3")] })],
      EMPTY_CTX,
    );
    const text = gridText(view);
    expect(text).toContain("⇧↔ focus");
    expect(text).toContain("⌃a↵ open");
    expect(text).toContain("⌃a x agent 1/3");
    expect(text).toContain("⌃a P hide");
  });

  test("⌃a x is omitted for a single-pane session — nothing to cycle to", () => {
    const { view } = makeView();
    view.resize(64, 10);
    view.setTiles([spec({ sessionId: "$1", panes: [pane("%1")] })], EMPTY_CTX);
    const text = gridText(view);
    expect(text).toContain("⇧↔ focus");
    expect(text).not.toContain("agent");
    expect(text).toContain("⌃a P hide");
  });

  test("a medium tile drops from the tail rather than truncating", () => {
    const { view } = makeView();
    view.resize(20, 6);
    view.setTiles(
      [spec({ sessionId: "$1", panes: [pane("%1"), pane("%2")] })],
      EMPTY_CTX,
    );
    const text = gridText(view);
    expect(text).toContain("⇧↔ focus");
    // Everything after it was dropped whole, not cut mid-word.
    expect(text).not.toContain("open");
    expect(text).not.toContain("agent");
    expect(text).not.toContain("hide");
  });

  test("a narrow tile shows no hint at all rather than a truncated one", () => {
    const { view } = makeView();
    view.resize(12, 6);
    view.setTiles([spec({ sessionId: "$1", panes: [pane("%1")] })], EMPTY_CTX);
    expect(gridText(view)).not.toContain("focus");
  });

  test("only the focused tile carries a hint", () => {
    const { view } = makeView();
    view.resize(80, 10);
    view.setTiles(
      [spec({ sessionId: "$1", panes: [pane("%1"), pane("%2")] }), spec({ sessionId: "$2", panes: [pane("%3")] })],
      EMPTY_CTX,
    );
    // $1 is focused (first spec wins the initial face/focus): its hint shows,
    // once — never one per tile.
    const text = gridText(view);
    expect((text.match(/⇧↔ focus/g) ?? []).length).toBe(1);

    view.moveFocus("right");
    const afterMove = gridText(view);
    expect((afterMove.match(/⇧↔ focus/g) ?? []).length).toBe(1);
    // $2 has one eligible pane, so its hint — now the one shown — omits the
    // face cycle, unlike $1's did.
    expect(afterMove).not.toContain("agent");
  });
});
