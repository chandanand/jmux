import { describe, test, expect } from "bun:test";
import {
  WorkflowScreen, buildRows, explainRow, destinationsFor, applyDestination,
  uniqueSectionLabel, isSelectable, tableLayout,
  type WorkflowPort, type WorkflowRow, type WorkflowBand,
} from "../workflow-screen";
import { parseViews, type PanelView } from "../panel-view";
import type { SettingDef } from "../settings-screen";
import type { CellGrid } from "../types";
import type { IssueStateType } from "../adapters/types";

// --- Fixtures ---

const STATUSES: Array<{ name: string; type: IssueStateType }> = [
  { name: "Triage", type: "triage" },
  { name: "Backlog", type: "backlog" },
  { name: "QA Failed", type: "started" },
  { name: "Dev Confirm", type: "started" },
  { name: "QA (PROD WEB)", type: "started" },
  { name: "Done", type: "completed" },
];

function views(): PanelView[] {
  return parseViews([
    {
      id: "urgent", label: "Urgent", source: "issues", filter: { scope: "assigned" },
      groupBy: "none", subGroupBy: "none", sortBy: "priority", sortOrder: "asc",
      sections: [{ label: "QA Failed", states: ["QA Failed"] }],
    },
    {
      id: "post-merge", label: "Post-merge", source: "issues", filter: { scope: "assigned" },
      groupBy: "none", subGroupBy: "none", sortBy: "priority", sortOrder: "asc",
      sections: [
        { label: "Dev Confirm", states: ["Dev Confirm"] },
        { label: "In QA", states: ["QA (PROD WEB)"] },
      ],
    },
    {
      id: "my-mrs", label: "My MRs", source: "mrs", filter: { scope: "authored" },
      groupBy: "none", subGroupBy: "none", sortBy: "updated", sortOrder: "desc",
    },
  ]);
}

interface Harness {
  port: WorkflowPort;
  current: () => PanelView[];
  writes: number;
}

function harness(over: Partial<WorkflowPort> = {}, initial: PanelView[] = views(),
                 parked: string[] = ["QA (PROD WEB)"]): Harness {
  const state = { views: initial, writes: 0, parked };
  const h: Harness = {
    current: () => state.views,
    get writes() { return state.writes; },
    port: {
      getViews: () => state.views,
      setViews: (next) => { state.views = next; state.writes++; },
      getStatuses: () => STATUSES,
      getIssueCounts: () => new Map([["qa failed", 4], ["qa (prod web)", 6], ["triage", 2]]),
      getParkedCounts: () => new Map([["qa (prod web)", 3]]),
      getParkedStates: () => state.parked,
      toggleParked: (st) => {
        const at = state.parked.findIndex((x) => x.toLowerCase() === st.toLowerCase());
        if (at >= 0) state.parked.splice(at, 1); else state.parked.push(st);
        state.writes++;
      },
      getUpNext: () => ["urgent"],
      toggleUpNext: () => {},
      getBands: () => [],
      trackerLabel: () => "Linear",
      repoLabel: () => null,
      ...over,
    },
  };
  return h;
}

const rowsOf = (h: Harness, collapsed = new Set<string>()): WorkflowRow[] =>
  buildRows(h.port, "global", collapsed);

const statusRow = (rows: WorkflowRow[], state: string) =>
  rows.find((r): r is Extract<WorkflowRow, { kind: "status" }> => r.kind === "status" && r.state === state)!;

// --- Row model ---

