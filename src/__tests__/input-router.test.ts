import { describe, test, expect } from "bun:test";
import { translateMouse, parseSgrMouseChunk, InputRouter, type InputRouterOptions } from "../input-router";
import { computeFrameLayout, SIDEBAR_MIN_TERM_COLS, type FrameLayout } from "../frame-layout";

// Shared FrameLayout fixtures. Tests build real layouts via computeFrameLayout
// (rather than hand-rolled Span objects) so the geometry fed to InputRouter is
// internally consistent — the same guarantee relayout() gives production code.

// A layout with no diff panel (mode "off"), given a sidebar width. termCols is
// generous (120) so main always has plenty of room regardless of sidebarWidth.
function baseLayout(sidebarWidth: number, diffState: "off" | "split" | "full" = "off", requestedPanelCols = 0): FrameLayout {
  return computeFrameLayout({
    termCols: 120,
    termRows: 40,
    sidebarWidth,
    borderWidth: 1,
    toolbarRows: 1,
    diffState,
    requestedPanelCols,
    frameRulesEnabled: false,
    footerEnabled: false,
  });
}

// A split-mode layout with exact main/panel widths (rather than "big enough"),
// for tests that assert precise translated mouse coordinates. sidebarWidth is
// widened (keeping mainCols/panelCols exact) if needed to clear
// SIDEBAR_MIN_TERM_COLS — computeFrameLayout returns sidebar: null below that,
// which would make the router skip the whole mouse block.
function diffPanelLayout(sidebarWidth: number, mainCols: number, panelCols: number): FrameLayout {
  const available = mainCols + panelCols + 1; // + borderWidth between main and panel
  let termCols = sidebarWidth + 1 + available; // + borderWidth between sidebar and main
  let effectiveSidebarWidth = sidebarWidth;
  if (termCols < SIDEBAR_MIN_TERM_COLS) {
    effectiveSidebarWidth += SIDEBAR_MIN_TERM_COLS - termCols;
    termCols = SIDEBAR_MIN_TERM_COLS;
  }
  return computeFrameLayout({
    termCols,
    termRows: 40,
    sidebarWidth: effectiveSidebarWidth,
    borderWidth: 1,
    toolbarRows: 1,
    diffState: "split",
    requestedPanelCols: panelCols,
    frameRulesEnabled: false,
    footerEnabled: false,
  });
}

// A layout with the chrome rows (top rule, footer rule, footer) turned on —
// termRows=40 clears computeFrameLayout's degradation ladder floor (>=12) so
// every chrome row is present. Used only by the chrome-row routing tests
// below; every other fixture in this file keeps the flags off (today's
// production wiring) so contentTop === toolbarRows there.
function chromeLayout(sidebarWidth: number, diffState: "off" | "split" | "full" = "off", requestedPanelCols = 0): FrameLayout {
  return computeFrameLayout({
    termCols: 120,
    termRows: 40,
    sidebarWidth,
    borderWidth: 1,
    toolbarRows: 1,
    diffState,
    requestedPanelCols,
    frameRulesEnabled: true,
    footerEnabled: true,
  });
}

describe("parseSgrMouse (single report, via parseSgrMouseChunk)", () => {
  const one = (seq: string) => {
    const parsed = parseSgrMouseChunk(seq);
    return parsed === null ? null : parsed[0]!;
  };

  test("parses SGR mouse button press", () => {
    const result = one("\x1b[<0;30;5M");
    expect(result).not.toBeNull();
    expect(result!.button).toBe(0);
    expect(result!.x).toBe(30);
    expect(result!.y).toBe(5);
    expect(result!.release).toBe(false);
  });

  test("parses SGR mouse button release", () => {
    const result = one("\x1b[<0;30;5m");
    expect(result).not.toBeNull();
    expect(result!.release).toBe(true);
  });

  test("parses wheel up event", () => {
    const result = one("\x1b[<64;10;5M");
    expect(result).not.toBeNull();
    expect(result!.button).toBe(64);
    expect(result!.x).toBe(10);
  });

  test("returns null for non-mouse sequence", () => {
    expect(one("\x1b[A")).toBeNull();
  });
});

describe("translateMouse", () => {
  test("translates x coordinate by subtracting offset", () => {
    const result = translateMouse("\x1b[<0;30;5M", 25);
    expect(result).toBe("\x1b[<0;5;5M");
  });

  test("preserves release suffix", () => {
    const result = translateMouse("\x1b[<0;30;5m", 25);
    expect(result).toBe("\x1b[<0;5;5m");
  });

  test("returns null if translated x would be <= 0", () => {
    const result = translateMouse("\x1b[<0;10;5M", 25);
    expect(result).toBeNull();
  });

  test("translates both x and y when yOffset provided", () => {
    const result = translateMouse("\x1b[<0;30;10M", 25, 1);
    expect(result).toBe("\x1b[<0;5;9M");
  });

  test("returns null if translated y would be <= 0", () => {
    const result = translateMouse("\x1b[<0;30;1M", 25, 1);
    expect(result).toBeNull();
  });
});

describe("Ctrl-Shift arrow detection", () => {
  test("calls onSessionPrev for Ctrl-Shift-Up", () => {
    let prevCalled = false;
    const router = new InputRouter(
      {
        onPtyData: () => {},
        onSidebarClick: () => {},
        onSessionPrev: () => { prevCalled = true; },
      },
      baseLayout(24),
    );
    router.handleInput("\x1b[1;6A");
    expect(prevCalled).toBe(true);
  });

  test("calls onSessionNext for Ctrl-Shift-Down", () => {
    let nextCalled = false;
    const router = new InputRouter(
      {
        onPtyData: () => {},
        onSidebarClick: () => {},
        onSessionNext: () => { nextCalled = true; },
      },
      baseLayout(24),
    );
    router.handleInput("\x1b[1;6B");
    expect(nextCalled).toBe(true);
  });

  test("Ctrl-Shift arrows are not forwarded to PTY", () => {
    let ptyData = "";
    const router = new InputRouter(
      {
        onPtyData: (d) => { ptyData += d; },
        onSidebarClick: () => {},
        onSessionPrev: () => {},
        onSessionNext: () => {},
      },
      baseLayout(24),
    );
    router.handleInput("\x1b[1;6A");
    router.handleInput("\x1b[1;6B");
    expect(ptyData).toBe("");
  });
});

describe("passthrough", () => {
  test("forwards regular input to PTY", () => {
    let ptyData = "";
    const router = new InputRouter(
      {
        onPtyData: (d) => { ptyData += d; },
        onSidebarClick: () => {},
      },
      baseLayout(24),
    );
    router.handleInput("hello");
    expect(ptyData).toBe("hello");
  });
});

describe("modal mode", () => {
  test("routes keyboard input to onModalInput when modal is open", () => {
    let paletteData = "";
    let ptyData = "";
    const router = new InputRouter(
      {
        onPtyData: (d) => { ptyData += d; },
        onSidebarClick: () => {},
        onModalInput: (d) => { paletteData += d; },
      },
      baseLayout(24),
    );
    router.setModalOpen(true);
    router.handleInput("hello");
    expect(paletteData).toBe("hello");
    expect(ptyData).toBe("");
  });

  test("still sends Ctrl-Shift arrows to session handlers when palette is open", () => {
    let prevCalled = false;
    const router = new InputRouter(
      {
        onPtyData: () => {},
        onSidebarClick: () => {},
        onModalInput: () => {},
        onSessionPrev: () => { prevCalled = true; },
      },
      baseLayout(24),
    );
    router.setModalOpen(true);
    router.handleInput("\x1b[1;6A");
    expect(prevCalled).toBe(true);
  });

  test("sidebar clicks still work when palette is open", () => {
    let clickedRow = -1;
    const router = new InputRouter(
      {
        onPtyData: () => {},
        onSidebarClick: (row) => { clickedRow = row; },
        onModalInput: () => {},
      },
      baseLayout(24),
    );
    router.setModalOpen(true);
    router.handleInput("\x1b[<0;5;3M");
    expect(clickedRow).toBe(2);
  });

  test("toolbar clicks are ignored when palette is open", () => {
    let toolbarClicked = false;
    const router = new InputRouter(
      {
        onPtyData: () => {},
        onSidebarClick: () => {},
        onModalInput: () => {},
        onToolbarClick: () => { toolbarClicked = true; },
      },
      baseLayout(24),
    );
    router.setModalOpen(true);
    router.handleInput("\x1b[<0;30;1M");
    expect(toolbarClicked).toBe(false);
  });

  test("main area mouse events are ignored when palette is open", () => {
    let ptyData = "";
    const router = new InputRouter(
      {
        onPtyData: (d) => { ptyData += d; },
        onSidebarClick: () => {},
        onModalInput: () => {},
      },
      baseLayout(24),
    );
    router.setModalOpen(true);
    router.handleInput("\x1b[<0;30;5M");
    expect(ptyData).toBe("");
  });

  test("routes to PTY when palette is closed", () => {
    let ptyData = "";
    let paletteData = "";
    const router = new InputRouter(
      {
        onPtyData: (d) => { ptyData += d; },
        onSidebarClick: () => {},
        onModalInput: (d) => { paletteData += d; },
      },
      baseLayout(24),
    );
    router.setModalOpen(true);
    router.setModalOpen(false);
    router.handleInput("hello");
    expect(ptyData).toBe("hello");
    expect(paletteData).toBe("");
  });
});

