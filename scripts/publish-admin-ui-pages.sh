#!/usr/bin/env bash
#
# Build the browser-local admin UI and publish it to GitHub Pages.
#
# Usage:
#   ./scripts/publish-admin-ui-pages.sh
#   ./scripts/publish-admin-ui-pages.sh --dry-run
#
# Environment:
#   REMOTE       Git remote to push to (default: origin2, fallback: origin)
#   PAGES_BRANCH GitHub Pages branch (default: gh-pages)
#   CNAME        Custom domain written to CNAME (default: swarm.rati.chat)

set -euo pipefail

DRY_RUN=false
for arg in "$@"; do
  case "$arg" in
    --dry-run)
      DRY_RUN=true
      ;;
    *)
      echo "Unknown argument: $arg" >&2
      echo "Usage: $0 [--dry-run]" >&2
      exit 2
      ;;
  esac
done

ROOT_DIR=$(git rev-parse --show-toplevel)
REMOTE=${REMOTE:-origin2}
PAGES_BRANCH=${PAGES_BRANCH:-gh-pages}
CNAME=${CNAME:-swarm.rati.chat}
DIST_DIR="$ROOT_DIR/packages/admin-ui/dist"

if ! git -C "$ROOT_DIR" remote get-url "$REMOTE" >/dev/null 2>&1; then
  REMOTE=origin
fi

if ! git -C "$ROOT_DIR" remote get-url "$REMOTE" >/dev/null 2>&1; then
  echo "No usable git remote found. Set REMOTE explicitly." >&2
  exit 1
fi

echo "Building admin UI for browser-local Pages..."
(
  cd "$ROOT_DIR"
  VITE_WEB_LOCAL=1 pnpm --filter @swarm/admin-ui build
)

if [ ! -f "$DIST_DIR/index.html" ]; then
  echo "Build did not produce $DIST_DIR/index.html" >&2
  exit 1
fi

cp "$DIST_DIR/index.html" "$DIST_DIR/404.html"
printf '%s\n' "$CNAME" > "$DIST_DIR/CNAME"
touch "$DIST_DIR/.nojekyll"

WORK_DIR=$(mktemp -d "${TMPDIR:-/tmp}/swarm-admin-ui-pages.XXXXXX")
cleanup() {
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT

git -C "$WORK_DIR" init -q
git -C "$WORK_DIR" remote add origin "$(git -C "$ROOT_DIR" remote get-url "$REMOTE")"

if git -C "$WORK_DIR" fetch -q --depth=1 origin "$PAGES_BRANCH"; then
  git -C "$WORK_DIR" checkout -q -B "$PAGES_BRANCH" FETCH_HEAD
else
  git -C "$WORK_DIR" checkout -q --orphan "$PAGES_BRANCH"
fi

find "$WORK_DIR" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
cp -R "$DIST_DIR"/. "$WORK_DIR"/

git -C "$WORK_DIR" add -A
if git -C "$WORK_DIR" diff --cached --quiet; then
  echo "No Pages changes to publish."
  exit 0
fi

git -C "$WORK_DIR" status --short

if [ "$DRY_RUN" = true ]; then
  echo "Dry run complete. Skipping commit and push."
  exit 0
fi

git -C "$WORK_DIR" commit -m "Publish web-local admin UI"
git -C "$WORK_DIR" push origin "$PAGES_BRANCH"

echo "Published $DIST_DIR to $REMOTE/$PAGES_BRANCH with CNAME=$CNAME."