describe("buildRows", () => {
  test("lists tabs first, then every status in tab-then-config order", () => {
    // Two blocks, because they edit two different kinds of thing. Interleaving
    // them is what made every key mean something different per row.
    const rows = rowsOf(harness());
    expect(rows.filter((r) => r.kind === "tab").map((r: any) => r.label))
      .toEqual(["Urgent", "Post-merge", "My MRs"]);
    expect(rows.filter((r) => r.kind === "status").map((r: any) => r.state))
      .toEqual(["QA Failed", "Dev Confirm", "QA (PROD WEB)", "Triage", "Backlog", "Done"]);
  });

  test("statuses in no tab sort last, where they read as the work still to do", () => {
    const rows = rowsOf(harness()).filter((r) => r.kind === "status") as any[];
    expect(rows.slice(-3).map((r) => r.state)).toEqual(["Triage", "Backlog", "Done"]);
    expect(rows.slice(-3).every((r) => r.viewId === null)).toBe(true);
  });

  test("the table gets a column-heading row, so it reads as data", () => {
    const rows = rowsOf(harness());
    const band = rows.findIndex((r) => r.kind === "band" && r.label === "Statuses");
    expect(rows[band + 1]!.kind).toBe("columns");
    expect(isSelectable(rows[band + 1]!)).toBe(false);
  });

  test("an unassigned status is classified by the tracker, with nothing to configure", () => {
    const rows = rowsOf(harness());
    expect(statusRow(rows, "Triage")).toMatchObject({ viewId: null, trackerStage: "idea" });
    expect(statusRow(rows, "Done")).toMatchObject({ viewId: null, trackerStage: "done" });
  });

  test("a status inherits parking from the tab it is in, not from itself", () => {
    // One flag on "Post-merge" covers every status in it. There is no
    // per-status meaning to set, and so none to get wrong.
    expect(statusRow(rowsOf(harness()), "QA (PROD WEB)"))
      .toMatchObject({ viewId: "post-merge", parks: true, parked: 3 });
    expect(statusRow(rowsOf(harness()), "QA Failed")).toMatchObject({ parks: false });
  });

  test("live issue counts ride along on the row", () => {
    const rows = rowsOf(harness());
    expect(statusRow(rows, "QA Failed").issues).toBe(4);
    expect(statusRow(rows, "Backlog").issues).toBe(0);
  });

  test("a tab sums the issues of every status it claims", () => {
    const tab = rowsOf(harness()).find((r) => r.kind === "tab" && r.viewId === "post-merge");
    expect(tab).toMatchObject({ statuses: 2, issues: 6, parks: 1 });
  });

  test("a status listed in config but gone from the tracker still shows, flagged", () => {
    // Renaming a status in Linear must not make its mapping invisible.
    const stale = parseViews([{
      id: "t", label: "T", source: "issues", filter: { scope: "assigned" },
      groupBy: "none", subGroupBy: "none", sortBy: "priority", sortOrder: "asc",
      sections: [{ label: "Old Name", states: ["Old Name"] }],
    }]);
    expect(statusRow(rowsOf(harness({}, stale)), "Old Name")).toMatchObject({ known: false });
  });

  test("an MR tab is listed so the block matches the panel's tab bar", () => {
    const rows = rowsOf(harness());
    const at = rows.findIndex((r) => r.kind === "tab" && r.viewId === "my-mrs");
    expect(rows[at]).toMatchObject({ source: "mrs", statuses: 0 });
    expect(rows[at + 1]!.kind).toBe("new-tab");
  });

  test("up-next rank is on the tab row, so priority is visible where order is edited", () => {
    const rows = rowsOf(harness());
    expect((rows.find((r) => r.kind === "tab" && r.viewId === "urgent") as any).upNextRank).toBe(0);
    expect((rows.find((r) => r.kind === "tab" && r.viewId === "post-merge") as any).upNextRank).toBeNull();
  });

  test("behaviour bands are appended as ordinary setting rows", () => {
    const band: WorkflowBand = {
      label: "Parking",
      settings: [{ id: "p", label: "Park sections that mean", type: "multiselect", getValue: () => "Parked" }],
    };
    const rows = rowsOf(harness({ getBands: () => [band] }));
    expect(rows.at(-2)).toMatchObject({ kind: "band", label: "Parking" });
    expect(rows.at(-1)).toMatchObject({ kind: "setting" });
  });
});

describe("buildRows — the seed row", () => {
  test("offers a starting layout while nothing is configured", () => {
    const bare = parseViews([{
      id: "a", label: "A", source: "issues", filter: { scope: "assigned" },
      groupBy: "none", subGroupBy: "none", sortBy: "priority", sortOrder: "asc",
    }]);
    expect(rowsOf(harness({}, bare))[0]).toMatchObject({ kind: "seed", statuses: 6 });
  });

  test("disappears as soon as one section exists", () => {
    expect(rowsOf(harness()).some((r) => r.kind === "seed")).toBe(false);
  });

  test("is not offered when the tracker reports no statuses at all", () => {
    // Nothing to seed from, and the Unassigned band explains why instead.
    const bare = parseViews([{
      id: "a", label: "A", source: "issues", filter: { scope: "assigned" },
      groupBy: "none", subGroupBy: "none", sortBy: "priority", sortOrder: "asc",
    }]);
    const rows = rowsOf(harness({ getStatuses: () => [] }, bare));
    expect(rows.some((r) => r.kind === "seed")).toBe(false);
    expect(rows.find((r) => r.kind === "band" && r.label === "Statuses")).toMatchObject({
      hint: expect.stringContaining("Connect an issue tracker"),
    });
  });
});

// --- The explain line ---
//
// Every case here is a failure this feature shipped with: a mapping that did
// nothing, a status that fell through to a default nobody chose, a tab that
// said "parked" while a second setting quietly switched parking off.