describe("link click", () => {
  // getLinkAt is queried with 0-indexed grid coords (mouse.x-1, mouse.y-1).
  // The link cell here is the main-area cell at absolute mouse (30, 5).
  const makeRouter = (sink: { pty: string; opened: string[] }) =>
    new InputRouter(
      {
        onPtyData: (d) => { sink.pty += d; },
        onSidebarClick: () => {},
        getLinkAt: (x, y) => (x === 29 && y === 4 ? "https://example.com" : undefined),
        onOpenLink: (url) => { sink.opened.push(url); },
      },
      baseLayout(24),
    );

  test("clean left-click on a link cell opens the URL and is not forwarded to tmux", () => {
    const sink = { pty: "", opened: [] as string[] };
    const router = makeRouter(sink);
    router.handleInput("\x1b[<0;30;5M");
    expect(sink.opened).toEqual(["https://example.com"]);
    expect(sink.pty).toBe("");
  });

  test("the matching release over the link cell is also consumed", () => {
    const sink = { pty: "", opened: [] as string[] };
    const router = makeRouter(sink);
    router.handleInput("\x1b[<0;30;5M"); // press → opens
    router.handleInput("\x1b[<0;30;5m"); // release → swallowed
    expect(sink.opened).toEqual(["https://example.com"]); // opened exactly once
    expect(sink.pty).toBe("");
  });

  test("left-click on a non-link cell forwards to tmux and does not open", () => {
    const sink = { pty: "", opened: [] as string[] };
    const router = makeRouter(sink);
    router.handleInput("\x1b[<0;40;5M"); // not the link cell
    expect(sink.opened).toEqual([]);
    expect(sink.pty.length).toBeGreaterThan(0); // translated event forwarded
  });

  test("wheel over a link cell does not open the link", () => {
    const sink = { pty: "", opened: [] as string[] };
    const router = makeRouter(sink);
    router.handleInput("\x1b[<64;30;5M"); // wheel up at the link cell
    expect(sink.opened).toEqual([]);
  });

  test("motion (drag) over a link cell does not open the link", () => {
    const sink = { pty: "", opened: [] as string[] };
    const router = makeRouter(sink);
    router.handleInput("\x1b[<32;30;5M"); // button 0 + motion bit (drag)
    expect(sink.opened).toEqual([]);
  });

  test("link click is not intercepted while a modal is open", () => {
    const sink = { pty: "", opened: [] as string[] };
    const router = makeRouter(sink);
    router.setModalOpen(true);
    router.handleInput("\x1b[<0;30;5M");
    expect(sink.opened).toEqual([]);
  });
});

describe("diff panel routing", () => {
  test("mouse click in diff panel region forwards translated SGR to onDiffPanelData", () => {
    let diffData = "";
    const layout = diffPanelLayout(4, 20, 10);
    const router = new InputRouter(
      {
        onPtyData: () => {},
        onSidebarClick: () => {},
        onDiffPanelData: (d) => { diffData += d; },
      },
      layout,
    );
    // A click 2 (1-indexed) columns into the panel, row 2 into content:
    // mouse.x = panel.x + 2, mouse.y = toolbarRows + 2.
    const mouseX = layout.panel!.x + 2;
    const mouseY = layout.toolbarRows + 2;
    router.handleInput(`\x1b[<0;${mouseX};${mouseY}M`);
    expect(diffData).toBe("\x1b[<0;2;2M");
  });

  // The divider is also a resize handle, so a press there is ambiguous until
  // the next event: the focus toggle fires on release-without-motion, not on
  // press. These two tests are a pair — together they pin the click-vs-drag
  // split in place, so a future edit can't quietly move the toggle back to
  // press and break dragging.
  test("divider click toggles focus on release", () => {
    let focusToggled = false;
    const layout = diffPanelLayout(4, 20, 10);
    const router = new InputRouter(
      {
        onPtyData: () => {},
        onSidebarClick: () => {},
        onDiffPanelFocusToggle: () => { focusToggled = true; },
      },
      layout,
    );
    // Divider click is 1-indexed mouse.x = divider (0-indexed) + 1.
    const mouseX = layout.divider! + 1;
    router.handleInput(`\x1b[<0;${mouseX};3M`);
    router.handleInput(`\x1b[<0;${mouseX};3m`);
    expect(focusToggled).toBe(true);
  });

  test("divider press alone does not toggle focus", () => {
    let focusToggled = false;
    const layout = diffPanelLayout(4, 20, 10);
    const router = new InputRouter(
      {
        onPtyData: () => {},
        onSidebarClick: () => {},
        onDiffPanelFocusToggle: () => { focusToggled = true; },
      },
      layout,
    );
    router.handleInput(`\x1b[<0;${layout.divider! + 1};3M`);
    expect(focusToggled).toBe(false);
  });

  test("keyboard routes to onDiffPanelData when diff panel is focused", () => {
    let diffData = "";
    let ptyData = "";
    const router = new InputRouter(
      {
        onPtyData: (d) => { ptyData += d; },
        onSidebarClick: () => {},
        onDiffPanelData: (d) => { diffData += d; },
      },
      baseLayout(4, "split", 10),
    );
    router.setPanelFocused(true);
    router.handleInput("jk");
    expect(diffData).toBe("jk");
    expect(ptyData).toBe("");
  });

  test("keyboard routes to PTY when diff panel exists but is not focused", () => {
    let diffData = "";
    let ptyData = "";
    const router = new InputRouter(
      {
        onPtyData: (d) => { ptyData += d; },
        onSidebarClick: () => {},
        onDiffPanelData: (d) => { diffData += d; },
      },
      baseLayout(4, "split", 10),
    );
    router.setPanelFocused(false);
    router.handleInput("jk");
    expect(ptyData).toBe("jk");
    expect(diffData).toBe("");
  });

  test("Ctrl-a Tab toggles diff panel focus", () => {
    let focusToggled = false;
    const router = new InputRouter(
      {
        onPtyData: () => {},
        onSidebarClick: () => {},
        onDiffPanelFocusToggle: () => { focusToggled = true; },
      },
      baseLayout(4, "split", 10),
    );
    router.setPanelFocused(false);
    router.handleInput("\x01");
    router.handleInput("\t");
    expect(focusToggled).toBe(true);
  });

  test("prefix key swallowed when diff panel is focused and key is unrecognized", () => {
    let ptyData = "";
    let diffData = "";
    const router = new InputRouter(
      {
        onPtyData: (d) => { ptyData += d; },
        onSidebarClick: () => {},
        onDiffPanelData: (d) => { diffData += d; },
      },
      baseLayout(4, "split", 10),
    );
    router.setPanelFocused(true);
    router.handleInput("\x01");
    expect(ptyData).toBe("");
    expect(diffData).toBe("");
    router.handleInput("x");
    expect(ptyData).toBe("");
    expect(diffData).toBe("");
  });

  test("Ctrl-a g still intercepted when diff panel is focused", () => {
    let toggleCalled = false;
    const router = new InputRouter(
      {
        onPtyData: () => {},
        onSidebarClick: () => {},
        onDiffPanelData: () => {},
        onDiffToggle: () => { toggleCalled = true; },
      },
      baseLayout(4, "split", 10),
    );
    router.setPanelFocused(true);
    router.handleInput("\x01");
    router.handleInput("g");
    expect(toggleCalled).toBe(true);
  });

  test("Ctrl-a G cycles the sidebar group mode, case-distinct from Ctrl-a g diff toggle", () => {
    let groupCycled = false;
    let diffToggled = false;
    const router = new InputRouter(
      {
        onPtyData: () => {},
        onSidebarClick: () => {},
        onGroupCycle: () => { groupCycled = true; },
        onDiffToggle: () => { diffToggled = true; },
      },
      baseLayout(4),
    );
    router.handleInput("\x01");
    router.handleInput("G");
    expect(groupCycled).toBe(true);
    expect(diffToggled).toBe(false); // uppercase G must not fall through to lowercase g
  });

  test("Ctrl-a \\ toggles the sidebar, and the backslash never reaches the pty", () => {
    let toggled = 0;
    let ptyData = "";
    const router = new InputRouter(
      {
        onPtyData: (d) => { ptyData += d; },
        onSidebarClick: () => {},
        onSidebarToggle: () => { toggled += 1; },
      },
      baseLayout(4),
    );
    router.handleInput("\x01");
    router.handleInput("\\");
    expect(toggled).toBe(1);
    // The prefix itself is forwarded (tmux's other binds must keep working);
    // the chord byte is not.
    expect(ptyData).toBe("\x01");
  });

  test("prefix+d detaches jmux when the Command Center is active", () => {
    let detachCalled = false;
    let ptyData = "";
    const router = new InputRouter(
      {
        onPtyData: (d) => { ptyData += d; },
        onSidebarClick: () => {},
        glassActive: () => true,
        onGlassDetach: () => { detachCalled = true; },
      },
      baseLayout(4),
    );
    router.handleInput("\x01"); // prefix is buffered (not forwarded) in glass
    router.handleInput("d");
    expect(detachCalled).toBe(true);
    expect(ptyData).toBe(""); // buffered prefix dropped, not forwarded
  });

  test("prefix+d is a normal passthrough when not in the Command Center", () => {
    let detachCalled = false;
    let ptyData = "";
    const router = new InputRouter(
      {
        onPtyData: (d) => { ptyData += d; },
        onSidebarClick: () => {},
        glassActive: () => false,
        onGlassDetach: () => { detachCalled = true; },
      },
      baseLayout(4),
    );
    router.handleInput("\x01");
    router.handleInput("d");
    expect(detachCalled).toBe(false);
    expect(ptyData).toBe("\x01d"); // tmux receives prefix+d → its own detach binding
  });

  test("Shift+Left from focused diff panel toggles focus back to tmux", () => {
    let focusToggled = false;
    const router = new InputRouter(
      {
        onPtyData: () => {},
        onSidebarClick: () => {},
        onDiffPanelFocusToggle: () => { focusToggled = true; },
      },
      baseLayout(4, "split", 10),
    );
    router.setPanelFocused(true); // focused
    router.handleInput("\x1b[1;2D"); // Shift+Left
    expect(focusToggled).toBe(true);
  });

  test("Shift+Left forwards to tmux when diff panel is not focused", () => {
    let ptyData = "";
    let focusToggled = false;
    const router = new InputRouter(
      {
        onPtyData: (d) => { ptyData += d; },
        onSidebarClick: () => {},
        onDiffPanelFocusToggle: () => { focusToggled = true; },
      },
      baseLayout(4, "split", 10),
    );
    router.setPanelFocused(false); // not focused
    router.handleInput("\x1b[1;2D"); // Shift+Left
    expect(focusToggled).toBe(false);
    expect(ptyData).toBe("\x1b[1;2D");
  });

  test("Shift+Right calls onPaneNavRight when diff panel open and tmux focused", () => {
    let navRightCalled = false;
    const router = new InputRouter(
      {
        onPtyData: () => {},
        onSidebarClick: () => {},
        onPaneNavRight: () => { navRightCalled = true; },
      },
      baseLayout(4, "split", 10),
    );
    router.setPanelFocused(false); // tmux focused
    router.handleInput("\x1b[1;2C"); // Shift+Right
    expect(navRightCalled).toBe(true);
  });

  test("Shift+Right forwards to tmux when no diff panel", () => {
    let ptyData = "";
    const router = new InputRouter(
      {
        onPtyData: (d) => { ptyData += d; },
        onSidebarClick: () => {},
        onPaneNavRight: () => {},
      },
      baseLayout(4), // No diff panel — layout.panel is null
    );
    router.handleInput("\x1b[1;2C"); // Shift+Right
    expect(ptyData).toBe("\x1b[1;2C");
  });

  // Full mode: panel.x === main.x (the panel overlaps main rather than
  // sitting after a divider) and divider is null. The setMainCols(0) deletion
  // in main.ts rests on this routing actually sending content-area clicks to
  // the panel instead of tmux's main pane.
  test("full mode: content-area click routes to panel, not main, translated by panel.x", () => {
    let diffData = "";
    let ptyData = "";
    const layout = baseLayout(4, "full", 10);
    // Sanity-check the geometry this test (and the setMainCols(0) deletion)
    // depends on before asserting router behavior against it.
    expect(layout.divider).toBeNull();
    expect(layout.panel!.x).toBe(layout.main.x);

    const router = new InputRouter(
      {
        onPtyData: (d) => { ptyData += d; },
        onSidebarClick: () => {},
        onDiffPanelData: (d) => { diffData += d; },
      },
      layout,
    );
    // A click 5 (1-indexed) columns into the panel, row 2 into content —
    // same convention as the split-mode panel test above.
    const mouseX = layout.panel!.x + 5;
    const mouseY = layout.toolbarRows + 2;
    router.handleInput(`\x1b[<0;${mouseX};${mouseY}M`);
    expect(diffData).toBe("\x1b[<0;5;2M");
    expect(ptyData).toBe("");
  });

  test("full mode: no divider exists, so no column is ever classified as a divider drag", () => {
    let diffData = "";
    let focusToggled = false;
    const layout = baseLayout(4, "full", 10);
    expect(layout.divider).toBeNull();

    const router = new InputRouter(
      {
        onPtyData: () => {},
        onSidebarClick: () => {},
        onDiffPanelData: (d) => { diffData += d; },
        onDiffPanelFocusToggle: () => { focusToggled = true; },
      },
      layout,
    );
    // Pre-focus the panel so the (unrelated) "click acquires focus" branch
    // can't fire and confound this assertion — isolates the divider check.
    router.setPanelFocused(true);
    // Click at the column that would have been the divider in a
    // comparably-sized split layout (main.x + main.w). With layout.divider
    // === null this must still route to the panel as ordinary content, never
    // trigger the divider-toggle branch.
    const mouseX = layout.main.x + layout.main.w; // 1-indexed grid col
    const mouseY = layout.toolbarRows + 3;
    router.handleInput(`\x1b[<0;${mouseX};${mouseY}M`);
    expect(focusToggled).toBe(false);
    expect(diffData.length).toBeGreaterThan(0);
  });
});

