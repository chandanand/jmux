# Phase 1c — Settings Screen Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the settings screen legible and honest — every row says what it does, a rejected value says why instead of vanishing, and 27 rows across 7 categories become findable by typing.

**Architecture:** Four independent changes to `src/settings-screen.ts`, plus one to `src/workflow-screen.ts` which consumes the same `SettingDef` contract. `SettingDef.describe` already exists and is ignored here; the explain line reuses the workflow screen's `EXPLAIN_ATTRS` treatment rather than inventing a second one. Search is an explicit `/` mode because bare typing collides with `q` (close) and `d` (clear override).

**Tech Stack:** Bun 1.3.8+, TypeScript strict, `bun:test`, `CellGrid` rendering.

## Global Constraints

- **Wide characters.** Anything written to a `CellGrid` must use `textCols` / `truncateToCols`, never `String.length`. Width-2 cells need a width-0 continuation cell after them. Settings rows carry user data (tracker status names), so this is live, not theoretical.
- **`drawSettingRow` is shared** with `workflow-screen.ts`. Changing its signature means changing both callers.
- **`SettingDef` is shared.** `workflow-screen.ts` consumes `onTextCommit` (`workflow-screen.ts:692-702`) and currently ignores its return value. Task 4 changes that contract, so both screens change together.
- **No mouse.** No full-screen surface handles mouse reports and `InputRouter` has no route for one. Out of scope — see the spec's Known Limits.
- **jmux is a public repo.** No personal paths or credentials.
- **Never attribute work to Claude in git.**
- **Run before claiming done:** `bun run typecheck` and `bun test`.

## Prerequisite

None. This plan is independent of 1a and 1b and can be implemented in any order relative to them.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `src/settings-screen.ts` | **Modify.** Explain line, `/` search, `j/k` + `◂ ▸`, validation display. |
| `src/__tests__/settings-screen.test.ts` | **Create or modify** — check whether it exists first. |
| `src/workflow-screen.ts` | **Modify.** Task 4 only: surface a rejected `onTextCommit`. |
| `src/main.ts` | **Modify.** Task 4: return messages from validating rows. Task 5: topical categories. |

---

## Task 1: Every row says what it does

**Files:**
- Modify: `src/settings-screen.ts:247` (`CONTENT_START_ROW` neighbourhood), `:323-382` (`render`), `:384-404` (`renderHint`)
- Test: `src/__tests__/settings-screen.test.ts`

**Interfaces:**
- Consumes: `SettingDef.describe?: () => string`, which already exists at `settings-screen.ts:85` and is explicitly documented as ignored by this screen.
- Produces: no new exports. Behaviour: one prose line above the hint row, describing the selected row.

- [ ] **Step 1: Check for an existing test file**

Run: `ls src/__tests__/settings-screen.test.ts 2>/dev/null || echo "none"`

If none, create it with this header:

```typescript
import { describe, test, expect } from "bun:test";
import { SettingsScreen, type SettingsCategory, type SettingDef } from "../settings-screen";

function textOf(grid: ReturnType<SettingsScreen["render"]>, row: number): string {
  return grid[row].map((c) => c.char).join("").trimEnd();
}

function category(settings: SettingDef[]): SettingsCategory[] {
  return [{ label: "Display", collapsed: false, settings }];
}

function boolRow(id: string, label: string, describe?: () => string): SettingDef {
  return { id, label, type: "boolean", getValue: () => "on", onToggle: () => {}, describe };
}
```

- [ ] **Step 2: Write the failing test**

