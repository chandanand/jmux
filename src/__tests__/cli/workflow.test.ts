import { describe, test, expect } from "bun:test";
import {
  buildBoard,
  summarizeBoard,
  buildStatusTable,
  orderedIssuesByView,
  toBoardIssue,
  type BoardInputs,
  type BoardSessionInput,
} from "../../cli/workflow";
import { parkedStages } from "../../panel-view";
import { stageForIssue } from "../../work-stage";
import { DEFAULT_PARKING } from "../../parking";
import type { PanelView } from "../../panel-view";
import type { Issue, WorkflowState } from "../../adapters/types";
import type { IssueSessionInfo } from "../../issue-session";

const NOW = 1_800_000_000_000;

function view(over: Partial<PanelView> & Pick<PanelView, "id" | "label">): PanelView {
  return {
    source: "issues",
    filter: { scope: "assigned" },
    groupBy: "none",
    subGroupBy: "none",
    sortBy: "priority",
    sortOrder: "asc",
    sessionLinkedFirst: false,
    ...over,
  } as PanelView;
}

function issue(over: Partial<Issue> & Pick<Issue, "id" | "identifier">): Issue {
  return {
    title: `Title for ${over.identifier}`,
    status: "To do",
    stateType: "unstarted",
    assignee: null,
    linkedMrUrls: [],
    webUrl: `https://linear.app/x/issue/${over.identifier}`,
    team: "Core",
    ...over,
  };
}

function session(over: Partial<BoardSessionInput> & Pick<BoardSessionInput, "name">): BoardSessionInput {
  return {
    id: `$${over.name}`,
    path: `/repo/${over.name}`,
    branch: over.name,
    agent: null,
    attention: false,
    attentionReason: null,
    pinned: false,
    lastActivity: NOW,
    ...over,
  };
}

const TODO = view({ id: "todo", label: "To do", states: ["To do"] });
const DOING = view({ id: "doing", label: "In Progress", states: ["In Progress"] });
const DONE = view({ id: "done", label: "Done", states: ["Done"] });
const MRS = view({ id: "my-mrs", label: "My MRs", source: "mrs", filter: { scope: "authored" } });

function inputs(over: Partial<BoardInputs> = {}): BoardInputs {
  const views = over.views ?? [TODO, DOING, DONE];
  const issues = over.issues ?? [];
  const parked = over.parkedStates ?? [];
  const issuesByView =
    over.issuesByView ??
    orderedIssuesByView(views, issues, over.issueSessionStates ?? new Map(), (i) =>
      stageForIssue(i as Issue, parkedStages(parked)),
    );
  return {
    views,
    upNextOrder: [],
    parkedStates: parked,
    parking: DEFAULT_PARKING,
    unstartedCap: 0,
    sessions: [],
    issues,
    issuesByView,
    issueSessionStates: new Map(),
    parkOverride: () => null,
    nowMs: NOW,
    ...over,
  };
}

describe("orderedIssuesByView", () => {
  test("a stage holds exactly the issues whose status it lists", () => {
    const issues = [
      issue({ id: "a", identifier: "T-1", status: "To do" }),
      issue({ id: "b", identifier: "T-2", status: "In Progress" }),
      issue({ id: "c", identifier: "T-3", status: "Nobody's stage" }),
    ];
    const byView = orderedIssuesByView([TODO, DOING], issues, new Map(), () => "active");
    expect(byView.get("todo")!.map((i) => i.identifier)).toEqual(["T-1"]);
    expect(byView.get("doing")!.map((i) => i.identifier)).toEqual(["T-2"]);
  });

  test("MR tabs get no entry — they hold no issues", () => {
    const byView = orderedIssuesByView([TODO, MRS], [], new Map(), () => "active");
    expect(byView.has("my-mrs")).toBe(false);
  });

  test("ordering is the panel's, not the input order", () => {
    const sorted = view({ id: "todo", label: "To do", states: ["To do"], sortBy: "priority" });
    const issues = [
      issue({ id: "a", identifier: "T-1", priority: 3 }),
      issue({ id: "b", identifier: "T-2", priority: 1 }),
    ];
    const byView = orderedIssuesByView([sorted], issues, new Map(), () => "active");
    expect(byView.get("todo")!.map((i) => i.identifier)).toEqual(["T-2", "T-1"]);
  });
});