describe("toolbar column routing", () => {
  // gridX - layout.main.x is the corrected formula (replacing the old
  // `mouse.x - sidebarCols - 1`, which was off by one — see the
  // "glass strip mouse routing" comment above for the corroborating trace).
  test("onToolbarClick receives gridX - layout.main.x for a click in the toolbar row", () => {
    let clickedCol = -1;
    const layout = baseLayout(24);
    const router = new InputRouter(
      {
        onPtyData: () => {},
        onSidebarClick: () => {},
        onToolbarClick: (col) => { clickedCol = col; },
      },
      layout,
    );
    const gridX = layout.main.x + 5;
    const mouseX = gridX + 1; // SGR mouse x is 1-indexed
    router.handleInput(`\x1b[<0;${mouseX};1M`); // row 1 → gridY 0, within toolbarRows
    expect(clickedCol).toBe(5);
  });

  test("onHover reports the same column for a motion event in the toolbar row", () => {
    // Derived from the option rather than restated, so adding a hover target
    // (drag handles) doesn't require editing this test.
    const hovers: Array<Parameters<NonNullable<InputRouterOptions["onHover"]>>[0]> = [];
    const layout = baseLayout(24);
    const router = new InputRouter(
      {
        onPtyData: () => {},
        onSidebarClick: () => {},
        onHover: (target) => { hovers.push(target); },
      },
      layout,
    );
    const gridX = layout.main.x + 5;
    const mouseX = gridX + 1;
    router.handleInput(`\x1b[<32;${mouseX};1M`); // button 32 = plain motion
    expect(hovers).toEqual([{ area: "toolbar", col: 5 }]);
  });

  test("a click at gridX === layout.main.x yields column 0 (the boundary the old -1 offset got wrong)", () => {
    let clickedCol = -1;
    const layout = baseLayout(24);
    const router = new InputRouter(
      {
        onPtyData: () => {},
        onSidebarClick: () => {},
        onToolbarClick: (col) => { clickedCol = col; },
      },
      layout,
    );
    const mouseX = layout.main.x + 1; // gridX === layout.main.x
    router.handleInput(`\x1b[<0;${mouseX};1M`);
    expect(clickedCol).toBe(0);
  });
});

describe("chrome chords on a full-screen surface", () => {
  // Settings / workflow / ghost preview consume input, so they arrive with
  // modalOpen set and every chord dies. The sidebar is painted beside all
  // three — and the preview is the surface you reach *from* a sidebar row —
  // so the chord that hides it has to survive there.
  const surfaceRouter = (opts: Partial<InputRouterOptions> = {}) => {
    const router = new InputRouter(
      {
        onPtyData: () => {},
        onSidebarClick: () => {},
        fullScreenSurfaceActive: () => true,
        ...opts,
      },
      baseLayout(24),
    );
    router.setModalOpen(true);
    return router;
  };

  test("Ctrl-a \\ toggles the sidebar instead of reaching the surface", () => {
    let toggled = 0;
    let surfaceSaw = "";
    const router = surfaceRouter({
      onSidebarToggle: () => { toggled += 1; },
      onModalInput: (d) => { surfaceSaw += d; },
    });
    router.handleInput("\x01");
    router.handleInput("\\");
    expect(toggled).toBe(1);
    expect(surfaceSaw).toBe("");
  });

  test("any other chord flushes the prefix and the key to the surface, in order", () => {
    let toggled = 0;
    let surfaceSaw = "";
    const router = surfaceRouter({
      onSidebarToggle: () => { toggled += 1; },
      onModalInput: (d) => { surfaceSaw += d; },
      // Wired, and must not fire: a surface owns everything but the chrome.
      onNewSession: () => { throw new Error("new-session must not fire on a surface"); },
    });
    router.handleInput("\x01");
    router.handleInput("n");
    expect(toggled).toBe(0);
    expect(surfaceSaw).toBe("\x01n");
  });

  test("a bare key still reaches the surface untouched", () => {
    let surfaceSaw = "";
    const router = surfaceRouter({ onModalInput: (d) => { surfaceSaw += d; } });
    router.handleInput("\\");
    expect(surfaceSaw).toBe("\\");
  });

  test("an ordinary modal is not a surface — the chord stays dead there", () => {
    let toggled = 0;
    let modalSaw = "";
    const router = new InputRouter(
      {
        onPtyData: () => {},
        onSidebarClick: () => {},
        onSidebarToggle: () => { toggled += 1; },
        onModalInput: (d) => { modalSaw += d; },
        fullScreenSurfaceActive: () => false,
      },
      baseLayout(24),
    );
    router.setModalOpen(true);
    router.handleInput("\x01");
    router.handleInput("\\");
    expect(toggled).toBe(0);
    expect(modalSaw).toBe("\x01\\");
  });

  test("nothing leaks to the pty while a surface owns input", () => {
    let ptyData = "";
    const router = surfaceRouter({
      onPtyData: (d) => { ptyData += d; },
      onSidebarToggle: () => {},
      onModalInput: () => {},
    });
    router.handleInput("\x01");
    router.handleInput("\\");
    router.handleInput("\x01");
    router.handleInput("n");
    expect(ptyData).toBe("");
  });
});

