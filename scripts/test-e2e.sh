#!/bin/bash
# End-to-end test script for Swarm avatars
# Usage: ./scripts/test-e2e.sh <platform> <avatar-id> <message>

PLATFORM=$1
AVATAR_ID=$2
MESSAGE=$3
ENV=${4:-staging}

if [ -z "$PLATFORM" ] || [ -z "$AVATAR_ID" ] || [ -z "$MESSAGE" ]; then
  echo "Usage: $0 <platform> <avatar-id> <message> [env=staging]"
  echo "Platforms: telegram, web"
  exit 1
fi

# Ensure scripts are executable
chmod +x ./scripts/test-api.sh

case $PLATFORM in
  telegram)
    # Simulate Telegram webhook call
    UPDATE='{"message":{"message_id":'$(date +%s)',"from":{"id":123,"is_bot":false,"username":"tester"},"chat":{"id":123,"type":"private"},"text":"'$MESSAGE'","date":'$(date +%s)'}}'
    ./scripts/test-api.sh "$ENV" "webhook/telegram/$AVATAR_ID" "$UPDATE"
    ;;
  web)
    PAYLOAD='{"message":"'$MESSAGE'","history":[],"agent":{"id":"'$AVATAR_ID'"}}'
    ./scripts/test-api.sh "$ENV" chat "$PAYLOAD"
    ;;
  *)
    echo "Unknown platform: $PLATFORM"
    exit 1
    ;;
esac
