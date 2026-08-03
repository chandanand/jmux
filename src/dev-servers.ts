// src/dev-servers.ts
//
// What is listening, and whose it is.
//
// "Open the dev server for this session" needs two facts nobody has together:
// which ports are listening (the kernel knows, via lsof) and which process
// belongs to which pane (tmux knows the pane's shell, and the shell's
// descendants are the rest). Joining them attributes a port to a *session*
// without reading a single line of anyone's output.
//
// Scraping the pane for a printed URL was the obvious alternative and is worse
// in both directions: a server that printed its URL before you scrolled is
// invisible, and a URL in a log line or a README preview is a false positive.
// A listening socket is a fact about now.
//
// Everything here is pure. The two commands it needs are injected, which is
// what lets the parsing be tested against real output shapes rather than
// against a machine that happens to have a dev server running on it.

/** A process listening on a TCP port. */
export interface Listener {
  pid: number;
  /** The bind address as lsof reports it: `*`, `127.0.0.1`, `[::1]`, … */
  address: string;
  port: number;
}

/** A listening port attributed to a session. */
export interface DevServer {
  session: string;
  paneId: string;
  port: number;
  address: string;
  /** The listening process, which is usually the interesting name. */
  pid: number;
  command: string;
}

/**
 * Parse `lsof -nP -iTCP -sTCP:LISTEN -F pn`.
 *
 * The `-F` output is a stream of one-letter-prefixed lines where `p` opens a
 * process block and every `n` after it belongs to that process until the next
 * `p`. A port bound on both IPv4 and IPv6 appears twice, which is a detail of
 * how it was bound rather than two servers, so it is collapsed.
 */