describe("mouse routing with no sidebar", () => {
  // The whole mouse block used to be gated on `layout.sidebar`, on the reading
  // that null meant "terminal too narrow for chrome". `Ctrl-a \` hides the
  // sidebar with the toolbar and panel still on screen, and that gate sent
  // every click straight to the pty — the buttons, the panel tabs and the
  // divider drag all dead while it was hidden.
  const hiddenLayout = (diffState: "off" | "split" = "off", panelCols = 0): FrameLayout =>
    computeFrameLayout({
      termCols: 120,
      termRows: 40,
      sidebarWidth: 26,
      sidebarHidden: true,
      borderWidth: 1,
      toolbarRows: 1,
      diffState,
      requestedPanelCols: panelCols,
      frameRulesEnabled: false,
      footerEnabled: false,
    });

  test("a toolbar click still dispatches, with main starting at column 0", () => {
    let clickedCol = -1;
    const layout = hiddenLayout();
    expect(layout.sidebar).toBeNull();
    expect(layout.main.x).toBe(0);
    const router = new InputRouter(
      {
        onPtyData: () => {},
        onSidebarClick: () => {},
        onToolbarClick: (col) => { clickedCol = col; },
      },
      layout,
    );
    router.handleInput("\x1b[<0;6;1M"); // gridX 5, toolbar row
    expect(clickedCol).toBe(5);
  });

  test("a click in the leftmost column is content, not a sidebar row", () => {
    let sidebarClicks = 0;
    let ptyData = "";
    const layout = hiddenLayout();
    const router = new InputRouter(
      {
        onPtyData: (d) => { ptyData += d; },
        onSidebarClick: () => { sidebarClicks += 1; },
      },
      layout,
    );
    router.handleInput("\x1b[<0;1;5M"); // gridX 0, a content row
    expect(sidebarClicks).toBe(0);
    // Translated by main.x (0) and contentTop (1), so tmux sees its own row 4.
    expect(ptyData).toBe("\x1b[<0;1;4M");
  });

  test("a click in the panel still reaches the panel", () => {
    let panelFocusToggles = 0;
    const layout = hiddenLayout("split", 40);
    expect(layout.panel).not.toBeNull();
    const router = new InputRouter(
      {
        onPtyData: () => {},
        onSidebarClick: () => {},
        onDiffPanelFocusToggle: () => { panelFocusToggles += 1; },
      },
      layout,
    );
    router.handleInput(`\x1b[<0;${layout.panel!.x + 2};5M`);
    expect(panelFocusToggles).toBe(1);
  });
});

describe("chrome row classification and routing", () => {
  test("classifyRow reads toolbar/rule/content/footer off the layout", () => {
    const layout = chromeLayout(24);
    const router = new InputRouter(
      { onPtyData: () => {}, onSidebarClick: () => {} },
      layout,
    );
    // Sanity-check the fixture actually exercises every chrome row before
    // asserting classification against it.
    expect(layout.topRuleRow).toBe(1);
    expect(layout.footerRuleRow).toBe(38);
    expect(layout.footerRow).toBe(39);
    expect(layout.contentTop).toBe(2);

    expect(router.classifyRow(1)).toBe("toolbar"); // y1=1 -> row 0
    expect(router.classifyRow(layout.topRuleRow! + 1)).toBe("rule");
    expect(router.classifyRow(layout.footerRuleRow! + 1)).toBe("rule");
    expect(router.classifyRow(layout.footerRow! + 1)).toBe("footer");
    expect(router.classifyRow(layout.contentTop + 1)).toBe("content");
  });

  test("a click on the frame-rule row is inert: no toolbar action, nothing forwarded to tmux", () => {
    let toolbarClicked = false;
    let ptyData = "";
    const layout = chromeLayout(24);
    const router = new InputRouter(
      {
        onPtyData: (d) => { ptyData += d; },
        onSidebarClick: () => {},
        onToolbarClick: () => { toolbarClicked = true; },
      },
      layout,
    );
    const mouseX = layout.main.x + 5 + 1; // 1-indexed, arbitrary main-area column
    const mouseY = layout.topRuleRow! + 1; // 1-indexed row of the top rule
    router.handleInput(`\x1b[<0;${mouseX};${mouseY}M`);
    expect(toolbarClicked).toBe(false);
    expect(ptyData).toBe("");
  });

  test("a click on the footer rule row is also inert", () => {
    let ptyData = "";
    const layout = chromeLayout(24);
    const router = new InputRouter(
      {
        onPtyData: (d) => { ptyData += d; },
        onSidebarClick: () => {},
      },
      layout,
    );
    const mouseX = layout.main.x + 3 + 1;
    const mouseY = layout.footerRuleRow! + 1;
    router.handleInput(`\x1b[<0;${mouseX};${mouseY}M`);
    expect(ptyData).toBe("");
  });

  test("a click on the footer row classifies footer and calls onFooterClick with the 0-indexed grid column", () => {
    let footerCol = -1;
    let ptyData = "";
    const layout = chromeLayout(24);
    const router = new InputRouter(
      {
        onPtyData: (d) => { ptyData += d; },
        onSidebarClick: () => {},
        onFooterClick: (col) => { footerCol = col; },
      },
      layout,
    );
    const mouseX = 10; // 1-indexed -> gridX 9
    const mouseY = layout.footerRow! + 1;
    router.handleInput(`\x1b[<0;${mouseX};${mouseY}M`);
    expect(footerCol).toBe(9);
    expect(ptyData).toBe(""); // consumed, not forwarded
  });

  test("footer click over the sidebar's column range still dispatches onFooterClick, not onSidebarClick", () => {
    // The footer band spans the full terminal width (it joins the sidebar
    // divider with a junction glyph — see the chrome-frame plan's Task 6),
    // so a click there is footer chrome even where x falls inside what
    // would otherwise be the sidebar's column range.
    let footerCol = -1;
    let sidebarClicked = false;
    const layout = chromeLayout(24);
    const router = new InputRouter(
      {
        onPtyData: () => {},
        onSidebarClick: () => { sidebarClicked = true; },
        onFooterClick: (col) => { footerCol = col; },
      },
      layout,
    );
    const mouseX = 5; // well inside the 24-wide sidebar's column range
    const mouseY = layout.footerRow! + 1;
    router.handleInput(`\x1b[<0;${mouseX};${mouseY}M`);
    expect(footerCol).toBe(4);
    expect(sidebarClicked).toBe(false);
  });

  test("a content click is forwarded to tmux translated by contentTop, not toolbarRows", () => {
    let ptyData = "";
    const layout = chromeLayout(24); // toolbarRows=1, topRule on -> contentTop=2
    expect(layout.contentTop).toBe(2);
    const router = new InputRouter(
      {
        onPtyData: (d) => { ptyData += d; },
        onSidebarClick: () => {},
      },
      layout,
    );
    const mouseX = layout.main.x + 1; // gridX === layout.main.x
    const mouseY = 3; // terminal row 3 (1-indexed) -> gridY=2, content row 0 given contentTop=2
    router.handleInput(`\x1b[<0;${mouseX};${mouseY}M`);
    // contentTop (2) is what must be subtracted from the raw 1-indexed y —
    // toolbarRows (1) would be off by exactly the top-rule row and forward
    // tmux row 2 instead of 1.
    expect(ptyData).toBe(`\x1b[<0;1;1M`);
  });
});

