import { describe, test, expect } from "bun:test";
import { Sidebar } from "../sidebar";
import type { PinnedPaneEntry } from "../sidebar";
import type { SessionInfo } from "../types";
import { makeSessionOtelState } from "../types";
import type { SessionContext, PipelineStatus } from "../adapters/types";
import type { SessionWorkflow } from "../workflow-drift";
import { tokens, frame } from "../chrome-tokens";
import { resolveStateColors } from "../state-colors";

const SIDEBAR_WIDTH = 24;
const makeBlankOtelState = makeSessionOtelState;

function makeSessions(
  entries: Array<{ name: string; directory?: string; gitBranch?: string; project?: string }>,
): SessionInfo[] {
  return entries.map((e, i) => ({
    id: `$${i}`,
    name: e.name,
    attached: i === 0,
    activity: 0,
    windowCount: 1,
    directory: e.directory,
    gitBranch: e.gitBranch,
    project: e.project,
  }));
}

function rowText(grid: ReturnType<Sidebar["getGrid"]>, row: number, width = SIDEBAR_WIDTH): string {
  return Array.from({ length: width }, (_, i) => grid.cells[row][i].char).join("");
}

describe("Sidebar", () => {
  test("renders header row with the group + sort chips", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(makeSessions([{ name: "main" }]));
    const grid = sidebar.getGrid();
    const header = Array.from({ length: SIDEBAR_WIDTH }, (_, i) => grid.cells[0][i].char).join("");
    // Defaults: group by project, sort by name — chips lead the header, no "Sessions" word.
    expect(header).toContain("⊞ Project");
    expect(header).toContain("⇅ Name");
    expect(header).not.toContain("Sessions");
  });

  test("header shows a right-aligned agent-state rollup", () => {
    // Wide enough for the label + sort control + the full three-segment tally.
    const sidebar = new Sidebar(40, 30);
    sidebar.updateSessions(makeSessions([
      { name: "a" }, { name: "b" }, { name: "c" }, { name: "d" },
    ]));
    const now = Date.now();
    sidebar.setAgentStateRecord("$0", { state: "running", since: now });
    sidebar.setAgentStateRecord("$1", { state: "running", since: now });
    sidebar.setAgentStateRecord("$2", { state: "waiting", since: now });
    sidebar.setAgentStateRecord("$3", { state: "complete", since: now });
    const grid = sidebar.getGrid();
    const header = Array.from({ length: 40 }, (_, i) => grid.cells[0][i].char).join("");
    // running / waiting / complete counts with the row indicators' glyphs.
    expect(header).toContain("2⏵");
    expect(header).toContain("1!");
    expect(header).toContain("1✓");
    // The control chips are untouched on the left.
    expect(header).toContain("⊞ Project");
  });

  test("header rollup omits states with no sessions, and vanishes when none are promoted", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(makeSessions([{ name: "a" }, { name: "b" }]));
    // Nothing promoted → no rollup; header is just the group + sort chips.
    let header = Array.from({ length: SIDEBAR_WIDTH }, (_, i) => sidebar.getGrid().cells[0][i].char).join("");
    expect(header).toContain("⊞");
    expect(header).toContain("⇅");
    expect(header).not.toContain("⏵"); // no rollup counts
    expect(header).not.toContain("✓");

    // Only running present → only the running segment appears.
    sidebar.setAgentStateRecord("$0", { state: "running", since: Date.now() });
    header = Array.from({ length: SIDEBAR_WIDTH }, (_, i) => sidebar.getGrid().cells[0][i].char).join("");
    expect(header).toContain("1⏵");
    expect(header).not.toContain("!");
    expect(header).not.toContain("✓");
  });

  test("renders ungrouped sessions without a group header", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(
      makeSessions([
        { name: "alpha", directory: "~/one" },
        { name: "beta", directory: "~/two" },
      ]),
    );
    const grid = sidebar.getGrid();
    // No shared parent → ungrouped. Overview block at rows 2-3, sessions start at row 4.
    const row4 = Array.from(
      { length: SIDEBAR_WIDTH },
      (_, i) => grid.cells[4][i].char,
    ).join("");
    expect(row4).toContain("alpha");
  });

  test("groups sessions sharing a parent directory", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(
      makeSessions([
        { name: "api", directory: "~/Code/work/api" },
        { name: "frontend", directory: "~/Code/work/frontend" },
        { name: "scratch", directory: "/tmp" },
      ]),
    );
    const grid = sidebar.getGrid();
    // Row 2: overview, Row 3: spacer, Row 4: group header "Code/work"
    const headerRow = Array.from(
      { length: SIDEBAR_WIDTH },
      (_, i) => grid.cells[4][i].char,
    ).join("");
    expect(headerRow).toContain("Code/work");
    // Row 5: spacer, Row 6: first session in group "api"
    const apiRow = Array.from(
      { length: SIDEBAR_WIDTH },
      (_, i) => grid.cells[6][i].char,
    ).join("");
    expect(apiRow).toContain("api");
  });

  test("solo sessions in a directory still show group header", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(
      makeSessions([
        { name: "only-one", directory: "~/Code/work/only-one" },
        { name: "other", directory: "~/somewhere/other" },
      ]),
    );
    const grid = sidebar.getGrid();
    // Both have valid group labels → both get group headers
    // Row 2: overview, Row 3: spacer, Row 4: first group header
    const row4 = Array.from(
      { length: SIDEBAR_WIDTH },
      (_, i) => grid.cells[4][i].char,
    ).join("");
    expect(row4).toContain("Code/work");
  });

  test("grouped sessions show no branch on the detail line", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(
      makeSessions([
        {
          name: "api",
          directory: "~/Code/work/api",
          gitBranch: "main",
        },
        {
          name: "web",
          directory: "~/Code/work/web",
          gitBranch: "feat/x",
        },
      ]),
    );
    const grid = sidebar.getGrid();
    // Row 2: overview, Row 3: spacer, Row 4: group header, Row 5: spacer, Row 6: api name, Row 7: api detail
    const detailRow = Array.from(
      { length: SIDEBAR_WIDTH },
      (_, i) => grid.cells[7][i].char,
    ).join("");
    // The branch left the sidebar entirely — it was only ever visible as row
    // 1's name, and with no title it falls back to the real session name there.
    expect(detailRow).not.toContain("main");
    expect(detailRow).not.toContain("Code/work");
  });

  test("ungrouped sessions show no branch on the detail line", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(
      makeSessions([
        { name: "solo", directory: "~/mydir", gitBranch: "dev" },
      ]),
    );
    const grid = sidebar.getGrid();
    // Row 2: overview, Row 3: spacer, Row 4: session name, Row 5: detail
    const detailRow = Array.from(
      { length: SIDEBAR_WIDTH },
      (_, i) => grid.cells[5][i].char,
    ).join("");
    expect(detailRow).not.toContain("dev");
  });

  test("highlights active session with an accent marker", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(
      makeSessions([{ name: "main" }, { name: "dev" }]),
    );
    sidebar.setActiveSession("$0");
    const grid = sidebar.getGrid();
    // Find the active session's name row and check for marker
    let marker: (typeof grid.cells)[number][number] | null = null;
    for (let r = 2; r < 20; r++) {
      if (grid.cells[r][0].char === "▎") {
        marker = grid.cells[r][0];
        break;
      }
    }
    expect(marker).not.toBeNull();
    // The rail is the accent, not palette-2 green.
    expect(marker!.fg).toBe(tokens.accent.fg!);
    expect(marker!.fgMode).toBe(tokens.accent.fgMode!);
    expect(marker!.fg).not.toBe(2);
  });

  test("selected row's name renders textPrimary bold, not palette-2 green", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    // Ungrouped sessions render alphabetically ("alpha" before "bravo"), so
    // "alpha" (id $0) is the first session row.
    sidebar.updateSessions(
      makeSessions([{ name: "alpha" }, { name: "bravo" }]),
    );
    sidebar.setActiveSession("$0");
    const grid = sidebar.getGrid();
    // Row 4: first session's name row; name text starts at col 3.
    const cell = grid.cells[4][3];
    expect(cell.char).toBe("a"); // sanity: this is "alpha"'s name row
    expect(cell.fg).toBe(tokens.textPrimary.fg!);
    expect(cell.fgMode).toBe(tokens.textPrimary.fgMode!);
    expect(cell.fg).not.toBe(2);
    expect(cell.bold).toBe(true);
  });

  test("shows activity indicator", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(makeSessions([{ name: "main" }]));
    sidebar.setActivity("$0", true);
    const grid = sidebar.getGrid();
    let foundDot = false;
    for (let r = 2; r < 20; r++) {
      if (grid.cells[r][1].char === "●") {
        foundDot = true;
        break;
      }
    }
    expect(foundDot).toBe(true);
  });

  test("activity indicator is neutral (tokens.textTertiary), not green", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(makeSessions([{ name: "main" }]));
    sidebar.setActivity("$0", true);
    const grid = sidebar.getGrid();
    let cell: (typeof grid.cells)[number][number] | null = null;
    for (let r = 2; r < 20; r++) {
      if (grid.cells[r][1].char === "●") {
        cell = grid.cells[r][1];
        break;
      }
    }
    expect(cell).not.toBeNull();
    expect(cell!.fg).toBe(tokens.textTertiary.fg!);
    expect(cell!.fgMode).toBe(tokens.textTertiary.fgMode!);
    expect(cell!.fg).not.toBe(2);
    expect(cell!.dim).toBe(tokens.textTertiary.dim!);
  });

  test("shows waiting glyph when agent state is waiting", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    const sessions = makeSessions([{ name: "main" }]);
    sidebar.updateSessions(sessions);
    sidebar.setAgentStateRecord("$0", { state: "waiting", since: Date.now() });
    const grid = sidebar.getGrid();
    let foundBang = false;
    for (let r = 2; r < 20; r++) {
      if (grid.cells[r][1].char === "!") {
        foundBang = true;
        break;
      }
    }
    expect(foundBang).toBe(true);
  });

  test("applies configured state color to the waiting indicator, preserving bold", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.setStateColors({
      running: { kind: "palette", index: 6 },
      waiting: { kind: "palette", index: 9 },
      complete: { kind: "palette", index: 7 },
    });
    sidebar.updateSessions(makeSessions([{ name: "main" }]));
    sidebar.setAgentStateRecord("$0", { state: "waiting", since: Date.now() });
    const grid = sidebar.getGrid();
    let cell: (typeof grid.cells)[number][number] | null = null;
    for (let r = 2; r < 20; r++) {
      if (grid.cells[r][1].char === "!") {
        cell = grid.cells[r][1];
        break;
      }
    }
    expect(cell).not.toBeNull();
    expect(cell!.fg).toBe(9); // configured brightred
    expect(cell!.bold).toBe(true); // emphasis preserved
  });

  test("defaults waiting indicator to palette yellow when unconfigured", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(makeSessions([{ name: "main" }]));
    sidebar.setAgentStateRecord("$0", { state: "waiting", since: Date.now() });
    const grid = sidebar.getGrid();
    for (let r = 2; r < 20; r++) {
      if (grid.cells[r][1].char === "!") {
        expect(grid.cells[r][1].fg).toBe(3); // yellow default
        return;
      }
    }
    throw new Error("waiting indicator not found");
  });

  test("renders red error glyph when lastError is set, overriding agent-state/activity", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(makeSessions([{ name: "main" }]));
    sidebar.setAgentStateRecord("$0", { state: "waiting", since: Date.now() });
    sidebar.setActivity("$0", true);
    sidebar.setSessionOtelState("$0", {
      ...makeBlankOtelState(),
      lastError: { type: "api_error", timestamp: Date.now() },
    });
    const grid = sidebar.getGrid();

    // Row 2: overview, Row 3: spacer, Row 4: session name row
    expect(grid.cells[4][1].char).toBe("⨯"); // ⨯
    expect(grid.cells[4][1].fg).toBe(1); // palette red
    expect(grid.cells[4][1].bold).toBe(true);
  });

  test("renders MCP-down glyph when failedMcpServers is non-empty, overriding agent-state", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(makeSessions([{ name: "main" }]));
    sidebar.setAgentStateRecord("$0", { state: "running", since: Date.now() });
    sidebar.setSessionOtelState("$0", {
      ...makeBlankOtelState(),
      failedMcpServers: new Set(["linear"]),
    });
    const grid = sidebar.getGrid();

    // Row 2: overview, Row 3: spacer, Row 4: session name row
    expect(grid.cells[4][1].char).toBe("⊘"); // ⊘
    expect(grid.cells[4][1].fg).toBe(1);
    expect(grid.cells[4][1].dim).toBe(true);
  });

  test("error glyph wins over MCP-down", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(makeSessions([{ name: "main" }]));
    sidebar.setSessionOtelState("$0", {
      ...makeBlankOtelState(),
      lastError: { type: "api_error", timestamp: Date.now() },
      failedMcpServers: new Set(["linear"]),
    });
    const grid = sidebar.getGrid();

    // Row 2: overview, Row 3: spacer, Row 4: session name row
    expect(grid.cells[4][1].char).toBe("⨯"); // ⨯
  });

  test("getDisplayOrderIds returns sessions in grouped display order", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(
      makeSessions([
        { name: "c" },
        { name: "a" },
        { name: "b" },
      ]),
    );
    const ids = sidebar.getDisplayOrderIds();
    // Ungrouped, sorted alphabetically by name
    expect(ids).toEqual(["$1", "$2", "$0"]); // a, b, c
  });

  test("getSessionByRow returns correct session for click handling", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(
      makeSessions([
        { name: "api", directory: "~/Code/work/api" },
        { name: "web", directory: "~/Code/work/web" },
      ]),
    );
    sidebar.getGrid(); // must render to populate row map

    // Row 2: overview → null
    expect(sidebar.getSessionByRow(2)).toBeNull();
    // Row 3: spacer → null
    expect(sidebar.getSessionByRow(3)).toBeNull();
    // Row 4: group header → null
    expect(sidebar.getSessionByRow(4)).toBeNull();
    // Row 5: spacer → null
    expect(sidebar.getSessionByRow(5)).toBeNull();
    // Row 6: first session name row → api
    expect(sidebar.getSessionByRow(6)?.name).toBe("api");
    // Row 7: first session detail row → api
    expect(sidebar.getSessionByRow(7)?.name).toBe("api");
  });

  test("scrolls to show active session when it overflows", () => {
    // Height 10 = 2 header rows + 8 viewport rows
    // Overview block = 2 rows (overview + spacer), each session = 3 rows + 1 spacer
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 10);
    sidebar.updateSessions(
      makeSessions([
        { name: "a" },
        { name: "b" },
        { name: "c" },
        { name: "d" },
      ]),
    );
    // Activate last session and scroll to it
    sidebar.setActiveSession("$3");
    sidebar.scrollToActive();
    const grid = sidebar.getGrid();
    // "d" should be visible somewhere in the grid
    let found = false;
    for (let r = 2; r < 10; r++) {
      const text = Array.from(
        { length: SIDEBAR_WIDTH },
        (_, i) => grid.cells[r][i].char,
      ).join("");
      if (text.includes("d")) {
        found = true;
        break;
      }
    }
    expect(found).toBe(true);
  });

  test("scrollBy moves viewport and clamps to bounds", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 10);
    sidebar.updateSessions(
      makeSessions([
        { name: "a" },
        { name: "b" },
        { name: "c" },
        { name: "d" },
      ]),
    );
    // Overview at row 2, spacer at row 3, first session "a" at row 4
    let grid = sidebar.getGrid();
    const row4 = Array.from(
      { length: SIDEBAR_WIDTH },
      (_, i) => grid.cells[4][i].char,
    ).join("");
    expect(row4).toContain("a");

    // Scroll down past "a"
    sidebar.scrollBy(3);
    grid = sidebar.getGrid();
    // "a" should no longer be visible on row 4
    const row4After = Array.from(
      { length: SIDEBAR_WIDTH },
      (_, i) => grid.cells[4][i].char,
    ).join("");
    expect(row4After).not.toContain("a");

    // Scroll way past the top — should clamp to 0
    sidebar.scrollBy(-100);
    grid = sidebar.getGrid();
    const row4Reset = Array.from(
      { length: SIDEBAR_WIDTH },
      (_, i) => grid.cells[4][i].char,
    ).join("");
    expect(row4Reset).toContain("a");
  });

  test("shows scroll indicators when content overflows", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 10);
    sidebar.updateSessions(
      makeSessions([
        { name: "a" },
        { name: "b" },
        { name: "c" },
        { name: "d" },
      ]),
    );
    // At top: should show down indicator but not up
    let grid = sidebar.getGrid();
    expect(grid.cells[2][SIDEBAR_WIDTH - 1].char).not.toBe("▲");
    expect(grid.cells[9][SIDEBAR_WIDTH - 1].char).toBe("▼");

    // Scroll to middle: should show both
    sidebar.scrollBy(3);
    grid = sidebar.getGrid();
    expect(grid.cells[2][SIDEBAR_WIDTH - 1].char).toBe("▲");
  });

  test("renders the version on the sidebar's last row", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 10);
    sidebar.updateSessions(makeSessions([{ name: "main" }]));
    sidebar.setVersion("1.2.3");
    const grid = sidebar.getGrid();
    const lastRow = Array.from(
      { length: SIDEBAR_WIDTH },
      (_, i) => grid.cells[9][i].char,
    ).join("");
    expect(lastRow).toContain("v1.2.3");
    expect(sidebar.isVersionRow(9)).toBe(true);
    expect(sidebar.isVersionRow(8)).toBe(false);
  });

  test("isVersionRow is false when no version has been set", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 10);
    sidebar.updateSessions(makeSessions([{ name: "main" }]));
    expect(sidebar.isVersionRow(9)).toBe(false);
  });

  test("plain version text renders in the textTertiary token", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 10);
    sidebar.updateSessions(makeSessions([{ name: "main" }]));
    sidebar.setVersion("1.2.3");
    const grid = sidebar.getGrid();
    const cell = grid.cells[9][1];
    expect(cell.fg).toBe(tokens.textTertiary.fg!);
    expect(cell.fgMode).toBe(tokens.textTertiary.fgMode!);
  });

  test("update-available version text renders in the attention token", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 10);
    sidebar.updateSessions(makeSessions([{ name: "main" }]));
    sidebar.setVersion("1.2.3", "1.3.0");
    const grid = sidebar.getGrid();
    const lastRow = Array.from(
      { length: SIDEBAR_WIDTH },
      (_, i) => grid.cells[9][i].char,
    ).join("");
    expect(lastRow).toContain("v1.3.0 avail");
    const cell = grid.cells[9][1];
    expect(cell.fg).toBe(tokens.attention.fg!);
    expect(cell.fgMode).toBe(tokens.attention.fgMode!);
  });

  test("the footer version row reserves a row from the viewport, moving the scroll indicator up", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 10);
    sidebar.updateSessions(
      makeSessions([
        { name: "a" },
        { name: "b" },
        { name: "c" },
        { name: "d" },
      ]),
    );
    sidebar.setVersion("1.2.3");
    const grid = sidebar.getGrid();
    // Version row occupies the last row (9); the ▼ indicator must move to
    // the row above it rather than colliding with the version text.
    expect(grid.cells[8][SIDEBAR_WIDTH - 1].char).toBe("▼");
    const lastRow = Array.from(
      { length: SIDEBAR_WIDTH },
      (_, i) => grid.cells[9][i].char,
    ).join("");
    expect(lastRow).toContain("v1.2.3");
  });

  test("scrollToActive snaps back after manual scroll", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 10);
    sidebar.updateSessions(
      makeSessions([
        { name: "a" },
        { name: "b" },
        { name: "c" },
        { name: "d" },
      ]),
    );
    sidebar.setActiveSession("$0"); // "a" is active
    // Scroll away from active session
    sidebar.scrollBy(6);
    // Snap back
    sidebar.scrollToActive();
    const grid = sidebar.getGrid();
    // "a" should be visible
    let found = false;
    for (let r = 2; r < 10; r++) {
      const text = Array.from(
        { length: SIDEBAR_WIDTH },
        (_, i) => grid.cells[r][i].char,
      ).join("");
      if (text.includes("a")) {
        found = true;
        break;
      }
    }
    expect(found).toBe(true);
  });

  test("collapsed group hides its sessions from render", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(
      makeSessions([
        { name: "api", directory: "~/Code/work/api" },
        { name: "web", directory: "~/Code/work/web" },
        { name: "solo", directory: "~" },
      ]),
    );
    sidebar.toggleGroup("project:Code/work");
    const grid = sidebar.getGrid();
    let foundApi = false;
    let foundWeb = false;
    for (let r = 0; r < 30; r++) {
      const text = Array.from(
        { length: SIDEBAR_WIDTH },
        (_, i) => grid.cells[r][i].char,
      ).join("");
      if (text.includes("api")) foundApi = true;
      if (text.includes("web")) foundWeb = true;
    }
    expect(foundApi).toBe(false);
    expect(foundWeb).toBe(false);
    let foundHeader = false;
    for (let r = 0; r < 30; r++) {
      const text = Array.from(
        { length: SIDEBAR_WIDTH },
        (_, i) => grid.cells[r][i].char,
      ).join("");
      if (text.includes("Code/work")) foundHeader = true;
    }
    expect(foundHeader).toBe(true);
  });

  test("collapsed group excludes sessions from displayOrder", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(
      makeSessions([
        { name: "api", directory: "~/Code/work/api" },
        { name: "web", directory: "~/Code/work/web" },
        { name: "solo", directory: "~" },
      ]),
    );
    sidebar.toggleGroup("project:Code/work");
    const ids = sidebar.getDisplayOrderIds();
    expect(ids).toEqual(["$2"]);
  });

  test("toggleGroup expands a collapsed group", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(
      makeSessions([
        { name: "api", directory: "~/Code/work/api" },
        { name: "web", directory: "~/Code/work/web" },
      ]),
    );
    sidebar.toggleGroup("project:Code/work"); // collapse
    sidebar.toggleGroup("project:Code/work"); // expand
    const ids = sidebar.getDisplayOrderIds();
    expect(ids).toEqual(["$0", "$1"]);
  });

  test("expanded group header renders 'label ────' hairline, not a chevron", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(
      makeSessions([
        { name: "api", directory: "~/Code/work/api" },
        { name: "web", directory: "~/Code/work/web" },
      ]),
    );
    const grid = sidebar.getGrid();
    // Row 2: overview, Row 3: spacer, Row 4: group header.
    const row = grid.cells[4];
    // Label starts at col 1 in tokens.textSecondary — no disclosure chevron.
    const label = Array.from({ length: "Code/work".length }, (_, i) => row[1 + i].char).join("");
    expect(label).toBe("Code/work");
    expect(row[1].fg).toBe(tokens.textSecondary.fg!);
    expect(row[1].fgMode).toBe(tokens.textSecondary.fgMode!);
    expect(row.some((c) => c.char === "▾" || c.char === "▸")).toBe(false);
    // After the label + a one-space gap, the rest of the row fills with the
    // hairline rule glyph in the hairline tone, out to the inner edge.
    const fillStart = 1 + label.length + 1;
    expect(row[fillStart].char).toBe(frame.ruleLight);
    expect(row[fillStart].fg).toBe(tokens.ruleHairline.fg!);
    expect(row[SIDEBAR_WIDTH - 1].char).toBe(frame.ruleLight);
  });

  test("collapsed group header keeps the hairline and shows a small count cue", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(
      makeSessions([
        { name: "api", directory: "~/Code/work/api" },
        { name: "web", directory: "~/Code/work/web" },
      ]),
    );
    sidebar.toggleGroup("project:Code/work");
    const grid = sidebar.getGrid();
    // Row 2: overview, Row 3: spacer, Row 4: group header
    const row = grid.cells[4];
    const headerText = Array.from(
      { length: SIDEBAR_WIDTH },
      (_, i) => row[i].char,
    ).join("");
    expect(headerText).toContain("Code/work");
    expect(headerText).toContain("(2)");
    expect(headerText).not.toContain("▸");
    expect(headerText).not.toContain("▾");
    // The hairline is still present between the label and the count cue.
    expect(headerText).toContain(frame.ruleLight);
  });

  test("getGroupKeyByRow returns the axis-namespaced collapse key for header rows", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(
      makeSessions([
        { name: "api", directory: "~/Code/work/api" },
        { name: "web", directory: "~/Code/work/web" },
      ]),
    );
    sidebar.getGrid(); // populate row maps
    // Row 4 is the group header (rows 2,3 are overview+spacer)
    expect(sidebar.getGroupKeyByRow(4)).toBe("project:Code/work");
    // Row 6 is a session, not a group header
    expect(sidebar.getGroupKeyByRow(6)).toBeNull();
  });

  test("group header row shows hover highlight", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(
      makeSessions([
        { name: "api", directory: "~/Code/work/api" },
        { name: "web", directory: "~/Code/work/web" },
      ]),
    );
    sidebar.setHoveredRow(4); // group header row (was row 2, now row 4 after overview block)
    const grid = sidebar.getGrid();
    // The header row should have HOVER_BG applied
    expect(grid.cells[4][0].bg).not.toBe(0);
  });

  test("renders cache timer on detail row when set", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(
      makeSessions([{ name: "main", directory: "~/mydir", gitBranch: "dev" }]),
    );
    sidebar.setSessionOtelState("$0", {
      ...makeSessionOtelState(),
      lastRequestTime: Date.now() - 60_000,
      cacheWasHit: true,
    });
    const grid = sidebar.getGrid();
    // Row 2: overview, Row 3: spacer, Row 4: session name, Row 5: detail
    const detailText = Array.from(
      { length: SIDEBAR_WIDTH },
      (_, i) => grid.cells[5][i].char,
    ).join("");
    expect(detailText).toContain("4:0");
  });

  test("timer shows elapsed text when cache expired", () => {
    // Cache expired (360s > 300s TTL) → falls back to elapsed from lastRequestTime
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(makeSessions([{ name: "main" }]));
    sidebar.setSessionOtelState("$0", {
      ...makeSessionOtelState(),
      lastRequestTime: Date.now() - 360_000,
      cacheWasHit: true,
    });
    const grid = sidebar.getGrid();
    // Row 2: overview, Row 3: spacer, Row 4: session name, Row 5: detail
    const detailText = Array.from(
      { length: SIDEBAR_WIDTH },
      (_, i) => grid.cells[5][i].char,
    ).join("");
    expect(detailText).toContain("6m");
  });

  test("no timer rendered when cache timer state is null", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(
      makeSessions([{ name: "main", directory: "~/mydir", gitBranch: "dev" }]),
    );
    const grid = sidebar.getGrid();
    // Row 2: overview, Row 3: spacer, Row 4: session name, Row 5: detail
    const detailText = Array.from(
      { length: SIDEBAR_WIDTH },
      (_, i) => grid.cells[5][i].char,
    ).join("");
    expect(detailText).not.toMatch(/\d:\d\d/);
  });

  test("timer uses green color when > 180s remaining", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(makeSessions([{ name: "main" }]));
    sidebar.setSessionOtelState("$0", {
      ...makeSessionOtelState(),
      lastRequestTime: Date.now() - 30_000,
      cacheWasHit: true,
    });
    const grid = sidebar.getGrid();
    // Row 2: overview, Row 3: spacer, Row 4: session name, Row 5: detail
    const row = grid.cells[5];
    let timerColStart = -1;
    for (let c = SIDEBAR_WIDTH - 1; c >= 0; c--) {
      if (row[c].char === ":") {
        timerColStart = c - 1;
        break;
      }
    }
    expect(timerColStart).toBeGreaterThan(0);
    expect(row[timerColStart].fg).toBe(2);
  });

  test("timer uses yellow color when 30-180s remaining", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(makeSessions([{ name: "main" }]));
    sidebar.setSessionOtelState("$0", {
      ...makeSessionOtelState(),
      lastRequestTime: Date.now() - 200_000,
      cacheWasHit: true,
    });
    const grid = sidebar.getGrid();
    // Row 2: overview, Row 3: spacer, Row 4: session name, Row 5: detail
    const row = grid.cells[5];
    let timerColStart = -1;
    for (let c = SIDEBAR_WIDTH - 1; c >= 0; c--) {
      if (row[c].char === ":") {
        timerColStart = c - 1;
        break;
      }
    }
    expect(timerColStart).toBeGreaterThan(0);
    expect(row[timerColStart].fg).toBe(3);
  });

  test("timer uses red color when < 30s remaining", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(makeSessions([{ name: "main" }]));
    sidebar.setSessionOtelState("$0", {
      ...makeSessionOtelState(),
      lastRequestTime: Date.now() - 280_000,
      cacheWasHit: true,
    });
    const grid = sidebar.getGrid();
    // Row 2: overview, Row 3: spacer, Row 4: session name, Row 5: detail
    const row = grid.cells[5];
    let timerColStart = -1;
    for (let c = SIDEBAR_WIDTH - 1; c >= 0; c--) {
      if (row[c].char === ":") {
        timerColStart = c - 1;
        break;
      }
    }
    expect(timerColStart).toBeGreaterThan(0);
    expect(row[timerColStart].fg).toBe(1);
  });

  test("timer uses dim when cache expired (elapsed fallback)", () => {
    // Cache expired (400s > 300s TTL) → elapsed text "6m" rendered with dim styling
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(makeSessions([{ name: "main" }]));
    sidebar.setSessionOtelState("$0", {
      ...makeSessionOtelState(),
      lastRequestTime: Date.now() - 400_000,
      cacheWasHit: true,
    });
    const grid = sidebar.getGrid();
    // Row 2: overview, Row 3: spacer, Row 4: session name, Row 5: detail
    const row = grid.cells[5];
    const detailText = Array.from({ length: SIDEBAR_WIDTH }, (_, i) => row[i].char).join("");
    expect(detailText).toContain("6m");
    // Find the rightmost dim cell that isn't whitespace — that's the timer.
    let timerCol = -1;
    for (let c = row.length - 1; c >= 0; c--) {
      if (row[c].char.trim() && row[c].dim) {
        timerCol = c;
        break;
      }
    }
    expect(timerCol).toBeGreaterThan(0);
    expect(row[timerCol].dim).toBe(true);
  });

  test("with no branch to compete for space, the timer renders in full", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(
      makeSessions([
        { name: "api", directory: "~/Code/work/api", gitBranch: "very-long-branch-name-here" },
        { name: "web", directory: "~/Code/work/web", gitBranch: "main" },
      ]),
    );
    sidebar.setSessionOtelState("$0", {
      ...makeSessionOtelState(),
      lastRequestTime: Date.now() - 60_000,
      cacheWasHit: true,
    });
    const grid = sidebar.getGrid();
    // Row 2: overview, Row 3: spacer, Row 4: group header, Row 5: spacer, Row 6: api name, Row 7: api detail
    const detailText = Array.from(
      { length: SIDEBAR_WIDTH },
      (_, i) => grid.cells[7][i].char,
    ).join("");
    // The branch used to compete with the timer for this row's width and
    // truncate to an ellipsis; it is gone, so nothing does.
    expect(detailText).not.toContain("…");
    expect(detailText).toContain("4:0");
  });

  test("pinned sessions appear in Pinned group at the top", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.setPinnedSessions(new Set(["beta"]));
    sidebar.updateSessions(
      makeSessions([
        { name: "alpha", directory: "~/Code/work/alpha" },
        { name: "beta", directory: "~/Code/work/beta" },
        { name: "gamma" },
      ]),
    );
    const grid = sidebar.getGrid();
    // Row 2: overview, Row 3: spacer, Row 4: "Pinned" group header
    const row4 = Array.from(
      { length: SIDEBAR_WIDTH },
      (_, i) => grid.cells[4][i].char,
    ).join("");
    expect(row4).toContain("Pinned");
    // Row 5: spacer, Row 6: pinned session "beta"
    const row6 = Array.from(
      { length: SIDEBAR_WIDTH },
      (_, i) => grid.cells[6][i].char,
    ).join("");
    expect(row6).toContain("beta");
  });

  test("pinned sessions are excluded from their normal group", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.setPinnedSessions(new Set(["api"]));
    sidebar.updateSessions(
      makeSessions([
        { name: "api", directory: "~/Code/work/server" },
        { name: "web", directory: "~/Code/work/web" },
      ]),
    );
    const grid = sidebar.getGrid();
    // Collect all rendered text
    let allText = "";
    for (let r = 0; r < 30; r++) {
      const rowText = Array.from(
        { length: SIDEBAR_WIDTH },
        (_, i) => grid.cells[r][i].char,
      ).join("");
      allText += rowText + "\n";
    }
    // "api" session name should appear once (in Pinned), not also in Code/work
    const apiMatches = allText.split("api").length - 1;
    expect(apiMatches).toBe(1);
    // "Code/work" group should still exist with "web"
    expect(allText).toContain("Code/work");
    expect(allText).toContain("web");
  });

  test("isPinned returns correct state", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.setPinnedSessions(new Set(["main"]));
    expect(sidebar.isPinned("main")).toBe(true);
    expect(sidebar.isPinned("other")).toBe(false);
  });

  test("Pinned group can be collapsed", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.setPinnedSessions(new Set(["alpha"]));
    sidebar.updateSessions(
      makeSessions([
        { name: "alpha" },
        { name: "beta" },
      ]),
    );
    sidebar.toggleGroup("pinned");
    const grid = sidebar.getGrid();
    let foundAlpha = false;
    for (let r = 0; r < 30; r++) {
      const text = Array.from(
        { length: SIDEBAR_WIDTH },
        (_, i) => grid.cells[r][i].char,
      ).join("");
      if (text.includes("alpha")) foundAlpha = true;
    }
    expect(foundAlpha).toBe(false);
    // Header should still be visible with count (at row 4 after overview block)
    const headerRow = Array.from(
      { length: SIDEBAR_WIDTH },
      (_, i) => grid.cells[4][i].char,
    ).join("");
    expect(headerRow).toContain("Pinned");
    expect(headerRow).toContain("(1)");
  });

  test("no Pinned group when no sessions are pinned", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(
      makeSessions([
        { name: "alpha" },
        { name: "beta" },
      ]),
    );
    const grid = sidebar.getGrid();
    let allText = "";
    for (let r = 0; r < 30; r++) {
      allText += Array.from(
        { length: SIDEBAR_WIDTH },
        (_, i) => grid.cells[r][i].char,
      ).join("");
    }
    expect(allText).not.toContain("Pinned");
  });

  test("updateSessions prunes otelStates for sessions that no longer exist", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(makeSessions([{ name: "alpha" }, { name: "beta" }]));
    sidebar.setSessionOtelState("$0", {
      ...makeBlankOtelState(),
      contextTokens: 100000,
    });
    sidebar.setSessionOtelState("$1", {
      ...makeBlankOtelState(),
      contextTokens: 200000,
    });
    expect(sidebar._otelStateCount()).toBe(2);
    // Now drop beta. Its state should be evicted.
    sidebar.updateSessions(makeSessions([{ name: "alpha" }]));
    expect(sidebar._otelStateCount()).toBe(1);
    // Sanity check: alpha's render shouldn't surface beta's context figure.
    sidebar.setActiveSession("$0");
    const grid = sidebar.getGrid();
    // Row 2: overview, Row 3: spacer, Row 4: alpha name, Row 5: alpha detail, Row 6: alpha row3
    const text = Array.from({ length: SIDEBAR_WIDTH }, (_, i) => grid.cells[6][i].char).join("");
    expect(text).not.toContain("200k");
  });

  test("cacheTimersEnabled false suppresses timer rendering", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(makeSessions([{ name: "main" }]));
    sidebar.setSessionOtelState("$0", {
      ...makeSessionOtelState(),
      lastRequestTime: Date.now() - 60_000,
      cacheWasHit: true,
    });
    sidebar.cacheTimersEnabled = false;
    const grid = sidebar.getGrid();
    // Row 2: overview, Row 3: spacer, Row 4: session name, Row 5: detail
    const detailText = Array.from(
      { length: SIDEBAR_WIDTH },
      (_, i) => grid.cells[5][i].char,
    ).join("");
    expect(detailText).not.toMatch(/\d:\d\d/);
  });

  // Row layout reminder for ungrouped sessions:
  // row 0: "Sessions" header
  // row 1: separator
  // row 2: overview entry (permanent synthetic block)
  // row 3: spacer (after overview block)
  // row 4: first session name (item starts here; spacer follows each session)
  //
  // Every session is uniformly 3 rows tall:
  //   α: rows 4,5,6
  //   spacer: row 7
  //   β: rows 8,9,10
  //   spacer: row 11
  //   γ: rows 12,13,14

  // Row 3 (context + agent-state label) only exists once a session is
  // promoted; before that it would render blank, which is what made a list of
  // un-promoted sessions look ragged. So height is 2 or 3 by promotion.
  test("a non-promoted session is 2 rows tall", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(makeSessions([
      { name: "alpha" },
      { name: "beta" },
    ]));
    sidebar.setActiveSession("$0");
    const grid = sidebar.getGrid();

    // alpha at rows 4,5; spacer at 6; beta at rows 7,8
    const rowText = (r: number) =>
      Array.from({ length: SIDEBAR_WIDTH }, (_, i) => grid.cells[r][i].char).join("");
    expect(rowText(7)).toContain("beta");
    // The row the old fixed-height layout would have put it on is now blank.
    expect(rowText(8)).not.toContain("beta");
  });

  test("a promoted session is 3 rows tall — the state row reappears", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(makeSessions([
      { name: "alpha" },
      { name: "beta" },
    ]));
    sidebar.setActiveSession("$0");
    sidebar.setAgentStateRecord("$0", { state: "running", since: Date.now() });
    const grid = sidebar.getGrid();

    // alpha now occupies 4,5,6; spacer at 7; beta starts at 8 again.
    const rowText = (r: number) =>
      Array.from({ length: SIDEBAR_WIDTH }, (_, i) => grid.cells[r][i].char).join("");
    expect(rowText(6)).toContain("RUNNING");
    expect(rowText(8)).toContain("beta");
  });

  test("hovering row 3 keeps hover styling", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(makeSessions([
      { name: "alpha" },
      { name: "beta" },
    ]));
    sidebar.setActiveSession("$0");
    // Promote beta so it actually HAS a third row to hover.
    sidebar.setAgentStateRecord("$1", { state: "running", since: Date.now() });
    // Layout: overview 2, spacer 3, alpha (non-promoted, 2 rows) at 4,5;
    // spacer 6; beta (promoted, 3 rows) at 7,8,9. Hover beta's third row.
    sidebar.setHoveredRow(9);
    const grid = sidebar.getGrid();

    // Beta's name row (row 7) should have hover bg painted.
    expect(grid.cells[7][0].bg).toBe((0x1a << 16) | (0x1f << 8) | 0x26);
    // Its third row should too — hovering any row highlights the whole slot.
    expect(grid.cells[9][0].bg).toBe((0x1a << 16) | (0x1f << 8) | 0x26);
  });

  test("a promoted session shows context tokens on row 3", () => {
    const width = 30;
    const sidebar = new Sidebar(width, 30);
    sidebar.updateSessions(makeSessions([{ name: "main" }]));
    sidebar.setActiveSession("$0");
    sidebar.setAgentStateRecord("$0", { state: "running", since: Date.now() });
    sidebar.setSessionOtelState("$0", {
      ...makeBlankOtelState(),
      contextTokens: 112000,
    });
    const grid = sidebar.getGrid();
    // Row 2: overview, Row 3: spacer, Row 4: name, Row 5: detail, Row 6: row3
    const text = Array.from({ length: width }, (_, i) => grid.cells[6][i].char).join("");
    expect(text).toContain("112k");
    expect(text).not.toContain("$");
  });

  // A non-promoted session has no row 3, so its context figure moves into
  // row 2's right cluster rather than being lost.
  test("a non-promoted session shows context tokens on row 2", () => {
    const width = 30;
    const sidebar = new Sidebar(width, 30);
    sidebar.updateSessions(makeSessions([{ name: "main" }]));
    sidebar.setActiveSession("$0");
    sidebar.setSessionOtelState("$0", {
      ...makeBlankOtelState(),
      contextTokens: 112000,
    });
    const grid = sidebar.getGrid();
    const rowText = (r: number) =>
      Array.from({ length: width }, (_, i) => grid.cells[r][i].char).join("");
    expect(rowText(5)).toContain("112k");
    // Row 6 belongs to the next item now — nothing of this session is there.
    expect(rowText(6)).not.toContain("112k");
  });

  test("switching active session does not shift layout", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(makeSessions([
      { name: "alpha" },
      { name: "beta" },
      { name: "gamma" },
    ]));
    sidebar.setActiveSession("$0");
    const grid1 = sidebar.getGrid();
    // All three are non-promoted (2 rows each): overview 2, spacer 3,
    // alpha 4,5, spacer 6, beta 7,8, spacer 9, gamma 10,11.
    const before = Array.from({ length: SIDEBAR_WIDTH }, (_, i) => grid1.cells[10][i].char).join("");

    sidebar.setActiveSession("$1");
    const grid2 = sidebar.getGrid();
    const after = Array.from({ length: SIDEBAR_WIDTH }, (_, i) => grid2.cells[10][i].char).join("");

    // Same row should still contain whatever was there before (gamma).
    expect(after).toBe(before);
    expect(before).toContain("gamma");
  });

  test("renders P badge in cyan when permissionMode is plan", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(makeSessions([{ name: "main" }]));
    sidebar.setSessionOtelState("$0", {
      ...makeBlankOtelState(),
      permissionMode: "plan",
    });
    const grid = sidebar.getGrid();

    // Row 2: overview, Row 3: spacer, Row 4: session name row — no Linear ID, badge anchors at width - 2
    const badgeCell = grid.cells[4][SIDEBAR_WIDTH - 2];
    expect(badgeCell.char).toBe("P");
    expect(badgeCell.fg).toBe(6); // palette cyan
  });

  test("renders A badge in yellow when permissionMode is accept-edits", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(makeSessions([{ name: "main" }]));
    sidebar.setSessionOtelState("$0", {
      ...makeBlankOtelState(),
      permissionMode: "accept-edits",
    });
    const grid = sidebar.getGrid();

    // Row 2: overview, Row 3: spacer, Row 4: session name row
    const badgeCell = grid.cells[4][SIDEBAR_WIDTH - 2];
    expect(badgeCell.char).toBe("A");
    expect(badgeCell.fg).toBe(3);
  });

  test("default mode renders no badge", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(makeSessions([{ name: "main" }]));
    sidebar.setSessionOtelState("$0", makeBlankOtelState());
    const grid = sidebar.getGrid();

    // Row 2: overview, Row 3: spacer, Row 4: session name row
    expect(grid.cells[4][SIDEBAR_WIDTH - 2].char).toBe(" ");
  });

  test("session name truncates 2 columns earlier when a mode badge is present", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    // 26-col sidebar, col 3 starts the name. With no badge, name has 22 cols.
    // With badge, name has 20 cols.
    const longName = "a".repeat(40);
    sidebar.updateSessions(makeSessions([{ name: longName }]));
    sidebar.setSessionOtelState("$0", {
      ...makeBlankOtelState(),
      permissionMode: "plan",
    });
    const grid = sidebar.getGrid();

    // Row 2: overview, Row 3: spacer, Row 4: session name row
    const row = grid.cells[4];
    // Find last 'a' col
    let lastA = -1;
    for (let c = 0; c < SIDEBAR_WIDTH; c++) if (row[c].char === "a") lastA = c;
    // Last char before the badge gap should be the ellipsis
    const ellipsisCol = lastA + 1;
    expect(row[ellipsisCol].char).toBe("…");
  });

  test("renders compaction marker for 30s when no mode badge", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(makeSessions([{ name: "main" }]));
    sidebar.setSessionOtelState("$0", {
      ...makeBlankOtelState(),
      lastCompactionTime: Date.now() - 5_000,
    });
    const grid = sidebar.getGrid();

    // Row 2: overview, Row 3: spacer, Row 4: session name row
    expect(grid.cells[4][SIDEBAR_WIDTH - 2].char).toBe("⊕");
    expect(grid.cells[4][SIDEBAR_WIDTH - 2].dim).toBe(true);
  });

  test("compaction marker disappears after 30s", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(makeSessions([{ name: "main" }]));
    sidebar.setSessionOtelState("$0", {
      ...makeBlankOtelState(),
      lastCompactionTime: Date.now() - 31_000,
    });
    const grid = sidebar.getGrid();

    // Row 2: overview, Row 3: spacer, Row 4: session name row
    expect(grid.cells[4][SIDEBAR_WIDTH - 2].char).toBe(" ");
  });

  test("plan mode wins over compaction marker", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(makeSessions([{ name: "main" }]));
    sidebar.setSessionOtelState("$0", {
      ...makeBlankOtelState(),
      permissionMode: "plan",
      lastCompactionTime: Date.now() - 5_000,
    });
    const grid = sidebar.getGrid();

    // Row 2: overview, Row 3: spacer, Row 4: session name row
    expect(grid.cells[4][SIDEBAR_WIDTH - 2].char).toBe("P");
  });

});

