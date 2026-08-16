import { describe, expect, test } from "bun:test";
import { parseTargetOwnership } from "../../cli/ownership";
import { US } from "../../tmux-fields";

describe("parseTargetOwnership", () => {
  test("recognizes the owning Groundcrew task for any resolved tmux target", () => {
    expect(parseTargetOwnership([`ALF-123${US}1`])).toEqual({
      task: "ALF-123",
      managedBy: "groundcrew",
    });
  });

  test("does not claim ordinary or malformed sessions", () => {
    expect(parseTargetOwnership([`main${US}`])).toBeNull();
    expect(parseTargetOwnership([`main${US}0`])).toBeNull();
    expect(parseTargetOwnership([])).toBeNull();
  });
});
