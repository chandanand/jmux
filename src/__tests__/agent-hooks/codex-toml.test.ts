import { describe, test, expect } from "bun:test";
import { ensureHooksFeature } from "../../agent-hooks/codex-toml";

describe("ensureHooksFeature", () => {
  test("already true → no edit", () => {
    const text = "[features]\nhooks = true\n";
    const out = ensureHooksFeature(text);
    expect(out.status).toBe("already-enabled");
    expect(out.text).toBe(text);
  });

  test("adds the flag to an existing [features] table", () => {
    const out = ensureHooksFeature("[features]\nmemories = true\n");
    expect(out.status).toBe("enabled");
    expect(Bun.TOML.parse(out.text)).toEqual({ features: { hooks: true, memories: true } });
  });

  test("creates [features] when the file has none", () => {
    const out = ensureHooksFeature('model = "gpt-5"\n');
    expect(out.status).toBe("enabled");
    expect(Bun.TOML.parse(out.text)).toEqual({ model: "gpt-5", features: { hooks: true } });
  });

  test("handles an empty config", () => {
    const out = ensureHooksFeature("");
    expect(out.status).toBe("enabled");
    expect(Bun.TOML.parse(out.text)).toEqual({ features: { hooks: true } });
  });

  test("an explicit false is reported, never overridden", () => {
    // Flipping this would reverse a decision the user made on purpose.
    const text = "[features]\nhooks = false\n";
    const out = ensureHooksFeature(text);
    expect(out.status).toBe("explicitly-disabled");
    expect(out.text).toBe(text);
  });

  test("preserves every other key and table", () => {
    const text = [
      'model = "gpt-5"',
      "",
      "[features]",
      "memories = true",
      "",
      "[hooks.state]",
      "",
      '[hooks.state."/x/hooks.json:stop:0:0"]',
      'trusted_hash = "sha256:abc"',
      "",
      "[mcp_servers.foo]",
      'command = "bar"',
      "",
    ].join("\n");
    const out = ensureHooksFeature(text);
    expect(out.status).toBe("enabled");
    const before = Bun.TOML.parse(text) as Record<string, unknown>;
    const after = Bun.TOML.parse(out.text) as Record<string, unknown>;
    expect(after.model).toEqual(before.model);
    expect(after.hooks).toEqual(before.hooks);
    expect(after.mcp_servers).toEqual(before.mcp_servers);
    expect(after.features).toEqual({ memories: true, hooks: true });
  });

  test("does not mistake a [features.sub] header for the table itself", () => {
    const out = ensureHooksFeature("[features.nested]\nx = 1\n");
    expect(out.status).toBe("enabled");
    const parsed = Bun.TOML.parse(out.text) as Record<string, any>;
    expect(parsed.features.hooks).toBe(true);
    expect(parsed.features.nested).toEqual({ x: 1 });
  });

  test("tolerates whitespace around the header", () => {
    const out = ensureHooksFeature("  [features]  \nmemories = true\n");
    expect(out.status).toBe("enabled");
    expect((Bun.TOML.parse(out.text) as any).features.hooks).toBe(true);
  });

  test("unparseable TOML is refused rather than rewritten", () => {
    const text = "this is [not valid = toml\n";
    const out = ensureHooksFeature(text);
    expect(out.status).toBe("unsafe");
    expect(out.text).toBe(text);
  });

  test("every returned text parses — the flag is never written blind", () => {
    for (const input of ["", "[features]\n", 'a = 1\n[features]\nb = 2\n', "[other]\nx = 1\n"]) {
      const out = ensureHooksFeature(input);
      expect(() => Bun.TOML.parse(out.text)).not.toThrow();
    }
  });
});

describe("ensureHooksFeature / corruption guard depth", () => {
  test("refuses a splice that would alter a NESTED value", () => {
    // Regression: the guard used JSON.stringify(v, Object.keys(v).sort()), which
    // is a property allowlist applied at every depth — it stripped all nested
    // keys, so nested corruption compared equal and sailed through.
    const text = [
      "[mcp_servers.foo]",
      'command = "bar"',
      "",
      "[hooks.state]",
      'trusted_hash = "sha256:abc"',
      "",
    ].join("\n");
    const out = ensureHooksFeature(text);
    expect(out.status).toBe("enabled");

    const before = Bun.TOML.parse(text) as any;
    const after = Bun.TOML.parse(out.text) as any;
    // Nested content must survive verbatim — this is what the guard protects.
    expect(after.mcp_servers.foo.command).toBe("bar");
    expect(after.hooks.state.trusted_hash).toBe("sha256:abc");
    expect(after.mcp_servers).toEqual(before.mcp_servers);
    expect(after.hooks).toEqual(before.hooks);
  });

  test("deeply nested tables round-trip untouched", () => {
    const text = '[a.b.c]\nd = 1\ne = ["x", "y"]\n';
    const out = ensureHooksFeature(text);
    expect(out.status).toBe("enabled");
    const after = Bun.TOML.parse(out.text) as any;
    expect(after.a.b.c).toEqual({ d: 1, e: ["x", "y"] });
  });
});
