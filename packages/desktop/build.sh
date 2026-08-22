#!/bin/bash
# Build Swarm Desktop — compile Bun sidecar, then build Tauri .app bundle.
set -euo pipefail
cd "$(dirname "$0")"

echo "==> Building Bun sidecar binary..."
mkdir -p src-tauri/binaries
bun build --compile --target=bun-darwin-arm64 ../local/src/app.ts --outfile src-tauri/binaries/swarm-server-aarch64-apple-darwin
echo "   Sidecar: $(ls -lh src-tauri/binaries/swarm-server-aarch64-apple-darwin | awk '{print $5}')"

echo "==> Building admin UI..."
(cd ../admin-ui && pnpm build) || { echo "ERROR: admin-ui build failed"; exit 1; }
echo "==> Copying admin UI dist..."
rm -rf src-tauri/admin-ui
cp -r ../admin-ui/dist src-tauri/admin-ui
echo "   Admin UI: $(du -sh src-tauri/admin-ui | awk '{print $1}')"

echo "==> Installing Tauri dependencies..."
bun install

echo "==> Building Tauri app..."
bun tauri build

echo ""
echo "✅ Built. Find the .app in: src-tauri/target/release/bundle/macos/"
