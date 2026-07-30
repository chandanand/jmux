# Packaging & Distribution

How jmux gets onto a machine that doesn't already have it.

Today there is exactly one channel — `bun install -g @jx0/jmux` — and it is only
reachable by someone who already installed Bun. This document plans the rest.

**Status:** built. Stages 1–4 and the formula are implemented and verified;
everything left is an action on an external service, listed under "What remains"
below. The plan was revised after an adversarial review that found ten material
defects in the first draft — every finding is addressed here, and where a
finding changed a decision, the decision says so.

### What is built and verified

| | Evidence |
| --- | --- |
| Dead keybindings removed, docs repointed | `tmux-conf.test.ts` fails on a missing referenced path |
| Linux parity (`openUrl`, clipboard) | `platform.test.ts`; conf lint rejects macOS-only binaries |
| Asset materialization | `assets.test.ts`, incl. a real 8-process `rename` race |
| `--install-skill` honoring `CLAUDE_CONFIG_DIR` | `skill.test.ts`, all four target states |
| `--uninstall-integrations` | `uninstall-hooks.test.ts` round-trips install→uninstall |
| Channel detection | `channel.test.ts`; a Homebrew Bun running source reports npm |
| Config generation | `config-generation.test.ts` + a live stale-server boot |
| **The compiled binary** | `binary-boot-smoke.test.ts`: boots under a pty, tmux sources the materialized config, survives a stale-generation server |
| CI workflow | tmux installed and asserted, so the smoke tests cannot skip silently |
| `release.sh` | five targets built and signed; `--dry-run` stops before publishing |
| Formula bumper | `bump-formula.test.ts`, incl. per-platform checksum pairing |
| **`site/install` end to end** | clean debian container with no Bun: downloads, verifies checksum, installs, runs |
| musl refusal | Alpine container asserts it refuses *and* names the npm channel |

Full suite: **2455 pass, 0 fail**; typecheck clean.

### What remains — all external actions

These cannot be done from the repo and are the only things between here and a
shipped release:

1. **Create the tap** `jarredkenny/homebrew-tap` and copy
   `packaging/Formula/jmux.rb` into it. `release.sh` skips the bump with a
   notice until it exists.
2. **Add the `/install` rewrite** so `https://jmux.build/install` serves
   `site/install` (object storage has no rewrite file; this is a CDN rule).
3. **Cut the first binary release**: write the release notes, `gh release create
   --draft`, then `./release.sh`.
4. **Apple Developer account**, if and when notarization is wanted — see D8 for
   why it is a project rather than a flag.

**Goal:** one command installs jmux on macOS and glibc Linux with no Bun on the
user's machine, over exactly two new channels — a shell installer and a
Homebrew tap. Every additional channel is permanent maintenance for a solo
project, so AUR, deb/rpm, musl and Windows are explicitly out.

---

## Ratified decisions

### D1. No Chocolatey; Windows is served by WSL, on request

jmux drives a real tmux process and tmux has no native Windows build. A choco
package could only ship something that cannot run, or a shim into WSL — an
audience the Linux artifact already covers.

### D2. Self-contained binaries

The cheap alternative — a Homebrew formula with `depends_on "bun"` wrapping the
npm install — is roughly a day of work and close to pointless: the user still
ends up with Bun on their machine, so we'd have paid for a distribution channel
and kept the dependency we were trying to shed. "No Bun" requires compiling.

### D3. The installer ships before the tap

Homebrew-core has acceptability requirements this project does not yet clear,
so the first Homebrew channel is a personal tap. A tap and a shell installer
reach a near-identical audience, but the installer *also* covers Linux from the
same artifact on day one. The tap then becomes a formula pointing at artifacts
that already exist.

### D4. The npm package keeps shipping source

`CLAUDE.md` states "no bundler, no transpile-on-publish" and `bin/jmux` imports
`src/main.ts` directly. Compiled binaries do not violate that — the invariant is
about the *npm artifact*. npm stays a source-shipping channel; the binary is a
second product with its own boot test.

