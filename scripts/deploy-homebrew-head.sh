#!/usr/bin/env bash
set -euo pipefail

formula="Nodaste-Lab/plan-reviewer/plan-reviewer"
service="plan-reviewer"
health_url="${PLAN_REVIEW_HEALTH_URL:-http://127.0.0.1:4317/health}"
cellar_path=""

relink_formula() {
  # Homebrew will not link a newly built HEAD keg while an older HEAD keg is
  # still linked. Unlink first, then let Homebrew recreate its managed links.
  echo "==> Relinking Homebrew formula"
  brew unlink "$service" >/dev/null 2>&1 || true
  brew link --overwrite "$formula"
}

verify_keg_metadata() {
  local opt_path
  opt_path="$(brew --prefix "$formula")"
  cellar_path="$(realpath "$opt_path")"
  if [[ "$cellar_path" != */Cellar/plan-reviewer/HEAD-* ]]; then
    echo "ERROR: expected a Homebrew HEAD Cellar path, got: $cellar_path" >&2
    return 1
  fi
  if [[ ! -f "$cellar_path/INSTALL_RECEIPT.json" ]]; then
    echo "ERROR: missing Homebrew INSTALL_RECEIPT.json in $cellar_path" >&2
    return 1
  fi
  if [[ ! -f "$cellar_path/.brew/plan-reviewer.rb" ]]; then
    echo "ERROR: missing Homebrew formula metadata in $cellar_path/.brew" >&2
    return 1
  fi
}

echo "==> Updating Homebrew metadata"
brew update

if brew list --formula "$formula" >/dev/null 2>&1 || brew list --formula "$service" >/dev/null 2>&1; then
  installed_version="$(brew info "$formula" --json=v2 | python3 -c 'import json,sys; data=json.load(sys.stdin)["formulae"][0]; installed=data.get("installed", []); print(installed[0].get("version", "") if installed else "")')"
  tap_repo="$(brew --repository Nodaste-Lab/plan-reviewer 2>/dev/null || true)"
  latest_head=""
  if [[ -n "$tap_repo" && -d "$tap_repo/.git" ]]; then
    latest_head="HEAD-$(git -C "$tap_repo" rev-parse --short=7 HEAD)"
  fi

  if [[ -n "$latest_head" && "$installed_version" == "$latest_head" ]]; then
    echo "==> HEAD install already matches $latest_head; skipping Homebrew rebuild"
  else
    echo "==> Upgrading HEAD install"
    if ! brew upgrade --fetch-HEAD "$formula"; then
      echo "==> Upgrade did not finish cleanly; reinstalling the existing Homebrew formula options"
      brew reinstall "$formula"
    fi
  fi
else
  echo "==> Installing HEAD formula"
  brew install --HEAD "$formula"
fi

# A prior non-Homebrew deploy may have left stale plan-reviewer-owned symlinks
# behind, and Homebrew can leave an older HEAD keg linked after building a new
# one. Relink through Homebrew so service management sees the installed keg.
relink_formula

echo "==> Verifying Homebrew keg metadata"
if ! verify_keg_metadata; then
  echo "==> Keg metadata incomplete; reinstalling the existing Homebrew formula options"
  brew reinstall "$formula"
  relink_formula
  echo "==> Verifying repaired Homebrew keg metadata"
  verify_keg_metadata
fi

echo "==> Restarting service"
brew services restart "$service"

echo "==> Verifying service health"
plan-review --version
for attempt in {1..40}; do
  if curl -fsS "$health_url" >/dev/null 2>&1; then
    printf 'plan-reviewer deployed from %s and healthy at %s\n' "$cellar_path" "$health_url"
    exit 0
  fi
  sleep 0.5
done

echo "ERROR: service did not become healthy at $health_url" >&2
exit 1
