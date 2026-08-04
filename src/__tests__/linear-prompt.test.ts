import { describe, test, expect } from "bun:test";
import { buildLinearPrompt, buildLinearGroupPrompt } from "../adapters/linear-prompt";
import type { Issue } from "../adapters/types";

const issue = (o: Partial<Issue> = {}): Issue => ({
  id: "i1",
  identifier: "TRA-1",
  title: "Parse CSV header",
  status: "Todo",
  assignee: null,
  linkedMrUrls: [],
  webUrl: "",
  team: "Core",
  ...o,
});

describe("buildLinearPrompt", () => {
  test("leads with the single-issue instruction and wraps the body", () => {
    const out = buildLinearPrompt(issue({ description: "Read the first row." }));
    expect(out.startsWith("Work on Linear issue TRA-1:")).toBe(true);
    expect(out).toContain('<issue identifier="TRA-1">');
    expect(out).toContain("<title>Parse CSV header</title>");
    expect(out).toContain("Read the first row.");
  });

  test("renders comment threads after the issue block", () => {
    const out = buildLinearPrompt(
      issue({ comments: [{ id: "c1", author: "ana", body: "ping", createdAt: "2026-01-01" }] }),
    );
    expect(out.indexOf("</issue>")).toBeLessThan(out.indexOf("<comment-thread"));
  });
});

describe("buildLinearGroupPrompt", () => {
  const three = [
    issue({ id: "i1", identifier: "TRA-1", title: "Parse CSV header" }),
    issue({ id: "i2", identifier: "TRA-2", title: "Column mapping UI" }),
    issue({ id: "i3", identifier: "TRA-3", title: "Validation errors" }),
  ];

  test("names every issue up front", () => {
    const out = buildLinearGroupPrompt(three, "Bulk Import");
    expect(out.startsWith("Work on 3 Linear issues from Bulk Import: TRA-1, TRA-2, TRA-3.")).toBe(true);
  });

  // Without this the prompt reads as three independent instructions and an
  // agent has every reason to open three branches.
  test("states that they share one branch and one merge request", () => {
    const out = buildLinearGroupPrompt(three, "Bulk Import");
    expect(out).toContain("share this branch and worktree");
    expect(out).toContain("single merge request");
  });

  test("carries each issue's full block", () => {
    const out = buildLinearGroupPrompt(three, "Bulk Import");
    for (const i of three) expect(out).toContain(`<issue identifier="${i.identifier}">`);
    expect(out).toContain("<title>Column mapping UI</title>");
  });

  test("an unlabelled group still reads as one sentence", () => {
    expect(buildLinearGroupPrompt(three, "").startsWith("Work on 3 Linear issues: TRA-1")).toBe(true);
  });

  // The blocks are the same builder the single-issue prompt uses, so an issue
  // must read identically whichever way its session was started.
  test("an issue block matches the single-issue prompt's body", () => {
    const one = issue({ description: "Read the first row." });
    const solo = buildLinearPrompt(one);
    const group = buildLinearGroupPrompt([one], "Bulk Import");
    const body = solo.slice(solo.indexOf("<issue"));
    expect(group).toContain(body);
  });
});
