# Telegram Quick Start & Repair Playbook

> Fast repair flows for Telegram webhook setup and common failures.

---

## Quick Setup: Bot Token + Webhook Registration

### Prerequisites

- Avatar ID (`AVATAR_ID`) - the bot identifier in Swarm
- AWS Secrets Manager access in the target region
- Telegram bot token from [@BotFather](https://t.me/botfather)
- Public HTTPS API domain (DNS CNAME to API Gateway)
- AWS region and account ID

### Step 1: Store Bot Token in Secrets Manager

```bash
export REGION="us-east-1"
export AVATAR_ID="your-avatar-id"
export BOT_TOKEN="123456789:ABCDEFG..."  # From @BotFather

aws secretsmanager put-secret-value \
  --region "$REGION" \
  --secret-id "swarm/${AVATAR_ID}/telegram_bot_token/default" \
  --secret-string "$BOT_TOKEN"
```

### Step 2: Generate Webhook Secret

```bash
export WEBHOOK_SECRET=$(openssl rand -base64 32)
echo "Webhook secret: $WEBHOOK_SECRET"

aws secretsmanager put-secret-value \
  --region "$REGION" \
  --secret-id "swarm/${AVATAR_ID}/telegram_webhook_secret/default" \
  --secret-string "$WEBHOOK_SECRET"
```

### Step 3: Register Webhook with Telegram

```bash
export API_DOMAIN="api.your-domain.com"

curl -s "https://api.telegram.org/bot${BOT_TOKEN}/setWebhook" \
  -d "url=https://${API_DOMAIN}/webhook/telegram/${AVATAR_ID}" \
  -d "secret_token=${WEBHOOK_SECRET}" \
  -d "allowed_updates=[\"message\",\"edited_message\",\"channel_post\",\"my_chat_member\",\"callback_query\"]" | jq .
```

**Expected response:** `"ok":true`

---

## Quick Repairs

### Webhook not receiving messages

1. **Verify webhook is still registered:**
   ```bash
   curl -s "https://api.telegram.org/bot${BOT_TOKEN}/getWebhookInfo" | jq .
   ```
   Expected: `"url":"https://api.your-domain.com/webhook/telegram/AVATAR_ID"`

2. **If `pending_update_count > 0`**, Telegram is queuing updates because the webhook failed. Re-run Step 3 above to re-register.

3. **Check Lambda invocation logs:**
   ```bash
   aws logs tail "/aws/lambda/swarm-${ENVIRONMENT}-telegram-webhook" --since 5m --follow
   ```

### Secret token mismatch (401 errors)

```bash
# Get the current secret from Secrets Manager
CURRENT_SECRET=$(aws secretsmanager get-secret-value \
  --region "$REGION" \
  --secret-id "swarm/${AVATAR_ID}/telegram_webhook_secret/default" \
  --query SecretString --output text)

# Re-register the webhook with Telegram using the current secret
curl -s "https://api.telegram.org/bot${BOT_TOKEN}/setWebhook" \
  -d "url=https://${API_DOMAIN}/webhook/telegram/${AVATAR_ID}" \
  -d "secret_token=${CURRENT_SECRET}" | jq .
```

### Test message flow (end-to-end)

1. Send a test message to the bot's DM or group chat.
2. Check webhook logs within 30 seconds:
   ```bash
   aws logs tail "/aws/lambda/swarm-${ENVIRONMENT}-telegram-webhook" --since 30s
   ```
3. Check message processor:
   ```bash
   aws logs tail "/aws/lambda/swarm-${ENVIRONMENT}-message-processor" --since 30s
   ```
4. Check response sender:
   ```bash
   aws logs tail "/aws/lambda/swarm-${ENVIRONMENT}-response-sender" --since 30s
   ```

---

## Full Troubleshooting

For detailed diagnosis steps, platform-specific configuration, and DLQ recovery, see [docs/RUNBOOK.md § Telegram](./RUNBOOK.md#telegram).
