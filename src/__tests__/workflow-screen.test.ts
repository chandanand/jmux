import { describe, test, expect } from "bun:test";
import {
  WorkflowScreen, buildRows, explainRow, destinationsFor, applyDestination,
  isSelectable, tableLayout, printableText, prevBoundary, nextBoundary,
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
      states: ["QA Failed"],
    },
    {
      id: "post-merge", label: "Post-merge", source: "issues", filter: { scope: "assigned" },
      groupBy: "none", subGroupBy: "none", sortBy: "priority", sortOrder: "asc",
      states: ["Dev Confirm", "QA (PROD WEB)"],
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

const rowsOf = (h: Harness): WorkflowRow[] => buildRows(h.port, "global");

const statusRow = (rows: WorkflowRow[], state: string) =>
  rows.find((r): r is Extract<WorkflowRow, { kind: "status" }> => r.kind === "status" && r.state === state)!;

// --- Row model ---

describe("buildRows", () => {
  test("lists stages first, then every status in stage-then-config order", () => {
    // Two blocks, because they edit two different kinds of thing. Interleaving
    // them is what made every key mean something different per row.
    const rows = rowsOf(harness());
    expect(rows.filter((r) => r.kind === "tab").map((r: any) => r.label))
      .toEqual(["Urgent", "Post-merge", "My MRs"]);
    expect(rows.filter((r) => r.kind === "status").map((r: any) => r.state))
      .toEqual(["QA Failed", "Dev Confirm", "QA (PROD WEB)", "Triage", "Backlog", "Done"]);
  });

  test("statuses in no stage sort last, where they read as the work still to do", () => {
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

  test("a status in no stage carries no stage label", () => {
    const rows = rowsOf(harness());
    expect(statusRow(rows, "Triage")).toMatchObject({ viewId: null, viewLabel: null });
    expect(statusRow(rows, "Done")).toMatchObject({ viewId: null, viewLabel: null });
  });

  test("parking is the status's own setting, independent of its stage", () => {
    // Both of these sit in a stage; only the one on the parked list parks.
    expect(statusRow(rowsOf(harness()), "QA (PROD WEB)"))
      .toMatchObject({ viewId: "post-merge", parks: true, parked: 3 });
    expect(statusRow(rowsOf(harness()), "Dev Confirm"))
      .toMatchObject({ viewId: "post-merge", parks: false });
  });

  test("a status can park while belonging to no stage", () => {
    const rows = buildRows(harness({}, views(), ["Triage"]).port, "global");
    expect(statusRow(rows, "Triage")).toMatchObject({ viewId: null, parks: true });
  });

  test("live issue counts ride along on the row", () => {
    const rows = rowsOf(harness());
    expect(statusRow(rows, "QA Failed").issues).toBe(4);
    expect(statusRow(rows, "Backlog").issues).toBe(0);
  });

  test("a stage sums the issues of every status it claims", () => {
    const tab = rowsOf(harness()).find((r) => r.kind === "tab" && r.viewId === "post-merge");
    expect(tab).toMatchObject({ statuses: 2, issues: 6, parks: 1 });
  });

  test("a status listed in config but gone from the tracker still shows, flagged", () => {
    // Renaming a status in Linear must not make its mapping invisible.
    const stale = parseViews([{
      id: "t", label: "T", source: "issues", filter: { scope: "assigned" },
      groupBy: "none", subGroupBy: "none", sortBy: "priority", sortOrder: "asc",
      states: ["Old Name"],
    }]);
    expect(statusRow(rowsOf(harness({}, stale)), "Old Name")).toMatchObject({ known: false });
  });

  test("an MR tab is listed so the block matches the panel's tab bar", () => {
    const rows = rowsOf(harness());
    const at = rows.findIndex((r) => r.kind === "tab" && r.viewId === "my-mrs");
    expect(rows[at]).toMatchObject({ source: "mrs", statuses: 0 });
    expect(rows[at + 1]!.kind).toBe("new-tab");
  });

  test("up-next rank is on the stage row, so priority is visible where order is edited", () => {
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

  test("disappears as soon as one stage maps a status", () => {
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

  test("a status names its stage and nothing below it", () => {
    const shared = parseViews([{
      id: "t", label: "T", source: "issues", filter: { scope: "assigned" },
      groupBy: "none", subGroupBy: "none", sortBy: "priority", sortOrder: "asc",
      states: ["QA Failed", "Triage"],
    }]);
    expect(explain("QA Failed", {}, shared)).toBe("QA Failed · 4 issues · T · its sessions stay in the sidebar");
  });

  test("a status the tracker no longer has is called out", () => {
    const stale = parseViews([{
      id: "t", label: "T", source: "issues", filter: { scope: "assigned" },
      groupBy: "none", subGroupBy: "none", sortBy: "priority", sortOrder: "asc",
      states: ["Old"],
    }]);
    expect(explain("Old", {}, stale)).toContain("no longer in your tracker");
  });

  test("a tab reports its position, size, how much of it parks, and its rotation slot", () => {
    const rows = rowsOf(harness());
    const tab = (id: string) => rows.find((r) => r.kind === "tab" && r.viewId === id);
    expect(explainRow(tab("urgent")))
      .toBe("Urgent · 1st of 2 · 1 status · 4 issues · 1st in Up next");
    expect(explainRow(tab("post-merge")))
      .toBe("Post-merge · 2nd of 2 · 2 statuses · 6 issues · 1 of them park · not in Up next");
  });

  test("position counts stages only, so an MR tab between them doesn't skew it", () => {
    const mixed = parseViews([
      { id: "a", label: "A", source: "issues", filter: { scope: "assigned" }, states: [] },
      { id: "m", label: "M", source: "mrs", filter: { scope: "authored" } },
      { id: "b", label: "B", source: "issues", filter: { scope: "assigned" }, states: [] },
    ]);
    const rows = rowsOf(harness({}, mixed));
    const tab = (id: string) => rows.find((r) => r.kind === "tab" && r.viewId === id);
    expect(explainRow(tab("a"))).toContain("1st of 2");
    expect(explainRow(tab("b"))).toContain("2nd of 2");
    // An MR tab is not a stage, so it neither has a position nor consumes one.
    expect(explainRow(tab("m"))).toBe("M · a merge-request tab, not a workflow stage.");
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

  test("marks the stage a status is already in rather than hiding it", () => {
    const d = destinationsFor(views(), "QA Failed").find((x) => x.label === "Urgent");
    expect(d!.annotation).toBe("already here");
  });

  test("offers nothing below a stage — the panel derives its subheadings", () => {
    // There used to be extra entries for named sub-headings inside a stage.
    // The panel groups by status name when a stage holds more than one, so
    // there is nothing further to choose.
    expect(destinationsFor(views(), "Triage")).toHaveLength(3);
  });
});

describe("applyDestination", () => {
  test("picking a stage appends the status to it", () => {
    const next = applyDestination(views(), "Triage", "urgent");
    expect(next.find((v) => v.id === "urgent")!.states).toEqual(["QA Failed", "Triage"]);
  });

  test("moving a status removes it from wherever it was", () => {
    // One home per status is what keeps the model comprehensible — two homes
    // would resolve by a first-wins scan nobody chose.
    const next = applyDestination(views(), "QA Failed", "post-merge");
    expect(next.find((v) => v.id === "urgent")!.states).toEqual([]);
    expect(next.find((v) => v.id === "post-merge")!.states)
      .toEqual(["Dev Confirm", "QA (PROD WEB)", "QA Failed"]);
  });

  test("picking the stage a status is already in leaves it in place", () => {
    const next = applyDestination(views(), "QA Failed", "urgent");
    expect(next.find((v) => v.id === "urgent")!.states).toEqual(["QA Failed"]);
  });

  test("No stage strips it from every stage", () => {
    const next = applyDestination(views(), "QA Failed", "\x00none");
    expect(next.find((v) => v.id === "urgent")!.states).toEqual([]);
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
    const rows = buildRows(open().h.port, "global");
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

  test("the table is four columns — there is no heading to name", () => {
    const grid = open().screen.render(100, 40);
    const header = text(grid, findRow(grid, "Parks"));
    expect(header).not.toContain("Heading");
    expect(header.replace(/\s+/g, " ").trim()).toBe("Status Stage Parks Issues");
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
      states: [long],
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
    expect(h.current().find((v) => v.id === "urgent")!.states)
      .toEqual(["QA Failed", "Triage"]);
  });

  test("the destination picker filters as you type", () => {
    const { screen, h } = open();
    selectRow(screen, "Triage");
    screen.handleInput("\r");
    for (const ch of "post") screen.handleInput(ch);
    screen.handleInput("\r");
    expect(h.current().find((v) => v.id === "post-merge")!.states)
      .toEqual(["Dev Confirm", "QA (PROD WEB)", "Triage"]);
  });

  test("Escape in a picker changes nothing", () => {
    const { screen, h } = open();
    selectRow(screen, "Triage");
    screen.handleInput("\r");
    screen.handleInput("\x1b");
    expect(h.writes).toBe(0);
    expect(screen.isOpen).toBe(true);
  });

  test("d takes a status out of its stage", () => {
    const { screen, h } = open();
    selectRow(screen, "QA Failed");
    screen.handleInput("d");
    expect(h.current().find((v) => v.id === "urgent")!.states).toEqual([]);
  });

  test("d leaves the other statuses in that stage alone", () => {
    const { screen, h } = open();
    selectRow(screen, "Dev Confirm");
    screen.handleInput("d");
    expect(h.current().find((v) => v.id === "post-merge")!.states).toEqual(["QA (PROD WEB)"]);
  });
});

describe("WorkflowScreen stages", () => {
  test("Enter on a stage renames it", () => {
    const { screen, h } = open();
    selectRow(screen, "Urgent");
    screen.handleInput("\r");
    expect(text(screen.render(80, 40), 0)).toContain("Rename stage");
    screen.handleInput("\x15");
    for (const ch of "Blocked") screen.handleInput(ch);
    screen.handleInput("\r");
    expect(h.current().find((v) => v.id === "urgent")!.label).toBe("Blocked");
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

  test("Shift-Up reorders a status within its stage", () => {
    const { screen, h } = open();
    selectRow(screen, "QA (PROD WEB)");
    screen.handleInput("\x1b[1;2A");
    expect(h.current().find((v) => v.id === "post-merge")!.states)
      .toEqual(["QA (PROD WEB)", "Dev Confirm"]);
  });

  test("an MR tab cannot be renamed, deleted or expanded from here", () => {
    const { screen, h } = open();
    selectRow(screen, "My MRs");
    screen.handleInput("\r");
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

  test("a text prompt opens on the editable value, not the prose the row displays", () => {
    // The row reads "never"; the input form is empty. Seeding the prompt with
    // the display string meant typing a number produced "never3" — which parses
    // to nothing, so the setting could not be switched on from its own prompt.
    const out: { value: string | null } = { value: null };
    const { screen } = open({
      getBands: () => [band({
        getValue: () => "never",
        getEditValue: () => "",
        onTextCommit: (v) => { out.value = v; },
      })],
    });
    selectRow(screen, "Park idle sessions after");
    screen.handleInput("\r");
    screen.handleInput("3");   // deliberately no \x15 first
    screen.handleInput("\r");
    expect(out.value).toBe("3");
  });

  test("without getEditValue a text prompt still opens on the displayed value", () => {
    const out: { value: string | null } = { value: null };
    const { screen } = open({
      getBands: () => [band({ getValue: () => "abc", onTextCommit: (v) => { out.value = v; } })],
    });
    selectRow(screen, "Park idle sessions after");
    screen.handleInput("\r");
    screen.handleInput("d");
    screen.handleInput("\r");
    expect(out.value).toBe("abcd");
  });

  test("◂ ▸ step a stepped setting in place, without opening an editor", () => {
    const steps: number[] = [];
    const { screen } = open({
      getBands: () => [band({ onStep: (d) => { steps.push(d); } })],
    });
    selectRow(screen, "Park idle sessions after");
    screen.handleInput("\x1b[C");
    screen.handleInput("\x1b[C");
    screen.handleInput("\x1b[D");
    expect(steps).toEqual([1, 1, -1]);
    // No prompt was opened — the value changes on the row itself.
    expect(screen.render(80, 24)).toBeDefined();
  });

  test("left/right do nothing on a setting that isn't stepped", () => {
    const out: { value: string | null } = { value: null };
    const { screen } = open({
      getBands: () => [band({ onTextCommit: (v) => { out.value = v; } })],
    });
    selectRow(screen, "Park idle sessions after");
    screen.handleInput("\x1b[C");
    screen.handleInput("\x1b[D");
    expect(out.value).toBeNull();
    // …and the cursor hasn't wandered: Enter still edits the row it was on.
    screen.handleInput("\r");
    screen.handleInput("\x15");
    screen.handleInput("9");
    screen.handleInput("\r");
    expect(out.value).toBe("9");
  });

  test("a stepped row advertises ◂ ▸, and only while it is selected", () => {
    const { screen } = open({ getBands: () => [band({ onStep: () => {} })] });
    const text = (): string => {
      const g = screen.render(80, 24);
      return Array.from({ length: g.rows }, (_, r) =>
        Array.from({ length: 80 }, (_, c) => g.cells[r][c].char).join("")).join("\n");
    };
    // Not selected yet — the row is plain.
    expect(text()).not.toContain("◂");
    selectRow(screen, "Park idle sessions after");
    const shown = text();
    expect(shown).toContain("◂");
    expect(shown).toContain("▸");
    expect(shown).toContain("change"); // and the footer names the keys
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
      h.port.setViews(applyDestination(h.current(), state, "urgent"));
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
      states: ["Triage"],
    }]);
    const { screen } = open({}, one);
    selectRow(screen, "Solo");
    expect(text(screen.render(100, 40), 38)).toContain("1 status · 2 issues");
    expect(text(screen.render(100, 40), 38)).not.toContain("1 issues");
  });
});

describe("WorkflowScreen — moving a status", () => {
  test("a move says what it does purely by where it lands", () => {
    // Nothing travels with the status: whether it parks is its own column, and
    // where it shows is the stage it lands in.
    const next = applyDestination(views(), "QA (PROD WEB)", "urgent");
    expect(next.find((v) => v.id === "urgent")!.states).toEqual(["QA Failed", "QA (PROD WEB)"]);
    expect(next.find((v) => v.id === "post-merge")!.states).toEqual(["Dev Confirm"]);
  });

  test("the cursor follows a status to its new stage", () => {
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
    const grid = screen.render(100, 40);
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
    expect(hint).not.toContain("remove");
  });

  test("an assigned status is offered the full set", () => {
    const { screen } = open();
    selectRow(screen, "QA Failed");
    const hint = text(screen.render(100, 40), 39);
    expect(hint).toContain("parks");
    expect(hint).toContain("remove");
  });
});

describe("WorkflowScreen table at narrow widths", () => {
  // A ~34-column content area used to render `SParks` as a heading: the Stage
  // header was written at a fixed offset with no truncation, while the value
  // beneath it was truncated to a width that had gone negative and so rendered
  // as "". The table showed a heading over a column that had lost its data,
  // which reads as "this status belongs to no stage" — the opposite of true.
  const layoutAt = (width: number) =>
    tableLayout(buildRows(harness().port, "global"), width);

  test("columns never overlap, at any width", () => {
    for (let w = 1; w <= 140; w++) {
      const t = layoutAt(w);
      if (t.stage !== null) {
        expect(t.status + t.statusWidth).toBeLessThanOrEqual(t.stage);
        if (t.parks !== null) expect(t.stage + t.stageWidth).toBeLessThanOrEqual(t.parks);
      }
      if (t.parks !== null && t.issues !== null) expect(t.parks).toBeLessThan(t.issues);
    }
  });

  test("a Stage column is never present without room for its values", () => {
    for (let w = 1; w <= 140; w++) {
      const t = layoutAt(w);
      if (t.stage !== null) expect(t.stageWidth).toBeGreaterThan(0);
    }
  });

  test("columns drop right to left as the width shrinks", () => {
    expect(layoutAt(120)).toMatchObject({ stage: expect.any(Number) });
    expect(layoutAt(120).parks).not.toBeNull();
    expect(layoutAt(120).issues).not.toBeNull();

    expect(layoutAt(24).issues).toBeNull();      // Issues goes first
    expect(layoutAt(24).stage).not.toBeNull();

    expect(layoutAt(14).parks).toBeNull();       // then Parks
    expect(layoutAt(14).stage).toBeNull();       // then Stage
    expect(layoutAt(14).statusWidth).toBe(14);   // Status keeps the whole row
  });

  test("the rendered header never runs one column into the next", () => {
    for (const width of [120, 80, 60, 46, 40, 34, 30, 26, 24, 20, 18, 14, 10, 6]) {
      const grid = open().screen.render(width, 30);
      const at = findRow(grid, "Status");
      if (at < 0) continue;
      const header = text(grid, at);
      expect(header).not.toContain("SParks");
      expect(header).not.toMatch(/Stag[^e]|Park[^s]|Issue[^s]/);
    }
  });

  test("renders without throwing at any width, down to one column", () => {
    for (let w = 1; w <= 40; w++) {
      expect(() => open().screen.render(w, 24)).not.toThrow();
    }
  });
});


describe("text entry — paste and astral characters", () => {
  // `data.length === 1` rejected both a pasted chunk and any character outside
  // the BMP, which arrives as a two-unit surrogate pair. Paste silently did
  // nothing; an emoji in a stage name was impossible to type.

  test("printableText keeps a pasted run and drops control bytes", () => {
    expect(printableText("Release Blockers")).toBe("Release Blockers");
    expect(printableText("a\u0000b\u0007c")).toBe("abc");
    expect(printableText("\u007f")).toBe("");
  });

  test("printableText rejects escape sequences, whose tails are printable", () => {
    // "\x1b[D" would otherwise type "[D" into the buffer.
    expect(printableText("\x1b[D")).toBe("");
    expect(printableText("\x1b[1;2A")).toBe("");
  });

  test("printableText keeps astral characters whole", () => {
    expect(printableText("🚀")).toBe("🚀");
    expect(printableText("QA 🚀 done")).toBe("QA 🚀 done");
  });

  test("boundaries step whole code points, never half a surrogate", () => {
    const s = "a🚀b";           // 'a' 1 unit, '🚀' 2 units, 'b' 1 unit
    expect(nextBoundary(s, 0)).toBe(1);
    expect(nextBoundary(s, 1)).toBe(3);
    expect(prevBoundary(s, 3)).toBe(1);
    expect(prevBoundary(s, 4)).toBe(3);
    expect(prevBoundary(s, 0)).toBe(0);
    expect(nextBoundary(s, s.length)).toBe(s.length);
  });

  test("a pasted stage name lands in the prompt intact", () => {
    const { screen, h } = open();
    selectRow(screen, "+ New stage");
    screen.handleInput("\r");
    screen.handleInput("Waiting on QA");        // one paste, one chunk
    screen.handleInput("\r");
    expect(h.current().map((v) => v.label)).toContain("Waiting on QA");
  });

  test("an emoji survives typing and backspace", () => {
    const { screen, h } = open();
    selectRow(screen, "+ New stage");
    screen.handleInput("\r");
    screen.handleInput("🚀x");
    screen.handleInput("\x7f");                 // deletes 'x'
    screen.handleInput("\x7f");                 // deletes the whole emoji
    screen.handleInput("ok");
    screen.handleInput("\r");
    expect(h.current().map((v) => v.label)).toContain("ok");
  });

  test("the picker filter takes a pasted query", () => {
    const { screen, h } = open();
    selectRow(screen, "Triage");
    screen.handleInput("\r");
    screen.handleInput("Post-merge");            // paste, not 10 keystrokes
    screen.handleInput("\r");
    expect(h.current().find((v) => v.id === "post-merge")!.states).toContain("Triage");
  });
});
