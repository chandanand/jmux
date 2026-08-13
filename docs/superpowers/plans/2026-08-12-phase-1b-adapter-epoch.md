# Phase 1b — Adapter Epoch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make changing the issue tracker or code host take effect immediately and safely, deleting "restart to apply" — so the first failure a new user hits (set Linear, nothing happens) cannot happen.

**Architecture:** One mutable `ActiveAdapters` holder carrying an `epoch` counter, shared by `PollCoordinator` and every async adapter consumer in `main.ts`. Each async path captures the epoch at entry and re-checks it after every `await`, **before** any mutation, catch-side auth/rate change, or `onUpdate`. A swap builds and verifies the replacement first and publishes only on success, so a bad token never displaces a working adapter. Verification is a real identity request, not a token-presence check.

**Tech Stack:** Bun 1.3.8+, TypeScript strict, `bun:test`.

## Global Constraints

- **Target Bun, not Node.**
- **`adapters` in `main.ts` is read as `adapters.issueTracker` / `adapters.codeHost` in dozens of places.** `ActiveAdapters` must expose those as **getters** so every existing call site keeps working untouched. Do not rewrite call sites.
- **Anything at module scope in `main.ts` must only touch bindings declared above it** — the temporal-dead-zone hazard `boot-smoke.test.ts` exists to catch.
- **Tests are pure unit tests over logic modules.** `main.ts` is unreachable; `boot-smoke` covers it.
- **jmux is a public repo.** No personal paths or credentials anywhere.
- **Never attribute work to Claude in git.**
- **Run before claiming done:** `bun run typecheck` and `bun test`.

## Prerequisite

Phase 1a (`2026-08-12-phase-1a-config-durability.md`) must be merged first. Task 7 here writes config on a tracker change, and doing that against the pre-1a writer is the data-loss path 1a exists to close.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `src/adapters/active-set.ts` | **Create.** The epoch holder. No I/O, no adapter construction — just identity, currency and swap bookkeeping. |
| `src/__tests__/adapters/active-set.test.ts` | **Create.** |
| `src/adapters/types.ts` | **Modify.** `AdapterAuthState` gains `unreachable`; both adapter interfaces gain `identity`. |
| `src/adapters/linear.ts`, `github.ts`, `gitlab.ts` | **Modify.** Real identity probes in `authenticate()`. |
| `src/adapters/poll-coordinator.ts` | **Modify.** `setAdapters`, epoch guards on every async completion. |
| `src/__tests__/adapters/poll-coordinator.test.ts` | **Modify.** Append describes. |
| `src/main.ts` | **Modify.** `adapters` becomes `ActiveAdapters`; guard `refreshTeams` and `applyStatusPick`; wire the settings swap; delete `adapterRestartNote`. |

---

## Task 1: The epoch holder

**Files:**
- Create: `src/adapters/active-set.ts`
- Test: `src/__tests__/adapters/active-set.test.ts`

**Interfaces:**
- Consumes: `AdapterSet`, `CodeHostAdapter`, `IssueTrackerAdapter` from `./registry` and `./types`.
- Produces:
  - `class ActiveAdapters { readonly epoch: number; get codeHost(): CodeHostAdapter | null; get issueTracker(): IssueTrackerAdapter | null; isCurrent(epoch: number): boolean; swap(next: AdapterSet): number }`

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/adapters/active-set.test.ts`:

```typescript
import { describe, test, expect } from "bun:test";
import { ActiveAdapters } from "../../adapters/active-set";
import type { IssueTrackerAdapter } from "../../adapters/types";

