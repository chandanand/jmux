#!/usr/bin/env bash
#
# Cut a jmux release.
#
# Releases are deliberately human-triggered. The GitHub Release body is
# rendered inside jmux as the changelog modal, so it is written by a person;
# this script does the mechanics around it and nothing else.
#
# ORDERING IS THE SAFETY PROPERTY, and it is not the obvious order. `npm
# publish` is the only irreversible step — a version can never be republished —
# so it goes LAST, after every artifact is built, verified and uploaded. Every
# step before it is idempotent, so a failed run is re-run rather than unwound.
#
#   ./release.sh --dry-run     build and verify, publish nothing
#   ./release.sh               full release
#
set -euo pipefail

DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

DIST="$ROOT/dist/release"
REPO="jarredkenny/jmux"
# Sibling checkout by default so this works for anyone with the tap cloned
# next to jmux; override with JMUX_TAP_DIR.
TAP_DIR="${JMUX_TAP_DIR:-$ROOT/../homebrew-tap}"

VERSION="$(bun -e 'console.log(require("./package.json").version)')"
TAG="v$VERSION"

say()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
ok()   { printf '    \033[32m✓\033[0m %s\n' "$*"; }
die()  { printf '\n\033[31mrelease aborted:\033[0m %s\n' "$*" >&2; exit 1; }

# Fatal when releasing, a warning when dry-running.
#
# The git assertions below exist to stop a *publish* from disagreeing with the
# tag. Nothing is published in a dry run, and making them fatal there would
# make the pre-flight check unusable exactly when it is wanted — mid-work, on a
# dirty tree, before the tag exists.
require() {
  if [ "$DRY_RUN" = "1" ]; then
    printf '    \033[33m!\033[0m %s (ignored: dry run)\n' "$1"
  else
    die "$1"
  fi
}

# --- 0. Prerequisites ------------------------------------------------------
# Asserted up front so the script cannot get halfway and discover it can't
# finish. Each of these was an unstated assumption in the original plan.

say "Checking prerequisites"

command -v bun    >/dev/null || die "bun is not installed"
command -v gh     >/dev/null || die "gh is not installed (needed to upload artifacts)"
command -v npm    >/dev/null || die "npm is not installed"
command -v docker >/dev/null || die "docker is not running (needed to smoke-test the Linux builds)"
docker info >/dev/null 2>&1  || die "docker is installed but not running"

gh auth status >/dev/null 2>&1 || die "gh is not authenticated — run: gh auth login"
npm whoami     >/dev/null 2>&1 || die "npm is not authenticated — run: npm login"
ok "bun, gh, npm, docker all present and authenticated"

if [ ! -d "$TAP_DIR/.git" ]; then
  echo "    ! homebrew tap not found at $TAP_DIR — the formula bump will be skipped"
  echo "      (set JMUX_TAP_DIR, or create the tap; see PACKAGING.md Stage 5)"
fi

# --- 1. The tree is exactly what the tag says ------------------------------
# Version equality alone proves nothing: a clean local commit can carry the
# right version and still differ from what the tag and the remote point at,
# which would publish binaries built from a tree nobody can retrieve.

say "Verifying $TAG matches this tree"

# What matters is whether the *build inputs* differ from the tag, not whether
# the directory is pristine. Uncommitted changes to tracked files always
# disqualify. An untracked file only matters if it could enter the binary —
# `bun build --compile` pulls in src/, and src/assets.ts embeds config/ and
# skills/ — because a fresh clone of the tag would not have it, and the
# published artifact would then be unreproducible.
BUILD_INPUTS='^(src/|config/|skills/|scripts/|package\.json|bun\.lock)'

dirty_tracked="$(git diff --name-only HEAD)"
if [ -n "$dirty_tracked" ]; then
  printf '    modified: %s\n' $dirty_tracked
  require "tracked files have uncommitted changes"
fi

untracked="$(git ls-files --others --exclude-standard)"
untracked_inputs="$(printf '%s\n' "$untracked" | grep -E "$BUILD_INPUTS" || true)"
if [ -n "$untracked_inputs" ]; then
  printf '    untracked build input: %s\n' $untracked_inputs
  require "untracked files could change the binary but are not in the tag"
elif [ -n "$untracked" ]; then
  printf '    ! ignoring untracked non-build files: %s\n' $untracked
fi

HEAD_SHA="$(git rev-parse HEAD)"

if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
  TAG_SHA="$(git rev-parse "$TAG^{commit}")"
  [ "$HEAD_SHA" = "$TAG_SHA" ] || require "$TAG points at $TAG_SHA but HEAD is $HEAD_SHA"
else
  require "tag $TAG does not exist — create it first: git tag $TAG"
fi

git fetch --quiet origin || true
REMOTE_SHA="$(git rev-parse "origin/$(git rev-parse --abbrev-ref HEAD)" 2>/dev/null || echo "")"
[ "$REMOTE_SHA" = "$HEAD_SHA" ] || require "HEAD is not pushed (origin is at ${REMOTE_SHA:-nothing})"

