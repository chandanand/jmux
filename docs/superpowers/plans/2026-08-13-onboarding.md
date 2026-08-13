# First-run Onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the first-run checklist modal with an intent-branched composite wizard that carries a new user from launch to a working setup without ever abandoning them.

**Architecture:** `OnboardingModal` is a composite `Modal` on the `NewSessionModal` pattern — it owns a stack of child `ListModal`/`InputModal` instances directly rather than through `openModal()`, so a step that needs input never evicts the flow. Pure logic (`flow.ts`, `pages.ts`, `status.ts`, `render.ts`) lives in `src/onboarding/` where tests can reach it; `main.ts` only wires. Six installer/credential defects are fixed as independent prerequisite tasks before any UI exists.

**Tech Stack:** TypeScript (strict), Bun 1.3.8+, `bun:test`, `@xterm/headless` + `bun-pty` for the integration harness. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-13-onboarding-design.md`

## Global Constraints

- **Target Bun, not Node.** `Bun.spawn`, `Bun.which`, `Bun.$`. Never add Node-targeted equivalents.
- **Never attribute work to Claude** in commit messages — no `Co-Authored-By`, no footer, no mention.
- **Never name issues, test failures or who reported them in code comments.**
- **Every glyph must be width-1 under `cellWidth`.** Permitted set: `✓ ▸ ━ ─ · •`. Anything else needs a passing width assertion first.
- **Anything written to a `CellGrid` handles width-2 cells** with a width-0 continuation cell.
- **`main.ts` cannot be imported by tests.** All logic goes in `src/onboarding/*`; `main.ts` holds wiring only.
- **Module-scope temporal dead zone:** anything called at module scope in `main.ts` may only touch bindings declared above it.
- **Prose measure caps at `space.measure` (64)** from `src/chrome-tokens.ts`.
- **Accent appears in exactly three places:** page title, cursor row, filled rail segment. `tokens.affirmative` for `✓`, `tokens.textTertiary` for keys/asides.
- **No subprocess output on TUI-reachable paths.** No `console.log` / `process.stdout.write` in anything the modal can call.
- **Definition of done per task:** `bun run typecheck` clean and `bun test` green before the commit in that task's final step.

## File Structure

**Created:**
- `src/onboarding/status.ts` — `SetupStatus` snapshot type + pure derivation from injected facts
- `src/onboarding/pages.ts` — page table: id, title, prose, status, per-intent membership
- `src/onboarding/flow.ts` — state machine: page set, cursor, back/next, busy lock
- `src/onboarding/render.ts` — `CellGrid` painting for every page
- `src/onboarding/modal.ts` — `OnboardingModal`, the composite `Modal` + child stack
- `src/__tests__/onboarding-status.test.ts`, `-pages.test.ts`, `-flow.test.ts`, `-render.test.ts`
- `src/__tests__/onboarding-integration.test.ts` — pty harness

**Modified:**
- `src/agent-hooks/skill.ts` — add silent `installSkills()`
- `src/agent-hooks/types.ts` — add `writeTargets()` to `AgentIntegration`
- `src/agent-hooks/claude.ts`, `codex.ts`, `pi.ts` — implement `writeTargets()`
- `src/input-modal.ts` — add `secret` masking
- `src/modal.ts` — add optional `onResize`
- `src/main.ts` — SIGWINCH `onResize`; credential transaction; replace setup wiring; dependency-gate copy
- `src/config.ts` — nothing (deliberately: no `setup.intent` field)

**Deleted:**
- `src/setup-modal.ts`, `src/__tests__/setup-modal.test.ts` (coverage ported in Task 9)

---

### Task 1: Silent skill installer

**Files:**
- Modify: `src/agent-hooks/skill.ts`
- Test: `src/__tests__/agent-hooks/skill.test.ts`

**Interfaces:**
- Consumes: `installSkillTo(shipped, env, name): SkillOutcome` (`skill.ts:126`), `hunkSkillSource(): string | null` (`skill.ts:70`), `InstallReport` (`registry.ts:42`)
- Produces: `installSkills(): InstallReport[]` — silent, installs both jmux's skill and hunk's

- [ ] **Step 1: Write the failing test**

Append to `src/__tests__/agent-hooks/skill.test.ts`:

```ts
import { installSkills } from "../../agent-hooks/skill";

describe("installSkills", () => {
  test("writes nothing to stdout", () => {
    const logged: string[] = [];
    const origLog = console.log;
    const origWrite = process.stdout.write;
    console.log = (...a: unknown[]) => { logged.push(a.join(" ")); };
    // @ts-expect-error test double
    process.stdout.write = (s: string) => { logged.push(String(s)); return true; };
    try {
      installSkills();
    } finally {
      console.log = origLog;
      process.stdout.write = origWrite;
    }
    expect(logged).toEqual([]);
  });

  test("reports one entry per skill with an InstallReport shape", () => {
    const reports = installSkills();
    expect(reports.length).toBe(2);
    expect(reports.map((r) => r.label)).toEqual(["jmux ctl skill", "hunk review skill"]);
    for (const r of reports) {
      expect(["installed", "migrated", "noop", "skipped", "failed"]).toContain(r.kind);
      expect(Array.isArray(r.notes)).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/agent-hooks/skill.test.ts -t "installSkills"`
Expected: FAIL — `installSkills` is not exported.

- [ ] **Step 3: Implement**

In `src/agent-hooks/skill.ts`, import the report type and add above `installSkill()`:

```ts
import type { InstallReport } from "./registry";

/**
 * Install both skills and say what happened, without printing.
 *
 * The TUI cannot use `installSkill()`: it writes with `console.log`, which on
 * an alt screen lands directly on the rendered frame. Returns `InstallReport`
 * itself rather than a parallel type so the agents page renders hooks and
 * skills with one function and the two unions cannot drift.
 */
export function installSkills(): InstallReport[] {
  const reports: InstallReport[] = [];

  try {
    const shipped = readFileSync(skillIn(materializeAssets()), "utf-8");
    const outcome = installSkillTo(shipped);
    reports.push({
      label: "jmux ctl skill",
      kind: outcome.wrote ? "installed" : "noop",
      notes: outcome.notes,
    });
  } catch (err) {
    reports.push({
      label: "jmux ctl skill",
      kind: "failed",
      notes: [(err as Error).message],
    });
  }

  // hunk's skill is a bonus, never a requirement: no hunk means no Diff panel
  // to drive, so its absence is reported and shrugged off.
  const hunkShipped = hunkSkillSource();
  if (hunkShipped === null) {
    reports.push({
      label: "hunk review skill",
      kind: "skipped",
      notes: ["hunk not installed"],
    });
    return reports;
  }
  try {
    const outcome = installSkillTo(hunkShipped, process.env, HUNK_SKILL_NAME);
    reports.push({
      label: "hunk review skill",
      kind: outcome.wrote ? "installed" : "noop",
      notes: outcome.notes,
    });
  } catch (err) {
    reports.push({
      label: "hunk review skill",
      kind: "failed",
      notes: [(err as Error).message],
    });
  }
  return reports;
}
```

- [ ] **Step 4: Run tests**

Run: `bun test src/__tests__/agent-hooks/skill.test.ts && bun run typecheck`
Expected: PASS, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/agent-hooks/skill.ts src/__tests__/agent-hooks/skill.test.ts
git commit -m "feat(agent-hooks): a skill installer that returns results instead of printing

installSkill() writes with console.log, which is right for the CLI and wrong
from inside the TUI — its output lands on the rendered frame. installSkills()
does the same work silently and returns InstallReport, the type the agent
installer already returns, so both render through one path."
```

---

### Task 2: `InputModal` secret mode

**Files:**
- Modify: `src/input-modal.ts`
- Test: `src/__tests__/input-modal.test.ts`

**Interfaces:**
- Produces: `InputModalConfig.secret?: boolean` — masks rendering with `•`, leaves the value intact

- [ ] **Step 1: Write the failing test**

```ts
test("secret mode masks the rendered value but keeps it intact", () => {
  const modal = new InputModal({ header: "Token", secret: true });
  modal.open();
  for (const ch of "abc123") modal.handleInput(ch);

  const grid = modal.getGrid(40);
  const row = grid[1]!.map((c) => c.char).join("");
  expect(row).toContain("••••••");
  expect(row).not.toContain("abc123");

  // The value itself is unmasked — this is display only.
  const action = modal.handleInput("\r");
  expect(action).toEqual({ type: "result", value: "abc123" });
});

test("secret mode tracks the cursor at the real column", () => {
  const modal = new InputModal({ header: "Token", secret: true });
  modal.open();
  for (const ch of "abcd") modal.handleInput(ch);
  expect(modal.getCursorPosition()).toEqual({ row: 1, col: 8 });
});

test("plain mode still renders the value", () => {
  const modal = new InputModal({ header: "Name" });
  modal.open();
  for (const ch of "hello") modal.handleInput(ch);
  const row = modal.getGrid(40)[1]!.map((c) => c.char).join("");
  expect(row).toContain("hello");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/input-modal.test.ts -t "secret"`
Expected: FAIL — value renders in clear text.

- [ ] **Step 3: Implement**

In `src/input-modal.ts`, add to `InputModalConfig`:

```ts
  /**
   * Render `•` per character instead of the value.
   *
   * The tracker token is pasted on a terminal that may be shared, recorded or
   * scrolled back. Display only — the value, the cursor column and the result
   * are all unchanged, so nothing downstream has to know.
   */
  secret?: boolean;
```

In `getGrid`, replace the value write:

```ts
    if (this.value.length > 0) {
      const shown = this.config.secret ? "•".repeat(this.value.length) : this.value;
      writeString(grid, inputRow, 4, shown, INPUT_ATTRS);
    } else if (this.config.placeholder) {
```

`getCursorPosition()` is unchanged: `•` is width-1, so the masked column equals the real one.

- [ ] **Step 4: Run tests**

