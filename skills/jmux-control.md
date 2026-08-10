---
name: jmux-control
description: Control jmux sessions, windows, and panes programmatically. Dispatch Claude Code instances, monitor their progress, and interact with them. Use when inside a jmux-managed tmux session ($JMUX=1).
---

# jmux Agent Control

You are inside a jmux-managed tmux session. You can create sibling sessions,
dispatch other Claude Code instances, monitor their progress, and interact
with them using the `jmux ctl` CLI.

All commands output JSON to stdout. Errors output JSON to stderr.

## Detection

Check `$JMUX` — if it's `1`, you're inside jmux and these commands work.
If not set, you're outside jmux and most commands require explicit `--session` flags.

## Quick Reference

| Command | Purpose |
|---------|---------|
| `jmux ctl session list` | List all sessions |
| `jmux ctl session create --name N --dir PATH` | Create new session |
| `jmux ctl session info --target NAME` | Session details |
| `jmux ctl session kill --target NAME` | Kill a session |
| `jmux ctl session rename --target NAME --name NEW` | Rename a session |
| `jmux ctl session switch --target NAME` | Switch to a session |
| `jmux ctl run-claude --name N --dir PATH --message "..."` | Launch Claude Code |
| `jmux ctl window list` | List windows in current session |
| `jmux ctl window create` | Create new window |
| `jmux ctl window select --target @ID` | Switch to a window |
| `jmux ctl window kill --target @ID` | Kill a window |
| `jmux ctl pane list` | List panes in current window |
| `jmux ctl pane split --direction h` | Split pane horizontally |
| `jmux ctl pane split --direction v` | Split pane vertically |
| `jmux ctl pane send-keys --target %ID text here` | Type into a pane |
| `jmux ctl pane capture --target %ID` | Read pane contents |
| `jmux ctl pane kill --target %ID` | Kill a pane |
| `jmux ctl status` | One-shot snapshot of the whole workspace |
| `jmux ctl agent state [--session N] [--all]` | Structured agent state (running/waiting/complete) |
| `jmux ctl agent watch [--session N] [--all]` | Stream agent state changes as JSONL |
| `jmux ctl session attention set --target N [--reason "..."]` | Flag a session as needing the human |
| `jmux ctl session attention clear --target N` | Clear the attention flag |
| `jmux ctl issue create --title T [--description D] [--team T] [--start]` | File a new issue; `--start` also provisions the session |
| `jmux ctl issue start <issue-id> [--repo P] [--wait [sec]]` | Start (or resume) work for an issue. Returns immediately; worktree setup continues in a pane |
| `jmux ctl issue get <issue-id>` | Fetch issue details from the tracker |
| `jmux ctl issue move <issue-id> <status>` | Move an issue along the workflow |
| `jmux ctl issue link <session> <issue-id>` | Add an issue to a session (a session may carry several) |
| `jmux ctl issue unlink <session> [issue-id]` | Remove one issue link, or all of them |
| `jmux ctl workflow stages` | The workflow stages and their counts |
| `jmux ctl workflow board [--stage ID]` | Every stage with its sessions and unstarted work |
| `jmux ctl workflow next [--start]` | The next thing to pick up (`Ctrl-a u`) |
| `jmux ctl workflow statuses` | Every tracker status: its stage, whether it parks |
| `jmux ctl browser list` | Browser panes, their tabs and current URLs |
| `jmux ctl browser open <url>` | Point a browser at a URL, or open one beside you |
| `jmux ctl browser action -- <cmd>` | Drive the browser — snapshot, click, fill, eval |

## Global Flags

| Flag | Description |
|------|-------------|
| `--session NAME` | Target session (default: current session from env) |
| `--socket NAME` / `-L NAME` | tmux server socket (default: from `$TMUX`) |

## Conventions

1. **Use returned names.** Session names are sanitized (`.` and `:` become `_`).
   Always use the `name` field from the JSON response, not your original input.

2. **Use IDs from responses.** Capture `id`, `pane`, `window` fields from
   create/list responses and pass them as `--target` in later commands.