describe("InfoPanel tab switching", () => {
  test("[ key triggers onPanelPrevTab when panel focused", () => {
    let prevTabCalled = false;
    const router = new InputRouter(
      {
        onPtyData: () => {},
        onSidebarClick: () => {},
        onPanelPrevTab: () => { prevTabCalled = true; },
        onPanelNextTab: () => {},
      },
      baseLayout(24, "split", 40),
    );
    router.setPanelFocused(true);
    router.handleInput("[");
    expect(prevTabCalled).toBe(true);
  });

  test("] key triggers onPanelNextTab when panel focused", () => {
    let nextTabCalled = false;
    const router = new InputRouter(
      {
        onPtyData: () => {},
        onSidebarClick: () => {},
        onPanelPrevTab: () => {},
        onPanelNextTab: () => { nextTabCalled = true; },
      },
      baseLayout(24, "split", 40),
    );
    router.setPanelFocused(true);
    router.handleInput("]");
    expect(nextTabCalled).toBe(true);
  });

  test("[ key passes through when panel not focused", () => {
    let ptyData = "";
    const router = new InputRouter(
      {
        onPtyData: (d) => { ptyData = d; },
        onSidebarClick: () => {},
      },
      baseLayout(24),
    );
    router.handleInput("[");
    expect(ptyData).toBe("[");
  });

  test("action key 'o' triggers onPanelAction when panel focused and tabs active", () => {
    let actionKey = "";
    const router = new InputRouter(
      {
        onPtyData: () => {},
        onSidebarClick: () => {},
        onPanelAction: (key) => { actionKey = key; },
      },
      baseLayout(24, "split", 40),
    );
    router.setPanelFocused(true);
    router.setPanelTabsActive(true);
    router.handleInput("o");
    expect(actionKey).toBe("o");
  });

  test("action key 'C' triggers onPanelAction when panel focused and tabs active", () => {
    let actionKey = "";
    const router = new InputRouter(
      {
        onPtyData: () => {},
        onSidebarClick: () => {},
        onPanelAction: (key) => { actionKey = key; },
      },
      baseLayout(24, "split", 40),
    );
    router.setPanelFocused(true);
    router.setPanelTabsActive(true);
    router.handleInput("C");
    expect(actionKey).toBe("C");
  });

  test("action key 's' triggers onPanelAction when panel focused and tabs active", () => {
    let actionKey = "";
    const router = new InputRouter(
      {
        onPtyData: () => {},
        onSidebarClick: () => {},
        onPanelAction: (key) => { actionKey = key; },
      },
      baseLayout(24, "split", 40),
    );
    router.setPanelFocused(true);
    router.setPanelTabsActive(true);
    router.handleInput("s");
    expect(actionKey).toBe("s");
  });

  test("action keys pass through to diff panel when tabs not active", () => {
    let diffData = "";
    const router = new InputRouter(
      {
        onPtyData: () => {},
        onSidebarClick: () => {},
        onDiffPanelData: (d) => { diffData = d; },
        onPanelAction: () => {},
      },
      baseLayout(24, "split", 40),
    );
    router.setPanelFocused(true);
    // panelTabsActive defaults to false — diff tab is active
    router.handleInput("o");
    expect(diffData).toBe("o");
  });

  test("up arrow triggers onPanelSelectPrev when panel tabs active", () => {
    let called = false;
    const router = new InputRouter(
      {
        onPtyData: () => {},
        onSidebarClick: () => {},
        onPanelSelectPrev: () => { called = true; },
      },
      baseLayout(24, "split", 40),
    );
    router.setPanelFocused(true);
    router.setPanelTabsActive(true);
    router.handleInput("\x1b[A");
    expect(called).toBe(true);
  });

  test("down arrow triggers onPanelSelectNext when panel tabs active", () => {
    let called = false;
    const router = new InputRouter(
      {
        onPtyData: () => {},
        onSidebarClick: () => {},
        onPanelSelectNext: () => { called = true; },
      },
      baseLayout(24, "split", 40),
    );
    router.setPanelFocused(true);
    router.setPanelTabsActive(true);
    router.handleInput("\x1b[B");
    expect(called).toBe(true);
  });

  test("arrows pass through to diff panel when tabs not active", () => {
    let diffData = "";
    const router = new InputRouter(
      {
        onPtyData: () => {},
        onSidebarClick: () => {},
        onDiffPanelData: (d) => { diffData = d; },
        onPanelSelectPrev: () => {},
      },
      baseLayout(24, "split", 40),
    );
    router.setPanelFocused(true);
    // panelTabsActive defaults to false
    router.handleInput("\x1b[A");
    expect(diffData).toBe("\x1b[A");
  });

  test("g key triggers onPanelCycleGroupBy when tabs active", () => {
    let called = false;
    const router = new InputRouter({
      onPtyData: () => {}, onSidebarClick: () => {},
      onPanelCycleGroupBy: () => { called = true; },
    }, baseLayout(24, "split", 40));
    router.setPanelFocused(true);
    router.setPanelTabsActive(true);
    router.handleInput("g");
    expect(called).toBe(true);
  });

  test("/ key triggers onPanelFilterStart and activates filter mode when tabs active", () => {
    let called = false;
    const router = new InputRouter({
      onPtyData: () => {}, onSidebarClick: () => {},
      onPanelFilterStart: () => { called = true; },
    }, baseLayout(24, "split", 40));
    router.setPanelFocused(true);
    router.setPanelTabsActive(true);
    router.handleInput("/");
    expect(called).toBe(true);
  });

  test("S key triggers onPanelCycleSortBy when tabs active", () => {
    let called = false;
    const router = new InputRouter({
      onPtyData: () => {}, onSidebarClick: () => {},
      onPanelCycleSortBy: () => { called = true; },
    }, baseLayout(24, "split", 40));
    router.setPanelFocused(true);
    router.setPanelTabsActive(true);
    router.handleInput("S");
    expect(called).toBe(true);
  });

  test("r key triggers onPanelRefresh when tabs active", () => {
    let called = false;
    const router = new InputRouter({
      onPtyData: () => {}, onSidebarClick: () => {},
      onPanelRefresh: () => { called = true; },
    }, baseLayout(24, "split", 40));
    router.setPanelFocused(true);
    router.setPanelTabsActive(true);
    router.handleInput("r");
    expect(called).toBe(true);
  });

  test("Enter triggers onPanelToggleCollapse when tabs active", () => {
    let called = false;
    const router = new InputRouter({
      onPtyData: () => {}, onSidebarClick: () => {},
      onPanelToggleCollapse: () => { called = true; },
    }, baseLayout(24, "split", 40));
    router.setPanelFocused(true);
    router.setPanelTabsActive(true);
    router.handleInput("\r");
    expect(called).toBe(true);
  });

  test("n key triggers onPanelCreateSession when tabs active", () => {
    let called = false;
    const router = new InputRouter({
      onPtyData: () => {}, onSidebarClick: () => {},
      onPanelCreateSession: () => { called = true; },
    }, baseLayout(24, "split", 40));
    router.setPanelFocused(true);
    router.setPanelTabsActive(true);
    router.handleInput("n");
    expect(called).toBe(true);
  });

  test("l key triggers onPanelLinkToSession when tabs active", () => {
    let called = false;
    const router = new InputRouter({
      onPtyData: () => {}, onSidebarClick: () => {},
      onPanelLinkToSession: () => { called = true; },
    }, baseLayout(24, "split", 40));
    router.setPanelFocused(true);
    router.setPanelTabsActive(true);
    router.handleInput("l");
    expect(called).toBe(true);
  });
});

describe("panel filter mode", () => {
  function makeFilterRouter(overrides: Partial<InputRouterOptions> = {}) {
    const calls: string[] = [];
    const opts: InputRouterOptions = {
      onPtyData: () => { calls.push("pty"); },
      onSidebarClick: () => {},
      onDiffPanelData: (d) => { calls.push(`diff:${d}`); },
      onPanelFilterStart: () => { calls.push("filterStart"); },
      onPanelFilterInput: (c) => { calls.push(`filterInput:${c}`); },
      onPanelFilterBackspace: () => { calls.push("filterBackspace"); },
      onPanelFilterClear: () => { calls.push("filterClear"); },
      onPanelSelectPrev: () => { calls.push("selectPrev"); },
      onPanelSelectNext: () => { calls.push("selectNext"); },
      onPanelAction: (k) => { calls.push(`action:${k}`); },
      onPanelRefresh: () => { calls.push("refresh"); },
      onPanelCycleSortBy: () => { calls.push("cycleSortBy"); },
      ...overrides,
    };
    const router = new InputRouter(opts, baseLayout(24, "split", 40));
    router.setPanelFocused(true);
    router.setPanelTabsActive(true);
    return { router, calls };
  }

  test("printable chars append to filter when filter mode is active", () => {
    const { router, calls } = makeFilterRouter();
    router.handleInput("/"); // enter filter mode
    calls.length = 0;
    router.handleInput("a");
    router.handleInput("b");
    router.handleInput("1");
    expect(calls).toEqual(["filterInput:a", "filterInput:b", "filterInput:1"]);
  });

  test("action keys are captured as filter input, not dispatched as actions", () => {
    const { router, calls } = makeFilterRouter();
    router.handleInput("/");
    calls.length = 0;
    router.handleInput("o"); // normally opens in browser
    router.handleInput("s"); // normally changes status
    router.handleInput("n"); // normally creates session
    expect(calls).toEqual(["filterInput:o", "filterInput:s", "filterInput:n"]);
  });

  test("backspace calls onPanelFilterBackspace in filter mode", () => {
    const { router, calls } = makeFilterRouter();
    router.handleInput("/");
    calls.length = 0;
    router.handleInput("\x7f");
    expect(calls).toEqual(["filterBackspace"]);
  });

  test("bare Esc clears filter and exits filter mode", () => {
    const { router, calls } = makeFilterRouter();
    router.handleInput("/");
    calls.length = 0;
    router.handleInput("\x1b");
    expect(calls).toEqual(["filterClear"]);
    // After Esc, normal keys should go to action handlers, not filter
    calls.length = 0;
    router.handleInput("o");
    expect(calls).toEqual(["action:o"]);
  });

  test("escape sequences (arrow keys) are not treated as bare Esc", () => {
    const { router, calls } = makeFilterRouter();
    router.handleInput("/");
    calls.length = 0;
    router.handleInput("\x1b[A"); // Up arrow — should navigate, not clear
    router.handleInput("\x1b[B"); // Down arrow
    expect(calls).toEqual(["selectPrev", "selectNext"]);
  });

  test("arrow keys navigate the filtered list", () => {
    const { router, calls } = makeFilterRouter();
    router.handleInput("/");
    router.handleInput("a"); // type something
    calls.length = 0;
    router.handleInput("\x1b[A");
    router.handleInput("\x1b[B");
    expect(calls).toEqual(["selectPrev", "selectNext"]);
  });

  test("tab switch clears filter mode", () => {
    const prevTabCalls: string[] = [];
    const { router, calls } = makeFilterRouter({
      onPanelPrevTab: () => { prevTabCalls.push("prevTab"); },
    });
    router.handleInput("/");
    calls.length = 0;
    router.handleInput("[");
    expect(calls).toContain("filterClear");
    expect(prevTabCalls).toEqual(["prevTab"]);
    // After tab switch, should be out of filter mode
    calls.length = 0;
    router.handleInput("o");
    expect(calls).toEqual(["action:o"]);
  });

  test("unrecognized keys are consumed in filter mode, not forwarded", () => {
    const { router, calls } = makeFilterRouter();
    router.handleInput("/");
    calls.length = 0;
    router.handleInput("\x1b[1;2C"); // Shift+Right — not handled in filter mode
    expect(calls).toEqual([]); // consumed, not forwarded
  });

  test("r key is captured as filter input when filter active, not refresh", () => {
    const { router, calls } = makeFilterRouter();
    router.handleInput("/");
    calls.length = 0;
    router.handleInput("r");
    expect(calls).toEqual(["filterInput:r"]);
  });

  test("r key triggers refresh when filter is not active", () => {
    const { router, calls } = makeFilterRouter();
    router.handleInput("r");
    expect(calls).toEqual(["refresh"]);
  });

  test("Enter confirms filter — exits input mode but keeps filter", () => {
    const { router, calls } = makeFilterRouter();
    router.handleInput("/");
    router.handleInput("a");
    calls.length = 0;
    router.handleInput("\r"); // Enter — confirm filter
    // Should NOT call filterClear
    expect(calls).toEqual([]);
    // After Enter, action keys should work normally (not captured as filter input)
    router.handleInput("o");
    expect(calls).toEqual(["action:o"]);
  });

  test("Esc clears a persisted filter after Enter confirmation", () => {
    const { router, calls } = makeFilterRouter();
    router.handleInput("/");
    router.handleInput("a");
    router.handleInput("\r"); // confirm filter
    calls.length = 0;
    router.handleInput("\x1b"); // Esc — clear the persisted filter
    expect(calls).toEqual(["filterClear"]);
    // After clearing, action keys still work
    calls.length = 0;
    router.handleInput("o");
    expect(calls).toEqual(["action:o"]);
  });
});

