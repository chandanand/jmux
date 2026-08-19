import { openSync, closeSync, readFileSync, existsSync, unlinkSync, chmodSync, statSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { writeFileAtomicSync } from "../atomic-write";
import { RAISES_CONTRACT_VERSION, RAISE_STATES, type Raise, type RaiseOption, type RaiseScope } from "./types";

/**
 * Beside the config file that is actually in use, never a fixed home path. The
 * session manager accepts an alternate config path and demo mode uses one. A
 * fixed path would let a demo screen read and modify real raises.
 */
export function raisesPathFor(configPath: string): string {
  return join(dirname(configPath), "raises.json");
}

export type ReadResult =
  | { kind: "missing" }
  | { kind: "valid"; raises: Raise[] }
  | { kind: "error"; why: string };

export type MutateResult = { ok: true; raises: Raise[] } | { ok: false; why: string };

function isRaiseOption(value: unknown): value is RaiseOption {
  if (typeof value !== "object" || value === null) return false;
  const o = value as Record<string, unknown>;
  return typeof o.id === "string" && typeof o.text === "string";
}

function isWellFormedScope(value: unknown): value is RaiseScope {
  if (typeof value !== "object" || value === null) return false;
  const s = value as Record<string, unknown>;
  if (s.kind === "session") {
    return (
      typeof s.socket === "string" &&
      typeof s.sessionId === "string" &&
      typeof s.sessionName === "string" &&
      (s.agentPane === null || typeof s.agentPane === "string")
    );
  }
  if (s.kind === "issue") {
    return typeof s.identifier === "string";
  }
  return false;
}

/**
 * Whether one record is a well-formed `Raise` — checking only what
 * consumers actually rely on (`id`, `state`, `scope`, `options`,
 * `recommendation`), not every field. Returns the reason it fails, or
 * `null` when the record is sound. A store with one malformed record next
 * to otherwise-valid ones must never quietly drop the bad one and read back
 * as if nothing were waiting on the operator — see `readRaises`.
 */
function malformedRaiseReason(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return "record is not an object";
  const r = value as Record<string, unknown>;
  if (typeof r.id !== "string" || r.id === "") return "id is missing or not a string";
  if (typeof r.state !== "string" || !(RAISE_STATES as readonly string[]).includes(r.state)) {
    return `state ${JSON.stringify(r.state)} is not one of ${RAISE_STATES.join(", ")}`;
  }
  if (!isWellFormedScope(r.scope)) return "scope is not a well-formed session or issue scope";
  if (!Array.isArray(r.options) || !r.options.every(isRaiseOption)) {
    return "options is not an array of {id, text}";
  }
  const optionIds = r.options.map((o) => o.id);
  if (typeof r.recommendation !== "string" || !optionIds.includes(r.recommendation)) {
    return "recommendation does not match any of the raise's option ids";
  }
  return null;
}

/**
 * Read the store, distinguishing "there is nothing here yet" from "this could
 * not be read". Returning `[]` for the second is how a corrupt file becomes an
 * erased file, and how a queue of questions waiting on a human silently empties.
 *
 * Every record is validated, not just the envelope: a single malformed raise
 * inside an otherwise-valid file used to reach `RaisesScreen.render` as a bare
 * `Raise`, and it threw — crashing the whole inbox rather than losing just
 * that one question. Treating a malformed record as an unreadable store, the
 * same as an unparseable file, is what already makes `list` refuse and
 * mutations leave the original bytes intact; see `mutateRaises`'s own re-read
 * under the lock.
 */
export function readRaises(path: string): ReadResult {
  if (!existsSync(path)) return { kind: "missing" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    return { kind: "error", why: `raise store at ${path} could not be parsed: ${(e as Error).message}` };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { kind: "error", why: `raise store at ${path} is not an object` };
  }
  const { version, raises } = parsed as { version?: unknown; raises?: unknown };
  if (version !== RAISES_CONTRACT_VERSION) {
    return {
      kind: "error",
      why: `raise store at ${path} has contract version ${String(version)}, expected ${RAISES_CONTRACT_VERSION}`,
    };
  }
  if (!Array.isArray(raises)) {
    return { kind: "error", why: `raise store at ${path} has no raises array` };
  }
  for (let i = 0; i < raises.length; i++) {
    const record: unknown = raises[i];
    const reason = malformedRaiseReason(record);
    if (reason !== null) {
      const id =
        typeof record === "object" && record !== null && typeof (record as Record<string, unknown>).id === "string"
          ? (record as Record<string, unknown>).id
          : null;
      const idHint = id !== null ? ` (id ${id})` : "";
      return { kind: "error", why: `raise store at ${path} has a malformed record at index ${i}${idHint}: ${reason}` };
    }
  }
  return { kind: "valid", raises: raises as Raise[] };
}

const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 5_000;

/**
 * Take an exclusive lock, re-read under it, apply `fn`, and replace the file.
 *
 * The lock is the point. `writeFileAtomicSync` replaces atomically but holds
 * nothing across read-modify-write, so two `ctl raise` processes each read the
 * same file, each append one record, and the second rename discards the first.
 */
export function mutateRaises(path: string, fn: (raises: Raise[]) => Raise[]): MutateResult {
  // writeFileAtomicSync only creates the directory once it gets to the write,
  // which is after the lock loop below. openSync(lockPath, "wx") throws ENOENT
  // when the containing directory is missing, and the retry loop cannot tell
  // that apart from a lock genuinely held by another process — so the
  // directory must exist before the first lock attempt.
  mkdirSync(dirname(path), { recursive: true });

  const lockPath = `${path}.lock`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  let fd: number | null = null;

  for (;;) {
    try {
      fd = openSync(lockPath, "wx");
      break;
    } catch {
      // A lock left by a killed process must not block every later write.
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) unlinkSync(lockPath);
      } catch { /* raced with the holder; fall through and retry */ }
      if (Date.now() > deadline) return { ok: false, why: `raise store at ${path} is locked` };
      Bun.sleepSync(10);
    }
  }

  try {
    const current = readRaises(path);
    if (current.kind === "error") return { ok: false, why: current.why };
    const next = fn(current.kind === "valid" ? current.raises : []);
    writeFileAtomicSync(path, JSON.stringify({ version: RAISES_CONTRACT_VERSION, raises: next }, null, 2) + "\n");
    // A raise holds a pane capture, which can contain anything that was on the
    // agent's screen. The atomic helper inherits the umask, so set the mode here.
    chmodSync(path, 0o600);
    return { ok: true, raises: next };
  } finally {
    if (fd !== null) closeSync(fd);
    try { unlinkSync(lockPath); } catch { /* already gone */ }
  }
}

/** An unresolved raise with this key, if one exists. Resolved raises never block a new question. */
export function findByKey(raises: Raise[], key: string): Raise | null {
  return raises.find((r) => r.idempotencyKey === key && r.state !== "resolved") ?? null;
}

/**
 * Keep every unresolved raise, and the `keep` most recently resolved ones.
 * Ordering is by `resolvedAt`: ordering by `createdAt` would discard an old
 * question the moment it was answered.
 */
export function pruneResolved(raises: Raise[], keep: number): Raise[] {
  const live = raises.filter((r) => r.state !== "resolved");
  const resolved = raises
    .filter((r) => r.state === "resolved")
    .sort((a, b) => (b.resolvedAt ?? 0) - (a.resolvedAt ?? 0))
    .slice(0, keep);
  return [...live, ...resolved];
}