```typescript
describe("settings explain line", () => {
  test("shows the selected row's description", () => {
    const s = new SettingsScreen();
    s.open(category([boolRow("a", "Cache timers", () => "Shows how long the cache has been warm.")]));
    s.handleInput("\x1b[B"); // onto the setting, off the category header
    const grid = s.render(80, 24);
    const explain = textOf(grid, 22);
    expect(explain).toContain("Shows how long the cache has been warm.");
  });

  test("is blank for a row with no description", () => {
    const s = new SettingsScreen();
    s.open(category([boolRow("a", "Cache timers")]));
    s.handleInput("\x1b[B");
    expect(textOf(s.render(80, 24), 22)).toBe("");
  });

  test("does not overlap the hint row", () => {
    const s = new SettingsScreen();
    s.open(category([boolRow("a", "Cache timers", () => "A description.")]));
    s.handleInput("\x1b[B");
    const grid = s.render(80, 24);
    expect(textOf(grid, 23)).toContain("navigate");
    expect(textOf(grid, 23)).not.toContain("A description.");
  });

  test("truncates a long description rather than wrapping", () => {
    const long = "x".repeat(500);
    const s = new SettingsScreen();
    s.open(category([boolRow("a", "Cache timers", () => long)]));
    s.handleInput("\x1b[B");
    const grid = s.render(80, 24);
    expect(textOf(grid, 22).length).toBeLessThanOrEqual(80);
    expect(textOf(grid, 21)).not.toContain("x");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test src/__tests__/settings-screen.test.ts -t "explain line"`
Expected: FAIL — row 22 is empty or holds a setting row.

- [ ] **Step 4: Write minimal implementation**

Add the attrs constant beside the others near `settings-screen.ts:113`:

```typescript
const EXPLAIN_ATTRS: CellAttrs = { fg: tokens.textSecondary.fg, fgMode: tokens.textSecondary.fgMode, dim: true };
```

Add it to `TEXT_SECONDARY_ROLE` so `rebuildSettingsColors()` re-themes it:

```typescript
const TEXT_SECONDARY_ROLE: CellAttrs[] = [CATEGORY_ATTRS, HINT_LABEL_ATTRS, EXPLAIN_ATTRS];
```

In `render()`, reserve the row. Replace `const hintRow = rows - 1;` with:

```typescript
    // Two reserved rows at the bottom now: the explain line sits above the
    // hints, matching the workflow screen's layout so the two full-screen
    // surfaces read the same way.
    const hintRow = rows - 1;
    const explainRow = rows - 2;
```

Change the loop bound from `row >= hintRow` to `row >= explainRow`.

After the loop, before `this.renderHint(...)`:

```typescript
    const selected = nodes[this.selectedIndex];
    if (selected?.kind === "setting") {
      const text = selected.setting.describe?.() ?? "";
      if (text) {
        writeString(grid, explainRow, left, truncateToCols(text, Math.max(1, right - left)), EXPLAIN_ATTRS);
      }
    }
```

Update `ensureVisible()`'s reservation from `- 1` to `- 2`:

```typescript
    const visibleCount = Math.max(1, this.lastRenderRows - CONTENT_START_ROW - 2);
```

- [ ] **Step 5: Run tests and commit**

```bash
bun test src/__tests__/settings-screen.test.ts && bun run typecheck
git add src/settings-screen.ts src/__tests__/settings-screen.test.ts
git commit -m "feat(settings): an explain line for the selected row

SettingDef.describe already existed and this screen explicitly ignored it,
so every row was a label and a value with nothing saying what it did. The
workflow screen has had this since it shipped."
```

---

## Task 2: `j/k` and `◂ ▸`

**Files:**
- Modify: `src/settings-screen.ts:287-321` (`handleInput` navigation arm)
- Test: `src/__tests__/settings-screen.test.ts`

**Interfaces:**
- Consumes: `SettingDef.onStep?: (delta: number) => void`, which exists at `:38` and is used by the workflow screen.
- Produces: no new exports.

`j`/`k` work in the setup modal (`setup-modal.ts:133-145`) and the workflow screen. `◂ ▸` drives `onStep` on the workflow screen. Neither works here.

- [ ] **Step 1: Write the failing test**

