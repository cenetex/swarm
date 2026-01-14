#!/bin/bash
# End-to-end test script for Swarm agents
# Usage: ./scripts/test-e2e.sh <platform> <agent-id> <message>

PLATFORM=$1
AGENT_ID=$2
MESSAGE=$3
ENV=${4:-staging}

if [ -z "$PLATFORM" ] || [ -z "$AGENT_ID" ] || [ -z "$MESSAGE" ]; then
  echo "Usage: $0 <platform> <agent-id> <message> [env=staging]"
  echo "Platforms: telegram, web"
  exit 1
fi

# Ensure scripts are executable
chmod +x ./scripts/test-api.sh

case $PLATFORM in
  telegram)
    # Simulate Telegram webhook call
    UPDATE='{"message":{"message_id":'$(date +%s)',"from":{"id":123,"is_bot":false,"username":"tester"},"chat":{"id":123,"type":"private"},"text":"'$MESSAGE'","date":'$(date +%s)'}}'
    ./scripts/test-api.sh "$ENV" "webhook/telegram/$AGENT_ID" "$UPDATE"
    ;;
  web)
    PAYLOAD='{"message":"'$MESSAGE'","history":[],"agent":{"id":"'$AGENT_ID'"}}'
    ./scripts/test-api.sh "$ENV" chat "$PAYLOAD"
    ;;
  *)
    echo "Unknown platform: $PLATFORM"
    exit 1
    ;;
esac