describe("explainRow", () => {
  const explain = (state: string, over: Partial<WorkflowPort> = {}, v = views(), parked?: string[]) =>
    explainRow(statusRow(rowsOf(harness(over, v, parked)), state));

  test("a status in none of your stages says it is simply not shown", () => {
    expect(explain("Triage"))
      .toBe("Triage · 2 issues · in none of your stages — it never shows in the panel · its sessions stay in the sidebar");
  });

  test("a status that does not park says its session stays put", () => {
    expect(explain("QA Failed")).toBe("QA Failed · 4 issues · Urgent · its sessions stay in the sidebar");
  });

  test("a parked status says how many sessions it is parking now", () => {
    expect(explain("QA (PROD WEB)"))
      .toBe("QA (PROD WEB) · 6 issues · Post-merge · parks its sessions (3 now)");
  });

  test("a status can park while sitting in no tab at all", () => {
    // The two settings are orthogonal: where it shows, and whether it hides
    // the session. Deriving one from the other would make this unsayable.
    expect(explain("Triage", {}, views(), ["Triage"]))
      .toContain("in none of your stages — it never shows in the panel · parks its sessions");
  });

  test("a shared heading is named, so grouping is never a surprise", () => {
    const shared = parseViews([{
      id: "t", label: "T", source: "issues", filter: { scope: "assigned" },
      groupBy: "none", subGroupBy: "none", sortBy: "priority", sortOrder: "asc",
      sections: [{ label: "Blocked", states: ["QA Failed", "Triage"] }],
    }]);
    expect(explain("QA Failed", {}, shared)).toContain('T, under "Blocked"');
  });

  test("a status the tracker no longer has is called out", () => {
    const stale = parseViews([{
      id: "t", label: "T", source: "issues", filter: { scope: "assigned" },
      groupBy: "none", subGroupBy: "none", sortBy: "priority", sortOrder: "asc",
      sections: [{ label: "Old", states: ["Old"] }],
    }]);
    expect(explain("Old", {}, stale)).toContain("no longer in your tracker");
  });

  test("a tab reports its size, how much of it parks, and its rotation slot", () => {
    const rows = rowsOf(harness());
    const tab = (id: string) => rows.find((r) => r.kind === "tab" && r.viewId === id);
    expect(explainRow(tab("urgent")))
      .toBe("Urgent · 1 status · 4 issues · 1st in Up next");
    expect(explainRow(tab("post-merge")))
      .toBe("Post-merge · 2 statuses · 6 issues · 1 of them park · not in Up next");
  });

  test("a setting row borrows its own description", () => {
    const def: SettingDef = {
      id: "p", label: "Unpark", type: "multiselect",
      getValue: () => "…", describe: () => "Any of these beats every parking rule.",
    };
    expect(explainRow({ kind: "setting", def })).toBe("Any of these beats every parking rule.");
  });

  test("says nothing rather than something wrong when there is no row", () => {
    expect(explainRow(undefined)).toBe("");
  });
});

// --- Assignment ---

describe("destinations", () => {
  test("offers every stage, plus No stage, and never an MR tab", () => {
    expect(destinationsFor(views(), "Triage").map((d) => d.label))
      .toEqual(["Urgent", "Post-merge", "No stage"]);
  });

  test("marks the tab a status is already in rather than hiding it", () => {
    const d = destinationsFor(views(), "QA Failed").find((x) => x.label === "Urgent");
    expect(d!.annotation).toBe("already here");
  });

  test("offers a shared section only where one already exists", () => {
    const shared = parseViews([{
      id: "t", label: "T", source: "issues", filter: { scope: "assigned" },
      groupBy: "none", subGroupBy: "none", sortBy: "priority", sortOrder: "asc",
      sections: [
        { label: "Blocked", states: ["QA Failed", "Triage"] },
        { label: "Solo", states: ["Done"] },
      ],
    }]);
    expect(destinationsFor(shared, "Backlog").map((d) => d.label))
      .toEqual(["T", "T › Blocked", "No stage"]);
  });
});

describe("applyDestination", () => {
  test("picking a tab makes a section named after the status", () => {
    const next = applyDestination(views(), "Triage", "v\x00urgent");
    const urgent = next.find((v) => v.id === "urgent")!;
    expect(urgent.sections!.map((s) => [s.label, s.states])).toEqual([
      ["QA Failed", ["QA Failed"]],
      ["Triage", ["Triage"]],
    ]);
  });

  test("moving a status removes it from wherever it was", () => {
    // One home per status is what keeps the model comprehensible — two homes
    // would resolve by a first-wins tie-break nobody chose.
    const next = applyDestination(views(), "QA Failed", "v\x00post-merge");
    // ...and takes the header it emptied with it: a section with no statuses
    // classifies nothing, so leaving it would be a permanent dead row.
    expect(next.find((v) => v.id === "urgent")!.sections).toEqual([]);
    expect(next.find((v) => v.id === "post-merge")!.sections!.map((s) => s.label))
      .toEqual(["Dev Confirm", "In QA", "QA Failed"]);
  });

  test("picking the tab a status is already in changes nothing", () => {
    // Otherwise it would split into a second, duplicate section.
    expect(applyDestination(views(), "QA Failed", "v\x00urgent")).toEqual(views());
  });

  test("picking a shared section joins it instead of making a new one", () => {
    const next = applyDestination(views(), "Triage", "s\x00post-merge\x00In QA");
    expect(next.find((v) => v.id === "post-merge")!.sections!.find((s) => s.label === "In QA")!.states)
      .toEqual(["QA (PROD WEB)", "Triage"]);
  });

  test("Unassigned strips it from every tab", () => {
    const next = applyDestination(views(), "QA Failed", "u");
    expect(next.find((v) => v.id === "urgent")!.sections).toEqual([]);
  });

  test("a section label collides safely with one already in the tab", () => {
    expect(uniqueSectionLabel(views(), "urgent", "QA Failed")).toBe("QA Failed 2");
    expect(uniqueSectionLabel(views(), "urgent", "Triage")).toBe("Triage");
  });
});

