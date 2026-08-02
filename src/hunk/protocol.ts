// src/hunk/protocol.ts
//
// The wire shapes of hunk's session daemon, and the pure functions that read
// them. No I/O — every fact arrives as an argument, so the whole decision table
// unit-tests without a daemon, a repo, or a terminal.
//
// Background: hunk 0.17 runs a local daemon that every hunk TUI registers with.
// Until now jmux treated hunk as an opaque source of terminal bytes; the daemon
// turns it into something jmux can read (which files, how many lines, what the
// user is looking at) and write to (inline review notes). That is what makes
// the review loop possible: hunk knows the notes, jmux knows which agent wrote
// the diff, and nothing else in the system knows both.
//
// Everything here is defensive. The daemon is a separate program on its own
// release cadence, and its error path leaks raw internal messages
// ("undefined is not an object (evaluating 'selector.sessionId')"), so a shape
// that doesn't parse must degrade to "no control plane" rather than throw into
// a render pass.

/** The daemon's default bind, matching hunk's own documented defaults. */
export const DEFAULT_HUNK_HOST = "127.0.0.1";
export const DEFAULT_HUNK_PORT = 47657;

/**
 * The daemon's base URL.
 *
 * Resolved from the same two environment variables hunk itself reads, rather
 * than hardcoded: jmux and the user's hunk inherit one environment, so reading
 * `HUNK_MCP_HOST`/`HUNK_MCP_PORT` here is what keeps the two agreeing when a
 * user moves the port. A non-numeric or out-of-range port falls back to the
 * default instead of producing an unfetchable URL.
 */
export function daemonBase(env: Record<string, string | undefined> = process.env): string {
  const host = env.HUNK_MCP_HOST?.trim() || DEFAULT_HUNK_HOST;
  const rawPort = Number(env.HUNK_MCP_PORT);
  const port = Number.isInteger(rawPort) && rawPort > 0 && rawPort < 65536 ? rawPort : DEFAULT_HUNK_PORT;
  return `http://${host}:${port}`;
}

/**
 * What `/session-api/capabilities` reports. This is the on switch: jmux probes
 * it once per hunk spawn, and a null result means the control plane is simply
 * off — the panel then behaves exactly as it did before any of this existed.
 */
export interface HunkCapabilities {
  version: number;
  daemonVersion: number;
  actions: string[];
}

/** One changed file in a live review. */
export interface HunkFile {
  path: string;
  additions: number;
  deletions: number;
  hunkCount: number;
}

/**
 * An inline note on a hunk. `source` is what jmux keys on: `user` notes are the
 * human's review of an agent's work and are the only ones worth sending back —
 * echoing an agent's own notes at it would be a loop with no new information.
 */
export interface HunkNote {
  noteId: string;
  source: "user" | "agent" | "ai" | string;
  filePath: string;
  hunkIndex: number;
  /** 1-based line on whichever side the note was anchored to. */
  line: number | null;
  side: "old" | "new";
  body: string;
  author: string;
  createdAt: string;
}

/** A live hunk TUI, as the daemon sees it. */
export interface HunkSession {
  sessionId: string;
  /**
   * The hunk process's pid — and, for a hunk jmux spawned itself, exactly the
   * pty child pid. This is the only exact way to find *our* session: the daemon
   * keeps dead entries for up to 45s and several sessions routinely share a
   * repo root, so selecting by repo is both stale-prone and ambiguous.
   */
  pid: number;
  cwd: string;
  repoRoot: string;
  /** `vcs` for a working-tree review, `show` for a commit, `patch` for a file. */
  inputKind: string;
  title: string;
  files: HunkFile[];
  /** Both the human's notes and any an agent left, newest last. */
  notes: HunkNote[];
  selectedFilePath: string | null;
  selectedHunkIndex: number | null;
}

// --- Parsing -----------------------------------------------------------------
//
// Hand-rolled rather than schema-validated: these run inside a render-adjacent
// poll, and the only correct response to any malformed field is to drop the
// value, which a validator would express as more code rather than less.

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null;
}

function str(x: unknown): string | null {
  return typeof x === "string" ? x : null;
}

function num(x: unknown): number | null {
  return typeof x === "number" && Number.isFinite(x) ? x : null;
}

