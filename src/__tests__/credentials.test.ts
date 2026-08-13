import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, statSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { readCredentials, writeCredential, resolveCredential } from "../credentials";

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jmux-creds-"));
  path = join(dir, "credentials.json");
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("readCredentials", () => {
  test("a missing file is empty, not an error", () => {
    expect(readCredentials(path)).toEqual({});
  });

  // Unlike config.json, a broken credentials file must not stop jmux starting:
  // the environment may still carry a good token.
  test("a corrupt file is empty rather than fatal", () => {
    writeFileSync(path, "{ not json");
    expect(readCredentials(path)).toEqual({});
  });

  test("non-string and empty values are ignored", () => {
    writeFileSync(path, JSON.stringify({ linear: "tok", github: 42, gitlab: "" }));
    expect(readCredentials(path)).toEqual({ linear: "tok" });
  });
});

describe("writeCredential", () => {
  test("stores a token and reads it back", () => {
    writeCredential("linear", "lin_abc", path);
    expect(readCredentials(path).linear).toBe("lin_abc");
  });

  test("writes the file 0600", () => {
    writeCredential("linear", "lin_abc", path);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  // writeFileSync's `mode` only applies on creation, so an existing file from
  // before this rule would keep whatever permissions it had.
  test("tightens the mode of a file that already existed", () => {
    writeFileSync(path, "{}", { mode: 0o644 });
    writeCredential("linear", "lin_abc", path);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test("null removes the entry without disturbing the others", () => {
    writeCredential("linear", "a", path);
    writeCredential("github", "b", path);
    writeCredential("linear", null, path);
    expect(readCredentials(path)).toEqual({ github: "b" });
  });

  test("the file holds only what was stored — no config bleeds in", () => {
    writeCredential("linear", "a", path);
    expect(Object.keys(JSON.parse(readFileSync(path, "utf-8")))).toEqual(["linear"]);
  });
});

describe("resolveCredential", () => {
  const ENV = ["LINEAR_API_KEY", "LINEAR_TOKEN"] as const;

  test("no source at all", () => {
    const r = resolveCredential("linear", ENV, { store: {}, env: {} });
    expect(r).toEqual({ token: null, source: "none", shadowed: false });
  });

  test("the environment is used when nothing is stored", () => {
    const r = resolveCredential("linear", ENV, { store: {}, env: { LINEAR_API_KEY: "e" } });
    expect(r.token).toBe("e");
    expect(r.source).toBe("env");
  });

  test("environment names are tried in order", () => {
    const r = resolveCredential("linear", ENV, { store: {}, env: { LINEAR_TOKEN: "second" } });
    expect(r.token).toBe("second");
  });

  // The file is the more deliberate and more recent act. The inverse silently
  // masks the wizard's own final step with a years-old shell export.
  test("the stored token wins over the environment", () => {
    const r = resolveCredential("linear", ENV, {
      store: { linear: "stored" },
      env: { LINEAR_API_KEY: "env" },
    });
    expect(r.token).toBe("stored");
    expect(r.source).toBe("file");
  });

  test("a disagreement between the two sources is disclosed", () => {
    const r = resolveCredential("linear", ENV, {
      store: { linear: "stored" },
      env: { LINEAR_API_KEY: "env" },
    });
    expect(r.shadowed).toBe(true);
  });

  test("two sources that agree are not reported as shadowed", () => {
    const r = resolveCredential("linear", ENV, {
      store: { linear: "same" },
      env: { LINEAR_API_KEY: "same" },
    });
    expect(r.shadowed).toBe(false);
  });

  test("an empty environment value is not a token", () => {
    const r = resolveCredential("linear", ENV, { store: {}, env: { LINEAR_API_KEY: "" } });
    expect(r.source).toBe("none");
  });

  test("adapters are keyed separately", () => {
    const store = { linear: "l", github: "g" };
    expect(resolveCredential("github", ["GH_TOKEN"], { store, env: {} }).token).toBe("g");
  });

  // An existing user with only an env var, who never opens the wizard, must be
  // completely untouched.
  test("an env-only user is unaffected", () => {
    const r = resolveCredential("linear", ENV, { store: {}, env: { LINEAR_API_KEY: "old" } });
    expect(r).toEqual({ token: "old", source: "env", shadowed: false });
  });
});
