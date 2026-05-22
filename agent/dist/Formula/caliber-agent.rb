class CaliberAgent < Formula
  desc "Caliber daemon: ship LLM coding-session telemetry from local clients to caliber"
  homepage "https://github.com/hanfour/caliber"
  version "0.1.0-pre"
  on_macos do
    on_arm do
      url "https://github.com/hanfour/caliber/releases/download/agent/v0.1.0-pre/caliber-agent-agent_v0.1.0-pre-darwin-arm64.tar.gz"
      sha256 "<placeholder-fill-from-gh-release-sha256-sidecar>"
    end
    on_intel do
      url "https://github.com/hanfour/caliber/releases/download/agent/v0.1.0-pre/caliber-agent-agent_v0.1.0-pre-darwin-amd64.tar.gz"
      sha256 "<placeholder-fill-from-gh-release-sha256-sidecar>"
    end
  end
  def install
    bin.install "caliber-agent"
  end
  def caveats
    <<~EOS
      caliber-agent is currently an interactive CLI. Background daemon
      mode (launchd integration) ships in the next release.
    EOS
  end
end