function makeContexts(
  entries: Array<{ name: string; pipelineState?: PipelineStatus["state"]; issueIds?: string[]; mrCount?: number }>,
): Map<string, SessionContext> {
  const map = new Map<string, SessionContext>();
  for (const e of entries) {
    const mrs: Array<import("../adapters/types").MergeRequest & { source: import("../adapters/types").LinkSource }> = [];
    const now = Date.now();
    if (e.pipelineState) {
      mrs.push({
        id: "proj:1", title: "Test", status: "open",
        sourceBranch: "main", targetBranch: "main",
        pipeline: { state: e.pipelineState, webUrl: "" },
        approvals: { required: 0, current: 0 },
        webUrl: "", source: "branch",
        createdAt: now,
      });
    }
    for (let i = 0; i < (e.mrCount ?? 0); i++) {
      mrs.push({
        id: `proj:mr-${i}`, title: `MR ${i}`, status: "open",
        sourceBranch: "feat", targetBranch: "main",
        pipeline: null, approvals: { required: 0, current: 0 },
        webUrl: "", source: "manual",
        createdAt: now - (e.mrCount! - i) * 1000,
      });
    }
    map.set(e.name, {
      sessionName: e.name,
      dir: "/tmp",
      branch: "main",
      remote: null,
      mrs,
      issues: (e.issueIds ?? []).map((id) => ({
        id, identifier: id, title: "Test", status: "In Progress",
        assignee: null, linkedMrUrls: [], webUrl: "", source: "manual" as import("../adapters/types").LinkSource,
      })),
      resolvedAt: Date.now(),
    });
  }
  return map;
}

