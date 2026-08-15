// End-to-end check of the diff panel's review loop, against a real jmux.
//
//   bun run scripts/review-loop-e2e.ts
//
// src/__tests__/hunk-integration.test.ts covers the handshake — jmux launches
// hunk with the right flags and finds its own session on the daemon — because
// that part is deterministic enough to belong in `bun test`. This covers the
// rest of the loop, including the parts that mean typing into hunk's own note
// editor on a timer: a note written in the panel, the confirm modal, the paste
// into the agent pane, the clear, and the view picker.
//
// It lives here rather than in the suite because those steps are timed against
// another program's TUI, and a flaky test is worse than an absent one. Run it
// by hand when touching src/hunk/ or the diff-panel wiring in main.ts.
//
// Requires tmux and hunk 0.17+. Uses its own tmux socket, its own scratch repo
// and a scratch HOME, so it cannot touch a real config or session.

import { Terminal } from "bun-pty";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO = realpathSync(mkdtempSync(join(tmpdir(), "jmux-review-e2e-")));
const SOCKET = "jmuxhunklive";
const JMUX = resolve(import.meta.dir, "..");

const sh = async (cmd: string[], cwd?: string) => {
  const p = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  const out = await new Response(p.stdout).text();
  await p.exited;
  return out.trim();
};

const tmux = (args: string[]) => sh(["tmux", "-L", SOCKET, ...args]);