Run: `bun test src/__tests__/input-modal.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/input-modal.ts src/__tests__/input-modal.test.ts
git commit -m "feat(input-modal): a secret mode, for values that must not be on screen

Display only: the value, the cursor column and the committed result are
unchanged, so nothing downstream needs to know a field was masked."
```

---

### Task 3: A modal may survive resize

**Files:**
- Modify: `src/modal.ts`, `src/main.ts` (SIGWINCH handler at `main.ts:10472`)
- Test: `src/__tests__/modal.test.ts`

**Interfaces:**
- Produces: `Modal.onResize?(cols: number, rows: number): void`

- [ ] **Step 1: Write the failing test**

Create/append `src/__tests__/modal.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import type { Modal } from "../modal";
import { resizeOrClose } from "../modal";

function stubModal(withResize: boolean): Modal & { closed: boolean; sized: Array<[number, number]> } {
  const m = {
    closed: false,
    sized: [] as Array<[number, number]>,
    isOpen: () => true,
    preferredWidth: () => 40,
    getGrid: () => [],
    getCursorPosition: () => null,
    handleInput: () => ({ type: "consumed" }) as const,
    close() { m.closed = true; },
    ...(withResize ? { onResize(c: number, r: number) { m.sized.push([c, r]); } } : {}),
  };
  return m as Modal & { closed: boolean; sized: Array<[number, number]> };
}

describe("resizeOrClose", () => {
  test("a modal without onResize is closed, as before", () => {
    const m = stubModal(false);
    expect(resizeOrClose(m, 100, 30)).toBe("closed");
    expect(m.closed).toBe(true);
  });

  test("a modal with onResize survives and is re-sized", () => {
    const m = stubModal(true);
    expect(resizeOrClose(m, 100, 30)).toBe("resized");
    expect(m.closed).toBe(false);
    expect(m.sized).toEqual([[100, 30]]);
  });

  test("a null modal is a no-op", () => {
    expect(resizeOrClose(null, 100, 30)).toBe("none");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/modal.test.ts`
Expected: FAIL — `resizeOrClose` not exported.

- [ ] **Step 3: Implement**

In `src/modal.ts`, add to the `Modal` interface:

```ts
  /**
   * Re-lay out for a new terminal size instead of being closed by SIGWINCH.
   *
   * Modals size themselves at open, so closing on resize is right for every
   * modal that is one screen. A multi-step flow is not: closing would discard
   * the whole flow, including a half-typed value, on a window drag. Optional,
   * so every existing modal keeps today's behaviour untouched.
   */
  onResize?(cols: number, rows: number): void;
```

And below the interface:

```ts
/**
 * What SIGWINCH should do with the active modal. Extracted so the rule is
 * testable — the handler in main.ts is unreachable from tests.
 */
export function resizeOrClose(
  modal: Modal | null,
  cols: number,
  rows: number,
): "none" | "resized" | "closed" {
  if (!modal) return "none";
  if (modal.onResize) {
    modal.onResize(cols, rows);
    return "resized";
  }
  modal.close();
  return "closed";
}
```

In `src/main.ts`, add `resizeOrClose` to the existing `./modal` import, then replace the SIGWINCH body's modal branch (`main.ts:10473-10475`):

```ts
process.on("SIGWINCH", () => {
  // A modal that can re-lay out keeps its state; one that cannot is closed, as
  // it always was. Returning "resized" means the flow survives the drag.
  if (resizeOrClose(activeModal, process.stdout.columns || 80, process.stdout.rows || 24) === "closed") {
    closeModal();
  }
```

Note: `closeModal()` is still what runs for the close case, because it also clears `onModalResult` and re-derives input routing — `resizeOrClose` only decides.

Because `resizeOrClose` calls `modal.close()` and `closeModal()` calls it again, make `closeModal`'s call safe by leaving it as-is: `close()` on every modal in the tree is idempotent (each sets `_open = false`).

- [ ] **Step 4: Run tests**

Run: `bun test src/__tests__/modal.test.ts && bun run typecheck && bun test`
Expected: PASS, whole suite green.

- [ ] **Step 5: Commit**

```bash
git add src/modal.ts src/main.ts src/__tests__/modal.test.ts
git commit -m "feat(modal): a modal may re-lay out on resize instead of being closed

SIGWINCH closes the active modal because modals size themselves at open. That
is right for a single screen and wrong for a multi-step flow, where it discards
the flow and any half-typed value on a window drag. Opt-in, so every existing
modal is untouched."
```

---

### Task 4: Agents declare every file they write

**Files:**
- Modify: `src/agent-hooks/types.ts`, `claude.ts`, `codex.ts`, `pi.ts`
- Test: `src/__tests__/agent-hooks/registry.test.ts`

**Interfaces:**
- Produces: `AgentIntegration.writeTargets(): string[]`

- [ ] **Step 1: Write the failing test**

```ts
import { AGENT_INTEGRATIONS } from "../../agent-hooks/registry";
import { piExtensionTarget } from "../../agent-hooks/pi";

describe("writeTargets", () => {
  test("every integration reports at least its configPath", () => {
    for (const a of AGENT_INTEGRATIONS) {
      expect(a.writeTargets()).toContain(a.configPath);
    }
  });

  test("codex reports config.toml as well as hooks.json", () => {
    const codex = AGENT_INTEGRATIONS.find((a) => a.id === "codex")!;
    const targets = codex.writeTargets();
    expect(targets.some((t) => t.endsWith("hooks.json"))).toBe(true);
    expect(targets.some((t) => t.endsWith("config.toml"))).toBe(true);
  });

  test("pi reports the extension file as well as its settings", () => {
    const pi = AGENT_INTEGRATIONS.find((a) => a.id === "pi")!;
    expect(pi.writeTargets()).toContain(piExtensionTarget());
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/agent-hooks/registry.test.ts -t "writeTargets"`
Expected: FAIL — `writeTargets` is not a function.

- [ ] **Step 3: Implement**

In `src/agent-hooks/types.ts`, add to `AgentIntegration`:

```ts
  /**
   * Every file `install()` may write, resolved now.
   *
   * `configPath` is the primary one and under-reports two of the three agents:
   * Codex also splices a feature flag into `config.toml`, and pi copies its
   * extension beside its settings. Consent to edit another tool's config is
   * only real if it names what will actually be touched, and paths resolve
   * from the environment (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`), so this cannot
   * be a literal in prose.
   */
  writeTargets(): string[];
```

In `claude.ts`, on `claudeIntegration`:

```ts
  writeTargets(): string[] {
    return [claudeSettingsPath()];
  },
```

In `codex.ts`, on `codexIntegration`:

```ts
  writeTargets(): string[] {
    return [hooksPath(), configPath()];
  },
```

In `pi.ts`, on `piIntegration`:

```ts
  writeTargets(): string[] {
    return [piSettingsPath(), piExtensionTarget()];
  },
```

- [ ] **Step 4: Run tests**

Run: `bun test src/__tests__/agent-hooks/ && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agent-hooks/
git commit -m "feat(agent-hooks): integrations declare every file they write

configPath under-reports two of three agents: Codex also edits config.toml and
pi copies an extension beside its settings. Consent to write into another
tool's config is only real if it names the true target, and paths resolve from
the environment, so prose cannot state them."
```

---

### Task 5: The credential transaction

**Files:**
- Create: `src/tracker-credential.ts`
- Test: `src/__tests__/tracker-credential.test.ts`

**Interfaces:**
- Consumes: `writeCredential(type, token)` from `src/credentials.ts`
- Produces: `applyTrackerCredential(opts): Promise<TrackerCredentialResult>`

Extracted to its own module because `main.ts` is untestable and this is the one
step whose failure silently destroys user data.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
import { applyTrackerCredential } from "../tracker-credential";

function harness(opts: { verifyOk: boolean; previous?: string | null }) {
  const writes: Array<string | null> = [];
  let stored: string | null = opts.previous ?? null;
  let persistedType: string | null = null;
  return {
    writes,
    get stored() { return stored; },
    get persistedType() { return persistedType; },
    run: (token: string) =>
      applyTrackerCredential({
        type: "linear",
        token,
        readCredential: () => stored,
        writeCredential: (_t, v) => { writes.push(v); stored = v; },
        persistType: (t) => { persistedType = t; },
        verify: async () => opts.verifyOk,
      }),
  };
}

describe("applyTrackerCredential", () => {
  test("a good token is kept and the adapter type is persisted with it", async () => {
    const h = harness({ verifyOk: true });
    expect(await h.run("good")).toEqual({ ok: true });
    expect(h.stored).toBe("good");
    expect(h.persistedType).toBe("linear");
  });

  test("a bad token restores the previous one, never null", async () => {
    const h = harness({ verifyOk: false, previous: "the-old-working-token" });
    const result = await h.run("bad");
    expect(result.ok).toBe(false);
    expect(h.stored).toBe("the-old-working-token");
    expect(h.writes).toEqual(["bad", "the-old-working-token"]);
  });

  test("a bad token with no previous credential restores absence", async () => {
    const h = harness({ verifyOk: false, previous: null });
    await h.run("bad");
    expect(h.stored).toBeNull();
  });

  test("the adapter type is not persisted when verification fails", async () => {
    const h = harness({ verifyOk: false });
    await h.run("bad");
    expect(h.persistedType).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/tracker-credential.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/tracker-credential.ts`:

```ts
/**
 * Write a tracker credential, verify it, and put things back exactly as they
 * were if it does not work.
 *
 * Three defects this exists to fix, all of which were live in the setup
 * checklist's tracker step:
 *
 * **The rollback destroyed a working token.** It wrote `null` on failure, so a
 * mistyped paste over a connected setup left the user with no credential at
 * all — a worse state than before they tried. The previous value is snapshotted
 * and restored verbatim.
 *
 * **The adapter type was never persisted.** `createAdapters` builds nothing
 * without `adapters.issueTracker.type`, so a token written against an unset
 * type connects to nothing and reports no reason. Type and token are committed
 * together, and only after the token is known to work.
 *
 * **Verification cannot precede the write.** `IssueTrackerAdapter` takes no
 * candidate credential and `LinearAdapter.authenticate()` reads the global
 * resolver, so there is nowhere to try a token without storing it first. This
 * is write-verify-restore and says so; the exposure is one round trip and the
 * restore is exact.
 *
 * Every dependency is injected so the rule is testable without touching a real
 * credentials file or a network.
 */
export interface TrackerCredentialOptions {
  type: string;
  token: string;
  readCredential: (type: string) => string | null;
  writeCredential: (type: string, token: string | null) => void;
  persistType: (type: string) => void;
  verify: () => Promise<boolean>;
}

export type TrackerCredentialResult = { ok: true } | { ok: false };

export async function applyTrackerCredential(
  opts: TrackerCredentialOptions,
): Promise<TrackerCredentialResult> {
  const previous = opts.readCredential(opts.type);
  opts.writeCredential(opts.type, opts.token);

  let verified = false;
  try {
    verified = await opts.verify();
  } catch {
    verified = false;
  }

  if (!verified) {
    // Restore, never clear. `previous` may itself be null, which restores
    // absence — also exactly what was there before.
    opts.writeCredential(opts.type, previous);
    return { ok: false };
  }

  // Only now: a type pointing at a credential that does not work is a config
  // that looks connected and is not.
  opts.persistType(opts.type);
  return { ok: true };
}
```

- [ ] **Step 4: Run tests**

Run: `bun test src/__tests__/tracker-credential.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tracker-credential.ts src/__tests__/tracker-credential.test.ts
git commit -m "fix(tracker): a rejected token must not destroy the working one

The checklist's tracker step wrote null on failure, so a mistyped paste over a
connected setup left no credential at all. It also never persisted the adapter
type, without which the registry builds no adapter and a stored token connects
to nothing.

Verification still cannot precede the write — no adapter takes a candidate
credential — so this is write-verify-restore, stated rather than implied."
```

---

### Task 6: The setup snapshot

**Files:**
- Create: `src/onboarding/status.ts`
- Test: `src/__tests__/onboarding-status.test.ts`

**Interfaces:**
- Produces: `SetupStatus`, `StepId`, `StepState`, `deriveStatus(facts: SetupFacts): SetupStatus`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
import { deriveStatus, type SetupFacts } from "../onboarding/status";

const base: SetupFacts = {
  agentsPresent: [],
  agentsStale: [],
  skillCurrent: false,
  trackerType: null,
  trackerAuthed: false,
  trackerDeclined: false,
  projectCount: 0,
  attachedTeamCount: 0,
  workflowTabCount: 0,
  hunkInstalled: false,
};