function fakeTracker(type: string): IssueTrackerAdapter {
  return { type, authState: "ok", authHint: "" } as unknown as IssueTrackerAdapter;
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/adapters/active-set.test.ts`
Expected: FAIL — `Cannot find module '../../adapters/active-set'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/adapters/active-set.ts`:

```typescript
import type { AdapterSet } from "./registry";
import type { CodeHostAdapter, IssueTrackerAdapter } from "./types";

/**
 * The one mutable adapter set, plus the epoch every async consumer checks.
 *
 * Adapters were a module-scope `const` whose fields nothing ever reassigned, so
 * changing the tracker in settings wrote config that did nothing until the next
 * launch. Making them swappable is only half the problem: every in-flight
 * request holds a reference to the adapter it started with, and its completion
 * would otherwise write one workspace's data into another's caches. The epoch
 * is how a completion asks "am I still the current world?" before it mutates
 * anything.
 *
 * Deliberately exposes `codeHost` / `issueTracker` as getters: `main.ts` reads
 * `adapters.issueTracker` in dozens of places, and this keeps all of them
 * correct with no edit.
 */
export class ActiveAdapters {
  private set: AdapterSet;
  private _epoch = 0;

  constructor(initial: AdapterSet) {
    this.set = initial;
  }

  get epoch(): number { return this._epoch; }
  get codeHost(): CodeHostAdapter | null { return this.set.codeHost; }
  get issueTracker(): IssueTrackerAdapter | null { return this.set.issueTracker; }

  /** True while `epoch` is the world the caller started in. */
  isCurrent(epoch: number): boolean {
    return epoch === this._epoch;
  }

  /**
   * Publish a new adapter set. Returns the new epoch.
   *
   * Callers must have verified `next` first — this does no I/O and cannot tell
   * a working adapter from a broken one. See `swapAdapters` in main.ts.
   */
  swap(next: AdapterSet): number {
    this.set = next;
    return ++this._epoch;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/__tests__/adapters/active-set.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Typecheck and commit**

```bash
bun run typecheck
git add src/adapters/active-set.ts src/__tests__/adapters/active-set.test.ts
git commit -m "feat(adapters): an epoch-carrying active adapter set

Swapping an adapter is not just reassignment: every in-flight request holds
the adapter it started with, and its completion would write one workspace's
data into another's caches. The epoch is how a completion asks whether it
still belongs to the current world."
```

---

## Task 2: Adapters report a verified identity

**Files:**
- Modify: `src/adapters/types.ts:92` (`AdapterAuthState`), `:96-113` and `:115-133` (both interfaces)
- Modify: `src/adapters/linear.ts:30-35` (`authenticate`)
- Test: `src/__tests__/adapters/linear.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces:
  - `type AdapterAuthState = "ok" | "failed" | "unreachable" | "unauthenticated"`
  - `interface AdapterIdentity { account: string; organization: string | null }`
  - `identity: AdapterIdentity | null` on both adapter interfaces.

`unreachable` is the distinction the spec requires: a revoked token and a dead network currently both land on `failed`, and `github.ts:107` already carries a comment warning that a startup blip must not permanently latch it. Only `failed` should ever block a swap.

- [ ] **Step 1: Write the failing test**

Append to `src/__tests__/adapters/linear.test.ts`:

```typescript
describe("LinearAdapter.authenticate verifies the token", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  function stubFetch(status: number, body: unknown): void {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(body), { status })) as typeof fetch;
  }

  test("a valid token reports ok and records the organization", async () => {
    process.env.LINEAR_API_KEY = "lin_test";
    stubFetch(200, { data: { viewer: { id: "u1", name: "Ada", organization: { name: "Acme", urlKey: "acme" } } } });
    const a = new LinearAdapter({});
    await a.authenticate();
    expect(a.authState).toBe("ok");
    expect(a.identity?.organization).toBe("Acme");
    expect(a.identity?.account).toBe("Ada");
  });

  test("a rejected token reports failed", async () => {
    process.env.LINEAR_API_KEY = "lin_bad";
    stubFetch(401, { errors: [{ message: "authentication failed" }] });
    const a = new LinearAdapter({});
    await a.authenticate();
    expect(a.authState).toBe("failed");
    expect(a.identity).toBeNull();
  });

  test("a network error reports unreachable, not failed", async () => {
    process.env.LINEAR_API_KEY = "lin_test";
    globalThis.fetch = (async () => { throw new Error("ECONNREFUSED"); }) as typeof fetch;
    const a = new LinearAdapter({});
    await a.authenticate();
    expect(a.authState).toBe("unreachable");
  });

  test("no token at all reports failed without any request", async () => {
    delete process.env.LINEAR_API_KEY;
    delete process.env.LINEAR_TOKEN;
    let called = false;
    globalThis.fetch = (async () => { called = true; return new Response("{}"); }) as typeof fetch;
    const a = new LinearAdapter({});
    await a.authenticate();
    expect(a.authState).toBe("failed");
    expect(called).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/adapters/linear.test.ts -t "verifies the token"`
Expected: FAIL — `a.identity` is undefined and `authState` is `"ok"` for a bad token.

- [ ] **Step 3: Write minimal implementation**

In `src/adapters/types.ts` replace line 92 and add the identity shape:

```typescript
/**
 * `unreachable` is deliberately distinct from `failed`. A revoked token and a
 * dropped network used to be the same state, which meant a blip at startup
 * latched the adapter off for the whole run — and, once adapters are swappable,
 * would let a transient failure block a swap that was actually fine.
 */
export type AdapterAuthState = "ok" | "failed" | "unreachable" | "unauthenticated";

/** Who the credential belongs to, for display and cross-workspace warnings. */
export interface AdapterIdentity {
  account: string;
  organization: string | null;
}
```

Add to **both** `CodeHostAdapter` and `IssueTrackerAdapter`, beside `authHint`:

```typescript
  /** Populated by a successful `authenticate()`; null otherwise. */
  identity: AdapterIdentity | null;
```

In `src/adapters/linear.ts`, add the field beside `authHint` and replace `authenticate`:

```typescript
  identity: AdapterIdentity | null = null;

  async authenticate(): Promise<void> {
    const token = process.env.LINEAR_API_KEY ?? process.env.LINEAR_TOKEN ?? null;
    if (!token) { this.authState = "failed"; this.identity = null; return; }
    this.token = token;
    // A real request, not merely a non-empty string. Presence proved nothing:
    // a revoked, malformed or wrong-workspace token reported `ok`, so every
    // "connected" the UI showed was a claim about a string existing.
    try {
      const resp = await fetch(LINEAR_API, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: token },
        body: JSON.stringify({
          query: `query { viewer { id name organization { name urlKey } } }`,
        }),
      });
      if (!resp.ok) { this.authState = "failed"; this.identity = null; return; }
      const json = await resp.json() as any;
      const viewer = json?.data?.viewer;
      if (!viewer?.id) { this.authState = "failed"; this.identity = null; return; }
      this.identity = {
        account: viewer.name ?? viewer.id,
        organization: viewer.organization?.name ?? null,
      };
      this.authState = "ok";
    } catch {
      // Network, DNS, timeout — the token may be perfectly good. Latching
      // `failed` here would block a swap over a blip.
      this.authState = "unreachable";
      this.identity = null;
    }
  }
```

Add `AdapterIdentity` to the type import at the top of `linear.ts`.

- [ ] **Step 4: Fix the fallout and run the suite**

`AdapterAuthState` gained a member, so `switch`/comparison sites may need updating. Run `bun run typecheck` and fix every error it reports. Sites that test `=== "ok"` are already correct and need no change. Sites that test `!== "ok"` are also correct.

Add `identity: AdapterIdentity | null = null;` to `GitHubAdapter`, `GitLabAdapter`, and both mocks in `src/demo/` — typecheck will name them.

Run: `bun test && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/ src/demo/ src/__tests__/adapters/
git commit -m "feat(adapters): verify credentials instead of checking they exist

authenticate() checked that an environment string was non-empty, so a
revoked or wrong-workspace token reported ok and every connected state the
UI showed was a claim about a string. Linear now asks the API who it is,
and a network failure is a distinct state from a rejected credential."
```

---

## Task 3: GitHub and GitLab identity probes

**Files:**
- Modify: `src/adapters/github.ts:100-125`, `src/adapters/gitlab.ts:36-50`
- Test: `src/__tests__/adapters/github.test.ts`, `src/__tests__/adapters/gitlab.test.ts`

**Interfaces:**
- Consumes: `AdapterIdentity`, the four-state `AdapterAuthState` from Task 2.
- Produces: no new exports.

A code-host swap can publish revoked credentials as healthy exactly as the tracker could. Same treatment, same three outcomes.

- [ ] **Step 1: Write the failing tests**

Append to `src/__tests__/adapters/github.test.ts`:

```typescript
describe("GitHubAdapter.authenticate verifies the token", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  test("a valid token reports ok and records the login", async () => {
    process.env.GH_TOKEN = "ghp_test";
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ login: "ada" }), { status: 200 })) as typeof fetch;
    const a = new GitHubAdapter({});
    await a.authenticate();
    expect(a.authState).toBe("ok");
    expect(a.identity?.account).toBe("ada");
  });

  test("a rejected token reports failed", async () => {
    process.env.GH_TOKEN = "ghp_bad";
    globalThis.fetch = (async () => new Response("{}", { status: 401 })) as typeof fetch;
    const a = new GitHubAdapter({});
    await a.authenticate();
    expect(a.authState).toBe("failed");
  });

  test("a network error reports unreachable", async () => {
    process.env.GH_TOKEN = "ghp_test";
    globalThis.fetch = (async () => { throw new Error("ECONNREFUSED"); }) as typeof fetch;
    const a = new GitHubAdapter({});
    await a.authenticate();
    expect(a.authState).toBe("unreachable");
  });
});
```

Append the equivalent to `src/__tests__/adapters/gitlab.test.ts`, using `GET /api/v4/user` and asserting `a.identity?.account` is the returned `username`, with `process.env.GITLAB_TOKEN`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/__tests__/adapters/github.test.ts src/__tests__/adapters/gitlab.test.ts -t "verifies the token"`
Expected: FAIL.