export function parseCapabilities(raw: unknown): HunkCapabilities | null {
  if (!isRecord(raw)) return null;
  const version = num(raw.version);
  const daemonVersion = num(raw.daemonVersion);
  if (version === null) return null;
  const actions = Array.isArray(raw.actions) ? raw.actions.filter((a): a is string => typeof a === "string") : [];
  return { version, daemonVersion: daemonVersion ?? 0, actions };
}

/**
 * Whether this daemon can do what jmux needs.
 *
 * A version jmux has never seen is *allowed*: the actions list is the real
 * contract and refusing an unknown major would strand users on every hunk
 * release. What is not allowed is a daemon missing an action jmux calls.
 */
export function supportsControlPlane(caps: HunkCapabilities | null): boolean {
  if (!caps) return false;
  return REQUIRED_ACTIONS.every((a) => caps.actions.includes(a));
}

/**
 * The actions jmux actually calls. `reload` is deliberately absent — jmux
 * respawns hunk to change content instead, because `--watch` stops firing
 * after a reload retargets a session and a silently stale panel is worse than
 * a visible respawn.
 */
export const REQUIRED_ACTIONS = ["list", "get", "comment-list", "comment-rm"] as const;

function parseFile(raw: unknown): HunkFile | null {
  if (!isRecord(raw)) return null;
  const path = str(raw.path);
  if (path === null) return null;
  return {
    path,
    additions: num(raw.additions) ?? 0,
    deletions: num(raw.deletions) ?? 0,
    hunkCount: num(raw.hunkCount) ?? 0,
  };
}

/**
 * A note, from either of the two shapes the daemon uses for one.
 *
 * `comment-list` returns `newRange`/`oldRange` pairs while a session snapshot's
 * `liveComments` return a flat `line`+`side`. Both are read into one shape here,
 * so no caller downstream has to know which endpoint its data came from.
 */
export function parseNote(raw: unknown): HunkNote | null {
  if (!isRecord(raw)) return null;
  const noteId = str(raw.noteId) ?? str(raw.commentId);
  const filePath = str(raw.filePath);
  if (noteId === null || filePath === null) return null;

  const newRange = Array.isArray(raw.newRange) ? num(raw.newRange[0]) : null;
  const oldRange = Array.isArray(raw.oldRange) ? num(raw.oldRange[0]) : null;
  const flatLine = num(raw.line);
  const flatSide = str(raw.side);

  let line: number | null;
  let side: "old" | "new";
  if (flatLine !== null) {
    line = flatLine;
    side = flatSide === "old" ? "old" : "new";
  } else if (newRange !== null) {
    line = newRange;
    side = "new";
  } else if (oldRange !== null) {
    line = oldRange;
    side = "old";
  } else {
    line = null;
    side = "new";
  }

  // A snapshot comment carries `summary`/`rationale`; comment-list flattens the
  // same note into `body`. Joining them here means the prompt builder never has
  // to care which one it got.
  const body =
    str(raw.body) ??
    [str(raw.summary), str(raw.rationale)].filter((s): s is string => s !== null && s.length > 0).join("\n\n");

  return {
    noteId,
    source: str(raw.source) ?? str(raw.author) ?? "user",
    filePath,
    hunkIndex: num(raw.hunkIndex) ?? 0,
    line,
    side,
    body,
    author: str(raw.author) ?? "user",
    createdAt: str(raw.createdAt) ?? "",
  };
}

export function parseNotes(raw: unknown): HunkNote[] {
  if (!isRecord(raw) || !Array.isArray(raw.comments)) return [];
  return raw.comments.map(parseNote).filter((n): n is HunkNote => n !== null);
}

export function parseSession(raw: unknown): HunkSession | null {
  if (!isRecord(raw)) return null;
  const sessionId = str(raw.sessionId);
  const pid = num(raw.pid);
  if (sessionId === null || pid === null) return null;

  const files = Array.isArray(raw.files)
    ? raw.files.map(parseFile).filter((f): f is HunkFile => f !== null)
    : [];

  const state = isRecord(raw.snapshot) && isRecord(raw.snapshot.state) ? raw.snapshot.state : null;
  const notes =
    state && Array.isArray(state.reviewNotes)
      ? state.reviewNotes.map(parseNote).filter((n): n is HunkNote => n !== null)
      : [];

  return {
    sessionId,
    pid,
    cwd: str(raw.cwd) ?? "",
    repoRoot: str(raw.repoRoot) ?? "",
    inputKind: str(raw.inputKind) ?? "",
    title: str(raw.title) ?? "",
    files,
    notes,
    selectedFilePath: state ? str(state.selectedFilePath) : null,
    selectedHunkIndex: state ? num(state.selectedHunkIndex) : null,
  };
}

