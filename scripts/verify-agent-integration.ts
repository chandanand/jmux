#!/usr/bin/env bun
/**
 * End-to-end verification that each agent actually drives jmux's state options.
 *
 * The unit tests cover the emitter text, the installer and the rollup. They
 * cannot cover the one link that matters most: whether a real agent, running in
 * a real pane, actually invokes the emitter when its state changes. That link
 * spans two projects and breaks silently — an upstream rename of a hook event
 * would leave every test green and the sidebar blank.
 *
 * So this drives the real binaries: an isolated tmux server, a sandboxed config
 * home (never the user's), and a trivial prompt.
 *
 * It runs each hook-based agent in **two phases**, because a one-shot run is
 * over in seconds and `Stop` → `SessionEnd` fire back to back:
 *
 *   turn      — SessionEnd suppressed, so `complete` survives long enough to
 *               observe. Proves the turn lifecycle: running → complete.
 *   teardown  — full install. Proves SessionEnd clears state on exit.
 *
 * Without the split, `complete` exists for under 25ms and no sampler can catch
 * it — which looks identical to a broken Stop hook.
 *
 * Usage:
 *   bun run scripts/verify-agent-integration.ts [claude|codex|pi|all]
 *
 * Costs one trivial model call per phase, so this is a manual gate rather than
 * part of `bun test`.
 */

import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { AgentState } from "../src/types";

const SOCKET = `jmux-verify-${process.pid}`;
const PROMPT = "Reply with exactly: OK";

interface AgentPlan {
  id: "claude" | "codex" | "pi";
  label: string;
  env(sandbox: string): Record<string, string>;
  command(sandbox: string): string;
  /** Extra setup before install (config files the agent expects to exist). */
  prepare?(sandbox: string): void;
  /** Copy credentials in — a sandboxed agent exits before firing any hook. */
  credentials?(sandbox: string): [from: string, to: string];
  /** A file the install MUST create inside the sandbox, proving isolation held. */
  installMarker(sandbox: string): string;
  /** Remove the clear-on-exit hook so `complete` is observable. */
  suppressSessionEnd?(sandbox: string): void;
  /** States the `turn` phase should demonstrate. */
  expect: AgentState[];
  /** Whether a teardown phase applies (agent has a clear-on-exit hook). */
  checksTeardown: boolean;
  timeout: number;
  caveat?: string;
}

function tmux(args: string[]): { ok: boolean; out: string } {
  const p = Bun.spawnSync(["tmux", "-L", SOCKET, ...args], { stdout: "pipe", stderr: "pipe" });
  return { ok: (p.exitCode ?? 1) === 0, out: p.stdout.toString().trim() };
}

function stripSessionEndFromJson(path: string): void {
  const doc = JSON.parse(readFileSync(path, "utf-8")) as { hooks?: Record<string, unknown> };
  delete doc.hooks?.SessionEnd;
  writeFileSync(path, JSON.stringify(doc, null, 2));
}