const api = async (body: object) => {
  const res = await fetch("http://127.0.0.1:47657/session-api", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json() as Promise<any>;
};

// --- scratch repo ---
await sh(["git", "init", "-q", "-b", "main"], REPO);
await sh(["git", "config", "user.email", "t@t.t"], REPO);
await sh(["git", "config", "user.name", "t"], REPO);
writeFileSync(`${REPO}/app.ts`, "export const a = 1;\nexport const b = 2;\n");
await sh(["git", "add", "-A"], REPO);
await sh(["git", "commit", "-qm", "init"], REPO);
// Working-tree changes for hunk to show.
writeFileSync(`${REPO}/app.ts`, "export const a = 1;\nexport const b = 22;\nexport const c = 3;\n");
writeFileSync(`${REPO}/new.ts`, "export const brand = 'new';\n");

await tmux(["kill-server"]).catch(() => {});

const results: Array<[string, boolean, string]> = [];
const check = (name: string, ok: boolean, detail = "") => {
  results.push([name, ok, detail]);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

let out = "";
// A scratch HOME, which is what actually isolates this: jmux resolves its
// config through homedir(), so XDG_CONFIG_HOME alone left the run reading the
// developer's real config and live tracker adapters.
const HOME = `${REPO}-home`;
rmSync(HOME, { recursive: true, force: true });
mkdirSync(`${HOME}/.config/jmux`, { recursive: true });

// Empty strings, not deletes: bun-pty merges the given env over the parent's,
// so a deleted key still arrives inherited. This is what boot-smoke does.
const cleanEnv = { ...process.env, JMUX: "", TMUX: "", TMUX_PANE: "" };

const term = new Terminal("bun", ["run", `${JMUX}/src/main.ts`, "-L", SOCKET, "livetest"], {
  name: "xterm-256color",
  cols: 200,
  rows: 50,
  // JMUX/TMUX must go: jmux refuses to nest inside itself, and this harness
  // runs from a shell that is already inside one.
  env: { ...cleanEnv, TERM: "xterm-256color", HOME, XDG_CONFIG_HOME: `${HOME}/.config` },
  cwd: REPO,
});
term.onData((d: string) => { out += d; });
let exitCode: number | null = null;
term.onExit((e: { exitCode: number }) => { exitCode = e.exitCode; });

// Merged writes are silently discarded by the input router, so every keystroke
// goes in on its own — but an escape sequence is ONE keystroke and splitting it
// byte-by-byte means it never parses. Tokenise first, then pace the tokens.
const type = async (s: string, gapMs = 60) => {
  const tokens = s.match(/\x1b\[[0-9;]*[A-Za-z~]|\x1b.|[\s\S]/g) ?? [];
  for (const tok of tokens) {
    term.write(tok);
    await Bun.sleep(gapMs);
  }
};

const plain = () => out.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").replace(/\x1b[\]P][^\x07\x1b]*(\x07|\x1b\\)?/g, "");

try {
  await Bun.sleep(6000);
  const booted = (await tmux(["list-sessions", "-F", "#{session_name}"])).includes("livetest");
  check("jmux boots and stays alive", booted, booted ? "" : plain().slice(-300));
  if (!booted) throw new Error("jmux did not boot — the rest of the run would be noise");

  // A scratch HOME means a first run, which may paint a setup surface over
  // everything. Esc twice so the chords below reach the router.
  term.write("\x1b");
  await Bun.sleep(500);
  term.write("\x1b");
  await Bun.sleep(1200);

  // --- open the diff panel: Ctrl-Space g ---
  out = "";
  await type("\x00g");
  await Bun.sleep(4000);

  // Find our hunk through the daemon, keyed on the scratch repo. A `ps` grep
  // matches any hunk on the machine, including one the developer has open, and
  // then every check below reports on the wrong process.
  const list = await api({ action: "list" });
  const mine = (list.sessions ?? []).find((s: any) => s.repoRoot === REPO || s.cwd === REPO);
  check("daemon knows the hunk jmux spawned", !!mine, mine ? `pid ${mine.pid}, ${mine.fileCount} files` : "no session for the scratch repo");

  const psOut = await sh(["ps", "-Ao", "pid,args"]);
  const hunkLine = psOut.split("\n").find((l) => l.trim().startsWith(String(mine?.pid))) ?? "";
  check("hunk spawned with --watch", hunkLine.includes("--watch"), hunkLine.trim().slice(0, 100));
  check("hunk spawned with --transparent-bg", hunkLine.includes("--transparent-bg"));
  check("control plane sees the working-tree diff", (mine?.files ?? []).length === 2,
    (mine?.files ?? []).map((f: any) => f.path).join(", "));

  // --- the tab badge ---
  await Bun.sleep(2500);
  const screen = plain();
  const badge = /Diff\s+\+(\d+)\s*−(\d+)/.exec(screen);
  check("Diff tab shows live +N −M", !!badge, badge ? badge[0] : "no badge in frame");

  // --- leave a review note in the panel (hunk's own `c`) ---
  await type("c");
  await Bun.sleep(1200);
  await type("needs a test");
  await Bun.sleep(400);
  term.write("\x13"); // Ctrl-S saves the note
  await Bun.sleep(1500);

  const notes = await api({ action: "comment-list", selector: { sessionId: mine?.sessionId }, type: "user" });
  check("user note reached hunk", (notes.comments ?? []).length === 1,
    (notes.comments ?? []).map((c: any) => c.body).join("|"));

  await Bun.sleep(2000);
  check("badge picks up the pending note", /Diff\s+\+\d+\s*−\d+\s*●1/.test(plain()), (/Diff[^│]*/.exec(plain()) ?? [""])[0].trim().slice(0, 40));

  // --- point @jmux-agent-pane at the session's shell ---
  //
  // Verified by reading the pane back rather than by piping into a file: a
  // trailing C-d closes the shell when nothing is reading, which kills the
  // pane and makes every later assertion inspect a corpse.
  const pane = (await tmux(["list-panes", "-s", "-t", "livetest", "-F", "#{pane_id}"])).split("\n")[0]?.trim() ?? "";
  await tmux(["set-option", "-t", "livetest", "@jmux-agent-pane", pane]);
  await Bun.sleep(400);

  // --- Ctrl-Space r: the review send ---
  out = "";
  await type("\x00r");
  await Bun.sleep(2500);
  const confirmScreen = plain();
  const title = /Send \d+ review notes?/.exec(confirmScreen)?.[0] ?? "";
  const wrongModal = /No review to send|No agent to send to/.exec(confirmScreen)?.[0] ?? "";
  check("confirm modal opens with the note", !!title && /needs a test/.test(confirmScreen),
    title || (wrongModal ? `got "${wrongModal}" instead` : "no modal"));
  check("confirm modal names the target pane", confirmScreen.includes(`Sends to ${pane}`));

  term.write("\r"); // confirm
  await Bun.sleep(2500);

  const delivered = await tmux(["capture-pane", "-p", "-t", pane]);
  check("review text reached the agent pane",
    delivered.includes("needs a test") && delivered.includes("app.ts:"),
    delivered.split("\n").filter(Boolean).slice(-3).join(" / ").slice(0, 120));
  check("delivered with its structure intact", delivered.includes("Code review feedback"));

  const after = await api({ action: "comment-list", selector: { sessionId: mine?.sessionId }, type: "user" });
  check("sent notes cleared from hunk", (after.comments ?? []).length === 0, `${(after.comments ?? []).length} left`);

  // --- the shared notice modal: a second send with nothing left to send ---
  out = "";
  await type("\x00r");
  await Bun.sleep(2000);
  const notice = plain();
  check("a send with no notes explains itself", /No review to send/.test(notice) && /Press c in the diff panel/.test(notice),
    (/No review to send/.exec(notice) ?? ["no notice"])[0]);
  term.write("\x1b");
  await Bun.sleep(800);

  // --- Ctrl-Space v: the view picker ---
  out = "";
  await type("\x00v");
  await Bun.sleep(2000);
  const picker = plain();
  check("view picker offers the changesets", /Working tree/.test(picker) && /Staged/.test(picker) && /Last commit/.test(picker),
    (/Show in the Diff tab/.exec(picker) ?? [""])[0]);
  check("view picker marks the current view", /current/.test(picker));

  // pick "Last commit" (third down from Working tree)
  await type("\x1b[B\x1b[B\x1b[B");
  await Bun.sleep(300);
  term.write("\r");
  await Bun.sleep(4000);

  const psOut2 = await sh(["ps", "-Ao", "pid,args"]);
  const showLine = psOut2.split("\n").find((l) => /hunk/.test(l) && /show/.test(l) && !/grep/.test(l)) ?? "";
  check("picking a view respawns hunk against it", showLine.includes("show HEAD"), showLine.trim().slice(0, 90));

  check("jmux still alive at the end", exitCode === null, exitCode === null ? "" : `exited ${exitCode}`);
} finally {
  try { term.kill(); } catch {}
  await tmux(["kill-server"]).catch(() => {});
  rmSync("/tmp/jmux-review-capture.txt", { force: true });
}

const failed = results.filter(([, ok]) => !ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
