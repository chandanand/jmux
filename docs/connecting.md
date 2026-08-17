# Connecting Linear, GitLab and GitHub

Connect an issue tracker and a code host and the info panel (`Ctrl-a g`) gains
tabs for your issues, your merge requests, and the ones waiting on your review —
plus pipeline glyphs in the sidebar and the one-keystroke
[issue-to-session flow](issue-tracking.md#issue-to-session-workflow).

This page is the whole setup. Once it works, [Issue tracking](issue-tracking.md)
covers what the panel does and [Workflow](workflow.md) covers shaping it around
your own process.

---

## What connects to what

jmux has two independent slots. Fill either, both, or neither.

| Slot | Options | What it drives |
|------|---------|----------------|
| `issueTracker` | `linear` | Issue tabs, ghost rows, capture (`Ctrl-a a`), status writes, `Ctrl-a u` |
| `codeHost` | `gitlab`, `github` | MR/PR tabs, review queue, approvals, pipeline glyphs |

They're independent: a tracker with no code host gives you issue tabs and no MR
tabs, and vice versa. A slot you leave unset simply contributes no tabs.

**GitHub is a code host only.** There is no GitHub Issues tracker — pair GitHub
with Linear, or run it alone for pull requests.

> **Just want to see it?** `jmux --demo` runs the whole panel against mock data.
> No tokens, nothing written anywhere. It's the fastest way to know what a
> working setup should look like before you go get credentials.

---

## 1. Get a token

### Linear

Create a personal API key at
[linear.app/settings/api](https://linear.app/settings/api) and export it as
either name — jmux checks `LINEAR_API_KEY` first, then `LINEAR_TOKEN`:

```bash
export LINEAR_API_KEY="lin_api_..."
```

jmux reads issues, teams, workflow states and comments. It **writes** only for
things you explicitly turn on or press: `s` to change a status,
[transitions](workflow.md#transitions-writes-to-your-tracker) (off by default),
and `Ctrl-a a` / `jmux ctl issue create` to file an issue. A read-only key works
fine if you never use those.

### GitLab

A personal access token with the **`api`** scope
([gitlab.com/-/user_settings/personal_access_tokens](https://gitlab.com/-/user_settings/personal_access_tokens)).
Any of three names works — checked in this order:

```bash
export GITLAB_TOKEN="glpat-..."
# or GITLAB_PRIVATE_TOKEN, or GITLAB_PERSONAL_ACCESS_TOKEN
```

**Or don't.** With none of them set, jmux runs
`glab config get token --host <your instance>` and uses the token the
[GitLab CLI](https://gitlab.com/gitlab-org/cli) already holds. If `glab` works
in your shell, you need no export at all.

### GitHub

A token with the **`repo`** scope (needed for pull requests, check runs and
reviews on private repos). `GH_TOKEN` is checked first, then `GITHUB_TOKEN`:

```bash
export GH_TOKEN="ghp_..."
```

**Or don't.** With neither set, jmux runs `gh auth token` and uses whatever the
[GitHub CLI](https://cli.github.com/) is logged in as.

One thing degrades quietly: the **required-approvals count** comes from the
branch's protection rule, which the API only exposes to repo admins. Without
admin the request 403s, jmux treats that as "no gate" and shows `0` required.
Everything else on the MR is unaffected.

Put the export in your shell profile (`~/.zshrc`, `~/.bashrc`) — jmux reads the
environment of the process you launch it from, so a token exported in one pane
after jmux started is not visible to it.

### Or store it in jmux, and stop thinking about the environment

Both slots take a token directly, checked before it is saved and written to
`~/.config/jmux/credentials.json` at mode 0600:

| Slot | Where |
|---|---|
| Issue tracker | The setup flow (`Ctrl-a p` → **Setup**), tracker step |
| Code host | `Ctrl-a I` → **Integrations** → **Code host token** |

A stored token beats the environment, so this is also the fix for the case
that reads as jmux ignoring you: `$GITLAB_TOKEN` exported in your profile but
jmux launched from somewhere that never sourced it — the MR tabs are simply
absent, because a tab whose adapter is not connected is not drawn. The
**Code host token** row says which source is actually in force (`stored in
jmux`, `$GITLAB_TOKEN`, or `not stored`), and tells you when a stored token is
shadowing an environment variable you set.

---

## 2. Name your adapters

Settings (`Ctrl-a I` — capital I) → **Integrations** → set **Code host** and
**Issue tracker**. Or edit `~/.config/jmux/config.json`:

```jsonc
{
  "adapters": {
    "codeHost": { "type": "gitlab" },   // or "github", or omit
    "issueTracker": { "type": "linear" } // or omit
  }
}
```

### Self-hosted GitLab

Add the full API base — including `/api/v4`, which is not appended for you:

```jsonc
{ "adapters": { "codeHost": { "type": "gitlab", "url": "https://gitlab.example.com/api/v4" } } }
```

### GitHub Enterprise Server

Same idea, with `/api/v3`. The GraphQL endpoint is derived from it, so you set
one value:

```jsonc
{ "adapters": { "codeHost": { "type": "github", "url": "https://github.example.com/api/v3" } } }
```

`$GITHUB_ENTERPRISE_URL` does the same job if you'd rather keep it in the
environment. The `url` field wins if both are present.

---

## 3. Apply it

**From the settings rows, immediately.** Changing **Code host**, **Issue
tracker** or **Code host token** builds the replacement, authenticates it, and
publishes it only if it works — so a bad token can never displace a connection
that was already fine. The row then reports what happened: your organization
when it connected, or why it didn't.

**From a hand-edited `config.json`, on restart.** The config watcher deliberately
leaves live adapters alone — one owns polling state and in-flight requests — so
an `adapters` block you edit in the file is picked up next launch. Everything
else in that file still applies immediately.

---

## 4. Check it worked

Press `Ctrl-a g`. You should see more than the lone **Diff** tab: an issues tab
if the tracker connected, **My MRs** and **Review** if the code host did.

**Tabs appear only for a slot that authenticated.** If a tracker fails, its tabs
are removed from the strip rather than shown empty — which is why "no Issues tab
at all" is the symptom to look for, not an error message.

For a direct answer, open `Ctrl-a I` → **Diagnostics**:

| Row | Reads |
|-----|-------|
| **Tracker states available** | `25 states` (working) · `none reported` (connected, nothing came back) · `tracker not connected` (no adapter, or auth failed) |
| **Parking status** | whether anything is configured to park, and how many sessions are parked now |

---

## Troubleshooting

**A token is probed, not merely counted.** Each adapter makes one identity
request at startup, so a revoked or wrong-scoped token reports `not connected`
rather than sitting there looking healthy. A *network* failure is kept separate
from a *rejection* — `unreachable` is retried on the next poll, `failed` is not —
so a blip at launch can't permanently disable the integration.

The consequence to know: **an adapter that isn't connected contributes no tabs
at all.** No Issues tab and no MR tabs is what a bad token looks like, not an
error dialog. The reason is written to `~/.config/jmux/jmux.log` and shown as a
toast at startup, and the **Integrations** rows in `Ctrl-a I` state it at any
time.

| What you see | Likely cause |
|---|---|
| No Issues tab at all | No `issueTracker` in config, or its token was rejected. `Ctrl-a I` → **Integrations** says which |
| No MR tabs at all | Same, for `codeHost` — most often a token that is exported in your profile but absent from the environment jmux was actually launched from. Store it in jmux instead (above) |
| Tabs exist but stay empty | The adapter is connected and nothing matches the tab's filter — try `F` in the panel to widen it |
| Tabs were there, now they're gone | A 401/403 mid-session disables that adapter until restart |
| Everything stalls, then recovers | Rate limit (HTTP 429). Active polling drops to 60s, background and global polling pause, and it resumes on its own — see [Polling & rate limits](issue-tracking.md#polling--rate-limits) |
| MR shows `0 of 0` approvals on GitHub | Token isn't admin on the repo, so branch protection is invisible. Expected; the rest of the MR is fine |
| Self-hosted host 404s everything | `url` is missing its `/api/v4` (GitLab) or `/api/v3` (GitHub Enterprise) |
| `n` on an issue opens a directory picker | The issue's team isn't in `teamRepoMap` — see [Team-to-repo mapping](issue-tracking.md#team-to-repo-mapping) |
| Settings row says `restart to apply` | Exactly what it says: config written, process still running the old adapter |

Auth failures and API errors are logged to `~/.config/jmux/jmux.log`. A startup
auth failure also raises a toast and writes one line to stderr; stderr is
usually swallowed by the alt-screen, so the log is the reliable copy.

---

## Next

- [Issue tracking](issue-tracking.md) — the panel, its keys, session linking, and starting work from an issue
- [Workflow](workflow.md) — your own stages over your tracker's statuses, parking, `Ctrl-a u`, and status writes
- [Configuration](configuration.md) — everything else in `config.json`
