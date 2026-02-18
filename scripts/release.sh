#!/bin/bash
#
# Release Script
#
# Usage:
#   ./scripts/release.sh [patch|minor|major]
#   ./scripts/release.sh v0.2.0  # explicit version
#
# Creates a GitHub Release (and tag) on main via the GitHub CLI.
# The release-notes.yml workflow will fire and overwrite the body
# with AI-polished release notes.
#

set -e

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
if [ -z "$1" ] || [ "$1" = "patch" ]; then
  new_version="v$major.$minor.$((patch + 1))"
elif [ "$1" = "minor" ]; then
  new_version="v$major.$((minor + 1)).0"
elif [ "$1" = "major" ]; then
  new_version="v$((major + 1)).0.0"
elif [[ "$1" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  new_version="$1"
else
  echo "Invalid argument: $1"
  echo "Usage: $0 [patch|minor|major|vX.Y.Z]"
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
echo "Watch: https://github.com/atimics/aws-swarm/actions"