const PLANS: AgentPlan[] = [
  {
    id: "claude",
    label: "Claude Code",
    env: (sb) => ({ CLAUDE_CONFIG_DIR: resolve(sb, "claude") }),
    command: (sb) => `CLAUDE_CONFIG_DIR=${resolve(sb, "claude")} claude -p ${JSON.stringify(PROMPT)}`,
    credentials: (sb) => [
      resolve(process.env.HOME ?? "", ".claude", ".credentials.json"),
      resolve(sb, "claude", ".credentials.json"),
    ],
    installMarker: (sb) => resolve(sb, "claude", "settings.json"),
    suppressSessionEnd: (sb) => stripSessionEndFromJson(resolve(sb, "claude", "settings.json")),
    expect: ["running", "complete"],
    checksTeardown: true,
    timeout: 120,
  },
  {
    id: "codex",
    label: "Codex CLI",
    env: (sb) => ({ CODEX_HOME: resolve(sb, "codex") }),
    prepare: (sb) => {
      mkdirSync(resolve(sb, "codex"), { recursive: true });
      writeFileSync(resolve(sb, "codex", "config.toml"), "");
    },
    // Hook trust is normally an interactive approval. This sandbox runs hooks
    // jmux itself just wrote, which is exactly the "automation that already vets
    // hook sources" case the flag documents. The installer never does this.
    command: (sb) =>
      `CODEX_HOME=${resolve(sb, "codex")} codex exec --dangerously-bypass-hook-trust ${JSON.stringify(PROMPT)}`,
    credentials: (sb) => [
      resolve(process.env.HOME ?? "", ".codex", "auth.json"),
      resolve(sb, "codex", "auth.json"),
    ],
    installMarker: (sb) => resolve(sb, "codex", "hooks.json"),
    suppressSessionEnd: (sb) => stripSessionEndFromJson(resolve(sb, "codex", "hooks.json")),
    expect: ["running", "complete"],
    checksTeardown: true,
    timeout: 120,
  },
  {
    id: "pi",
    label: "pi",
    env: (sb) => ({ HOME: sb }),
    prepare: (sb) => mkdirSync(resolve(sb, ".pi", "agent"), { recursive: true }),
    installMarker: (sb) => resolve(sb, ".config", "jmux", "pi-extension.ts"),
    // -e loads the shipped extension directly, proving the file loads and its
    // handlers fire without depending on settings registration.
    command: (sb) =>
      `HOME=${sb} pi -e ${resolve(sb, ".config", "jmux", "pi-extension.ts")} -p ${JSON.stringify(PROMPT)}`,
    expect: ["complete"],
    checksTeardown: false,
    timeout: 90,
  },
];

interface PhaseResult {
  observed: string[];
  kind: string;
  finalState: string;
  /** Set when the agent could not run at all (e.g. no usable credentials). */
  blocked: string | null;
}

/**
 * An agent that cannot authenticate never takes a turn, so Stop never fires and
 * the run looks identical to a broken hook. Detect it and report a skip — a
 * false FAIL here would send someone hunting a bug that does not exist.
 *
 * Claude Code is the usual case: its real credentials live in the macOS
 * Keychain, so the `.credentials.json` copied into a sandbox is often stale.
 */
const BLOCKED_PATTERNS = [
  /Failed to authenticate[^\n]*/i,
  /OAuth session expired[^\n]*/i,
  /Not logged in[^\n]*/i,
  /Please run \/login[^\n]*/i,
  /invalid[_ ]api[_ ]key[^\n]*/i,
];

function detectBlocked(paneText: string): string | null {
  for (const re of BLOCKED_PATTERNS) {
    const m = paneText.match(re);
    if (m) return m[0].trim();
  }
  return null;
}