- [ ] **Step 3: Write minimal implementation**

In `github.ts`, after the existing token resolution succeeds, replace the unconditional `this.authState = "ok"` with a probe of `GET https://api.github.com/user`:

```typescript
    try {
      const resp = await fetch("https://api.github.com/user", {
        headers: { Authorization: `Bearer ${this.token}`, Accept: "application/vnd.github+json" },
      });
      if (!resp.ok) { this.authState = "failed"; this.identity = null; return; }
      const user = await resp.json() as { login?: string };
      if (!user.login) { this.authState = "failed"; this.identity = null; return; }
      this.identity = { account: user.login, organization: null };
      this.authState = "ok";
    } catch {
      this.authState = "unreachable";
      this.identity = null;
    }
```

In `gitlab.ts`, the same shape against `${this.baseUrl}/api/v4/user` with header `PRIVATE-TOKEN: <token>`, reading `username`. Use whatever base-URL field the adapter already holds — do not introduce a new one.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/github.ts src/adapters/gitlab.ts src/__tests__/adapters/
git commit -m "feat(adapters): identity probes for GitHub and GitLab

A code host could publish revoked credentials as healthy exactly as the
tracker could, and a swap would then replace a working adapter with a dead
one."
```

---

## Task 4: `PollCoordinator` accepts a swap and guards its global paths

**Files:**
- Modify: `src/adapters/poll-coordinator.ts:34-40` (options), `:174-198` (`pollGlobal`), `:213-235` (`refreshGlobalItem`)
- Test: `src/__tests__/adapters/poll-coordinator.test.ts`

**Interfaces:**
- Consumes: `ActiveAdapters` from Task 1.
- Produces: `PollCoordinator.setAdapters(set: AdapterSet): void`, and a private `epoch` readable via the new public `get adapterEpoch(): number` (tests need to observe it).

- [ ] **Step 1: Write the failing test**

Append to `src/__tests__/adapters/poll-coordinator.test.ts`:

```typescript
describe("PollCoordinator adapter swap", () => {
  test("results from a retired adapter are dropped", async () => {
    let release: (v: Issue[]) => void = () => {};
    const slow = new Promise<Issue[]>((r) => { release = r; });
    const oldTracker = {
      type: "linear", authState: "ok" as AdapterAuthState, authHint: "", identity: null,
      getMyIssues: () => slow,
      getMyMergeRequests: async () => [],
    } as unknown as IssueTrackerAdapter;

    const coord = new PollCoordinator({
      codeHost: null, issueTracker: oldTracker,
      onUpdate: () => {}, getSessionDir: () => null, sessionState: null,
    });

    const inFlight = coord.pollGlobal();
    coord.setAdapters({ codeHost: null, issueTracker: null });
    release([{ id: "old-1" } as Issue]);
    await inFlight;

    expect(coord.getGlobalIssues()).toEqual([]);
  });

  test("setAdapters advances the epoch", () => {
    const coord = new PollCoordinator({
      codeHost: null, issueTracker: null,
      onUpdate: () => {}, getSessionDir: () => null, sessionState: null,
    });
    const before = coord.adapterEpoch;
    coord.setAdapters({ codeHost: null, issueTracker: null });
    expect(coord.adapterEpoch).toBeGreaterThan(before);
  });

  test("setAdapters clears provider-derived caches", async () => {
    const tracker = {
      type: "linear", authState: "ok" as AdapterAuthState, authHint: "", identity: null,
      getMyIssues: async () => [{ id: "a" } as Issue],
      getMyMergeRequests: async () => [],
    } as unknown as IssueTrackerAdapter;
    const coord = new PollCoordinator({
      codeHost: null, issueTracker: tracker,
      onUpdate: () => {}, getSessionDir: () => null, sessionState: null,
    });
    await coord.pollGlobal();
    expect(coord.getGlobalIssues()).toHaveLength(1);
    coord.setAdapters({ codeHost: null, issueTracker: null });
    expect(coord.getGlobalIssues()).toEqual([]);
  });
});
```

Add `AdapterAuthState`, `Issue`, `IssueTrackerAdapter` to that file's type imports if absent.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/adapters/poll-coordinator.test.ts -t "adapter swap"`
Expected: FAIL — `coord.setAdapters` is not a function.