describe("Sidebar pipeline glyphs", () => {
  test("renders pipeline passed glyph", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(makeSessions([{ name: "api" }]));
    sidebar.setSessionContexts(makeContexts([{ name: "api", pipelineState: "passed" }]));
    const grid = sidebar.getGrid();
    const allChars = grid.cells.flatMap((row) => row.map((c) => c.char)).join("");
    expect(allChars).toContain("✓");
  });

  test("renders pipeline failed glyph", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(makeSessions([{ name: "api" }]));
    sidebar.setSessionContexts(makeContexts([{ name: "api", pipelineState: "failed" }]));
    const grid = sidebar.getGrid();
    const allChars = grid.cells.flatMap((row) => row.map((c) => c.char)).join("");
    expect(allChars).toContain("✗");
  });

  test("renders pipeline running glyph", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(makeSessions([{ name: "api" }]));
    sidebar.setSessionContexts(makeContexts([{ name: "api", pipelineState: "running" }]));
    const grid = sidebar.getGrid();
    const allChars = grid.cells.flatMap((row) => row.map((c) => c.char)).join("");
    expect(allChars).toContain("⟳");
  });

  test("no glyph when no session context", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(makeSessions([{ name: "api" }]));
    const grid = sidebar.getGrid();
    const allChars = grid.cells.flatMap((row) => row.map((c) => c.char)).join("");
    expect(allChars).not.toContain("✓");
    expect(allChars).not.toContain("✗");
    expect(allChars).not.toContain("⟳");
  });

  test("no glyph when session has no MR", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(makeSessions([{ name: "api" }]));
    sidebar.setSessionContexts(makeContexts([{ name: "api" }]));
    const grid = sidebar.getGrid();
    const allChars = grid.cells.flatMap((row) => row.map((c) => c.char)).join("");
    expect(allChars).not.toContain("✓");
    expect(allChars).not.toContain("✗");
  });

  test("pipeline glyph shows state of latest MR", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(makeSessions([{ name: "api" }]));
    const ctx = makeContexts([{ name: "api", pipelineState: "running" }]);
    const existing = ctx.get("api")!;
    // Add an older MR with failed pipeline
    existing.mrs.push({
      id: "proj:2", title: "Second", status: "open",
      sourceBranch: "feat", targetBranch: "main",
      pipeline: { state: "failed", webUrl: "" },
      approvals: { required: 0, current: 0 },
      webUrl: "", source: "manual",
      createdAt: Date.now() - 10000, // older
    });
    sidebar.setSessionContexts(ctx);
    const grid = sidebar.getGrid();
    const allChars = grid.cells.flatMap((row) => row.map((c) => c.char)).join("");
    // Latest MR (proj:1 with createdAt: now) has running pipeline
    expect(allChars).toContain("⟳");
  });
});