```typescript
describe("settings navigation parity", () => {
  test("j moves down and k moves up", () => {
    const s = new SettingsScreen();
    s.open(category([boolRow("a", "First"), boolRow("b", "Second")]));
    s.handleInput("j");
    s.handleInput("j");
    const grid = s.render(80, 24);
    // The cursor glyph marks the selected row; "Second" is the third node.
    expect(textOf(grid, 4)).toContain("▸");
    s.handleInput("k");
    expect(textOf(s.render(80, 24), 3)).toContain("▸");
  });

  test("right and left arrows call onStep with +1 and -1", () => {
    const deltas: number[] = [];
    const s = new SettingsScreen();
    s.open(category([{
      id: "n", label: "Count", type: "text",
      getValue: () => "3", onTextCommit: () => {},
      onStep: (d) => deltas.push(d),
    }]));
    s.handleInput("\x1b[B");
    s.handleInput("\x1b[C");
    s.handleInput("\x1b[D");
    expect(deltas).toEqual([1, -1]);
  });

  test("arrows do nothing on a row with no onStep", () => {
    const s = new SettingsScreen();
    s.open(category([boolRow("a", "Cache timers")]));
    s.handleInput("\x1b[B");
    expect(() => s.handleInput("\x1b[C")).not.toThrow();
  });

  test("j and k are not swallowed while editing text", () => {
    let committed = "";
    const s = new SettingsScreen();
    s.open(category([{
      id: "t", label: "Command", type: "text",
      getValue: () => "", onTextCommit: (v) => { committed = v; },
    }]));
    s.handleInput("\x1b[B");
    s.handleInput("\r");      // enter edit mode
    s.handleInput("j");
    s.handleInput("k");
    s.handleInput("\r");      // commit
    expect(committed).toBe("jk");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/settings-screen.test.ts -t "navigation parity"`
Expected: FAIL — `j` does not move; `deltas` is empty.

- [ ] **Step 3: Write minimal implementation**

In `handleInput`, inside the navigation arm only (after the `this.editState` early return, so the editing test above passes untouched), extend the existing arrow cases:

```typescript
    if (data === "\x1b[A" || data === "k") { this.moveUp(); return { type: "none" }; }
    if (data === "\x1b[B" || data === "j") { this.moveDown(); return { type: "none" }; }

    // ◂ ▸ nudge a value one place without opening an editor, for rows on an
    // ordered ladder. Deliberately not how `list` rows work — see the note on
    // SettingDef.onStep.
    if (data === "\x1b[C" || data === "\x1b[D") {
      const node = this.getSelectedNode();
      if (node?.kind === "setting" && node.setting.onStep) {
        node.setting.onStep(data === "\x1b[C" ? 1 : -1);
      }
      return { type: "none" };
    }
```

Note for the implementer: `q` must keep closing the screen and `d` must keep clearing an override. Do **not** add `h`/`l` as step aliases — `l` is not bound here and adding it would pre-empt Task 3's search.

Update `renderHint`'s navigation group so the keys are discoverable:

```typescript
      : [{ key: "↵", label: "edit" }, { key: "/", label: "search" }, { key: "esc", label: "close" }, { key: "↑↓", label: "navigate" }];
```

(The `/` entry lands with Task 3; adding it here keeps one edit to this line.)

- [ ] **Step 4: Run tests and commit**

```bash
bun test src/__tests__/settings-screen.test.ts && bun run typecheck
git add src/settings-screen.ts src/__tests__/settings-screen.test.ts
git commit -m "feat(settings): j/k and step arrows, matching the other surfaces

The setup modal and workflow screen both take j/k, and the workflow screen
drives onStep with the arrows. This screen took neither, so muscle memory
from either of them did nothing here."
```

---

## Task 3: `/` to search

