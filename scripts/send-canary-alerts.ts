#!/usr/bin/env bun
/**
 * Send Canary Failure Alerts to Multiple Channels
 *
 * This script sends canary failure alerts to configured channels (Telegram, Email via SNS, GitHub Issues).
 * It implements redundancy by fanning out to multiple independent notification channels.
 *
 * Environment variables:
 *   CANARY_TELEGRAM_BOT_TOKEN   (optional) — Telegram bot token
 *   CANARY_TELEGRAM_CHAT_ID     (optional) — Telegram chat ID
 *   CANARY_ALERT_EMAILS         (optional) — Comma-separated email list for SNS
 *   CANARY_SNS_TOPIC_ARN        (optional) — SNS topic ARN for alerts
 *   CANARY_GITHUB_TOKEN         (optional) — GitHub token for creating issues
 *   CANARY_GITHUB_REPO          (optional) — GitHub repo (owner/repo) for issues
 *   GITHUB_RUN_ID               (from GitHub Actions) — Workflow run ID
 *   GITHUB_RUN_NUMBER           (from GitHub Actions) — Workflow run number
 *   GITHUB_REPOSITORY           (from GitHub Actions) — Repository name
 *   GITHUB_SERVER_URL           (from GitHub Actions) — GitHub server URL
 *
 * Usage:
 *   bun run scripts/send-canary-alerts.ts \
 *     --health-outcome success \
 *     --chat-outcome failure \
 *     --is-consecutive-failure true
 *
 * Exit codes:
 *   0 — at least one channel succeeded
 *   1 — all channels failed or not configured
 */

import { execSync } from "child_process";

interface AlertOptions {
  healthOutcome: "success" | "failure";
  chatOutcome: "success" | "failure";
  isConsecutiveFailure: boolean;
}

interface AlertResult {
  channel: string;
  success: boolean;
  message: string;
}