describe("glass-buffered prefix + Ctrl-a <n>", () => {
  test("Ctrl-a then digit switches tabs and forwards nothing to the tile", () => {
    const sent: string[] = [];
    const switched: number[] = [];
    const router = new InputRouter({
      onPtyData: (d) => sent.push(d),
      onSidebarClick: () => {},
      glassActive: () => true,
      onGlassTabSwitch: (n) => switched.push(n),
    }, baseLayout(26));
    router.handleInput("\x01");
    router.handleInput("2");
    expect(switched).toEqual([2]);
    expect(sent).toEqual([]); // neither byte reached the tile
  });

  test("Ctrl-a then an unrecognized key flushes prefix + key to the tile", () => {
    const sent: string[] = [];
    const router = new InputRouter({
      onPtyData: (d) => sent.push(d),
      onSidebarClick: () => {},
      glassActive: () => true,
    }, baseLayout(26));
    router.handleInput("\x01");
    router.handleInput("k"); // not a glass chord → flushed to the tile
    expect(sent).toEqual(["\x01", "k"]);
  });

  test("Ctrl-a then [ / ] switch to prev/next tab and forward nothing", () => {
    const sent: string[] = [];
    const deltas: number[] = [];
    const router = new InputRouter({
      onPtyData: (d) => sent.push(d),
      onSidebarClick: () => {},
      glassActive: () => true,
      onGlassTabRelative: (delta) => deltas.push(delta),
    }, baseLayout(26));
    router.handleInput("\x01");
    router.handleInput("[");
    router.handleInput("\x01");
    router.handleInput("]");
    expect(deltas).toEqual([-1, 1]);
    expect(sent).toEqual([]); // nothing leaked to the tile
  });

  test("Ctrl-a then d detaches jmux and forwards nothing", () => {
    const sent: string[] = [];
    let detached = 0;
    const router = new InputRouter({
      onPtyData: (d) => sent.push(d),
      onSidebarClick: () => {},
      glassActive: () => true,
      onGlassDetach: () => detached++,
    }, baseLayout(26));
    router.handleInput("\x01");
    router.handleInput("d");
    expect(detached).toBe(1);
    expect(sent).toEqual([]); // buffered prefix dropped, not forwarded
  });
});

describe("glass strip mouse routing", () => {
  // SGR press at row 1 (top), col 30, sidebarWidth 26 → main.x (0-indexed) is
  // 27, gridX is 29, so content x = gridX - main.x = 2. (Pre-Task-3 this used
  // to be computed as `mouse.x - sidebarCols - 1` = 3 — one column off from
  // where glass/view.ts's own 0-indexed tile rects place column 0; see the
  // task report for the corroborating renderer.ts trace.)
  const press = (col: number, row: number) => `\x1b[<0;${col};${row}M`;

  test("a click on the strip row routes to onGlassTabClick", () => {
    const tabClicks: number[] = [];
    const tileClicks: Array<[number, number]> = [];
    const router = new InputRouter({
      onPtyData: () => {},
      onSidebarClick: () => {},
      glassActive: () => true,
      glassStripRows: () => 1,
      onGlassTabClick: (x) => tabClicks.push(x),
      onGlassClick: (x, y) => tileClicks.push([x, y]),
    }, baseLayout(26));
    router.handleInput(press(30, 1)); // row 1 = strip
    expect(tabClicks).toEqual([2]);
    expect(tileClicks).toEqual([]);
  });

  test("a click below the strip routes to the tile with cy offset by strip rows", () => {
    const tileClicks: Array<[number, number]> = [];
    const router = new InputRouter({
      onPtyData: () => {},
      onSidebarClick: () => {},
      glassActive: () => true,
      glassStripRows: () => 1,
      onGlassClick: (x, y) => tileClicks.push([x, y]),
      onGlassTabClick: () => {},
    }, baseLayout(26));
    router.handleInput(press(30, 5)); // row 5: cy = (5-1) - 1 stripRow = 3
    expect(tileClicks).toEqual([[2, 3]]);
  });
});

// Regression test for the stale-geometry bug: main.ts's relayout() updates
// five separate InputRouter setters, and used to be able to leave one out of
// sync after a runtime sidebarWidth change, so the router kept routing
// clicks against the old boundary. setLayout(layout) makes that impossible —
// there is exactly one geometry object, replaced atomically.
describe("setLayout — sidebar/main boundary follows layout, not stale geometry", () => {
  test("a runtime sidebarWidth change moves the sidebar/main click boundary", () => {
    let clickedRow = -1;
    let ptyData = "";
    const router = new InputRouter(
      {
        onPtyData: (d) => { ptyData += d; },
        onSidebarClick: (row) => { clickedRow = row; },
      },
      baseLayout(26),
    );

    // 26-wide sidebar: boundary is at 0-indexed grid col 26 (1-indexed x=27).
    // x=26 (grid col 25) → sidebar; x=28 (grid col 27) → main.
    router.handleInput("\x1b[<0;26;3M");
    expect(clickedRow).toBe(2);
    clickedRow = -1;
    router.handleInput("\x1b[<0;28;3M");
    expect(clickedRow).toBe(-1);
    expect(ptyData.length).toBeGreaterThan(0);

    // Now widen the sidebar to 40 at runtime via setLayout — the boundary
    // must move with it, not stay pinned at the old 26/27 split.
    ptyData = "";
    router.setLayout(baseLayout(40));

    // x=28 (grid col 27) is now inside the wider sidebar.
    router.handleInput("\x1b[<0;28;3M");
    expect(clickedRow).toBe(2);
    clickedRow = -1;
    ptyData = "";

    // x=42 (grid col 41) is now inside main.
    router.handleInput("\x1b[<0;42;3M");
    expect(clickedRow).toBe(-1);
    expect(ptyData.length).toBeGreaterThan(0);
  });
});

// --- Drag handles (sidebar edge, panel divider) ---
//
// SGR button codes used below: 0 = bare left press/release, 32 = motion with
// left held (a drag), 35 = bare motion (hover), 64 = wheel up.