describe("Sidebar inline link data", () => {
  test("renders linear ID on the detail row, session name on the row above", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(makeSessions([{ name: "api" }]));
    sidebar.setSessionContexts(makeContexts([{
      name: "api", issueIds: ["ENG-1234"],
    }]));
    const grid = sidebar.getGrid();
    // Row 2: overview, Row 3: spacer, Row 4: session name row, Row 5: detail row
    const nameRow = Array.from(
      { length: SIDEBAR_WIDTH },
      (_, i) => grid.cells[4][i].char,
    ).join("");
    const detailRow = Array.from(
      { length: SIDEBAR_WIDTH },
      (_, i) => grid.cells[5][i].char,
    ).join("");
    expect(nameRow).not.toContain("ENG-1234");
    expect(nameRow).toContain("api");
    expect(detailRow).toContain("ENG-1234");
  });

  test("renders MR ID on detail row", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(makeSessions([{ name: "api", gitBranch: "feat/x" }]));
    sidebar.setSessionContexts(makeContexts([{
      name: "api", pipelineState: "passed",
    }]));
    const grid = sidebar.getGrid();
    // Row 2: overview, Row 3: spacer, Row 4: session name, Row 5: detail row
    const detailRow = Array.from(
      { length: SIDEBAR_WIDTH },
      (_, i) => grid.cells[5][i].char,
    ).join("");
    expect(detailRow).toContain("!1");
    expect(detailRow).toContain("✓");
  });

  test("a non-promoted session with link data still takes 2 rows", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(makeSessions([{ name: "api" }, { name: "other" }]));
    sidebar.setSessionContexts(makeContexts([{
      name: "api", issueIds: ["ENG-1234"], mrCount: 2,
    }]));
    const grid = sidebar.getGrid();
    // Neither session is promoted, so each is 2 rows: overview 2, spacer 3,
    // api 4,5, spacer 6, other 7.
    const rowText = (r: number) =>
      Array.from({ length: SIDEBAR_WIDTH }, (_, i) => grid.cells[r][i].char).join("");
    expect(rowText(7)).toContain("other");
  });

  test("no link data shows a clean 2-row session", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(makeSessions([{ name: "api" }, { name: "other" }]));
    const grid = sidebar.getGrid();
    // Neither session is promoted, so each is 2 rows: overview 2, spacer 3,
    // api 4,5, spacer 6, other 7.
    const rowText = (r: number) =>
      Array.from({ length: SIDEBAR_WIDTH }, (_, i) => grid.cells[r][i].char).join("");
    expect(rowText(7)).toContain("other");
  });
});

describe("Sidebar — agent state rendering", () => {
  function makeSidebarWithAgentState(state: "running" | "waiting" | "complete"): Sidebar {
    const sb = new Sidebar(26, 24);
    const session: SessionInfo = {
      id: "$1", name: "alpha", attached: false, activity: 0,
      windowCount: 1,
    };
    sb.updateSessions([session]);
    sb.setAgentStateRecord("$1", { state, since: Date.now() });
    return sb;
  }

  test("col-1 glyph for running is ⏵ in palette green", () => {
    const sb = makeSidebarWithAgentState("running");
    const grid = sb.getGrid();
    // Header takes rows 0+1; overview block at rows 2,3; first session's nameRow is row 4.
    const cell = grid.cells[4][1];
    expect(cell.char).toBe("⏵");
    expect(cell.fg).toBe(2);
  });

  test("col-1 glyph for waiting is ! in orange bold", () => {
    const sb = makeSidebarWithAgentState("waiting");
    const grid = sb.getGrid();
    // Row 4: first session name row
    const cell = grid.cells[4][1];
    expect(cell.char).toBe("!");
    expect(cell.fg).toBe(3);
    expect(cell.bold).toBe(true);
  });

  test("col-1 glyph for complete is ✓ in dim blue", () => {
    const sb = makeSidebarWithAgentState("complete");
    const grid = sb.getGrid();
    // Row 4: first session name row
    const cell = grid.cells[4][1];
    expect(cell.char).toBe("✓");
    expect(cell.fg).toBe(4);
    expect(cell.dim).toBe(true);
  });

  test("col-1 glyph for complete resolves to the neutral token tone (not palette 8) via the app's default state colors", () => {
    // End-to-end through setStateColors(resolveStateColors(...)) — the same
    // path main.ts drives — rather than the sidebar's raw bootstrap default.
    const sb = makeSidebarWithAgentState("complete");
    sb.setStateColors(resolveStateColors(undefined));
    const grid = sb.getGrid();
    const cell = grid.cells[4][1];
    expect(cell.char).toBe("✓");
    expect(cell.fg).toBe(tokens.textTertiary.fg!);
    expect(cell.fgMode).toBe(tokens.textTertiary.fgMode!);
    expect(cell.dim).toBe(true); // complete's fixed emphasis is preserved
  });

  test("indicator priority: mcp-down wins over agent-state", () => {
    const sb = new Sidebar(26, 24);
    const session: SessionInfo = {
      id: "$1", name: "alpha", attached: false, activity: 0,
      windowCount: 1,
    };
    sb.updateSessions([session]);
    sb.setAgentStateRecord("$1", { state: "running", since: Date.now() });
    const otel = makeSessionOtelState();
    otel.failedMcpServers = new Set(["server-a"]);
    sb.setSessionOtelState("$1", otel);
    const grid = sb.getGrid();
    // Row 4: first session name row
    expect(grid.cells[4][1].char).toBe("⊘");
  });

  test("indicator priority: agent-state wins over activity", () => {
    const sb = new Sidebar(26, 24);
    const session: SessionInfo = {
      id: "$1", name: "alpha", attached: false, activity: 0,
      windowCount: 1,
    };
    sb.updateSessions([session]);
    sb.setAgentStateRecord("$1", { state: "complete", since: Date.now() });
    sb.setActivity("$1", true);
    const grid = sb.getGrid();
    // Row 4: first session name row
    expect(grid.cells[4][1].char).toBe("✓");  // not the activity dot
  });

  test("setAgentStateRecord(id, null) clears the record", () => {
    const sb = makeSidebarWithAgentState("running");
    sb.setAgentStateRecord("$1", null);
    sb.setActivity("$1", true);
    const grid = sb.getGrid();
    // Row 4: first session name row
    expect(grid.cells[4][1].char).toBe("●");  // falls back to activity dot
  });

  test("updateSessions prunes orphaned agent-state records", () => {
    const sb = makeSidebarWithAgentState("running");
    sb.updateSessions([]);  // remove the session
    // Indirect assertion: no error, and re-adding the session doesn't show the old state.
    const session: SessionInfo = {
      id: "$1", name: "alpha", attached: false, activity: 0,
      windowCount: 1,
    };
    sb.updateSessions([session]);
    const grid = sb.getGrid();
    // Row 4: first session name row. No agent state and no activity → indicator column should be empty (space).
    expect(grid.cells[4][1].char).toBe(" ");
  });

  test("row-2 state label appears with the matching color", () => {
    const sb = makeSidebarWithAgentState("running");
    sb.setSessionOtelState("$1", makeSessionOtelState());
    const grid = sb.getGrid();
    // Row 2 of the session (nameRow + 2) is at grid row 6 (header rows 0+1, overview+spacer 2+3, nameRow=4, row3=4+2=6).
    // Find the "RUNNING" label by scanning the row for the first non-space cell
    // that has fg=2 (palette green).
    const row = grid.cells[6];
    let found = "";
    for (const cell of row) {
      if (cell.char !== " " && cell.fg === 2) found += cell.char;
    }
    expect(found).toBe("RUNNING");
  });

  test("row-2 state label preserves the active-row background", () => {
    const sb = new Sidebar(26, 24);
    const session: SessionInfo = {
      id: "$1", name: "alpha", attached: false, activity: 0,
      windowCount: 1,
    };
    sb.updateSessions([session]);
    sb.setActiveSession("$1");
    sb.setAgentStateRecord("$1", { state: "running", since: Date.now() });

    const grid = sb.getGrid();
    // Row 2 of the session (nameRow + 2) is at grid row 6 (header rows 0+1, overview+spacer rows 2+3, nameRow=4).
    const row = grid.cells[6];
    // Find a cell that has fg=2 (green) — that's a RUNNING label cell.
    const labelCell = row.find((cell) => cell.fg === 2 && cell.char !== " ");
    expect(labelCell).toBeDefined();
    if (labelCell) {
      // Active background is 0x1e2a35 packed as RGB.
      expect(labelCell.bg).toBe((0x1e << 16) | (0x2a << 8) | 0x35);
    }
  });
});

describe("Overview entry", () => {
  test("overview row is at the very top (row 2, first content row)", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(makeSessions([{ name: "api" }]));
    const grid = sidebar.getGrid();
    const row2 = Array.from(
      { length: SIDEBAR_WIDTH },
      (_, i) => grid.cells[2][i].char,
    ).join("");
    expect(row2).toContain("Command Center");
  });

  test("empty state: zero pinned panes, row 2 still contains 'Command Center'", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(makeSessions([{ name: "api" }]));
    // No setPinnedPanes call — default is empty
    const grid = sidebar.getGrid();
    const row2 = Array.from(
      { length: SIDEBAR_WIDTH },
      (_, i) => grid.cells[2][i].char,
    ).join("");
    expect(row2).toContain("Command Center");
  });

  test("command center shows a colored agent-state breakdown row", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.setPinnedPanes([
      { paneId: "%1", label: "api › claude", homeSessionName: "api", agentState: "running" },
      { paneId: "%2", label: "web › claude", homeSessionName: "web", agentState: "running" },
      { paneId: "%3", label: "db › claude", homeSessionName: "db", agentState: "waiting" },
    ]);
    sidebar.updateSessions(makeSessions([{ name: "api" }]));
    const grid = sidebar.getGrid();
    // Header at row 2, breakdown at row 3.
    const row3 = Array.from(
      { length: SIDEBAR_WIDTH },
      (_, i) => grid.cells[3][i].char,
    ).join("");
    expect(row3).toContain("2 RUN");
    expect(row3).toContain("1 WAIT");
    expect(row3).not.toContain("DONE"); // no complete panes → omitted
  });

  test("pinned panes are NOT listed individually — only the count/breakdown", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.setPinnedPanes([
      { paneId: "%1", label: "api › claude", homeSessionName: "api" },
      { paneId: "%2", label: "api › npm test", homeSessionName: "api" },
    ]);
    sidebar.updateSessions(makeSessions([{ name: "api" }]));
    const grid = sidebar.getGrid();

    let allText = "";
    for (let r = 0; r < 30; r++) {
      allText += Array.from(
        { length: SIDEBAR_WIDTH },
        (_, i) => grid.cells[r][i].char,
      ).join("") + "\n";
    }
    // The individual pane labels must NOT appear in the sidebar anymore.
    expect(allText).not.toContain("npm test");
    // But the count is present in the Command Center header.
    expect(allText).toContain("Command Center · 2");
  });

  test("session that owns a pinned pane shows '(N pinned)' marker", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.setPinnedPanes([
      { paneId: "%1", label: "api › claude", homeSessionName: "api" },
    ]);
    sidebar.updateSessions(makeSessions([{ name: "api" }]));
    const grid = sidebar.getGrid();

    let allText = "";
    for (let r = 0; r < 30; r++) {
      allText += Array.from(
        { length: SIDEBAR_WIDTH },
        (_, i) => grid.cells[r][i].char,
      ).join("") + "\n";
    }
    expect(allText).toMatch(/1 pinned/);
  });

  test("getSelectionByRow(2) returns {type:'overview'} after getGrid()", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(makeSessions([{ name: "api" }]));
    sidebar.getGrid(); // populate row map
    const sel = sidebar.getSelectionByRow(2);
    expect(sel).not.toBeNull();
    expect(sel?.type).toBe("overview");
  });

  test("overview shows pane count when panes are present", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.setPinnedPanes([
      { paneId: "%1", label: "api › claude", homeSessionName: "api" },
      { paneId: "%2", label: "api › npm test", homeSessionName: "api" },
    ]);
    sidebar.updateSessions(makeSessions([{ name: "api" }]));
    const grid = sidebar.getGrid();
    const row2 = Array.from(
      { length: SIDEBAR_WIDTH },
      (_, i) => grid.cells[2][i].char,
    ).join("");
    expect(row2).toContain("2");
    expect(row2).toContain("Command Center");
  });
});