### D5. Assets materialize to a content-hashed dir under `XDG_DATA_HOME`

`${XDG_DATA_HOME:-~/.local/share}/jmux/assets/<sha256-of-bundle>/`, created
mode 0700, written by building into a sibling temp dir **on the same
filesystem** and `rename`-ing it into place.

Content-hashed rather than version-keyed because a version-keyed path breaks on
dev builds and on downgrades that reuse a version string, while a hashed one is
correct in both and self-invalidates.

**Concurrency, stated properly.** `rename` onto an existing *non-empty*
directory fails with `ENOTEMPTY`/`EEXIST` — it does not atomically replace it,
so "temp dir + rename" alone is not a race-safe algorithm. The loser of the race
must treat that error as **success**, after verifying the winning directory
contains every expected file at the expected size. A verification failure means
a corrupt or partially pre-created destination, which is a hard error naming the
path, not a silent retry loop. Temp dirs from crashed runs are swept on startup
by age.

**No eviction.** Each asset set is ~23KB, so accumulation costs kilobytes.
(The first draft justified this by claiming a detached tmux server "holds" a
`source-file` path into the directory. That is false — tmux *executes*
`source-file` at server start and retains nothing. The conclusion stands on size
alone; the reason did not.)

`XDG_DATA_HOME` rather than `XDG_CACHE_HOME` because XDG says cache is
disposable at any moment, and `--install-agent-hooks` and `--install-skill` both
read from here (D7). Honor `$XDG_DATA_HOME` when set even if `HOME` is unset;
only an unset *and* underivable base directory is fatal.

### D6. The resolver has one mode, not two

Source *and* binary both materialize. A source-mode fast path that returned the
real `config/` dir unchanged would be a privileged path — the same shape
`CLAUDE.md` rejects elsewhere ("one switch, no degraded mode") — and it is
self-defeating: the binary's asset path would then be exercised only by a CI
test, while jmux run from source (the daily driver) never touched it.

`with { type: "text" }` re-reads from disk on each `bun run`, so editing
`config/*.conf` still takes effect on the next restart.

**Constraint:** `--install-agent-hooks` is handled at `main.ts:242` but `jmuxDir`
is resolved at `:365`. The resolver must be declared *above* line 242 and
materialize before that branch runs. This is exactly the temporal-dead-zone
failure `src/__tests__/boot-smoke.test.ts` exists to catch.

### D7. Materialization is uniform — all five assets

`config/tmux.conf`, `config/defaults.conf`, `config/core.conf`,
`src/agent-hooks/pi-extension.ts`, `skills/jmux-control.md`. One mechanism, one
place to look. `pi.ts`'s `piExtensionSource()` reads from the materialized dir
instead of `import.meta.dir`; the skill installer copies from there.

Only tmux — a separate process — strictly *needs* a real path, so a
split-by-consumer scheme was possible. It was rejected in favour of the single
mechanism.

### D8. macOS ships unsigned, ad-hoc re-signed. Notarization is a project, not a flag

`curl` and Homebrew formulas do not set `com.apple.quarantine`, so both shipped
channels run unsigned (measured — see Verified facts). Only a *browser* download
of a release tarball trips quarantine, and it does so brutally: SIGKILL with a
"cannot be opened, move to Trash?" dialog and no explanation.

The darwin build gets `codesign --force -s -` because Bun's compiled output
carries an ad-hoc signature that `codesign --verify` rejects (the payload is
appended after the linker signs). Re-signing is free and removes a latent
failure mode as macOS tightens.

**Correction to the first draft:** it claimed notarization would be "purely
additive — it changes artifacts, not design." That is wrong. Notarization
requires a Developer ID signature **and hardened runtime**, and hardened runtime
enforces library validation and constrains JIT. jmux embeds a Bun runtime (JIT)
and `dlopen`s bun-pty's platform dylib, which is ad-hoc signed on arm64 and
unsigned on x64 — library validation rejects both. Doing it therefore requires,
at minimum: signing or re-signing the embedded dylibs under the same Team ID,
`com.apple.security.cs.allow-jit` (and likely
`allow-unsigned-executable-memory`), possibly
`com.apple.security.cs.disable-library-validation`, a defined signing order
relative to `--compile`, notary credentials in the release path, and a test on a
genuinely quarantined machine.