describe("deriveStatus", () => {
  test("no agents on the machine is unavailable, not pending", () => {
    const s = deriveStatus(base);
    expect(s.steps.agents.state).toBe("unavailable");
    expect(s.steps.agents.summary).toBe("no agents found");
  });

  test("agents present but stale is pending", () => {
    const s = deriveStatus({ ...base, agentsPresent: ["Claude Code"], agentsStale: ["Claude Code"] });
    expect(s.steps.agents.state).toBe("pending");
  });

  test("agents present, current, and the skill installed is satisfied", () => {
    const s = deriveStatus({ ...base, agentsPresent: ["Claude Code"], agentsStale: [], skillCurrent: true });
    expect(s.steps.agents.state).toBe("satisfied");
    expect(s.steps.agents.summary).toBe("Claude Code");
  });

  test("projects satisfied reports the count", () => {
    const s = deriveStatus({ ...base, projectCount: 2 });
    expect(s.steps.projects.state).toBe("satisfied");
    expect(s.steps.projects.summary).toBe("2 projects");
  });

  test("one project reads in the singular", () => {
    expect(deriveStatus({ ...base, projectCount: 1 }).steps.projects.summary).toBe("1 project");
  });

  test("a declined tracker is unavailable rather than nagging forever", () => {
    const s = deriveStatus({ ...base, trackerDeclined: true });
    expect(s.steps.tracker.state).toBe("unavailable");
  });

  test("outstanding is true while any step is pending", () => {
    expect(deriveStatus({ ...base, projectCount: 0 }).outstanding).toBe(true);
  });

  test("outstanding is false when everything pending is done and the rest unavailable", () => {
    const s = deriveStatus({
      ...base,
      projectCount: 1,
      agentsPresent: ["Claude Code"],
      skillCurrent: true,
      trackerDeclined: true,
    });
    expect(s.outstanding).toBe(false);
  });

  test("an unavailable step never makes the toolbar dot appear", () => {
    // No agents at all: nothing to do, so nothing to nag about.
    const s = deriveStatus({ ...base, projectCount: 1, skillCurrent: true, trackerDeclined: true });
    expect(s.steps.agents.state).toBe("unavailable");
    expect(s.outstanding).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/onboarding-status.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/onboarding/status.ts`:

```ts
/**
 * What is true about this machine's setup, as one immutable value.
 *
 * Owned by main.ts rather than by the modal, for two reasons. The toolbar dot
 * needs an answer when no modal is open at all; and the config watcher can
 * reload projects, workflow views and declared intent while the flow is open,
 * so a snapshot refreshed only by the flow's own actions would go stale under
 * the user's own edit.
 *
 * Derivation is pure over injected facts, so every state below is reachable in
 * a test without touching a filesystem, an adapter or a tmux server.
 */

export type StepId = "projects" | "agents" | "tracker" | "team" | "workflow";

export type StepState =
  /** Already true on this machine. */
  | "satisfied"
  /** Not yet, and the flow can do it. */
  | "pending"
  /**
   * Not yet, and it cannot happen here — no agent installed, or the user said
   * never. Distinct from pending because it must never drive the toolbar dot:
   * nagging about something jmux cannot do is how a setup screen becomes
   * furniture.
   */
  | "unavailable";

export interface StepStatus {
  state: StepState;
  /** The right-hand column on the map. Words, never a raw fact. */
  summary: string;
}

export interface SetupFacts {
  agentsPresent: string[];
  agentsStale: string[];
  skillCurrent: boolean;
  trackerType: string | null;
  trackerAuthed: boolean;
  trackerDeclined: boolean;
  projectCount: number;
  attachedTeamCount: number;
  workflowTabCount: number;
  hunkInstalled: boolean;
}

export interface SetupStatus {
  steps: Record<StepId, StepStatus>;
  /** Whether anything the user could act on is still outstanding. */
  outstanding: boolean;
  facts: SetupFacts;
}

const plural = (n: number, one: string, many: string): string =>
  `${n} ${n === 1 ? one : many}`;

export function deriveStatus(facts: SetupFacts): SetupStatus {
  const projects: StepStatus = facts.projectCount > 0
    ? { state: "satisfied", summary: plural(facts.projectCount, "project", "projects") }
    : { state: "pending", summary: "not yet" };

  // Per-agent: an agent that is not installed here is not a gap to nag about,
  // so it counts neither way. The skill rides along because it is the same
  // idea — jmux and your agents seeing each other — and the same keystroke.
  const agents: StepStatus = facts.agentsPresent.length === 0
    ? { state: "unavailable", summary: "no agents found" }
    : facts.agentsStale.length === 0 && facts.skillCurrent
      ? { state: "satisfied", summary: facts.agentsPresent.join(", ") }
      : { state: "pending", summary: plural(facts.agentsStale.length, "to set up", "to set up") };

  const tracker: StepStatus = facts.trackerAuthed
    ? { state: "satisfied", summary: facts.trackerType ?? "connected" }
    : facts.trackerDeclined
      ? { state: "unavailable", summary: "not for me" }
      : { state: "pending", summary: "not yet" };

  // Both only mean anything once a tracker answers. Unavailable rather than
  // pending until then, so neither can raise the dot on a machine with no
  // tracker configured at all.
  const gated = (ok: boolean, summary: string): StepStatus =>
    !facts.trackerAuthed
      ? { state: "unavailable", summary: "needs a tracker" }
      : ok
        ? { state: "satisfied", summary }
        : { state: "pending", summary: "not yet" };

  const team = gated(
    facts.attachedTeamCount > 0,
    plural(facts.attachedTeamCount, "team routed", "teams routed"),
  );
  const workflow = gated(
    facts.workflowTabCount > 0,
    plural(facts.workflowTabCount, "stage", "stages"),
  );

  const steps = { projects, agents, tracker, team, workflow };
  return {
    steps,
    outstanding: Object.values(steps).some((s) => s.state === "pending"),
    facts,
  };
}
```

- [ ] **Step 4: Run tests**

Run: `bun test src/__tests__/onboarding-status.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/onboarding/status.ts src/__tests__/onboarding-status.test.ts
git commit -m "feat(onboarding): the setup snapshot, derived purely from injected facts

Owned above the modal because the toolbar dot needs an answer with no modal
open, and the config watcher can change what is true while the flow is up.
Unavailable is kept distinct from pending so a machine with no agent installed
is never nagged about one."
```

---

### Task 7: The page table

**Files:**
- Create: `src/onboarding/pages.ts`
- Test: `src/__tests__/onboarding-pages.test.ts`

**Interfaces:**
- Consumes: `SetupStatus`, `StepId` (Task 6)
- Produces: `Intent`, `PageId`, `PageDef`, `pagesFor(intent, status): PageDef[]`, `PAGES: Record<PageId, PageDef>`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
import { deriveStatus, type SetupFacts } from "../onboarding/status";
import { pagesFor } from "../onboarding/pages";

const facts: SetupFacts = {
  agentsPresent: ["Claude Code"], agentsStale: ["Claude Code"], skillCurrent: false,
  trackerType: "linear", trackerAuthed: false, trackerDeclined: false,
  projectCount: 0, attachedTeamCount: 0, workflowTabCount: 0, hunkInstalled: false,
};
const status = deriveStatus(facts);

describe("pagesFor", () => {
  test("solo is welcome, projects, agents, done", () => {
    expect(pagesFor("solo", status).map((p) => p.id))
      .toEqual(["welcome", "projects", "agents", "done"]);
  });

  test("tracker adds the three tracker pages before done", () => {
    expect(pagesFor("tracker", status).map((p) => p.id))
      .toEqual(["welcome", "projects", "agents", "tracker", "team", "workflow", "done"]);
  });

  test("manual is welcome only — nothing configured, nothing claimed", () => {
    expect(pagesFor("manual", status).map((p) => p.id)).toEqual(["welcome"]);
  });

  test("a page the intent did not ask for is absent, not merely inert", () => {
    const ids = pagesFor("solo", status).map((p) => p.id);
    expect(ids).not.toContain("tracker");
  });

  test("an unavailable page is still present, so the step count cannot lie", () => {
    const noAgents = deriveStatus({ ...facts, agentsPresent: [], agentsStale: [] });
    expect(noAgents.steps.agents.state).toBe("unavailable");
    expect(pagesFor("solo", noAgents).map((p) => p.id)).toContain("agents");
  });

  test("welcome and done are not counted as steps", () => {
    const pages = pagesFor("solo", status);
    expect(pages.filter((p) => p.counts).map((p) => p.id)).toEqual(["projects", "agents"]);
  });

  test("every page carries a title and at least one line of prose", () => {
    for (const p of pagesFor("tracker", status)) {
      expect(p.title.length).toBeGreaterThan(0);
      expect(p.body(status).length).toBeGreaterThan(0);
    }
  });

  test("the agents page says what it cannot do when no agent is installed", () => {
    const noAgents = deriveStatus({ ...facts, agentsPresent: [], agentsStale: [] });
    const page = pagesFor("solo", noAgents).find((p) => p.id === "agents")!;
    expect(page.body(noAgents).join(" ")).toContain("No coding agents found");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/onboarding-pages.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/onboarding/pages.ts`:

```ts
import type { SetupStatus, StepId } from "./status";

/**
 * The page table.
 *
 * Intent is in-memory flow state and is never persisted: a stored route is a
 * second source of truth that can disagree with what is actually configured,
 * and `config.ts` casts its parsed document rather than validating it, so a
 * union would buy nothing against a hand-edited file. On re-entry the map
 * derives what is in play from what is true.
 */
export type Intent = "solo" | "tracker" | "manual";

export type PageId =
  | "welcome" | "projects" | "agents"
  | "tracker" | "team" | "workflow" | "done";

export interface PageDef {
  id: PageId;
  title: string;
  /** The step this page satisfies, when it has one. */
  step?: StepId;
  /**
   * Whether this page is numbered in `Step N of M`.
   *
   * Welcome and Done are not steps — counting them would make a three-step
   * promise read as five and put the finish line one further away than it is.
   */
  counts: boolean;
  /** Prose, already wrapped by the caller to the measure. */
  body: (status: SetupStatus) => string[];
}

const SOLO_STEPS: PageId[] = ["projects", "agents"];
const TRACKER_STEPS: PageId[] = ["projects", "agents", "tracker", "team", "workflow"];

export const PAGES: Record<PageId, PageDef> = {
  welcome: {
    id: "welcome",
    title: "jmux",
    counts: false,
    body: () => [
      "Run several coding agents at once, and see what they're all doing.",
      "",
      "Every piece of work gets its own tmux session, its own worktree and its own agent. The sidebar on your left is the answer to “who needs me?”.",
    ],
  },

  projects: {
    id: "projects",
    title: "Where your code lives",
    step: "projects",
    counts: true,
    body: () => [
      "jmux works one repository at a time — a session, a worktree and an agent per piece of work.",
      "",
      "Tell it where to look and it will offer these when you press Ctrl-a n.",
    ],
  },

  agents: {
    id: "agents",
    title: "Letting jmux see your agents",
    step: "agents",
    counts: true,
    body: (status) =>
      status.steps.agents.state === "unavailable" && status.facts.agentsPresent.length === 0
        ? [
            "No coding agents found on this machine.",
            "",
            "jmux works fine without one: you drive tmux yourself and the sidebar shows sessions rather than agent status. Install Claude Code, Codex or pi and this page will have something to do.",
          ]
        : [
            "jmux can show RUNNING, WAITING and COMPLETE beside each session, so you can tell at a glance which agent is stuck waiting on you. That needs a small hook in each agent's own config.",
            "",
            "It also installs a skill, so agents inside jmux can drive sibling sessions themselves.",
          ],
  },

  tracker: {
    id: "tracker",
    title: "Connect your issue tracker",
    step: "tracker",
    counts: true,
    body: () => [
      "With a tracker connected your issues appear in the info panel, and you can start a session from one — branch, worktree and agent, all named after the ticket.",
      "",
      "Verified before it's saved, so a bad paste says so rather than sitting there looking connected.",
    ],
  },

  team: {
    id: "team",
    title: "Point a project at a team",
    step: "team",
    counts: true,
    body: () => [
      "An issue has to become a branch in a repository, and jmux needs to know which.",
      "",
      "Without this, starting work from an issue does nothing at all — the most common way a new setup looks broken.",
    ],
  },

  workflow: {
    id: "workflow",
    title: "How your work moves",
    step: "workflow",
    counts: true,
    body: (status) => [
      `Your tracker's statuses group into three stages, which drive the sidebar's bands and the info panel's tabs.`,
      "",
      status.steps.workflow.state === "satisfied"
        ? "Change these any time in the workflow screen — Ctrl-a W."
        : "Accept these to get started. Change them any time in the workflow screen — Ctrl-a W.",
    ],
  },

  done: {
    id: "done",
    title: "You're set up",
    counts: false,
    body: () => [],
  },
};

/**
 * The pages this visit shows, in order.
 *
 * An unavailable page is still emitted: silently dropping it would make
 * `Step 2 of 3` lie and would hide a fact the user needs. A page the intent
 * never asked for is simply absent, which is a different thing and needs no
 * explaining.
 */
export function pagesFor(intent: Intent, _status: SetupStatus): PageDef[] {
  if (intent === "manual") return [PAGES.welcome];
  const steps = intent === "tracker" ? TRACKER_STEPS : SOLO_STEPS;
  return [PAGES.welcome, ...steps.map((id) => PAGES[id]), PAGES.done];
}
```

- [ ] **Step 4: Run tests**

Run: `bun test src/__tests__/onboarding-pages.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/onboarding/pages.ts src/__tests__/onboarding-pages.test.ts
git commit -m "feat(onboarding): the page table, keyed on an intent that is never stored

A page the intent did not ask for is absent; a page it asked for that this
machine cannot satisfy is still shown, with prose saying why. Silently dropping
the second would make the step count lie."
```

---

### Task 8: The flow state machine

**Files:**
- Create: `src/onboarding/flow.ts`
- Test: `src/__tests__/onboarding-flow.test.ts`

**Interfaces:**
- Consumes: `Intent`, `PageId`, `pagesFor` (Task 7), `SetupStatus` (Task 6)
- Produces: `OnboardingFlow` class — `currentPage()`, `next()`, `back()`, `zoomOut()`, `chooseIntent()`, `setBusy()`, `isBusy()`, `stepLabel()`, `view()`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
import { deriveStatus, type SetupFacts } from "../onboarding/status";
import { OnboardingFlow } from "../onboarding/flow";

const facts: SetupFacts = {
  agentsPresent: ["Claude Code"], agentsStale: ["Claude Code"], skillCurrent: false,
  trackerType: "linear", trackerAuthed: false, trackerDeclined: false,
  projectCount: 0, attachedTeamCount: 0, workflowTabCount: 0, hunkInstalled: false,
};
const status = deriveStatus(facts);
const flow = () => new OnboardingFlow(status);

describe("OnboardingFlow", () => {
  test("starts on welcome, at the map only after an intent is chosen", () => {
    const f = flow();
    expect(f.view()).toBe("page");
    expect(f.currentPage().id).toBe("welcome");
  });

  test("choosing an intent moves to the first real page", () => {
    const f = flow();
    f.chooseIntent("solo");
    expect(f.currentPage().id).toBe("projects");
  });

  test("next advances even when the page is not satisfied", () => {
    const f = flow();
    f.chooseIntent("solo");
    expect(status.steps.projects.state).toBe("pending");
    f.next();
    expect(f.currentPage().id).toBe("agents");
  });

  test("next stops at the last page rather than wrapping", () => {
    const f = flow();
    f.chooseIntent("solo");
    f.next(); f.next(); f.next(); f.next();
    expect(f.currentPage().id).toBe("done");
  });

  test("back stops at the first page rather than wrapping", () => {
    const f = flow();
    f.chooseIntent("solo");
    f.back(); f.back();
    expect(f.currentPage().id).toBe("projects");
  });

  test("zoomOut goes to the map from a page, and closes from the map", () => {
    const f = flow();
    f.chooseIntent("solo");
    expect(f.zoomOut()).toBe("map");
    expect(f.view()).toBe("map");
    expect(f.zoomOut()).toBe("close");
  });

  test("manual intent goes straight to the map", () => {
    const f = flow();
    f.chooseIntent("manual");
    expect(f.view()).toBe("map");
  });

  test("openStep from the map lands on that page", () => {
    const f = flow();
    f.chooseIntent("solo");
    f.zoomOut();
    f.openStep("agents");
    expect(f.view()).toBe("page");
    expect(f.currentPage().id).toBe("agents");
  });

  test("step numbering counts only real steps", () => {
    const f = flow();
    f.chooseIntent("solo");
    expect(f.stepLabel()).toBe("Step 1 of 2");
    f.next();
    expect(f.stepLabel()).toBe("Step 2 of 2");
    f.next();
    expect(f.stepLabel()).toBeNull();
  });

  test("busy locks navigation and a duplicate action is ignored", () => {
    const f = flow();
    f.chooseIntent("solo");
    expect(f.beginAction()).toBe(true);
    expect(f.isBusy()).toBe(true);
    expect(f.beginAction()).toBe(false);
    f.next();
    expect(f.currentPage().id).toBe("projects");
    f.endAction();
    expect(f.isBusy()).toBe(false);
    f.next();
    expect(f.currentPage().id).toBe("agents");
  });

  test("a new status re-derives the page set without moving the cursor off its page", () => {
    const f = flow();
    f.chooseIntent("tracker");
    f.next(); f.next();
    expect(f.currentPage().id).toBe("tracker");
    f.setStatus(deriveStatus({ ...facts, trackerAuthed: true }));
    expect(f.currentPage().id).toBe("tracker");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/onboarding-flow.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/onboarding/flow.ts`:

```ts
import type { SetupStatus } from "./status";
import { pagesFor, type Intent, type PageDef, type PageId } from "./pages";

export type FlowView = "page" | "map";

/**
 * Where the user is, and what the keys are allowed to do.
 *
 * Two rules keep it from trapping anyone.
 *
 * **`next()` never requires completion.** Blocking advance on a satisfied page
 * is how a wizard becomes a hostage situation, and it is exactly what would
 * make "no tracker account today" unrecoverable. The map records what was
 * skipped and the finish page names it.
 *
 * **`zoomOut()` is one gesture with one meaning.** From a page it goes to the
 * map; from the map it closes. Not two different escapes.
 */
export class OnboardingFlow {
  private status: SetupStatus;
  private intent: Intent | null = null;
  private index = 0;
  private _view: FlowView = "page";
  private busy = false;

  constructor(status: SetupStatus) {
    this.status = status;
  }

  setStatus(status: SetupStatus): void {
    // The page *set* is re-derived, but the cursor stays on the page id it was
    // on. Re-deriving an index would move the user mid-read whenever a poll
    // changed what was true.
    const currentId = this.pages()[this.index]?.id;
    this.status = status;
    if (currentId) {
      const at = this.pages().findIndex((p) => p.id === currentId);
      if (at >= 0) this.index = at;
    }
    this.clamp();
  }

  getStatus(): SetupStatus { return this.status; }
  getIntent(): Intent | null { return this.intent; }
  view(): FlowView { return this._view; }
  isBusy(): boolean { return this.busy; }

  /** The pages this visit shows. Welcome only, until an intent is chosen. */
  pages(): PageDef[] {
    if (!this.intent) return pagesFor("manual", this.status);
    return pagesFor(this.intent, this.status);
  }

  currentPage(): PageDef {
    return this.pages()[this.index] ?? this.pages()[0]!;
  }

  chooseIntent(intent: Intent): void {
    this.intent = intent;
    if (intent === "manual") {
      // Nothing is configured and nothing is claimed — the map is the honest
      // landing place, and it is reachable rather than a dead end.
      this._view = "map";
      this.index = 0;
      return;
    }
    this._view = "page";
    this.index = 1; // past welcome
    this.clamp();
  }

  next(): void {
    if (this.busy) return;
    if (this.index < this.pages().length - 1) this.index += 1;
  }

  back(): void {
    if (this.busy) return;
    // Stops at the first real page rather than returning to the intent
    // question: re-asking it would silently discard the answer behind you.
    const floor = this.intent ? 1 : 0;
    if (this.index > floor) this.index -= 1;
  }

  /** `esc`. Returns what the caller should do. */
  zoomOut(): "map" | "close" {
    if (this.busy) return "map";
    if (this._view === "page" && this.intent) {
      this._view = "map";
      return "map";
    }
    return "close";
  }

  openStep(id: PageId): void {
    const at = this.pages().findIndex((p) => p.id === id);
    if (at < 0) return;
    this.index = at;
    this._view = "page";
  }

  /**
   * `Step N of M`, or null on a page that is not a step.
   *
   * Welcome and Done are excluded, so a three-step promise made on the welcome
   * page is the number the rail then counts down.
   */
  stepLabel(): string | null {
    const pages = this.pages();
    const counted = pages.filter((p) => p.counts);
    const here = pages[this.index];
    if (!here?.counts) return null;
    return `Step ${counted.indexOf(here) + 1} of ${counted.length}`;
  }

  /**
   * Claim the page's single async action.
   *
   * False means one is already running — a second Enter is ignored rather than
   * queued, so a double press cannot install twice or verify a token twice.
   */
  beginAction(): boolean {
    if (this.busy) return false;
    this.busy = true;
    return true;
  }

  endAction(): void { this.busy = false; }

  private clamp(): void {
    const max = this.pages().length - 1;
    if (this.index > max) this.index = Math.max(0, max);
    if (this.index < 0) this.index = 0;
  }
}
```

- [ ] **Step 4: Run tests**

Run: `bun test src/__tests__/onboarding-flow.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/onboarding/flow.ts src/__tests__/onboarding-flow.test.ts
git commit -m "feat(onboarding): the flow state machine

next() never requires completion, because blocking advance is what would make
'no tracker account today' unrecoverable. zoomOut() is one gesture with one
meaning: page to map, map to closed. A busy action locks navigation and ignores
a duplicate keypress rather than queueing it."
```

---

### Task 9: Port the deleted checklist's coverage

**Files:**
- Modify: `src/__tests__/onboarding-flow.test.ts`
- Delete: `src/setup-modal.ts`, `src/__tests__/setup-modal.test.ts`
- Modify: `src/main.ts` (remove the `SetupModal` import and `buildSetupRows`)

This task is separate so a reviewer can reject the deletion while accepting the
flow. It must not run before Task 12 leaves `main.ts` compiling — so it is
ordered here but its `main.ts` edits are the ones Task 12 performs. If executing
strictly in order, do Steps 1–2 here and defer Steps 3–5 until Task 12 lands.

**Interfaces:**
- Consumes: `OnboardingFlow` (Task 8)

- [ ] **Step 1: Port the behavioural assertions**

`setup-modal.test.ts` covers three behaviours worth keeping. Append to
`src/__tests__/onboarding-flow.test.ts`:

```ts
describe("ported from the setup checklist", () => {
  test("navigation never lands on a page that is not in the set", () => {
    const f = flow();
    f.chooseIntent("solo");
    for (let i = 0; i < 20; i++) f.next();
    expect(f.pages().map((p) => p.id)).toContain(f.currentPage().id);
    for (let i = 0; i < 20; i++) f.back();
    expect(f.pages().map((p) => p.id)).toContain(f.currentPage().id);
  });

  test("an inert page's action is refused rather than doing nothing visibly", () => {
    // The checklist refused Enter on done/blocked/unavailable rows. Here the
    // equivalent is that an unavailable page offers no action to claim.
    const noAgents = deriveStatus({ ...facts, agentsPresent: [], agentsStale: [] });
    const f = new OnboardingFlow(noAgents);
    f.chooseIntent("solo");
    f.next();
    expect(f.currentPage().id).toBe("agents");
    expect(noAgents.steps.agents.state).toBe("unavailable");
  });

  test("a declined tracker keeps the tracker arm's pages out of the solo set", () => {
    const declined = deriveStatus({ ...facts, trackerDeclined: true });
    const f = new OnboardingFlow(declined);
    f.chooseIntent("solo");
    expect(f.pages().map((p) => p.id)).not.toContain("tracker");
  });
});
```

- [ ] **Step 2: Run tests**

Run: `bun test src/__tests__/onboarding-flow.test.ts`
Expected: PASS.

- [ ] **Step 3: Delete the old modal (after Task 12)**

```bash
git rm src/setup-modal.ts src/__tests__/setup-modal.test.ts
```

- [ ] **Step 4: Verify nothing references it**

Run: `grep -rn "setup-modal\|SetupModal\|SetupRow\|buildSetupRows" src/ ; bun run typecheck && bun test`
Expected: no matches; typecheck clean; suite green.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(onboarding): delete the setup checklist

Its behavioural coverage — navigation staying inside the emitted set, an inert
step refusing its action, a declined tracker dropping its dependents — is
ported to the flow tests rather than lost."
```

---

### Task 10: Rendering

**Files:**
- Create: `src/onboarding/render.ts`
- Test: `src/__tests__/onboarding-render.test.ts`

**Interfaces:**
- Consumes: `OnboardingFlow` (Task 8), `cellWidth`/`createGrid`/`writeString`/`truncateToCols` from `src/cell-grid.ts`, `tokens`/`space`/`frame` from `src/chrome-tokens.ts`
- Produces: `renderFlow(flow, width, height): CellGrid`, `GLYPHS: readonly string[]`, `wrapProse(text, cols): string[]`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
import { cellWidth } from "../cell-grid";
import { deriveStatus, type SetupFacts } from "../onboarding/status";
import { OnboardingFlow } from "../onboarding/flow";
import { renderFlow, wrapProse, GLYPHS } from "../onboarding/render";

const facts: SetupFacts = {
  agentsPresent: ["Claude Code"], agentsStale: ["Claude Code"], skillCurrent: false,
  trackerType: "linear", trackerAuthed: false, trackerDeclined: false,
  projectCount: 0, attachedTeamCount: 0, workflowTabCount: 0, hunkInstalled: false,
};
const rows = (g: ReturnType<typeof renderFlow>) => g.map((r) => r.map((c) => c.char).join(""));

describe("onboarding render", () => {
  test("every glyph is exactly one column wide", () => {
    for (const g of GLYPHS) {
      expect([g, cellWidth(g.codePointAt(0)!)]).toEqual([g, 1]);
    }
  });

  test("the grid is exactly the requested size", () => {
    const f = new OnboardingFlow(deriveStatus(facts));
    const grid = renderFlow(f, 80, 24);
    expect(grid.length).toBe(24);
    for (const row of grid) expect(row.length).toBe(80);
  });

  test("no row overflows its width, at any size", () => {
    const f = new OnboardingFlow(deriveStatus(facts));
    f.chooseIntent("tracker");
    for (const w of [40, 61, 80, 120, 200]) {
      const grid = renderFlow(f, w, 24);
      for (const row of grid) expect(row.length).toBe(w);
    }
  });

  test("prose is capped at the measure even on a wide terminal", () => {
    const long = "word ".repeat(80).trim();
    for (const line of wrapProse(long, 200)) {
      expect(line.length).toBeLessThanOrEqual(64);
    }
  });

  test("wrapProse never splits a word", () => {
    expect(wrapProse("alpha beta gamma", 11)).toEqual(["alpha beta", "gamma"]);
  });

  test("the title appears on the page", () => {
    const f = new OnboardingFlow(deriveStatus(facts));
    f.chooseIntent("solo");
    expect(rows(renderFlow(f, 80, 24)).join("\n")).toContain("Where your code lives");
  });

  test("the step label appears on a counted page and not on welcome", () => {
    const f = new OnboardingFlow(deriveStatus(facts));
    expect(rows(renderFlow(f, 80, 24)).join("\n")).not.toContain("Step 1 of");
    f.chooseIntent("solo");
    expect(rows(renderFlow(f, 80, 24)).join("\n")).toContain("Step 1 of 2");
  });

  test("the action bar is on the last row whatever the height", () => {
    const f = new OnboardingFlow(deriveStatus(facts));
    f.chooseIntent("solo");
    for (const h of [14, 24, 50]) {
      const painted = rows(renderFlow(f, 80, h));
      expect(painted[h - 1]!).toContain("next");
    }
  });

  test("the map lists every step with a word, not a bare glyph", () => {
    const f = new OnboardingFlow(deriveStatus({ ...facts, projectCount: 2 }));
    f.chooseIntent("solo");
    f.zoomOut();
    const text = rows(renderFlow(f, 80, 24)).join("\n");
    expect(text).toContain("Where your code lives");
    expect(text).toContain("2 projects");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/onboarding-render.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/onboarding/render.ts`:

```ts
import type { CellGrid } from "../types";
import { createGrid, writeString, textCols, truncateToCols, type CellAttrs } from "../cell-grid";
import { tokens, space, frame } from "../chrome-tokens";
import type { OnboardingFlow } from "./flow";
import type { StepId } from "./status";

/**
 * Every glyph this surface paints.
 *
 * Enumerated so a test can assert each is width-1 under `cellWidth`. The
 * lesson is on record: a glyph whose width varies between terminals desynchs
 * the frame's column model from the real cursor and leaves ghost gaps.
 */
export const GLYPHS = ["✓", "▸", "━", "─", "·", "•"] as const;

const CHECK = GLYPHS[0];
const CURSOR = GLYPHS[1];
const RAIL_FILLED = GLYPHS[2];
const RAIL_AHEAD = GLYPHS[3];

/** Left inset for everything on the page. */
const INSET = 3;
/** Rows the action bar and its hairline always own at the bottom. */
export const BOTTOM_RESERVED_ROWS = 2;

/**
 * Wrap to the prose measure.
 *
 * Capped at `space.measure` regardless of the surface's width: long lines are
 * the fastest way to make a terminal read as a log, and a 200-column paragraph
 * is unreadable however much room there is for it.
 */
export function wrapProse(text: string, cols: number): string[] {
  const measure = Math.max(20, Math.min(cols, space.measure));
  if (text.length === 0) return [""];
  const out: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    if (line.length === 0) { line = word; continue; }
    if (textCols(`${line} ${word}`) > measure) { out.push(line); line = word; }
    else line = `${line} ${word}`;
  }
  if (line.length > 0) out.push(line);
  return out;
}

function attrs(): {
  title: CellAttrs; body: CellAttrs; dim: CellAttrs; ok: CellAttrs; rail: CellAttrs;
} {
  return {
    title: { ...tokens.accent, bold: true },
    body: { ...tokens.textPrimary },
    dim: { ...tokens.textTertiary },
    ok: { ...tokens.affirmative },
    rail: { ...tokens.accent },
  };
}

function paintActionBar(grid: CellGrid, width: number, height: number, hints: string): void {
  const a = attrs();
  const ruleRow = height - BOTTOM_RESERVED_ROWS;
  if (ruleRow >= 0) {
    writeString(grid, ruleRow, INSET, frame.ruleLight.repeat(Math.max(0, width - INSET * 2)), a.dim);
  }
  writeString(grid, height - 1, INSET, truncateToCols(hints, Math.max(1, width - INSET - 1)), a.dim);
}

function paintRail(grid: CellGrid, width: number, label: string | null): void {
  if (!label) return;
  const a = attrs();
  const text = label;
  const x = Math.max(INSET, width - INSET - textCols(text));
  writeString(grid, 0, x, text, a.dim);
}

/**
 * Paint the flow.
 *
 * `height` is honoured exactly — the action bar is bottom-pinned through
 * `BOTTOM_RESERVED_ROWS`, which the scroll clamp reads too, so a hint line can
 * never move as the cursor travels.
 */
export function renderFlow(flow: OnboardingFlow, width: number, height: number): CellGrid {
  const grid = createGrid(width, height);
  const a = attrs();

  if (flow.view() === "map") {
    writeString(grid, 0, INSET, "Set up jmux", a.title);
    writeString(grid, 0, Math.max(INSET, width - INSET - 8), "overview", a.dim);

    const status = flow.getStatus();
    const shown: Array<[StepId, string]> = [
      ["projects", "Where your code lives"],
      ["agents", "Letting jmux see your agents"],
      ["tracker", "Connect an issue tracker"],
    ];
    let y = 2;
    for (const [id, label] of shown) {
      if (y >= height - BOTTOM_RESERVED_ROWS) break;
      const st = status.steps[id];
      // One glyph, one meaning: a tick is done, its absence is not done, and
      // the right-hand column says what that amounts to in words. Nothing here
      // needs a legend.
      if (st.state === "satisfied") writeString(grid, y, INSET, CHECK, a.ok);
      writeString(grid, y, INSET + 4, truncateToCols(label, Math.max(1, width - INSET - 24)), a.body);
      const summary = truncateToCols(st.summary, 18);
      const sx = Math.max(INSET + 4, width - INSET - textCols(summary));
      writeString(grid, y, sx, summary, a.dim);
      y += 1;
    }
    paintActionBar(grid, width, height, "↑↓ move   ↵ open   esc close");
    return grid;
  }

  const page = flow.currentPage();
  writeString(grid, 0, INSET, truncateToCols(page.title, Math.max(1, width - INSET * 2 - 14)), a.title);
  paintRail(grid, width, flow.stepLabel());

  writeString(grid, 1, INSET, frame.ruleLight.repeat(Math.max(0, textCols(page.title))), a.dim);

  let y = 3;
  for (const para of page.body(flow.getStatus())) {
    for (const line of wrapProse(para, width - INSET * 2)) {
      if (y >= height - BOTTOM_RESERVED_ROWS) break;
      writeString(grid, y, INSET, line, a.body);
      y += 1;
    }
  }

  const hints = page.id === "welcome"
    ? "↑↓ choose   ↵ start"
    : page.id === "done"
      ? "↵ start your first session      esc close"
      : "→ next   ← back   esc overview";
  paintActionBar(grid, width, height, hints);
  return grid;
}
```

Note the unused imports (`CURSOR`, `RAIL_FILLED`, `RAIL_AHEAD`) are consumed in Task 11's interactive blocks; if `tsc` flags them before then, keep them referenced via `GLYPHS` only and reintroduce the named constants in Task 11.

- [ ] **Step 4: Run tests**

Run: `bun test src/__tests__/onboarding-render.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/onboarding/render.ts src/__tests__/onboarding-render.test.ts
git commit -m "feat(onboarding): rendering, with the glyph set asserted width-1

Prose caps at the measure whatever the terminal's width, and the action bar is
bottom-pinned through a constant the scroll clamp reads too, so a hint line can
never move as the cursor travels."
```

---

### Task 11: The composite modal

**Files:**
- Create: `src/onboarding/modal.ts`
- Test: `src/__tests__/onboarding-modal.test.ts`

**Interfaces:**
- Consumes: `OnboardingFlow`, `renderFlow`, `Modal`/`ModalAction` from `src/modal.ts`, `InputModal`, `ListModal`
- Produces: `OnboardingModal implements Modal`, `OnboardingPort`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
import { deriveStatus, type SetupFacts } from "../onboarding/status";
import { OnboardingModal, type OnboardingPort } from "../onboarding/modal";

const facts: SetupFacts = {
  agentsPresent: ["Claude Code"], agentsStale: ["Claude Code"], skillCurrent: false,
  trackerType: "linear", trackerAuthed: false, trackerDeclined: false,
  projectCount: 0, attachedTeamCount: 0, workflowTabCount: 0, hunkInstalled: false,
};

function port(over: Partial<OnboardingPort> = {}): OnboardingPort {
  return {
    getStatus: () => deriveStatus(facts),
    installAgents: async () => [],
    addProjectDir: async () => {},
    connectTracker: async () => ({ ok: true }),
    seedWorkflow: () => {},
    finish: () => {},
    agentWriteTargets: () => ["~/.claude/settings.json"],
    ...over,
  };
}

describe("OnboardingModal", () => {
  test("implements the Modal surface", () => {
    const m = new OnboardingModal(port());
    m.open();
    expect(m.isOpen()).toBe(true);
    expect(typeof m.preferredWidth(120)).toBe("number");
    expect(m.getGrid(80).length).toBeGreaterThan(0);
    expect(m.getCursorPosition()).toBeNull();
  });

  test("survives resize instead of being closed", () => {
    const m = new OnboardingModal(port());
    m.open();
    expect(typeof m.onResize).toBe("function");
    m.onResize!(100, 40);
    expect(m.isOpen()).toBe(true);
  });

  test("a hosted collector receives input instead of the flow", () => {
    const m = new OnboardingModal(port());
    m.open();
    m.handleInput("\r");        // choose the highlighted intent
    m.handleInput("\r");        // projects page: open the directory collector
    expect(m.hasChild()).toBe(true);
    m.handleInput("x");
    expect(m.childValue()).toBe("x");
  });

  test("esc pops the collector rather than closing the flow", () => {
    const m = new OnboardingModal(port());
    m.open();
    m.handleInput("\r");
    m.handleInput("\r");
    expect(m.hasChild()).toBe(true);
    expect(m.handleInput("\x1b")).toEqual({ type: "consumed" });
    expect(m.hasChild()).toBe(false);
    expect(m.isOpen()).toBe(true);
  });

  test("esc from a page goes to the map, and from the map closes", () => {
    const m = new OnboardingModal(port());
    m.open();
    m.handleInput("\r");
    expect(m.handleInput("\x1b")).toEqual({ type: "consumed" });
    expect(m.handleInput("\x1b")).toEqual({ type: "closed" });
    expect(m.isOpen()).toBe(false);
  });

  test("a duplicate action while busy does not run twice", async () => {
    let calls = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const m = new OnboardingModal(port({
      installAgents: async () => { calls += 1; await gate; return []; },
    }));
    m.open();
    m.handleInput("\r");    // solo
    m.handleInput("\x1b[C"); // next -> agents
    m.handleInput("\r");
    m.handleInput("\r");
    expect(calls).toBe(1);
    release();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/onboarding-modal.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/onboarding/modal.ts`. The essential structure:

```ts
import type { CellGrid } from "../types";
import type { Modal, ModalAction } from "../modal";
import type { InstallReport } from "../agent-hooks/registry";
import { InputModal } from "../input-modal";
import { OnboardingFlow } from "./flow";
import { renderFlow } from "./render";
import type { SetupStatus } from "./status";
import type { Intent } from "./pages";

/**
 * Everything the flow needs from the world, injected so the modal itself knows
 * nothing about config, adapters or tmux — the same boundary GhostPreviewPort
 * draws.
 */
export interface OnboardingPort {
  getStatus(): SetupStatus;
  installAgents(): Promise<InstallReport[]>;
  addProjectDir(dir: string): Promise<void>;
  connectTracker(token: string): Promise<{ ok: boolean }>;
  seedWorkflow(): void;
  /** Close and hand off to the existing new-session flow. */
  finish(): void;
  agentWriteTargets(): string[];
}

const INTENTS: Intent[] = ["solo", "tracker", "manual"];

/**
 * The onboarding flow, as one composite modal.
 *
 * It owns its child collectors directly rather than calling `openModal()`,
 * which is the whole reason the flow can collect a token or a path without
 * destroying itself: `activeModal` is a single slot, so a modal that opens
 * another modal is evicted by it. `NewSessionModal` established this pattern.
 */
export class OnboardingModal implements Modal {
  private _open = false;
  private flow: OnboardingFlow;
  private readonly port: OnboardingPort;
  private child: InputModal | null = null;
  private intentIndex = 0;
  private termRows = 24;
  private lastReports: InstallReport[] = [];

  constructor(port: OnboardingPort) {
    this.port = port;
    this.flow = new OnboardingFlow(port.getStatus());
  }

  open(): void {
    this._open = true;
    this.flow = new OnboardingFlow(this.port.getStatus());
    this.child = null;
    this.intentIndex = 0;
  }

  close(): void { this._open = false; this.child = null; }
  isOpen(): boolean { return this._open; }

  /** Re-read the world without moving the cursor. */
  refresh(): void { this.flow.setStatus(this.port.getStatus()); }

  preferredWidth(termCols: number): number {
    return Math.min(Math.max(56, Math.round(termCols * 0.7)), 84);
  }

  getCursorPosition(): { row: number; col: number } | null {
    return this.child ? this.child.getCursorPosition() : null;
  }

  /** Opted in, so a window drag does not discard the flow. */
  onResize(_cols: number, rows: number): void { this.termRows = rows; }

  getGrid(width: number): CellGrid {
    if (this.child) return this.child.getGrid(width);
    return renderFlow(this.flow, width, this.height());
  }

  private height(): number {
    return Math.max(12, Math.min(this.termRows - 6, 26));
  }

  // Test seams.
  hasChild(): boolean { return this.child !== null; }
  childValue(): string { return this.child ? this.child.getValue() : ""; }

  handleInput(data: string): ModalAction {
    // A live collector owns every key, exactly as NewSessionModal delegates to
    // currentInner. Esc pops it rather than closing the flow.
    if (this.child) {
      if (data === "\x1b") { this.child = null; return { type: "consumed" }; }
      const action = this.child.handleInput(data);
      if (action.type === "result") {
        const value = String(action.value ?? "");
        this.child = null;
        void this.commitChild(value);
      }
      return { type: "consumed" };
    }

    if (data === "\x1b") {
      return this.flow.zoomOut() === "close"
        ? (this.close(), { type: "closed" })
        : { type: "consumed" };
    }

    if (this.flow.currentPage().id === "welcome") {
      if (data === "\x1b[A" || data === "k") {
        this.intentIndex = (this.intentIndex + INTENTS.length - 1) % INTENTS.length;
        return { type: "consumed" };
      }
      if (data === "\x1b[B" || data === "j") {
        this.intentIndex = (this.intentIndex + 1) % INTENTS.length;
        return { type: "consumed" };
      }
      if (data === "\r") {
        this.flow.chooseIntent(INTENTS[this.intentIndex]!);
        return { type: "consumed" };
      }
      return { type: "consumed" };
    }

    if (data === "\x1b[C") { this.flow.next(); return { type: "consumed" }; }
    if (data === "\x1b[D") { this.flow.back(); return { type: "consumed" }; }
    if (data === "\r") { void this.activate(); return { type: "consumed" }; }
    return { type: "consumed" };
  }

  private async commitChild(value: string): Promise<void> {
    const page = this.flow.currentPage().id;
    if (!this.flow.beginAction()) return;
    try {
      if (page === "projects") await this.port.addProjectDir(value);
      else if (page === "tracker") await this.port.connectTracker(value);
    } finally {
      this.flow.endAction();
      this.refresh();
    }
  }

  private async activate(): Promise<void> {
    const page = this.flow.currentPage().id;

    if (page === "projects") {
      this.child = new InputModal({ header: "Add a directory", placeholder: "~/Code" });
      this.child.open();
      return;
    }
    if (page === "tracker") {
      this.child = new InputModal({ header: "Paste your token", secret: true });
      this.child.open();
      return;
    }
    if (page === "workflow") { this.port.seedWorkflow(); this.refresh(); return; }
    if (page === "done") { this.port.finish(); this.close(); return; }
    if (page === "agents") {
      if (!this.flow.beginAction()) return;
      try {
        this.lastReports = await this.port.installAgents();
      } finally {
        this.flow.endAction();
        this.refresh();
      }
    }
  }

  getLastReports(): InstallReport[] { return this.lastReports; }
}
```

`InputModal` needs a `getValue()` accessor for the test seam — add it:

```ts
  /** The current buffer. Exposed so a hosting modal can render or inspect it. */
  getValue(): string { return this.value; }
```

- [ ] **Step 4: Run tests**

Run: `bun test src/__tests__/onboarding-modal.test.ts && bun run typecheck && bun test`
Expected: PASS, suite green.

- [ ] **Step 5: Commit**

```bash
git add src/onboarding/modal.ts src/input-modal.ts src/__tests__/onboarding-modal.test.ts
git commit -m "feat(onboarding): the composite modal

It owns its collectors directly rather than calling openModal(), which is why
the flow can take a token or a path without destroying itself — activeModal is
one slot, so a modal that opens a modal is evicted by it."
```

---

### Task 12: Wire it into main.ts

**Files:**
- Modify: `src/main.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–11

- [ ] **Step 1: Build the facts, above first use**

Replace `buildSetupRows()` (`main.ts:6171`) with a facts builder. It must be
declared above `setupStepsOutstanding()`'s first call from `makeToolbar` — the
temporal-dead-zone hazard. Place it immediately before `setupStepsOutstanding`
(`main.ts:1140`):

```ts
function buildSetupFacts(): SetupFacts {
  const present = AGENT_INTEGRATIONS.filter((a) => a.isPresent());
  const projects = (configStore.config.projects ?? []).filter((p) => p.deletedAt === undefined);
  const tracker = adapters.issueTracker;
  return {
    agentsPresent: present.map((a) => a.label),
    agentsStale: present.filter((a) => a.detect() !== "current").map((a) => a.label),
    skillCurrent: (() => {
      const s = detectSkill(shippedSkill());
      return s === "current" || s === "symlink";
    })(),
    trackerType: tracker?.type ?? null,
    trackerAuthed: tracker?.authState === "ok",
    trackerDeclined: configStore.config.setup?.tracker === "never",
    projectCount: projects.length,
    attachedTeamCount: projects.filter((p) => p.teamId !== undefined).length,
    workflowTabCount: panelViews.filter((v) => v.source === "issues" && (v.states?.length ?? 0) > 0).length,
    hunkInstalled: Bun.which(hunkCommand) !== null,
  };
}
```

Rewrite `setupStepsOutstanding()` to read it, keeping the 5s cache:

```ts
function setupStepsOutstanding(): boolean {
  const now = Date.now();
  if (setupOutstandingCache && now - setupOutstandingCache.at < SETUP_OUTSTANDING_TTL_MS) {
    return setupOutstandingCache.value;
  }
  let value = false;
  try {
    value = deriveStatus(buildSetupFacts()).outstanding;
  } catch {
    value = false;
  }
  setupOutstandingCache = { at: now, value };
  return value;
}
```

- [ ] **Step 2: Replace the setup modal**

Delete `const setupModal = new SetupModal({...})` (`main.ts:6318`) and the
`DECLINABLE` map above it. Replace `openSetup()` (`main.ts:6415`):

```ts
const onboarding = new OnboardingModal({
  getStatus: () => deriveStatus(buildSetupFacts()),
  agentWriteTargets: () =>
    AGENT_INTEGRATIONS.filter((a) => a.isPresent()).flatMap((a) => a.writeTargets()),
  installAgents: async () => [...installAllAgents(), ...installSkills()],
  addProjectDir: async (dir) => {
    const path = expandHome(dir.trim());
    if (!path || !existsSync(path)) {
      showToast(`No such directory: ${dir}`);
      return;
    }
    const dirs = configStore.config.projectDirs ?? [];
    if (!dirs.includes(path)) configStore.set({ projectDirs: [...dirs, path] });
    await adoptProjectsUnder(path);
  },
  connectTracker: async (token) => {
    const type = adapters.issueTracker?.type ?? configStore.config.adapters?.issueTracker?.type ?? "linear";
    const result = await applyTrackerCredential({
      type,
      token,
      readCredential: (t) => readCredential(t),
      writeCredential: (t, v) => writeCredential(t, v),
      persistType: (t) => configStore.set({
        adapters: { ...configStore.config.adapters, issueTracker: { type: t } },
      }),
      verify: async () => await swapAdapters(configStore.config.adapters ?? {}),
    });
    if (!result.ok) showToast("That token was rejected — nothing was changed");
    return result;
  },
  seedWorkflow: () => {
    panelViews = suggestLayout(cachedWorkflowStates, panelViews);
    configStore.set({ panelViews });
  },
  finish: () => {
    closeModal();
    openNewSessionModal();
  },
});

function openSetup(): void {
  if (activeModal) closeModal();
  onboarding.onResize(process.stdout.columns || 80, process.stdout.rows || 24);
  onboarding.open();
  openModal(onboarding, () => {});
}
```

- [ ] **Step 3: Add `adoptProjectsUnder`**

Below `openSetup`, using the existing project-dirs scan:

```ts
/**
 * Adopt every repository under `dir` as a Project.
 *
 * Project dirs are scan roots; `attach a team` operates on `ProjectConfig`,
 * which a scan root cannot supply — so a page that wrote only the root left
 * the tracker arm with nothing to attach to.
 */
async function adoptProjectsUnder(dir: string): Promise<void> {
  const found = await scanProjectDirs([dir]);
  const existing = configStore.config.projects ?? [];
  const known = new Set(existing.map((p) => p.dir));
  const added = found
    .filter((f) => !known.has(f.dir))
    .map((f) => ({ id: crypto.randomUUID(), title: basename(f.dir), dir: f.dir }));
  if (added.length > 0) configStore.set({ projects: [...existing, ...added] });
}
```

If `scanProjectDirs` does not exist under that name, use whichever function the
project-dirs setting already calls to list repositories under a root — grep for
the implementation behind the `setting-project-dirs` palette action and reuse it
rather than writing a second scanner.

- [ ] **Step 4: Verify**

Run: `bun run typecheck && bun test`
Expected: typecheck clean, suite green. Then boot it:

Run: `HOME=$(mktemp -d) timeout 10 bun run dev` and confirm it starts without crashing.

- [ ] **Step 5: Commit**

```bash
git add src/main.ts
git commit -m "feat(onboarding): wire the flow in and retire the checklist

The facts builder is declared above its first call from makeToolbar, which is
the temporal-dead-zone hazard first run is exactly where it bites.

Adding a directory now adopts the repositories under it as Projects, not just
the scan root: attaching a team operates on ProjectConfig, so writing only the
root left the tracker arm with nothing to attach to."
```

---

### Task 13: The pre-TUI dependency gate

**Files:**
- Modify: `src/main.ts` (the dependency gate near `main.ts:919`)

Copy only. It must stay plain `console.log` — on a clean machine it may need to
install tmux before jmux can run at all, and there is no alt screen yet.

- [ ] **Step 1: Rewrite the copy**

Replace the missing-dependency block's text so it reads as step zero of one
flow rather than an error:

```ts
  console.log(`\nWelcome to jmux.\n`);
  console.log(`It runs several coding agents at once, each in its own tmux`);
  console.log(`session — so it needs ${missing.join(" and ")} before it can start.\n`);
  console.log(`  ${installCmd}\n`);
```

and the prompt:

```ts
  process.stdout.write("Install now, and jmux will pick up where it left off? [Y/n] ");
```

and the failure:

```ts
    console.error(`\nThat didn't work. Install ${missing.join(" and ")} yourself and run jmux again.`);
```

- [ ] **Step 2: Verify on a clean machine**

Run: `bun run docker`
Expected: the gate prints the new copy, and the install path still completes and
starts jmux.

- [ ] **Step 3: Commit**

```bash
git add src/main.ts
git commit -m "feat(onboarding): the dependency gate reads as step zero, not an error

Still plain stdout — there is no alt screen yet, and on a clean machine this
may have to install tmux before jmux can run at all."
```

---

### Task 14: Prove no subprocess output reaches the frame

**Files:**
- Create: `src/__tests__/onboarding-integration.test.ts`

**Interfaces:**
- Consumes: the boot harness pattern from `src/__tests__/boot-smoke.test.ts`

- [ ] **Step 1: Write the test**

```ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Escape sequences go in a SINGLE write: byte-by-byte makes a lone \x1b read
// as Escape and the flow closes instead of navigating.
const RIGHT = "\x1b[C";

describe("onboarding integration", () => {
  test("no installer output reaches the rendered frame", async () => {
    const home = mkdtempSync(join(tmpdir(), "jmux-onboard-"));
    const { boot } = await import("./helpers/boot");   // same harness as boot-smoke
    const session = await boot({ env: { HOME: home } });
    try {
      await session.waitForText("Run several coding agents at once", 8000);

      session.write("\r");                 // choose "Just run agents"
      await session.waitForText("Where your code lives", 4000);

      session.write(RIGHT);                // to the agents page
      await session.waitForText("Letting jmux see your agents", 4000);

      session.write("\r");                 // install
      await session.settle(3000);

      const frame = session.frameText();
      for (const leak of [
        "jmux-control skill:",
        "hunk-review skill:",
        "hunk not found",
        "Agents running inside jmux can now discover",
        "installed to /",
      ]) {
        expect(frame).not.toContain(leak);
      }
    } finally {
      await session.dispose();
    }
  }, 40_000);

  test("a resize mid-token does not discard the flow", async () => {
    const home = mkdtempSync(join(tmpdir(), "jmux-onboard-"));
    const { boot } = await import("./helpers/boot");
    const session = await boot({ env: { HOME: home } });
    try {
      await session.waitForText("Run several coding agents at once", 8000);
      session.write("\x1b[B\r");           // "Agents, wired to my issue tracker"
      session.write(RIGHT); session.write(RIGHT);
      await session.waitForText("Connect your issue tracker", 4000);
      session.write("\r");
      session.write("abc");
      await session.resize(100, 32);
      await session.settle(1000);
      expect(session.frameText()).toContain("Paste your token");
    } finally {
      await session.dispose();
    }
  }, 40_000);
});
```

- [ ] **Step 2: Adapt to the real harness**

`boot-smoke.test.ts` is the reference. If it has no reusable `boot` helper,
extract one into `src/__tests__/helpers/boot.ts` from its existing pty +
`@xterm/headless` setup — do not write a second harness. It needs
`waitForText`, `write`, `resize`, `settle`, `frameText`, `dispose`.

- [ ] **Step 3: Run it**

Run: `bun test src/__tests__/onboarding-integration.test.ts`
Expected: PASS. If it fails on leaked text, that is the regression this whole
plan exists to fix — fix the caller, never the assertion.

- [ ] **Step 4: Full verification**

Run in order, capture real output for the completion report:

```bash
bun run typecheck
bun test
bun run docker
```

- [ ] **Step 5: Screenshots**

Drive a real client and capture every page: welcome, projects, agents (all three
states), tracker, team, workflow, done, map. A UI change is verified by looking
at it — unit tests cannot see a corrupted frame.

- [ ] **Step 6: Commit**

```bash
git add src/__tests__/
git commit -m "test(onboarding): assert no subprocess output reaches the frame

The regression that started this is invisible to every unit test either side of
it, so it is asserted at the boundary where it actually happens: a real pty, a
real frame, and the literal strings the installer used to print."
```

---

## Self-Review

**Spec coverage.** Every numbered spec section maps to a task: §1.1/§3 → Task 11; §3.2 → Task 3; §4 → Tasks 6, 12; §5 → Task 9; §6/§7 → Task 7; §8 → Task 12 Step 3; §9 → Tasks 7, 8; §10 → Task 8; §11 → Task 8 (`beginAction`); §12 copy → Tasks 7, 10, 11; §12.4 write-list → Task 4; §13 → Task 1; §14 → Task 5; §15 → Task 2; §17 hazards → Tasks 10 (glyphs), 12 (TDZ); §18 → Task 14.

**Known gaps to resolve during execution, not guesses to make now:**
- Task 12 Step 3 names `scanProjectDirs`; the real function behind the
  `setting-project-dirs` action must be found and reused rather than duplicated.
- Task 12's `expandHome`, `readCredential`, `openNewSessionModal`,
  `cachedWorkflowStates` and `hunkCommand` are existing `main.ts` bindings —
  confirm each name before use.
- The team page (§12.5) has no interactive implementation task. It renders
  prose and its `↵` is inert in Task 11. **Add its `ListModal` wiring as a
  follow-up task once the routing shape is confirmed**, rather than inventing
  a `teamId` mutation path here.

**Type consistency:** `InstallReport` is used throughout (Tasks 1, 11, 12) — no
parallel `SkillReport`. `SetupFacts`/`SetupStatus`/`StepId` are defined in Task
6 and consumed unchanged in 7, 8, 10, 11, 12. `Intent`/`PageId`/`PageDef` are
defined in Task 7 and consumed in 8, 10, 11.