describe("parking is a column in the table", () => {
  test("space toggles parking for the status under the cursor", () => {
    const { screen, h } = open();
    selectRow(screen, "QA Failed");
    screen.handleInput(" ");
    expect(h.port.getParkedStates()).toContain("QA Failed");
    screen.handleInput(" ");
    expect(h.port.getParkedStates()).not.toContain("QA Failed");
  });

  test("space works on a status in no tab — the two settings are independent", () => {
    const { screen, h } = open();
    selectRow(screen, "Triage");
    screen.handleInput(" ");
    expect(h.port.getParkedStates()).toContain("Triage");
  });

  test("space on a tab row does nothing — parking is per status", () => {
    const { screen, h } = open();
    selectRow(screen, "Urgent");
    screen.handleInput(" ");
    expect(h.writes).toBe(0);
  });

  test("the cursor stays on the status it just toggled", () => {
    const { screen } = open();
    selectRow(screen, "QA Failed");
    screen.handleInput(" ");
    const grid = screen.render(100, 40);
    expect(text(grid, findRow(grid, "QA Failed"))).toContain("▸");
  });

  test("u adds a tab to the up-next rotation", () => {
    const seen: string[] = [];
    const { screen } = open({ toggleUpNext: (id) => { seen.push(id); } });
    selectRow(screen, "Post-merge");
    screen.handleInput("u");
    expect(seen).toEqual(["post-merge"]);
  });

  test("u on a status does nothing — the rotation is over tabs", () => {
    const seen: string[] = [];
    const { screen } = open({ toggleUpNext: (id) => { seen.push(id); } });
    selectRow(screen, "QA Failed");
    screen.handleInput("u");
    expect(seen).toEqual([]);
  });
});

// --- The screen ---

function text(grid: CellGrid, row: number): string {
  return grid.cells[row]!.map((c) => c.char).join("").replace(/\s+$/, "");
}

function findRow(grid: CellGrid, needle: string): number {
  for (let r = 0; r < grid.rows; r++) if (text(grid, r).includes(needle)) return r;
  return -1;
}

function open(over: Partial<WorkflowPort> = {}, initial = views(),
              parked?: string[]): { screen: WorkflowScreen; h: Harness } {
  const h = harness(over, initial, parked);
  const screen = new WorkflowScreen();
  screen.open(h.port);
  return { screen, h };
}

/** Drive the cursor onto the row whose rendered line contains `needle`. */
function selectRow(screen: WorkflowScreen, needle: string): void {
  for (let i = 0; i < 60; i++) {
    const grid = screen.render(80, 40);
    const at = findRow(grid, needle);
    if (at >= 0 && text(grid, at).trimStart().startsWith("▸")) return;
    screen.handleInput("\x1b[B");
  }
  throw new Error(`never selected a row containing ${JSON.stringify(needle)}`);
}

describe("WorkflowScreen navigation", () => {
  test("opens on the first selectable row, skipping the block heading", () => {
    const { screen } = open();
    const grid = screen.render(100, 40);
    expect(text(grid, findRow(grid, "Urgent"))).toContain("▸");
  });

  test("the cursor skips band headers, which are labels and not targets", () => {
    const rows = buildRows(open().h.port, "global", new Set());
    expect(rows.filter(isSelectable).some((r) => r.kind === "band")).toBe(false);
  });

  test("Escape closes", () => {
    const { screen } = open();
    screen.handleInput("\x1b");
    expect(screen.isOpen).toBe(false);
  });

  test("q closes, matching the settings screen", () => {
    const { screen } = open();
    screen.handleInput("q");
    expect(screen.isOpen).toBe(false);
  });
});