- [ ] **Step 3: Write minimal implementation**

Add beside the other private fields:

```typescript
  private epoch = 0;
```

Add the public accessor and the setter beside `get issueTracker()`:

```typescript
  /** The current adapter generation. Exposed so tests can observe a swap. */
  get adapterEpoch(): number { return this.epoch; }

  /**
   * Replace the adapters and retire everything derived from the old ones.
   *
   * Clearing is not optional. Contexts, global caches and link signatures were
   * all computed against a different workspace, and `resolvedLinkSignatures` in
   * particular would make every session look freshly resolved and suppress the
   * re-resolve that fixes it. Sessions are re-queued so they refill from the
   * new adapters.
   */
  setAdapters(set: AdapterSet): void {
    this.epoch++;
    this.opts.codeHost = set.codeHost;
    this.opts.issueTracker = set.issueTracker;

    this.contexts.clear();
    this.resolvedLinkSignatures.clear();
    this.degradedSessions.clear();
    this.globalIssues = [];
    this.globalMrs = [];
    this.globalReviewMrs = [];
    this._rateLimitState = "normal";
    this.pending.clear();
    this.inFlight.clear();

    for (const name of this.sessionDirs.keys()) this.enqueueBackfill(name);
    this.opts.onUpdate("__global__");
  }
```

Add `AdapterSet` to the imports from `./registry`.

Guard `pollGlobal` — capture at entry, check before each assignment and the final update:

```typescript
  async pollGlobal(): Promise<void> {
    const { codeHost, issueTracker } = this.opts;
    const epoch = this.epoch;

    if (issueTracker && issueTracker.authState === "ok") {
      try {
        const issues = await issueTracker.getMyIssues();
        if (!this.isCurrent(epoch)) return;
        this.globalIssues = issues;
      } catch (e) {
        if (!this.isCurrent(epoch)) return;
        logError("PollCoordinator", `global issues poll failed: ${(e as Error).message}`);
      }
    }

    if (codeHost && codeHost.authState === "ok") {
      try {
        const mrs = await codeHost.getMyMergeRequests();
        if (!this.isCurrent(epoch)) return;
        this.globalMrs = mrs;
      } catch (e) {
        if (!this.isCurrent(epoch)) return;
        logError("PollCoordinator", `global MRs poll failed: ${(e as Error).message}`);
      }
      try {
        const review = await codeHost.getMrsAwaitingMyReview();
        if (!this.isCurrent(epoch)) return;
        this.globalReviewMrs = review;
      } catch (e) {
        if (!this.isCurrent(epoch)) return;
        logError("PollCoordinator", `global review MRs poll failed: ${(e as Error).message}`);
      }
    }

    if (!this.isCurrent(epoch)) return;
    this.opts.onUpdate("__global__");
  }
```

Add the private helper beside `adapterEpoch`:

```typescript
  /** Whether a captured epoch is still the live one. */
  private isCurrent(epoch: number): boolean { return epoch === this.epoch; }
```

Apply the identical treatment to `refreshGlobalItem`: capture `const epoch = this.epoch;` at entry, `await` into a local, `if (!this.isCurrent(epoch)) return;` before the array mutation, before each catch's `logError`, and before the final `onUpdate`.

`PollCoordinatorOptions.codeHost` / `.issueTracker` must lose `readonly` if they carry it; the interface as written at `:34-40` does not, so no change is needed there.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/__tests__/adapters/poll-coordinator.test.ts`
Expected: PASS, including the pre-existing tests.

- [ ] **Step 5: Typecheck and commit**

```bash
bun run typecheck
git add src/adapters/poll-coordinator.ts src/__tests__/adapters/poll-coordinator.test.ts
git commit -m "feat(poll): accept an adapter swap and drop retired results

A completion from a replaced adapter would otherwise write one workspace's
issues into another's caches. Clearing resolvedLinkSignatures is the
subtle half: without it every session looks freshly resolved and never
re-resolves against the new adapter."
```

---

## Task 5: The subtle paths — `resolveContext` and `drainBackfill`

**Files:**
- Modify: `src/adapters/poll-coordinator.ts:294-312` (`drainBackfill`), `:346-378` (`resolveContext`)
- Test: `src/__tests__/adapters/poll-coordinator.test.ts`

**Interfaces:**
- Consumes: `isCurrent`, `epoch` from Task 4.
- Produces: no new exports.

Two hazards a plain epoch check does not cover:

1. `resolveContext` stamps `resolvedLinkSignatures` **before** its await — deliberately, so a link added during resolution stays stale. On a swap that stamp survives into the new epoch and marks the session fresh forever. Task 4's `setAdapters` clears the map, but a resolve already in flight re-stamps it *after* the clear.
2. `drainBackfill`'s `.finally()` deletes `inFlight.delete(name)` unconditionally. A retired resolve's `finally` can delete a marker the **new** epoch just added, letting two resolves run for one session.

- [ ] **Step 1: Write the failing test**

Append to `src/__tests__/adapters/poll-coordinator.test.ts`:

```typescript
describe("PollCoordinator swap during in-flight resolution", () => {
  test("a retired resolve does not leave a stale link signature", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = () => r(); });
    const tracker = {
      type: "linear", authState: "ok" as AdapterAuthState, authHint: "", identity: null,
      pollAllIssues: async () => { await gate; return new Map(); },
      getMyIssues: async () => [],
    } as unknown as IssueTrackerAdapter;

    const coord = new PollCoordinator({
      codeHost: null, issueTracker: tracker,
      onUpdate: () => {}, getSessionDir: () => "/tmp/x", sessionState: null,
    });
    coord.setSessionDirs(new Map([["s1", "/tmp/x"]]));

    const inFlight = coord.setActiveSession("s1");
    coord.setAdapters({ codeHost: null, issueTracker: null });
    release();
    await inFlight;

    // The session must be queued for re-resolution, not considered fresh.
    expect(coord.getContext("s1")).toBeUndefined();
  });

  test("a retired resolve's finally cannot clear a live in-flight marker", async () => {
    const coord = new PollCoordinator({
      codeHost: null, issueTracker: null,
      onUpdate: () => {}, getSessionDir: () => "/tmp/x", sessionState: null,
    });
    coord.setSessionDirs(new Map([["s1", "/tmp/x"]]));
    // Exercised indirectly: after a swap, the coordinator must not hold a
    // session in `inFlight` that no promise will ever settle.
    coord.setAdapters({ codeHost: null, issueTracker: null });
    expect(coord.inFlightCount).toBe(0);
  });
});
```

Note for the implementer: use whatever the real method for seeding session dirs is — check with `grep -n "setSessionDirs\|sessionDirs.set" src/adapters/poll-coordinator.ts` and use the actual public API. Do not add a method just for the test; if none exists, drive it through the existing public entry point that populates `sessionDirs`.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/adapters/poll-coordinator.test.ts -t "in-flight resolution"`
Expected: FAIL — `coord.inFlightCount` does not exist, and the context survives the swap.

