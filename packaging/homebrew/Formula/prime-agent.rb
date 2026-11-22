# Homebrew formula candidate for prime-agent v1.0.0 (the Rust port).
#
# Context: this supersedes Homebrew/homebrew-core#297372, the node-based
# formula for the TypeScript product. The Rust port is distributed as a
# source tarball (prime-agent-<version>-src.tar.gz: the git tree at the tag
# plus the bundled catalog assets at the archive root — see
# scripts/release/assemble_source.py and the assemble step in
# .github/workflows/release.yml), which this formula builds with cargo.
# The cask sketch next door (packaging/homebrew/Casks/prime-agent.rb) is
# the vendor-tap alternative (prebuilt binaries) and stays untouched.
#
# Submission note: the sha256 below is a placeholder, filled from the
# v1.0.0 release's SHA256SUMS when the tag publishes.
class PrimeAgent < Formula
  desc "Coding agent harness with a persistent Bun JavaScript control environment"
  homepage "https://github.com/sashimikun/prime-agent"
  url "https://github.com/sashimikun/prime-agent/releases/download/v0.10.5/prime-agent-0.10.5-src.tar.gz"
  # TODO: replace with the release src-tarball sha256 from the release SHA256SUMS
  sha256 "0000000000000000000000000000000000000000000000000000000000000000"
  license "MIT"

  livecheck do
    url "https://github.com/sashimikun/prime-agent/releases/latest"
    # Stable releases only: the beta cuts (-beta.N) build no source tarball.
    regex(/prime-agent-v?(\d+(?:\.\d+)+)-src\.tar\.gz/i)
  end

  depends_on "rust" => :build
  # The binary runs its persistent JavaScript REPL through Bun (>= 1.3.14).
  depends_on "oven-sh/bun/bun"

  def install
    system "cargo", "build", "--release", "--locked"
    # The shipped payload set (assemble_artifacts.py STAGED_ENTRIES): the
    # binary plus the kernel runtime, skills, and the bundled catalog
    # assets it resolves beside its executable.
    libexec.install "target/release/prime-agent"
    libexec.install "prime-agent-runtime", "skills"
    libexec.install "models.bundled.json", "mcp-services.bundled.json"
    libexec.install "LICENSE", "README.md"
    bin.install_symlink libexec/"prime-agent"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/prime-agent --version")
  end
end
