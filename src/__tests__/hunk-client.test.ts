import { describe, test, expect } from "bun:test";
import { HunkClient } from "../hunk/client";

/**
 * A fetch stand-in that records what it was asked and replays canned answers.
 * The client's whole job is to be unbothered by a daemon that is missing,
 * slow, or answering with something unexpected, and none of those states are
 * reachable by pointing tests at a real one.
 */
function stubFetch(handler: (url: string, init: RequestInit | undefined) => unknown) {
  const calls: Array<{ url: string; body: unknown }> = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const result = handler(url, init);
    if (result instanceof Error) throw result;
    return new Response(JSON.stringify(result), { headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const BASE = "http://127.0.0.1:47657";

function client(handler: (url: string, init: RequestInit | undefined) => unknown) {
  const { impl, calls } = stubFetch(handler);
  return { client: new HunkClient({ base: BASE, fetchImpl: impl }), calls };
}

describe("probe", () => {
  test("reads capabilities off the documented endpoint", async () => {
    const { client: c, calls } = client(() => ({ version: 1, daemonVersion: 4, actions: ["list"] }));
    expect(await c.probe()).toEqual({ version: 1, daemonVersion: 4, actions: ["list"] });
    expect(calls[0].url).toBe(`${BASE}/session-api/capabilities`);
  });

  // No daemon is the common case — hunk isn't installed, or hasn't started one
  // yet. It must read as "control plane off", never as an error.
  test("no daemon is a null, not a throw", async () => {
    const { client: c } = client(() => new Error("ECONNREFUSED"));
    expect(await c.probe()).toBeNull();
  });
});

describe("request handling", () => {
  test("posts actions as {action, ...params} to /session-api", async () => {
    const { client: c, calls } = client(() => ({ sessions: [] }));
    await c.list();
    expect(calls[0].url).toBe(`${BASE}/session-api`);
    expect(calls[0].body).toEqual({ action: "list" });
  });

  // The daemon reports failures as HTTP 200 with an `error` string, including
  // raw internal messages like "undefined is not an object". None of them are
  // actionable, so they all collapse to "no answer".
  test("a 200 carrying an error is treated as no answer", async () => {
    const { client: c } = client(() => ({ error: "undefined is not an object (evaluating 'selector.sessionId')" }));
    expect(await c.get("sid")).toBeNull();
    expect(await c.notes("sid", "user")).toEqual([]);
    expect(await c.navigate("sid", "a.ts", { hunkNumber: 1 })).toBe(false);
  });

  test("a payload of the wrong shape yields empties rather than throwing", async () => {
    const { client: c } = client(() => ["not", "an", "object"]);
    expect(await c.list()).toEqual([]);
    expect(await c.get("sid")).toBeNull();
  });

  test("a transport failure mid-session yields empties", async () => {
    const { client: c } = client(() => new Error("socket hang up"));
    expect(await c.list()).toEqual([]);
    expect(await c.notes("sid", "user")).toEqual([]);
  });
});

describe("get", () => {
  test("unwraps the session envelope", async () => {
    const { client: c } = client(() => ({ session: { sessionId: "sid", pid: 42, title: "wt" } }));
    const s = await c.get("sid");
    expect(s?.sessionId).toBe("sid");
    expect(s?.pid).toBe(42);
  });
});

describe("notes", () => {
  // Omitting `type` selects a legacy live-agent view with a different payload
  // shape, so the client always sends one.
  test("always sends a type", async () => {
    const { client: c, calls } = client(() => ({ comments: [] }));
    await c.notes("sid", "user");
    expect(calls[0].body).toEqual({ action: "comment-list", selector: { sessionId: "sid" }, type: "user" });
  });

  test("parses the note list", async () => {
    const { client: c } = client(() => ({
      comments: [{ noteId: "user:1", source: "user", filePath: "a.ts", newRange: [3, 3], body: "fix" }],
    }));
    const notes = await c.notes("sid", "user");
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ noteId: "user:1", line: 3, body: "fix" });
  });
});

describe("removeNotes", () => {
  test("removes by id, one call per note", async () => {
    const { client: c, calls } = client(() => ({ result: { removed: true } }));
    expect(await c.removeNotes("sid", ["user:1", "user:2"])).toBe(2);
    expect(calls.map((call) => (call.body as { commentId: string }).commentId)).toEqual(["user:1", "user:2"]);
  });

  // A bulk clear would also delete notes written between reading the list and
  // finishing the send. The count is what the caller reports, so it has to be
  // what the daemon confirmed rather than what was attempted.
  test("counts only what the daemon confirmed gone", async () => {
    const { client: c } = client((_url, init) => {
      const body = JSON.parse(String(init?.body)) as { commentId: string };
      return body.commentId === "user:1" ? { result: { removed: true } } : { result: { removed: false } };
    });
    expect(await c.removeNotes("sid", ["user:1", "user:2"])).toBe(1);
  });

  test("a daemon that dies mid-clear reports what it managed", async () => {
    let n = 0;
    const { client: c } = client(() => (n++ === 0 ? { result: { removed: true } } : new Error("gone")));
    expect(await c.removeNotes("sid", ["user:1", "user:2"])).toBe(1);
  });

  test("nothing to remove makes no calls", async () => {
    const { client: c, calls } = client(() => ({ result: { removed: true } }));
    expect(await c.removeNotes("sid", [])).toBe(0);
    expect(calls).toHaveLength(0);
  });
});

describe("navigate", () => {
  test("sends the target through verbatim", async () => {
    const { client: c, calls } = client(() => ({ result: { filePath: "a.ts", hunkIndex: 0 } }));
    expect(await c.navigate("sid", "a.ts", { hunkNumber: 2 })).toBe(true);
    expect(calls[0].body).toEqual({
      action: "navigate",
      selector: { sessionId: "sid" },
      filePath: "a.ts",
      hunkNumber: 2,
    });
  });

  test("a line target rather than a hunk", async () => {
    const { client: c, calls } = client(() => ({ result: {} }));
    await c.navigate("sid", "a.ts", { newLine: 372 });
    expect(calls[0].body).toMatchObject({ newLine: 372 });
  });
});

describe("timeouts", () => {
  // A wedged daemon must not leave a pending promise on every poll tick.
  test("a request that never settles is abandoned", async () => {
    const impl = (async (_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as unknown as typeof fetch;
    const c = new HunkClient({ base: BASE, fetchImpl: impl, timeoutMs: 20 });
    expect(await c.list()).toEqual([]);
  });
});