3. **Don't kill what you didn't create.** Only kill sessions/panes you spawned.
   Kill commands refuse to destroy your own session/pane without `--force`.

4. **Prefer structured state over pane scraping.** To know whether an agent is
   working, waiting for permission, or done, read `jmux ctl agent state` or
   `jmux ctl status` — never grep `pane capture` output for a shell prompt.
   Reach for `pane capture` only when you need the actual screen *text* (e.g. to
   read what an agent wrote), not to infer lifecycle.

   For *what the work is* rather than *what the agents are doing* — which issue a
   session is on, which stage it sits in, what hasn't been picked up — use
   `jmux ctl workflow`. `status` is the flat session list; `workflow` is the same
   sessions arranged the way the human's sidebar arranges them.

5. **Parse JSON.** All output is structured JSON. Don't regex it.

## Orchestration

These commands expose jmux's higher-level work model so an orchestrator can
dispatch, monitor, and clean up work **without scraping panes**. All read
directly from tmux, so they work whether or not the jmux TUI is running (pass
`--socket`/`-L` when outside a session).

### `status` — one snapshot of the whole workspace

A single cheap command that answers "what work exists and what needs me?":

```bash
jmux ctl status
```

Each session reports its agent state, linked issue/MR, branch, attention flag,
and pinned state. This is the right command for a heartbeat / work-radar loop.

### `agent state` — is the agent running, waiting, or complete?

```bash
jmux ctl agent state --session TRA-123   # one session
jmux ctl agent state --all               # every session (default with no flag)
```

State comes from the same source the sidebar uses — the `@jmux-agent-state`
tmux option set by Claude Code's hooks — so it reflects lifecycle exactly:

- `running` — the agent is actively working.
- `waiting` — the agent is blocked on a permission prompt (needs input).
- `complete` — the agent finished its turn.
- `null` — no agent (e.g. a plain shell), or hooks not installed.

`ageSeconds` tells you how long it's been in that state — useful for spotting a
stale/stuck session (e.g. `running` for an implausibly long time).

### `agent watch` — react to transitions without a poll loop

```bash
jmux ctl agent watch --session TRA-123    # stream one session
jmux ctl agent watch --all                # stream all sessions
```

Emits one JSON object **per line** (JSONL) on every state change, until you
SIGINT it. Use it instead of a `pane capture` polling loop:

```bash
jmux ctl agent watch --session TRA-123 | while read -r event; do
  state=$(echo "$event" | jq -r .state)
  case "$state" in
    waiting)  echo "Agent needs permission" ;;
    complete) echo "Agent done"; break ;;
  esac
done
```

### `workflow` — the work pipeline

jmux models work as **stages** the user defined (`Ctrl-a W`), each sitting on top
of one or more of the tracker's own statuses. Stage order is priority order. A
session belongs to the stage that claims its linked issue's status; an issue in a
stage with no session yet is **unstarted** work anyone can pick up.

`workflow` is how you read that model. It is derived from the config file, tmux
and the tracker — the same sources the sidebar uses — so it works whether or not
the TUI is running. It needs a configured tracker.

```bash
jmux ctl workflow stages                     # the stage table + counts
jmux ctl workflow board                      # + each stage's sessions and unstarted work
jmux ctl workflow board --stage in-progress  # one stage
jmux ctl workflow next                       # what to pick up next
jmux ctl workflow next --start               # ...and start it
jmux ctl workflow statuses                   # every status: its stage, whether it parks
```

**Reach for `stages` first.** It is `board` without the item arrays, which is
usually all you need to decide what to do next; pull `board` when you actually
need the rows, and `board --stage <id>` when you only care about one.

Key fields:

- `counts.sessions` / `counts.parked` / `counts.unstarted` / `counts.issues` —
  per stage. `issues` is everything in the stage; `unstarted` is the subset with
  no session.
- `upNextRank` — the stage's place in the `Ctrl-a u` rotation, or `null` if it
  isn't in it. `workflow next` walks that order and returns the top item of the
  first non-empty stage.
