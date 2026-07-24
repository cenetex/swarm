#!/bin/bash
# signal-with-swarm.sh — Launch the local Swarm and Signal applications.
#
# Private avatar keys are deliberately not exported through the local HTTP API.
# Signal identity integration must use a future signing-capability bridge.
#
# Usage: ./scripts/signal-with-swarm.sh [swarm-port] [signal-path]

set -eu

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
SWARM_ROOT=$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd)
SWARM_PORT="${1:-3090}"
SIGNAL_BIN="${2:-${SIGNAL_BIN:-}}"
SWARM_URL="http://localhost:${SWARM_PORT}"
SWARM_DB="/tmp/swarm-signal-$$.db"
SWARM_BLOBS="/tmp/swarm-signal-blobs-$$"
SWARM_PID=""

cleanup() {
    if [ -n "$SWARM_PID" ]; then
        kill "$SWARM_PID" 2>/dev/null || true
    fi
    rm -rf "$SWARM_DB" "$SWARM_BLOBS" 2>/dev/null || true
}
trap cleanup EXIT

if [ -z "$SIGNAL_BIN" ] || [ ! -x "$SIGNAL_BIN" ]; then
    echo "ERROR: pass an executable Signal binary as argument 2 or set SIGNAL_BIN" >&2
    exit 2
fi

echo "=== Starting swarm on port $SWARM_PORT ==="
mkdir -p "$SWARM_BLOBS"
cd "$SWARM_ROOT"
SWARM_DB_PATH="$SWARM_DB" SWARM_BLOB_DIR="$SWARM_BLOBS" \
  PORT="$SWARM_PORT" bun run packages/local/src/app.ts --password=swarm1234 &
SWARM_PID=$!

# Wait for swarm to be ready
SWARM_READY=0
attempt=0
while [ "$attempt" -lt 30 ]; do
    if curl --fail --silent --show-error "$SWARM_URL/health" > /dev/null 2>&1; then
        echo "=== Swarm is ready ==="
        SWARM_READY=1
        break
    fi
    sleep 1
    attempt=$((attempt + 1))
done

if [ "$SWARM_READY" -ne 1 ]; then
    echo "ERROR: Swarm did not become ready within 30 seconds" >&2
    exit 1
fi

# Launch Signal
echo "=== Launching Signal ==="
exec "$SIGNAL_BIN"