It stays deferred, with that scope written down so it is not mistaken for a CI
one-liner. Until then, the browser-download caveat is documented on the release
page and the installer is the documented path everywhere.

### D9. `checkBunVersion()` stays, unconditional

`bun build --compile` embeds the *compiling* Bun's runtime, so `Bun.version`
inside a binary reports whatever the release machine built with. The check is
therefore not vacuous under compile — it catches a mis-provisioned build and
surfaces a clear error instead of `Bun.markdown.ansi is not a function` at first
render. Stripping it would mean a build-time define, a second build variant, and
a branch to test, for no user-visible benefit.

### D10. Install channel is inferred, but compiled-mode is detected first

jmux ships a live update check (`checkForUpdates()`, main.ts:5888) whose result
renders in the footer in urgent colours. Today it is channel-*uninformative* —
it shows `vX.Y.Z avail` and opens the changelog — rather than channel-*wrong*.
The improvement is telling a brew user to run `brew upgrade`.

**Correction to the first draft:** it proposed sniffing `process.execPath`
directly. Under Bun, `process.execPath` is **Bun's own executable**, not the
script or shim — so a Homebrew-installed Bun running jmux from source would be
misread as a Homebrew-installed jmux. Detection therefore runs in two steps:

1. Determine whether this is a compiled binary at all (`import.meta.dir` is
   `/$bunfs` under compile). If not, the channel is npm-or-source and the
   message is `bun install -g @jx0/jmux`.
2. Only then sniff `process.execPath`: `/opt/homebrew` or `/Cellar` →
   `brew upgrade`; otherwise → re-run the installer.

Anything unrecognised falls back to a docs URL. No installer cooperation is
required, which matters because a Homebrew formula should not write state into
`$HOME`.

### D11. Releases stay human; `./release.sh` does the mechanics

The GitHub Releases carry hand-curated titles and bodies, and those bodies are
**rendered inside jmux** as the "jmux changelog" modal (`showVersionInfo`,
main.ts:5943). Auto-generated notes would visibly degrade a shipping feature. A
tag does not trigger publication; a local script does, and the notes are written
by a person. CI is separate: it runs the suite on push and PR, and publishes
nothing.

### D12. The tmux server's config generation is checked on attach

`-f <configFile>` is honored **only when tmux starts a server**. main.ts:6663
already documents that jmux deliberately does not `source-file` after
connecting. So an upgraded jmux attaching to a server started by the *previous*
version silently runs the old keybindings and options until that server dies —
a failure the first draft's "done when tmux sources all three configs" could
never detect, because it only ever tested a fresh server.

jmux records the materialized hash on the server (`@jmux-config-generation`)
immediately after the control channel is up. On a later attach, a mismatch means
the running server predates the current config. jmux says so plainly and names
the remedy (restart the server) rather than leaving the user with silently stale
bindings.

Stage 2's boot test must therefore cover **both** paths: a fresh server, and an
attach to a server started by a different generation.

### D13. glibc only — musl is a stated non-goal; baseline x64 is shipped

Bun's `bun-linux-*` targets are glibc builds. More decisively, **bun-pty ships
no musl library at all** — its Linux natives target glibc 2.17+ and are loaded
via `dlopen` — so adding Bun's `-musl` target would produce a binary that
compiles and then dies on first pty spawn. Alpine cannot be supported by a build
flag; it would need an upstream native library that does not exist.

The installer therefore *detects* musl and refuses with an explanation naming
the npm channel as the alternative, rather than installing something that will
fail later.