- `ungrouped` — sessions with no issue, or whose status no stage claims. These
  are ordinary work, not an error state; they are the flat list below the bands
  in the sidebar.
- `parked` — a session on the back burner (its status is one the user marked as
  parking, or it was parked by hand, or it has no issue and has been idle past
  `autoParkIdleDays`). It is a **field on the session, not a separate bucket**,
  because parking keys off the status rather than the stage. Filter it out when
  you are looking for live work.
- `inSidebar` / `showsUnstarted` / `unstartedCap` — what the *human* currently
  sees. `unstarted` is always the full list; `unstartedCap` is how many of them
  per stage their sidebar is showing (`0` = none, `"all"` = every one). Use these
  when you need to talk about what is on their screen.

### `issue move` — hand work on

```bash
jmux ctl issue move TRA-123 "In Review"
```

Writes the status back to the tracker. Matching is case-insensitive and the
tracker's canonical spelling is returned; a status the issue cannot move to is
rejected with the list of ones it can. The result is read back after the write,
so `moved` means the issue actually moved, not that the request was sent. Moving
an issue to a status it is already on is a no-op (`moved: false`, no write).

This is a **write to a shared team tracker** — use it for your own work when you
genuinely finish a step, not to tidy up someone else's board. Run
`workflow statuses` first if you don't know the workspace's status names.

### Attention — flag a session for the human

Mark a session as needing Jarred **only** when there's a real decision: a
blocker, a failed verification, a permission wait, or a review gate.

```bash
jmux ctl session attention set --target TRA-123 --reason "tests fail; needs a call"
jmux ctl session attention clear --target TRA-123
```

The flag and reason surface in `jmux ctl status` (`attention` / `attentionReason`).

## Patterns

### Fan-Out: Dispatch N agents and wait on structured state

```bash
# Spawn agents
result1=$(jmux ctl run-claude --name task-auth --dir /repo --message "Fix auth bug in src/auth.ts")
result2=$(jmux ctl run-claude --name task-tests --dir /repo --message "Add tests for src/utils.ts")
session1=$(echo "$result1" | jq -r .session)
session2=$(echo "$result2" | jq -r .session)

# Monitor via agent state — no pane scraping
while true; do
  states=$(jmux ctl agent state --all | jq -r \
    --arg a "$session1" --arg b "$session2" \
    '.agents[] | select(.session==$a or .session==$b) | .state')
  if ! echo "$states" | grep -qv complete; then
    echo "Both agents finished"
    break
  fi
  sleep 5
done
```

### Pipeline: Chain agents sequentially

```bash
# Step 1: dispatch first agent
result=$(jmux ctl run-claude --name analyze --dir /repo --message "Analyze the auth module and write findings to /tmp/analysis.md")
session=$(echo "$result" | jq -r .session)

# Step 2: block until it completes, reacting to the JSONL stream
jmux ctl agent watch --session "$session" | while read -r event; do
  [ "$(echo "$event" | jq -r .state)" = "complete" ] && break
done

# Step 3: feed its output to the next agent
jmux ctl run-claude --name refactor --dir /repo --message-file /tmp/analysis.md
```

### Interact: Send follow-up to a running agent

```bash
# Send a follow-up prompt (Enter is sent by default)
jmux ctl pane send-keys --target %12 "Now refactor the auth middleware"

# Send without pressing Enter (build up partial input)
jmux ctl pane send-keys --target %12 --no-enter "partial text"

# Send multiline content from a file
jmux ctl pane send-keys --target %12 --file /tmp/instructions.md
```

### Monitor: Check what's on screen

```bash
# Capture visible pane content (plain text, ANSI stripped)
jmux ctl pane capture --target %12

# Include scrollback (up to 1000 lines above visible)
jmux ctl pane capture --target %12 --lines 200

# Raw capture with ANSI escape codes preserved
jmux ctl pane capture --target %12 --raw
```

### `browser` — use the web

A browser pane is a real Chromium rendered into the terminal. You can read a
page, click through it, fill forms and evaluate JavaScript in it.