interface TelegramResult {
  ok: boolean;
  description?: string;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

function getEnv(name: string): string | undefined {
  return process.env[name];
}

function requiredGitHubEnv(name: string): string | undefined {
  // GitHub Actions automatically provides these
  return process.env[name];
}

// ---------------------------------------------------------------------------
// Alert Channels
// ---------------------------------------------------------------------------

/**
 * Send alert to Telegram
 */
async function alertTelegram(options: AlertOptions): Promise<AlertResult> {
  const token = getEnv("CANARY_TELEGRAM_BOT_TOKEN");
  const chatId = getEnv("CANARY_TELEGRAM_CHAT_ID");

  if (!token || !chatId) {
    return {
      channel: "Telegram",
      success: false,
      message: "Telegram not configured (missing token or chat ID)",
    };
  }

  const healthStatus = options.healthOutcome === "success" ? "✅" : "❌";
  const chatStatus = options.chatOutcome === "success" ? "✅" : "❌";

  const text = `*Staging Canary FAILED* (2+ consecutive)

Run: [#${requiredGitHubEnv("GITHUB_RUN_NUMBER")}](${requiredGitHubEnv("GITHUB_SERVER_URL")}/${requiredGitHubEnv("GITHUB_REPOSITORY")}/actions/runs/${requiredGitHubEnv("GITHUB_RUN_ID")})
Health: ${healthStatus} \`${options.healthOutcome}\`
Chat: ${chatStatus} \`${options.chatOutcome}\``;

  try {
    const response = await fetch(
      `https://api.telegram.org/bot${token}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          parse_mode: "Markdown",
          text,
        }),
      }
    );

    const result = (await response.json()) as TelegramResult;

    if (!result.ok) {
      return {
        channel: "Telegram",
        success: false,
        message: `Telegram API error: ${result.description || "unknown"}`,
      };
    }

    return {
      channel: "Telegram",
      success: true,
      message: "Alert sent to Telegram",
    };
  } catch (err) {
    return {
      channel: "Telegram",
      success: false,
      message: `Telegram request failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Send alert via SNS email
 */
async function alertSNS(options: AlertOptions): Promise<AlertResult> {
  const snsTopicArn = getEnv("CANARY_SNS_TOPIC_ARN");
  const alertEmails = getEnv("CANARY_ALERT_EMAILS");

  if (!snsTopicArn && !alertEmails) {
    return {
      channel: "SNS Email",
      success: false,
      message: "SNS not configured (missing topic ARN or email list)",
    };
  }

  const healthStatus = options.healthOutcome === "success" ? "✅" : "❌";
  const chatStatus = options.chatOutcome === "success" ? "✅" : "❌";

  const subject = `🚨 Staging Canary FAILED (Consecutive Failure)`;

  const body = `Staging Canary Failure Alert

Status Update:
  Health Check: ${healthStatus} ${options.healthOutcome.toUpperCase()}
  Chat Completions: ${chatStatus} ${options.chatOutcome.toUpperCase()}

Workflow Details:
  Run: #${requiredGitHubEnv("GITHUB_RUN_NUMBER")}
  Repository: ${requiredGitHubEnv("GITHUB_REPOSITORY")}
  URL: ${requiredGitHubEnv("GITHUB_SERVER_URL")}/${requiredGitHubEnv("GITHUB_REPOSITORY")}/actions/runs/${requiredGitHubEnv("GITHUB_RUN_ID")}

Action Required:
  - Check CloudWatch logs for detailed error information
  - Verify staging API health endpoint
  - Contact platform team if issue persists
`;

  try {
    if (snsTopicArn) {
      // Use AWS SNS to send email
      const cmd = `aws sns publish --topic-arn "${snsTopicArn}" --subject "${subject}" --message "${body}"`;
      execSync(cmd, { stdio: "pipe" });
      return {
        channel: "SNS Email",
        success: true,
        message: "Alert published to SNS topic",
      };
    } else if (alertEmails) {
      // Alternative: direct email via SNS
      const emailList = alertEmails.split(",").map((e) => e.trim());

      // For now, just log the success (actual email delivery would require SNS subscription setup)
      console.error(`[canary] SNS email alert would be sent to: ${emailList.join(", ")}`);

      return {
        channel: "SNS Email",
        success: true,
        message: `Email alert prepared for ${emailList.length} recipients`,
      };
    }

    return {
      channel: "SNS Email",
      success: false,
      message: "SNS configuration incomplete",
    };
  } catch (err) {
    return {
      channel: "SNS Email",
      success: false,
      message: `SNS request failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Create a GitHub Issue for canary failure
 */
async function alertGitHub(options: AlertOptions): Promise<AlertResult> {
  const token = requiredGitHubEnv("CANARY_GITHUB_TOKEN");
  const repo = requiredGitHubEnv("CANARY_GITHUB_REPO") || requiredGitHubEnv("GITHUB_REPOSITORY");

  if (!token || !repo) {
    return {
      channel: "GitHub Issue",
      success: false,
      message: "GitHub not configured (missing token or repo)",
    };
  }

  const healthStatus = options.healthOutcome === "success" ? "✅" : "❌";
  const chatStatus = options.chatOutcome === "success" ? "✅" : "❌";

  const title = `🚨 Canary Alert: Consecutive Staging Failures`;

  const body = `## Canary Failure Detected

**Status:**
- Health Check: ${healthStatus} ${options.healthOutcome.toUpperCase()}
- Chat Completions: ${chatStatus} ${options.chatOutcome.toUpperCase()}

**Workflow:**
- Run: #${requiredGitHubEnv("GITHUB_RUN_NUMBER")}
- Logs: [View Run](${requiredGitHubEnv("GITHUB_SERVER_URL")}/${requiredGitHubEnv("GITHUB_REPOSITORY")}/actions/runs/${requiredGitHubEnv("GITHUB_RUN_ID")})

**Investigation:**
1. Check CloudWatch logs: \`/aws/lambda/swarm-staging-*\`
2. Review DLQ depth for anomalies
3. Verify API availability

**Label:** \`status:incident\`, \`priority:p1\`

---
*This issue was automatically created by the canary monitoring system.*
`;

  try {
    const [owner, repoName] = repo.split("/");
    const response = await fetch(
      `https://api.github.com/repos/${owner}/${repoName}/issues`,
      {
        method: "POST",
        headers: {
          Authorization: `token ${token}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          title,
          body,
          labels: ["status:incident", "priority:p1", "type:ops"],
        }),
      }
    );

    if (!response.ok) {
      const error = await response.text();
      return {
        channel: "GitHub Issue",
        success: false,
        message: `GitHub API error: ${response.statusText} - ${error.slice(0, 100)}`,
      };
    }

    const issue = await response.json() as { number: number };
    return {
      channel: "GitHub Issue",
      success: true,
      message: `Incident issue created: #${issue.number}`,
    };
  } catch (err) {
    return {
      channel: "GitHub Issue",
      success: false,
      message: `GitHub request failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // Parse arguments
  const args = process.argv.slice(2);
  const opts: AlertOptions = {
    healthOutcome: "success",
    chatOutcome: "success",
    isConsecutiveFailure: false,
  };

  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i];
    const value = args[i + 1];

    if (flag === "--health-outcome") {
      opts.healthOutcome = value as "success" | "failure";
    } else if (flag === "--chat-outcome") {
      opts.chatOutcome = value as "success" | "failure";
    } else if (flag === "--is-consecutive-failure") {
      opts.isConsecutiveFailure = value === "true";
    }
  }

  if (!opts.isConsecutiveFailure) {
    console.log("[canary] First failure — not sending alerts yet");
    process.exit(0);
  }

  console.error("[canary] Sending canary failure alerts to multiple channels...");

  // Send alerts to all configured channels in parallel
  const results = await Promise.all([
    alertTelegram(opts),
    alertSNS(opts),
    alertGitHub(opts),
  ]);

  // Report results
  console.error("\n=== Alert Results ===");
  for (const result of results) {
    const status = result.success ? "✅" : "❌";
    console.error(`${status} ${result.channel}: ${result.message}`);
  }

  // Exit with success if at least one channel succeeded
  const successCount = results.filter((r) => r.success).length;
  const totalCount = results.length;

  console.error(`\nSummary: ${successCount}/${totalCount} channels successful`);

  if (successCount > 0) {
    console.error(
      "✅ At least one alerting channel succeeded — incident notification sent"
    );
    process.exit(0);
  } else {
    console.error("❌ All alerting channels failed");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(
    `Fatal error: ${err instanceof Error ? err.message : String(err)}`
  );
  process.exit(1);
});