describe("drag handles", () => {
  type DragCalls = {
    moves: Array<{ handle: string; col: number }>;
    commits: Array<{ handle: string; col: number }>;
    cancels: string[];
    focusToggles: number;
    sidebarClicks: number;
    ptyData: string;
    hovers: unknown[];
  };

  function dragRouter(layout: FrameLayout): { router: InputRouter; calls: DragCalls } {
    const calls: DragCalls = {
      moves: [], commits: [], cancels: [], focusToggles: 0,
      sidebarClicks: 0, ptyData: "", hovers: [],
    };
    const router = new InputRouter(
      {
        onPtyData: (d) => { calls.ptyData += d; },
        onSidebarClick: () => { calls.sidebarClicks++; },
        onDiffPanelFocusToggle: () => { calls.focusToggles++; },
        onDragMove: (handle, col) => { calls.moves.push({ handle, col }); },
        onDragCommit: (handle, col) => { calls.commits.push({ handle, col }); },
        onDragCancel: (handle) => { calls.cancels.push(handle); },
        onHover: (t) => { calls.hovers.push(t); },
      },
      layout,
    );
    return { router, calls };
  }

  // 1-indexed mouse coords from a 0-indexed grid column.
  const press = (x: number, y = 10) => `\x1b[<0;${x + 1};${y}M`;
  const release = (x: number, y = 10) => `\x1b[<0;${x + 1};${y}m`;
  const dragTo = (x: number, y = 10) => `\x1b[<32;${x + 1};${y}M`;
  const hoverAt = (x: number, y = 10) => `\x1b[<35;${x + 1};${y}M`;
  const wheelAt = (x: number, y = 10) => `\x1b[<64;${x + 1};${y}M`;

  test("dragging the sidebar border tracks movement then commits", () => {
    const layout = baseLayout(26);
    const { router, calls } = dragRouter(layout);
    router.handleInput(press(layout.borderCol!));
    expect(calls.moves).toHaveLength(0); // a press commits nothing
    router.handleInput(dragTo(40));
    expect(calls.moves).toEqual([{ handle: "sidebar-edge", col: 40 }]);
    router.handleInput(release(40));
    expect(calls.commits).toEqual([{ handle: "sidebar-edge", col: 40 }]);
  });

  test("a drag clamps to the legal sidebar range", () => {
    const layout = baseLayout(26);
    const { router, calls } = dragRouter(layout);
    router.handleInput(press(layout.borderCol!));
    router.handleInput(dragTo(2));   // below the 10-col minimum
    router.handleInput(release(2));
    expect(calls.commits).toEqual([{ handle: "sidebar-edge", col: 10 }]);
  });

  test("press and release on the border with no motion commits nothing", () => {
    const layout = baseLayout(26);
    const { router, calls } = dragRouter(layout);
    router.handleInput(press(layout.borderCol!));
    router.handleInput(release(layout.borderCol!));
    expect(calls.moves).toHaveLength(0);
    expect(calls.commits).toHaveLength(0);
  });

  test("the divider still toggles focus on a click — but on release, not press", () => {
    const layout = diffPanelLayout(26, 40, 30);
    const { router, calls } = dragRouter(layout);
    router.handleInput(press(layout.divider!));
    // The press alone must NOT toggle: it is still ambiguous between a click
    // and the start of a drag.
    expect(calls.focusToggles).toBe(0);
    router.handleInput(release(layout.divider!));
    expect(calls.focusToggles).toBe(1);
    expect(calls.commits).toHaveLength(0);
  });

  test("dragging the divider resizes the panel instead of toggling focus", () => {
    const layout = diffPanelLayout(26, 40, 30);
    const { router, calls } = dragRouter(layout);
    router.handleInput(press(layout.divider!));
    router.handleInput(dragTo(layout.divider! - 10));
    router.handleInput(release(layout.divider! - 10));
    expect(calls.commits).toEqual([
      { handle: "panel-divider", col: layout.divider! - 10 },
    ]);
    expect(calls.focusToggles).toBe(0);
  });

  test("a live drag over the sidebar does not click sessions", () => {
    const layout = baseLayout(26);
    const { router, calls } = dragRouter(layout);
    router.handleInput(press(layout.borderCol!));
    router.handleInput(dragTo(15));
    router.handleInput(dragTo(12));
    router.handleInput(release(12));
    expect(calls.sidebarClicks).toBe(0);
    expect(calls.commits).toEqual([{ handle: "sidebar-edge", col: 12 }]);
  });

  test("a live drag over the main area does not reach the pty", () => {
    const layout = baseLayout(26);
    const { router, calls } = dragRouter(layout);
    router.handleInput(press(layout.borderCol!));
    router.handleInput(dragTo(55));
    router.handleInput(release(55));
    expect(calls.ptyData).toBe("");
  });

  test("a wheel mid-drag cancels it", () => {
    const layout = baseLayout(26);
    const { router, calls } = dragRouter(layout);
    router.handleInput(press(layout.borderCol!));
    router.handleInput(dragTo(40));
    router.handleInput(wheelAt(40));
    expect(calls.cancels).toEqual(["sidebar-edge"]);
    expect(calls.commits).toHaveLength(0);
    // And the drag is over: a later release commits nothing.
    router.handleInput(release(40));
    expect(calls.commits).toHaveLength(0);
  });

  test("a keystroke mid-drag cancels it and still reaches the pty", () => {
    const layout = baseLayout(26);
    const { router, calls } = dragRouter(layout);
    router.handleInput(press(layout.borderCol!));
    router.handleInput(dragTo(40));
    router.handleInput("x");
    expect(calls.cancels).toEqual(["sidebar-edge"]);
    expect(calls.ptyData).toBe("x");
  });

  // A cancel has to say which handle it owned. main.ts persists the width the
  // live resize already applied, and it must not have to infer the handle
  // from hover state — a drag whose pointer was never hovered (or whose hover
  // moved on) still owns a width that needs writing.
  test("a cancel reports the handle it owned, even with no prior hover", () => {
    const layout = diffPanelLayout(26, 40, 30);
    const { router, calls } = dragRouter(layout);
    router.handleInput(press(layout.divider!));
    router.handleInput(dragTo(layout.divider! - 10));
    router.handleInput("q");
    expect(calls.cancels).toEqual(["panel-divider"]);
  });

  test("hovering a handle reports it, and leaving clears it", () => {
    const layout = baseLayout(26);
    const { router, calls } = dragRouter(layout);
    router.handleInput(hoverAt(layout.borderCol!));
    expect(calls.hovers.at(-1)).toEqual({ area: "handle", handle: "sidebar-edge" });
    router.handleInput(hoverAt(50));
    expect(calls.hovers.at(-1)).not.toEqual({ area: "handle", handle: "sidebar-edge" });
  });

  test("a press on a handle is ignored while a modal is open", () => {
    const layout = baseLayout(26);
    const { router, calls } = dragRouter(layout);
    router.setModalOpen(true);
    router.handleInput(press(layout.borderCol!));
    router.handleInput(dragTo(40));
    expect(calls.moves).toHaveLength(0);
  });

  test("full mode has no divider handle to press", () => {
    const layout = baseLayout(26, "full", 90);
    expect(layout.divider).toBeNull();
    const { router, calls } = dragRouter(layout);
    // The column that would be a divider in split mode is just panel content here.
    router.handleInput(press(layout.main.x + 40));
    router.handleInput(dragTo(layout.main.x + 30));
    expect(calls.moves).toHaveLength(0);
    expect(calls.commits).toHaveLength(0);
  });

  // A fast drag makes jmux slow enough (a tmux resize per tracked movement)
  // that the kernel merges several mouse reports into one read. Before this
  // was handled, a merged chunk read as a keystroke: it cancelled the drag
  // mid-gesture and leaked raw escape bytes into the shell.
  test("a merged chunk of motion reports keeps the drag alive", () => {
    const layout = baseLayout(26);
    const { router, calls } = dragRouter(layout);
    router.handleInput(press(layout.borderCol!));
    router.handleInput(dragTo(35) + dragTo(40) + dragTo(45));
    expect(calls.cancels).toEqual([]);
    expect(calls.ptyData).toBe("");
    // Every position in the chunk is tracked, in order — the last one wins.
    expect(calls.moves.map((m) => m.col)).toEqual([35, 40, 45]);
  });

  test("a merged chunk ending in a release commits", () => {
    const layout = baseLayout(26);
    const { router, calls } = dragRouter(layout);
    router.handleInput(press(layout.borderCol!));
    router.handleInput(dragTo(35) + release(38));
    expect(calls.commits).toEqual([{ handle: "sidebar-edge", col: 38 }]);
    expect(calls.cancels).toEqual([]);
  });

  test("an entire gesture merged into one chunk still works, press included", () => {
    // The extreme case: press, every movement and the release all arrive in a
    // single read. Splitting happens before the press is even hit-tested, so
    // the drag starts, tracks and commits normally.
    const layout = baseLayout(26);
    const { router, calls } = dragRouter(layout);
    router.handleInput(
      press(layout.borderCol!) + dragTo(30) + dragTo(35) + dragTo(41) + release(41),
    );
    expect(calls.commits).toEqual([{ handle: "sidebar-edge", col: 41 }]);
    expect(calls.cancels).toEqual([]);
    expect(calls.ptyData).toBe("");
  });

  test("a chunk mixing a mouse report with real keys still cancels", () => {
    const layout = baseLayout(26);
    const { router, calls } = dragRouter(layout);
    router.handleInput(press(layout.borderCol!));
    router.handleInput(dragTo(35));
    router.handleInput(dragTo(40) + "q");
    expect(calls.cancels).toEqual(["sidebar-edge"]);
    // The whole chunk takes its normal path once the drag is gone.
    expect(calls.ptyData).toBe(dragTo(40) + "q");
  });

  test("dragging right and back to the origin still commits the origin width", () => {
    const layout = baseLayout(26);
    const { router, calls } = dragRouter(layout);
    router.handleInput(press(layout.borderCol!));
    router.handleInput(dragTo(45));
    router.handleInput(dragTo(26));
    router.handleInput(release(26));
    expect(calls.commits).toEqual([{ handle: "sidebar-edge", col: 26 }]);
  });
});

describe("parseSgrMouseChunk", () => {
  test("parses a single report", () => {
    expect(parseSgrMouseChunk("\x1b[<0;30;5M")).toEqual([
      { button: 0, x: 30, y: 5, release: false },
    ]);
  });

  test("parses several merged reports in order", () => {
    const events = parseSgrMouseChunk("\x1b[<32;10;5M\x1b[<32;11;5M\x1b[<0;12;5m");
    expect(events).toEqual([
      { button: 32, x: 10, y: 5, release: false },
      { button: 32, x: 11, y: 5, release: false },
      { button: 0, x: 12, y: 5, release: true },
    ]);
  });

  test("returns null when anything else is mixed in", () => {
    expect(parseSgrMouseChunk("\x1b[<0;30;5Mq")).toBeNull();
    expect(parseSgrMouseChunk("q\x1b[<0;30;5M")).toBeNull();
    expect(parseSgrMouseChunk("\x1b[<0;30;5M\x1b[A\x1b[<0;31;5M")).toBeNull();
  });

  test("returns null for input with no reports at all", () => {
    expect(parseSgrMouseChunk("")).toBeNull();
    expect(parseSgrMouseChunk("hello")).toBeNull();
  });
});

