# Opting out of the user's tmux config

## The problem

jmux's tmux config layering is three-tier (`config/tmux.conf`):

```
config/defaults.conf   ← jmux opinionated baseline
~/.tmux.conf           ← user overrides
config/core.conf       ← jmux requirements, sourced LAST, always wins
```

`core.conf` holds only the six settings jmux needs to function, and deliberately
so. Everything else jmux ships is presentation the user is invited to override —
`pane-border-status`, the window and pane styles, the status-bar block, the
terminal overrides. A user with an elaborate `~/.tmux.conf` therefore gets that
config applied inside jmux, and its chrome lands on top of jmux's own: border
title rows, plugin status lines, whatever else the file turns on. Observed on a
colleague's machine as extra bars in the jmux UI.

There is no way to say "don't".

## What this is not

Not a re-layering. Step 3 already wins on everything jmux genuinely requires,
and moving presentation settings into `core.conf` would take away overrides that
are working for people who want them. The layering stays exactly as it is; step
2 gains a switch.

## The value

```jsonc
// ~/.config/jmux/config.json
"userTmuxConfig": false                    // source nothing
"userTmuxConfig": "~/.jmux.tmux.conf"      // source this instead
// unset                                    // auto-detect
```

`string | false`, unset meaning auto-detect. **The value is the switch** — there
is no companion boolean that could disagree with it, the same construction as
`diffPanel.theme` (`string | false`), `sessionTitle.command` and
`pipeline.showUnstartedInSidebar`.

A path is admitted rather than a bare boolean because the interesting middle
case exists and costs nothing: a user who wants their own tmux setup everywhere
*except* inside jmux points jmux at a second file. A boolean would force them to
choose between their whole config and none of it.

### Auto-detect resolves what tmux itself resolves

`man tmux`: the user configuration file is at "`~/.tmux.conf` or
`$XDG_CONFIG_HOME/tmux/tmux.conf`". jmux checks `~/.tmux.conf` and stops. So a
user whose config lives at the XDG path has it silently ignored today — and
would gain an off switch for something that was never on.

Auto-detect therefore takes the first that exists, in tmux's own order:

1. `~/.tmux.conf`
2. `${XDG_CONFIG_HOME:-~/.config}/tmux/tmux.conf`

**This is a behaviour change on upgrade, not only a new setting.** A user with an
XDG-located tmux config goes from "ignored" to "applied" — new prefix, new binds,
possibly the very chrome this feature exists to remove. It belongs in the release
notes. It ships anyway, because a switch named "source the user's tmux config"
that consults one of the two documented locations encodes a second, invisible
rule that its own name denies; that is discovered later as "the off switch works
but the on switch doesn't". The resolution is one ordered list inside one pure
function, which is the cheapest place in the system to be correct.

## Resolution — `src/tmux-user-config.ts`

A new pure module. Nothing in it touches the filesystem or the environment
directly:

```ts
export type UserTmuxConfig =
  | { kind: "source"; path: string }    // source this
  | { kind: "disabled" }                 // configured false
  | { kind: "missing"; path: string }    // configured a path that is not there
  | { kind: "none" };                    // auto-detect found nothing

export function resolveUserTmuxConfig(
  value: string | false | undefined,
  env: { home: string; xdgConfigHome?: string },
  exists: (path: string) => boolean,
): UserTmuxConfig;
```

`exists` and `env` are injected so the table is testable without a home
directory. `~` in a configured path is expanded here, since a user editing JSON
by hand will write one and no shell is involved.

**A configured path that is not on disk falls through to not sourcing, never to
auto-detect.** Quietly sourcing a different file than the one you named is worse
than sourcing none: it is a wrong answer given confidently, where the other is an
honest nothing. `missing` warns to stderr *and* `jmux.log`, deduped by message —
the same treatment `resolveTitleConfig` gives a malformed `sessionTitle.command`,
and for the same reason: a hot reload can raise it after the alt screen has taken
the terminal.

`none` is distinct from `disabled` so the settings row can say which is true.

The module also owns the settings row's parse/format pair, because the row is
built in `main.ts` and nothing in `main.ts` is reachable by a unit test:

```ts
export function formatUserTmuxConfig(r: UserTmuxConfig): string;   // display
export function editableUserTmuxConfig(v, r): string;              // round-trip
export function parseUserTmuxConfig(input: string): string | false | undefined;
```

## The wire — `$JMUX_USER_CONF`

`config/tmux.conf` step 2 becomes:

```tmux
if-shell '[ -n "$JMUX_USER_CONF" ]' 'source-file -q "$JMUX_USER_CONF"'
```

`main.ts` exports `process.env.JMUX_USER_CONF` — the resolved path, or empty for
every other resolution — alongside `JMUX_DIR` and `JMUX_COPY`.