```bash
jmux ctl browser list
jmux ctl browser open https://localhost:3000
jmux ctl browser action -- snapshot
jmux ctl browser action -- click @e14
jmux ctl browser action -- fill @e3 "hello"
jmux ctl browser action -- eval "document.title"
```

`action` passes everything after `--` straight to terminal-browser's
agent-browser CLI, so its vocabulary is that tool's, not jmux's — `snapshot`
returns an accessibility tree whose entries carry `[ref=e14]` handles, and
`click`/`fill` take those as `@e14`. Flags and quoted arguments survive
verbatim, so `eval "a + b"` arrives as one argument.

**Go through `jmux ctl browser`, not `terminal-browser` directly.** jmux gives
each browser pane a private runtime directory so that two panes do not render
the same page, and terminal-browser's registry lives inside it — so
`terminal-browser ls` run from your pane finds nothing at all. jmux recorded
which directory belongs to which pane and is the only thing that can point the
CLI at the right one.

With no `--pane`, commands target the nearest browser: same window, then same
session, then anywhere. `jmux ctl browser list` gives you pane ids for `--pane`
when several are open.

`open` navigates a browser that already exists rather than opening a second one;
pass `--new` to insist on a new pane. A new pane is split off *your* pane, so
you can show the human something in your own workspace and cannot rearrange a
session you are not in.

If nothing is installed, `open` says so and how to install it — that is a
message for the human, not something to work around.

## Response Shapes

### session list
```json
{"sessions": [{"id": "$1", "name": "my-project", "windows": 3, "attached": true, "activity": 1712678400, "path": "/path/to/project", "title": "Fix stale cache headers"}]}
```
`title` is the model-generated display phrase, present only once one has been
generated. `name` is still the real tmux session name — use it to address the
session with any other `session`/`pane`/`window` subcommand.

### session create / run-claude
```json
{"session": "fix-auth-bug", "pane": "%12", "claude_command": "claude", "command_dispatched": true}
```

### session info
```json
{"id": "$1", "name": "my-project", "windows": 2, "attached": true, "path": "/path", "title": "Fix stale cache headers", "windows_detail": [{"id": "@1", "index": 0, "name": "claude", "active": true, "zoomed": false, "bell": false}]}
```

### pane capture
```json
{"target": "%8", "content": "$ claude\n\nHello! How can I help?\n\n> "}
```

### status
```json
{
  "sessions": [
    {
      "id": "$1", "name": "TRA-123", "path": "/repo/worktree",
      "branch": "TRA-123-fix-auth",
      "agent": { "state": "running", "since": 1781480000, "ageSeconds": 123 },
      "links": [{ "type": "issue", "id": "TRA-123" }, { "type": "mr", "id": "5812" }],
      "attention": false, "attentionReason": null, "pinned": false
    }
  ]
}
```
`agent` is `null` when there's no agent in the session. `branch` is `null` if the path isn't a git repo.

### agent state
```json
{"agents": [{"session": "TRA-123", "sessionId": "$1", "state": "running", "since": 1781480000, "ageSeconds": 123, "agentPane": "%12", "activePane": "%12", "path": "/repo/worktree", "kind": "claude"}]}
```
`agentPane` is the pane actually running the agent (set by its emitter) — target it for `pane send-keys`. It is `null` if no agent has reported yet (re-run `jmux --install-agent-hooks`); fall back to `activePane`, which is the session's active pane and can drift after splits.

`state` is rolled up across the session's panes: `waiting` beats `running` beats `complete`, so a session running two agents reports the one that most needs attention. `kind` (`claude` / `codex` / `pi`, or `null` for an unrecognised reporter) tells you which agent produced that state. Note pi never reports `waiting` — its API exposes no permission event, so a pi pane blocked on you still shows `running`.

### agent watch (one JSON line per change)
```json
{"type": "agent_state_changed", "session": "TRA-123", "state": "waiting", "since": 1781480000}
```

### session attention set / clear
```json
{"target": "TRA-123", "attention": true, "reason": "tests fail; needs a call"}
```

