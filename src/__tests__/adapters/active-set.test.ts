import { describe, test, expect } from "bun:test";
import { ActiveAdapters } from "../../adapters/active-set";
import type { IssueTrackerAdapter } from "../../adapters/types";

function fakeTracker(type: string): IssueTrackerAdapter {
  return { type, authState: "ok", authHint: "", identity: null } as unknown as IssueTrackerAdapter;
}

describe("ActiveAdapters", () => {
  test("exposes the adapters it was built with", () => {
    const t = fakeTracker("linear");
    const a = new ActiveAdapters({ codeHost: null, issueTracker: t });
    expect(a.issueTracker).toBe(t);
    expect(a.codeHost).toBeNull();
  });

  test("starts at epoch 0 and that epoch is current", () => {
    const a = new ActiveAdapters({ codeHost: null, issueTracker: null });
    expect(a.epoch).toBe(0);
    expect(a.isCurrent(0)).toBe(true);
  });

  test("swap advances the epoch and publishes the new adapters", () => {
    const first = fakeTracker("linear");
    const second = fakeTracker("linear");
    const a = new ActiveAdapters({ codeHost: null, issueTracker: first });
    const before = a.epoch;
    const after = a.swap({ codeHost: null, issueTracker: second });
    expect(after).toBeGreaterThan(before);
    expect(a.epoch).toBe(after);
    expect(a.issueTracker).toBe(second);
  });

  test("an epoch captured before a swap is no longer current", () => {
    const a = new ActiveAdapters({ codeHost: null, issueTracker: fakeTracker("linear") });
    const captured = a.epoch;
    a.swap({ codeHost: null, issueTracker: fakeTracker("linear") });
    expect(a.isCurrent(captured)).toBe(false);
    expect(a.isCurrent(a.epoch)).toBe(true);
  });

  test("epochs never repeat across many swaps", () => {
    const a = new ActiveAdapters({ codeHost: null, issueTracker: null });
    const seen = new Set<number>([a.epoch]);
    for (let i = 0; i < 50; i++) {
      seen.add(a.swap({ codeHost: null, issueTracker: null }));
    }
    expect(seen.size).toBe(51);
  });
});