// The info panel's list/detail separator is the one horizontal handle: it
// hit-tests on the row and travels vertically. main.ts supplies its geometry
// (the panel owns its own internal row layout; FrameLayout only knows the
// panel's columns), the same way glassStripRows is supplied.
describe("panel split handle", () => {
  const SPLIT = { row: 12, minRow: 6, maxRow: 20 };

  function splitRouter(layout: FrameLayout, split: typeof SPLIT | null = SPLIT) {
    const calls = {
      moves: [] as Array<{ handle: string; pos: number }>,
      commits: [] as Array<{ handle: string; pos: number }>,
      hovers: [] as unknown[],
      itemClicks: [] as number[],
      focusToggles: 0,
    };
    const router = new InputRouter(
      {
        onPtyData: () => {},
        onSidebarClick: () => {},
        panelSplit: () => split,
        onDragMove: (handle, pos) => { calls.moves.push({ handle, pos }); },
        onDragCommit: (handle, pos) => { calls.commits.push({ handle, pos }); },
        onHover: (t) => { calls.hovers.push(t); },
        onPanelItemClick: (row) => { calls.itemClicks.push(row); },
        onDiffPanelFocusToggle: () => { calls.focusToggles++; },
      },
      layout,
    );
    router.setPanelTabsActive(true);
    return { router, calls };
  }

  // 1-indexed mouse coords from 0-indexed grid coords.
  const pressAt = (x: number, y: number) => `\x1b[<0;${x + 1};${y + 1}M`;
  const releaseAt = (x: number, y: number) => `\x1b[<0;${x + 1};${y + 1}m`;
  const dragToRow = (x: number, y: number) => `\x1b[<32;${x + 1};${y + 1}M`;
  const hoverAt = (x: number, y: number) => `\x1b[<35;${x + 1};${y + 1}M`;

  test("dragging the separator tracks the row, not the column", () => {
    const layout = diffPanelLayout(26, 40, 30);
    const x = layout.panel!.x + 5;
    const { router, calls } = splitRouter(layout);
    router.handleInput(pressAt(x, SPLIT.row));
    // Move sideways as well as down — only the row should be reported.
    router.handleInput(dragToRow(x + 9, 16));
    expect(calls.moves).toEqual([{ handle: "panel-split", pos: 16 }]);
    router.handleInput(releaseAt(x + 9, 16));
    expect(calls.commits).toEqual([{ handle: "panel-split", pos: 16 }]);
  });

  test("horizontal-only movement is not a drag — it is still a click", () => {
    const layout = diffPanelLayout(26, 40, 30);
    const x = layout.panel!.x + 5;
    const { router, calls } = splitRouter(layout);
    router.handleInput(pressAt(x, SPLIT.row));
    router.handleInput(dragToRow(x + 12, SPLIT.row)); // same row
    expect(calls.moves).toEqual([]);
  });

  test("the drag clamps to the separator's legal row range", () => {
    const layout = diffPanelLayout(26, 40, 30);
    const x = layout.panel!.x + 5;
    const { router, calls } = splitRouter(layout);
    router.handleInput(pressAt(x, SPLIT.row));
    router.handleInput(dragToRow(x, 0));
    router.handleInput(releaseAt(x, 0));
    expect(calls.commits).toEqual([{ handle: "panel-split", pos: SPLIT.minRow }]);

    const second = splitRouter(layout);
    second.router.handleInput(pressAt(x, SPLIT.row));
    second.router.handleInput(dragToRow(x, 999));
    second.router.handleInput(releaseAt(x, 999));
    expect(second.calls.commits).toEqual([{ handle: "panel-split", pos: SPLIT.maxRow }]);
  });

  test("hovering the separator reports it as a handle", () => {
    const layout = diffPanelLayout(26, 40, 30);
    const { router, calls } = splitRouter(layout);
    router.handleInput(hoverAt(layout.panel!.x + 5, SPLIT.row));
    expect(calls.hovers.at(-1)).toEqual({ area: "handle", handle: "panel-split" });
  });

  test("the same row outside the panel's columns is not the handle", () => {
    const layout = diffPanelLayout(26, 40, 30);
    const { router, calls } = splitRouter(layout);
    // Over the terminal area, on the separator's row.
    router.handleInput(hoverAt(layout.main.x + 2, SPLIT.row));
    expect(calls.hovers.at(-1)).not.toEqual({ area: "handle", handle: "panel-split" });
    router.handleInput(pressAt(layout.main.x + 2, SPLIT.row));
    router.handleInput(dragToRow(layout.main.x + 2, 18));
    expect(calls.moves).toEqual([]);
  });

  test("no separator (diff tab, or a panel too short) means no handle", () => {
    const layout = diffPanelLayout(26, 40, 30);
    const x = layout.panel!.x + 5;
    const { router, calls } = splitRouter(layout, null);
    router.handleInput(hoverAt(x, 12));
    expect(calls.hovers.at(-1)).not.toEqual({ area: "handle", handle: "panel-split" });
    router.handleInput(pressAt(x, 12));
    router.handleInput(dragToRow(x, 16));
    expect(calls.moves).toEqual([]);
    // Falls through to the panel's normal click handling instead.
    expect(calls.itemClicks.length).toBeGreaterThan(0);
  });

  test("clicking the separator focuses the panel, exactly as any other panel press does", () => {
    const layout = diffPanelLayout(26, 40, 30);
    const x = layout.panel!.x + 5;
    const { router, calls } = splitRouter(layout);
    router.handleInput(pressAt(x, SPLIT.row));
    router.handleInput(releaseAt(x, SPLIT.row));
    expect(calls.focusToggles).toBe(1);
    expect(calls.commits).toEqual([]);
  });

  test("clicking the separator when the panel is already focused does not unfocus it", () => {
    // onDiffPanelFocusToggle *toggles*, so the split click has to check first
    // — unlike the divider, this handle only ever acquires focus.
    const layout = diffPanelLayout(26, 40, 30);
    const x = layout.panel!.x + 5;
    const { router, calls } = splitRouter(layout);
    router.setPanelFocused(true);
    router.handleInput(pressAt(x, SPLIT.row));
    router.handleInput(releaseAt(x, SPLIT.row));
    expect(calls.focusToggles).toBe(0);
  });

  test("a press elsewhere in the panel still selects an item", () => {
    const layout = diffPanelLayout(26, 40, 30);
    const { router, calls } = splitRouter(layout);
    router.handleInput(pressAt(layout.panel!.x + 3, SPLIT.row + 4));
    expect(calls.moves).toEqual([]);
    expect(calls.itemClicks.length).toBeGreaterThan(0);
  });
});

// --- Work-pipeline prefix chords ---
//
// The soft prefix intercept swallows whatever byte follows Ctrl-a, so every
// chord added here is a key taken away from tmux. These tests pin both halves:
// the chords jmux claims, and — more importantly — the high-traffic tmux keys
// it must NOT claim. `c` is tmux's new-window and `z` is pane zoom; an earlier
// draft of this feature bound both and silently broke them.

function pipelineRouter(sink: { calls: string[]; pty: string[] }): InputRouter {
  return new InputRouter(
    {
      onPtyData: (d) => { sink.pty.push(d); },
      onSidebarClick: () => {},
      onCaptureIssue: () => { sink.calls.push("capture"); },
      onStartUpNext: () => { sink.calls.push("upnext"); },
      onUndoTransition: () => { sink.calls.push("undo"); },
      onWorkflowScreen: () => { sink.calls.push("workflow"); },
      onSettingsScreen: () => { sink.calls.push("settings"); },
    },
    baseLayout(24),
  );
}

describe("work-pipeline prefix chords", () => {
  const chord = (key: string) => {
    const sink = { calls: [] as string[], pty: [] as string[] };
    const router = pipelineRouter(sink);
    router.handleInput("\x01");
    router.handleInput(key);
    return sink;
  };

  test("Ctrl-a a opens the capture composer", () => {
    expect(chord("a").calls).toEqual(["capture"]);
  });

  test("Ctrl-a u starts the next queued issue", () => {
    expect(chord("u").calls).toEqual(["upnext"]);
  });

  test("Ctrl-a Z undoes the last status write", () => {
    expect(chord("Z").calls).toEqual(["undo"]);
  });

  test("Ctrl-a c is left to tmux (new window), not stolen for capture", () => {
    const sink = chord("c");
    expect(sink.calls).toEqual([]);
    expect(sink.pty.join("")).toContain("c");
  });

  test("Ctrl-a z is left to tmux (pane zoom), not stolen for undo", () => {
    const sink = chord("z");
    expect(sink.calls).toEqual([]);
    expect(sink.pty.join("")).toContain("z");
  });

  test("Ctrl-a W opens the workflow screen", () => {
    expect(chord("W").calls).toEqual(["workflow"]);
  });

  test("Ctrl-a w is left to tmux (choose-tree), not stolen for the workflow screen", () => {
    // Uppercase deliberately: tmux binds `w` by default and jmux has never
    // unbound it, so claiming it would repeat the Ctrl-a c / Ctrl-a z mistake.
    const sink = chord("w");
    expect(sink.calls).toEqual([]);
    expect(sink.pty.join("")).toContain("w");
  });

  test("Ctrl-a I still opens the settings screen alongside it", () => {
    expect(chord("I").calls).toEqual(["settings"]);
  });
});

describe("panel multi-select keys", () => {
  function panelRouter(over: Record<string, unknown> = {}) {
    const calls = { toggle: 0, clearChecks: 0, clearFilter: 0 };
    const router = new InputRouter(
      {
        onPtyData: () => {},
        onSidebarClick: () => {},
        onPanelToggleCheck: () => { calls.toggle++; },
        onPanelClearChecks: () => { calls.clearChecks++; },
        onPanelFilterClear: () => { calls.clearFilter++; },
        ...over,
      } as any,
      baseLayout(24, "split"),
    );
    // The panel key block is gated on keyboard focus *and* real panel geometry.
    router.setPanelFocused(true);
    router.setPanelTabsActive(true);
    return { router, calls };
  }

  test("space toggles the highlighted item", () => {
    const { router, calls } = panelRouter();
    router.handleInput(" ");
    expect(calls.toggle).toBe(1);
  });

  // Escape has two jobs here; the more expensive state goes first.
  test("Escape clears ticks before the filter when ticks exist", () => {
    const { router, calls } = panelRouter({ panelHasChecks: () => true });
    router.handleInput("\x1b");
    expect(calls.clearChecks).toBe(1);
    expect(calls.clearFilter).toBe(0);
  });

  test("Escape clears the filter when nothing is ticked", () => {
    const { router, calls } = panelRouter({ panelHasChecks: () => false });
    router.handleInput("\x1b");
    expect(calls.clearChecks).toBe(0);
    expect(calls.clearFilter).toBe(1);
  });

  test("space does nothing when the panel is not focused", () => {
    const { router, calls } = panelRouter();
    router.setPanelTabsActive(false);
    router.handleInput(" ");
    expect(calls.toggle).toBe(0);
  });
});

// `{` / `}` step the detail pane's preview strip — the queue-tab keys beside
// them, shifted. Same gesture, one level in.
describe("preview strip keys", () => {
  function router(opts: Partial<ConstructorParameters<typeof InputRouter>[0]> = {}) {
    const calls: string[] = [];
    const r = new InputRouter(
      {
        onPtyData: (d) => calls.push(`pty:${d}`),
        onSidebarClick: () => {},
        onPanelPrevPreview: () => calls.push("prev"),
        onPanelNextPreview: () => calls.push("next"),
        ...opts,
      },
      baseLayout(24, "split", 40),
    );
    return { r, calls };
  }

  test("} steps forward when the panel has focus", () => {
    const { r, calls } = router();
    r.setPanelFocused(true);
    r.setPanelTabsActive(true);
    r.handleInput("}");
    expect(calls).toEqual(["next"]);
  });

  test("{ steps back", () => {
    const { r, calls } = router();
    r.setPanelFocused(true);
    r.setPanelTabsActive(true);
    r.handleInput("{");
    expect(calls).toEqual(["prev"]);
  });

  // The Diff tab has no preview strip, so the keys must reach hunk rather than
  // being swallowed by a handler with nothing to act on.
  test("they are not intercepted on the Diff tab", () => {
    const { r, calls } = router();
    r.setPanelFocused(true);
    r.setPanelTabsActive(false);
    r.handleInput("}");
    expect(calls).not.toContain("next");
  });

  test("they reach the pty when the panel is not focused", () => {
    const { r, calls } = router();
    r.setPanelFocused(false);
    r.handleInput("}");
    expect(calls).toEqual(["pty:}"]);
  });
});
