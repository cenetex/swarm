#!/bin/bash
#
# Release Script — follows SemVer (see CLAUDE.md § Versioning)
#
# Usage:
#   ./scripts/release.sh            # patch (bug fixes, config changes)
#   ./scripts/release.sh minor      # new features, significant refactors
#   ./scripts/release.sh major      # breaking changes, schema migrations
#   ./scripts/release.sh v1.0.0     # explicit version
#   ./scripts/release.sh --dry-run  # run preflight only, skip publish
#   ./scripts/release.sh --skip-preflight patch  # skip preflight (emergency)
#
# Creates a GitHub Release (and tag) on main via the GitHub CLI.
# The release-notes.yml workflow will fire and overwrite the body
# with AI-polished release notes.
#

set -e

# ── Parse flags ──────────────────────────────────────────────────────────────

DRY_RUN=false
SKIP_PREFLIGHT=false
VERSION_ARG=""

for arg in "$@"; do
  case "$arg" in
    --dry-run)        DRY_RUN=true ;;
    --skip-preflight) SKIP_PREFLIGHT=true ;;
    *)                VERSION_ARG="$arg" ;;
  esac
done

# ── Preflight checks ────────────────────────────────────────────────────────

preflight_pass() {
  echo "[PREFLIGHT] $1... ✓"
}

preflight_fail() {
  echo "[PREFLIGHT] $1... ✗"
  echo "ERROR: Release gate failed: $2"
  exit 1
}

if [ "$SKIP_PREFLIGHT" = true ]; then
  echo ""
  echo "WARNING: --skip-preflight specified. Skipping all validation gates."
  echo "WARNING: Use this only for emergency releases."
  echo ""
else
  echo ""
  echo "Running preflight checks..."
  echo ""

  # 1. Clean git state
  if git diff --quiet && git diff --cached --quiet; then
    preflight_pass "Checking clean git state"
  else
    preflight_fail "Checking clean git state" "working tree has uncommitted changes."
  fi

  # 2. On main branch
  current_branch=$(git rev-parse --abbrev-ref HEAD)
  if [ "$current_branch" = "main" ]; then
    preflight_pass "Checking branch is main"
  else
    preflight_fail "Checking branch is main" "current branch is '$current_branch', expected 'main'."
  fi

  # 3. Lint
  echo "[PREFLIGHT] Running lint..."
  if pnpm lint > /dev/null 2>&1; then
    preflight_pass "Running lint"
  else
    preflight_fail "Running lint" "pnpm lint found errors."
  fi

  # 4. Typecheck
  echo "[PREFLIGHT] Running typecheck..."
  if pnpm typecheck > /dev/null 2>&1; then
    preflight_pass "Running typecheck"
  else
    preflight_fail "Running typecheck" "pnpm typecheck found errors."
  fi

  # 5. Build
  echo "[PREFLIGHT] Running build..."
  if pnpm build > /dev/null 2>&1; then
    preflight_pass "Running build"
  else
    preflight_fail "Running build" "pnpm build failed."
  fi

  # 6. Test
  echo "[PREFLIGHT] Running tests..."
  if bun test > /dev/null 2>&1; then
    preflight_pass "Running tests"
  else
    preflight_fail "Running tests" "bun test had failures."
  fi

  # 7. Audit
  echo "[PREFLIGHT] Running audit..."
  if pnpm audit --audit-level=high > /dev/null 2>&1; then
    preflight_pass "Running audit"
  else
    preflight_fail "Running audit" "pnpm audit found high-severity findings."
  fi

  # 8. Security exceptions
  echo "[PREFLIGHT] Validating security exceptions..."
  if node scripts/validate-security-exceptions.mjs --warn-days 14 > /dev/null 2>&1; then
    preflight_pass "Validating security exceptions"
  else
    preflight_fail "Validating security exceptions" "security exception validation failed."
  fi

  echo ""
  echo "All preflight checks passed."
  echo ""
fi

# ── Dry-run exit ─────────────────────────────────────────────────────────────

if [ "$DRY_RUN" = true ]; then
  echo "Dry run complete. Skipping release creation."
  exit 0
fi

# ── Release flow ─────────────────────────────────────────────────────────────

# Ensure gh CLI is available
if ! command -v gh &>/dev/null; then
  echo "Error: GitHub CLI (gh) is required. Install: https://cli.github.com"
  exit 1
fi

# Fetch latest tags
echo "Fetching latest tags..."
git fetch --tags --quiet

# Get current highest version
current_tag=$(git tag --list 'v*' | sort -V | tail -1)
if [ -z "$current_tag" ]; then
  current_tag="v0.0.0"
fi

current_version="${current_tag#v}"
IFS='.' read -r major minor patch <<< "$current_version"

# Determine new version
if [ -z "$VERSION_ARG" ] || [ "$VERSION_ARG" = "patch" ]; then
  new_version="v$major.$minor.$((patch + 1))"
elif [ "$VERSION_ARG" = "minor" ]; then
  new_version="v$major.$((minor + 1)).0"
elif [ "$VERSION_ARG" = "major" ]; then
  new_version="v$((major + 1)).0.0"
elif [[ "$VERSION_ARG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  new_version="$VERSION_ARG"
else
  echo "Invalid argument: $VERSION_ARG"
  echo "Usage: $0 [patch|minor|major|vX.Y.Z] [--dry-run] [--skip-preflight]"
  exit 1
fi

# Validate new version is higher
new_ver_nums="${new_version#v}"
higher=$(echo -e "$current_version\n$new_ver_nums" | sort -V | tail -1)
if [ "$higher" = "$current_version" ] && [ "$current_version" != "$new_ver_nums" ]; then
  echo "Version $new_version is not higher than current $current_tag"
  exit 1
fi

# Build changelog
changelog=$(git log --oneline "$current_tag"..HEAD 2>/dev/null | head -20 || echo "Initial release")

# Show summary
echo ""
echo "Release Summary:"
echo "   Current version: $current_tag"
echo "   New version:     $new_version"
echo ""
echo "Recent changes since $current_tag:"
echo "$changelog"
echo ""

# Confirm
read -p "Create release $new_version on main? [y/N] " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
  echo "Aborted."
  exit 0
fi

# Create GitHub Release (this creates the tag on main remotely)
echo "Creating release..."
gh release create "$new_version" \
  --target main \
  --title "$new_version" \
  --notes "$changelog"

echo ""
echo "Released $new_version"
echo "release-notes.yml will overwrite the body with AI-polished notes."
echo "Watch: https://github.com/cenetex/aws-swarm/actions"
