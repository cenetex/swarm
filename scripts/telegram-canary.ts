#!/usr/bin/env bun
/**
 * Telegram Canary Smoke Test
 *
 * Sends a [CANARY]-prefixed message to a staging avatar via Telegram Bot API,
 * waits for a bot response within a configurable timeout, and reports
 * pass/fail with structured JSON output.
 *
 * Environment variables:
 *   CANARY_BOT_TOKEN   (required) — Telegram Bot API token for the canary bot
 *   CANARY_CHAT_ID     (required) — Telegram chat ID where the canary avatar lives
 *   CANARY_TIMEOUT_MS  (optional) — Response timeout in ms (default: 30000)
 *
 * Optional (webhook smoke tests):
 *   WEBHOOK_URL        — Staging webhook endpoint URL
 *   WEBHOOK_SECRET     — Telegram webhook secret token
 *
 * Usage:
 *   CANARY_BOT_TOKEN=xxx CANARY_CHAT_ID=xxx bun run scripts/telegram-canary.ts
 *   pnpm canary:telegram
 *
 * Exit codes:
 *   0 — all checks passed
 *   1 — one or more checks failed
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CanaryResult {
  timestamp: string;
  suite: string;
  status: "pass" | "fail" | "skip";
  durationMs: number;
  checks: CheckResult[];
  summary: string;
}

interface CheckResult {
  name: string;
  status: "pass" | "fail" | "skip";
  message: string;
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const CANARY_PREFIX = "[CANARY]";
const DEFAULT_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 3_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Error: Required environment variable ${name} is not set.`);
    console.error("");
    console.error("Required:");
    console.error("  CANARY_BOT_TOKEN=xxx  CANARY_CHAT_ID=xxx");
    console.error("");
    console.error("Optional:");
    console.error("  CANARY_TIMEOUT_MS=30000");
    console.error("  WEBHOOK_URL=https://...  WEBHOOK_SECRET=xxx  -- enable webhook tests");
    process.exit(1);
  }
  return value;
}

function optionalEnv(name: string, fallback: string): string {
  return process.env[name] || fallback;
}

async function timedCheck(
  name: string,
  fn: () => Promise<{ status: "pass" | "fail" | "skip"; message: string }>,
): Promise<CheckResult> {
  const start = Date.now();
  try {
    const result = await fn();
    return { name, ...result, durationMs: Date.now() - start };
  } catch (err) {
    return {
      name,
      status: "fail",
      message: `Unexpected error: ${err instanceof Error ? err.message : String(err)}`,
      durationMs: Date.now() - start,
    };
  }
}

// ---------------------------------------------------------------------------
// Telegram Bot API helpers
// ---------------------------------------------------------------------------

function apiUrl(botToken: string, method: string): string {
  return `https://api.telegram.org/bot${botToken}/${method}`;
}

async function telegramApiCall<T>(
  botToken: string,
  method: string,
  body: Record<string, unknown>,
): Promise<{ ok: boolean; result?: T; description?: string }> {
  const res = await fetch(apiUrl(botToken, method), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await res.json()) as { ok: boolean; result?: T; description?: string };
}

// ---------------------------------------------------------------------------
// Check: Send canary message and wait for bot response
// ---------------------------------------------------------------------------

async function checkBotResponse(
  botToken: string,
  chatId: string,
  timeoutMs: number,
): Promise<{ status: "pass" | "fail"; message: string }> {
  const nonce = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const canaryText = `${CANARY_PREFIX} ping ${nonce}`;

  // Send the canary message
  const sendResult = await telegramApiCall<{ message_id: number }>(
    botToken,
    "sendMessage",
    { chat_id: chatId, text: canaryText },
  );

  if (!sendResult.ok || !sendResult.result) {
    return {
      status: "fail",
      message: `Failed to send canary message: ${sendResult.description || "unknown error"}`,
    };
  }

  const sentMessageId = sendResult.result.message_id;

  // Clear pending updates so we only see new ones
  await telegramApiCall(botToken, "getUpdates", { offset: -1, limit: 1 });

  // Poll for bot response
  const pollStart = Date.now();
  while (Date.now() - pollStart < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));

    const pollResult = await telegramApiCall<
      Array<{
        update_id: number;
        message?: {
          message_id: number;
          from?: { is_bot: boolean; username?: string };
          chat: { id: number };
          text?: string;
          reply_to_message?: { message_id: number };
        };
      }>
    >(botToken, "getUpdates", { timeout: 2, limit: 10 });

    if (!pollResult.ok || !pollResult.result) continue;

    for (const update of pollResult.result) {
      const msg = update.message;
      if (!msg) continue;

      const isSameChat = String(msg.chat.id) === String(chatId);
      const isFromBot = msg.from?.is_bot === true;
      const isReply = msg.reply_to_message?.message_id === sentMessageId;
      const isAfterSend = msg.message_id > sentMessageId;

      if (isSameChat && isFromBot && (isReply || isAfterSend)) {
        const preview = (msg.text || "[non-text]").slice(0, 120);
        const elapsed = Date.now() - pollStart;

        // Acknowledge processed updates
        await telegramApiCall(botToken, "getUpdates", {
          offset: update.update_id + 1,
        });

        return {
          status: "pass",
          message: `Bot responded in ${elapsed}ms (msg_id=${msg.message_id}, from=@${msg.from?.username}): "${preview}"`,
        };
      }

      // Acknowledge this update
      await telegramApiCall(botToken, "getUpdates", {
        offset: update.update_id + 1,
      });
    }
  }

  return {
    status: "fail",
    message: `No bot response within ${timeoutMs}ms after sending "${canaryText}"`,
  };
}

// ---------------------------------------------------------------------------
// Check: Webhook with correct secret (optional)
// ---------------------------------------------------------------------------

function buildSyntheticUpdate(text: string): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return {
    update_id: 100000000 + Math.floor(Math.random() * 999999),
    message: {
      message_id: Math.floor(Math.random() * 999999),
      from: {
        id: 999999999,
        is_bot: false,
        first_name: "Canary",
        last_name: "Test",
        username: "canary_test_user",
        language_code: "en",
      },
      chat: {
        id: -1001999999999,
        title: "Canary Test Group",
        type: "supergroup",
        username: "canary_test_group",
      },
      date: now,
      text,
      entities: [],
    },
  };
}

async function checkWebhookAcceptsValidSecret(
  webhookUrl: string,
  webhookSecret: string,
): Promise<{ status: "pass" | "fail"; message: string }> {
  const update = buildSyntheticUpdate(`${CANARY_PREFIX} webhook-ping`);
  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Telegram-Bot-Api-Secret-Token": webhookSecret,
    },
    body: JSON.stringify(update),
  });

  if (res.status === 200) {
    return { status: "pass", message: `Webhook returned ${res.status} with valid secret` };
  }
  const body = await res.text().catch(() => "");
  return {
    status: "fail",
    message: `Webhook returned ${res.status} (expected 200). Body: ${body.slice(0, 200)}`,
  };
}

async function checkWebhookRejectsInvalidSecret(
  webhookUrl: string,
): Promise<{ status: "pass" | "fail"; message: string }> {
  const update = buildSyntheticUpdate(`${CANARY_PREFIX} webhook-ping-bad-secret`);
  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Telegram-Bot-Api-Secret-Token": "wrong-secret-value-12345",
    },
    body: JSON.stringify(update),
  });

  if (res.status === 200 || res.status === 401) {
    return {
      status: "pass",
      message: `Webhook returned ${res.status} with invalid secret (message not processed)`,
    };
  }
  const body = await res.text().catch(() => "");
  return {
    status: "fail",
    message: `Webhook returned ${res.status} (expected 200 or 401). Body: ${body.slice(0, 200)}`,
  };
}

async function checkWebhookRejectsMissingSecret(
  webhookUrl: string,
): Promise<{ status: "pass" | "fail"; message: string }> {
  const update = buildSyntheticUpdate(`${CANARY_PREFIX} webhook-ping-no-secret`);
  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(update),
  });

  if (res.status === 200 || res.status === 401) {
    return {
      status: "pass",
      message: `Webhook returned ${res.status} with missing secret (message not processed)`,
    };
  }
  const body = await res.text().catch(() => "");
  return {
    status: "fail",
    message: `Webhook returned ${res.status} (expected 200 or 401). Body: ${body.slice(0, 200)}`,
  };
}

async function checkWebhookRejectsInvalidJson(
  webhookUrl: string,
  webhookSecret: string,
): Promise<{ status: "pass" | "fail"; message: string }> {
  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Telegram-Bot-Api-Secret-Token": webhookSecret,
    },
    body: "this is not json{{{",
  });

  if (res.status === 200 || res.status === 400) {
    return { status: "pass", message: `Webhook returned ${res.status} for invalid JSON body` };
  }
  const body = await res.text().catch(() => "");
  return {
    status: "fail",
    message: `Webhook returned ${res.status} (expected 200 or 400). Body: ${body.slice(0, 200)}`,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const suiteStart = Date.now();

  const botToken = requiredEnv("CANARY_BOT_TOKEN");
  const chatId = requiredEnv("CANARY_CHAT_ID");
  const timeoutMs = parseInt(optionalEnv("CANARY_TIMEOUT_MS", String(DEFAULT_TIMEOUT_MS)), 10);

  const webhookUrl = process.env.WEBHOOK_URL;
  const webhookSecret = process.env.WEBHOOK_SECRET;

  const checks: CheckResult[] = [];

  // -- Primary: Bot API round-trip test --
  console.error(`[canary] Sending ${CANARY_PREFIX} message to chat ${chatId}...`);
  const botCheck = await timedCheck("bot-response", () =>
    checkBotResponse(botToken, chatId, timeoutMs),
  );
  checks.push(botCheck);
  console.error(`[canary] bot-response: ${botCheck.status} (${botCheck.durationMs}ms)`);

  // -- Optional: Webhook smoke tests --
  if (webhookUrl && webhookSecret) {
    console.error("[canary] Running webhook smoke tests...");

    const webhookChecks = await Promise.all([
      timedCheck("webhook-valid-secret", () =>
        checkWebhookAcceptsValidSecret(webhookUrl, webhookSecret),
      ),
      timedCheck("webhook-invalid-secret", () =>
        checkWebhookRejectsInvalidSecret(webhookUrl),
      ),
      timedCheck("webhook-missing-secret", () =>
        checkWebhookRejectsMissingSecret(webhookUrl),
      ),
      timedCheck("webhook-invalid-json", () =>
        checkWebhookRejectsInvalidJson(webhookUrl, webhookSecret),
      ),
    ]);

    for (const c of webhookChecks) {
      checks.push(c);
      console.error(`[canary] ${c.name}: ${c.status} (${c.durationMs}ms)`);
    }
  }

  // -- Build structured result --
  const failures = checks.filter((c) => c.status === "fail").length;
  const passed = checks.filter((c) => c.status === "pass").length;

  const result: CanaryResult = {
    timestamp: new Date().toISOString(),
    suite: "telegram-canary",
    status: failures === 0 ? "pass" : "fail",
    durationMs: Date.now() - suiteStart,
    checks,
    summary: `${passed}/${checks.length} checks passed${failures > 0 ? `, ${failures} failed` : ""}`,
  };

  // Structured JSON on stdout
  console.log(JSON.stringify(result, null, 2));

  process.exit(failures > 0 ? 1 : 0);
}

main().catch((err) => {
  const result: CanaryResult = {
    timestamp: new Date().toISOString(),
    suite: "telegram-canary",
    status: "fail",
    durationMs: 0,
    checks: [],
    summary: `Fatal error: ${err instanceof Error ? err.message : String(err)}`,
  };
  console.log(JSON.stringify(result, null, 2));
  process.exit(1);
});
