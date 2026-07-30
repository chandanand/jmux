#!/bin/sh
#
# jmux installer — https://jmux.build/install
#
#   curl -fsSL https://jmux.build/install | sh
#
# Environment:
#   JMUX_VERSION=v0.25.0     install a specific release (default: latest)
#   JMUX_INSTALL_DIR=~/bin   where to put the binary (default: ~/.local/bin)
#   JMUX_ASSUME_YES=1        never prompt
#   JMUX_BASE_URL=...        fetch artifacts from somewhere other than GitHub
#                            (used by the clean-environment test, which has to
#                            verify the install path before a release exists)
#
# POSIX sh, not bash: this runs on whatever /bin/sh a machine happens to have.
#
# NOTE ON PROMPTING. Under `curl … | sh` the script *is* standard input, so an
# unredirected `read` consumes the script's own remaining bytes rather than the
# user's answer. Every prompt here therefore reads from /dev/tty, and skips
# itself entirely when there is no tty — which is also what makes this safe to
# run in CI and in a Dockerfile.
set -eu

REPO="jarredkenny/jmux"
INSTALL_DIR="${JMUX_INSTALL_DIR:-$HOME/.local/bin}"
MIN_TMUX_MAJOR=3
MIN_TMUX_MINOR=2

TMP=""
cleanup() { [ -n "$TMP" ] && rm -rf "$TMP"; }
trap cleanup EXIT INT TERM

say()  { printf '%s\n' "$*"; }
info() { printf '  %s\n' "$*"; }
warn() { printf '\033[33mwarning:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

# Ask a yes/no question, defaulting to yes. Never blocks without a tty.
confirm() {
  [ "${JMUX_ASSUME_YES:-0}" = "1" ] && return 0
  [ -r /dev/tty ] || return 1
  printf '%s [Y/n] ' "$1" > /dev/tty
  read -r reply < /dev/tty || return 1
  case "$reply" in
    ""|y|Y|yes|YES) return 0 ;;
    *) return 1 ;;
  esac
}

need() { command -v "$1" >/dev/null 2>&1 || die "$1 is required but not installed"; }

# --- Platform --------------------------------------------------------------

os="$(uname -s)"
arch="$(uname -m)"

case "$os" in
  Darwin) os_name="darwin" ;;
  Linux)  os_name="linux" ;;
  *) die "unsupported operating system: $os

jmux drives a real tmux process, and tmux has no native Windows build.
On Windows, install WSL and run this inside it." ;;
esac

case "$arch" in
  arm64|aarch64) arch_name="arm64" ;;
  x86_64|amd64)  arch_name="x64" ;;
  *) die "unsupported architecture: $arch" ;;
esac

# musl is not a build flag away. bun-pty ships no musl native library, so a
# musl binary would install cleanly and then die the moment jmux opens a pty.
# Refusing here is the honest outcome; npm still works on Alpine.
if [ "$os_name" = "linux" ]; then
  if [ -f /etc/alpine-release ] || (command -v ldd >/dev/null 2>&1 && ldd --version 2>&1 | grep -qi musl); then
    die "musl-based Linux (Alpine) is not supported by the binary build.

jmux's pty library ships glibc-only natives, so a musl binary cannot work.
Install via Bun instead:  bun install -g @jx0/jmux"
  fi
fi

# Pre-AVX2 x86 CPUs need Bun's baseline build; the standard one dies with an
# illegal instruction and no explanation.
platform="$os_name-$arch_name"
if [ "$platform" = "linux-x64" ] && [ -r /proc/cpuinfo ]; then
  if ! grep -qm1 avx2 /proc/cpuinfo; then
    platform="linux-x64-baseline"
    info "CPU has no AVX2 — using the baseline build"
  fi
fi

need uname
need mkdir
need tar
command -v curl >/dev/null 2>&1 || command -v wget >/dev/null 2>&1 \
  || die "curl or wget is required"

fetch() {
  if command -v curl >/dev/null 2>&1; then curl -fsSL "$1" -o "$2"
  else wget -qO "$2" "$1"; fi
}
fetch_stdout() {
  if command -v curl >/dev/null 2>&1; then curl -fsSL "$1"
  else wget -qO- "$1"; fi
}

# macOS ships `shasum`; Linux ships `sha256sum`. Neither ships both.
if command -v sha256sum >/dev/null 2>&1; then
  checksum() { sha256sum "$1" | cut -d' ' -f1; }
elif command -v shasum >/dev/null 2>&1; then
  checksum() { shasum -a 256 "$1" | cut -d' ' -f1; }
else
  die "no sha256 tool found (need sha256sum or shasum)"
fi

# --- Resolve the release ---------------------------------------------------
# Resolved at runtime, not baked in: this script ships on site pushes, which
# are not synchronised with releases. Hardcoding a version would mean the
# installer could reference a release that does not exist yet.

version="${JMUX_VERSION:-}"
if [ -z "$version" ] && [ -n "${JMUX_BASE_URL:-}" ]; then
  die "JMUX_BASE_URL requires JMUX_VERSION to be set explicitly"
fi
if [ -z "$version" ]; then
  say "Resolving the latest jmux release..."
  version="$(fetch_stdout "https://api.github.com/repos/$REPO/releases/latest" \
    | grep -m1 '"tag_name"' | cut -d'"' -f4)"
  [ -n "$version" ] || die "could not determine the latest release (GitHub API unreachable or rate-limited)

