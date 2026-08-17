import { describe, test, expect, mock, beforeEach } from "bun:test";
import { GitLabAdapter, extractProjectPath } from "../../adapters/gitlab";

const GITLAB_ENV = [
  "GITLAB_TOKEN",
  "GITLAB_PRIVATE_TOKEN",
  "GITLAB_PERSONAL_ACCESS_TOKEN",
] as const;

/**
 * Run `fn` with no GitLab credential resolvable from anywhere.
 *
 * The environment half is obvious. The store half is not: `resolveCredential`
 * reads `~/.config/jmux/credentials.json` first, so the moment anybody stores a
 * GitLab token in jmux the fallback tests below would stop reaching the
 * fallback — passing while asserting nothing. An empty store is passed in
 * explicitly rather than hoped for.
 */
async function withoutGitLabEnv(fn: (deps: { credentials: {} }) => Promise<void>): Promise<void> {
  const saved = GITLAB_ENV.map((name) => [name, process.env[name]] as const);
  for (const name of GITLAB_ENV) delete process.env[name];
  try {
    await fn({ credentials: {} });
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

/** Swap `Bun.spawnSync` for the duration of one test; returns the undo. */
function stubSpawnSync(
  impl: (cmd: string[]) => { exitCode: number; stdout: string; stderr: string },
): () => void {
  const original = Bun.spawnSync;
  (Bun as any).spawnSync = (cmd: string[]) => {
    const r = impl(cmd);
    return { exitCode: r.exitCode, stdout: Buffer.from(r.stdout), stderr: Buffer.from(r.stderr) };
  };
  return () => { (Bun as any).spawnSync = original; };
}

describe("extractProjectPath", () => {
  test("extracts from HTTPS URL", () => {
    expect(extractProjectPath("https://gitlab.com/org/repo.git")).toBe("org/repo");
  });

  test("extracts from HTTPS URL without .git", () => {
    expect(extractProjectPath("https://gitlab.com/org/repo")).toBe("org/repo");
  });

  test("extracts from SSH URL", () => {
    expect(extractProjectPath("git@gitlab.com:org/repo.git")).toBe("org/repo");
  });

  test("extracts nested group paths", () => {
    expect(extractProjectPath("https://gitlab.com/org/sub/repo.git")).toBe("org/sub/repo");
  });

  test("returns null for invalid URL", () => {
    expect(extractProjectPath("not-a-url")).toBeNull();
  });
});

describe("parseMrUrl", () => {
  test("parses GitLab MR URL", () => {
    const adapter = new GitLabAdapter({ type: "gitlab" });
    const result = adapter.parseMrUrl("https://gitlab.com/org/repo/-/merge_requests/42");
    expect(result).toBe("org%2Frepo:42");
  });

  test("returns null for non-MR URL", () => {
    const adapter = new GitLabAdapter({ type: "gitlab" });
    expect(adapter.parseMrUrl("https://example.com")).toBeNull();
  });

  test("handles nested group paths", () => {
    const adapter = new GitLabAdapter({ type: "gitlab" });
    const result = adapter.parseMrUrl("https://gitlab.com/org/sub/repo/-/merge_requests/7");
    expect(result).toBe("org%2Fsub%2Frepo:7");
  });
});

describe("getMyMergeRequests", () => {
  test("returns empty array when not authenticated", async () => {
    const adapter = new GitLabAdapter({ type: "gitlab" });
    const results = await adapter.getMyMergeRequests();
    expect(results).toEqual([]);
  });
});

describe("getMrsAwaitingMyReview", () => {
  test("returns empty array when not authenticated", async () => {
    const adapter = new GitLabAdapter({ type: "gitlab" });
    const results = await adapter.getMrsAwaitingMyReview();
    expect(results).toEqual([]);
  });
});

describe("GitLabAdapter", () => {
  test("starts in unauthenticated state", () => {
    const adapter = new GitLabAdapter({ type: "gitlab" });
    expect(adapter.type).toBe("gitlab");
    expect(adapter.authState).toBe("unauthenticated");
    expect(adapter.authHint).toBe("$GITLAB_TOKEN or $GITLAB_PRIVATE_TOKEN");
  });

  // Rewritten, not removed: this asserted that a non-empty env var means "ok",
  // which is the bug — a revoked token reported connected, and swapping to one
  // would replace a working adapter with a dead one. It also reached the real
  // gitlab.com once authenticate() started probing.
  test("authenticate succeeds when the API confirms the token", async () => {
    const origToken = process.env.GITLAB_TOKEN;
    const realFetch = globalThis.fetch;
    process.env.GITLAB_TOKEN = "test-token";
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ username: "ada" }), { status: 200 })) as unknown as typeof fetch;
    try {
      const adapter = new GitLabAdapter({ type: "gitlab" });
      await adapter.authenticate();
      expect(adapter.authState).toBe("ok");
      expect(adapter.identity?.account).toBe("ada");
    } finally {
      globalThis.fetch = realFetch;
      if (origToken === undefined) delete process.env.GITLAB_TOKEN;
      else process.env.GITLAB_TOKEN = origToken;
    }
  });

  test("a rejected token reports failed", async () => {
    const origToken = process.env.GITLAB_TOKEN;
    const realFetch = globalThis.fetch;
    process.env.GITLAB_TOKEN = "revoked";
    globalThis.fetch = (async () => new Response("{}", { status: 401 })) as unknown as typeof fetch;
    try {
      const adapter = new GitLabAdapter({ type: "gitlab" });
      await adapter.authenticate();
      expect(adapter.authState).toBe("failed");
    } finally {
      globalThis.fetch = realFetch;
      if (origToken === undefined) delete process.env.GITLAB_TOKEN;
      else process.env.GITLAB_TOKEN = origToken;
    }
  });

  test("a network error reports unreachable, not failed", async () => {
    const origToken = process.env.GITLAB_TOKEN;
    const realFetch = globalThis.fetch;
    process.env.GITLAB_TOKEN = "test-token";
    globalThis.fetch = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    try {
      const adapter = new GitLabAdapter({ type: "gitlab" });
      await adapter.authenticate();
      expect(adapter.authState).toBe("unreachable");
    } finally {
      globalThis.fetch = realFetch;
      if (origToken === undefined) delete process.env.GITLAB_TOKEN;
      else process.env.GITLAB_TOKEN = origToken;
    }
  });

  test("authenticate fails when neither the env nor glab has a token", async () => {
    await withoutGitLabEnv(async (deps) => {
      const restore = stubSpawnSync(() => ({ exitCode: 1, stdout: "", stderr: "" }));
      try {
        const adapter = new GitLabAdapter({ type: "gitlab" }, deps);
        await adapter.authenticate();
        expect(adapter.authState).toBe("failed");
      } finally {
        restore();
      }
    });
  });
});