describe("WorkflowScreen rendering", () => {
  test("titles itself and summarises the workspace", () => {
    const grid = open().screen.render(80, 40);
    expect(text(grid, 0)).toContain("Workflow");
    expect(text(grid, 0)).toContain("Linear · 6 statuses · 3 unmapped");
  });

  test("says the tracker is missing rather than showing an empty mapping", () => {
    const grid = open({ getStatuses: () => [], trackerLabel: () => null }).screen.render(80, 40);
    expect(text(grid, 0)).toContain("no issue tracker connected");
  });

  test("a status row is a table row: status, tab, parks, issues", () => {
    const grid = open().screen.render(100, 40);
    const line = text(grid, findRow(grid, "QA (PROD WEB)"));
    expect(line).toContain("QA (PROD WEB)");
    expect(line).toContain("Post-merge");
    expect(line).toContain("⏸");
    expect(line.trimEnd().endsWith("6")).toBe(true);
  });

  test("the table has aligned columns, not dot leaders", () => {
    // Four fields per row: the eye needs a vertical rule to follow, and "does
    // this park?" is a question you answer by scanning down a column.
    const grid = open().screen.render(100, 40);
    const header = text(grid, findRow(grid, "Parks"));
    expect(header).toContain("Stage");
    expect(header).toContain("Parks");
    const tabCol = header.indexOf("Stage");
    expect(text(grid, findRow(grid, "QA Failed")).indexOf("Urgent")).toBe(tabCol);
    expect(text(grid, findRow(grid, "QA (PROD WEB)")).indexOf("Post-merge")).toBe(tabCol);
  });

  test("the parks glyph sits inside its column heading", () => {
    const grid = open().screen.render(100, 40);
    const header = text(grid, findRow(grid, "Parks"));
    const at = header.indexOf("Parks");
    const glyph = text(grid, findRow(grid, "QA (PROD WEB)")).indexOf("⏸");
    expect(glyph).toBeGreaterThanOrEqual(at);
    expect(glyph).toBeLessThan(at + 5);
  });

  test("a status in no tab shows an em dash rather than an empty cell", () => {
    const grid = open().screen.render(100, 40);
    expect(text(grid, findRow(grid, "Triage"))).toContain("—");
  });

  test("the Heading column exists only when the config actually groups something", () => {
    const plain = open().screen.render(100, 40);
    expect(text(plain, findRow(plain, "Parks"))).not.toContain("Heading");

    const shared = parseViews([{
      id: "t", label: "T", source: "issues", filter: { scope: "assigned" },
      groupBy: "none", subGroupBy: "none", sortBy: "priority", sortOrder: "asc",
      sections: [{ label: "Blocked", states: ["QA Failed", "Triage"] }, { label: "Solo", states: ["Done"] }],
    }]);
    const grid = open({}, shared).screen.render(100, 40);
    expect(text(grid, findRow(grid, "Parks"))).toContain("Heading");
    expect(text(grid, findRow(grid, "QA Failed"))).toContain("Blocked");
    // A heading over one status is just that status — nothing to show.
    expect(text(grid, findRow(grid, "Done"))).not.toContain("Solo");
  });

  test("the explain line describes the selected row", () => {
    const { screen } = open();
    selectRow(screen, "QA (PROD WEB)");
    expect(text(screen.render(100, 40), 38).trim())
      .toBe("QA (PROD WEB) · 6 issues · Post-merge · parks its sessions (3 now)");
  });

  test("the explain line runs past the row measure rather than being clipped by it", () => {
    // Rows are capped at a measure so the dot leaders stay readable; the
    // explanation is prose and gets the whole content width. A clipped
    // explanation defeats the one thing this line exists for.
    const long = "Waiting On Somebody Else Entirely (PRE-RELEASE WEB)";
    const wide = parseViews([{
      id: "t", label: "Handed off", source: "issues", filter: { scope: "assigned" },
      groupBy: "none", subGroupBy: "none", sortBy: "priority", sortOrder: "asc",
      parks: true, sections: [{ label: long, states: [long] }],
    }]);
    const { screen } = open({ getStatuses: () => [{ name: long, type: "started" }] }, wide);
    // Search on a prefix: the label column truncates long names, which is
    // exactly why the explanation must not be truncated too.
    selectRow(screen, "Waiting On Somebody");
    expect(text(screen.render(120, 40), 38).trim().length).toBeGreaterThan(78);
  });

  test("the hint line offers the keys that apply to the selected row", () => {
    const { screen } = open();
    selectRow(screen, "QA Failed");
    expect(text(screen.render(100, 40), 39)).toContain("park");
  });
});