Old x64 CPUs without AVX2 are a different matter and are cheap to serve, so
`bun-linux-x64-baseline` ships as a fifth artifact and the installer selects it
when `/proc/cpuinfo` lacks `avx2`. Without it those machines get an illegal
instruction and no explanation. macOS needs no baseline variant — every Mac
supported by a current macOS has AVX2.

---

## Verified facts

Measured on this machine (Bun 1.3.13, darwin arm64, jmux 0.25.0), not assumed.

| Fact | Evidence |
| --- | --- |
| `bun build --compile` succeeds on `src/main.ts` | 133 modules, ~70ms; binary runs `--version` |
| Cross-compilation works from macOS | `--target=bun-linux-x64` produced a valid `ELF 64-bit LSB executable, x86-64` |
| Binary size, darwin-arm64 | **65MB** uncompressed, **22.5MB** gzipped |
| Binary size, linux-x64 | 104MB uncompressed |
| Materialized asset set | **22,741 bytes** across five files (`core.conf` is 982 bytes) |
| `bun-pty` needs no build toolchain | ships prebuilt `librust_pty{,_arm64}.{dylib,so}` + `rust_pty.dll`, resolved via an embedded-path fallback |
| `bun-pty` has **no musl build** | Linux natives target glibc 2.17+, `dlopen`ed at runtime |
| **`import.meta.dir` breaks under compile** | resolves to `/$bunfs`; `config/tmux.conf` → `exists: false` |
| Exactly **two** compile-hostile sites exist | full sweep: `main.ts:365`, `pi.ts:28` |
| **Text embedding survives compile** | `import core from "../config/core.conf" with { type: "text" }` → correct content |
| **`pkg.version` survives compile** | it is an `import ... with { type: "json" }`, bundled at build time |
| Compiled binary signature | ad-hoc / linker-signed, but `codesign --verify` → *invalid signature* |
| Runs unquarantined | ✅ exit 0 |
| Runs **quarantined** | ❌ **SIGKILL (137)** + "move to Trash?" dialog |
| Valid ad-hoc re-sign, quarantined | ❌ still SIGKILL — ad-hoc signing does not satisfy Gatekeeper |
| `curl` does not quarantine | sets only `com.apple.provenance` |
| `-f` applies only at server start | main.ts:6663 comment; `tmux-pty.ts:12` passes `-f` on attach |
| `boot-smoke` **skips** without tmux | `test.skipIf(!TMUX)` — absence is silent, not red |
| `Dockerfile.test` is **not** a clean env | it installs Bun and `bun link`s jmux; only tmux is absent |
| `claude.ts:22-30` honors `CLAUDE_CONFIG_DIR` | with a comment naming this exact failure mode |
| Three adapters hardcode macOS `open` | github.ts:253, gitlab.ts:98, linear.ts:103 |
| There is no CI | `.github/workflows` does not exist |

### The blocker, stated precisely

`bun build --compile` collapses `import.meta.dir` to a virtual filesystem path.
That alone would be a routine embedding problem. It isn't routine because of
what `config/tmux.conf` does:

```tmux
source-file "$JMUX_DIR/config/defaults.conf"
```

**tmux is a separate process.** It cannot read `/$bunfs` under any
circumstances, and `main.ts` exports `JMUX_DIR` into its environment precisely
so tmux can resolve those paths itself.

So the assets cannot merely be *embedded* — they must be **materialized onto a
real filesystem path** before tmux is spawned. That is Stage 2, and it is an
architecture change rather than packaging glue.

---

## Pre-existing bugs found in the path of this work

### The skill has never reached a single user

`skills/jmux-control.md` ships in the npm package's `files`, and README.md:165
and docs/agent-integration.md:180 both claim agents "auto-discover" it. They
don't. Claude Code discovers skills at `<config-dir>/skills/<name>/SKILL.md`; a
bare markdown file inside a package install dir is never found. It works on
exactly one machine — this one — because of a hand-made symlink created in
April. **Fixed in Stage 2d.**

### Three keybindings point at deleted shell scripts

