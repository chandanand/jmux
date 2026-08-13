import type { TmuxRunner, TmuxRunResult } from "./deps";

export class ProductionTmuxRunner implements TmuxRunner {
  constructor(private readonly socketName: string | null = null) {}

  async run(
    args: string[],
    opts?: { timeoutMs?: number },
  ): Promise<TmuxRunResult> {
    const full = this.socketName ? ["-L", this.socketName, ...args] : args;
    const proc = Bun.spawn(["tmux", ...full], {
      stdout: "pipe",
      stderr: "pipe",
      // Read live, not inherited. `Bun.spawn` without this passes the
      // environment as it was when *jmux* started, and both variables the tmux
      // config expands are assigned at runtime by main.ts: `$JMUX_DIR`, which
      // `tmux.conf` uses to find defaults.conf and core.conf, and
      // `$JMUX_USER_CONF`, which gates whether the user's own tmux config is
      // sourced at all.
      //
      // This runner is a server-*starting* path — restore.ts passes `-f` on
      // "the very first new-session ... (the one that actually starts the
      // server)" — and `-f` is honored only there. So without this, restoring a
      // snapshot brings up a server that silently sourced neither jmux's
      // defaults nor its requirements: `/config/defaults.conf` does not exist,
      // `status off` never runs, and the tmux status bar comes straight back.
      // Exactly the failure documented in demo/setup.ts, on a different path.
      env: { ...process.env },
    });
    const timeoutMs = opts?.timeoutMs ?? 5000;
    const killer = setTimeout(() => {
      proc.kill();
    }, timeoutMs);
    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      return { stdout, stderr, exitCode };
    } finally {
      clearTimeout(killer);
    }
  }
}
