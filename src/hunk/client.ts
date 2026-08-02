// src/hunk/client.ts
//
// The transport to hunk's session daemon.
//
// One mechanism, HTTP, for everything jmux asks of it. The `hunk session` CLI
// wraps this same endpoint, but a CLI call costs ~90ms of process startup
// against ~0.4ms for the POST, and the panel polls — so the CLI would have put
// a subprocess spawn on a once-a-second timer for the life of the panel.
//
// Every method swallows its failures. The daemon is a separate program that
// may be absent, mid-restart, or newer than jmux, and none of those are the
// diff panel's problem: a null or empty result puts jmux back on the behaviour
// it had before the control plane existed, which is a path that already ships
// and is already exercised every time hunk isn't installed.

import {
  daemonBase,
  parseCapabilities,
  parseNotes,
  parseSession,
  parseSessionList,
  type HunkCapabilities,
  type HunkNote,
  type HunkSession,
} from "./protocol";

/**
 * How long any one request may take. Generous next to a 0.4ms local round trip
 * and still short enough that a wedged daemon can never hold up a frame: the
 * poll that calls this runs off a timer, not the render path, but a request
 * that never settles would leak a pending promise per tick.
 */
const REQUEST_TIMEOUT_MS = 500;

export interface HunkClientOptions {
  /** Overridden in tests; defaults to the daemon's documented bind. */
  base?: string;
  /** Injected in tests so the client is exercisable with no daemon. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** Which notes to ask for. `all` includes notes agents left. */
export type NoteType = "user" | "agent" | "all";

/** Where to move the user's view. Exactly one field is honoured. */
export type NavigateTarget =
  | { hunkNumber: number }
  | { newLine: number }
  | { oldLine: number };

export class HunkClient {
  private readonly base: string;
  private readonly doFetch: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: HunkClientOptions = {}) {
    this.base = opts.base ?? daemonBase();
    this.doFetch = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
  }

  /**
   * Capabilities, or null if there is no daemon answering. This is the probe
   * that decides whether the control plane is on at all.
   */
  async probe(): Promise<HunkCapabilities | null> {
    const raw = await this.request("GET", "/session-api/capabilities");
    return raw === null ? null : parseCapabilities(raw);
  }

  async list(): Promise<HunkSession[]> {
    const raw = await this.action("list", {});
    return parseSessionList(raw);
  }

  async get(sessionId: string): Promise<HunkSession | null> {
    const raw = await this.action("get", { selector: { sessionId } });
    if (raw === null || typeof raw !== "object") return null;
    return parseSession((raw as Record<string, unknown>).session);
  }

  /**
   * Notes on the live review.
   *
   * `type` is always sent: omitting it selects a legacy live-agent view with a
   * different payload shape, which is not what any caller here wants.
   */
  async notes(sessionId: string, type: NoteType): Promise<HunkNote[]> {
    const raw = await this.action("comment-list", { selector: { sessionId }, type });
    return parseNotes(raw);
  }

  /**
   * Delete specific notes, returning how many the daemon confirmed gone.
   *
   * By id, one at a time, rather than the bulk clear the CLI also offers: the
   * bulk form would also delete notes the user wrote in the seconds between
   * jmux reading the list and the send completing. Losing a note the user just
   * typed is silent and unrecoverable, so the slower call is the correct one.
   */
  async removeNotes(sessionId: string, noteIds: readonly string[]): Promise<number> {
    let removed = 0;
    for (const commentId of noteIds) {
      const raw = await this.action("comment-rm", { selector: { sessionId }, commentId });
      if (isRemoved(raw)) removed++;
    }
    return removed;
  }

  /** Move the user's view. Returns whether the daemon accepted it. */
  async navigate(sessionId: string, filePath: string, target: NavigateTarget): Promise<boolean> {
    const raw = await this.action("navigate", { selector: { sessionId }, filePath, ...target });
    return raw !== null && typeof raw === "object" && "result" in (raw as Record<string, unknown>);
  }

  private async action(action: string, params: Record<string, unknown>): Promise<unknown> {
    return this.request("POST", "/session-api", { action, ...params });
  }

  private async request(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
    try {
      const res = await this.doFetch(`${this.base}${path}`, {
        method,
        headers: body === undefined ? undefined : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) return null;
      const json = (await res.json()) as unknown;
      // The daemon reports failures as 200 with an `error` string, including
      // raw internal messages. Treat any of them as "no answer" rather than
      // trying to distinguish the ones jmux could act on.
      if (json !== null && typeof json === "object" && "error" in json) return null;
      return json;
    } catch {
      return null;
    }
  }
}

function isRemoved(raw: unknown): boolean {
  if (raw === null || typeof raw !== "object") return false;
  const result = (raw as Record<string, unknown>).result;
  return typeof result === "object" && result !== null && (result as Record<string, unknown>).removed === true;
}