`config/defaults.conf` binds `m`, `i` and `r` to `$JMUX_DIR/config/*.sh` files
that do not exist — removed when their functionality moved into modals
(`ca669f0`, `4c2f0df`, `afb354b`) without cleaning up the binds. `Ctrl-a i` is
doubly dead: InputRouter's soft-prefix intercept eats it before tmux ever sees
it. All three functions already exist in the command palette (main.ts:3554-3564),
and `Ctrl-a r` / `Ctrl-a m` are documented as working in docs/cheat-sheet.md:89-90
and docs/getting-started.md:137-138. **Fixed in Stage 2a.**

### Linux is a shipping target with macOS-only code in it

- `config/defaults.conf:71` binds `y` to **`pbcopy`** — dead on Linux.
- `src/adapters/github.ts:253`, `gitlab.ts:98`, `linear.ts:103` spawn **`open`**
  — dead on Linux, so "open in browser" silently does nothing.

Shipping a Linux channel while knowingly leaving these broken contradicts the
channel's own "working install" criterion. **Fixed in Stage 2b.**

### `preflight()` never checks the tmux *version*

It checks only that `tmux -V` exits 0, so a user on tmux 2.8 passes and fails
later. It also knows `brew` and `apt` only. **Version check fixed in Stage 4;
package-manager coverage deliberately left alone.**

---

## Stage 1 — CI

**Goal:** every push and PR gets a signal that cannot silently degrade.

1. `.github/workflows/ci.yml`, on push/PR, on `ubuntu-latest` and `macos-latest`:
   install tmux explicitly (**it is not preinstalled on GitHub runners** — and
   `boot-smoke` skips silently without it), then `bun install`,
   `bun run typecheck`, `bun test`.
   → *verify:* the job log shows `tmux -V` ≥ 3.2 before the test step.
2. Assert tmux is present in a dedicated step so its absence fails the job
   rather than quietly reducing the suite.
   → *verify:* remove the tmux install locally; the job goes red, not green.
3. Pin the Bun version at or above `MIN_BUN_VERSION`.
4. Name the suite honestly: this runs `bun test`. `test:snapshot-orphan`,
   `test:snapshot-coverage` and `verify:agents` are **not** included, because
   the first two need Docker and the third needs real agent installs.
   → *verify:* the workflow file lists exactly what it runs.

Note that first-time fork contributors require manual approval before workflows
run; that is GitHub policy, not a gap to fix.

**Done when:** a PR runs typecheck, unit tests and a genuinely-executed
boot-smoke on both platforms.

---

## Stage 2 — Asset materialization (unblocks the binary)

**Goal:** jmux resolves its assets identically whether it runs from source or as
a compiled binary, on both supported platforms.

### 2a. Fix the dead keybindings

Delete the `m` / `i` / `r` binds from `config/defaults.conf`; update
docs/cheat-sheet.md and docs/getting-started.md to point at `Ctrl-a p`.
→ *verify:* a test asserts every path referenced by any `.conf` file exists on
disk, so this cannot regress.

### 2b. Make Linux actually work

Add a single `openUrl()` helper (`open` on darwin, `xdg-open` on linux) and use
it in all three adapters. Make the `y` clipboard bind platform-aware
(`pbcopy` / `wl-copy` / `xclip -selection clipboard`), degrading to a message
naming what to install rather than failing silently.
→ *verify:* unit test over the helper's platform branch; the conf test asserts
no macOS-only binary is hardcoded in a bind.

### 2c. Embed the assets and replace `jmuxDir` with a resolver

Import all five with `with { type: "text" }`. Replace `main.ts:365` with a
resolver that always materializes into
`${XDG_DATA_HOME:-~/.local/share}/jmux/assets/<content-hash>/`, per D5 —
same-filesystem temp dir, mode 0700, `rename`, **`ENOTEMPTY` treated as success
after verifying the winner**, stale temps swept by age.