describe("buildBoard — sessions land in the stage that claims their issue", () => {
  const issues = [
    issue({ id: "a", identifier: "T-1", status: "In Progress" }),
    issue({ id: "b", identifier: "T-2", status: "To do" }),
  ];
  const states = new Map<string, IssueSessionInfo>([
    ["a", { state: "session", sessionName: "t-1" }],
  ]);

  test("a linked session is filed under its issue's stage", () => {
    const board = buildBoard(
      inputs({ issues, issueSessionStates: states, sessions: [session({ name: "t-1" })] }),
    );
    const doing = board.stages.find((s) => s.id === "doing")!;
    expect(doing.sessions.map((s) => s.name)).toEqual(["t-1"]);
    expect(doing.sessions[0]!.issue!.identifier).toBe("T-1");
    expect(board.ungrouped).toEqual([]);
  });

  test("a session with no issue falls to the flat remainder", () => {
    const board = buildBoard(inputs({ issues, sessions: [session({ name: "dotfiles" })] }));
    expect(board.ungrouped.map((s) => s.name)).toEqual(["dotfiles"]);
    expect(board.stages.every((s) => s.sessions.length === 0)).toBe(true);
  });

  test("an issue whose status no stage claims leaves its session ungrouped", () => {
    const orphan = [issue({ id: "a", identifier: "T-1", status: "Waiting on legal" })];
    const board = buildBoard(
      inputs({ issues: orphan, issueSessionStates: states, sessions: [session({ name: "t-1" })] }),
    );
    expect(board.ungrouped.map((s) => s.name)).toEqual(["t-1"]);
    expect(board.ungrouped[0]!.issue!.identifier).toBe("T-1");
  });

  test("a hidden stage still claims its sessions — hiding a band is not hiding work", () => {
    const hidden = view({ id: "doing", label: "In Progress", states: ["In Progress"], inSidebar: false });
    const board = buildBoard(
      inputs({
        views: [TODO, hidden],
        issues,
        issueSessionStates: states,
        sessions: [session({ name: "t-1" })],
      }),
    );
    const doing = board.stages.find((s) => s.id === "doing")!;
    expect(doing.inSidebar).toBe(false);
    expect(doing.sessions.map((s) => s.name)).toEqual(["t-1"]);
  });

  test("only a resolved session counts — a bare worktree is not started", () => {
    const board = buildBoard(
      inputs({
        issues,
        issueSessionStates: new Map([["a", { state: "worktree", sessionName: "t-1" }]]),
        sessions: [session({ name: "t-1" })],
      }),
    );
    expect(board.ungrouped.map((s) => s.name)).toEqual(["t-1"]);
  });

  test("MR tabs are not stages", () => {
    const board = buildBoard(inputs({ views: [TODO, MRS, DOING] }));
    expect(board.stages.map((s) => s.id)).toEqual(["todo", "doing"]);
  });

  test("rank is the position in the workflow screen, MR tabs included", () => {
    const board = buildBoard(inputs({ views: [TODO, MRS, DOING] }));
    expect(board.stages.map((s) => s.rank)).toEqual([0, 2]);
  });
});

