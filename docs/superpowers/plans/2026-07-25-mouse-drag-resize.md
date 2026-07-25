# Mouse Drag Resize Implementation Plan (drag primitive + sidebar/panel resize)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Let the user resize the sidebar by dragging the border column, and the diff/info panel by dragging its divider — with a hover affordance so the handles are discoverable, and a drag preview so no `relayout()` fires mid-drag.

**Architecture:** A new pure module `src/drag.ts` owns a press→motion→release state machine and the layout math that turns a drag column into a width. `InputRouter` hit-tests presses against `layout.borderCol` / `layout.divider` and feeds the machine; while a drag is live it bypasses the entire column-routing ladder. `main.ts` applies commits through the existing `relayout()` + `configStore.set` paths. The renderer gains a hover accent on the two handles and a ghost column during a drag.

**Tech Stack:** Bun 1.3.8+, TypeScript strict, `bun:test`, no bundler.

## Why this is cheap

No new terminal capability is needed. `main.ts:671-673` already enables `?1000h` + `?1003h` + `?1006h`, and `InputRouter.handleInput` already parses button/x/y/release out of every motion event. Drag events arrive today and are discarded:

- Sidebar (`input-router.ts:373`) — `if (!mouse.release && !isMotion)` drops them.
- Main area (`input-router.ts:486`) — only *bare* motion (`button & 3 === 3`) is dropped; held-button motion is already translated and forwarded, which is why tmux's own drag-to-resize-panes works inside jmux today.

`layout.borderCol` is currently **inert**: it is not `< sidebar.w`, so it falls through to main-area routing where `translateMouse` computes `newX === 0` and returns `null`. Clicks there are silently eaten. It is a free handle in exactly the place users expect one.

## Global Constraints

- Target **Bun, not Node**. Pure logic modules; no new deps.
- **Spans are 0-indexed grid columns; the mouse coordinate is 1-indexed and converted once** in `InputRouter` (existing `gridX`/`gridY`).
- **`src/drag.ts` is pure** — no callbacks, no timers, no layout mutation. It takes events and returns intents. `InputRouter` and `main.ts` do the effecting.
- **The continuation-cell rule lives only in `writeCell`** — the ghost column paints through `writeCell`, never by hand-writing cells.
- One accent (`ACCENT_BASE`) means focus and nothing else; the handle hover and the drag ghost both use it, because both mean "this is the thing you are manipulating".
- Pure `bun:test` unit tests over logic modules; **no test spawns tmux**.
- `bun run typecheck` clean; `any` unacceptable.
- `git add` only the files a task changed, by exact filename. Never `git add -A`.
- Never sign off as Claude in git.

## Design decisions worth not relitigating

**Press stops being the commit point for drag-eligible targets.** Today a press on the divider toggles diff-panel focus (`input-router.ts:429`). You cannot know whether a press is a click or the start of a drag until you see motion or a release, so that action moves to release-without-motion. The state machine emits this as a `click` intent, so the divider keeps its focus-toggle behaviour exactly.

**An active drag owns all mouse input.** The pointer will travel over the sidebar, main, and panel during one drag. Ownership is decided once, by where the press landed, and every subsequent mouse event routes to the drag until release — checked before the rule/footer classification and before any column routing.

**Drags leak, so they must be abortable.** If the terminal loses focus or the pointer exits the window, the release never arrives. Any wheel event, any keyboard byte, a modal opening, a terminal resize, or entering glass/settings force-aborts to idle.

**Handles stay exactly one column wide.** Widening to ±1 would steal the sidebar's last content column on one side and tmux's first column on the other. The hover highlight, not a fat hit box, is what makes the handle findable — the same bargain tmux's own pane borders make.

**Promotion to a drag requires horizontal movement.** A press that jiggles vertically is still a click. Both handles are vertical lines, so `x !== originX` is the correct and complete threshold.

**No `relayout()` during the drag.** `relayout()` (`main.ts:1149`) calls `pty.resize()` + `bridge.resize()`, which is a tmux resize plus an xterm.js reflow. At pointer rate that is a lot of churn for an unmeasured benefit. The drag paints a ghost column and commits once on release. Task 7 revisits live resize behind a measurement.

---

### Task 1: The drag state machine in `src/drag.ts`

**Files:**
- Create: `src/drag.ts`
- Test: `src/__tests__/drag.test.ts`