export function parseListeners(output: string): Listener[] {
  const seen = new Set<string>();
  const out: Listener[] = [];
  let pid = 0;
  for (const line of output.split("\n")) {
    if (line.startsWith("p")) {
      pid = Number(line.slice(1)) || 0;
      continue;
    }
    if (!line.startsWith("n") || !pid) continue;
    const addr = line.slice(1);
    // `host:port`, where host may itself contain colons when it is IPv6 — so
    // the split has to come from the right.
    const colon = addr.lastIndexOf(":");
    if (colon < 0) continue;
    const port = Number(addr.slice(colon + 1));
    if (!Number.isInteger(port) || port <= 0) continue;
    const address = addr.slice(0, colon);
    const key = `${pid}:${port}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ pid, address, port });
  }
  return out;
}

/**
 * Parse `ps -Ao pid=,ppid=` into a child index.
 *
 * Children rather than parents because the question is always "everything under
 * this pane", and walking down from one root beats walking up from thousands of
 * processes that are nothing to do with us.
 */
export function parseProcessTree(output: string): Map<number, number[]> {
  const children = new Map<number, number[]>();
  for (const line of output.split("\n")) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
    const list = children.get(ppid);
    if (list) list.push(pid);
    else children.set(ppid, [pid]);
  }
  return children;
}

/**
 * Every pid at or below `root`.
 *
 * Iterative, and it tracks what it has seen: a process tree is a tree until a
 * pid is reused mid-read, and recursion over that is a hang rather than a wrong
 * answer.
 */
export function descendants(root: number, children: Map<number, number[]>): Set<number> {
  const found = new Set<number>([root]);
  const queue = [root];
  while (queue.length > 0) {
    for (const child of children.get(queue.pop()!) ?? []) {
      if (found.has(child)) continue;
      found.add(child);
      queue.push(child);
    }
  }
  return found;
}

/** A pane, as `list-panes -F '#{session_name}\t#{pane_id}\t#{pane_pid}'` gives it. */
export interface PaneProcess {
  session: string;
  paneId: string;
  pid: number;
}

export function parsePaneProcesses(lines: string[]): PaneProcess[] {
  const out: PaneProcess[] = [];
  for (const line of lines) {
    const [session, paneId, pid] = line.split("\t");
    const n = Number(pid);
    if (!paneId || !Number.isInteger(n)) continue;
    out.push({ session: session ?? "", paneId, pid: n });
  }
  return out;
}

/**
 * Only addresses a browser on this machine can actually reach.
 *
 * A wildcard bind and a loopback bind are both "http://localhost:PORT" from
 * here. Anything else — a VPN interface, a container bridge — is listening
 * somewhere this browser is not, and offering it produces a page that never
 * loads.
 */
export function isLocallyReachable(address: string): boolean {
  return (
    address === "*" ||
    address === "0.0.0.0" ||
    address === "127.0.0.1" ||
    address === "[::1]" ||
    address === "::1" ||
    address === "[::]"
  );
}

/**
 * Join listeners to panes.
 *
 * A pane's shell is the root; the server is somewhere under it. Sorted by port
 * so a picker is stable between invocations rather than following whatever
 * order lsof happened to walk its file descriptors in.
 */
export function attributeListeners(
  listeners: Listener[],
  panes: PaneProcess[],
  children: Map<number, number[]>,
  commands: Map<number, string> = new Map(),
): DevServer[] {
  const out: DevServer[] = [];
  const claimed = new Set<string>();
  for (const pane of panes) {
    const owned = descendants(pane.pid, children);
    for (const listener of listeners) {
      if (!owned.has(listener.pid)) continue;
      if (!isLocallyReachable(listener.address)) continue;
      // One port, one owner. Panes nest (a shell inside a shell) and without
      // this the same server is offered once per level.
      const key = `${listener.pid}:${listener.port}`;
      if (claimed.has(key)) continue;
      claimed.add(key);
      out.push({
        session: pane.session,
        paneId: pane.paneId,
        port: listener.port,
        address: listener.address,
        pid: listener.pid,
        command: commands.get(listener.pid) ?? "",
      });
    }
  }
  return out.sort((a, b) => a.port - b.port);
}

/**
 * The URL to point a browser at.
 *
 * Always `localhost`, whatever the bind was: `*:3000` is not something a
 * browser can navigate to, and a loopback bind and a wildcard bind are the same
 * address from here.
 *
 * The scheme is a genuine guess. A listening socket says nothing about whether
 * TLS is on it, and probing would cost a round trip on every open. `http` is
 * right for the overwhelming majority of dev servers, and when it is wrong the
 * URL is visible in the picker and editable in the browser's address bar — so
 * the guess is recoverable rather than silent.
 */
export function devServerUrl(server: DevServer, scheme: "http" | "https" = "http"): string {
  return `${scheme}://localhost:${server.port}`;
}

/**
 * What `scanDevServers` needs from the outside world.
 *
 * Injected rather than imported so this module stays pure and so the two
 * callers can each bring their own transport: the TUI already holds a tmux
 * control connection, `ctl` shells out. Both are async, which is not a detail —
 * `lsof` costs around 120ms and the TUI calls this from a keypress.
 */
export interface DevServerDeps {
  /** `tmux list-panes …`, returning non-empty lines. */
  listPanes: (format: string) => Promise<string[]>;
  /** Run a command, returning stdout. Failure is an empty string, not a throw. */
  run: (cmd: string[]) => Promise<string>;
}

/** The `list-panes -F` spec `parsePaneProcesses` understands. */
export const PANE_PROCESS_FORMAT = "#{session_name}\t#{pane_id}\t#{pane_pid}";

/**
 * Every locally reachable listening port, attributed to a session.
 *
 * Async throughout, deliberately. `lsof` is ~120ms and `ps` is called twice;
 * doing that synchronously from the TUI stops rendering, input and pty drain
 * for the duration — which is most of the latency budget the render loop was
 * just tuned to protect.
 */
export async function scanDevServers(
  opts: { session?: string },
  deps: DevServerDeps,
): Promise<DevServer[]> {
  const panes = parsePaneProcesses(await deps.listPanes(PANE_PROCESS_FORMAT));
  const scoped = opts.session ? panes.filter((p) => p.session === opts.session) : panes;
  if (scoped.length === 0) return [];

  const listeners = parseListeners(
    await deps.run(["lsof", "-nP", "-iTCP", "-sTCP:LISTEN", "-F", "pn"]),
  );
  if (listeners.length === 0) return [];

  const [tree, commands] = await Promise.all([
    deps.run(["ps", "-Ao", "pid=,ppid="]).then(parseProcessTree),
    deps.run(["ps", "-Ao", "pid=,comm="]).then(parseCommands),
  ]);
  return attributeListeners(listeners, scoped, tree, commands);
}

/** Command names by pid, from `ps -Ao pid=,comm=`. */
export function parseCommands(output: string): Map<number, string> {
  const out = new Map<number, string>();
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    const space = trimmed.indexOf(" ");
    if (space < 0) continue;
    const pid = Number(trimmed.slice(0, space));
    if (!Number.isInteger(pid)) continue;
    // Just the program, not the path it was started from — `node`, not
    // `/opt/homebrew/Cellar/node/24.1.0/bin/node`.
    const command = trimmed.slice(space + 1).trim();
    out.set(pid, command.split("/").pop() ?? command);
  }
  return out;
}