export function parseSessionList(raw: unknown): HunkSession[] {
  if (!isRecord(raw) || !Array.isArray(raw.sessions)) return [];
  return raw.sessions.map(parseSession).filter((s): s is HunkSession => s !== null);
}

/**
 * Our session among all the live ones.
 *
 * Matching on pid rather than repo is the whole point — see `HunkSession.pid`.
 * A miss is expected and normal for the first second or so after spawn: the
 * daemon is started by the TUI itself, so it may not be listening yet.
 */
export function sessionByPid(sessions: readonly HunkSession[], pid: number | null): HunkSession | null {
  if (pid === null) return null;
  return sessions.find((s) => s.pid === pid) ?? null;
}

// --- Derived display ---------------------------------------------------------

export interface DiffStats {
  files: number;
  additions: number;
  deletions: number;
}

export function diffStats(session: HunkSession | null): DiffStats {
  if (!session) return { files: 0, additions: 0, deletions: 0 };
  let additions = 0;
  let deletions = 0;
  for (const f of session.files) {
    additions += f.additions;
    deletions += f.deletions;
  }
  return { files: session.files.length, additions, deletions };
}

/** The human's own notes — the only ones worth sending back to an agent. */
export function userNotes(notes: readonly HunkNote[]): HunkNote[] {
  return notes.filter((n) => n.source === "user");
}

/**
 * The badge appended to the Diff tab label, or null when there is nothing to
 * say. Two widths, because the tab strip lives in a panel the user can drag
 * down to 20 columns and an overlong label would push the other tabs off the
 * end of a strip that has no drop behaviour.
 *
 * The note count is a *pending review* count, not a total: sent notes are
 * removed from hunk, so a non-zero badge always means "you have written
 * something you have not sent yet".
 */
export function formatDiffBadge(stats: DiffStats, pendingNotes: number, cols: number): string | null {
  if (stats.files === 0 && pendingNotes === 0) return null;

  const parts: string[] = [];
  if (stats.files > 0) {
    // U+2212 MINUS SIGN reads as a deletion count next to "+"; ASCII hyphen
    // next to a digit reads as a range.
    parts.push(cols < 44 ? `+${stats.additions}−${stats.deletions}` : `+${stats.additions} −${stats.deletions}`);
  }
  if (pendingNotes > 0) parts.push(`●${pendingNotes}`);
  return parts.join(" ");
}

// --- The review prompt -------------------------------------------------------

export interface ReviewPromptOptions {
  /** Shown so the agent knows which changeset the notes are about. */
  title?: string;
}

/**
 * The message an agent receives when the user sends their review.
 *
 * Kept pure and tested because it is the one artifact of this whole feature the
 * user never sees before it is acted on — it lands in an agent's context and
 * becomes work. Notes are grouped by file and ordered by line so the agent
 * reads them in the order it would open the file, and every note carries an
 * explicit `path:line` so it can navigate without guessing.
 */
export function formatReviewPrompt(notes: readonly HunkNote[], opts: ReviewPromptOptions = {}): string {
  if (notes.length === 0) return "";

  const byFile = new Map<string, HunkNote[]>();
  for (const note of notes) {
    const list = byFile.get(note.filePath);
    if (list) list.push(note);
    else byFile.set(note.filePath, [note]);
  }

  const lines: string[] = [];
  lines.push(
    opts.title
      ? `Code review feedback on ${opts.title}. Please address each note:`
      : "Code review feedback on your changes. Please address each note:",
  );

  for (const [path, fileNotes] of byFile) {
    lines.push("");
    lines.push(`${path}:`);
    const ordered = [...fileNotes].sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
    for (const note of ordered) {
      const where = note.line === null ? path : `${path}:${note.line}`;
      // A note's body can be a paragraph. Indent continuation lines so the
      // boundary between one note and the next survives in a plain-text prompt.
      const body = note.body.trim().split("\n");
      lines.push(`  - ${where} — ${body[0] ?? ""}`);
      for (const cont of body.slice(1)) lines.push(`    ${cont}`);
    }
  }

  return lines.join("\n");
}
