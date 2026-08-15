import { describe, expect, test, afterAll } from "bun:test";
import { Terminal } from "bun-pty";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// Does the hunk control plane actually connect?
//
// The second integration test in the suite, and it earns the exception for the
// same reason boot-smoke.test.ts does: the wiring lives in `main.ts`, which no
// unit test can import. The unit tests either side of this one cover the parts
// that are pure — the parsers, the argv table, the client against a stubbed
// fetch — and every one of them passed while the feature was completely broken
// end to end, because what was wrong lived in the glue.
//
// What this asserts is the handshake: jmux launches hunk with the flags it
// thinks it does, hunk's daemon registers that process, and jmux finds *its
// own* session among any others on the machine. Everything downstream (the tab
// badge, the review send, the view picker) is gated on that handshake, so it is
// the check with the most leverage per second of runtime.
//
// Deliberately not asserted here: the full review round trip. Driving hunk's
// TUI to author a note means typing into another program's text editor on a
// timer, and a flaky test is worse than an absent one. That path is covered by
// the harness described in docs/diff-panel.md.
//
// Skipped rather than failed when tmux or hunk is missing — neither must ever
// be the reason a clean checkout can't run its tests.

const TMUX = Bun.which("tmux");
const HUNK = Bun.which("hunk");

/** This machine's hunk help text, for the one assertion that depends on its age. */
const HUNK_HELP = HUNK ? Bun.spawnSync([HUNK, "diff", "--help"]).stdout.toString() : "";
const SOCKET = `jmux-hunk-int-${process.pid}`;

const DAEMON = `http://${process.env.HUNK_MCP_HOST || "127.0.0.1"}:${process.env.HUNK_MCP_PORT || 47657}`;

const scratch: string[] = [];

function killServer(): void {
  if (!TMUX) return;
  try {
    Bun.spawnSync([TMUX, "-L", SOCKET, "kill-server"], { stdout: "ignore", stderr: "ignore" });
  } catch {}
  // Same cleanup boot-smoke does, for the same reason: kill-server leaves the
  // socket file behind, and the name carries this run's pid.
  try {
    rmSync(join(process.env.TMUX_TMPDIR || `/tmp/tmux-${process.getuid?.() ?? 0}`, SOCKET), { force: true });
  } catch {}
}

