#!/bin/bash
# Bootstrap script to set up pnpm and install dependencies
set -e

echo "🎯 Bootstrapping aws-swarm development environment..."

# Check if corepack is available
if ! command -v corepack &> /dev/null; then
  echo "❌ Error: corepack is not available. Please ensure Node.js >=16.9.0 is installed."
  exit 1
fi

# Use corepack to activate pnpm
echo "📦 Setting up pnpm@10.19.0 via corepack..."
corepack use pnpm@10.19.0

# Ensure pnpm is available
if ! command -v pnpm &> /dev/null && ! npx pnpm &> /dev/null; then
  echo "❌ Error: pnpm could not be activated. Please check your corepack installation."
  exit 1
fi

# Install dependencies
echo "📥 Installing dependencies..."
npx pnpm install

echo "✅ Bootstrap complete! Run 'npm run build' or 'npx pnpm run build' to verify setup."