async function runPhase(plan: AgentPlan, suppressSessionEnd: boolean): Promise<PhaseResult> {
  const sandbox = mkdtempSync(resolve(tmpdir(), `jmux-verify-${plan.id}-`));
  const observed: string[] = [];
  let kind = "";

  try {
    plan.prepare?.(sandbox);

    // Install in a CHILD process with the sandbox env applied at spawn.
    // Mutating process.env in-process is not enough: Bun's os.homedir() does not
    // observe a runtime change to HOME, so an in-process install silently
    // resolves to the real home and writes the user's actual config.
    const install = Bun.spawnSync(
      ["bun", "-e", `const {integrationFor} = await import(${JSON.stringify(resolve(import.meta.dir, "../src/agent-hooks/registry.ts"))}); integrationFor(${JSON.stringify(plan.id)}).install();`],
      { env: { ...process.env, ...plan.env(sandbox) }, stdout: "pipe", stderr: "pipe" },
    );
    if ((install.exitCode ?? 1) !== 0) {
      throw new Error(`install failed: ${install.stderr.toString().trim()}`);
    }

    // Guard: prove the install landed inside the sandbox. Without this, a
    // sandboxing bug degrades into silently verifying the user's real config.
    const marker = plan.installMarker(sandbox);
    if (!existsSync(marker)) {
      throw new Error(`install escaped the sandbox — expected ${marker}`);
    }

    const creds = plan.credentials?.(sandbox);
    if (creds) await Bun.$`cp ${creds[0]} ${creds[1]}`.quiet().nothrow();
    if (suppressSessionEnd) plan.suppressSessionEnd?.(sandbox);

    tmux(["new-session", "-d", "-s", plan.id, "-x", "100", "-y", "30"]);
    const pane = tmux(["list-panes", "-t", plan.id, "-F", "#{pane_id}"]).out.split("\n")[0];
    // The marker is split so the *typed* command line does not contain it —
    // capture-pane sees echoed keystrokes, and an unsplit literal would read as
    // "finished" the instant it was typed.
    tmux(["send-keys", "-t", pane, `${plan.command(sandbox)}; echo VERIFY""_DONE`, "Enter"]);

    const deadline = Date.now() + plan.timeout * 1000;
    // The shell prompt can return before the final hook's tmux write lands, so
    // finishing is not a reason to stop looking. Keep sampling briefly after.
    const GRACE_MS = 2000;
    let finishedAt = 0;
    let finished = false;
    while (Date.now() < deadline) {
      const [state, k] = tmux([
        "display-message", "-p", "-t", pane,
        "#{@jmux-agent-state}/#{@jmux-agent-kind}",
      ]).out.split("/");
      if (k) kind = k;
      if (state && observed[observed.length - 1] !== state) observed.push(state);
      if (!finished) {
        finished = tmux(["capture-pane", "-p", "-t", pane]).out.includes("VERIFY_DONE");
        if (finished) finishedAt = Date.now();
      }
      if (finished && Date.now() - finishedAt > GRACE_MS) {
        // Suppressed: nothing will clear it, so stop once we have a value.
        // Intact: wait for the clear, which is the thing being proven.
        if (suppressSessionEnd && observed.length > 0) break;
        if (!suppressSessionEnd && !state && observed.length > 0) break;
      }
      await Bun.sleep(25);
    }
    const finalState = tmux(["display-message", "-p", "-t", pane, "#{@jmux-agent-state}"]).out;
    const blocked = detectBlocked(tmux(["capture-pane", "-p", "-t", pane]).out);
    return { observed, kind, finalState, blocked };
  } finally {
    tmux(["kill-session", "-t", plan.id]);
    rmSync(sandbox, { recursive: true, force: true });
  }
}

const which = process.argv[2] ?? "all";
const selected = which === "all" ? PLANS : PLANS.filter((p) => p.id === which);
if (selected.length === 0) {
  console.error(`Unknown agent "${which}". Known: ${PLANS.map((p) => p.id).join(", ")}, all`);
  process.exit(2);
}

console.log(`Verifying on tmux socket ${SOCKET}\n`);
let failures = 0;
let skipped = 0;

for (const plan of selected) {
  console.log(plan.label);

  const turn = await runPhase(plan, plan.suppressSessionEnd !== undefined);
  if (turn.blocked) {
    console.log(`  turn:      SKIP  ${turn.blocked}`);
    console.log(`  observed:  ${turn.observed.join(" → ") || "(none)"}`);
    console.log(`  Cannot verify without working credentials in the sandbox.\n`);
    skipped++;
    continue;
  }
  const missing = plan.expect.filter((s) => !turn.observed.includes(s));
  const kindOk = turn.kind === plan.id;
  const turnOk = missing.length === 0 && kindOk;
  console.log(`  turn:      ${turnOk ? "PASS" : "FAIL"}  ${turn.observed.join(" → ") || "(none)"}`);
  console.log(`  kind:      ${turn.kind || "(unset)"}${kindOk ? "" : `   EXPECTED ${plan.id}`}`);
  if (missing.length > 0) console.log(`  missing:   ${missing.join(", ")}`);
  if (!turnOk) failures++;

  if (plan.checksTeardown) {
    const teardown = await runPhase(plan, false);
    const cleared = teardown.finalState === "";
    console.log(`  teardown:  ${cleared ? "PASS" : "FAIL"}  state cleared on exit`);
    if (!cleared) {
      console.log(`  left as:   ${teardown.finalState}`);
      failures++;
    }
  }
  if (plan.caveat) console.log(`  note:      ${plan.caveat}`);
  console.log();
}

tmux(["kill-server"]);
const summary = failures === 0 ? "All checks passed." : `${failures} check(s) failed.`;
console.log(skipped > 0 ? `${summary} ${skipped} agent(s) skipped.` : summary);
process.exit(failures > 0 ? 1 : 0);