describe("Sidebar — sort & filter", () => {
  const WIDTH = 30;

  // Two projects, mixed statuses, so we can prove flat status sort crosses
  // project boundaries and pulls waiting to the very top.
  function seeded(): Sidebar {
    const sb = new Sidebar(WIDTH, 40);
    sb.updateSessions(makeSessions([
      { name: "alpha", project: "proj-a" },   // $0 running
      { name: "bravo", project: "proj-a" },    // $1 waiting
      { name: "charlie", project: "proj-b" },  // $2 idle
      { name: "delta", project: "proj-b" },    // $3 waiting
    ]));
    const now = Date.now();
    sb.setAgentStateRecord("$0", { state: "running", since: now });
    sb.setAgentStateRecord("$1", { state: "waiting", since: now });
    sb.setAgentStateRecord("$3", { state: "waiting", since: now });
    return sb;
  }

  const linesWith = (sb: Sidebar, needle: string): number => {
    const g = sb.getGrid();
    let row = -1;
    for (let r = 0; r < g.rows; r++) {
      const t = Array.from({ length: WIDTH }, (_, i) => g.cells[r][i].char).join("");
      if (t.includes(needle)) { row = r; break; }
    }
    return row;
  };

  test("group=none + sort=status pulls waiting to the top across projects, no headers", () => {
    const sb = seeded();
    sb.setGroupMode("none");
    sb.setSortMode("status");
    const g = sb.getGrid();
    const all = Array.from({ length: g.rows }, (_, r) =>
      Array.from({ length: WIDTH }, (_, i) => g.cells[r][i].char).join("")).join("\n");
    // No project group headers in a flat (group=none) list.
    expect(all).not.toContain("proj-a");
    expect(all).not.toContain("proj-b");
    // Both waiting sessions appear above both non-waiting ones.
    const bravo = linesWith(sb, "bravo");   // waiting
    const delta = linesWith(sb, "delta");   // waiting
    const alpha = linesWith(sb, "alpha");   // running
    const charlie = linesWith(sb, "charlie"); // idle
    expect(Math.max(bravo, delta)).toBeLessThan(Math.min(alpha, charlie));
  });

  test("group=status emits ranked headers: Needs you above Running above Idle", () => {
    const sb = seeded();
    sb.setGroupMode("status");
    const needsYou = linesWith(sb, "Needs you");
    const running = linesWith(sb, "Running");
    const idle = linesWith(sb, "Idle");
    // Every populated status heads its own group, ordered by rank.
    expect(needsYou).toBeGreaterThan(-1);
    expect(running).toBeGreaterThan(-1);
    expect(idle).toBeGreaterThan(-1);
    expect(needsYou).toBeLessThan(running);
    expect(running).toBeLessThan(idle);
    // Waiting sessions sit under the "Needs you" header, above the running one.
    const bravo = linesWith(sb, "bravo");   // waiting
    const alpha = linesWith(sb, "alpha");   // running
    expect(needsYou).toBeLessThan(bravo);
    expect(bravo).toBeLessThan(running);
    expect(running).toBeLessThan(alpha);
  });

  test("group=project + sort=status keeps project headers, ranks members within", () => {
    const sb = seeded();
    // Default group=project; sort members by status so waiting rises inside a group.
    sb.setSortMode("status");
    const g = sb.getGrid();
    const all = Array.from({ length: g.rows }, (_, r) =>
      Array.from({ length: WIDTH }, (_, i) => g.cells[r][i].char).join("")).join("\n");
    // Project headers still present — grouping is not dissolved.
    expect(all).toContain("proj-a");
    expect(all).toContain("proj-b");
    // Within proj-a, waiting "bravo" rises above running "alpha".
    expect(linesWith(sb, "bravo")).toBeLessThan(linesWith(sb, "alpha"));
  });

  test("pins float into a Pinned group in every mode, including group=none", () => {
    const sb = seeded();
    sb.setPinnedSessions(new Set(["charlie"])); // idle, would otherwise sink
    sb.setGroupMode("none");
    sb.setSortMode("status");
    const pinned = linesWith(sb, "Pinned");
    expect(pinned).toBeGreaterThan(-1);
    // The pinned (idle) session sits in the Pinned group above every other row,
    // even a waiting one — pinning outranks status ordering.
    expect(pinned).toBeLessThan(linesWith(sb, "charlie"));
    expect(linesWith(sb, "charlie")).toBeLessThan(linesWith(sb, "bravo"));
  });

  test("attention filter hides non-waiting sessions; Command Center stays", () => {
    const sb = seeded();
    sb.setFilterMode("attention");
    const g = sb.getGrid();
    const all = Array.from({ length: g.rows }, (_, r) =>
      Array.from({ length: WIDTH }, (_, i) => g.cells[r][i].char).join("")).join("\n");
    expect(all).toContain("Command Center");
    expect(all).toContain("bravo");   // waiting → shown
    expect(all).toContain("delta");   // waiting → shown
    expect(all).not.toContain("alpha");   // running → hidden
    expect(all).not.toContain("charlie"); // idle → hidden
  });

  test("project mode + attention filter hides a fully-filtered group", () => {
    const sb = seeded();
    // proj-b: charlie (idle, hidden) + delta (waiting, shown) → group stays.
    // Make a third project entirely non-waiting to prove it vanishes.
    sb.updateSessions(makeSessions([
      { name: "alpha", project: "proj-a" },
      { name: "bravo", project: "proj-a" },
      { name: "solo", project: "proj-c" },
    ]));
    sb.setAgentStateRecord("$1", { state: "waiting", since: Date.now() });
    // proj-c/solo has no waiting → whole group hidden under attention filter.
    sb.setFilterMode("attention");
    const g = sb.getGrid();
    const all = Array.from({ length: g.rows }, (_, r) =>
      Array.from({ length: WIDTH }, (_, i) => g.cells[r][i].char).join("")).join("\n");
    expect(all).toContain("proj-a");    // has a waiting session
    expect(all).toContain("bravo");
    expect(all).not.toContain("proj-c"); // fully filtered → header gone
    expect(all).not.toContain("solo");
  });

  test("header names the active group, sort, and filter", () => {
    const sb = new Sidebar(40, 40); // wide enough for both chips + filter
    sb.updateSessions(makeSessions([{ name: "alpha" }]));
    sb.setAgentStateRecord("$0", { state: "waiting", since: Date.now() });
    const header = () => Array.from({ length: 40 }, (_, i) => sb.getGrid().cells[0][i].char).join("");
    // Defaults: group by project, sort by name — no "Sessions" word.
    expect(header()).not.toContain("Sessions");
    expect(header()).toContain("⊞ Project");
    expect(header()).toContain("⇅ Name");
    sb.setGroupMode("status");
    expect(header()).toContain("⊞ Status");
    sb.setSortMode("activity");
    expect(header()).toContain("⇅ Activity");
    sb.setFilterMode("attention");
    expect(header()).toContain("· Needs you");
  });

  test("cycle helpers return and apply the next mode on each axis", () => {
    const sb = seeded();
    // Group axis: project → status → none → project.
    expect(sb.getGroupMode()).toBe("project");
    expect(sb.cycleGroupMode()).toBe("status");
    expect(sb.getGroupMode()).toBe("status");
    // Sort axis: name → activity → status → name.
    expect(sb.getSortMode()).toBe("name");
    expect(sb.cycleSortMode()).toBe("activity");
    expect(sb.getSortMode()).toBe("activity");
    expect(sb.cycleFilterMode()).toBe("attention");
    expect(sb.getFilterMode()).toBe("attention");
  });

  // --- group=stage: the user's own workflow stages as sidebar groups ---
  //
  // Stage membership is resolved by the caller (main.ts, from the linked issue
  // + panelViews) and handed over pre-resolved, so these tests set it directly.

  const stage = (id: string, label: string, rank: number): SessionWorkflow => ({
    band: { id, label, rank },
    label,
    drift: null,
    driftByIssue: new Map(),
  });

  test("group=stage emits headers in the user's stage order, not alphabetical", () => {
    const sb = seeded();
    sb.setGroupMode("stage");
    // "To do" is rank 0 and "In review" rank 1 — alphabetically the reverse, so
    // this only passes if header order follows the workflow, not the label.
    sb.setSessionWorkflow(new Map([
      ["alpha", stage("todo", "To do", 0)],
      ["bravo", stage("review", "In review", 1)],
      ["charlie", stage("review", "In review", 1)],
      ["delta", stage("todo", "To do", 0)],
    ]));
    const todo = linesWith(sb, "To do");
    const review = linesWith(sb, "In review");
    expect(todo).toBeGreaterThan(-1);
    expect(review).toBeGreaterThan(-1);
    expect(todo).toBeLessThan(review);
    // Members sit under their own stage's header.
    expect(todo).toBeLessThan(linesWith(sb, "alpha"));
    expect(linesWith(sb, "alpha")).toBeLessThan(review);
    expect(review).toBeLessThan(linesWith(sb, "charlie"));
  });

  test("a session with no stage falls to the flat remainder, not a group of its own", () => {
    const sb = seeded();
    sb.setGroupMode("stage");
    // charlie/delta have no linked issue, or a status no stage claims.
    sb.setSessionWorkflow(new Map([
      ["alpha", stage("todo", "To do", 0)],
      ["bravo", stage("todo", "To do", 0)],
    ]));
    const g = sb.getGrid();
    const all = Array.from({ length: g.rows }, (_, r) =>
      Array.from({ length: WIDTH }, (_, i) => g.cells[r][i].char).join("")).join("\n");
    expect(all).toContain("To do");
    expect(all).not.toContain("No stage");
    // Stageless sessions still render — below every stage group.
    expect(linesWith(sb, "To do")).toBeLessThan(linesWith(sb, "charlie"));
    expect(linesWith(sb, "alpha")).toBeLessThan(linesWith(sb, "charlie"));
  });

  test("with no stages resolved at all, group=stage degrades to a flat list", () => {
    const sb = seeded();
    sb.setGroupMode("stage");
    sb.setSessionWorkflow(new Map());
    const g = sb.getGrid();
    const all = Array.from({ length: g.rows }, (_, r) =>
      Array.from({ length: WIDTH }, (_, i) => g.cells[r][i].char).join("")).join("\n");
    for (const name of ["alpha", "bravo", "charlie", "delta"]) expect(all).toContain(name);
    expect(all).not.toContain("proj-a"); // no project headers leak in either
  });

  test("collapse is keyed on stage id, so a rename keeps the group folded", () => {
    const sb = seeded();
    sb.setGroupMode("stage");
    sb.setSessionWorkflow(new Map([["alpha", stage("todo", "To do", 0)]]));
    sb.toggleGroup("stage:todo");
    expect(linesWith(sb, "alpha")).toBe(-1); // folded away
    // Rename the stage; the id is unchanged, so it must still be folded.
    sb.setSessionWorkflow(new Map([["alpha", stage("todo", "Next up", 0)]]));
    expect(linesWith(sb, "Next up")).toBeGreaterThan(-1);
    expect(linesWith(sb, "alpha")).toBe(-1);
  });

  test("pins outrank a stage — an explicit signal beats a derived one", () => {
    const sb = seeded();
    sb.setGroupMode("stage");
    sb.setSessionWorkflow(new Map([
      ["alpha", stage("todo", "To do", 0)],
      ["charlie", stage("todo", "To do", 0)],
    ]));
    sb.setPinnedSessions(new Set(["charlie"]));
    expect(linesWith(sb, "Pinned")).toBeLessThan(linesWith(sb, "charlie"));
    expect(linesWith(sb, "charlie")).toBeLessThan(linesWith(sb, "To do"));
  });

  test("header chip names the stage axis", () => {
    const sb = seeded();
    sb.setGroupMode("stage");
    const header = Array.from({ length: WIDTH }, (_, i) => sb.getGrid().cells[0][i].char).join("");
    expect(header).toContain("⊞ Stage");
  });

  // --- Up next: unstarted issues as ghost rows ---
  //
  // Membership, ordering and the cap are all resolved by the caller (main.ts,
  // from the tracker + Up next config + live sessions), so these hand the
  // sidebar a finished list — the same boundary as setSessionWorkflow.

  const ghost = (issueId: string, identifier: string, title: string) => ({ issueId, identifier, title });

  test("ghosts render identifier and title over two rows, under an Up next header", () => {
    const sb = seeded();
    sb.setGhostSessions([ghost("i1", "ENG-142", "fix flaky auth test")]);
    const header = linesWith(sb, "Up next");
    const id = linesWith(sb, "ENG-142");
    const title = linesWith(sb, "fix flaky auth test");
    expect(header).toBeGreaterThan(-1);
    expect(header).toBeLessThan(id);
    // The title sits on the row directly below its identifier — a session row's
    // exact geometry, which is what makes the ghost a preview of what it becomes.
    expect(title).toBe(id + 1);
  });

  test("the band sits below live sessions and above Parked", () => {
    const sb = seeded();
    sb.setParkedSessions(new Set(["delta"]));
    sb.setGhostSessions([ghost("i1", "ENG-142", "fix flaky auth test")]);
    expect(linesWith(sb, "alpha")).toBeLessThan(linesWith(sb, "Up next"));
    expect(linesWith(sb, "Up next")).toBeLessThan(linesWith(sb, "Parked"));
  });

  test("no ghosts means no band at all", () => {
    const sb = seeded();
    sb.setGhostSessions([]);
    expect(linesWith(sb, "Up next")).toBe(-1);
  });

  test("both of a ghost's rows resolve to the same selection", () => {
    const sb = seeded();
    sb.setGhostSessions([ghost("i1", "ENG-142", "fix flaky auth test")]);
    const idRow = linesWith(sb, "ENG-142");
    expect(sb.getSelectionByRow(idRow)).toEqual({ type: "ghost", issueId: "i1" });
    expect(sb.getSelectionByRow(idRow + 1)).toEqual({ type: "ghost", issueId: "i1" });
  });

  test("a ghost row is not a session row — it never resolves to one", () => {
    const sb = seeded();
    sb.setGhostSessions([ghost("i1", "ENG-142", "fix flaky auth test")]);
    const idRow = linesWith(sb, "ENG-142");
    expect(sb.getSessionByRow(idRow)).toBeNull();
    expect(sb.getSessionByRow(idRow + 1)).toBeNull();
  });

  test("ghosts stay out of displayOrder — it is the session cycle", () => {
    // displayOrder means "sessions", and callers that ask for it get sessions.
    // Keyboard navigation moved to getNavOrder(), which includes ghosts.
    const sb = seeded();
    const before = sb.getDisplayOrderIds();
    sb.setGhostSessions([ghost("i1", "ENG-142", "fix flaky auth test")]);
    expect(sb.getDisplayOrderIds()).toEqual(before);
  });

  // --- Navigation order: ghosts are reachable from the keyboard ---
  //
  // They were excluded while landing on one provisioned a worktree. Selecting a
  // ghost now opens a preview, so the exclusion lost its justification.

  test("getNavOrder interleaves ghosts with sessions in render order", () => {
    const sb = seeded();
    sb.setGhostSessions([ghost("i1", "ENG-142", "fix flaky auth test")]);
    const nav = sb.getNavOrder();
    expect(nav.filter((t) => t.type === "ghost")).toEqual([{ type: "ghost", issueId: "i1" }]);
    // The flat band sits below the sessions, so the ghost is the last stop.
    expect(nav[nav.length - 1]).toEqual({ type: "ghost", issueId: "i1" });
    expect(nav.filter((t) => t.type === "session")).toHaveLength(4);
  });

  test("session nav targets carry ids that resolve against the session list", () => {
    const sb = seeded();
    const ids = sb.getDisplayOrderIds();
    const navSessions = sb.getNavOrder()
      .filter((t): t is { type: "session"; sessionId: string } => t.type === "session")
      .map((t) => t.sessionId);
    expect(navSessions).toEqual(ids);
  });

  test("ghosts join nav order on the stage axis too, inside their band", () => {
    const sb = seeded();
    sb.setGroupMode("stage");
    sb.setSessionWorkflow(new Map([["alpha", stage("todo", "To do", 0)]]));
    sb.setGhostSessions([stageGhost("i1", "ENG-142", "fix flaky auth", "todo", "To do", 0)]);
    const nav = sb.getNavOrder();
    const ghostAt = nav.findIndex((t) => t.type === "ghost" && t.issueId === "i1");
    const alphaAt = nav.findIndex((t) => t.type === "session" && t.sessionId === "$0");
    expect(ghostAt).toBeGreaterThan(-1);
    expect(alphaAt).toBeGreaterThan(-1);
    expect(ghostAt).toBeGreaterThan(alphaAt);
  });

  test("a filter drops ghosts from nav order entirely", () => {
    // Both filters select on agent state, which a ghost has none of, so the
    // rows are never emitted — and an unemitted row is not a nav stop.
    const sb = seeded();
    sb.setGhostSessions([ghost("i1", "ENG-142", "fix flaky auth test")]);
    expect(sb.getNavOrder().some((t) => t.type === "ghost")).toBe(true);
    sb.setFilterMode("attention");
    expect(sb.getNavOrder().some((t) => t.type === "ghost")).toBe(false);
  });

  test("a collapsed band contributes no nav stops", () => {
    const sb = seeded();
    sb.setGhostSessions([ghost("i1", "ENG-142", "fix flaky auth test")]);
    sb.toggleGroup("upnext");
    expect(sb.getNavOrder().some((t) => t.type === "ghost")).toBe(false);
  });

  // --- The focused ghost owns the rail while the preview is up ---

  test("setFocusedGhost paints both of the ghost's rows as active", () => {
    const sb = seeded();
    sb.setGhostSessions([ghost("i1", "ENG-142", "fix flaky auth test")]);
    const idRow = linesWith(sb, "ENG-142");

    const plain = sb.getGrid().cells[idRow]![0]!.bg;
    sb.setFocusedGhost("i1");
    const focused = sb.getGrid();
    expect(focused.cells[idRow]![0]!.bg).not.toBe(plain);
    expect(focused.cells[idRow + 1]![0]!.bg).toBe(focused.cells[idRow]![0]!.bg);

    sb.setFocusedGhost(null);
    expect(sb.getGrid().cells[idRow]![0]!.bg).toBe(plain);
  });

  test("focusing one ghost leaves its siblings unpainted", () => {
    const sb = seeded();
    sb.setGhostSessions([
      ghost("i1", "ENG-142", "first"),
      ghost("i2", "ENG-143", "second"),
    ]);
    sb.setFocusedGhost("i1");
    const g = sb.getGrid();
    const focusedRow = linesWith(sb, "ENG-142");
    const otherRow = linesWith(sb, "ENG-143");
    expect(g.cells[focusedRow]![0]!.bg).not.toBe(g.cells[otherRow]![0]!.bg);
  });

  test("scrollToActive brings an off-screen focused ghost into view", () => {
    const sb = new Sidebar(WIDTH, 12); // short viewport, so the band is below the fold
    sb.updateSessions(makeSessions([
      { name: "alpha" }, { name: "bravo" }, { name: "charlie" }, { name: "delta" },
    ]));
    sb.setGhostSessions([ghost("i1", "ENG-142", "fix flaky auth test")]);
    expect(linesWith(sb, "ENG-142")).toBe(-1);

    sb.setActiveSession("");
    sb.setFocusedGhost("i1");
    sb.scrollToActive();
    expect(linesWith(sb, "ENG-142")).toBeGreaterThan(-1);
  });

  test("scrollToActive is inert when the focused ghost is not on screen at all", () => {
    // The preview deliberately outlives its row: a filter can remove it while
    // the surface stays open. That must not throw or scroll somewhere random.
    const sb = seeded();
    sb.setGhostSessions([ghost("i1", "ENG-142", "fix flaky auth test")]);
    sb.setFilterMode("attention");
    sb.setActiveSession("");
    sb.setFocusedGhost("i1");
    expect(() => sb.scrollToActive()).not.toThrow();
  });

  test("the band collapses like any other group, keyed on its own axis", () => {
    const sb = seeded();
    sb.setGhostSessions([ghost("i1", "ENG-142", "fix flaky auth test")]);
    expect(linesWith(sb, "ENG-142")).toBeGreaterThan(-1);
    sb.toggleGroup("upnext");
    expect(linesWith(sb, "Up next")).toBeGreaterThan(-1); // header stays
    expect(linesWith(sb, "ENG-142")).toBe(-1);            // rows fold away
  });

  test("untagged ghosts use the flat band on every axis except stage", () => {
    // The caller tags ghosts with a stage only for the per-stage placement; on
    // any other axis they arrive untagged and collect into one band.
    for (const mode of ["none", "project", "status"] as const) {
      const sb = seeded();
      sb.setGroupMode(mode);
      sb.setGhostSessions([ghost("i1", "ENG-142", "fix flaky auth test")]);
      expect(linesWith(sb, "Up next")).toBeGreaterThan(-1);
      expect(linesWith(sb, "ENG-142")).toBeGreaterThan(-1);
    }
  });

  // --- Per-stage ghosts: every stage shows the work nobody is on ---

  const stageGhost = (
    issueId: string, identifier: string, title: string,
    stageId: string, stageLabel: string, rank: number,
  ) => ({ issueId, identifier, title, stageId, stageLabel, rank });

  test("a ghost sits inside its own stage band, below that stage's sessions", () => {
    const sb = seeded();
    sb.setGroupMode("stage");
    sb.setSessionWorkflow(new Map([["alpha", stage("todo", "To do", 0)]]));
    sb.setGhostSessions([stageGhost("i1", "ENG-142", "fix flaky auth", "todo", "To do", 0)]);
    const header = linesWith(sb, "To do");
    expect(header).toBeGreaterThan(-1);
    expect(header).toBeLessThan(linesWith(sb, "alpha"));
    // Real work outranks work nobody has picked up.
    expect(linesWith(sb, "alpha")).toBeLessThan(linesWith(sb, "ENG-142"));
    // …and no separate Up next band is emitted on this axis.
    expect(linesWith(sb, "Up next")).toBe(-1);
  });

  test("a stage holding only ghosts still gets a band", () => {
    // The band can only be named from the ghost's own stageLabel here — there
    // is no session in that stage to carry it.
    const sb = seeded();
    sb.setGroupMode("stage");
    sb.setSessionWorkflow(new Map([["alpha", stage("todo", "To do", 0)]]));
    sb.setGhostSessions([stageGhost("i1", "ENG-9", "ship it", "review", "In review", 1)]);
    expect(linesWith(sb, "In review")).toBeGreaterThan(-1);
    expect(linesWith(sb, "ENG-9")).toBeGreaterThan(-1);
  });

  test("ghost-only stage bands obey workflow order like any other", () => {
    const sb = seeded();
    sb.setGroupMode("stage");
    sb.setSessionWorkflow(new Map());
    sb.setGhostSessions([
      stageGhost("i2", "ENG-2", "second", "review", "In review", 1),
      stageGhost("i1", "ENG-1", "first", "todo", "To do", 0),
    ]);
    expect(linesWith(sb, "To do")).toBeLessThan(linesWith(sb, "In review"));
    expect(linesWith(sb, "ENG-1")).toBeLessThan(linesWith(sb, "ENG-2"));
  });

  test("ghosts count toward a collapsed band's tally", () => {
    // A stage of only ghosts must not collapse to a header reading "(0)".
    const sb = seeded();
    sb.setGroupMode("stage");
    sb.setSessionWorkflow(new Map());
    sb.setGhostSessions([
      stageGhost("i1", "ENG-1", "one", "todo", "To do", 0),
      stageGhost("i2", "ENG-2", "two", "todo", "To do", 0),
    ]);
    sb.toggleGroup("stage:todo");
    const g = sb.getGrid();
    const row = linesWith(sb, "To do");
    const text = Array.from({ length: WIDTH }, (_, i) => g.cells[row][i].char).join("");
    expect(text).toContain("(2)");
    expect(linesWith(sb, "ENG-1")).toBe(-1);
  });

  test("per-stage ghosts stay out of the session cycle order too", () => {
    const sb = seeded();
    sb.setGroupMode("stage");
    sb.setSessionWorkflow(new Map([["alpha", stage("todo", "To do", 0)]]));
    const before = sb.getDisplayOrderIds();
    sb.setGhostSessions([stageGhost("i1", "ENG-142", "fix it", "todo", "To do", 0)]);
    expect(sb.getDisplayOrderIds()).toEqual(before);
  });

  test("a filter suppresses per-stage ghosts, and empties a ghost-only band", () => {
    const sb = seeded();
    sb.setGroupMode("stage");
    sb.setSessionWorkflow(new Map());
    sb.setGhostSessions([stageGhost("i1", "ENG-1", "one", "todo", "To do", 0)]);
    expect(linesWith(sb, "ENG-1")).toBeGreaterThan(-1);
    sb.setFilterMode("attention");
    expect(linesWith(sb, "ENG-1")).toBe(-1);
    expect(linesWith(sb, "To do")).toBe(-1); // nothing left to head
  });

  test("a filter hides the band — ghosts have no agent state to match on", () => {
    const sb = seeded();
    sb.setGhostSessions([ghost("i1", "ENG-142", "fix flaky auth test")]);
    expect(linesWith(sb, "Up next")).toBeGreaterThan(-1);
    for (const mode of ["attention", "active"] as const) {
      sb.setFilterMode(mode);
      expect(linesWith(sb, "Up next")).toBe(-1);
      expect(linesWith(sb, "ENG-142")).toBe(-1);
    }
    sb.setFilterMode("all");
    expect(linesWith(sb, "Up next")).toBeGreaterThan(-1);
  });

  test("a long title is truncated rather than spilling past the sidebar edge", () => {
    const sb = seeded();
    sb.setGhostSessions([ghost("i1", "ENG-142", "a".repeat(200))]);
    const g = sb.getGrid();
    const row = linesWith(sb, "aaa");
    // Nothing may be written in the final column — that's the sidebar's border.
    expect(g.cells[row][WIDTH - 1].char).not.toBe("a");
  });

  test("header shows clickable group + sort chips, each its own hit target", () => {
    const sb = seeded();
    const header = () => Array.from({ length: WIDTH }, (_, i) => sb.getGrid().cells[0][i].char).join("");
    const row0 = header();
    expect(row0).toContain("⊞ Project"); // group chip + current mode name
    expect(row0).toContain("⇅ Name");    // sort chip + current mode name

    // Each glyph plus its trailing mode name is that axis's click target; the
    // other chip and non-header rows are not.
    const groupCol = [...row0].findIndex((c) => c === "⊞");
    const sortCol = [...row0].findIndex((c) => c === "⇅");
    expect(sb.headerGroupToggleHit(0, groupCol)).toBe(true);      // group glyph
    expect(sb.headerGroupToggleHit(0, groupCol + 2)).toBe(true);  // group mode name
    expect(sb.headerGroupToggleHit(0, sortCol)).toBe(false);      // that's the sort chip
    expect(sb.headerSortToggleHit(0, sortCol)).toBe(true);        // sort glyph
    expect(sb.headerSortToggleHit(0, sortCol + 2)).toBe(true);    // sort mode name
    expect(sb.headerSortToggleHit(0, groupCol)).toBe(false);      // that's the group chip
    expect(sb.headerGroupToggleHit(1, groupCol)).toBe(false);     // separator row
    expect(sb.headerSortToggleHit(4, sortCol)).toBe(false);       // a session row
  });

  test("switching sort resets the scroll to the top (no bleed into the header)", () => {
    const sb = new Sidebar(WIDTH, 12); // short viewport so the list overflows
    sb.updateSessions(makeSessions(
      Array.from({ length: 12 }, (_, i) => ({ name: `s${i}`, project: "p" })),
    ));
    sb.setAgentStateRecord("$11", { state: "waiting", since: Date.now() });
    sb.scrollBy(20); // scroll far down
    sb.setSortMode("status");
    // Row 1 is the header separator — it must be only rule chars, never a
    // session name bled up from a stale scroll offset.
    const sep = Array.from({ length: WIDTH }, (_, i) => sb.getGrid().cells[1][i].char).join("");
    expect(sep.replace(/[─\s]/g, "")).toBe("");
  });
});

