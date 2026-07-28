# Agent Integration

jmux shows live state for every coding agent you have running — `RUNNING`,
`WAITING`, `COMPLETE` — one badge per agent pane, plus an elapsed timer. It
supports Claude Code, Codex CLI and pi out of the box, and a screen-reading
fallback for anything else.

## Quick Setup

```bash
jmux --install-agent-hooks
```

This detects which agents are installed on your machine and sets each one up.
Agents you don't have are skipped.

```
Claude Code: installed
  Restart Claude Code in any open session to pick the hooks up.
Codex CLI: installed
  Enabled [features] hooks = true in ~/.codex/config.toml.
  Codex will ask you to approve these hooks the first time you launch it.
  Until you approve them, Codex sessions report no state.
pi: not installed on this machine — skipped
```

Re-running it is safe: agents already up to date report `already up to date` and
nothing is written.

## What each agent reports

| Agent | Mechanism | `RUNNING` | `WAITING` | `COMPLETE` |
| --- | --- | :-: | :-: | :-: |
| Claude Code | hooks in `~/.claude/settings.json` | ✓ | ✓ | ✓ |
| Codex CLI | hooks in `~/.codex/hooks.json` | ✓ | ✓ | ✓ |
| pi | extension in `settings.extensions` | ✓ | — | ✓ |
| anything else | screen signatures (opt-in) | depends | depends | depends |

**pi never shows `WAITING`.** Its extension API exposes no permission-request
event, so that state is unobservable rather than merely unimplemented. jmux
declares this rather than inventing a state — a pi pane sitting on `RUNNING`
while it waits on you is a limitation of pi's API, not a stuck detection.

### Codex needs two extra things

Codex gates its hook engine behind a feature flag, and requires you to trust
each hook before it will run:

1. `jmux --install-agent-hooks` adds `[features] hooks = true` to
   `~/.codex/config.toml` for you. If it can't edit the file safely it prints
   the lines to add instead of risking a malformed config.
2. The first time you launch Codex afterwards it will ask you to approve the
   jmux hooks. **Until you approve, Codex sessions report no state.** jmux
   deliberately does not forge the `trusted_hash` entries that approval writes —
   that would be making a security decision on your behalf.

## The protocol

State lives in tmux user options, so *anything* can report state to jmux — a
hook, an extension, a CI callback, a shell script:

| Option | Scope | Meaning |
| --- | --- | --- |
| `@jmux-agent-state` | pane | `running`, `waiting` or `complete` |
| `@jmux-agent-state-since` | pane | epoch seconds; drives the elapsed timer |
| `@jmux-agent-kind` | pane | which agent (`claude`, `codex`, `pi`) |
| `@jmux-agent-pane` | session | the pane to send keys to |

Reporting from your own tooling is one command:

```bash
tmux set-option -p -t "$TMUX_PANE" @jmux-agent-state waiting \; \
     set-option -p -t "$TMUX_PANE" @jmux-agent-state-since "$(date +%s)"
```

Hooks run inside the tmux session, so plain `tmux` targets the right server
automatically — this works whether or not you started jmux with `-L`.

### Why pane-scoped

State is set on the **pane**, not the session. A session that hosts two agents
in a split would otherwise have them clobber each other, last writer wins. jmux
rolls a session's panes up for the sidebar: `waiting` beats `running` beats
`complete`, and ties go to the *earliest* timestamp so the timer tracks the
agent that has been going longest.

Older setups that wrote session-scoped options still work — a pane with no value
of its own inherits the session's, and the rollup collapses that back to exactly
the old behaviour. Claude Code and Codex promote themselves to pane scope on
their next tool call.

## Screen detection (opt-in)

For agents with no hook or extension support, jmux can read the pane and match
its text against per-agent patterns. This is off by default, because unlike a
hook — which reports a transition the agent actually made — a screen signature
can be confidently wrong.

```json
{
  "agentScreenDetection": true,
  "agentScreenSignatures": [
    {
      "command": "aider",
      "waiting": ["\\(Y\\)es/\\(N\\)o"],
      "running": ["Applying edit"],
      "complete": ["^> $"]
    }
  ]
}
```

`command` is matched against the pane's foreground process; the state patterns
are case-insensitive regexes matched against the visible pane text. Your entries
take precedence over the built-in table.

Two rules keep this contained:

- It **never overrides an agent that reports for itself.** On a pane that has
  declared `@jmux-agent-kind`, screen detection may only fill states that agent
  is structurally incapable of reporting.
- Derived states are marked `@jmux-agent-source screen`, so a guess is always
  distinguishable from a fact.

The built-in signature table is deliberately thin. A pattern is only shipped
once it has been read off a real terminal — an unverified pattern produces a
confident wrong answer instead of an honest blank.

## Verifying it actually works

Unit tests cover the emitter text, the installer and the rollup. They cannot
cover the link that matters most — whether a real agent actually invokes the
emitter — because that link spans two projects and breaks silently. An upstream
rename of a hook event leaves every test green and the sidebar blank.

```bash
bun run verify:agents          # all agents
bun run verify:agents codex    # just one
```

This drives the real binaries in an isolated tmux server against a sandboxed
config home, and asserts the states actually observed. It costs one trivial
model call per phase, so it is a manual gate rather than part of `bun test`.

Each hook-based agent runs in two phases, because a one-shot run is over in
seconds and `Stop` → `SessionEnd` fire back to back:

- **turn** — `SessionEnd` suppressed so `complete` survives long enough to see.
  Proves `running → complete`.
- **teardown** — full install. Proves `SessionEnd` clears state on exit.

Without that split, `complete` exists for under 25ms and no sampler catches it,
which is indistinguishable from a broken `Stop` hook.

An agent that cannot authenticate in the sandbox is reported as `SKIP`, not
`FAIL` — it never takes a turn, so `Stop` legitimately never fires. Claude Code
hits this most often because its real credentials live in the macOS Keychain.

## Agent Control CLI

`jmux ctl` exposes the same state as JSON, for agents orchestrating other
agents:

```bash
jmux ctl agent state                    # every session, rolled up
jmux ctl agent state --session fix-auth # one session
jmux ctl agent watch                    # JSONL stream of transitions
```

```json
{"agents":[{"session":"fix-auth","sessionId":"$3","state":"waiting",
  "since":1781480050,"ageSeconds":42,"agentPane":"%7","activePane":"%7",
  "path":"/repo/wt","kind":"codex"}]}
```

`kind` tells you which agent produced the winning state — useful when a session
runs more than one. `agentPane` is the pane to target with `pane send-keys`; it
stays correct after splits, unlike `activePane`.

jmux ships a [skill](../skills/jmux-control.md) that agents auto-discover when
`$JMUX=1`. See `jmux ctl --help` for the full reference.

## Attention flags

Separate from agent state, any tool can raise an orange `!` on a session:

```bash
tmux set-option -t deploy @jmux-attention 1     # from anywhere
jmux ctl session set-attention --target deploy  # from inside jmux
```

jmux clears it automatically when you switch to that session.

| Indicator | Meaning | Triggered by |
| --- | --- | --- |
| Green `●` | New output since you last looked | Automatic (tmux activity timestamp) |
| Orange `!` | Something explicitly needs you | `@jmux-attention` |
| State badge | What the agent is doing | `@jmux-agent-state` |