**Interfaces:**
- Consumes: nothing (pure).
- Produces: `DragHandle`, `DragIntent`, `DragController`. Tasks 2–6 consume these.

```ts
/** The two draggable frame handles. Both are single vertical columns. */
export type DragHandle = "sidebar-edge" | "panel-divider";

/**
 * What the caller should do in response to a mouse event. The controller
 * never acts; it classifies. `click` is how a press+release with no motion
 * reaches the handle's non-drag behaviour (the divider's focus toggle).
 */
export type DragIntent =
  | { type: "none" }
  | { type: "click"; handle: DragHandle }
  | { type: "preview"; handle: DragHandle; col: number }
  | { type: "commit"; handle: DragHandle; col: number }
  | { type: "cancel"; handle: DragHandle };
```

`DragController` holds `idle | armed | dragging` internally and exposes:

- `press(handle: DragHandle, col: number): DragIntent` — arms. Always returns `{type:"none"}`.
- `motion(col: number): DragIntent` — `none` while idle or while `col === originCol`; otherwise promotes to dragging and returns `preview`.
- `release(col: number): DragIntent` — from armed returns `click`; from dragging returns `commit`; from idle returns `none`.
- `abort(): DragIntent` — `cancel` if armed or dragging, else `none`. Resets.
- `isActive(): boolean` — true when armed **or** dragging (armed counts: the router must keep ownership through the ambiguous window).
- `ghostCol(): number | null` — the preview column while dragging, else null.

- [x] **Step 1: Write failing tests** in `src/__tests__/drag.test.ts` covering: press alone emits none; press+release emits `click`; press+motion at the same column stays `none`; press+motion to a new column emits `preview`; subsequent motions emit further `preview`s; release after motion emits `commit` with the final column; `abort` mid-drag emits `cancel` and resets; `abort` while idle emits `none`; `motion`/`release` while idle emit `none`; `isActive` is true while armed; `ghostCol` is null while armed and set while dragging.
- [x] **Step 2: Implement** `src/drag.ts` to pass.
- [x] **Step 3: Verify** — `bun test src/__tests__/drag.test.ts` green, `bun run typecheck` clean.

---

### Task 2: Handle hit-testing and width math in `src/drag.ts`

**Files:**
- Modify: `src/drag.ts`
- Test: `src/__tests__/drag.test.ts` (extend)

**Interfaces:**
- Consumes: `FrameLayout` from `src/frame-layout.ts` (type-only import).
- Produces: `hitHandle`, `sidebarWidthForCol`, `panelWidthForCol`. Task 3 uses `hitHandle`; Task 5 uses both width functions.

```ts
/** Which handle, if any, a 0-indexed grid column lands on. */
export function hitHandle(layout: FrameLayout, gridX: number): DragHandle | null;

/** Clamped sidebar width for a drag ending at `gridX`. */
export function sidebarWidthForCol(layout: FrameLayout, gridX: number): number;

/** Clamped panel width for a divider drag ending at `gridX`. */
export function panelWidthForCol(layout: FrameLayout, gridX: number, borderWidth: number): number;
```

The math, stated so it is not re-derived:

- `borderCol === sidebar.x + sidebar.w` and `sidebar.x === 0`, so dragging the border to column `X` means **`sidebarWidth = X`** directly.
- `panel.x === divider + borderWidth` and `panel.x + panel.w === termCols`, so dragging the divider to column `X` means **`panelWidth = termCols - X - borderWidth`**.

Clamps:

- Sidebar: `[10, max(10, min(60, termCols - 40))]`. The `10..60` range matches the existing settings-screen clamp (`main.ts:2657`); the `termCols - 40` term keeps a usable main area on narrow terminals. `SIDEBAR_MIN_TERM_COLS` already guarantees no sidebar at all below 80 cols, so this only ever bites between 80 and 110.
- Panel: `[20, available - 20]`, matching `calcSplitPanelCols` (`main.ts:1067`). `available` is `termCols - main.x`. Duplicating the clamp here is deliberate — it keeps the *preview* from showing a position the commit would refuse.

`hitHandle` returns `"sidebar-edge"` when `layout.borderCol !== null && gridX === layout.borderCol`, `"panel-divider"` when `layout.divider !== null && gridX === layout.divider`, else `null`. Note `layout.divider` is null in `full` mode by construction, so full mode correctly has no divider handle.

