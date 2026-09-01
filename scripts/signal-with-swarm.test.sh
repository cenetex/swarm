#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
SWARM_ROOT=$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd)
LAUNCHER="$SCRIPT_DIR/signal-with-swarm.sh"
TEST_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/signal-with-swarm-test.XXXXXX")
UNRELATED_PID=""

cleanup() {
    if [ -n "$UNRELATED_PID" ] && kill -0 "$UNRELATED_PID" 2>/dev/null; then
        kill "$UNRELATED_PID" 2>/dev/null || true
        wait "$UNRELATED_PID" 2>/dev/null || true
    fi
    rm -rf -- "$TEST_ROOT"
}
trap cleanup EXIT

fail() {
    echo "FAIL: $*" >&2
    exit 1
}

assert_file() {
    [ -f "$1" ] || fail "expected file $1"
}

assert_contains() {
    grep -F -- "$2" "$1" > /dev/null || fail "expected '$2' in $1"
}

make_stubs() {
    local case_root=$1
    mkdir -p "$case_root/bin" "$case_root/tmp" "$case_root/log"

    cat > "$case_root/bin/bun" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$PWD" > "$SWARM_TEST_LOG_DIR/swarm.cwd"
printf '%s\n' "$*" > "$SWARM_TEST_LOG_DIR/swarm.args"
printf '%s\n' "$SWARM_DB_PATH" > "$SWARM_TEST_LOG_DIR/swarm.db-path"
printf '%s\n' "$SWARM_BLOB_DIR" > "$SWARM_TEST_LOG_DIR/swarm.blob-path"
printf '%s\n' "$$" > "$SWARM_TEST_LOG_DIR/swarm.pid"
touch "$SWARM_DB_PATH" "$SWARM_BLOB_DIR/runtime"
trap 'printf "%s\n" stopped > "$SWARM_TEST_LOG_DIR/swarm.stopped"; exit 0' TERM INT
touch "$SWARM_TEST_LOG_DIR/swarm.started"
while :; do
    /bin/sleep 0.05
done
STUB

    cat > "$case_root/bin/curl" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$SWARM_TEST_LOG_DIR/curl.calls"
if [ "${SWARM_TEST_HEALTH:-ready}" = "ready" ] && [ -f "$SWARM_TEST_LOG_DIR/swarm.started" ]; then
    exit 0
fi
exit 22
STUB

    cat > "$case_root/bin/signal" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' launched > "$SWARM_TEST_LOG_DIR/signal.launched"
if env | grep -q '^SIGNAL_AVATAR_KEYPAIR'; then
    echo "private key material reached Signal" >&2
    exit 99
fi
exit "${SWARM_TEST_SIGNAL_EXIT:-0}"
STUB

    chmod +x "$case_root/bin/bun" "$case_root/bin/curl" "$case_root/bin/signal"
}

run_launcher() {
    local case_root=$1
    shift
    (
        cd "$case_root"
        PATH="$case_root/bin:$PATH" \
        TMPDIR="$case_root/tmp" \
        SWARM_TEST_LOG_DIR="$case_root/log" \
        SWARM_READY_ATTEMPTS="${SWARM_READY_ATTEMPTS:-3}" \
        SWARM_READY_INTERVAL_SECONDS=0 \
        "$LAUNCHER" "$@"
    ) > "$case_root/output.log" 2>&1
}

invalid_case="$TEST_ROOT/invalid"
make_stubs "$invalid_case"
if run_launcher "$invalid_case" 3090 "$invalid_case/bin/missing-signal"; then
    fail "missing Signal binary should fail"
fi
assert_contains "$invalid_case/output.log" "pass an executable Signal binary"
[ ! -e "$invalid_case/log/swarm.started" ] || fail "Swarm started before Signal validation"

success_case="$TEST_ROOT/success"
make_stubs "$success_case"
mv "$success_case/bin/signal" "$success_case/bin/signal app"
/bin/sleep 30 &
UNRELATED_PID=$!
run_launcher "$success_case" 3091 "$success_case/bin/signal app"
assert_file "$success_case/log/signal.launched"
assert_file "$success_case/log/swarm.stopped"
assert_contains "$success_case/log/swarm.cwd" "$SWARM_ROOT"
assert_contains "$success_case/log/swarm.args" "run packages/local/src/app.ts --password=swarm1234"
assert_contains "$success_case/log/curl.calls" "http://localhost:3091/health"
if grep -F '/api/signal/keypair' "$success_case/log/curl.calls" > /dev/null; then
    fail "launcher requested the private keypair endpoint"
fi
runtime_db=$(cat "$success_case/log/swarm.db-path")
runtime_blobs=$(cat "$success_case/log/swarm.blob-path")
[ ! -e "$runtime_db" ] || fail "temporary database was not removed"
[ ! -e "$runtime_blobs" ] || fail "temporary blob directory was not removed"
kill -0 "$UNRELATED_PID" 2>/dev/null || fail "launcher stopped an unrelated process"
kill "$UNRELATED_PID"
wait "$UNRELATED_PID" 2>/dev/null || true
UNRELATED_PID=""

timeout_case="$TEST_ROOT/timeout"
make_stubs "$timeout_case"
export SWARM_TEST_HEALTH=never
export SWARM_READY_ATTEMPTS=2
if run_launcher "$timeout_case" 3092; then
    fail "readiness timeout should fail"
fi
unset SWARM_TEST_HEALTH SWARM_READY_ATTEMPTS
assert_contains "$timeout_case/output.log" "did not become ready after 2 attempts"
assert_file "$timeout_case/log/swarm.stopped"
[ ! -e "$timeout_case/log/signal.launched" ] || fail "Signal launched after readiness timeout"
timeout_db=$(cat "$timeout_case/log/swarm.db-path")
timeout_blobs=$(cat "$timeout_case/log/swarm.blob-path")
[ ! -e "$timeout_db" ] || fail "timeout database was not removed"
[ ! -e "$timeout_blobs" ] || fail "timeout blob directory was not removed"

echo "signal-with-swarm smoke test passed"
