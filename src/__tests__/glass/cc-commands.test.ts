import { describe, test, expect } from "bun:test";
import { buildCcCommands, type CcCommandInput } from "../../glass/cc-commands";
import type { CommandCenterView } from "../../glass/views";

const views: CommandCenterView[] = [
  { id: "active", name: "Active", filter: "active", groupBy: "status", sortBy: "status" },
  { id: "backend", name: "Backend", filter: "all", groupBy: "project", sortBy: "name" },
];

const base: CcCommandInput = {
  inGlass: false,
  views,
  activeViewId: "active",
  dirty: false,
  hiddenSessions: [],
  targetPaneId: null,
  targetPinned: false,
};

const ids = (cmds: { id: string }[]) => cmds.map((c) => c.id);

describe("buildCcCommands — pin/unpin", () => {
  test("offers pin when the target pane isn't pinned, with the new meaning in the label", () => {
    const cmds = buildCcCommands({ ...base, targetPaneId: "%5", targetPinned: false });
    const pin = cmds.find((c) => c.id === "pin-pane")!;
    expect(pin).toBeTruthy();
    expect(pin.label).toMatch(/keep this session on the grid/i);
    expect(pin.sublist).toBeUndefined();
    expect(ids(cmds)).not.toContain("unpin-pane");
  });

  test("offers unpin when the target pane already carries a force-on pin", () => {
    const cmds = buildCcCommands({ ...base, targetPaneId: "%5", targetPinned: true });
    expect(ids(cmds)).toContain("unpin-pane");
    expect(ids(cmds)).not.toContain("pin-pane");
  });

  test("offers neither when there is no target pane", () => {
    const cmds = buildCcCommands({ ...base, targetPaneId: null });
    expect(ids(cmds)).not.toContain("pin-pane");
    expect(ids(cmds)).not.toContain("unpin-pane");
  });
});

describe("buildCcCommands — view CRUD", () => {
  test("save/rename/delete are offered only in glass", () => {
    expect(ids(buildCcCommands({ ...base, inGlass: true }))).toEqual(
      expect.arrayContaining(["save-cc-view", "rename-cc-view", "delete-cc-view"]),
    );
    const outsideGlass = ids(buildCcCommands(base));
    expect(outsideGlass).not.toContain("save-cc-view");
    expect(outsideGlass).not.toContain("rename-cc-view");
    expect(outsideGlass).not.toContain("delete-cc-view");
  });

  test("switch-cc-view is offered everywhere and lists every view", () => {
    for (const inGlass of [true, false]) {
      const cmd = buildCcCommands({ ...base, inGlass }).find((c) => c.id === "switch-cc-view")!;
      expect(cmd.sublist!.map((o) => o.id)).toEqual(["active", "backend"]);
    }
  });

  test("marks the active view dirty in the switch sublist, and only the active one", () => {
    const cmd = buildCcCommands({ ...base, dirty: true }).find((c) => c.id === "switch-cc-view")!;
    const active = cmd.sublist!.find((o) => o.id === "active")!;
    const backend = cmd.sublist!.find((o) => o.id === "backend")!;
    expect(active.label).toBe("Active (unsaved changes)");
    expect(backend.label).toBe("Backend");
  });

  test("no dirty marker anywhere when the live axes match the active view", () => {
    const cmd = buildCcCommands({ ...base, dirty: false }).find((c) => c.id === "switch-cc-view")!;
    expect(cmd.sublist!.every((o) => !o.label.includes("unsaved"))).toBe(true);
  });

  test("switch-cc-view flags the active view as current", () => {
    const cmd = buildCcCommands(base).find((c) => c.id === "switch-cc-view")!;
    expect(cmd.sublist!.find((o) => o.id === "active")!.current).toBe(true);
    expect(cmd.sublist!.find((o) => o.id === "backend")!.current).toBeFalsy();
  });
});

describe("buildCcCommands — hidden sessions", () => {
  test("hidden is omitted when nothing is hidden", () => {
    expect(ids(buildCcCommands(base))).not.toContain("show-hidden-sessions");
  });

  test("hidden carries the count in its label and every hidden session in its sublist", () => {
    const cmds = buildCcCommands({
      ...base,
      hiddenSessions: [{ id: "$1", name: "alpha" }, { id: "$2", name: "beta" }],
    });
    const hidden = cmds.find((c) => c.id === "show-hidden-sessions")!;
    expect(hidden.label).toBe("Show hidden sessions (2)…");
    expect(hidden.sublist).toEqual([
      { id: "$1", label: "alpha" },
      { id: "$2", label: "beta" },
    ]);
  });
});