describe("buildBoard — parking", () => {
  const issues = [issue({ id: "a", identifier: "T-1", status: "In QA" })];
  const states = new Map<string, IssueSessionInfo>([
    ["a", { state: "session", sessionName: "t-1" }],
  ]);
  const qaStage = view({ id: "doing", label: "In Progress", states: ["In QA"] });

  test("a session on a parking status is flagged, and stays in its stage", () => {
    const board = buildBoard(
      inputs({
        views: [qaStage],
        issues,
        parkedStates: ["In QA"],
        issueSessionStates: states,
        sessions: [session({ name: "t-1" })],
      }),
    );
    const stage = board.stages[0]!;
    expect(stage.sessions[0]!.parked).toBe(true);
    expect(stage.counts).toMatchObject({ sessions: 1, parked: 1 });
  });

  test("parking is opt-in — an unlisted status never parks", () => {
    const board = buildBoard(
      inputs({
        views: [qaStage],
        issues,
        issueSessionStates: states,
        sessions: [session({ name: "t-1" })],
      }),
    );
    expect(board.stages[0]!.sessions[0]!.parked).toBe(false);
  });

  test("a waiting agent unparks — the agent-attention trigger is readable from tmux", () => {
    const board = buildBoard(
      inputs({
        views: [qaStage],
        issues,
        parkedStates: ["In QA"],
        parking: { ...DEFAULT_PARKING, unparkOn: ["agent-attention"] },
        issueSessionStates: states,
        sessions: [
          session({ name: "t-1", agent: { state: "waiting", since: null, ageSeconds: null } }),
        ],
      }),
    );
    expect(board.stages[0]!.sessions[0]!.parked).toBe(false);
  });

  test("the orchestrator's attention flag alone does not unpark", () => {
    // The TUI's parking consults the agent state only. Unparking on a signal
    // the sidebar ignores would put the agent and the human on different boards.
    const board = buildBoard(
      inputs({
        views: [qaStage],
        issues,
        parkedStates: ["In QA"],
        parking: { ...DEFAULT_PARKING, unparkOn: ["agent-attention"] },
        issueSessionStates: states,
        sessions: [session({ name: "t-1", attention: true, attentionReason: "look at me" })],
      }),
    );
    expect(board.stages[0]!.sessions[0]!.parked).toBe(true);
    expect(board.stages[0]!.sessions[0]!.attention).toBe(true);
  });

  test("a manual park applies to an issueless session", () => {
    const board = buildBoard(
      inputs({
        sessions: [session({ name: "dotfiles" })],
        parkOverride: () => ({ manual: "park", atStage: null }),
      }),
    );
    expect(board.ungrouped[0]!.parked).toBe(true);
  });

  test("a stale override is ignored — it answered a situation that has moved on", () => {
    const board = buildBoard(
      inputs({
        views: [qaStage],
        issues,
        issueSessionStates: states,
        sessions: [session({ name: "t-1" })],
        // Recorded while the issue was `done`; it is `active` now.
        parkOverride: () => ({ manual: "park", atStage: "done" }),
      }),
    );
    expect(board.stages[0]!.sessions[0]!.parked).toBe(false);
  });
});

describe("buildBoard — unstarted work", () => {
  const issues = [
    issue({ id: "a", identifier: "T-1", status: "To do" }),
    issue({ id: "b", identifier: "T-2", status: "To do" }),
    issue({ id: "c", identifier: "T-3", status: "Done", stateType: "completed" }),
  ];

  test("issues with no session are listed under their stage", () => {
    const board = buildBoard(inputs({ issues }));
    const todo = board.stages.find((s) => s.id === "todo")!;
    expect(todo.unstarted.map((i) => i.identifier)).toEqual(["T-1", "T-2"]);
    expect(todo.counts.unstarted).toBe(2);
  });

  test("an issue with a session is not unstarted", () => {
    const board = buildBoard(
      inputs({
        issues,
        issueSessionStates: new Map([["a", { state: "session", sessionName: "t-1" }]]),
      }),
    );
    expect(board.stages.find((s) => s.id === "todo")!.unstarted.map((i) => i.identifier))
      .toEqual(["T-2"]);
  });

  test("done work never becomes unstarted — nothing would ever clear it", () => {
    const board = buildBoard(inputs({ issues }));
    expect(board.stages.find((s) => s.id === "done")!.unstarted).toEqual([]);
  });

  test("parked work is left out for the same reason", () => {
    const parkedIssues = [issue({ id: "a", identifier: "T-1", status: "In QA" })];
    const qa = view({ id: "todo", label: "To do", states: ["In QA"] });
    const board = buildBoard(
      inputs({ views: [qa], issues: parkedIssues, parkedStates: ["In QA"] }),
    );
    expect(board.stages[0]!.unstarted).toEqual([]);
  });

  test("the list is uncapped; the sidebar's cap is reported alongside it", () => {
    const board = buildBoard(inputs({ issues, unstartedCap: 1 }));
    expect(board.stages.find((s) => s.id === "todo")!.unstarted).toHaveLength(2);
    expect(board.unstartedCap).toBe(1);
  });
});

