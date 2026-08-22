#!/bin/bash
# Build Swarm Desktop — compile to standalone binary and assemble .app bundle.
set -euo pipefail

APP_NAME="Swarm"
BUNDLE_DIR="dist/${APP_NAME}.app"
ENTRY="packages/local/src/app.ts"

echo "==> Building standalone binary..."
bun build --compile --target=bun-darwin-arm64 "$ENTRY" --outfile "$BUNDLE_DIR/Contents/MacOS/${APP_NAME}"

echo "==> Copying bundle resources..."
cp packages/local/app-bundle/Contents/Info.plist "$BUNDLE_DIR/Contents/Info.plist"
cp packages/local/app-bundle/Contents/Resources/AppIcon.icns "$BUNDLE_DIR/Contents/Resources/AppIcon.icns"
cp packages/local/app-bundle/Contents/Resources/AppIcon.png "$BUNDLE_DIR/Contents/Resources/AppIcon.png" 2>/dev/null || true

echo "==> Cleaning extended attributes..."
xattr -cr "$BUNDLE_DIR" 2>/dev/null || true

echo ""
echo "✅ Built: $BUNDLE_DIR"
echo "   Binary: $(ls -lh "$BUNDLE_DIR/Contents/MacOS/${APP_NAME}" | awk '{print $5}')"
echo ""
echo "   Open with:  open $BUNDLE_DIR"
echo "   Or drag to: /Applications/"