describe("WorkflowScreen editing", () => {
  test("Enter on a status asks which stage it is, and the pick assigns it", () => {
    const { screen, h } = open();
    selectRow(screen, "Triage");
    screen.handleInput("\r");
    expect(text(screen.render(80, 40), 0)).toContain('Which stage is "Triage"?');

    screen.handleInput("\r"); // first destination: Urgent
    expect(h.current().find((v) => v.id === "urgent")!.sections!.map((s) => s.label))
      .toEqual(["QA Failed", "Triage"]);
  });

  test("the destination picker filters as you type", () => {
    const { screen, h } = open();
    selectRow(screen, "Triage");
    screen.handleInput("\r");
    for (const ch of "post") screen.handleInput(ch);
    screen.handleInput("\r");
    expect(h.current().find((v) => v.id === "post-merge")!.sections!.map((s) => s.label))
      .toEqual(["Dev Confirm", "In QA", "Triage"]);
  });

  test("Escape in a picker changes nothing", () => {
    const { screen, h } = open();
    selectRow(screen, "Triage");
    screen.handleInput("\r");
    screen.handleInput("\x1b");
    expect(h.writes).toBe(0);
    expect(screen.isOpen).toBe(true);
  });

  test("d unassigns a status and takes its now-empty section with it", () => {
    const { screen, h } = open();
    selectRow(screen, "QA Failed");
    screen.handleInput("d");
    expect(h.current().find((v) => v.id === "urgent")!.sections).toEqual([]);
  });

  test("d on a status in a shared header leaves the header for the others", () => {
    const shared = parseViews([{
      id: "t", label: "T", source: "issues", filter: { scope: "assigned" },
      groupBy: "none", subGroupBy: "none", sortBy: "priority", sortOrder: "asc",
      sections: [{ label: "Blocked", states: ["QA Failed", "Triage"] }],
    }]);
    const { screen, h } = open({}, shared);
    selectRow(screen, "QA Failed");
    screen.handleInput("d");
    expect(h.current()[0]!.sections).toEqual([{ label: "Blocked", states: ["Triage"] }]);
  });

  test("r on a status renames the heading it appears under", () => {
    const { screen, h } = open();
    selectRow(screen, "QA Failed");
    screen.handleInput("r");
    expect(text(screen.render(80, 40), 0)).toContain("Heading this status appears under");
    screen.handleInput("\x15"); // clear
    for (const ch of "Blocked") screen.handleInput(ch);
    screen.handleInput("\r");
    expect(h.current().find((v) => v.id === "urgent")!.sections![0]!.label).toBe("Blocked");
  });

  test("renaming a header onto an existing one merges the two into one section", () => {
    // This is the whole multi-status-section feature, expressed as a rename.
    const { screen, h } = open();
    selectRow(screen, "Dev Confirm");
    screen.handleInput("r");
    screen.handleInput("\x15");
    for (const ch of "In QA") screen.handleInput(ch);
    screen.handleInput("\r");
    expect(h.current().find((v) => v.id === "post-merge")!.sections)
      .toEqual([{ label: "In QA", states: ["QA (PROD WEB)", "Dev Confirm"] }]);
  });
});

describe("WorkflowScreen stages", () => {
  test("Enter folds a tab away and back", () => {
    const { screen } = open();
    selectRow(screen, "Post-merge");
    screen.handleInput("\r");
    expect(findRow(screen.render(80, 40), "Dev Confirm")).toBe(-1);
    screen.handleInput("\r");
    expect(findRow(screen.render(80, 40), "Dev Confirm")).toBeGreaterThan(0);
  });

  test("+ New stage prompts for a name and creates it", () => {
    const { screen, h } = open();
    selectRow(screen, "+ New stage");
    screen.handleInput("\r");
    expect(text(screen.render(80, 40), 0)).toContain("Name this stage");
    for (const ch of "Waiting") screen.handleInput(ch);
    screen.handleInput("\r");
    expect(h.current().map((v) => v.label)).toContain("Waiting");
  });

  test("deleting a tab asks first, and n backs out", () => {
    const { screen, h } = open();
    selectRow(screen, "Urgent");
    screen.handleInput("d");
    expect(text(screen.render(80, 40), 39)).toContain("Delete the \"Urgent\" stage");
    screen.handleInput("n");
    expect(h.writes).toBe(0);
    expect(h.current().some((v) => v.id === "urgent")).toBe(true);
  });

  test("confirming the delete removes the tab", () => {
    const { screen, h } = open();
    selectRow(screen, "Urgent");
    screen.handleInput("d");
    screen.handleInput("y");
    expect(h.current().some((v) => v.id === "urgent")).toBe(false);
  });

  test("Shift-Down moves a tab, and the cursor follows it", () => {
    const { screen, h } = open();
    selectRow(screen, "Urgent");
    screen.handleInput("\x1b[1;2B");
    expect(h.current().map((v) => v.id)).toEqual(["post-merge", "urgent", "my-mrs"]);
    const grid = screen.render(80, 40);
    expect(text(grid, findRow(grid, "Urgent"))).toContain("▸");
  });

  test("Shift-Up reorders a status within its tab", () => {
    const { screen, h } = open();
    selectRow(screen, "QA (PROD WEB)");
    screen.handleInput("\x1b[1;2A");
    expect(h.current().find((v) => v.id === "post-merge")!.sections!.map((s) => s.label))
      .toEqual(["In QA", "Dev Confirm"]);
  });

  test("an MR tab cannot be renamed, deleted or expanded from here", () => {
    const { screen, h } = open();
    selectRow(screen, "My MRs");
    screen.handleInput("\r");
    screen.handleInput("r");
    screen.handleInput("d");
    expect(h.writes).toBe(0);
    expect(screen.isOpen).toBe(true);
  });
});

