# Connecting Linear, GitLab and GitHub

Connect an issue tracker and a code host and the info panel (`Ctrl-Space g`) gains
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
| `issueTracker` | `linear` | Issue tabs, ghost rows, capture (`Ctrl-Space a`), status writes, `Ctrl-Space u` |
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
and `Ctrl-Space a` / `jmux ctl issue create` to file an issue. A read-only key works
fine if you never use those.

### GitLab

A personal access token with the **`api`** scope
([gitlab.com/-/user_settings/personal_access_tokens](https://gitlab.com/-/user_settings/personal_access_tokens)).
Any of three names works — checked in this order:

```bash
export GITLAB_TOKEN="glpat-..."
# or GITLAB_PRIVATE_TOKEN, or GITLAB_PERSONAL_ACCESS_TOKEN
```

**Or don't.** With none of them set, jmux runs `glab auth status -t` and uses
the token the [GitLab CLI](https://gitlab.com/gitlab-org/cli) already holds. If
`glab` works in your shell, you need no export at all.

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

---

## 2. Name your adapters

Settings (`Ctrl-Space I` — capital I) → **Integrations** → set **Code host** and
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

## 3. Restart jmux

**Adapters are the one setting that does not hot-reload.** A live adapter owns
polling state and in-flight requests, so jmux builds them once at startup and
the config watcher deliberately leaves them alone. Change the row in settings
and it reads `linear · restart to apply` until you relaunch — that note is the
row telling you the value is stored but not yet in force.

Everything else in `config.json` — sidebar width, colors, panel views, the whole
workflow pipeline — applies immediately.

---

## 4. Check it worked

Press `Ctrl-Space g`. You should see more than the lone **Diff** tab: an issues tab
if the tracker connected, **My MRs** and **Review** if the code host did.

**Tabs appear only for a slot that authenticated.** If a tracker fails, its tabs
are removed from the strip rather than shown empty — which is why "no Issues tab
at all" is the symptom to look for, not an error message.

For a direct answer, open `Ctrl-Space I` → **Diagnostics**:

| Row | Reads |
|-----|-------|
| **Tracker states available** | `25 states` (working) · `none reported` (connected, nothing came back) · `tracker not connected` (no adapter, or auth failed) |
| **Parking status** | whether anything is configured to park, and how many sessions are parked now |

---

## Troubleshooting

**Authentication is token-presence only.** Neither adapter makes a network call
at startup — a token that exists is a token jmux uses, deliberately, so a
transient blip at launch can't permanently disable the integration. The
consequence: **an expired or wrong-scoped token still reports connected.** It
shows up as tabs that exist and stay empty, not as an auth error.

| What you see | Likely cause |
|---|---|
| No Issues tab at all | No `issueTracker` in config; or you set it and haven't restarted; or no `LINEAR_API_KEY` in the environment jmux was launched from |
| No MR tabs at all | Same three, for `codeHost` and its token |
| Tabs exist but stay empty | Token found but rejected (expired, wrong scope), or nothing matches the tab's filter — try `F` in the panel to widen it |
| Tabs were there, now they're gone | A 401/403 mid-session disables that adapter until restart |
| Everything stalls, then recovers | Rate limit (HTTP 429). Active polling drops to 60s, background and global polling pause, and it resumes on its own — see [Polling & rate limits](issue-tracking.md#polling--rate-limits) |
| MR shows `0 of 0` approvals on GitHub | Token isn't admin on the repo, so branch protection is invisible. Expected; the rest of the MR is fine |
| Self-hosted host 404s everything | `url` is missing its `/api/v4` (GitLab) or `/api/v3` (GitHub Enterprise) |
| `n` on an issue opens a directory picker | The issue's team isn't in `teamRepoMap` — see [Team-to-repo mapping](issue-tracking.md#team-to-repo-mapping) |
| Settings row says `restart to apply` | Exactly what it says: config written, process still running the old adapter |

Auth failures and API errors are logged to `~/.config/jmux/jmux.log`. A startup
auth failure also writes one line to stderr, which the alt-screen usually
swallows — the log is the reliable copy.

---

## Next

- [Issue tracking](issue-tracking.md) — the panel, its keys, session linking, and starting work from an issue
- [Workflow](workflow.md) — your own stages over your tracker's statuses, parking, `Ctrl-Space u`, and status writes
- [Configuration](configuration.md) — everything else in `config.json`