Declare it **above `main.ts:242`** so `--install-agent-hooks` can call it (D6).
Point `pi.ts`'s `piExtensionSource()` at the materialized dir.

→ *verify:* unit tests for the happy path, the concurrent-write race (two
resolvers, one destination), a pre-created corrupt destination, and the
underivable-base-dir error.

### 2d. `jmux --install-skill`

Copies the materialized skill to `<config-dir>/skills/jmux-control/SKILL.md`,
where `<config-dir>` is `$CLAUDE_CONFIG_DIR` when set, falling back to
`~/.claude` — the same rule `claude.ts:22-30` already follows, and for the same
reason: writing to `~/.claude` for a user who relocated their config installs
something that never fires.

Behaviour is defined, not incidental: an existing **symlink** is left alone and
reported (that is a developer's deliberate setup — including this repo's own);
an identical file is a no-op; a differing regular file is overwritten only after
saying so. Detection mirrors `pi.ts`'s `detect()` so the command is idempotent.
Fix README.md:165 and docs/agent-integration.md:180 to describe the real
mechanism.

→ *verify:* unit tests for each of the four target states.

### 2e. Channel detection

Two-step detection per D10 — compiled-vs-source first, then path sniffing — used
to make the existing update indicator say something true.
→ *verify:* unit test asserting a `/opt/homebrew/bin/bun` execPath in
source mode reports the npm channel, not brew.

### 2f. Config generation check

Write `@jmux-config-generation` after the control channel is up; on attach,
compare and warn when the running server predates the current assets (D12).
→ *verify:* boot test covering attach-to-stale-server.

### 2g. Test the binary, not just the source

Add a sibling to `boot-smoke.test.ts` that compiles the binary and boots *that*
under a pty — once against a fresh server, once attaching to a server started
from a different generation — asserting it stays alive and that tmux sourced the
configs (`tmux show-options`).
→ *verify:* deliberately break the resolver; the new test must fail.

**Done when:** the compiled binary boots on a fresh *and* a pre-existing server,
and `--install-agent-hooks` and `--install-skill` both work from it.

---

## Stage 3 — `./release.sh`

**Prerequisites, asserted by the script before it does anything** (these were
assumed silently in the first draft): `npm whoami` succeeds and the account can
publish `@jx0/jmux` under its 2FA policy; `gh auth status` succeeds; the tap
repo is cloned and pushable **or** the tap step is skipped as not-yet-created;
Docker is running for the Linux smoke tests.

**Ordering, corrected.** The first draft published npm at step 7 and uploaded
artifacts at step 8, calling the order "the safety property". It wasn't: an npm
version can never be republished, so a failure after step 7 was unrecoverable.
The irreversible action now goes **last**, and every step is idempotent so a
failed run can be re-run rather than unwound.

1. Assert the working tree is clean, the tag exists, **the tag resolves to
   `HEAD`**, `HEAD` matches the pushed upstream commit, and `package.json`
   version === tag. Version equality alone does not prove the artifacts came
   from the tagged tree.
2. `bun run typecheck` && `bun test`.
3. Build five targets: `bun-darwin-arm64`, `bun-darwin-x64`, `bun-linux-x64`,
   `bun-linux-x64-baseline`, `bun-linux-arm64` (D13).
4. `codesign --force -s -` the darwin binaries (D8).
5. Verify every artifact, executing what the host can execute **natively**:
   arm64 natively, darwin-x64 under Rosetta, and the matching Linux target in a
   native-platform container.

   Cross-architecture artifacts are **format-verified, not executed**. This is
   not a shortcut — running a 100MB Bun binary's startup under QEMU takes tens
   of minutes, which is a hang rather than a test (measured: a single
   `--version` under `linux/amd64` emulation ran 14 minutes without finishing).
   A `file`-based check catches the mis-targeted or truncated build that
   packaging actually produces, and CI executes those targets on native
   runners. `JMUX_EMULATED_SMOKE=1` forces the slow path.