### issue start
```json
{
  "session": "tra-123", "pane": "%12", "cwd": "/repo/tra-123", "issue": "TRA-123",
  "reused": false,
  "transition": {"moved": true, "from": "To do", "to": "In Progress", "status": "In Progress"},
  "provisioning": {"ready": false, "pane": "%13", "worktree": "/repo/tra-123", "note": "…"}
}
```
This is the same flow as the human pressing `n` in the issues panel or Enter on
a sidebar ghost row — same session name, same worktree, same two-pane layout,
same tracker move. It provisions *into* a session rather than before one, so it
**returns in about a second even when setup takes minutes**:

1. the session is created with the agent in the main pane, waiting;
2. a 30% setup pane runs the worktree tool (`wtm create`, or `git worktree add`)
   beside it;
3. the agent starts by itself the moment the worktree lands.

**`cwd` is where the worktree *will* be, not where it is.** Until
`provisioning.ready` is true that directory may not exist. Do not `cd` into it,
`git -C` it, or send keys to the session expecting a repo — the session is
alive but its main pane is still parked in the wait loop.

Three ways to handle that, in order of preference:

- **Don't wait.** The agent launches itself with the issue prompt already
  seeded. If your job was "kick this off", you are done — return the session
  name and move on.
- **`--wait [seconds]`** (default 300) blocks until setup finishes and returns
  `{"ready": true, "waited": true}`. Always bounded: a timeout comes back as
  `{"ready": false, "timedOut": true}` with the session still live and still
  provisioning. **A timeout is not a failure** — do not kill the session or
  retry the command over it. Note `ready` means *the worktree landed*, not that
  the agent is up: the main pane notices within ~200ms and launches then. If
  you need the agent running (rather than just the directory), check
  `jmux ctl agent state --session <name>` — do not send keys on `ready` alone
  or they land in the shell before the agent starts.
- **Poll `jmux ctl status`.** When setup *fails*, the setup pane raises the
  session's attention flag, so `status` reports
  `attention: true, attentionReason: "worktree setup failed"`. The pane stays
  open on the tool's own error — `jmux ctl pane capture --target <session>.1`
  reads it. This is the only way to learn about a failure you didn't wait for.

`transition` reports the tracker move that a human's start also fires (the
repo's `onSessionStartState`). `moved: false` with a `reason` is normal and
never fatal — the session is real either way, and a tracker write failing is
not a reason to throw away a successful start.

`reused: true` means nothing was provisioned and an existing session is returned
as-is. Two ways that happens, and you don't need to tell them apart: a session
already carries the issue's link, **or** a live session already sits on the name
this issue resolves to — which is what jmux itself creates. So `issue start` is
safe to call blind: it starts, resumes, or hands back, and never duplicates.

A session on that name already carrying *other* issues is not a collision: the
issue is appended and the session is returned. One session can carry several
issues, which is how a feature filed as several tickets gets one branch and one
merge request.

It does **not** switch the human's view to the new session. Starting work in the
background must not move somebody's cursor.

### issue link / unlink
An issue belongs to at most one session, but a session can carry any number.
`link` therefore *appends* — it errors only when the issue is already linked
somewhere else, and is a no-op when the pair already exists. `issues` is the
session's full list after the write.
```json
{"session": "feat-bulk-import", "issue": "TRA-456", "issues": ["TRA-123", "TRA-456"], "repo": "/repo", "linked": true}
```

`unlink` takes an optional issue id: with one, only that link goes; without one,
every link on the session does.
```json
{"session": "feat-bulk-import", "unlinked": ["TRA-456"], "issues": ["TRA-123"]}
```

### issue move
```json
{"issue": "TRA-123", "from": "In Progress", "to": "MR Review", "moved": true, "status": "MR Review"}
```