describe("WorkflowScreen seeding", () => {
  test("Enter on the seed row lays out tabs from the tracker's own categories", () => {
    const bare = parseViews([{
      id: "a", label: "A", source: "issues", filter: { scope: "assigned" },
      groupBy: "none", subGroupBy: "none", sortBy: "priority", sortOrder: "asc",
    }]);
    const { screen, h } = open({}, bare);
    selectRow(screen, "Suggest a starting layout");
    screen.handleInput("\r");
    expect(h.current().map((v) => v.label)).toEqual(["A", "To do", "In progress", "Done"]);
  });
});

describe("WorkflowScreen behaviour bands", () => {
  const band = (over: Partial<SettingDef> = {}): WorkflowBand => ({
    label: "Parking",
    settings: [{
      id: "idle", label: "Park idle sessions after", type: "text",
      getValue: () => "off", onTextCommit: () => {}, ...over,
    }],
  });

  test("a text setting edits through the screen's own prompt", () => {
    const out: { value: string | null } = { value: null };
    const { screen } = open({
      getBands: () => [band({ onTextCommit: (v) => { out.value = v; } })],
    });
    selectRow(screen, "Park idle sessions after");
    screen.handleInput("\r");
    screen.handleInput("\x15");
    screen.handleInput("2");
    screen.handleInput("\r");
    expect(out.value).toBe("2");
  });

  test("a list setting is a filterable picker, not a 25-step cycle", () => {
    const out: { value: string | null } = { value: null };
    const { screen } = open({
      getBands: () => [{
        label: "Writes to your tracker",
        settings: [{
          id: "start", label: "When a session starts", type: "list",
          getValue: () => "—", options: ["Never", "In Progress", "In Review"],
          onOptionSelect: (v) => { out.value = v; },
        }],
      }],
    });
    selectRow(screen, "When a session starts");
    screen.handleInput("\r");
    for (const ch of "Review") screen.handleInput(ch);
    screen.handleInput("\r");
    expect(out.value).toBe("In Review");
  });

  test("a multiselect stays open across toggles and shows what is ticked", () => {
    const chosen = new Set(["parked"]);
    const { screen } = open({
      getBands: () => [{
        label: "Parking",
        settings: [{
          id: "park", label: "Park sections that mean", type: "multiselect",
          getValue: () => "Parked",
          getOptions: () => [{ id: "active", label: "Active" }, { id: "parked", label: "Parked" }],
          getSelected: () => [...chosen],
          onToggleOption: (id) => { chosen.has(id) ? chosen.delete(id) : chosen.add(id); },
        }],
      }],
    });
    selectRow(screen, "Park sections that mean");
    screen.handleInput("\r");
    expect(text(screen.render(80, 40), 3)).toContain("[ ] Active");
    expect(text(screen.render(80, 40), 4)).toContain("[x] Parked");
    screen.handleInput("\r"); // toggle Active, picker stays open
    expect(chosen.has("active")).toBe(true);
    expect(text(screen.render(80, 40), 3)).toContain("[x] Active");
  });

  test("d clears a per-repo override back to the inherited value", () => {
    const out = { cleared: false };
    const { screen } = open({
      repoLabel: () => "jmux",
      getBands: () => [band({
        getScope: () => "override", onClearOverride: () => { out.cleared = true; },
      })],
    });
    selectRow(screen, "Park idle sessions after");
    screen.handleInput("d");
    expect(out.cleared).toBe(true);
  });

  test("g switches which tier the bands are showing", () => {
    const seen: string[] = [];
    const { screen } = open({
      repoLabel: () => "jmux",
      getBands: (tier) => { seen.push(tier); return []; },
    });
    screen.render(80, 40);
    expect(seen.at(-1)).toBe("repo");
    screen.handleInput("g");
    screen.render(80, 40);
    expect(seen.at(-1)).toBe("global");
  });

  test("with no repo-backed session there is no tier to switch to", () => {
    const seen: string[] = [];
    const { screen } = open({ getBands: (tier) => { seen.push(tier); return []; } });
    screen.handleInput("g");
    screen.render(80, 40);
    expect(seen.at(-1)).toBe("global");
  });
});

