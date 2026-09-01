#!/usr/bin/env bash
# signal-with-swarm.sh — Launch the local Swarm and Signal applications.
#
# Private avatar keys are deliberately not exported through the local HTTP API.
# Signal identity integration must use a future signing-capability bridge.
#
# Usage: ./scripts/signal-with-swarm.sh [swarm-port] [signal-path]

set -euo pipefail

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
SWARM_ROOT=$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd)
SWARM_PORT="${1:-3090}"
SIGNAL_INPUT="${2:-${SIGNAL_BIN:-}}"
SWARM_URL="http://localhost:${SWARM_PORT}"
SWARM_READY_ATTEMPTS="${SWARM_READY_ATTEMPTS:-30}"
SWARM_READY_INTERVAL_SECONDS="${SWARM_READY_INTERVAL_SECONDS:-1}"
RUNTIME_DIR=""
SWARM_DB=""
SWARM_BLOBS=""
SWARM_PID=""

cleanup() {
    local exit_status=$?
    trap - EXIT HUP INT TERM

    if [ -n "$SWARM_PID" ]; then
        if kill -0 "$SWARM_PID" 2>/dev/null; then
            kill "$SWARM_PID" 2>/dev/null || true
        fi
        wait "$SWARM_PID" 2>/dev/null || true
        SWARM_PID=""
    fi

    if [ -n "$RUNTIME_DIR" ] && [ -d "$RUNTIME_DIR" ]; then
        rm -rf -- "$RUNTIME_DIR"
    fi

    exit "$exit_status"
}

trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

case "$SWARM_PORT" in
    ''|*[!0-9]*)
        echo "ERROR: swarm port must be a number from 1 to 65535" >&2
        exit 2
        ;;
esac
if [ "$SWARM_PORT" -lt 1 ] || [ "$SWARM_PORT" -gt 65535 ]; then
    echo "ERROR: swarm port must be a number from 1 to 65535" >&2
    exit 2
fi

case "$SWARM_READY_ATTEMPTS" in
    ''|*[!0-9]*|0)
        echo "ERROR: SWARM_READY_ATTEMPTS must be a positive integer" >&2
        exit 2
        ;;
esac

if [ -z "$SIGNAL_INPUT" ]; then
    SIGNAL_PATH=$(command -v signal 2>/dev/null || true)
else
    case "$SIGNAL_INPUT" in
        */*) SIGNAL_PATH="$SIGNAL_INPUT" ;;
        *) SIGNAL_PATH=$(command -v "$SIGNAL_INPUT" 2>/dev/null || true) ;;
    esac
fi

if [ -z "${SIGNAL_PATH:-}" ] || [ ! -x "$SIGNAL_PATH" ]; then
    echo "ERROR: pass an executable Signal binary as argument 2, set SIGNAL_BIN, or add signal to PATH" >&2
    exit 2
fi

# Keep a relative Signal path valid after changing to the Swarm checkout.
case "$SIGNAL_PATH" in
    /*) ;;
    *) SIGNAL_PATH=$(CDPATH='' cd -- "$(dirname -- "$SIGNAL_PATH")" && pwd)/$(basename -- "$SIGNAL_PATH") ;;
esac

BUN_PATH=$(command -v "${BUN_BIN:-bun}" 2>/dev/null || true)
if [ -z "$BUN_PATH" ] || [ ! -x "$BUN_PATH" ]; then
    echo "ERROR: bun is required to start the local Swarm runtime" >&2
    exit 2
fi

RUNTIME_DIR=$(mktemp -d "${TMPDIR:-/tmp}/swarm-signal.XXXXXX")
SWARM_DB="$RUNTIME_DIR/swarm.db"
SWARM_BLOBS="$RUNTIME_DIR/blobs"

echo "=== Starting swarm on port $SWARM_PORT ==="
mkdir -p "$SWARM_BLOBS"
cd "$SWARM_ROOT"
SWARM_DB_PATH="$SWARM_DB" SWARM_BLOB_DIR="$SWARM_BLOBS" \
  PORT="$SWARM_PORT" "$BUN_PATH" run packages/local/src/app.ts --password=swarm1234 &
SWARM_PID=$!

# Wait for swarm to be ready
SWARM_READY=0
attempt=1
while [ "$attempt" -le "$SWARM_READY_ATTEMPTS" ]; do
    if ! kill -0 "$SWARM_PID" 2>/dev/null; then
        wait "$SWARM_PID" 2>/dev/null || true
        SWARM_PID=""
        echo "ERROR: Swarm exited before it became ready" >&2
        exit 1
    fi

    if curl --fail --silent --show-error "$SWARM_URL/health" > /dev/null 2>&1; then
        echo "=== Swarm is ready ==="
        SWARM_READY=1
        break
    fi

    if [ "$attempt" -lt "$SWARM_READY_ATTEMPTS" ]; then
        sleep "$SWARM_READY_INTERVAL_SECONDS"
    fi
    attempt=$((attempt + 1))
done

if [ "$SWARM_READY" -ne 1 ]; then
    echo "ERROR: Swarm did not become ready after $SWARM_READY_ATTEMPTS attempts" >&2
    exit 1
fi

# Launch Signal
echo "=== Launching Signal ==="
set +e
"$SIGNAL_PATH"
SIGNAL_STATUS=$?
set -e
exit "$SIGNAL_STATUS"