### workflow stages
```json
{
  "stages": [
    {
      "id": "in-progress", "label": "In Progress", "rank": 3,
      "statuses": ["In Progress", "In Review", "MR Review"],
      "inSidebar": true, "showsUnstarted": true, "upNextRank": null,
      "counts": { "issues": 11, "sessions": 2, "parked": 0, "unstarted": 9 }
    }
  ],
  "ungrouped": 17,
  "upNext": { "stageId": "todo", "stageLabel": "To do", "issue": { "identifier": "TRA-1647", "…": "…" } },
  "unstartedCap": 10
}
```

### workflow board
Same, plus the rows. `ungrouped` is an array here rather than a count.
```json
{
  "stages": [
    {
      "id": "in-progress", "label": "In Progress", "…": "…",
      "sessions": [
        {
          "id": "$4", "name": "tra-1610-planning-page-500s", "path": "/repo/tra-1610-planning-page-500s",
          "branch": "tra-1610-planning-page-500s",
          "agent": { "state": "running", "since": 1781480000, "ageSeconds": 123 },
          "attention": false, "attentionReason": null, "pinned": false, "parked": false,
          "issue": { "id": "uuid", "identifier": "TRA-1610", "title": "…", "status": "MR Review",
                     "priority": 2, "team": "Core Engineering", "url": "https://linear.app/…" }
        }
      ],
      "unstarted": [{ "identifier": "TRA-1622", "title": "…", "status": "In Progress", "…": "…" }]
    }
  ],
  "ungrouped": [{ "name": "dotfiles", "issue": null, "…": "…" }],
  "upNext": { "…": "…" },
  "unstartedCap": 10
}
```

### workflow next
```json
{"upNext": {"stageId": "todo", "stageLabel": "To do", "issue": {"identifier": "TRA-1647", "…": "…"}}, "started": null}
```
`upNext` is `null` when the rotation is empty or every queue in it is — an
ordinary answer, not an error. With `--start`, `started` carries the
`issue start` result.

### workflow statuses
```json
{"statuses": [{"name": "QA (RELEASE BR)", "type": "started", "stage": {"id": "waiting", "label": "Waiting"}, "parks": true, "issues": 8}]}
```
`stage` is `null` for a status no stage claims — it simply won't appear in the
panel. `parks` and `stage` are independent: a status can park while belonging to
no stage, which is the right answer for something like **Done**.

## Limitations

- `agent watch` streams real-time state transitions (JSONL). For raw screen *text*, `pane capture` remains a point-in-time snapshot.
- `session switch` only works from inside tmux (not from external processes).
- `run-claude` confirms the command was dispatched, not that Claude actually started — check `agent state` to confirm it began.
- The CLI does not manage tmux config, keybindings, or display settings.
- `issue get` / `issue move` / `issue start` and every `workflow` command need a configured tracker (`LINEAR_API_KEY` or `LINEAR_TOKEN`). `issue start` resolves the repo from `--repo` or `issueWorkflow.teamRepoMap`, creates the worktree with the same tool the TUI would (`wtm` or `git worktree add`) at `<repo>/<session>`, links it via the `@jmux-linear-issue` tmux option, and (unless `--no-launch-agent`) launches Claude with the issue context. When a tracker is configured, an issue id that doesn't resolve is rejected (no silent worktree for a typo); only with no tracker configured does `issue start` proceed offline, and only when `--repo` is given explicitly.
- `workflow` sees a session's issue through explicit links (both stores) and the derived session name — the same resolution the sidebar uses. A session whose issue is reachable only by traversing its branch's merge request appears under `ungrouped`; that traversal costs an API call per session, which a one-shot command doesn't make.
- `parked` in `workflow board` is a conservative superset of what the sidebar shows. Four of the five unpark triggers (a new comment, MR activity, a red pipeline, a state regression) are edges measured against a baseline captured when the session parked, and that history lives in the running TUI's memory. The `agent-attention` trigger and idle auto-park are read from tmux and are exact. So a session the human's sidebar has already pulled back out may still read as `parked` here — never the reverse.
- `session attention` survives jmux TUI restarts. (Older builds cleared `@jmux-attention` on every launch; that cleanup is now a one-time-per-tmux-server legacy migration, so orchestrator-set flags persist.)
