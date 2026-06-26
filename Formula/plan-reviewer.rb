require "json"

class PlanReviewer < Formula
  desc "Local HTML plan review daemon and CLI for agent comment workflows"
  homepage "https://github.com/Nodaste-Lab/plan-reviewer"
  url "https://github.com/Nodaste-Lab/plan-reviewer/archive/refs/tags/v0.1.0.tar.gz"
  sha256 "d6fac34c6286032f772b918242fdcb21d302b21aeb4f42b2333f3a739726bf1b"
  head "https://github.com/Nodaste-Lab/plan-reviewer.git", branch: "main"
  # The stable v0.1.0 tarball predates the repository's Apache-2.0 migration.
  # Update this to Apache-2.0 with the next release URL and checksum.
  license "MIT"

  depends_on "node"

  def install
    system "npm", "ci", "--include=dev"
    system "npm", "run", "build"
    system "npm", "prune", "--omit=dev"

    # Homebrew HEAD reinstalls can target the same HEAD-<sha> keg path.
    # Clear formula-owned artifacts first so a reinstall does not fail on
    # existing libexec contents or the generated CLI symlink.
    libexec.rmtree if libexec.exist?
    rm_f bin/"plan-review"

    libexec.install "bin", "dist", "node_modules", "package.json", "package-lock.json"
    build_commit = (buildpath/".git").exist? ? Utils.safe_popen_read("git", "rev-parse", "HEAD").strip : ""
    build_metadata = {
      source: "homebrew",
      formula: "plan-reviewer",
      formulaVersion: version.to_s,
      gitCommit: build_commit.empty? ? nil : build_commit
    }.compact
    (libexec/"plan-reviewer-build.json").write(JSON.pretty_generate(build_metadata))
    bin.install_symlink libexec/"bin/plan-review" => "plan-review"
  end

  service do
    run [
      opt_bin/"plan-review", "serve",
      "--host", "0.0.0.0",
      "--port", "4317",
      "--db", "#{Dir.home}/.plan-reviewer/plan-reviewer.sqlite"
    ]
    keep_alive true
    log_path var/"log/plan-reviewer.log"
    error_log_path var/"log/plan-reviewer.err.log"
  end

  def caveats
    <<~EOS
      Stop the persistent service with:
        brew services stop plan-reviewer

      Uninstalling the formula does not delete review data. To remove stored
      plans, comments, assets, and watch state manually:
        rm -rf ~/.plan-reviewer
    EOS
  end

  test do
    assert_match "plan-review", shell_output("#{bin}/plan-review --help")
  end
end