// --- Parked band ---
//
// The mirror image of the Pinned band: pins float to the top, parked sinks to
// the bottom as a single collapsed row. The point is to shrink handed-off work
// to one line without killing the session, so the row must be collapsed by
// default and must still show a count of what is waiting inside it.

describe("Sidebar parked band", () => {
  const W = 26;

  function parkedSidebar(parked: string[]): Sidebar {
    const sb = new Sidebar(W, 30);
    sb.setParkedSessions(new Set(parked));
    sb.updateSessions(
      makeSessions([
        { name: "alpha", directory: "~/Code/work/alpha" },
        { name: "beta", directory: "~/Code/work/beta" },
        { name: "gamma", directory: "~/Code/work/gamma" },
      ]),
    );
    return sb;
  }

  function allText(sb: Sidebar): string {
    const g = sb.getGrid();
    return Array.from({ length: g.rows }, (_, r) =>
      Array.from({ length: W }, (_, i) => g.cells[r][i].char).join("")).join("\n");
  }

  function lineOf(sb: Sidebar, needle: string): number {
    const g = sb.getGrid();
    for (let r = 0; r < g.rows; r++) {
      const line = Array.from({ length: W }, (_, i) => g.cells[r][i].char).join("");
      if (line.includes(needle)) return r;
    }
    return -1;
  }

  test("no Parked group when nothing is parked", () => {
    expect(allText(parkedSidebar([]))).not.toContain("Parked");
  });

  test("parked sessions collapse into one Parked row at the bottom", () => {
    const sb = parkedSidebar(["beta"]);
    const parkedRow = lineOf(sb, "Parked");
    expect(parkedRow).toBeGreaterThan(-1);
    // Below every unparked session — it is the back burner, not a headline.
    expect(parkedRow).toBeGreaterThan(lineOf(sb, "alpha"));
    expect(parkedRow).toBeGreaterThan(lineOf(sb, "gamma"));
  });

  test("the band is collapsed by default, hiding its members", () => {
    expect(allText(parkedSidebar(["beta"]))).not.toContain("beta");
  });

  test("expanding the band reveals its members", () => {
    const sb = parkedSidebar(["beta"]);
    sb.toggleGroup("parked");
    expect(allText(sb)).toContain("beta");
  });

  test("parked sessions are excluded from their normal group", () => {
    const sb = parkedSidebar(["beta"]);
    sb.toggleGroup("parked");
    // "beta" appears once, under Parked — not also under its project group.
    const occurrences = allText(sb).split("\n").filter((l) => l.includes("beta")).length;
    expect(occurrences).toBe(1);
  });

  test("a pinned session is never also parked — pinning wins", () => {
    const sb = new Sidebar(W, 30);
    sb.setPinnedSessions(new Set(["beta"]));
    sb.setParkedSessions(new Set(["beta"]));
    sb.updateSessions(makeSessions([{ name: "alpha" }, { name: "beta" }]));
    const text = allText(sb);
    expect(text).toContain("Pinned");
    expect(text).not.toContain("Parked");
  });
});