6. Package `jmux-<version>-<os>-<arch>.tar.gz`, each containing the binary,
   `LICENSE` and a short `README`. Generate `SHA256SUMS`.
7. Create or reuse the **draft** GitHub Release and upload artifacts (re-runnable;
   existing assets are replaced).
8. Flip the release non-draft.
9. `npm publish` — the one irreversible step, and therefore the last risky one.
10. Bump `Formula/jmux.rb` in the tap. **Skipped with a notice until Stage 5
    creates the tap**, which resolves the first draft's contradiction of
    requiring in Stage 3 a repo that Stage 5 creates.

**Recovery, documented rather than improvised:** a failure before 9 is fixed by
re-running. A failure after 9 means the npm version is spent — cut a patch
version rather than trying to overwrite, and `npm deprecate` the orphan.

→ *verify:* `--dry-run` performs 1-6 and stops; re-running a completed release
is a no-op through step 8.

**Done when:** `curl -L <release-url> | tar xz && ./jmux --version` works on a
clean machine with no Bun installed.

---

## Stage 4 — `curl | sh` installer

**Goal:** one command installs jmux on macOS and glibc Linux.

1. `site/install`: detect os/arch, **detect musl and refuse with an
   explanation** (D13), select the baseline x64 build when `/proc/cpuinfo` lacks
   `avx2`, resolve the latest release from the GitHub API at runtime, download,
   **verify the checksum** (`shasum -a 256` on macOS, `sha256sum` on Linux —
   neither exists on both), install to `~/.local/bin`, `chmod +x`.
2. **Non-interactive by default.** Under `curl … | sh` the script *is* stdin, so
   an unredirected `read` consumes the script rather than the user's answer. Any
   prompt must read from `/dev/tty` and must be skipped entirely when
   `/dev/tty` is unavailable or `JMUX_ASSUME_YES=1` is set. This applies to both
   the `/usr/local/bin` fallback (which also needs `sudo` handling) and the
   `--install-skill` offer.
3. Install atomically: download to a temp file on the target filesystem, verify,
   then `rename` over the destination, so upgrading while jmux is running
   replaces the inode rather than corrupting a mapped binary. Clean up temps on
   any exit path.
4. **Detect a conflicting install**: if `command -v jmux` resolves somewhere
   other than the target directory, say which one will win and how to fix it,
   rather than leaving two jmuxes and a confusing version report.
5. Detect tmux; if missing or below `MIN_TMUX_VERSION`, print the platform's
   install command. This duplicates `preflight()` deliberately, to fail before
   the user holds a binary they can't run — guarded against drift by a single
   `MIN_TMUX_VERSION` constant plus a test asserting `site/install` carries the
   same floor. Fix `preflight()`'s missing version check at the same time, since
   that path serves the brew and npm channels.
6. Warn when the install dir is not on `PATH`, with the exact line to add.
7. Support `JMUX_VERSION=`, `JMUX_INSTALL_DIR=`, `JMUX_ASSUME_YES=`.
8. Serve at `https://jmux.build/install` through the existing site pipeline.
   A static `site/install` maps to `/install.sh`, so the extensionless URL
   needs an explicit rewrite or a second uploaded object — **that rewrite is a
   prerequisite, not an assumption.** Update `README.md:17` and
   `site/index.html`.

Because the installer ships on *site push* rather than with a release, it must
never assume a release that does not exist yet — hence resolving latest at
runtime.

→ *verify:* a **new** `Dockerfile.installer` — genuinely clean debian, no Bun, no
jmux — asserts a working install. The existing `Dockerfile.test` cannot serve
this: it installs Bun and `bun link`s jmux, and only tmux is absent. A second
case runs it on an Alpine image and asserts the musl refusal.

**Done when:** both container tests pass and the site shows the new command.

---

## Stage 5 — Homebrew tap

**Goal:** `brew install jarredkenny/tap/jmux`.