- [x] **Step 1: Write failing tests** building real layouts via `computeFrameLayout` (the `baseLayout`/`diffPanelLayout` fixture style already in `src/__tests__/input-router.test.ts`). Cover: border column hits `sidebar-edge`; divider hits `panel-divider`; full mode yields no divider hit; a null sidebar (termCols < 80) yields no hit; sidebar width round-trips (`sidebarWidthForCol(l, l.borderCol) === l.sidebar.w`); panel width round-trips (`panelWidthForCol(l, l.divider, 1) === l.panel.w`); both clamps saturate at each end.
- [x] **Step 2: Implement.**
- [x] **Step 3: Verify** — tests green, typecheck clean.

---

### Task 3: Drag routing in `InputRouter`

**Files:**
- Modify: `src/input-router.ts`
- Test: `src/__tests__/input-router.test.ts` (extend)

**Interfaces:**
- Consumes: `DragController`, `hitHandle` from `src/drag.ts`.
- Produces: new `InputRouterOptions` callbacks `onDragPreview?(handle, col)`, `onDragCommit?(handle, col)`, `onDragCancel?()`; extends the `onHover` target union with `{ area: "handle"; handle: DragHandle }`.

Placement inside `handleInput`, in order:

1. **Before** the `parseSgrMouse` block: if `drag.isActive()` and `data` is not a mouse sequence, `abort()` and dispatch `onDragCancel`, then fall through to normal handling. Keyboard during a drag cancels it rather than being swallowed.
2. **Inside** the mouse block, **before** `classifyRow`: if `drag.isActive()`, route the event to the controller and return — a live drag sees rule rows, footer rows, the sidebar, and main alike. A wheel event here aborts.
3. Press hit-testing goes **after** the link-click check and **before** the `gridX < sidebar.w` sidebar branch, guarded on `!this.modalOpen && !isMotion && !isWheel && !mouse.release && (mouse.button & 0x03) === 0` (bare left press only).
4. The existing divider-press focus toggle (`input-router.ts:429`) is **deleted**; a `click` intent on `panel-divider` now drives `onDiffPanelFocusToggle`.
5. Hover: before the existing `onHover` dispatch, `hitHandle` the column and emit `{ area: "handle", handle }` when it matches, so the renderer can highlight it.

- [x] **Step 1: Write failing tests** extending `src/__tests__/input-router.test.ts`. Cover: a press on `borderCol` followed by motion emits `onDragPreview`; the matching release emits `onDragCommit` with the clamped column; press+release on the divider with no motion still calls `onDiffPanelFocusToggle` and emits no drag callbacks; a drag that travels over the sidebar column range does **not** call `onSidebarClick`; a drag that travels over the main area does **not** forward to `onPtyData`; a wheel mid-drag emits `onDragCancel`; a keypress mid-drag emits `onDragCancel`; hovering `borderCol` emits `{area:"handle"}`; a press on `borderCol` while a modal is open is ignored; presses in `full` mode do not arm a divider drag.
- [x] **Step 2: Implement.**
- [x] **Step 3: Verify** — `bun test src/__tests__/input-router.test.ts` green, typecheck clean.

**One pre-existing test changes, by design.** `"divider click toggles focus"` (`input-router.test.ts:368`) sends a bare press (`\x1b[<0;X;3M`) and asserts the toggle fired. Under the new behaviour that press only *arms*; the toggle fires on the matching release. Update it to send press **and** release, and add a sibling test asserting a press alone does **not** toggle — that pair is what pins the click-vs-drag split in place.

---

### Task 4: Handle hover accent and drag ghost in the renderer

**Files:**
- Modify: `src/renderer.ts`
- Test: `src/__tests__/renderer.test.ts` (extend)

**Interfaces:**
- Consumes: `DragHandle` from `src/drag.ts`.
- Produces: one new trailing optional parameter, on **both** `Renderer.render` (`renderer.ts:646`) and `compositeGrids` (`renderer.ts:379`), which `render` forwards at its `compositeGrids` call (`renderer.ts:662`):

```ts
drag?: { hoveredHandle: DragHandle | null; ghostCol: number | null } | null;
```

A single object rather than two positional booleans — `render` already carries nine positional parameters and two more would be actively hostile to the next reader.

The border column is painted uniformly at `renderer.ts:421` with palette fg 8; the split divider at `renderer.ts:524` via `writeCell(grid, y, dividerCol, frame.divider, tokens.ruleFrame)`. Both gain an accent variant when `hoveredHandle` names them.