afterAll(() => {
  killServer();
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

function git(args: string[], cwd: string): void {
  Bun.spawnSync(["git", ...args], { cwd, stdout: "ignore", stderr: "ignore" });
}

/** A repo with one commit and uncommitted work, so hunk has something to show. */
function scratchRepo(): string {
  // realpath, because on macOS tmpdir() sits under a symlinked /var and the
  // daemon reports the resolved path — comparing the two never matches.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "jmux-hunk-repo-")));
  scratch.push(dir);
  git(["init", "-q", "-b", "main"], dir);
  git(["config", "user.email", "t@example.com"], dir);
  git(["config", "user.name", "t"], dir);
  writeFileSync(join(dir, "app.ts"), "export const a = 1;\nexport const b = 2;\n");
  git(["add", "-A"], dir);
  git(["commit", "-qm", "init"], dir);
  writeFileSync(join(dir, "app.ts"), "export const a = 1;\nexport const b = 22;\nexport const c = 3;\n");
  writeFileSync(join(dir, "new.ts"), "export const brand = 'new';\n");
  return dir;
}

async function daemonAction(body: object): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(`${DAEMON}/session-api`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(2000),
    });
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

describe.skipIf(!TMUX || !HUNK)("hunk control plane, against a real jmux", () => {
  test(
    "jmux's own hunk registers with the daemon and is findable by pid",
    async () => {
      const repo = scratchRepo();
      // A scratch HOME is what isolates the run: jmux resolves its config
      // through homedir(), so XDG_CONFIG_HOME alone still reads the developer's
      // real config and their live tracker adapters.
      const home = mkdtempSync(join(tmpdir(), "jmux-hunk-home-"));
      scratch.push(home);
      mkdirSync(join(home, ".config", "jmux"), { recursive: true });

      let exitCode: number | null = null;
      const pty = new Terminal(
        process.execPath,
        ["run", join(import.meta.dir, "..", "main.ts"), "-L", SOCKET, "hunkint"],
        {
          name: "xterm-256color",
          cols: 180,
          rows: 45,
          env: {
            ...process.env,
            HOME: home,
            TERM: "xterm-256color",
            // Empty, not deleted: the child inherits the parent's environment,
            // and jmux refuses to start inside another jmux.
            JMUX: "",
            TMUX: "",
            TMUX_PANE: "",
          },
          cwd: repo,
        },
      );
      // Behave like a terminal with a white background: answer jmux's OSC 11
      // probe. Light on purpose — a dark answer is indistinguishable from every
      // way this can fail, since no reply, an unparsed reply and hunk's own
      // auto-fallback all end at a dark theme too. Only a light terminal proves
      // the detected background actually reached hunk's argv.
      //
      // Answered every time rather than once, because jmux re-probes to follow
      // a live theme switch, and a real terminal keeps replying.
      // Consumed as it is answered, exactly once per probe. Leaving a matched
      // probe in the carry re-answers it on every subsequent frame, and jmux
      // strips only the *first* reply out of a read — the rest reach the input
      // router as raw escape bytes and eventually type something.
      const PROBE = "\x1b]11;?";
      let carry = "";
      pty.onData((chunk: string) => {
        let rest = carry + chunk;
        for (let at = rest.indexOf(PROBE); at !== -1; at = rest.indexOf(PROBE)) {
          pty.write("\x1b]11;rgb:ffff/ffff/ffff\x07");
          rest = rest.slice(at + PROBE.length);
        }
        // Bounded: only enough to rejoin a probe split across two reads.
        carry = rest.slice(-PROBE.length);
      });
      pty.onExit((e: { exitCode: number }) => { exitCode = e.exitCode; });

      try {
        // Boot: config load, tmux spawn, control-mode attach, first frame.
        await Bun.sleep(6000);
        expect(exitCode).toBeNull();

        // A scratch HOME means a first run, which paints the setup surface over
        // everything and swallows the chord below. Esc twice to clear it.
        pty.write("\x1b");
        await Bun.sleep(500);
        pty.write("\x1b");
        await Bun.sleep(1200);

        // Ctrl-Space g opens the panel. One byte at a time — the router matches a
        // single anchored report per read and silently drops merged chunks.
        for (const ch of "\x00g") {
          pty.write(ch);
          await Bun.sleep(80);
        }
        await Bun.sleep(5000);

        const list = await daemonAction({ action: "list" });
        const sessions = (list?.sessions ?? []) as Array<Record<string, unknown>>;
        const mine = sessions.find((s) => s.repoRoot === repo || s.cwd === repo);

        // The daemon knows the process jmux spawned. Matched on the repo here
        // because the test can't see jmux's pty child pid — jmux itself matches
        // on pid, which is the only selector that stays exact when several
        // sessions share a repo and dead ones linger for 45s.
        expect(mine).toBeDefined();

        // Launched with the flags jmux believes it uses. `--watch` is what keeps
        // the panel honest while an agent edits; without it the panel is a
        // snapshot from whenever it opened.
        const ps = Bun.spawnSync(["ps", "-Ao", "pid,args"]).stdout.toString();
        const line = ps.split("\n").find((l) => l.trim().startsWith(String(mine!.pid))) ?? "";
        expect(line).toContain("--watch");
        expect(line).toContain("--transparent-bg");

        // And the theme jmux resolved from the white background it was told
        // about above. This is the assertion hunk's own `--theme auto` cannot
        // satisfy: its startup query dies in a one-way pty feed, so it would
        // land on the dark fallback here. Gated on this hunk having the flag,
        // for the same reason jmux gates passing it — an older binary failing
        // this would be a fact about the binary, not about jmux.
        if (HUNK_HELP.includes("--theme")) {
          expect(line).toContain("--theme github-light-default");
        }

        // And it resolved the working tree, which is what the badge reports.
        const files = (mine!.files ?? []) as Array<{ path: string }>;
        expect(files.map((f) => f.path).sort()).toEqual(["app.ts", "new.ts"]);

        expect(exitCode).toBeNull();
      } finally {
        try { pty.kill(); } catch {}
        killServer();
      }
    },
    45_000,
  );
});