- [ ] **Step 3: Write minimal implementation**

Add the observability accessor beside `adapterEpoch`:

```typescript
  /** Sessions currently being resolved. Exposed so tests can assert a swap drains them. */
  get inFlightCount(): number { return this.inFlight.size; }
```

Guard `resolveContext` — capture the epoch at entry, and check it before **every** mutation:

```typescript
  private async resolveContext(name: string): Promise<void> {
    const dir = this.sessionDirs.get(name);
    if (!dir) return;
    const epoch = this.epoch;
    try {
      const manualIssueIds = this.linkIdsFor(name);
      const manualMrIds = this.opts.sessionState?.getLinkedMrIds(name) ?? [];
      this.resolvedLinkSignatures.set(name, issueLinkSignature(manualIssueIds));
      const ctx = await resolveSessionContext({
        sessionName: name,
        dir,
        codeHost: this.opts.codeHost,
        issueTracker: this.opts.issueTracker,
        manualIssueIds,
        manualMrIds,
      });
      // The signature above was stamped before the await and would otherwise
      // survive a swap that cleared the map — marking this session fresh
      // against adapters it was never resolved from.
      if (!this.isCurrent(epoch)) {
        this.resolvedLinkSignatures.delete(name);
        return;
      }
      this.contexts.set(name, ctx);
      if (ctx.degraded) this.degradedSessions.add(name);
      else this.degradedSessions.delete(name);
      this.opts.onUpdate(name);
    } catch (e) {
      if (!this.isCurrent(epoch)) {
        this.resolvedLinkSignatures.delete(name);
        return;
      }
      logError("PollCoordinator", `resolve session "${name}" failed: ${(e as Error).message}`);
      this.degradedSessions.add(name);
    }
  }
```

Make `drainBackfill`'s `finally` epoch-aware:

```typescript
      this.inFlight.add(name);
      const startedAt = this.epoch;
      void this.resolveContext(name).finally(() => {
        // Only the epoch that added this marker may remove it. A retired
        // resolve settling late would otherwise delete a marker the current
        // epoch just added, and two resolves would run for one session.
        if (this.isCurrent(startedAt)) {
          this.inFlight.delete(name);
          void this.drainBackfill();
        }
      });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/__tests__/adapters/poll-coordinator.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

```bash
bun run typecheck
git add src/adapters/poll-coordinator.ts src/__tests__/adapters/poll-coordinator.test.ts
git commit -m "fix(poll): make in-flight resolution survive a swap correctly

