import { afterAll, describe, expect, test } from "bun:test";
import { rmSync } from "fs";
import { join } from "path";
import { ProductionTmuxRunner } from "../../snapshot/runner";

// Does the tmux this runner starts inherit jmux's *live* environment?
//
// This runner is a server-starting path: restore.ts passes `-f` on "the very
// first new-session ... (the one that actually starts the server)", and `-f` is
// honored nowhere else. The config it loads expands two variables that main.ts
// assigns at *runtime* — `$JMUX_DIR`, which locates defaults.conf and
// core.conf, and `$JMUX_USER_CONF`, which decides whether the user's own tmux
// config is sourced at all.
//
// `Bun.spawn` without an explicit `env` passes the environment as it was when
// the process started, so a runtime assignment is invisible to it. That is not
// a hypothetical: it is asserted below, because it is the entire reason the
// runner has to spread `process.env` and the thing a future edit would quietly
// undo. When it was undone, restoring a snapshot brought up a server that had
// silently sourced neither jmux's defaults nor its requirements — the status
// bar came back and nothing said why.

const TMUX = Bun.which("tmux");
const SOCKET = `jmux-runner-env-${process.pid}`;
const PROBE = "JMUX_RUNNER_ENV_PROBE";

function killServer(): void {
  if (!TMUX) return;
  try {
    Bun.spawnSync([TMUX, "-L", SOCKET, "kill-server"], { stdout: "ignore", stderr: "ignore" });
  } catch {}
  try {
    rmSync(join(process.env.TMUX_TMPDIR || `/tmp/tmux-${process.getuid?.() ?? 0}`, SOCKET), {
      force: true,
    });
  } catch {}
}

afterAll(killServer);

describe("ProductionTmuxRunner environment", () => {
  // The premise. If Bun ever starts reading process.env live at spawn time this
  // fails, and the runner's explicit spread becomes redundant rather than
  // load-bearing — which is worth being told about rather than discovering.
  test("Bun.spawn without an explicit env cannot see a runtime assignment", async () => {
    process.env[PROBE] = "live";
    const proc = Bun.spawn(["sh", "-c", `printf '%s' "$${PROBE}"`], { stdout: "pipe" });
    expect(await new Response(proc.stdout).text()).toBe("");
  });

  test.skipIf(!TMUX)(
    "a server this runner starts carries variables jmux set at runtime",
    async () => {
      killServer();
      process.env[PROBE] = "live";

      const runner = new ProductionTmuxRunner(SOCKET);
      const created = await runner.run(["new-session", "-d", "-s", "probe"]);
      expect(created.exitCode).toBe(0);

      // tmux seeds its global environment from the client that started the
      // server, so this reports what that process actually handed over.
      const shown = await runner.run(["show-environment", "-g", PROBE]);
      expect(shown.stdout.trim()).toBe(`${PROBE}=live`);

      killServer();
    },
    20_000,
  );
});