// The disclosure: a session carrying several issues expands in place to list
// them. The rows are sub-rows of their session, not peers of it, which is what
// keeps navigation and the session cycle meaning what they meant before.
describe("Sidebar session issue disclosure", () => {
  const WIDE = 44;

  function withIssues(
    issues: Array<{ id: string; identifier: string; title?: string; status?: string; stateType?: string }>,
  ): Map<string, SessionContext> {
    return new Map([["api", {
      sessionName: "api",
      dir: "/tmp",
      branch: "main",
      remote: null,
      mrs: [],
      issues: issues.map((i) => ({
        id: i.id,
        identifier: i.identifier,
        title: i.title ?? "Some work",
        status: i.status ?? "In Progress",
        stateType: i.stateType,
        assignee: null,
        linkedMrUrls: [],
        webUrl: "",
        source: "manual",
      })),
      resolvedAt: Date.now(),
    } as unknown as SessionContext]]);
  }

  const TWO = [
    { id: "a", identifier: "TRA-1", title: "Parse CSV", status: "In Progress", stateType: "started" },
    { id: "b", identifier: "TRA-2", title: "Column map", status: "Todo", stateType: "unstarted" },
  ];

  function build(width = WIDE, issues = TWO) {
    const sidebar = new Sidebar(width, 30);
    sidebar.updateSessions(makeSessions([{ name: "api" }]));
    sidebar.setSessionContexts(withIssues(issues));
    return sidebar;
  }

  const text = (sidebar: Sidebar) =>
    sidebar.getGrid().cells.map((row) => row.map((c) => c.char).join("")).join("\n");

  test("collapsed by default, so an untouched sidebar looks as it always did", () => {
    const sidebar = build();
    expect(sidebar.isSessionExpanded("api")).toBe(false);
    expect(text(sidebar)).not.toContain("Parse CSV");
  });

  test("expanding lists every issue the session carries", () => {
    const sidebar = build();
    sidebar.toggleSessionIssues("api");
    const out = text(sidebar);
    expect(out).toContain("TRA-1");
    expect(out).toContain("TRA-2");
    expect(out).toContain("Parse CSV");
    expect(out).toContain("Column map");
  });

  test("toggling again collapses it", () => {
    const sidebar = build();
    expect(sidebar.toggleSessionIssues("api")).toBe(true);
    expect(sidebar.toggleSessionIssues("api")).toBe(false);
    expect(text(sidebar)).not.toContain("Parse CSV");
  });

  // The badge names the driving issue; the first disclosed row must be that
  // same issue, or `+N` reads as expanding to a different set than it named.
  test("the driving issue leads the list, matching the badge", () => {
    const sidebar = build(WIDE, [
      { id: "a", identifier: "TRA-9", title: "Done bit", status: "Done", stateType: "completed" },
      { id: "b", identifier: "TRA-4", title: "Open bit", status: "Todo", stateType: "unstarted" },
    ]);
    sidebar.toggleSessionIssues("api");
    const rows = text(sidebar).split("\n");
    const badgeRow = rows.findIndex((r) => r.includes("TRA-4 +1"));
    expect(badgeRow).toBeGreaterThanOrEqual(0);
    // First issue row after the session's own rows names the driving issue.
    const firstIssueRow = rows.findIndex((r, i) => i > badgeRow && r.includes("TRA-"));
    expect(rows[firstIssueRow]).toContain("TRA-4");
  });

  test("a finished issue stays on the list rather than vanishing from the count", () => {
    const sidebar = build(WIDE, [
      { id: "a", identifier: "TRA-4", title: "Open bit", status: "Todo", stateType: "unstarted" },
      { id: "b", identifier: "TRA-9", title: "Done bit", status: "Done", stateType: "completed" },
    ]);
    sidebar.toggleSessionIssues("api");
    expect(text(sidebar)).toContain("TRA-9");
  });

  describe("the disclosure is offered only when it reveals something", () => {
    test("one issue is not expandable — the badge already names it", () => {
      const sidebar = build(WIDE, [TWO[0]!]);
      expect(sidebar.canExpandSession("api")).toBe(false);
      expect(sidebar.toggleSessionIssues("api")).toBeNull();
      expect(text(sidebar)).not.toContain("▸");
    });

    test("no issues is not expandable either", () => {
      const sidebar = new Sidebar(WIDE, 30);
      sidebar.updateSessions(makeSessions([{ name: "api" }]));
      expect(sidebar.canExpandSession("api")).toBe(false);
      expect(sidebar.toggleSessionIssues("api")).toBeNull();
    });

    test("two issues draw a chevron beside the badge", () => {
      expect(text(build())).toContain("▸");
    });

    test("the chevron turns down when expanded", () => {
      const sidebar = build();
      sidebar.toggleSessionIssues("api");
      expect(text(sidebar)).toContain("▾");
    });

    // A session that drops to one issue has nothing left to disclose, so it
    // must collapse on its own rather than leave a chevron revealing the row
    // its own badge already shows.
    test("falling back to one issue stops disclosing, even while expanded", () => {
      const sidebar = build();
      sidebar.toggleSessionIssues("api");
      expect(text(sidebar)).toContain("Parse CSV");

      sidebar.setSessionContexts(withIssues([TWO[0]!]));
      const out = text(sidebar);
      expect(out).not.toContain("▾");
      expect(out).not.toContain("Parse CSV");
    });
  });

  describe("rows are sub-rows, not peers", () => {
    test("they add no stops to the session cycle", () => {
      const sidebar = build();
      const before = sidebar.getDisplayOrderIds();
      sidebar.toggleSessionIssues("api");
      expect(sidebar.getDisplayOrderIds()).toEqual(before);
    });

    // Ctrl-Shift-Down walking through five tickets to reach the next session
    // would break navigation in exactly the sessions this feature is for.
    test("they add no stops to keyboard navigation", () => {
      const sidebar = build();
      const before = sidebar.getNavOrder().length;
      sidebar.toggleSessionIssues("api");
      expect(sidebar.getNavOrder().length).toBe(before);
    });

    test("clicking one selects the issue and names its session", () => {
      const sidebar = build();
      sidebar.toggleSessionIssues("api");
      const rows = text(sidebar).split("\n");
      const row = rows.findIndex((r) => r.includes("Column map"));
      expect(sidebar.getSelectionByRow(row)).toEqual({
        type: "sessionIssue", sessionId: "$0", issueId: "b",
      });
    });
  });

  describe("the badge is the click target", () => {
    test("a click on the badge discloses; one to its left does not", () => {
      const sidebar = build();
      const rows = text(sidebar).split("\n");
      // TRA-2 drives: it is unstarted, which is less advanced than TRA-1.
      const badgeRow = rows.findIndex((r) => r.includes("TRA-2 +1"));
      expect(badgeRow).toBeGreaterThanOrEqual(0);
      const col = rows[badgeRow]!.indexOf("▸");
      expect(sidebar.disclosureHit(badgeRow, col)).toBe("api");
      expect(sidebar.disclosureHit(badgeRow, col + 2)).toBe("api"); // the id itself
      expect(sidebar.disclosureHit(badgeRow, col - 2)).toBeNull();  // the name
    });

    test("a one-issue session offers no target at all", () => {
      const sidebar = build(WIDE, [TWO[0]!]);
      for (let r = 0; r < 30; r++) expect(sidebar.disclosureHit(r, WIDE - 3)).toBeNull();
    });
  });

  describe("narrow sidebars drop fields right-to-left", () => {
    test("a wide sidebar shows identifier, title and status", () => {
      const sidebar = build(WIDE);
      sidebar.toggleSessionIssues("api");
      const row = text(sidebar).split("\n").find((r) => r.includes("Parse CSV"))!;
      expect(row).toContain("TRA-1");
      expect(row).toContain("In Progress");
    });

    // The identifier is the one field that makes a row identifiable, so the
    // status name gives way to a glyph and the title goes entirely before the
    // identifier is touched. TRA-1's row is the one to read: TRA-2's identifier
    // also appears in the badge above, since it is the driving issue.
    test("a status too long to fit becomes a glyph, and the title is dropped", () => {
      const sidebar = build(20);
      sidebar.toggleSessionIssues("api");
      const row = text(sidebar).split("\n").find((r) => r.includes("TRA-1"))!;
      expect(row).toBeDefined();
      expect(row).not.toContain("In Progress");
      expect(row).toContain("◐"); // started
    });

    // A status that still fits keeps its name — the glyph is a fallback, not a
    // narrow-sidebar style.
    test("a status that fits is still spelled out", () => {
      const sidebar = build(20);
      sidebar.toggleSessionIssues("api");
      const rows = text(sidebar).split("\n");
      const badgeRow = rows.findIndex((r) => r.includes("+1"));
      const row = rows.find((r, i) => i > badgeRow && r.includes("TRA-2"))!;
      expect(row).toContain("Todo");
    });

    test("the identifier survives even when only it fits", () => {
      const sidebar = build(14);
      sidebar.toggleSessionIssues("api");
      const row = text(sidebar).split("\n").find((r) => r.includes("TRA-1"))!;
      expect(row).toBeDefined();
      expect(row).not.toContain("Parse");
    });
  });

  // A collapsed band hides its sessions, and an expanded session inside one
  // must go with it — the rows are emitted through the same path as the
  // session, so this holds by construction rather than by a second check.
  test("a collapsed group hides the disclosed rows too", () => {
    const sidebar = new Sidebar(WIDE, 30);
    sidebar.updateSessions(makeSessions([{ name: "api", directory: "~/Code/proj/api" }]));
    sidebar.setSessionContexts(withIssues(TWO));
    sidebar.toggleSessionIssues("api");
    expect(text(sidebar)).toContain("Parse CSV");

    const group = sidebar.getGroups().find((g) => g.label.includes("Code"));
    expect(group).toBeDefined();
    sidebar.toggleGroup(group!.key);
    expect(text(sidebar)).not.toContain("Parse CSV");
  });

  test("expansion is dropped when the session dies, so a reused name starts fresh", () => {
    const sidebar = build();
    sidebar.toggleSessionIssues("api");
    expect(sidebar.isSessionExpanded("api")).toBe(true);
    sidebar.updateSessions(makeSessions([{ name: "other" }]));
    expect(sidebar.isSessionExpanded("api")).toBe(false);
  });
});