REMOTE_TAG="$(git ls-remote --tags origin "refs/tags/$TAG" | awk '{print $1}')"
[ -n "$REMOTE_TAG" ] || require "$TAG is not pushed — run: git push origin $TAG"

[ "$DRY_RUN" = "1" ] || ok "$TAG = HEAD = origin ($HEAD_SHA)"

# --- 2. Tests --------------------------------------------------------------

say "Running typecheck and tests"
bun run typecheck
bun test
ok "green"

# --- 3. Build --------------------------------------------------------------
# Five targets, not four. `bun-linux-x64-baseline` serves CPUs without AVX2 —
# without it those machines get an illegal instruction and no explanation.
#
# musl is deliberately absent: bun-pty ships no musl native library, so a musl
# build would compile and then die on the first pty spawn. install.sh refuses
# on musl rather than installing something that cannot work.

say "Building $VERSION"

rm -rf "$DIST"
mkdir -p "$DIST"

TARGETS=(
  "darwin-arm64:bun-darwin-arm64"
  "darwin-x64:bun-darwin-x64"
  "linux-x64:bun-linux-x64"
  "linux-x64-baseline:bun-linux-x64-baseline"
  "linux-arm64:bun-linux-arm64"
)

for entry in "${TARGETS[@]}"; do
  name="${entry%%:*}"
  target="${entry##*:}"
  bun build --compile --target="$target" src/main.ts --outfile "$DIST/jmux-$name" >/dev/null
  ok "$name"
done

# --- 4. Sign the darwin builds ---------------------------------------------
# Bun's compiled output is linker-signed but the payload is appended after
# signing, so `codesign --verify` rejects it. Re-signing ad-hoc is free and
# makes the signature valid. It does NOT satisfy Gatekeeper for a quarantined
# binary — only notarization does, and nothing we ship is quarantined because
# neither curl nor `brew install` sets the quarantine attribute.

if [ "$(uname -s)" = "Darwin" ]; then
  say "Ad-hoc signing the darwin builds"
  for name in darwin-arm64 darwin-x64; do
    codesign --force -s - "$DIST/jmux-$name" 2>/dev/null
    codesign --verify "$DIST/jmux-$name" || die "$name failed signature verification"
    ok "$name signed and verified"
  done
else
  echo "    ! not on macOS — darwin builds ship with Bun's invalid ad-hoc signature"
fi

# --- 5. Smoke-test every artifact ------------------------------------------
# Execution is verified where the host can execute it *natively*. Running a
# cross-architecture binary under QEMU is not a slower version of this check —
# emulating a 100MB Bun runtime's startup takes tens of minutes, which is a
# hang in practice, not a test.
#
# Cross-architecture artifacts get a structural check instead: the right file
# format for the right machine. That catches a mis-targeted or truncated build,
# which is what packaging actually gets wrong. Executing them belongs on native
# hardware — CI has amd64 runners.
#
# Set JMUX_EMULATED_SMOKE=1 to execute the emulated ones anyway, and expect it
# to take a very long time.

say "Smoke-testing artifacts"

HOST_OS="$(uname -s)"
HOST_ARCH="$(uname -m)"

# Does this artifact's compiled shape match what we asked for?
verify_shape() {
  name="$1"; want="$2"
  desc="$(file -b "$DIST/jmux-$name")"
  case "$desc" in
    *"$want"*) ok "$name (format: $want)" ;;
    *) die "$name has the wrong format — expected $want, got: $desc" ;;
  esac
}

verify_shape darwin-arm64        "Mach-O 64-bit executable arm64"
verify_shape darwin-x64          "Mach-O 64-bit executable x86_64"
verify_shape linux-x64           "ELF 64-bit LSB executable, x86-64"
verify_shape linux-x64-baseline  "ELF 64-bit LSB executable, x86-64"
verify_shape linux-arm64         "ELF 64-bit LSB executable, ARM aarch64"

if [ "$HOST_OS" = "Darwin" ] && [ "$HOST_ARCH" = "arm64" ]; then
  "$DIST/jmux-darwin-arm64" --version >/dev/null || die "darwin-arm64 does not run"
  ok "darwin-arm64 runs (native)"
  if "$DIST/jmux-darwin-x64" --version >/dev/null 2>&1; then
    ok "darwin-x64 runs (rosetta)"
  else
    echo "    ! darwin-x64 not executed — install Rosetta: softwareupdate --install-rosetta"
  fi
  native_linux="linux/arm64:linux-arm64"
elif [ "$HOST_OS" = "Linux" ] && [ "$HOST_ARCH" = "x86_64" ]; then
  native_linux="linux/amd64:linux-x64"
else
  native_linux=""
fi