Both halves of this are mechanisms the file already depends on. tmux expands
`$VAR` in a config file at config-load time against the server's environment,
which is inherited from the client that started it — that is how
`source-file "$JMUX_DIR/config/defaults.conf"` works today. `if-shell`'s shell
inherits the same environment — that is how `defaults.conf`'s `C-a y` reaches
`$JMUX_COPY`. And `if-shell` without `-b` blocks the command queue (`man tmux`:
"if-shell and run-shell [stop execution of subsequent commands] until a shell
command finishes"), so `core.conf` still lands last.

`source-file -q` guards the window between jmux's `exists` check and tmux
reading the file. It is not the error path: a configured-but-absent path is
reported from TypeScript, where there is a human to tell.

*Rejected:* materialize an empty sentinel `.conf` and point `JMUX_USER_CONF` at
it when disabled, so step 2 could be an unconditional `source-file` with no
shell at all. Elegant, but an unset variable then makes tmux source `""`, and
the conf is a file other people run by hand.

### Ordering

`materializeAssets()` runs at `main.ts:343` and `configStore` is constructed at
`main.ts:452`. The export goes immediately after `configStore`, which is still
thousands of lines ahead of the PTY spawn — nothing between 452 and there starts
a tmux server.

The one exception is demo mode, which *starts* a server at `main.ts:426`, before
`configStore` exists. **Demo mode sets `JMUX_USER_CONF=""` unconditionally.** A
recording must not inherit the recorder's tmux config, and demo already writes
its own synthetic `config.json` into a temp dir, so there is no user preference
in play to respect. `setupDemo` owns the export, next to the `JMUX_DIR` handling
it already does for the same class of reason.

## Two disclosures, because the toggle is inert on a running server

`-f <config>` is honored only when tmux **starts** a server. Flipping this
setting while a server is running does nothing until `tmux kill-server`, and the
asset hash does not move when a *setting* changes — so without work, this is a
setting that can look configured and be wholly inert. That is the failure
`sectionedViewNotice` and the ghost-cap "off globally" row exist to prevent.

Both disclosures reuse machinery that already ships.

### At attach — the generation stamp

`@jmux-config-generation` becomes `<assetHash>.<confTag>`, where `confTag` is
`none` or a truncated sha256 of the resolved path — the convention `assets.ts`
already uses for the asset-bundle hash. Hashed rather than literal so the option
value has a fixed shape and carries no spaces or home directory.

`compareGeneration` splits both halves and reports which differs.
`staleGenerationNotice` then names the actual cause — a server started by a
different *version* of jmux and a server started with a different *tmux-config
setting* share one remedy (`tmux kill-server`) but are two different sentences,
and one message covering two causes is how a warning trains people to ignore it.

An unstamped server stays `unstamped`, unchanged: jmux may legitimately be the
first to attach to a server the user started, and crying wolf there was already
ruled out.

### In the settings screen — `getNote`

`SettingDef.getNote` documents itself as existing for exactly this — "a row whose
stored value is not yet the value in force (`restart to apply`)" — and is used
only by the two adapter rows. The row compares the resolution captured at boot
(a module-level const) against the live config, returning `"restart to apply"`
when they differ. This is `adapterRestartNote`'s shape: configured versus live,
no server round-trip, and it returns null the moment it stops being true so the
row can never keep asserting a stale caveat.

**Known gap, documented rather than fixed:** attach to a server some *other*
jmux started and the boot resolution is not in force either, so the row stays
quiet about a genuine divergence. The startup modal covers that case; teaching
the row to re-derive it would mean reading a stamp this process has already
overwritten.

## The settings row — a new `tmux` category

Categories today are Display, Integrations, Repo, Project, Workflow,
Diagnostics, plus the workflow screen's Parking and Unstarted work. None fits: a
user's tmux config is neither display nor an integration — it is jmux's
substrate.

A new **`tmux`** category holds the one row, `collapsed: false` like every other
category. One row is thin, but discoverability is the *only* reason this row
exists rather than living in `config.json` alone, and a user whose tmux config is
bleeding into the UI scans for "tmux" — not for a row wedged between "Max image
height" and "Auto-pin agent panes". It is also where any later tmux-layer setting
goes.

```
tmux
  Source tmux config      auto (~/.tmux.conf)      restart to apply
```

`type: "text"`, modelled on the `panel-width` row's `auto` idiom rather than on a
boolean toggle. A boolean cannot express a path, and toggling off then on would
silently destroy a configured one.

- `getValue` shows the resolution, disclosing *why* it reads as it does — the
  construction the `inline-images` row uses: `auto (~/.tmux.conf)`,
  `auto (none found)`, `off`, `~/.jmux.tmux.conf`, `~/gone.conf (not found)`.
- `getEditValue` supplies the round-trippable form (`auto`, `off`, or the bare
  path). This is precisely what that hook is documented for: the display form has
  the resolution in parentheses and does not survive being fed back in.
- `onTextCommit` accepts `off`/`none`/`false` → store `false`; `auto`/empty →
  store `undefined`; anything else → store the path verbatim.

## Tests

- **`src/__tests__/tmux-user-config.test.ts`** — the resolution table: unset with
  both files present, with neither, with XDG only; an explicit path present and
  absent; `false`. Plus the parse/format round-trip for every resolution, which
  is the settings row's logic tested without `main.ts`.
- **`src/__tests__/config-generation.test.ts`** — extend for the two-part stamp,
  a version-only difference, a conf-only difference, both, and the
  cause-specific notice text.
- **`src/__tests__/tmux-conf.test.ts`** — assert step 2 is gated on
  `$JMUX_USER_CONF`. The `.conf` files are the one part of jmux nothing in the
  type system can check, which is why that file exists; an edit that quietly
  un-gates the step would otherwise ship.
- **`src/__tests__/boot-smoke.test.ts`** — unchanged, but it is the check that
  the `if-shell` gate does not break startup, since `main.ts` cannot be
  imported.

## Docs

- `docs/configuration.md` — the setting, its three forms, and the restart
  requirement.
- `CLAUDE.md` "Config layering" — step 2 is now conditional, and why the
  disclosure is doubled.
- Release notes — the XDG auto-detect change is user-visible on upgrade.