resolveContext stamps its link signature before awaiting, so a resolve
crossing a swap re-stamped the map setAdapters had just cleared and marked
the session permanently fresh. And drainBackfill's finally deleted the
in-flight marker unconditionally, so a retired resolve could clear one the
new epoch had just added."
```

---

## Task 6: Auth and rate-limit reports are scoped to the adapter that produced them

**Files:**
- Modify: `src/adapters/poll-coordinator.ts:330-344` (`reportRateLimit`, `reportAuthFailure`), `:380-456` (active poll), `:458-560` (background poll)
- Test: `src/__tests__/adapters/poll-coordinator.test.ts`

**Interfaces:**
- Consumes: `isCurrent` from Task 4.
- Produces: `reportAuthFailure(adapterKey, epoch?: number)` — the epoch is optional so existing callers keep compiling; when supplied and stale, the report is dropped.

`reportAuthFailure` looks up `this.opts[adapterKey]` — the *current* adapter — so a late 401 from the retired one marks the new one dead. `reportRateLimit` stops and restarts polling globally for the same reason.

- [ ] **Step 1: Write the failing test**

```typescript
describe("PollCoordinator retired-adapter reports", () => {
  test("a late auth failure from a retired adapter does not mark the new one failed", () => {
    const fresh = {
      type: "linear", authState: "ok" as AdapterAuthState, authHint: "", identity: null,
    } as unknown as IssueTrackerAdapter;
    const coord = new PollCoordinator({
      codeHost: null, issueTracker: null,
      onUpdate: () => {}, getSessionDir: () => null, sessionState: null,
    });
    const stale = coord.adapterEpoch;
    coord.setAdapters({ codeHost: null, issueTracker: fresh });
    coord.reportAuthFailure("issueTracker", stale);
    expect(fresh.authState).toBe("ok");
  });

  test("a current auth failure still marks the adapter failed", () => {
    const live = {
      type: "linear", authState: "ok" as AdapterAuthState, authHint: "", identity: null,
    } as unknown as IssueTrackerAdapter;
    const coord = new PollCoordinator({
      codeHost: null, issueTracker: live,
      onUpdate: () => {}, getSessionDir: () => null, sessionState: null,
    });
    coord.reportAuthFailure("issueTracker", coord.adapterEpoch);
    expect(live.authState).toBe("failed");
  });

  test("a retired rate-limit report does not restart polling for the new adapter", () => {
    const coord = new PollCoordinator({
      codeHost: null, issueTracker: null,
      onUpdate: () => {}, getSessionDir: () => null, sessionState: null,
    });
    const stale = coord.adapterEpoch;
    coord.setAdapters({ codeHost: null, issueTracker: null });
    coord.reportRateLimit("hard_limited", stale);
    expect(coord.rateLimitState).toBe("normal");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/adapters/poll-coordinator.test.ts -t "retired-adapter reports"`
Expected: FAIL — both methods take no epoch.

- [ ] **Step 3: Write minimal implementation**

```typescript
  reportRateLimit(state: RateLimitState, epoch?: number): void {
    // A 429 belongs to the adapter that earned it. Applying a retired one
    // throttles a brand-new adapter that has made no requests at all.
    if (epoch !== undefined && !this.isCurrent(epoch)) return;
    this._rateLimitState = state;
    this.stop();
    if (state !== "hard_limited") {
      this.start();
    }
  }

  reportAuthFailure(adapterKey: "codeHost" | "issueTracker", epoch?: number): void {
    // Looks up the *current* adapter, so a late 401 from the retired one would
    // otherwise mark its replacement dead — with no request of its own having
    // failed, and no way for the user to tell why.
    if (epoch !== undefined && !this.isCurrent(epoch)) return;
    const adapter = this.opts[adapterKey];
    if (adapter) {
      adapter.authState = "failed";
    }
  }
```

Then, in `pollActiveSession` and `pollBackgroundSessions`: capture `const epoch = this.epoch;` at entry; pass it to every `reportAuthFailure` / `reportRateLimit` call in those methods; add `if (!this.isCurrent(epoch)) return;` immediately after each `await` and before every success-path mutation and `onUpdate`.

One extra rule specific to the active poll: **after the `getGitBranch` await, re-read the context from `this.contexts`** rather than using the object captured before it — a swap clears the map, and mutating the detached object writes into nothing.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/poll-coordinator.ts src/__tests__/adapters/poll-coordinator.test.ts
git commit -m "fix(poll): scope auth and rate-limit reports to their own adapter

A late 401 or 429 from a replaced adapter marked its replacement failed or
throttled it, with no request of its own having failed and nothing on
screen able to explain why."
```

---

## Task 7: Wire the swap into `main.ts` and delete "restart to apply"

**Files:**
- Modify: `src/main.ts:1545` (`adapters`), `:1638-1652` (`refreshTeams`), `:2012-2030` (`applyStatusPick`), `:5960-5975` (`adapterRestartNote`), `:6091-6113` (the two adapter settings rows)
- Test: none directly (`main.ts` is unreachable); covered by `boot-smoke` staying green plus the manual check below.

**Interfaces:**
- Consumes: `ActiveAdapters` (Task 1), `setAdapters` (Task 4), `identity` (Tasks 2–3).
- Produces: `async function swapAdapters(next: AdapterConfig): Promise<boolean>`.

- [ ] **Step 1: Replace the adapter binding**

At `main.ts:1545`:

```typescript
const adapters = new ActiveAdapters(
  demoCtx
    ? { codeHost: demoCtx.codeHost, issueTracker: demoCtx.issueTracker }
    : createAdapters(configStore.config.adapters),
);
```

Import `ActiveAdapters` from `./adapters/active-set`. Every existing `adapters.issueTracker` / `adapters.codeHost` read continues to work — they are getters.

- [ ] **Step 2: Guard the two module-level caches**

`refreshTeams` assigns `cachedTeams` and `cachedWorkflowStates` after awaits with no guard:

```typescript
async function refreshTeams(): Promise<void> {
  if (adapters.issueTracker?.authState !== "ok") return;
  if (Date.now() - lastTeamFetchMs < TEAM_REFRESH_INTERVAL_MS && cachedTeams.length > 0) return;
  const epoch = adapters.epoch;
  try {
    const teams = await adapters.issueTracker.getTeams();
    if (!adapters.isCurrent(epoch)) return;
    cachedTeams = teams;
    lastTeamFetchMs = Date.now();
  } catch (e) {
    logError("jmux", `team fetch failed: ${(e as Error).message}`);
  }
  try {
    const states = await adapters.issueTracker.listWorkflowStates();
    if (!adapters.isCurrent(epoch)) return;
    cachedWorkflowStates = states;
  } catch (e) {
    logError("jmux", `workflow state fetch failed: ${(e as Error).message}`);
  }
}
```

- [ ] **Step 3: Guard the optimistic status rollback**

In `applyStatusPick` (`main.ts:2012`), the rollback on failure is the dangerous one — it writes into `pollCoordinator` after an await:

```typescript
  const from = issue.status;
  const epoch = adapters.epoch;
  pollCoordinator.optimisticIssueStatus(issue.id, target);
  try {
    await tracker.updateStatus(issue.id, target);
  } catch (e) {
    // Only roll back into the world this write started in. After a swap the
    // coordinator's caches belong to a different workspace, and restoring a
    // status there would invent an issue state nobody asked for.
    if (!adapters.isCurrent(epoch)) return null;
    pollCoordinator.optimisticIssueStatus(issue.id, from);
    logError("jmux", `status pick failed for ${issue.identifier}: ${(e as Error).message}`);
    scheduleRender();
    return null;
  }
```

Apply the same `epoch` capture-and-check to the other adapter-capturing async actions the spec names: `main.ts:4435`, `:6512`, `:8335`. For each, capture `const epoch = adapters.epoch;` before the first `await` and `if (!adapters.isCurrent(epoch)) return;` before any state mutation or `scheduleRender()` that follows it.

Add `isCurrent` to `ActiveAdapters` if Task 1's version is not already public — it is.

- [ ] **Step 4: Add the swap function**

Place it below `refreshPanelViews` (which it calls) and above the settings-category builder:

```typescript
/**
 * Apply an adapter configuration change without a restart.
 *
 * Builds and *verifies* the replacement before publishing it: a bad token must
 * never displace a working adapter, and `authenticate()` now makes a real
 * request, so "verified" means something. `unreachable` is treated as a refusal
 * too — jmux cannot tell a good token on a dead network from a bad one, so it
 * keeps what works and says why.
 */
async function swapAdapters(next: AdapterConfig): Promise<boolean> {
  const candidate = createAdapters(next);
  if (candidate.issueTracker) await candidate.issueTracker.authenticate();
  if (candidate.codeHost) await candidate.codeHost.authenticate();

  const trackerBad = candidate.issueTracker && candidate.issueTracker.authState !== "ok";
  const hostBad = candidate.codeHost && candidate.codeHost.authState !== "ok";
  if (trackerBad || hostBad) {
    const bad = trackerBad ? candidate.issueTracker! : candidate.codeHost!;
    showToast(
      bad.authState === "unreachable"
        ? `${bad.type}: could not reach it — keeping the current connection`
        : `${bad.type}: not connected — check ${bad.authHint}`,
    );
    return false;
  }

  adapters.swap(candidate);
  pollCoordinator.setAdapters(candidate);
  cachedTeams = [];
  cachedWorkflowStates = [];
  lastTeamFetchMs = 0;
  refreshPanelViews();
  void refreshTeams();
  void pollCoordinator.pollGlobal();
  scheduleRender();
  return true;
}
```

- [ ] **Step 5: Call it from the settings rows and delete the restart note**

In `buildSettingsCategories`, the `code-host` and `issue-tracker` rows currently write config and carry `getNote: () => adapterRestartNote(...)`. Replace each `onOptionSelect` with:

```typescript
          onOptionSelect: (v) => {
            configStore.setAdapter("issueTracker", v === "none" ? null : { type: v });
            void swapAdapters(configStore.config.adapters ?? {});
          },
```

(and the `codeHost` equivalent). Delete the `getNote` line from both rows, and delete the `adapterRestartNote` function entirely — the concept is gone.

Change the `issue-tracker` row's `getValue` to report identity rather than a bare type, so "connected" stops being a claim about a string:

```typescript
          getValue: () => {
            const t = adapters.issueTracker;
            if (!t) return "none";
            if (t.authState === "ok") {
              return t.identity?.organization ? `${t.type} · ${t.identity.organization}` : t.type;
            }
            if (t.authState === "unreachable") return `${t.type} (unreachable)`;
            return `${t.type} (not connected)`;
          },
```

Note for the implementer: `getValue` for a `list` row must still match one of `options` for the picker to open on the current choice — see the comment on `SettingDef.getNote`. So keep `options` as-is and let the picker fall back to index 0 when the value is decorated; the decoration is display-only. If that proves wrong in testing, move the decoration to `getNote` instead, which exists for exactly this.

- [ ] **Step 6: Verify manually**

```bash
bun run dev
```

1. `Ctrl-a i` → Integrations → Issue tracker → set to `linear` with `LINEAR_API_KEY` exported. Expect: issue tabs appear **without restarting**, and the row reads `linear · <your org>`.
2. Set it to `none`. Expect: tabs disappear immediately, no stale issues in the sidebar.
3. Unset the token, restart, set it to `linear`. Expect: `linear (not connected)` and a toast naming `$LINEAR_API_KEY` — and the row does **not** claim success.
4. `Ctrl-a W` (workflow screen) after step 1. Expect: the seed row is present, because statuses arrived without a relaunch. This is the phase-1 goal.

- [ ] **Step 7: Run everything and commit**

```bash
bun test && bun run typecheck
git add src/main.ts
git commit -m "feat(adapters): apply a tracker change without a restart

The first thing a new user hit: set the tracker to Linear, nothing
happens, and the only thing saying so was a note on a row they had already
moved off. Adapters are now swapped in place behind an epoch, verified
before they are published, and the workflow screen's seed row appears
because statuses finally arrive. Deletes adapterRestartNote."
```

---

## Done criteria

- [ ] `bun test` passes in full.
- [ ] `bun run typecheck` is clean.
- [ ] All four manual checks in Task 6 Step 6 pass.
- [ ] `grep -rn "adapterRestartNote" src/` returns nothing.
- [ ] `grep -rn "restart to apply" src/` returns nothing.
