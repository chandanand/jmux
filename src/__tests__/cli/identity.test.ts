import { describe, test, expect } from "bun:test";
import { buildIdentityPayload } from "../../cli/identity";

describe("buildIdentityPayload", () => {
  test("reports the authenticated account and organization", () => {
    expect(
      buildIdentityPayload({
        type: "linear",
        authState: "ok",
        identity: { account: "operator@example.com", organization: "acme" },
      }),
    ).toEqual({
      tracker: {
        type: "linear",
        authState: "ok",
        account: "operator@example.com",
        organization: "acme",
      },
    });
  });

  test("reports nulls when the adapter never authenticated", () => {
    expect(
      buildIdentityPayload({ type: "linear", authState: "unauthenticated", identity: null }),
    ).toEqual({
      tracker: { type: "linear", authState: "unauthenticated", account: null, organization: null },
    });
  });
});
