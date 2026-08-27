import { afterAll, describe, expect, test } from "bun:test";
import { Terminal } from "bun-pty";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// Does turning the user's tmux config off actually turn it off?
//
// The unit tests either side of this cover the halves: tmux-user-config.test.ts
// resolves a value to a path, tmux-conf.test.ts asserts the loader is gated on
// $JMUX_USER_CONF. Neither can see the glue between them — main.ts reading
// config.json, resolving, and exporting the variable *before* tmux starts — and
// main.ts is the one file no unit test can import. That is the same gap the
// diff panel and graphics-passthrough integration tests exist for, and it is
// the gap where "every test passed and the feature did nothing" lives.
//
// The probe is a tmux option set by the scratch HOME's own tmux config: it is
// present on the server if and only if jmux sourced that file.
//
// Skipped rather than failed when tmux is missing, like boot-smoke.

const TMUX = Bun.which("tmux");
const PROBE = "@jmux-user-conf-probe";
const sockets: string[] = [];

function killServer(socket: string): void {
  if (!TMUX) return;
  try {
    Bun.spawnSync([TMUX, "-L", socket, "kill-server"], { stdout: "ignore", stderr: "ignore" });
  } catch {}
  // kill-server leaves the socket file behind when the server is already gone.
  try {
    rmSync(join(process.env.TMUX_TMPDIR || `/tmp/tmux-${process.getuid?.() ?? 0}`, socket), {
      force: true,
    });
  } catch {}
}

afterAll(() => sockets.forEach(killServer));

function serverUp(socket: string): boolean {
  const out = Bun.spawnSync([TMUX!, "-L", socket, "list-sessions"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return out.exitCode === 0;
}

function showProbe(socket: string): string {
  const out = Bun.spawnSync([TMUX!, "-L", socket, "show-option", "-gqv", PROBE], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return new TextDecoder().decode(out.stdout).trim();
}

/**
 * Boot jmux against a scratch HOME and report what the server ended up with.
 *
 * `userTmuxConfig` is written into the scratch config.json exactly as a user
 * would write it — the point is to exercise the read, not to inject a resolved
 * value past it.
 */
async function bootWith(
  label: string,
  confs: Record<string, string>,
  userTmuxConfig?: string | false,
): Promise<{ probe: string; alive: boolean; up: boolean }> {
  const home = mkdtempSync(join(tmpdir(), `jmux-userconf-${label}-`));
  const socket = `jmux-userconf-${label}-${process.pid}`;
  sockets.push(socket);

  for (const [rel, body] of Object.entries(confs)) {
    const path = join(home, rel);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, body);
  }

  mkdirSync(join(home, ".config", "jmux"), { recursive: true });
  writeFileSync(
    join(home, ".config", "jmux", "config.json"),
    JSON.stringify(userTmuxConfig === undefined ? {} : { userTmuxConfig }),
  );

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    TERM: "xterm-256color",
    JMUX: "",
    TMUX: "",
    TMUX_PANE: "",
  };
  // Set every XDG root explicitly. bun-pty merges the supplied environment
  // with its parent on some runtime versions, so deleting a key here can let
  // the developer's real XDG_CONFIG_HOME leak back into the child process.

  let exitCode: number | null = null;
  const pty = new Terminal(
    process.execPath,
    ["run", join(import.meta.dir, "..", "main.ts"), "--socket", socket],
    { name: "xterm-256color", cols: 120, rows: 40, env },
  );
  pty.onExit((e: { exitCode: number }) => {
    exitCode = e.exitCode;
  });

  // Wait for the *server*, not for the probe. Polling until a probe appears
  // would make every negative case burn the whole timeout, and worse, would
  // read an empty option off a server that had not started yet and call that
  // proof the config was not sourced — the one thing this test must not do.
  // The config is loaded once, when the server starts, so a server that answers
  // has already made its decision.
  let up = false;
  for (let i = 0; i < 80 && exitCode === null; i++) {
    await Bun.sleep(250);
    up = serverUp(socket);
    if (up) break;
  }
  const probe = showProbe(socket);

  const alive = exitCode === null;
  try {
    pty.kill();
  } catch {}
  killServer(socket);
  rmSync(home, { recursive: true, force: true });
  // `up` is asserted by every case, including the negative ones: without it,
  // "the probe is empty" is equally consistent with a server that never
  // started, and the tests that matter most would pass proving nothing.
  return { probe, alive, up };
}

describe("userTmuxConfig end to end", () => {
  test.skipIf(!TMUX)(
    "unset sources ~/.tmux.conf, as it always has",
    async () => {
      const result = await bootWith("dot", { ".tmux.conf": `set -g ${PROBE} dot\n` });
      expect(result).toEqual({ probe: "dot", alive: true, up: true });
    },
    40_000,
  );

  // The location tmux itself documents alongside ~/.tmux.conf, and which jmux
  // ignored for its whole life — so a user living here had no config applied
  // and would have been handed an off switch for something never on.
  test.skipIf(!TMUX)(
    "unset falls through to the XDG location",
    async () => {
      const result = await bootWith("xdg", {
        ".config/tmux/tmux.conf": `set -g ${PROBE} xdg\n`,
      });
      expect(result).toEqual({ probe: "xdg", alive: true, up: true });
    },
    40_000,
  );

  // The feature. A present, readable ~/.tmux.conf that jmux declines to source.
  test.skipIf(!TMUX)(
    "false sources nothing even though the file is right there",
    async () => {
      const result = await bootWith("off", { ".tmux.conf": `set -g ${PROBE} dot\n` }, false);
      expect(result).toEqual({ probe: "", alive: true, up: true });
    },
    40_000,
  );

  test.skipIf(!TMUX)(
    "a configured path wins over the auto-detected one",
    async () => {
      const result = await bootWith(
        "explicit",
        { ".tmux.conf": `set -g ${PROBE} dot\n`, "alt.conf": `set -g ${PROBE} alt\n` },
        "~/alt.conf",
      );
      expect(result).toEqual({ probe: "alt", alive: true, up: true });
    },
    40_000,
  );

  // The refusal that matters: falling back to auto-detect here would source a
  // different file than the one named, silently. jmux must start regardless —
  // a bad path is a warning, not a boot failure.
  test.skipIf(!TMUX)(
    "a configured path that is absent sources nothing and still boots",
    async () => {
      const result = await bootWith(
        "missing",
        { ".tmux.conf": `set -g ${PROBE} dot\n` },
        "~/gone.conf",
      );
      expect(result).toEqual({ probe: "", alive: true, up: true });
    },
    40_000,
  );
});