describe("WorkflowScreen — regressions found by running it", () => {
  test("seeding appends to the tab list instead of replacing it", () => {
    // The suggestion has to build on what is there: the tab list also holds
    // the user's MR tabs, and replacing it silently deleted them.
    const bare = parseViews([
      { id: "a", label: "Issues", source: "issues", filter: { scope: "assigned" },
        groupBy: "team", subGroupBy: "status", sortBy: "priority", sortOrder: "asc" },
      { id: "my-mrs", label: "My MRs", source: "mrs", filter: { scope: "authored" },
        groupBy: "none", subGroupBy: "none", sortBy: "updated", sortOrder: "desc" },
    ]);
    const { screen, h } = open({}, bare);
    selectRow(screen, "Suggest a starting layout");
    screen.handleInput("\r");
    expect(h.current().map((v) => v.label))
      .toEqual(["Issues", "My MRs", "To do", "In progress", "Done"]);
  });

  test("the header stops reporting unmapped statuses once every one is mapped", () => {
    // An empty band header with nothing under it reads as a rendering fault.
    const { screen, h } = open();
    for (const state of ["Triage", "Backlog", "Done"]) {
      h.port.setViews(applyDestination(h.current(), state, "v\x00urgent"));
    }
    const grid = screen.render(100, 40);
    // Every status now names a tab, so the em dash placeholder is gone.
    expect(text(grid, findRow(grid, "Triage"))).toContain("Urgent");
    expect(text(grid, 0)).toContain("0 unmapped");
  });

  test("the last band survives an unconnected tracker, to explain the emptiness", () => {
    const { screen } = open({ getStatuses: () => [], trackerLabel: () => null });
    const grid = screen.render(80, 40);
    expect(findRow(grid, "Statuses")).toBeGreaterThan(0);
  });

  test("counts read as English at one", () => {
    const one = parseViews([{
      id: "t", label: "Solo", source: "issues", filter: { scope: "assigned" },
      groupBy: "none", subGroupBy: "none", sortBy: "priority", sortOrder: "asc",
      sections: [{ label: "Triage", states: ["Triage"] }],
    }]);
    const { screen } = open({}, one);
    selectRow(screen, "Solo");
    expect(text(screen.render(100, 40), 38)).toContain("1 status · 2 issues");
    expect(text(screen.render(100, 40), 38)).not.toContain("1 issues");
  });
});

describe("WorkflowScreen — moving a status keeps its meaning and the cursor", () => {
  test("a move carries the meaning the user set for that status", () => {
    // Stage lives on the section, but the *decision* is about the status.
    // Dropping it on a move silently switches parking off for it.
    const next = applyDestination(views(), "QA (PROD WEB)", "v\x00urgent");
    expect(next.find((v) => v.id === "urgent")!.sections!.find((s) => s.label === "QA (PROD WEB)"))
      .toEqual({ label: "QA (PROD WEB)", states: ["QA (PROD WEB)"] });
  });

  test("a status with no meaning set stays that way rather than inventing one", () => {
    const noStage = parseViews([{
      id: "t", label: "T", source: "issues", filter: { scope: "assigned" },
      groupBy: "none", subGroupBy: "none", sortBy: "priority", sortOrder: "asc",
      sections: [{ label: "Triage", states: ["Triage"] }],
    }]);
    const moved = applyDestination([...noStage, ...views()], "Triage", "v\x00urgent");
    expect("stage" in moved.find((v) => v.id === "urgent")!.sections!.find((s) => s.label === "Triage")!)
      .toBe(false);
  });

  test("joining a shared section takes that section's meaning, not the old one", () => {
    const next = applyDestination(views(), "QA Failed", "s\x00post-merge\x00In QA");
    const section = next.find((v) => v.id === "post-merge")!.sections!.find((s) => s.label === "In QA")!;
    expect(section).toEqual({ label: "In QA", states: ["QA (PROD WEB)", "QA Failed"] });
  });

  test("the cursor follows a status to its new tab", () => {
    const { screen } = open();
    selectRow(screen, "Triage");
    screen.handleInput("\r");
    screen.handleInput("\r"); // first destination: Urgent
    const grid = screen.render(100, 40);
    expect(text(grid, findRow(grid, "Triage"))).toContain("▸");
    expect(text(grid, 38)).toContain("Urgent");
  });

  test("the cursor follows a status out of its stage when it is dropped", () => {
    const { screen } = open();
    selectRow(screen, "QA Failed");
    screen.handleInput("d");
    const grid = screen.render(80, 40);
    expect(text(grid, findRow(grid, "QA Failed"))).toContain("▸");
    expect(text(grid, 38)).toContain("in none of your stages");
  });
});

describe("WorkflowScreen hints", () => {
  test("an unassigned status is only offered the key that applies to it", () => {
    // It has no section, so meaning / header / order / unassign have nothing
    // to act on — advertising them is a hint that lies.
    const { screen } = open();
    selectRow(screen, "Triage");
    const hint = text(screen.render(100, 40), 39);
    expect(hint).toContain("stage");
    expect(hint).toContain("parks");
    expect(hint).not.toContain("heading");
    expect(hint).not.toContain("remove");
  });

  test("an assigned status is offered the full set", () => {
    const { screen } = open();
    selectRow(screen, "QA Failed");
    const hint = text(screen.render(100, 40), 39);
    expect(hint).toContain("parks");
    expect(hint).toContain("heading");
    expect(hint).toContain("remove");
  });
});