The ghost is painted **last**, after all compositing including the rule rows, over the content band only (`layout.contentTop` to `contentTop + contentRows`), as `frame.divider` in the accent. It must not overwrite the toolbar, the rule rows, or the footer — those carry junction glyphs whose continuity is the whole point of the chrome frame.

The parameter defaults to `null`/absent, so every existing call site and snapshot is unchanged.

- [x] **Step 1: Write failing tests** extending `src/__tests__/renderer.test.ts`. Cover: with both params null the composited grid is unchanged from today (guard against snapshot drift); `hoveredHandle: "sidebar-edge"` accents `borderCol` and nothing else; `hoveredHandle: "panel-divider"` accents the divider column; `dragGhostCol: N` paints an accented glyph at column N across the content rows; the ghost does **not** touch `topRuleRow` or row 0.
- [x] **Step 2: Implement.**
- [x] **Step 3: Verify** — `bun test src/__tests__/renderer.test.ts` green, typecheck clean.

---

### Task 5: Wire the drag into `main.ts`

**Files:**
- Modify: `src/main.ts`

**Interfaces:**
- Consumes: `sidebarWidthForCol`, `panelWidthForCol` from `src/drag.ts`; the new `InputRouter` callbacks; the new `compositeGrids` params.

Wiring:

- Module-level `let dragGhostCol: number | null = null;` and `let hoveredHandle: DragHandle | null = null;`, passed together as the new trailing `drag` argument to `renderer.render(...)` in `renderFrame`.
- `onDragPreview: (handle, col) => { dragGhostCol = col; scheduleRender(); }` — the ghost column is the *clamped* column, so the preview never shows an impossible position.
- `onDragCancel: () => { dragGhostCol = null; scheduleRender(); }`.
- `onDragCommit`:
  - `sidebar-edge` → `sidebarWidth = sidebarWidthForCol(layout, col)`, then `relayout()`, then `configStore.set("sidebarWidth", sidebarWidth)`.
  - `panel-divider` → `infoPanelWidth = panelWidthForCol(layout, col, BORDER_WIDTH)`, then `relayout()`, then `configStore.set("infoPanelWidth", infoPanelWidth)`.
  - Clear `dragGhostCol` first in both cases.
- `onHover` gains a `handle` branch setting `hoveredHandle` and clearing sidebar/toolbar hover, matching how the existing branches clear each other.
- Abort the drag from the terminal `resize` handler and from the glass/settings entry points — the layout the drag was hit-tested against no longer exists.

**The config-watcher interaction is already correct and must not be "fixed".** `configStore.set` writes the file, which fires the watcher (`main.ts:3776`). Because we assign the module-level `sidebarWidth` / `infoPanelWidth` **before** writing, the watcher's `needsResize` (`main.ts:3824`) and `prevPanelWidth !== infoPanelWidth` (`main.ts:3837`) both come out false, so no second `relayout()` fires. Setting the module state after the write would cause a visible double-resize.

- [x] **Step 1: Implement** the wiring above.
- [x] **Step 2: Verify** — `bun run typecheck` clean; `bun test` fully green.
- [x] **Step 3: Manual verification** under `bun run dev`: drag the sidebar border left and right (ghost tracks the pointer, commit lands on release, width survives a restart); drag the divider with the diff panel in split mode; single-click the divider (focus toggles, no resize); hover both handles (accent appears, disappears on leave); start a drag and release outside the terminal window (no stuck ghost); drag while a modal is open (nothing happens).

---

### Task 6: Documentation

**Files:**
- Modify: `docs/configuration.md`, `CLAUDE.md`

- [x] **Step 1:** Document in `docs/configuration.md` that `sidebarWidth` and `infoPanelWidth` are now also set by dragging their handles, and that a drag persists to config.
- [x] **Step 2:** Add a short paragraph to `CLAUDE.md` under "Input routing" describing the drag-ownership rule (press decides ownership; a live drag bypasses column routing; press is not the commit point for drag handles). This is the invariant most likely to be broken by a future edit.
- [x] **Step 3: Verify** — prose only; re-read for accuracy against the shipped behaviour.

---

### Task 7 (gated): Live resize instead of ghost — **taken**

Accepted on request after using the ghost build. Live resize replaced the ghost entirely.

