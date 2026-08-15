# The Diff panel

The Diff tab runs [hunk](https://github.com/modem-dev/hunk) in a pty jmux owns
and composites into the info panel. hunk 0.17 added a local session daemon, and
that is what turns the panel from a viewer into a review loop: hunk knows the
notes you write on a hunk, jmux knows which pane is running the agent that wrote
the code, and nothing else in the system knows both.

## The loop

1. `Ctrl-Space g` opens the panel on the current session's working tree. The tab
   reads `Diff +142 −38`.
2. `c` in the panel writes a note on the hunk under the cursor. The tab picks up
   a `●2` count.
3. `Ctrl-Space r` shows exactly what will be sent and to which pane. Enter types it
   into the agent as a single paste.
4. The sent notes are deleted from hunk, so `●N` always means *written but not
   sent yet* rather than *notes exist*.

`Ctrl-Space v` repoints the panel: working tree (with or without untracked files),
staged, the last commit, or `base...HEAD` — everything the branch has added
since it forked, which is usually the whole of an agent's work rather than
whatever happens to be uncommitted.

## How it connects

`hunk daemon serve` runs a loopback HTTP daemon that every hunk TUI registers
with. jmux uses three parts of it:

| Endpoint | Used for |
| --- | --- |
| `GET /session-api/capabilities` | the on switch — `{version, daemonVersion, actions[]}` |
| `POST /session-api` `{action:"list"\|"get"}` | diff stats and review notes |
| `POST /session-api` `{action:"comment-list"\|"comment-rm"\|"navigate"}` | the review send |

Host and port come from `HUNK_MCP_HOST` / `HUNK_MCP_PORT`, the same variables
hunk itself reads, so the two agree when a user moves the port.

Six things about this are load-bearing and easy to undo by accident.

- **The control plane is optional, and off is a path that already ships.** No
  daemon, an older hunk, or `diffPanel.controlPlane: false` all land on exactly
  the behaviour the panel had before any of this existed — a hunk pty and
  nothing more. There is no third, degraded mode to keep working.

- **Sessions are matched by pid, never by repo.** The pid the daemon reports for
  a hunk jmux spawned is exactly the pty child pid. Repo matching looks
  equivalent and isn't: the daemon keeps dead sessions for 45 seconds, and
  several worktrees routinely resolve to one repo root, so `--repo` is both
  stale-prone and ambiguous. Resolution is retried for ~3s after spawn, because
  the daemon is started *by* the TUI and isn't listening yet on a cold start.

- **Content changes by respawning hunk, never by `hunk session reload`.** Reload
  is cheaper and wrong: once it retargets a session, `--watch` stops firing, so
  the panel goes quietly stale while an agent keeps editing. A visible respawn
  beats a panel that lies. This is also why one mechanism covers both session
  switches and view switches.

- **Flags are probed, not assumed.** Not every hunk takes the same options —
  0.9 has `--watch` but not `--transparent-bg`, and passing it one it doesn't
  know makes it exit before drawing a frame, leaving the panel showing nothing
  but "Diff viewer closed". jmux reads `hunk diff --help` once per binary and
  passes only what it saw. A missing *presentation* flag is dropped silently; a
  missing *content* flag (`--staged`, `--exclude-untracked`) refuses the view
  instead, because substituting the working tree for the staged diff would show
  you something you didn't ask for.

- **jmux does not manage hunk's layout.** `--mode auto` already re-lays out
  live on resize, and jmux resizes the diff pty on every relayout and drag, so
  narrow-vs-wide is handled better than jmux could do it.

- **jmux does manage hunk's theme, because hunk cannot detect it here.** The
  two presentation flags passed are `--transparent-bg` and `--theme`, and the
  second exists because of the first: with the surface transparent, hunk's text
  is drawn straight onto *jmux's* background, so a dark theme over a light
  terminal is unreadable rather than merely mismatched.

  hunk has its own answer to this — `--theme auto` queries the terminal
  background at startup — and it cannot work inside the panel. hunk runs in a
  pty whose output jmux feeds to a headless xterm, and that feed is one-way:
  nothing ever writes back to the pty, so the query gets no reply and `auto`
  takes its "terminal didn't answer" fallback, which is dark. That is the wrong
  half of the choice on precisely the terminals the flag is for.

  So jmux resolves the name itself. It ran the same OSC 11 probe against the
  real terminal at boot and already holds the answer, so it passes
  `github-light-default` or `github-dark-default` — the ids hunk's own `auto`
  resolves to — and `diffPanel.theme` overrides that with a fixed id, or with
  `false` to pass nothing and leave hunk's config in charge. Before the probe
  answers there is no way to tell "dark terminal" from "no reply yet", so jmux
  passes nothing rather than commit hunk to a guess for the panel's lifetime.

  hunk reads the theme only at startup, so a light/dark switch while the panel
  is open respawns it — but only when the *resolved* name actually changes,
  since a respawn costs the user hunk's scroll position.

- **Notes are deleted by id, one at a time.** The bulk clear would also delete
  notes written between jmux reading the list and the send finishing. Losing a
  note the user just typed is silent and unrecoverable, so the slower call is
  the correct one.

The tab strip normally hides itself when Diff is the only tab, since a lone
unlabelled tab is pure chrome. It is shown when the badge has something to
report — otherwise the stats would be invisible to exactly the users who have
no tracker configured, which is everyone on their first run.

## For agents

`jmux --install-skill` installs hunk's own `hunk-review` skill alongside
jmux's, with a short jmux-specific addendum. An agent in a jmux session can then
navigate the diff its human is reading (`hunk session navigate`) and leave its
own inline notes (`hunk session comment apply`). Notes an agent writes are
tagged `agent` and are never included in `Ctrl-Space r` — echoing an agent's own
notes back at it would be a loop carrying no new information.

## Settings

```json
"diffPanel": {
  "splitRatio": 0.4,
  "hunkCommand": "hunk",
  "watch": true,
  "transparentBg": true,
  "controlPlane": true,
  "clearNotesOnSend": true
}
```

`theme` is deliberately absent: unset, jmux passes the light or dark hunk theme
matching the terminal background it detected at startup. Set an id
(`"catppuccin-mocha"`, `"zenburn"`, …) to pin one regardless of the terminal, or
`false` to pass none and let hunk's own config decide.

## Testing

`src/__tests__/hunk-integration.test.ts` boots a real jmux and asserts the
handshake: the flags hunk is launched with, and jmux finding its own session on
the daemon. It skips when tmux or hunk is missing.

`scripts/review-loop-e2e.ts` covers the rest of the loop — writing a note in the
panel, the confirm modal, the paste into the agent pane, the clear, and the view
picker. It lives outside the suite because those steps are timed against another
program's TUI. Run it by hand when changing `src/hunk/` or the diff-panel wiring
in `main.ts`:

```bash
bun run scripts/review-loop-e2e.ts
```