1. Create the `jarredkenny/homebrew-tap` repo.
2. Author `Formula/jmux.rb`. Note this is **not a bottle** — a bottle is a
   prebuilt keg produced by Homebrew from a formula. This is an upstream
   binary tarball as the formula's source: `on_macos`/`on_linux` ×
   `on_arm`/`on_intel` blocks each with their own `url` and `sha256`, and a
   `bin.install "jmux"`. `depends_on "tmux"` — a real win over the installer,
   since brew guarantees tmux is present and `preflight()` becomes a silent
   no-op on this channel.
3. Add a `test do` block that runs `jmux --version` **and** asserts a tmux-backed
   startup path, since `--version` exits before `preflight()` and proves almost
   nothing.
4. State Linuxbrew support explicitly (the linux-x64 tarball works; musl does
   not) and that `--build-from-source` is unsupported for a binary formula.
5. Wire the bump into `release.sh` step 10.
6. `brew audit --strict --online jmux` and `brew test jmux`.

**Done when:** install, `jmux --version`, a real tmux-backed launch, and
`brew uninstall` all work on a clean macOS machine, and the bump happens without
anyone remembering to do it.

*Homebrew-core submission stays out of scope until the project clears its
acceptability bar. The tap is not throwaway work either way.*

---

## Coexistence, upgrade and uninstall

Omitted entirely from the first draft; each is a real user path.

- **Coexistence.** Three channels can put `jmux` in `~/.bun/bin`,
  `~/.local/bin`, `/usr/local/bin` and Homebrew's prefix. The installer detects
  a conflicting resolution (Stage 4.4). On Intel macOS an installer-owned
  `/usr/local/bin/jmux` can block `brew link`, so the installer names that
  consequence when it writes there.
- **Upgrade in place.** Atomic rename (Stage 4.3), so a running jmux keeps its
  open inode. The materialized asset dir is content-addressed and never mutated,
  so a running instance's assets survive an upgrade — but its **tmux server**
  does not pick up new config until restarted, which is what D12 surfaces.
- **Uninstall.** Documented per channel, because none of them are complete:
  `brew uninstall` removes only the keg; the installer removes only the binary.
  Neither touches `~/.local/share/jmux`, `~/.config/jmux`, the installed skill,
  the pi extension, or the hook entries `--install-agent-hooks` wrote into
  `~/.claude` / `~/.codex` / pi's settings. A `jmux --uninstall-integrations`
  reverses exactly what jmux installed, and the docs list the remaining paths
  explicitly.

---

## Deferred

- **Notarization** — scoped in D8. Fixes only the browser-download path.
- **musl / Alpine** — blocked upstream by bun-pty, not by us (D13). npm remains
  the answer there.
- **Linux packages** — AUR (`jmux-bin`) first if anyone asks; deb/rpm via `nfpm`
  after. The glibc tarball already covers mainstream distros. AGPL-3.0 is
  unproblematic in all three.
- **Windows / WSL** — WSL docs, plus detecting Windows-without-WSL at startup.
- **`--bytecode`** — a startup-time optimization, not a size one. 22.5MB
  compressed is unremarkable.

---

## Flagged, not fixed

- `defaults.conf:69` — `display-message "Pane cleared"` is likely invisible,
  because `core.conf` sets `status off` and tmux renders messages in the status
  line.
- `preflight()` knows `brew` and `apt` only. Fedora, Arch and openSUSE users
  fall through to the generic message. Stage 4 fixes the version check but
  deliberately leaves the package-manager list alone.
- No build provenance or SBOM. Worth revisiting if the project ever wants
  reproducible or attested builds; out of scope for a solo local release script.

---

## Execution order

```
Stage 2a (dead binds)  ─┐
Stage 2b (Linux parity) ─┴──────────────────────┐  independent, ship first
                                                │
Stage 1 (CI)  →  Stage 2c-g (materialization)  →  Stage 3 (release.sh)
                                                │
                              Stage 4 (installer)  →  Stage 5 (tap)
```

Stages 2a and 2b are independently valuable, carry no packaging risk, and fix
bugs that exist on every install today.