- [x] **Step 1:** `relayout()` now runs per tracked movement, coalesced by `scheduleDragResize()` (leading + trailing, `DRAG_RESIZE_INTERVAL_MS = 33`, matching `RENDER_INTERVAL_ACTIVE`). Deliberately *not* hung off `scheduleRender()`'s tick: `renderFrame()` bails while `writesPending > 0`, and a live resize makes tmux chatty, so the resize would be starved exactly when the drag is fastest.
- [x] **Step 2:** Kept. Verified against a real instance — the frame tracks the pointer with no visible stutter at 200x50.

Two consequences that were not obvious before the switch, both now covered by tests:

1. **`applyChromeLayout()` must NOT cancel the drag.** A live drag relayouts on every movement, and every relayout funnels through `applyChromeLayout()` — so the ghost-era placement of `cancelDrag()` there would have aborted each drag on its own first motion. Cancellation moved back to the `SIGWINCH` handler. Mode changes can't strand a drag: reaching them requires a keystroke, which already aborts.
2. **Merged mouse chunks had to be handled.** A live resize is slow enough per event that the kernel merges several mouse reports into a single read. Every mouse path (and `translateMouse`) matches one *anchored* report, so a merged chunk parsed as "not a mouse event" — leaking raw escape bytes into the pty and cancelling the drag mid-gesture. `handleInput` now splits merged chunks via `parseSgrMouseChunk` and re-enters once per report, which also fixes the pre-existing (silent) version of this bug on every other mouse path.

The ghost, `DragController.ghostCol()`, and `DragState.ghostCol` were all removed rather than left dormant. The `preview` intent was renamed `move`, since it no longer previews anything.

---

## Out of scope (deliberately)

- **Sidebar drag-to-reorder.** Order is fully derived from `groupMode × sortMode × filterMode` in `buildRenderPlan` (`sidebar.ts:309`); a manual order is a contradictory third axis that visibly fails to stick under `sortBy: activity`. Groups are derived facts (wtm project basename, live agent state), not user-owned buckets. Coherent reorder requires a `groupBy: "custom"` / `sortBy: "manual"` feature with its own config schema and reconciliation — scope it separately.
- **Drag-to-pin.** The coherent subset of reorder (`Pinned` *is* user-owned, backed by `config.pinnedSessions`). Small and worth doing, but it is a sidebar feature riding on this primitive, not part of it.
- **Toolbar tab reorder via `swap-window`.** The one reorder gesture that fits the model, since tmux window order is genuinely mutable. Also rides on this primitive; separate plan.

---

## As built (2026-07-25)

Tasks 1–6 are implemented and verified; Task 7 remains open by design.

**Deltas from the plan, all additive:**

- `DragController.activeHandle()` — the router must clamp a column *before* feeding it to `motion()`/`release()`, but the intent carrying the handle only comes back afterwards. Without this accessor the router would have to duplicate the handle in its own field, which is exactly the kind of shadow state `setLayout` was introduced to kill.
- `clampDragCol()` and `borderWidthOf()` in `src/drag.ts` — the first keeps preview and commit derived from a single clamp; the second recovers the frame's border width from a built layout, so `InputRouter` doesn't need to be told a constant `computeFrameLayout` was already given.
- `InputRouter.cancelDrag()` is called from **`applyChromeLayout()`**, not from the `SIGWINCH` handler as originally specified. That function is the single funnel every geometry *and* mode change already passes through (relayout, settings enter/exit, glass enter/exit), so one call there covers every stranding case instead of four separate ones.
- `dragChrome()` in `main.ts` feeds all three render paths (normal frame, settings screen, Command Center), since the sidebar edge is draggable wherever the sidebar is drawn.
- Added a property test, *"the preview never lies"*, asserting across every column (including past both clamps) that the ghost column equals the column the handle occupies after commit. This is the invariant the whole feature rests on — if it ever fails, the frame visibly jumps on release.

**Verification.** 1591 unit tests green, `tsc --noEmit` clean. End-to-end behaviour was driven headlessly against a real instance (`--demo`, isolated socket) by sending raw SGR mouse bytes and reading back `capture-pane`:

| Check | Result |
| --- | --- |
| Sidebar drag 26 → 40 | ghost at 40 mid-drag with border still at 26; border at 40 after release |
| Divider drag 136 → 110 | ghost at 110; divider at 110 after release; `infoPanelWidth: 89` (= 200 − 110 − 1) |
| Divider click (no motion) | focus toggled, divider unmoved |
| Hover on / off handle | `\e[38;2;240;136;62m` (ACCENT_BASE) / `\e[90m` |
| Clamps | drag to col 2 → 10; drag to col 190 → 60 |
| Keystroke mid-drag | ghost cleared, later orphaned release committed nothing |
| Drag while palette open | no ghost, no resize |
| Persistence | `sidebarWidth` / `infoPanelWidth` written and reloaded without a double-resize |