// The workflow field at the head of a session's detail row, and the drift form
// it takes when the tracker disagrees with what the MR and the session prove.
//
// Everything here arrives pre-resolved through setSessionWorkflow — the same
// boundary as setParkedSessions — so these set it directly.
describe("Sidebar workflow field", () => {
  const WIDE = 40;

  function wf(over: Partial<SessionWorkflow> = {}): SessionWorkflow {
    return {
      band: { id: "review", label: "Review", rank: 2 },
      label: "Review",
      stateType: "started",
      drift: null,
      driftByIssue: new Map(),
      ...over,
    };
  }

  function build(width = WIDE, workflow: SessionWorkflow | null = wf()) {
    const sidebar = new Sidebar(width, 30);
    sidebar.updateSessions(makeSessions([{ name: "api", gitBranch: "feat/importer" }]));
    if (workflow) sidebar.setSessionWorkflow(new Map([["api", workflow]]));
    return sidebar;
  }

  const rows = (sidebar: Sidebar) =>
    sidebar.getGrid().cells.map((row) => row.map((c) => c.char).join(""));
  /** The session's detail row: the one carrying its workflow word. */
  const detailRow = (sidebar: Sidebar, needle: string) =>
    rows(sidebar).find((r) => r.includes(needle));
  /** The session's own name row — never the workflow word, never a branch. */
  const findNameRow = (sidebar: Sidebar) =>
    rows(sidebar).findIndex((r) => r.includes("api"));

  // The branch left the sidebar with this move: it was only ever visible as
  // row 1's name, and `build()` sets no issue context, so there is nothing at
  // all on the left of these rows besides the field itself.
  test("a wide sidebar shows the stage word on the detail row; no branch appears", () => {
    const row = detailRow(build(), "Review")!;
    expect(row).toBeDefined();
    expect(row).toContain("Review");
    expect(row).not.toContain("feat/importer");
  });

  // The field was added to an existing row; it has to take that row's state
  // styling like everything already on it, rather than staying dim in the one
  // place the user is looking. Resting, it sets a specific quiet color
  // (WORKFLOW_ATTRS); active, it inherits the row's own detail styling and
  // sets none of its own — the two are observably different fg values.
  test("the field lights up with its row when that row is active", () => {
    const resting = build();
    const restRowIdx = rows(resting).findIndex((r) => r.includes("Review"));
    const restText = rows(resting)[restRowIdx]!;
    const restCell = resting.getGrid().cells[restRowIdx]![restText.indexOf("Review")]!;

    const sidebar = build();
    sidebar.setActiveSession("$0");
    const rowIdx = rows(sidebar).findIndex((r) => r.includes("Review"));
    expect(rowIdx).toBeGreaterThan(-1);
    const text = rows(sidebar)[rowIdx]!;
    const activeCell = sidebar.getGrid().cells[rowIdx]![text.indexOf("Review")]!;

    expect(activeCell.fg).not.toBe(restCell.fg);
  });

  test("no workflow resolved leaves the row without a stage word", () => {
    const sidebar = build(WIDE, null);
    const nameRowIdx = findNameRow(sidebar);
    expect(nameRowIdx).toBeGreaterThan(-1);
    const row = rows(sidebar)[nameRowIdx + 1]!;
    expect(row).not.toContain("Review");
  });

  // Nothing follows the field any more, so there is nothing left for it to
  // compete with as the sidebar narrows — this only pins down that a branch
  // never reappears to take the space back.
  test("the stage word has no branch to compete with at any width", () => {
    expect(detailRow(build(22), "Review")).toContain("Review");
    const narrow = detailRow(build(15), "Review");
    expect(narrow).toContain("Review");
    expect(narrow).not.toContain("feat/importer");
  });

  test("below the stage word's own width it degrades to a stateType glyph", () => {
    const row = detailRow(build(8), "◐");
    expect(row).toBeDefined();
    expect(row).not.toContain("Review");
  });

  // `unknown` is the default when an adapter populates no stateType, which
  // makes this the common case, not an exotic one. With no badge, the field is
  // the only thing on the row's left, so it renders alone — nothing follows it
  // to collide with.
  test("a marker form renders alone, with nothing after it", () => {
    const sidebar = build(13, wf({ label: "In Progress", stateType: undefined }));
    const nameRowIdx = findNameRow(sidebar);
    const row = rows(sidebar)[nameRowIdx + 1]!;
    expect(row).toContain("·");
    expect(row).not.toContain("· ·");
    expect(row).not.toContain("In Progress");
  });

  // The separator now sits between the badge and the field, not between the
  // field and a branch — but the collision it has to avoid is the same one:
  // `·` is both the backlog/unknown glyph and the character inside the
  // separator, so an unconditional full separator ahead of a terse field
  // renders "· ·", indistinguishable as one thing or two. Reachable at the
  // sidebar's own documented default width (26) with a two-issue badge.
  test("a marker form is not preceded by the full separator when a badge leads the row", () => {
    const sidebar = build(26, wf({ label: "In Progress", stateType: undefined }));
    sidebar.setSessionContexts(new Map([["api", {
      issues: [
        { id: "a", identifier: "TRA-123", title: "One", status: "Todo", stateType: "unstarted" },
        { id: "b", identifier: "TRA-124", title: "Two", status: "Todo", stateType: "unstarted" },
      ],
      mrs: [],
    } as unknown as SessionContext]]));
    const row = detailRow(sidebar, "TRA-123")!;
    expect(row).toBeDefined();
    expect(row).not.toContain("· ·");
    expect(row).toContain("·");
  });

  test("the drift marker gets the same treatment", () => {
    const narrow = wf({
      label: "In Progress",
      drift: "Ready for Release",
      driftByIssue: new Map([["a", "Ready for Release"]]),
    });
    const sidebar = build(20, narrow);
    const nameRowIdx = findNameRow(sidebar);
    const row = rows(sidebar)[nameRowIdx + 1]!;
    expect(row).toContain("!");
    expect(row).not.toContain("! ·");
  });

  test("the drift marker gets the same treatment, with a badge leading the row", () => {
    const narrow = wf({
      label: "In Progress",
      drift: "Ready for Release",
      driftByIssue: new Map([["a", "Ready for Release"]]),
    });
    const sidebar = build(26, narrow);
    sidebar.setSessionContexts(new Map([["api", {
      issues: [
        { id: "a", identifier: "TRA-123", title: "One", status: "Todo", stateType: "unstarted" },
        { id: "b", identifier: "TRA-124", title: "Two", status: "Todo", stateType: "unstarted" },
      ],
      mrs: [],
    } as unknown as SessionContext]]));
    const row = detailRow(sidebar, "TRA-123")!;
    expect(row).toBeDefined();
    expect(row).toContain("!");
    expect(row).not.toContain("! ·");
  });

  // A label can sit in the two-column band where it fits the budget the
  // narrow separator implies but not the budget the full separator costs
  // back — a short badge ("TRA-1", not "TRA-123") is what opens that band at
  // this width. Measuring twice would disagree with itself here: the first
  // pass sees "In Progress" fit and reaches for the full separator, but the
  // budget that separator leaves is one column short, so a naive
  // re-measurement falls to the terse glyph while the separator still
  // assumes a word — reproducing "· ·" by a different path than the one
  // above. The resolution falls back to the first (self-consistent)
  // measurement instead: a full word gets a single space rather than either
  // a doubled dot or an invented three-candidate degrade step.
  test("a label straddling the separator's budget keeps its word, with a single space", () => {
    const sidebar = build(26, wf({ label: "In Progress", stateType: undefined }));
    sidebar.setSessionContexts(new Map([["api", {
      issues: [
        { id: "a", identifier: "TRA-1", title: "One", status: "Todo", stateType: "unstarted" },
        { id: "b", identifier: "TRA-2", title: "Two", status: "Todo", stateType: "unstarted" },
      ],
      mrs: [],
    } as unknown as SessionContext]]));
    const row = detailRow(sidebar, "TRA-1")!;
    expect(row).toBeDefined();
    expect(row).toContain("In Progress");
    expect(row).not.toContain("· ·");
    expect(row).not.toContain("· In Progress"); // not the full " · " separator either
  });

  // A row reading "Review" under a "REVIEW" header says nothing, and there is
  // no branch left for the freed width to go to — the row is simply shorter.
  describe("grouped by stage, the header already says it", () => {
    function grouped(width = WIDE, workflow = wf()) {
      const sidebar = new Sidebar(width, 30);
      sidebar.updateSessions(makeSessions([{ name: "api", gitBranch: "feat/importer" }]));
      sidebar.setSessionWorkflow(new Map([["api", workflow]]));
      sidebar.setGroupMode("stage");
      return sidebar;
    }

    test("the stage word drops from the row, and nothing replaces it", () => {
      const sidebar = grouped();
      const all = rows(sidebar);
      const header = all.findIndex((r) => r.includes("Review"));
      expect(header).toBeGreaterThan(-1);
      // The only "Review" on screen is the header itself.
      expect(all.filter((r) => r.includes("Review")).length).toBe(1);
      expect(all.some((r) => r.includes("feat/importer"))).toBe(false);
    });

    // The header supplies where the ticket is; the disagreement is about where
    // it should be, which no header carries.
    test("drift survives, without repeating the stage the header names", () => {
      const sidebar = grouped(WIDE, wf({ drift: "Done", driftByIssue: new Map([["a", "Done"]]) }));
      const row = rows(sidebar).find((r) => r.includes("→Done"))!;
      expect(row).toBeDefined();
      expect(row).not.toContain("Review→Done");
    });

    // A session under group=stage can still land in Pinned or Parked, whose
    // headers name neither — so the word has to come back. Asserted against
    // the session's own detail row rather than "some row contains Review":
    // a stage band header reading "Review" would satisfy that too, and this
    // describe block's whole subject is telling the two apart.
    test("a pinned session keeps its stage word, since no header names it", () => {
      const sidebar = grouped();
      sidebar.setPinnedSessions(new Set(["api"]));
      const all = rows(sidebar);
      expect(all.some((r) => r.includes("Pinned"))).toBe(true);
      const nameRowIdx = all.findIndex((r) => r.includes("api"));
      expect(nameRowIdx).toBeGreaterThan(-1);
      expect(all[nameRowIdx + 1]).toContain("Review");
    });

    // Its sessions fall to the flat remainder, where nothing names the stage.
    test("a session whose stage draws no band keeps its word", () => {
      const sidebar = grouped(WIDE, wf({ band: null }));
      expect(rows(sidebar).some((r) => r.includes("Review"))).toBe(true);
    });

    test("on every other axis the word stays", () => {
      const sidebar = grouped();
      sidebar.setGroupMode("project");
      expect(rows(sidebar).some((r) => r.includes("Review"))).toBe(true);
    });
  });

  test("a status claimed by no stage still names itself on the row", () => {
    const row = detailRow(build(WIDE, wf({ band: null, label: "Blocked" })), "Blocked")!;
    expect(row).toContain("Blocked");
  });

  describe("drift", () => {
    const drifting = (over: Partial<SessionWorkflow> = {}) =>
      wf({ drift: "Done", driftByIssue: new Map([["a", "Done"]]), ...over });

    test("names where the workflow says it should be", () => {
      const row = detailRow(build(WIDE, drifting()), "Review→Done")!;
      expect(row).toContain("Review→Done");
    });

    // The target is what the fix key will write, so the current stage — which
    // the drift already contradicts — is what gives way first.
    test("the current stage drops before the target does", () => {
      const row = detailRow(build(11, drifting()), "→Done")!;
      expect(row).toBeDefined();
      expect(row).not.toContain("Review→Done");
      expect(row).toContain("→Done");
    });

    // Not "⚠": this sidebar tracks columns explicitly and that glyph's width
    // varies between terminals.
    test("the minimal form is a single unambiguous column", () => {
      const wide = rows(build(WIDE, drifting())).join("\n");
      const narrow = rows(build(7, drifting())).join("\n");
      expect(wide).not.toContain("⚠");
      expect(narrow).not.toContain("⚠");
      expect(narrow).not.toContain("→Done");
      expect(narrow.split("\n").some((r) => r.includes("!"))).toBe(true);
    });
  });

  describe("the disclosure marks every drifting issue, not just the driving one", () => {
    function withIssues(): Map<string, SessionContext> {
      return new Map([["api", {
        sessionName: "api",
        dir: "/tmp",
        branch: "feat/importer",
        remote: null,
        mrs: [],
        issues: [
          { id: "a", identifier: "TRA-1", title: "Parse CSV", status: "Todo", stateType: "unstarted" },
          { id: "b", identifier: "TRA-2", title: "Column map", status: "In Review", stateType: "started" },
        ],
        resolvedAt: Date.now(),
      } as unknown as SessionContext]]);
    }

    function expanded(width: number, driftByIssue: Map<string, string>) {
      const sidebar = new Sidebar(width, 30);
      sidebar.updateSessions(makeSessions([{ name: "api", gitBranch: "feat/importer" }]));
      sidebar.setSessionContexts(withIssues());
      sidebar.setSessionWorkflow(new Map([["api", wf({
        label: "Todo",
        drift: driftByIssue.get("a") ?? null,
        driftByIssue,
      })]]));
      sidebar.toggleSessionIssues("api");
      return sidebar;
    }

    test("a sub-row names both its status and its target when both fit", () => {
      const sidebar = expanded(48, new Map([["a", "Done"], ["b", "Done"]]));
      const row = rows(sidebar).find((r) => r.includes("Parse CSV"))!;
      expect(row).toContain("Todo→Done");
    });

    test("the target drops before the raw status, which is why you expanded", () => {
      const sidebar = expanded(24, new Map([["a", "Done"], ["b", "Done"]]));
      const row = rows(sidebar).find((r) => r.includes("TRA-2"))!;
      expect(row).not.toContain("In Review→Done");
      expect(row).toContain("→Done");
    });

    // The collapsed row can only speak for the issue its badge names; expanding
    // is how the rest become visible.
    test("a drifting non-driving issue is marked even when the row above is not", () => {
      const sidebar = expanded(48, new Map([["b", "Done"]]));
      const all = rows(sidebar).join("\n");
      const driving = rows(sidebar).find((r) => r.includes("Parse CSV"))!;
      const other = rows(sidebar).find((r) => r.includes("Column map"))!;
      expect(driving).not.toContain("→Done");
      expect(other).toContain("→Done");
      expect(all).toContain("TRA-1");
    });

    test("with nothing drifting the sub-rows read exactly as they always did", () => {
      const sidebar = expanded(48, new Map());
      const row = rows(sidebar).find((r) => r.includes("Parse CSV"))!;
      expect(row).toContain("Todo");
      expect(row).not.toContain("→");
    });
  });
});

// Row 1 becomes the title (or the real name, with none), and the issue badge
// moves down to lead row 2 — see the module doc comment on renderSession.
describe("session titles", () => {
  const titled: SessionInfo[] = [{
    id: "$0", name: "tra-123", attached: true, activity: 0, windowCount: 1,
    gitBranch: "feat/cache", title: "Fix stale cache headers",
  }];

  // Row 2: overview, Row 3: spacer, Row 4: session name row, Row 5: detail row
  // — the permanent overview block every other describe block in this file
  // accounts for (see e.g. "renders ungrouped sessions without a group header").
  test("row 1 shows the title instead of the session name", () => {
    const sidebar = new Sidebar(40, 30);
    sidebar.updateSessions(titled);
    const grid = sidebar.getGrid();
    expect(rowText(grid, 4, 40)).toContain("Fix stale cache headers");
    expect(rowText(grid, 4, 40)).not.toContain("tra-123");
  });

  test("row 1 falls back to the session name when there is no title", () => {
    const sidebar = new Sidebar(40, 30);
    sidebar.updateSessions([{ ...titled[0], title: undefined }]);
    expect(rowText(sidebar.getGrid(), 4, 40)).toContain("tra-123");
  });

  test("the branch no longer appears on row 2", () => {
    const sidebar = new Sidebar(40, 30);
    sidebar.updateSessions(titled);
    expect(rowText(sidebar.getGrid(), 5, 40)).not.toContain("feat/cache");
  });

  test("row 2 leads with the issue badge", () => {
    const sidebar = new Sidebar(40, 30);
    sidebar.updateSessions(titled);
    sidebar.setSessionContexts(new Map([["tra-123", {
      issues: [
        { id: "1", identifier: "TRA-123", title: "Cache", status: "In Review", stateType: "started" },
        { id: "2", identifier: "TRA-124", title: "More", status: "In Review", stateType: "started" },
      ],
      mrs: [],
    } as unknown as SessionContext]]));
    const row2 = rowText(sidebar.getGrid(), 5, 40);
    expect(row2.trimStart().startsWith("▸ TRA-123 +1")).toBe(true);
    expect(rowText(sidebar.getGrid(), 4, 40)).not.toContain("TRA-123");
  });

  test("the issue badge survives a width that drops everything else", () => {
    const sidebar = new Sidebar(16, 30);
    sidebar.updateSessions(titled);
    sidebar.setSessionContexts(new Map([["tra-123", {
      issues: [{ id: "1", identifier: "TRA-123", title: "Cache", status: "In Review", stateType: "started" }],
      mrs: [],
    } as unknown as SessionContext]]));
    expect(rowText(sidebar.getGrid(), 5, 16)).toContain("TRA-123");
  });

  // Row 2's drop order is timer → stage word → stage glyph → drift marker →
  // MR id, with the badge last of all — so at a width where both cannot fit,
  // the badge is what survives and the MR id is what goes, not the reverse.
  test("the badge outranks the MR id when both cannot fit", () => {
    const sidebar = new Sidebar(18, 30);
    sidebar.updateSessions(titled);
    sidebar.setSessionContexts(new Map([["tra-123", {
      issues: [
        { id: "1", identifier: "TRA-123", title: "Cache", status: "In Review", stateType: "started" },
        { id: "2", identifier: "TRA-124", title: "More", status: "In Review", stateType: "started" },
      ],
      mrs: [{ id: "acme/repo#4321", createdAt: Date.now() }],
    } as unknown as SessionContext]]));
    const row2 = rowText(sidebar.getGrid(), 5, 18);
    expect(row2).toContain("TRA-123");
    expect(row2).not.toContain("#4321");
  });

  test("a long title truncates with an ellipsis at a narrow width", () => {
    const sidebar = new Sidebar(24, 30);
    sidebar.updateSessions([{
      id: "$0", name: "tra-123", attached: true, activity: 0, windowCount: 1,
      title: "This title is far too long to fit in the sidebar at all",
    }]);
    const row = rowText(sidebar.getGrid(), 4, 24);
    expect(row).toContain("…");
    expect(row).not.toContain("too long to fit");
  });

  // Column bookkeeping for a title is sensitive precisely because a title is
  // human text a model produced, and may contain CJK or emoji — the one
  // string on this row that .length would get wrong. Checked here, not just
  // in truncateToCols's own unit tests, because what matters is that
  // sidebar.ts actually passes it a column budget rather than a character
  // count: the mode badge sits at a fixed column right after the name, and a
  // character-count truncation would let a wide title overrun it.
  test("a title with wide characters truncates on the column budget, not the character count", () => {
    const sidebar = new Sidebar(30, 30);
    sidebar.updateSessions([{
      id: "$0", name: "tra-123", attached: true, activity: 0, windowCount: 1,
      title: "测试测试测试测试测试测试测试测试测试测试测试测试测试测试测",
    }]);
    sidebar.setSessionOtelState("$0", { ...makeSessionOtelState(), permissionMode: "plan" });
    const grid = sidebar.getGrid();
    const row = rowText(grid, 4, 30);
    expect(row).toContain("…");
    expect(grid.cells[4][28]!.char).toBe("P");
  });

  // Proves the trim-and-fallback decision actually runs through
  // `displaySessionName` rather than a reimplementation in sidebar.ts: a
  // whitespace-only title is truthy, so a naive `view.title ?? sessionName`
  // would display it as blank space instead of falling back to the name.
  test("a whitespace-only title falls back to the session name", () => {
    const sidebar = new Sidebar(40, 30);
    sidebar.updateSessions([{ ...titled[0], title: "   " }]);
    const row = rowText(sidebar.getGrid(), 4, 40);
    expect(row).toContain("tra-123");
    expect(row).not.toContain("Fix stale cache headers");
  });

  // Sorting by name has to key on the string the row shows, or the sidebar
  // reads as broken: a human sorting "by name" is sorting by what they read,
  // not by a tmux slug they never see. With real names alone "$1" would sort
  // before "$2"; the title flips it, which is what proves the fix is live.
  test("sort by name orders on the title, not the tmux session name", () => {
    const sidebar = new Sidebar(40, 30);
    sidebar.updateSessions([
      { id: "$1", name: "abc-real", attached: true, activity: 0, windowCount: 1 },
      { id: "$2", name: "xyz-real", attached: true, activity: 0, windowCount: 1, title: "aardvark task" },
    ]);
    sidebar.setSortMode("name");
    expect(sidebar.getDisplayOrderIds()).toEqual(["$2", "$1"]);
  });
});