**Files:**
- Modify: `src/settings-screen.ts:217-221` (`EditState`), `:287-321` (`handleInput`), `:828-850` (`buildNodes`), `:384-404` (`renderHint`)
- Test: `src/__tests__/settings-screen.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: no new exports. Behaviour: `/` opens a filter; typing narrows rows to those whose label matches, case-insensitively; `Esc` clears it; `Enter` keeps the filter and moves to the row.

Bare type-to-filter cannot work here: `q` closes the screen and `d` clears an override (`settings-screen.ts:294`, `:310`), so typing "query" would close it on the first keystroke.

- [ ] **Step 1: Write the failing test**

```typescript
describe("settings search", () => {
  const rows = () => category([
    boolRow("a", "Cache timers"),
    boolRow("b", "Inline images in issue previews"),
    boolRow("c", "Sidebar width"),
  ]);

  test("slash opens a filter that narrows the visible rows", () => {
    const s = new SettingsScreen();
    s.open(rows());
    s.handleInput("/");
    for (const ch of "image") s.handleInput(ch);
    const painted = Array.from({ length: 24 }, (_, r) => textOf(s.render(80, 24), r)).join("\n");
    expect(painted).toContain("Inline images");
    expect(painted).not.toContain("Cache timers");
    expect(painted).not.toContain("Sidebar width");
  });

  test("the filter is case-insensitive", () => {
    const s = new SettingsScreen();
    s.open(rows());
    s.handleInput("/");
    for (const ch of "CACHE") s.handleInput(ch);
    const painted = Array.from({ length: 24 }, (_, r) => textOf(s.render(80, 24), r)).join("\n");
    expect(painted).toContain("Cache timers");
  });

  test("escape clears the filter and shows everything again", () => {
    const s = new SettingsScreen();
    s.open(rows());
    s.handleInput("/");
    for (const ch of "cache") s.handleInput(ch);
    s.handleInput("\x1b");
    const painted = Array.from({ length: 24 }, (_, r) => textOf(s.render(80, 24), r)).join("\n");
    expect(painted).toContain("Sidebar width");
  });

  test("q and d are typed into the filter, not treated as close and clear", () => {
    const s = new SettingsScreen();
    s.open(rows());
    s.handleInput("/");
    s.handleInput("q");
    s.handleInput("d");
    expect(s.isOpen).toBe(true);
  });

  test("a filter matching nothing says so", () => {
    const s = new SettingsScreen();
    s.open(rows());
    s.handleInput("/");
    for (const ch of "zzzz") s.handleInput(ch);
    const painted = Array.from({ length: 24 }, (_, r) => textOf(s.render(80, 24), r)).join("\n");
    expect(painted).toContain("No matches");
  });

  test("a category with no matching settings is hidden entirely", () => {
    const s = new SettingsScreen();
    s.open([
      { label: "Display", collapsed: false, settings: [boolRow("a", "Cache timers")] },
      { label: "Integrations", collapsed: false, settings: [boolRow("b", "Issue tracker")] },
    ]);
    s.handleInput("/");
    for (const ch of "tracker") s.handleInput(ch);
    const painted = Array.from({ length: 24 }, (_, r) => textOf(s.render(80, 24), r)).join("\n");
    expect(painted).toContain("Integrations");
    expect(painted).not.toContain("Display");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/settings-screen.test.ts -t "settings search"`
Expected: FAIL — `/` is ignored and `q` closes the screen.

- [ ] **Step 3: Write minimal implementation**

Add the field beside `expandedMaps`:

```typescript
  /**
   * The `/` filter. An explicit mode rather than type-to-filter, because bare
   * typing collides with the navigation keys this screen already binds — `q`
   * closes it and `d` clears an override, so "query" would close the screen on
   * its first keystroke.
   */
  private filter = "";
  private filtering = false;
```

Clear both in `open()` and `close()`.

In `handleInput`'s navigation arm, before the `\x1b`/`q` case:

```typescript
    if (this.filtering) {
      if (data === "\x1b") {
        this.filtering = false;
        this.filter = "";
        this.selectedIndex = 0;
        this.scrollOffset = 0;
        return { type: "none" };
      }
      if (data === "\r") { this.filtering = false; return { type: "none" }; }
      if (data === "\x7f" || data === "\b") {
        this.filter = this.filter.slice(0, -1);
        this.clampSelection();
        return { type: "none" };
      }
      if (data === "\x1b[A") { this.moveUp(); return { type: "none" }; }
      if (data === "\x1b[B") { this.moveDown(); return { type: "none" }; }
      if (data.length === 1 && data.charCodeAt(0) >= 32) {
        this.filter += data;
        this.clampSelection();
        return { type: "none" };
      }
      return { type: "none" };
    }

    if (data === "/") { this.filtering = true; this.filter = ""; return { type: "none" }; }
```

Add the clamp helper beside `moveDown`:

```typescript
  /** Keep the cursor on a real node after the filter changes the node list. */
  private clampSelection(): void {
    const n = this.buildNodes().length;
    if (this.selectedIndex >= n) this.selectedIndex = Math.max(0, n - 1);
    this.scrollOffset = 0;
    this.ensureVisible();
  }
```

Filter inside `buildNodes()`, so navigation, rendering and scrolling all agree by construction — the same discipline as the sidebar's render plan:

```typescript
  private buildNodes(): SettingsNode[] {
    const q = this.filter.trim().toLowerCase();
    const nodes: SettingsNode[] = [];
    for (const cat of this.categories) {
      const settings = q
        ? cat.settings.filter((s) => s.label.toLowerCase().includes(q))
        : cat.settings;
      // A category with nothing matching is dropped whole. Leaving its header
      // would claim a section exists that the filter has emptied.
      if (q && settings.length === 0) continue;
      nodes.push({
        kind: "category",
        label: cat.label,
        collapsed: cat.collapsed,
        count: settings.length,
      });
      // A filter overrides collapse: the user asked to see matches, and a
      // match hidden inside a collapsed section reads as no match at all.
      if (cat.collapsed && !q) continue;
      for (const setting of settings) {
        nodes.push({ kind: "setting", setting });
        if (setting.type === "map" && this.expandedMaps.has(setting.id) && setting.getMapEntries) {
          for (const entry of setting.getMapEntries()) {
            nodes.push({ kind: "map-entry", parentId: setting.id, key: entry.key, value: entry.value });
          }
          nodes.push({ kind: "map-add", parentId: setting.id });
        }
      }
    }
    return nodes;
  }
```

In `render()`, draw the filter line and the empty state. After the header write:

```typescript
    if (this.filtering || this.filter) {
      writeString(grid, 1, left, `/${this.filter}`, LABEL_ACTIVE);
    }
```

And after the row loop, when nothing matched:

```typescript
    if (this.filter && nodes.length === 0) {
      writeString(grid, CONTENT_START_ROW, left + 2, "No matches", DIM_ATTRS);
    }
```

- [ ] **Step 4: Run tests and commit**

```bash
bun test src/__tests__/settings-screen.test.ts && bun run typecheck
git add src/settings-screen.ts src/__tests__/settings-screen.test.ts
git commit -m "feat(settings): / to search across every category

27 rows across 7 categories with no way to find one but scrolling and
already knowing which category it was filed under. An explicit mode rather
than type-to-filter, because bare typing collides with q and d."
```

---

## Task 4: A rejected value says why

**Files:**
- Modify: `src/settings-screen.ts:26` (`SettingDef.onTextCommit`), `:554-559` (commit path), `:445-488` (`renderSetting`)
- Modify: `src/workflow-screen.ts:692-702`
- Modify: `src/main.ts:5988-6048` (the validating rows)
- Test: `src/__tests__/settings-screen.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `onTextCommit?: (value: string) => string | null | void` — a returned string is an error message; `null`/`undefined` is success.

`void` stays in the union so the dozens of existing rows that return nothing keep compiling unchanged. Today `sidebar width: 200` is discarded in silence (`main.ts:5991-5994`) — the same class of defect as the three this whole phase exists to fix, inside the screen meant to fix them.

- [ ] **Step 1: Write the failing test**

```typescript
describe("settings validation feedback", () => {
  function widthRow(): SettingDef {
    return {
      id: "w", label: "Sidebar width", type: "text",
      getValue: () => "26",
      onTextCommit: (v) => {
        const n = parseInt(v, 10);
        if (isNaN(n) || n < 10 || n > 60) return "must be between 10 and 60";
        return null;
      },
    };
  }

  test("a rejected value shows the message on the row", () => {
    const s = new SettingsScreen();
    s.open(category([widthRow()]));
    s.handleInput("\x1b[B");
    s.handleInput("\r");
    for (const ch of "200") s.handleInput(ch);
    s.handleInput("\r");
    const painted = Array.from({ length: 24 }, (_, r) => textOf(s.render(80, 24), r)).join("\n");
    expect(painted).toContain("must be between 10 and 60");
  });

  test("a rejected value keeps the editor open so it can be corrected", () => {
    const s = new SettingsScreen();
    s.open(category([widthRow()]));
    s.handleInput("\x1b[B");
    s.handleInput("\r");
    for (const ch of "200") s.handleInput(ch);
    s.handleInput("\r");
    expect(s.isEditing).toBe(true);
  });

  test("an accepted value closes the editor and shows no message", () => {
    const s = new SettingsScreen();
    s.open(category([widthRow()]));
    s.handleInput("\x1b[B");
    s.handleInput("\r");
    for (const ch of "30") s.handleInput(ch);
    s.handleInput("\r");
    expect(s.isEditing).toBe(false);
    const painted = Array.from({ length: 24 }, (_, r) => textOf(s.render(80, 24), r)).join("\n");
    expect(painted).not.toContain("must be between");
  });

  test("a row whose commit returns nothing still closes the editor", () => {
    const s = new SettingsScreen();
    s.open(category([{
      id: "t", label: "Command", type: "text",
      getValue: () => "", onTextCommit: () => {},
    }]));
    s.handleInput("\x1b[B");
    s.handleInput("\r");
    s.handleInput("x");
    s.handleInput("\r");
    expect(s.isEditing).toBe(false);
  });

  test("escaping a rejected edit clears the message", () => {
    const s = new SettingsScreen();
    s.open(category([widthRow()]));
    s.handleInput("\x1b[B");
    s.handleInput("\r");
    for (const ch of "200") s.handleInput(ch);
    s.handleInput("\r");
    s.handleInput("\x1b");
    const painted = Array.from({ length: 24 }, (_, r) => textOf(s.render(80, 24), r)).join("\n");
    expect(painted).not.toContain("must be between");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/settings-screen.test.ts -t "validation feedback"`
Expected: FAIL — the editor closes and nothing is shown.

- [ ] **Step 3: Write minimal implementation**

Change the type at `settings-screen.ts:26`:

```typescript
  /**
   * Commit a text value. Return a message to **reject** it; return nothing to
   * accept. A rejected commit leaves the editor open with the message on the
   * row, because the alternative — what this screen did — was to discard the
   * value in silence and leave the old one on screen looking applied.
   */
  onTextCommit?: (value: string) => string | null | void;
```

Add the error field beside `filter`:

```typescript
  private commitError: string | null = null;
```

Clear it in `open()`, `close()`, and on `\x1b` in the text-edit arm.

Replace the commit branch at `:554-559`:

```typescript
      if (data === "\r") {
        const setting = this.findSetting(state.settingId);
        const err = setting?.onTextCommit ? setting.onTextCommit(state.buffer) : null;
        if (typeof err === "string" && err.length > 0) {
          this.commitError = err;
          return { type: "none" };   // stay in the editor so it can be fixed
        }
        this.commitError = null;
        this.editState = null;
        return { type: "none" };
      }
```

In `renderTextEdit`, draw the message after the field when present. It shares the row, right-aligned, so no extra row is consumed:

```typescript
    if (this.commitError) {
      const msg = truncateToCols(this.commitError, Math.max(1, right - fieldStart - 2));
      const col = right - textCols(msg);
      if (col > fieldStart) writeString(grid, row, col, msg, OFF_ATTRS);
    }
```

`renderTextEdit` needs `right` — it already receives it.

- [ ] **Step 4: Return messages from the validating rows in `main.ts`**

`sidebar-width` (`:5988`):

```typescript
          onTextCommit: (v) => {
            const n = parseInt(v, 10);
            if (isNaN(n) || n < 10 || n > 60) return "must be a number between 10 and 60";
            configStore.set("sidebarWidth", n);
            return null;
          },
```

`panel-width` (`:5996`) — accepts `auto` as well, so the message must say so:

```typescript
          onTextCommit: (v) => {
            if (v === "auto" || v === "") {
              configStore.set("infoPanelWidth", undefined as any);
              return null;
            }
            const n = parseInt(v, 10);
            if (isNaN(n) || n < 20 || n > 120) return "20–120, or \"auto\"";
            configStore.set("infoPanelWidth", n);
            return null;
          },
```

`image-max-rows` (`:6038`):

```typescript
          onTextCommit: (v) => {
            const n = parseInt(v, 10);
            if (isNaN(n) || n < 1 || n > 60) return "must be a number between 1 and 60";
            configStore.set("images", { ...configStore.config.images, maxRows: n });
            scheduleRender();
            return null;
          },
```

- [ ] **Step 5: Make the workflow screen honour the same contract**

At `workflow-screen.ts:692-702` the commit path ignores the return value. Apply the same treatment: keep the editor open and show the message. If that screen has no error slot, reuse its **explain line** — it already has one, and a message there is read exactly where the user is looking.

- [ ] **Step 6: Run everything and commit**

```bash
bun test && bun run typecheck
git add src/settings-screen.ts src/workflow-screen.ts src/main.ts src/__tests__/settings-screen.test.ts
git commit -m "feat(settings): a rejected value says why instead of vanishing

sidebar width: 200 was parsed, found out of range, and discarded in
silence, leaving the old value on screen looking applied — the same defect
the rest of this phase exists to remove, inside the screen meant to
surface it."
```

---

## Task 5: Orphaned config becomes reachable, filed topically

**Files:**
- Modify: `src/main.ts:5978-6230` (`buildSettingsCategories`)
- Test: none — these are declarative row definitions; correctness is that they appear and edit. Verified manually.

**Interfaces:**
- Consumes: the `describe` support from Task 1 and the validation contract from Task 4.
- Produces: no new exports.

`sessionTitle`, `diffPanel.*`, `agentScreenDetection` and `browser.*` are reachable today only by reading source and hand-editing JSON. They go into **topical categories, not an "Advanced" bucket** — prompt capture is a privacy question, browser isolation a resource one, screen detection a correctness one, and filing them together by how rarely they are touched is a junk drawer.

- [ ] **Step 1: Add a "Session titles" category**

Insert after `Display`:

```typescript
    {
      label: "Session titles",
      collapsed: true,
      settings: [
        {
          id: "title-command", label: "Naming command", type: "text" as const,
          getValue: () => (configStore.config.sessionTitle?.command ?? []).join(" ") || "off",
          getEditValue: () => (configStore.config.sessionTitle?.command ?? []).join(" "),
          describe: () => "Argv jmux runs to name a session; it reads a prompt on stdin and prints a name. Blank turns titling off.",
          onTextCommit: (v: string) => {
            const argv = v.trim().split(/\s+/).filter(Boolean);
            if (argv.length > 0 && Bun.which(argv[0]) === null) return `${argv[0]} is not on PATH`;
            configStore.set("sessionTitle", { ...configStore.config.sessionTitle, command: argv });
            return null;
          },
        },
        {
          id: "title-max-chars", label: "Title length", type: "text" as const,
          getValue: () => String(configStore.config.sessionTitle?.maxChars ?? 32),
          describe: () => "Budget given to the model and the cap applied to its reply. The sidebar shows around twenty columns.",
          onTextCommit: (v: string) => {
            const n = parseInt(v, 10);
            if (isNaN(n) || n < 8 || n > 120) return "must be a number between 8 and 120";
            configStore.set("sessionTitle", { ...configStore.config.sessionTitle, maxChars: n });
            return null;
          },
        },
      ],
    },
```

- [ ] **Step 2: Add a "Diff panel" category**

```typescript
    {
      label: "Diff panel",
      collapsed: true,
      settings: [
        {
          id: "diff-watch", label: "Follow the working tree", type: "boolean" as const,
          getValue: () => configStore.config.diffPanel?.watch !== false ? "on" : "off",
          describe: () => "Launches hunk with --watch so the panel follows edits instead of being a snapshot.",
          onToggle: () => configStore.set("diffPanel", {
            ...configStore.config.diffPanel,
            watch: configStore.config.diffPanel?.watch === false,
          }),
        },
        {
          id: "diff-control-plane", label: "Diff stats and review notes", type: "boolean" as const,
          getValue: () => configStore.config.diffPanel?.controlPlane !== false ? "on" : "off",
          describe: () => "Talks to hunk's session daemon. Off falls back to the behaviour jmux had before the daemon existed.",
          onToggle: () => configStore.set("diffPanel", {
            ...configStore.config.diffPanel,
            controlPlane: configStore.config.diffPanel?.controlPlane === false,
          }),
        },
        {
          id: "diff-clear-notes", label: "Clear notes once sent", type: "boolean" as const,
          getValue: () => configStore.config.diffPanel?.clearNotesOnSend ? "on" : "off",
          describe: () => "Keeps the note badge meaning \"written but not yet sent\". Off keeps them as a record.",
          onToggle: () => configStore.set("diffPanel", {
            ...configStore.config.diffPanel,
            clearNotesOnSend: !configStore.config.diffPanel?.clearNotesOnSend,
          }),
        },
      ],
    },
```

- [ ] **Step 3: Add `agentScreenDetection` to the existing Integrations category**

```typescript
        {
          id: "agent-screen-detection", label: "Detect agent state from pane text", type: "boolean" as const,
          getValue: () => configStore.config.agentScreenDetection ? "on" : "off",
          describe: () => "Last resort for agents with no hook integration. Off by default: a screen guess can be confidently wrong where a hook cannot.",
          onToggle: () => configStore.set("agentScreenDetection", !configStore.config.agentScreenDetection),
        },
```

- [ ] **Step 4: Add a "Browser panes" category**

```typescript
    {
      label: "Browser panes",
      collapsed: true,
      settings: [
        {
          id: "browser-isolate", label: "One daemon per pane", type: "boolean" as const,
          getValue: () => configStore.config.browser?.isolate !== false ? "on" : "off",
          describe: () => "Off makes every browser pane share one daemon, which makes them all draw the same page.",
          onToggle: () => configStore.set("browser", {
            ...configStore.config.browser,
            isolate: configStore.config.browser?.isolate === false,
          }),
        },
        {
          id: "browser-pane-size", label: "Pane size", type: "text" as const,
          getValue: () => String(configStore.config.browser?.paneSize ?? 0.5),
          describe: () => "Fraction of the current pane a browser pane takes.",
          onTextCommit: (v: string) => {
            const n = parseFloat(v);
            if (isNaN(n) || n < 0.2 || n > 0.95) return "must be between 0.2 and 0.95";
            configStore.set("browser", { ...configStore.config.browser, paneSize: n });
            return null;
          },
        },
        {
          id: "browser-display-scale", label: "Display scale", type: "text" as const,
          getValue: () => String(configStore.config.browser?.displayScale ?? "auto"),
          describe: () => "Chooses which layout a page picks. \"auto\" follows the terminal.",
          onTextCommit: (v: string) => {
            if (v.trim() === "auto") {
              configStore.set("browser", { ...configStore.config.browser, displayScale: "auto" });
              return null;
            }
            const n = parseFloat(v);
            if (isNaN(n) || n <= 0) return "a positive number, or \"auto\"";
            configStore.set("browser", { ...configStore.config.browser, displayScale: n });
            return null;
          },
        },
        {
          id: "browser-fps", label: "Frame rate", type: "text" as const,
          getValue: () => String(configStore.config.browser?.fps ?? "auto"),
          describe: () => "Frames per second a browser pane redraws at. \"auto\" lets jmux choose.",
          onTextCommit: (v: string) => {
            if (v.trim() === "auto") {
              configStore.set("browser", { ...configStore.config.browser, fps: "auto" });
              return null;
            }
            const n = parseInt(v, 10);
            if (isNaN(n) || n < 1 || n > 120) return "1–120, or \"auto\"";
            configStore.set("browser", { ...configStore.config.browser, fps: n });
            return null;
          },
        },
      ],
    },
```

Note for the implementer: check each field's documented range in `src/config.ts` (`BrowserConfig`, `:197`–`:252`) and use the range the comment states if it differs from the bounds above — the comment is the source of truth, and a settings row that rejects a value the loader accepts is its own bug.

- [ ] **Step 5: Verify manually**

```bash
bun run dev
```

`Ctrl-a i`, then `/` and search for `title`, `diff`, `browser`, `pane text`. Each new row appears, its explain line reads sensibly, and editing one persists to `~/.config/jmux/config.json`. Set the naming command to something not on `PATH` and confirm the row rejects it with a message rather than storing it.

- [ ] **Step 6: Run everything and commit**

```bash
bun test && bun run typecheck
git add src/main.ts
git commit -m "feat(settings): surface config that was source-only

sessionTitle, diffPanel, agentScreenDetection and browser were reachable
only by reading the source and hand-editing JSON. Filed by topic rather
than into an Advanced bucket: these differ in kind — privacy, resource
use, correctness — and grouping them by how rarely they are touched is a
junk drawer."
```

---

## Done criteria

- [ ] `bun test` passes in full.
- [ ] `bun run typecheck` is clean.
- [ ] `/` finds a row in a collapsed category.
- [ ] `sidebar width: 200` shows a message and keeps the editor open.
- [ ] Every row reachable by `/` has a non-empty explain line, or is one whose label is self-evident (`Sidebar width`).
