import { describe, expect, test } from "bun:test";
import {
  groundcrewActionGuidance,
  sessionManagerFromGroundcrewOption,
} from "../session-ownership";

describe("sessionManagerFromGroundcrewOption", () => {
  test("recognizes the exact Groundcrew ownership marker", () => {
    expect(sessionManagerFromGroundcrewOption("1")).toBe("groundcrew");
  });

  test("does not infer ownership from absent or unexpected values", () => {
    expect(sessionManagerFromGroundcrewOption(undefined)).toBeUndefined();
    expect(sessionManagerFromGroundcrewOption("")).toBeUndefined();
    expect(sessionManagerFromGroundcrewOption("0")).toBeUndefined();
    expect(sessionManagerFromGroundcrewOption("true")).toBeUndefined();
  });
});

describe("groundcrewActionGuidance", () => {
  test("routes destructive topology actions through crewop", () => {
    const guidance = groundcrewActionGuidance("close-pane", "ALF-123");
    expect(guidance.message).toContain("owns the tmux topology");
    expect(guidance.hint).toContain("crewop stop ALF-123");
    expect(guidance.paletteHint).toContain("crewop stop ALF-123");
  });

  test("cleanup observes ownership of both the session and worktree", () => {
    const guidance = groundcrewActionGuidance("cleanup-session", "ALF-123");
    expect(guidance.message).toContain("owns the session and worktree");
    expect(guidance.hint).toContain("crewop stop ALF-123");
  });

  test("explains that a Groundcrew session name is task identity", () => {
    const guidance = groundcrewActionGuidance("rename-session", "ALF-123");
    expect(guidance.message).toContain("task and session identity");
    expect(guidance.paletteHint).toContain("must stay ALF-123");
  });
});