Pick one explicitly:  JMUX_VERSION=v0.25.0 sh install.sh"
fi
bare_version="${version#v}"

tarball="jmux-$bare_version-$platform.tar.gz"
base="${JMUX_BASE_URL:-https://github.com/$REPO/releases/download/$version}"

say "Installing jmux $version ($platform)"

# --- Download and verify ---------------------------------------------------

TMP="$(mktemp -d)"
info "downloading $tarball"
fetch "$base/$tarball" "$TMP/$tarball" || die "download failed: $base/$tarball"

info "verifying checksum"
fetch "$base/SHA256SUMS" "$TMP/SHA256SUMS" || die "could not download SHA256SUMS"

expected="$(grep " $tarball\$" "$TMP/SHA256SUMS" | cut -d' ' -f1)"
[ -n "$expected" ] || die "$tarball is not listed in SHA256SUMS"

actual="$(checksum "$TMP/$tarball")"
[ "$expected" = "$actual" ] || die "checksum mismatch for $tarball
  expected $expected
  actual   $actual"

tar -xzf "$TMP/$tarball" -C "$TMP"
[ -f "$TMP/jmux" ] || die "archive did not contain a jmux binary"
chmod +x "$TMP/jmux"

# --- Install ---------------------------------------------------------------

if ! mkdir -p "$INSTALL_DIR" 2>/dev/null; then
  die "cannot create $INSTALL_DIR — set JMUX_INSTALL_DIR to somewhere writable"
fi

if [ ! -w "$INSTALL_DIR" ]; then
  die "$INSTALL_DIR is not writable.

Either set JMUX_INSTALL_DIR to a directory you own, or re-run with sudo:
  curl -fsSL https://jmux.build/install | sudo JMUX_INSTALL_DIR=$INSTALL_DIR sh"
fi

# Move into place rather than copying over the existing file: rename is atomic,
# so upgrading while jmux is running replaces the directory entry and leaves
# the running process's inode intact. Copying over a mapped binary corrupts it.
mv "$TMP/jmux" "$INSTALL_DIR/jmux.new"
mv "$INSTALL_DIR/jmux.new" "$INSTALL_DIR/jmux"
info "installed $INSTALL_DIR/jmux"

# --- Coexistence -----------------------------------------------------------
# Three channels can install jmux into four different directories. Saying
# nothing here means the user runs an old jmux and cannot work out why.

resolved="$(command -v jmux 2>/dev/null || true)"
if [ -n "$resolved" ] && [ "$resolved" != "$INSTALL_DIR/jmux" ]; then
  warn "another jmux is earlier on your PATH and will win:
    $resolved  (this one wins)
    $INSTALL_DIR/jmux  (just installed)

  Remove the other one, or put $INSTALL_DIR earlier in PATH."
elif [ -z "$resolved" ]; then
  warn "$INSTALL_DIR is not on your PATH. Add it:
    export PATH=\"$INSTALL_DIR:\$PATH\""
fi

# --- tmux ------------------------------------------------------------------
# Checked here as well as in jmux's own preflight, so the requirement surfaces
# before the user is holding a binary that cannot start.

tmux_ok=0
if command -v tmux >/dev/null 2>&1; then
  tmux_version="$(tmux -V | sed 's/^tmux //; s/[a-z]*$//')"
  tmux_major="${tmux_version%%.*}"
  tmux_minor="${tmux_version#*.}"
  tmux_minor="${tmux_minor%%.*}"
  if [ "$tmux_major" -gt "$MIN_TMUX_MAJOR" ] 2>/dev/null; then tmux_ok=1
  elif [ "$tmux_major" -eq "$MIN_TMUX_MAJOR" ] 2>/dev/null && [ "$tmux_minor" -ge "$MIN_TMUX_MINOR" ] 2>/dev/null; then tmux_ok=1
  fi
  [ "$tmux_ok" = "1" ] || warn "tmux $tmux_version is too old — jmux needs $MIN_TMUX_MAJOR.$MIN_TMUX_MINOR or newer"
else
  warn "tmux is not installed — jmux cannot start without it"
fi

if [ "$tmux_ok" = "0" ]; then
  if [ "$os_name" = "darwin" ]; then info "install it with:  brew install tmux"
  elif command -v apt-get >/dev/null 2>&1; then info "install it with:  sudo apt-get install tmux"
  elif command -v dnf >/dev/null 2>&1; then info "install it with:  sudo dnf install tmux"
  elif command -v pacman >/dev/null 2>&1; then info "install it with:  sudo pacman -S tmux"
  else info "install tmux $MIN_TMUX_MAJOR.$MIN_TMUX_MINOR or newer from your package manager"
  fi
fi

# --- Agent integrations ----------------------------------------------------

say ""
if confirm "Install the jmux-control skill so agents can drive jmux?"; then
  "$INSTALL_DIR/jmux" --install-skill || warn "skill install failed"
else
  info "skipped — run 'jmux --install-skill' any time"
fi

say ""
say "jmux $version installed."
say "Run 'jmux' to start, or 'jmux --install-agent-hooks' for agent state tracking."