if [ -n "$native_linux" ]; then
  platform="${native_linux%%:*}"
  name="${native_linux##*:}"
  docker run --rm --platform "$platform" \
    -v "$DIST:/dist:ro" debian:bookworm-slim /dist/jmux-"$name" --version >/dev/null \
    || die "$name does not run under $platform"
  ok "$name runs ($platform, native)"
fi

if [ "${JMUX_EMULATED_SMOKE:-0}" = "1" ]; then
  say "Executing emulated artifacts (this is slow)"
  for pair in "linux/amd64:linux-x64" "linux/amd64:linux-x64-baseline" "linux/arm64:linux-arm64"; do
    platform="${pair%%:*}"; name="${pair##*:}"
    [ "$pair" = "$native_linux" ] && continue
    docker run --rm --platform "$platform" \
      -v "$DIST:/dist:ro" debian:bookworm-slim /dist/jmux-"$name" --version >/dev/null \
      || die "$name does not run under $platform"
    ok "$name runs ($platform, emulated)"
  done
else
  echo "    ! not executed on this host: the non-native Linux targets"
  echo "      (format-verified above; CI executes them on native runners)"
fi

# --- 6. Package ------------------------------------------------------------
# LICENSE ships inside the tarball: AGPL-3.0 requires it to travel with the
# binary, and a tarball containing only an executable does not satisfy that.

say "Packaging"

for entry in "${TARGETS[@]}"; do
  name="${entry%%:*}"
  stage="$DIST/stage-$name"
  mkdir -p "$stage"
  cp "$DIST/jmux-$name" "$stage/jmux"
  cp LICENSE "$stage/LICENSE"
  cat > "$stage/README" <<EOF
jmux $VERSION — the terminal workspace for agentic development

Install:  move \`jmux\` onto your PATH (e.g. ~/.local/bin) and run it.
Requires: tmux 3.2 or newer. No Bun or Node runtime needed.
Docs:     https://github.com/$REPO
EOF
  # macOS tar embeds com.apple.provenance xattrs, which make GNU tar print a
  # warning for every file on extraction — on every Linux user's install.
  COPYFILE_DISABLE=1 tar --no-xattrs -czf "$DIST/jmux-$VERSION-$name.tar.gz" \
    -C "$stage" jmux LICENSE README 2>/dev/null \
    || tar -czf "$DIST/jmux-$VERSION-$name.tar.gz" -C "$stage" jmux LICENSE README
  rm -rf "$stage"
  ok "jmux-$VERSION-$name.tar.gz"
done

( cd "$DIST" && shasum -a 256 jmux-"$VERSION"-*.tar.gz > SHA256SUMS )
ok "SHA256SUMS"

if [ "$DRY_RUN" = "1" ]; then
  say "Dry run — stopping before anything is published"
  ls -lh "$DIST"/*.tar.gz "$DIST/SHA256SUMS"
  exit 0
fi

# --- 7. Upload to the draft release ----------------------------------------
# Re-runnable: --clobber replaces assets, so a failed upload is fixed by
# running the script again rather than by hand-deleting artifacts.

say "Uploading artifacts to $TAG"

if ! gh release view "$TAG" >/dev/null 2>&1; then
  die "no GitHub Release for $TAG — create it (with its changelog body) as a draft first:
       gh release create $TAG --draft --title \"$TAG — <name>\" --notes-file <file>"
fi

gh release upload "$TAG" "$DIST"/jmux-"$VERSION"-*.tar.gz "$DIST/SHA256SUMS" --clobber
ok "artifacts attached"

# --- 8. Publish the release ------------------------------------------------

say "Publishing the GitHub Release"
gh release edit "$TAG" --draft=false
ok "$TAG is live"

# --- 9. npm — the one irreversible step ------------------------------------
# A published npm version can never be reused. Everything above is verified and
# retryable precisely so this line runs last.

say "Publishing to npm"
if npm view "@jx0/jmux@$VERSION" version >/dev/null 2>&1; then
  ok "@jx0/jmux@$VERSION already published — skipping"
else
  npm publish
  ok "@jx0/jmux@$VERSION published"
fi

# --- 10. Homebrew tap ------------------------------------------------------
# Last, and skipped cleanly when the tap does not exist yet — Stage 5 creates
# it, and Stage 3 must not require a repo a later stage introduces.

say "Bumping the Homebrew formula"

if [ ! -d "$TAP_DIR/.git" ]; then
  echo "    ! skipped — no tap at $TAP_DIR"
else
  bun run scripts/bump-formula.ts "$TAP_DIR/Formula/jmux.rb" "$VERSION" "$DIST/SHA256SUMS"
  git -C "$TAP_DIR" add Formula/jmux.rb
  if git -C "$TAP_DIR" diff --cached --quiet; then
    ok "formula already at $VERSION"
  else
    git -C "$TAP_DIR" commit -m "jmux $VERSION"
    git -C "$TAP_DIR" push
    ok "tap bumped to $VERSION"
  fi
fi

say "Released $TAG"
echo "  https://github.com/$REPO/releases/tag/$TAG"