describe("buildBoard — up next", () => {
  const issues = [
    issue({ id: "a", identifier: "T-1", status: "To do" }),
    issue({ id: "b", identifier: "T-2", status: "In Progress" }),
  ];

  test("picks the first item of the first non-empty queue, in rotation order", () => {
    const board = buildBoard(inputs({ issues, upNextOrder: ["doing", "todo"] }));
    expect(board.upNext).toMatchObject({ stageId: "doing", stageLabel: "In Progress" });
    expect(board.upNext!.issue.identifier).toBe("T-2");
  });

  test("skips an empty queue", () => {
    const board = buildBoard(inputs({ issues, upNextOrder: ["done", "todo"] }));
    expect(board.upNext!.issue.identifier).toBe("T-1");
  });

  test("an empty rotation is null, not an error", () => {
    expect(buildBoard(inputs({ issues })).upNext).toBeNull();
  });

  test("upNextRank records a stage's place in the rotation", () => {
    const board = buildBoard(inputs({ issues, upNextOrder: ["doing", "todo"] }));
    const byId = new Map(board.stages.map((s) => [s.id, s.upNextRank]));
    expect(byId.get("doing")).toBe(0);
    expect(byId.get("todo")).toBe(1);
    expect(byId.get("done")).toBeNull();
  });
});

describe("summarizeBoard", () => {
  test("drops the item arrays but keeps every count", () => {
    const issues = [issue({ id: "a", identifier: "T-1", status: "To do" })];
    const summary = summarizeBoard(buildBoard(inputs({ issues }))) as any;
    expect(summary.stages[0]).not.toHaveProperty("sessions");
    expect(summary.stages[0]).not.toHaveProperty("unstarted");
    expect(summary.stages[0].counts).toEqual({
      issues: 1,
      sessions: 0,
      parked: 0,
      unstarted: 1,
    });
  });
});

describe("buildStatusTable", () => {
  const states: WorkflowState[] = [
    { id: "1", name: "To do", type: "unstarted" },
    { id: "2", name: "In QA", type: "started" },
    { id: "3", name: "Backlog", type: "backlog" },
    // listWorkflowStates unions every team, so names recur.
    { id: "4", name: "To do", type: "unstarted", team: "Other" },
  ];

  test("says which stage claims each status, and whether it parks", () => {
    const rows = buildStatusTable(states, [TODO], ["In QA"], []);
    expect(rows.map((r) => r.name)).toEqual(["To do", "In QA", "Backlog"]);
    expect(rows[0]).toMatchObject({ stage: { id: "todo", label: "To do" }, parks: false });
    expect(rows[1]).toMatchObject({ stage: null, parks: true });
    expect(rows[2]).toMatchObject({ stage: null, parks: false });
  });

  test("counts issues per status, case-insensitively", () => {
    const issues = [
      issue({ id: "a", identifier: "T-1", status: "to do" }),
      issue({ id: "b", identifier: "T-2", status: "To do" }),
    ];
    expect(buildStatusTable(states, [TODO], [], issues)[0]!.issues).toBe(2);
  });
});

describe("toBoardIssue", () => {
  test("carries the fields an agent needs to act, priority absent as null", () => {
    expect(toBoardIssue(issue({ id: "a", identifier: "T-1" }))).toEqual({
      id: "a",
      identifier: "T-1",
      title: "Title for T-1",
      status: "To do",
      priority: null,
      team: "Core",
      url: "https://linear.app/x/issue/T-1",
    });
  });
});
