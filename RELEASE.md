# Releasing jmux

Everything mechanical is in `./release.sh`. This document is the part that is
**yours** — the decisions and the prose a script cannot write.

Your job each release is four things: pick the version, write the notes, tag it,
run the script. Everything else is automated and verified.

> This is a public repository. The release notes you write here are published on
> GitHub *and* rendered inside jmux itself as the changelog modal — they are a
> product surface, read by strangers. Credentials live in your local `npm` and
> `gh` sessions and must never be committed, added to a workflow, or pasted into
> a release body.

---

## One-time setup

Per machine, not per release.

```bash
gh auth login          # uploads artifacts, creates releases
npm login              # publishes @jx0/jmux
```

- **Docker** must be running — the Linux artifact is verified in a container.
- **Rosetta**, to verify the Intel Mac build on Apple Silicon:
  `softwareupdate --install-rosetta`
- **The Homebrew tap**, if you want the formula bumped automatically. Clone
  `jarredkenny/homebrew-tap` next to this repo, or point `JMUX_TAP_DIR` at it.
  Without it the bump is skipped with a notice and nothing else changes.

Verify the whole toolchain without publishing anything:

```bash
bun run release:dry
```

That builds all five targets, signs, verifies and packages them, then stops.
It is safe to run at any time, on a dirty tree, before a tag exists.

---

## Every release

### 1. Confirm main is green

```bash
gh run list --branch main --limit 1
```

CI runs typecheck, the full test suite, and the pty boot tests on Linux and
macOS. Do not release on red.

### 2. Bump the version

```bash
# edit package.json → "version": "0.26.0"
git commit -am "chore(release): 0.26.0"
```

The version in `package.json` is the single source of truth. `release.sh`
refuses to run unless the tag, `HEAD`, and the pushed branch all agree with it.

### 3. Write the release notes

**This is the part only you can do.** The body you write is markdown-rendered
inside jmux as the changelog modal (`Ctrl-a p` → Changelog), so it is read by
users in the product, not just on GitHub.

Write for someone deciding whether to upgrade:

- Lead with what changed for them, not what changed in the code.
- Name new keybindings and commands explicitly — the changelog is where people
  discover them.
- Call out anything that changes existing behaviour.

Title format matches the existing releases: `v0.26.0 — <short theme>`.

### 4. Tag and push

```bash
git push
git tag v0.26.0
git push origin v0.26.0
```

### 5. Create the release as a **draft**

```bash
gh release create v0.26.0 --draft \
  --title "v0.26.0 — <short theme>" \
  --notes-file notes.md
```

Draft matters: nothing is public until the artifacts exist and pass their
checks. `release.sh` publishes it for you at the right moment, and stops with
instructions if you forget this step.

### 6. Run the release

```bash
bun run release
```

Takes a few minutes, mostly compiling. It prints each step as it goes and stops
at the first failure.

### 7. Confirm it landed

```bash
gh release view v0.26.0        # five tarballs + SHA256SUMS
npm view @jx0/jmux version     # matches
```

Then install it the way a stranger would:

```bash
curl -fsSL https://jmux.build/install | sh
```

---

## What the script does, so you don't have to

In this order — and the order is the safety property:

| | Step | Why it is where it is |
| --- | --- | --- |
| 0 | Check `gh`, `npm`, Docker, auth | Fails before doing work it cannot finish |
| 1 | Assert tag = `HEAD` = pushed, tree clean | Version equality alone doesn't prove the artifacts came from the tagged tree |
| 2 | Typecheck + full test suite | — |
| 3 | Build 5 targets | macOS arm64/x64, Linux x64/x64-baseline/arm64 |
| 4 | Ad-hoc sign the macOS builds | Bun's own signature is invalid; this makes it valid |
| 5 | Verify every artifact | Executes what runs natively, format-checks the rest |
| 6 | Package + `SHA256SUMS` | `LICENSE` ships inside each tarball |
| 7 | Upload to the draft release | Re-runnable; assets are replaced, not duplicated |
| 8 | Publish the release | — |
| 9 | **`npm publish`** | **Last, because it is the only irreversible step** |
| 10 | Bump the Homebrew formula | After the artifacts it points at are live |

Steps 1–8 are idempotent. If one fails, fix the cause and run the script again.

---

## When something goes wrong

**Before step 9** — just re-run `bun run release`. Nothing is permanent yet;
uploads replace existing assets and a published release can be re-drafted.

**After step 9 (npm published, something later failed)** — an npm version can
never be reused. Do not fight it:

```bash
# finish the remaining steps by hand, or:
npm deprecate @jx0/jmux@0.26.0 "superseded by 0.26.1"
# then bump to 0.26.1 and release again
```

The script skips `npm publish` if that exact version is already on the registry,
so re-running after a partial failure is safe.

**"no GitHub Release for v0.26.0"** — you skipped step 5. Create the draft and
re-run.

**"working tree is dirty" / "tag points at …"** — the tree and the tag disagree.
Fix it rather than bypassing it; this check is what stops binaries being
published from a tree nobody can retrieve.

**Formula bump says "no sha256 line tagged"** — the formula is missing a
`# <platform>` comment on one of its `sha256` lines. It refuses to guess,
because pairing a checksum with the wrong architecture would install the wrong
binary and still pass Homebrew's integrity check.

---

## Occasionally

- **`bun run test:installer`** — installs jmux in a clean container with no Bun
  and runs it. Worth doing after changing `site/install.sh`.
- **`bun run test:installer-musl`** — asserts the installer *refuses* on Alpine
  rather than installing a binary that cannot work.
- **`site/install.sh` ships on site pushes, not with releases.** It resolves the
  latest release at runtime, so it must keep working against both the current
  release and the next one.
- **Bun's version is a build input.** `bun build --compile` embeds whichever Bun
  compiled it, so upgrading Bun changes what users run. Keep the pin in
  `.github/workflows/ci.yml` in step with the Bun you release from.

---

## Not automated on purpose

- **Release notes.** See step 3.
- **Deciding the version number.** Nothing infers semver from a diff.
- **macOS notarization.** Unsigned binaries are fine through `curl` and
  Homebrew — neither sets the quarantine flag. Only a *browser* download trips
  Gatekeeper. See `PACKAGING.md` D8 for what notarization would actually
  require; it is a project, not a flag.
