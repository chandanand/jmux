# jmux — Homebrew formula
#
# Lives here so it is versioned with the code it installs; release.sh copies the
# bumped copy into the tap repo (jarredkenny/homebrew-tap).
#
# NOTE: this is not a bottle. A bottle is a prebuilt keg Homebrew produces from
# a formula; this pours an upstream binary tarball, which is a formula whose
# `url` happens to be a precompiled archive. `brew install --build-from-source`
# is therefore meaningless here — there is no source build to fall back to.
#
# Every sha256 carries a trailing `# <platform>` comment. release.sh's bumper
# matches on those tags rather than on position, because a formula has several
# identical-looking sha256 lines and pairing one with the wrong architecture
# would install the wrong binary and still pass its own integrity check.
class Jmux < Formula
  desc "Terminal workspace for agentic development"
  homepage "https://github.com/jarredkenny/jmux"
  version "0.25.0"
  license "AGPL-3.0-only"

  # tmux is the one hard runtime requirement, and Homebrew can guarantee it —
  # which is a real advantage over the shell installer, where jmux has to
  # detect a missing tmux itself and ask.
  depends_on "tmux"

  on_macos do
    on_arm do
      url "https://github.com/jarredkenny/jmux/releases/download/v#{version}/jmux-#{version}-darwin-arm64.tar.gz"
      sha256 "0000000000000000000000000000000000000000000000000000000000000000" # darwin-arm64
    end
    on_intel do
      url "https://github.com/jarredkenny/jmux/releases/download/v#{version}/jmux-#{version}-darwin-x64.tar.gz"
      sha256 "0000000000000000000000000000000000000000000000000000000000000000" # darwin-x64
    end
  end

  # Linuxbrew works on glibc. Alpine/musl is unsupported and cannot be fixed
  # here: bun-pty ships no musl native library, so a musl build would install
  # cleanly and then fail on the first pty spawn.
  on_linux do
    on_arm do
      url "https://github.com/jarredkenny/jmux/releases/download/v#{version}/jmux-#{version}-linux-arm64.tar.gz"
      sha256 "0000000000000000000000000000000000000000000000000000000000000000" # linux-arm64
    end
    on_intel do
      url "https://github.com/jarredkenny/jmux/releases/download/v#{version}/jmux-#{version}-linux-x64.tar.gz"
      sha256 "0000000000000000000000000000000000000000000000000000000000000000" # linux-x64
    end
  end

  def install
    bin.install "jmux"
  end

  def caveats
    <<~EOS
      Teach your agents the jmux control CLI:
        jmux --install-skill

      Install agent state hooks (Claude Code, Codex, pi):
        jmux --install-agent-hooks

      Both write into those tools' own config. To reverse them before
      uninstalling jmux:
        jmux --uninstall-integrations
    EOS
  end

  test do
    # `--version` exits before any of the interesting startup work, so on its
    # own it proves almost nothing. The second assertion is the real one: boot
    # against a private tmux socket and confirm the server came up with jmux's
    # materialized config, which exercises asset materialization, the tmux
    # spawn, and the config path all at once.
    assert_match version.to_s, shell_output("#{bin}/jmux --version")

    socket = "jmux-brew-test-#{Process.pid}"
    require "pty"
    begin
      PTY.spawn("#{bin}/jmux", "--socket", socket) do |_r, _w, pid|
        sleep 6
        detach = shell_output("tmux -L #{socket} show-options -g detach-on-destroy 2>/dev/null", 0)
        Process.kill("TERM", pid)
        assert_match "off", detach
      end
    ensure
      system "tmux", "-L", socket, "kill-server"
    end
  end
end