/**
 * The glab fallback asks for one value and gets one value back.
 *
 * It used to scrape `glab auth status -t` for `/Token:\s+(\S+)/`. glab stopped
 * printing that: 1.111 says "Token found in operating system keyring: <tok>",
 * which the pattern does not match — so on a machine authenticated through glab
 * alone, jmux found no token, reported `failed`, and every MR tab silently
 * disappeared. A status page is prose written for a human and free to be
 * reworded; `config get token` is the machine-readable form, and the same
 * property is why `readGhToken` has never had this problem.
 */
describe("GitLabAdapter glab fallback", () => {
  test("asks glab for the token of the host it is configured against", async () => {
    await withoutGitLabEnv(async (deps) => {
      const calls: string[][] = [];
      const restore = stubSpawnSync((cmd) => {
        calls.push(cmd);
        return { exitCode: 0, stdout: "glpat-from-keyring\n", stderr: "" };
      });
      const realFetch = globalThis.fetch;
      const seenTokens: string[] = [];
      globalThis.fetch = (async (_url: string, init: RequestInit) => {
        seenTokens.push((init.headers as Record<string, string>)["PRIVATE-TOKEN"]);
        return new Response(JSON.stringify({ username: "ada" }), { status: 200 });
      }) as unknown as typeof fetch;
      try {
        const adapter = new GitLabAdapter({ type: "gitlab", url: "https://gitlab.example.com/api/v4" }, deps);
        await adapter.authenticate();
        expect(calls[0]).toEqual(["glab", "config", "get", "token", "--host", "gitlab.example.com"]);
        expect(adapter.authState).toBe("ok");
        expect(seenTokens).toEqual(["glpat-from-keyring"]);
      } finally {
        globalThis.fetch = realFetch;
        restore();
      }
    });
  });

  test("ignores stdout when glab exits non-zero", async () => {
    await withoutGitLabEnv(async (deps) => {
      const restore = stubSpawnSync(() => ({
        exitCode: 1,
        // glab prints its usage text on an unknown key rather than staying
        // quiet, so a non-zero exit has to disqualify stdout outright.
        stdout: "Usage: glab config get <key>",
        stderr: "",
      }));
      try {
        const adapter = new GitLabAdapter({ type: "gitlab" }, deps);
        await adapter.authenticate();
        expect(adapter.authState).toBe("failed");
      } finally {
        restore();
      }
    });
  });

  test("treats an empty answer as no token", async () => {
    await withoutGitLabEnv(async (deps) => {
      // `glab config get` prints nothing for a key it does not hold, and exits 0.
      const restore = stubSpawnSync(() => ({ exitCode: 0, stdout: "\n", stderr: "" }));
      try {
        const adapter = new GitLabAdapter({ type: "gitlab" }, deps);
        await adapter.authenticate();
        expect(adapter.authState).toBe("failed");
      } finally {
        restore();
      }
    });
  });
});

/**
 * Every other call in the adapter uses `this.baseUrl`; the identity probe alone
 * used the gitlab.com constant. A self-hosted install therefore sent its token
 * to gitlab.com, was told 401, and could never authenticate — the same missing
 * tabs, from a different cause.
 */
describe("GitLabAdapter identity probe", () => {
  test("probes the configured base URL, not gitlab.com", async () => {
    const origToken = process.env.GITLAB_TOKEN;
    process.env.GITLAB_TOKEN = "test-token";
    const realFetch = globalThis.fetch;
    const urls: string[] = [];
    globalThis.fetch = (async (url: string) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ username: "ada" }), { status: 200 });
    }) as unknown as typeof fetch;
    try {
      const adapter = new GitLabAdapter({ type: "gitlab", url: "https://gitlab.example.com/api/v4" });
      await adapter.authenticate();
      expect(urls).toEqual(["https://gitlab.example.com/api/v4/user"]);
    } finally {
      globalThis.fetch = realFetch;
      if (origToken === undefined) delete process.env.GITLAB_TOKEN;
      else process.env.GITLAB_TOKEN = origToken;
    }
  });
});
