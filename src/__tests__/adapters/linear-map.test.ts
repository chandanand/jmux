import { describe, test, expect } from "bun:test";
import { customerRequestSignal } from "../../adapters/linear";

/**
 * Every shape the tracker can actually return. The three-state result is the
 * point: `true` and `false` are answers, `undefined` means the question could
 * not be answered — and only the last of those may not be treated as "no".
 */
describe("customerRequestSignal", () => {
  test("a connection with nodes is an attached request", () => {
    expect(customerRequestSignal({ nodes: [{ id: "n1" }] })).toBe(true);
  });

  test("a connection with no nodes is a confirmed absence", () => {
    expect(customerRequestSignal({ nodes: [] })).toBe(false);
  });

  test.each([
    ["the field was never requested", undefined],
    ["the resolver failed and returned null", null],
    ["the connection came back without nodes", {}],
    ["nodes came back null", { nodes: null }],
    ["nodes came back as something other than a list", { nodes: 3 }],
  ])("%s is unknown, never a confirmed absence", (_label, input) => {
    // Reporting any of these as `false` puts an issue that may carry a customer
    // request into the lane that merges without a human. That is the defect
    // this whole plan exists to remove; do not let it back in here.
    expect(customerRequestSignal(input)).toBeUndefined();
  });
});

describe("the query actually asks for it", () => {
  test("ISSUE_FIELDS requests the needs connection", async () => {
    // Without this the mapper is correct and production still never sees the
    // field, which is exactly how the previous defect survived review.
    const source = await Bun.file(new URL("../../adapters/linear.ts", import.meta.url)).text();
    expect(source).toMatch(/needs\(first:\s*1\)\s*\{\s*nodes\s*\{\s*id\s*\}\s*\}/);
  });
});