## As built, revision 2 (live resize)

Task 7 was taken on request. Deltas beyond the revision-1 notes above:

- `onDragPreview` → `onDragMove`; the `preview` intent → `move`. Nothing is previewed any more, and a name that says otherwise would mislead the next reader.
- `onDragCancel` now carries its handle. It originally inferred one from `hoveredHandle`, which was wrong: a drag that was never hovered (press without a preceding motion event) cancelled without persisting, silently losing the width. Caught in live verification, not by the unit tests — now pinned by one.
- `dragDidResize` guards cancel-persistence, so a stray press-then-keystroke that never moved doesn't rewrite config.
- A cancel keeps the size the drag reached rather than reverting. With a live resize the new size is already on screen, and snapping back on an incidental keystroke would be the surprising outcome.

**Verification.** 1600 unit tests green, `tsc --noEmit` clean. Re-driven end to end against a real instance:

| Check | Result |
| --- | --- |
| Sidebar drag, captured mid-gesture | border tracked to 32 → 38 → 48 with no release sent |
| Divider drag, captured mid-gesture | divider tracked 133 → 113 → 93 live |
| 36 rapid moves, no pauses | landed on the final column, nothing dropped |
| Whole gesture merged into one write | press + 30 moves + release all honoured; no escape leak into the shell |
| Clamp held past the edge | pinned at 10 |
| Keystroke mid-drag | kept the live size and persisted it |
| Stray press + keystroke, no movement | config untouched |
| Divider click, no motion | focus toggled, no resize |

---

## As built, revision 3 (panel list/detail split)

A third handle on request: the horizontal separator between the item list and the detail pane in the Issues / MRs / Review views.

**The drag primitive gained a second axis.** `handleAxis()` says which way each handle travels; the controller tracks a single scalar `pos` (a grid column for `x` handles, a grid row for `y`) rather than a column, because a drag is 1-D either way and duplicating the state machine per axis would be silly. `col` → `pos` throughout — with a horizontal handle the old name was actively wrong. Promotion to a drag now requires movement along *the handle's own* axis, so sliding sideways along the separator is still a click.

**Its geometry is supplied, not derived.** `FrameLayout` knows only the panel's column span; the panel owns its internal row layout. So main.ts passes a `panelSplit` callback returning `{row, minRow, maxRow}` in absolute grid rows — the same shape of dependency as `glassStripRows`. It returns null on the diff tab, with the panel closed, or on a panel too short for a detail pane, and each of those cases falls through to the panel's normal click handling.

**No throttle needed.** Unlike the two width handles this costs only a repaint — the panel grid is rebuilt every frame — so it applies immediately with no `relayout()`, no tmux resize, no `scheduleDragResize()`.

### A pre-existing bug fixed on the way

The band geometry was derived **twice**: once in `renderView` for painting, and again in main.ts for wheel/click hit-testing — with two *different* formulas. main.ts's omitted both the filter-bar row and the max-list clamp, so with a filter active its idea of where the list ended was a row off from what was drawn, and clicks near the boundary mis-routed. This drag made the divergence much worse (a moved split would have left hit-testing pinned at the hardcoded 50%), so the math is now extracted into `computeViewLayout`, which all four former call sites plus the paint and the drag share.

`splitRatioForSepRow` is its exact inverse. `computeViewLayout` rounds rather than floors specifically so that round trip holds — with `floor`, `splittable * (n/splittable)` can land a hair under `n` and a dragged separator would settle one row above the pointer.

**Verification.** 1616 unit tests green, `tsc --noEmit` clean. Driven end to end against a real instance:

| Check | Result |
| --- | --- |
| Drag separator up, captured mid-gesture | tracked 25 → 15 with no release sent |
| Drag separator down | tracked to 35; persisted `infoPanelSplitRatio: 0.7333` (= 33/45) |
| Clamps | pinned at row 5 (3 list rows) and row 43 (4 detail rows) |
| Hover on / off separator | accent applied, then cleared |
| Sideways movement along the separator | stays a click, no resize |
| Click below the moved split | routed to detail — selection untouched (the drift fix) |
| Click above it | selection moved, detail re-rendered |
