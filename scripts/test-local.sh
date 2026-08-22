#!/bin/bash
# Test the local swarm server end-to-end.
# Usage: ./scripts/test-local.sh [password]
set -euo pipefail

PASSWORD="${1:-woodenbox}"
PORT="${PORT:-3099}"
SIDECAR="packages/desktop/src-tauri/binaries/swarm-server-aarch64-apple-darwin"
ADMIN_UI="packages/admin-ui/dist"
LOG_FILE="$HOME/Library/Application Support/Swarm/swarm.log"
DB_FILE="$HOME/Library/Application Support/Swarm/swarm.db"

echo "=== Test: Swarm Local Server ==="
echo ""

# Kill any existing test server on our port
lsof -ti ":$PORT" 2>/dev/null | xargs kill -9 2>/dev/null || true
sleep 1

# Clear previous test database
rm -f "$DB_FILE" "$LOG_FILE"
echo "[setup] Clean database"

# Start server
echo "[setup] Starting server on port $PORT..."
PORT="$PORT" "$SIDECAR" \
  --password "$PASSWORD" \
  --admin-ui-path "$ADMIN_UI" \
  > /tmp/swarm-test-stdout.log 2>&1 &

SERVER_PID=$!
sleep 5

# Check if server started
if ! kill -0 $SERVER_PID 2>/dev/null; then
  echo "FAIL: Server failed to start"
  cat /tmp/swarm-test-stdout.log
  exit 1
fi

# Test health
echo ""
echo "--- Health Check ---"
HEALTH=$(curl -s "http://localhost:$PORT/health" || echo '{"status":"error"}')
echo "$HEALTH" | python3 -m json.tool 2>/dev/null || echo "$HEALTH"
if echo "$HEALTH" | grep -q '"ok"'; then
  echo "PASS: health"
else
  echo "FAIL: health"
fi

# Test auth
echo ""
echo "--- Auth ---"
AUTH=$(curl -s "http://localhost:$PORT/api/auth/me" || echo '{}')
if echo "$AUTH" | grep -q '"authenticated":true'; then
  echo "PASS: auth/me"
else
  echo "FAIL: auth/me"
fi

# Test consent
echo ""
echo "--- Consent ---"
CONSENT=$(curl -s "http://localhost:$PORT/api/consent?policyVersion=1.3" || echo '{}')
if echo "$CONSENT" | grep -q '"consented":true'; then
  echo "PASS: consent"
else
  echo "FAIL: consent"
fi

# Test avatars list
echo ""
echo "--- Avatars List ---"
AVATARS=$(curl -s "http://localhost:$PORT/api/avatars" || echo '{"error":"request failed"}')
if echo "$AVATARS" | grep -q '"avatars"'; then
  echo "PASS: avatars list"
else
  echo "FAIL: avatars list"
  echo "$AVATARS" | head -5
fi

# Test secrets
echo ""
echo "--- Secrets ---"
curl -s -X POST "http://localhost:$PORT/api/secrets/test-key" \
  -H "Content-Type: application/json" \
  -d '{"value":"test-value"}' > /dev/null
SECRET=$(curl -s "http://localhost:$PORT/api/secrets/test-key" || echo '{}')
if echo "$SECRET" | grep -q '"test-value"'; then
  echo "PASS: secrets set/get"
else
  echo "FAIL: secrets"
fi

# Show logs
echo ""
echo "--- Server Logs ---"
cat "$LOG_FILE" 2>/dev/null | grep -i "error\|fail\|avatars" | tail -10 || echo "(no errors in log)"

# Show full log
echo ""
echo "--- Full Log (last 15 lines) ---"
cat "$LOG_FILE" 2>/dev/null | tail -15 || echo "(no log)"

# Cleanup
kill $SERVER_PID 2>/dev/null || true
echo ""
echo "=== Test Complete ==="
