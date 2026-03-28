#!/usr/bin/env bun
/**
 * Twitter/X Canary Monitoring
 *
 * Monitors the health of Twitter autonomous posting and mention polling:
 * 1. Checks CloudWatch metrics for recent Lambda invocations
 * 2. Validates tweet poster Lambda invocation rate
 * 3. Validates mention poller Lambda invocation rate
 * 4. Alerts if posting/polling stops or error rates spike
 *
 * Environment variables:
 *   AWS_REGION           (optional) — AWS region (default: us-east-1)
 *   AWS_PROFILE          (optional) — AWS profile to use
 *   ENVIRONMENT          (required) — staging or prod
 *   ALERT_WEBHOOK_URL    (optional) — Slack webhook URL for alerts
 *
 * Usage:
 *   ENVIRONMENT=staging bun run scripts/twitter-canary.ts
 *   pnpm canary:twitter
 *
 * Exit codes:
 *   0 — all checks passed
 *   1 — one or more checks failed
 */

import { CloudWatchClient, GetMetricStatisticsCommand } from "@aws-sdk/client-cloudwatch";

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
  metrics?: Record<string, unknown>;
}

interface LambdaMetrics {
  Invocations: number;
  Errors: number;
  Throttles: number;
  Duration?: {
    Average: number;
    Maximum: number;
  };
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const REGION = process.env.AWS_REGION || "us-east-1";
const PROFILE = process.env.AWS_PROFILE;
const ENVIRONMENT = process.env.ENVIRONMENT || "staging";

// Lambda functions to monitor
const LAMBDAS = {
  tweetPoster: `swarm-${ENVIRONMENT}-autonomous-tweet-poster`,
  mentionPoller: `swarm-${ENVIRONMENT}-twitter-mention-poller`,
};

// Thresholds
const THRESHOLDS = {
  // Tweet poster runs hourly, so check last 2 hours for at least 1 invocation
  tweetPosterMinInvocations: 1,
  tweetPosterCheckWindowMinutes: 120,

  // Mention poller runs every minute, so check last 10 minutes for at least 4 invocations
  mentionPollerMinInvocations: 4,
  mentionPollerCheckWindowMinutes: 10,

  // Error rate should be < 5%
  maxErrorRatePercent: 5,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Error: Required environment variable ${name} is not set.`);
    process.exit(1);
  }
  return value;
}

async function timedCheck(
  name: string,
  fn: () => Promise<{ status: "pass" | "fail" | "skip"; message: string; metrics?: Record<string, unknown> }>,
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
// CloudWatch Metrics
// ---------------------------------------------------------------------------

async function getLambdaMetrics(
  client: CloudWatchClient,
  functionName: string,
  windowMinutes: number,
): Promise<LambdaMetrics> {
  const now = new Date();
  const startTime = new Date(now.getTime() - windowMinutes * 60000);

  // Fetch Invocations
  const invocationsResult = await client.send(
    new GetMetricStatisticsCommand({
      Namespace: "AWS/Lambda",
      MetricName: "Invocations",
      Dimensions: [{ Name: "FunctionName", Value: functionName }],
      StartTime: startTime,
      EndTime: now,
      Period: 300, // 5-minute buckets
      Statistics: ["Sum"],
    }),
  );

  // Fetch Errors
  const errorsResult = await client.send(
    new GetMetricStatisticsCommand({
      Namespace: "AWS/Lambda",
      MetricName: "Errors",
      Dimensions: [{ Name: "FunctionName", Value: functionName }],
      StartTime: startTime,
      EndTime: now,
      Period: 300,
      Statistics: ["Sum"],
    }),
  );

  // Fetch Throttles
  const throttlesResult = await client.send(
    new GetMetricStatisticsCommand({
      Namespace: "AWS/Lambda",
      MetricName: "Throttles",
      Dimensions: [{ Name: "FunctionName", Value: functionName }],
      StartTime: startTime,
      EndTime: now,
      Period: 300,
      Statistics: ["Sum"],
    }),
  );

  // Fetch Duration (optional)
  const durationResult = await client.send(
    new GetMetricStatisticsCommand({
      Namespace: "AWS/Lambda",
      MetricName: "Duration",
      Dimensions: [{ Name: "FunctionName", Value: functionName }],
      StartTime: startTime,
      EndTime: now,
      Period: 300,
      Statistics: ["Average", "Maximum"],
    }),
  );

  const invocations = invocationsResult.Datapoints?.reduce((sum, dp) => sum + (dp.Sum || 0), 0) || 0;
  const errors = errorsResult.Datapoints?.reduce((sum, dp) => sum + (dp.Sum || 0), 0) || 0;
  const throttles = throttlesResult.Datapoints?.reduce((sum, dp) => sum + (dp.Sum || 0), 0) || 0;

  const durationStats = durationResult.Datapoints?.[durationResult.Datapoints.length - 1] || {};

  return {
    Invocations: invocations,
    Errors: errors,
    Throttles: throttles,
    Duration: durationStats.Average
      ? {
          Average: Math.round(durationStats.Average),
          Maximum: Math.round(durationStats.Maximum || 0),
        }
      : undefined,
  };
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

async function checkTweetPosterHealth(
  client: CloudWatchClient,
): Promise<{ status: "pass" | "fail"; message: string; metrics: Record<string, unknown> }> {
  const metrics = await getLambdaMetrics(client, LAMBDAS.tweetPoster, THRESHOLDS.tweetPosterCheckWindowMinutes);

  const hasRecentInvocations = metrics.Invocations >= THRESHOLDS.tweetPosterMinInvocations;
  const hasThrottles = metrics.Throttles > 0;
  const errorRate = metrics.Invocations > 0 ? (metrics.Errors / metrics.Invocations) * 100 : 0;
  const hasHighErrorRate = errorRate > THRESHOLDS.maxErrorRatePercent;

  const issues: string[] = [];

  if (!hasRecentInvocations) {
    issues.push(
      `No recent invocations (expected ≥${THRESHOLDS.tweetPosterMinInvocations} in last ${THRESHOLDS.tweetPosterCheckWindowMinutes}m)`,
    );
  }

  if (hasThrottles) {
    issues.push(`${metrics.Throttles} throttles detected`);
  }

  if (hasHighErrorRate) {
    issues.push(`High error rate: ${errorRate.toFixed(1)}% (threshold: ${THRESHOLDS.maxErrorRatePercent}%)`);
  }

  const status = issues.length === 0 ? "pass" : "fail";
  const message =
    issues.length === 0
      ? `Tweet poster healthy: ${metrics.Invocations} invocations, ${metrics.Errors} errors in last ${THRESHOLDS.tweetPosterCheckWindowMinutes}m`
      : `Tweet poster unhealthy: ${issues.join("; ")}`;

  return {
    status,
    message,
    metrics: {
      invocations: metrics.Invocations,
      errors: metrics.Errors,
      errorRate: `${errorRate.toFixed(1)}%`,
      throttles: metrics.Throttles,
      duration: metrics.Duration,
    },
  };
}

async function checkMentionPollerHealth(
  client: CloudWatchClient,
): Promise<{ status: "pass" | "fail"; message: string; metrics: Record<string, unknown> }> {
  const metrics = await getLambdaMetrics(client, LAMBDAS.mentionPoller, THRESHOLDS.mentionPollerCheckWindowMinutes);

  const hasRecentInvocations = metrics.Invocations >= THRESHOLDS.mentionPollerMinInvocations;
  const hasThrottles = metrics.Throttles > 0;
  const errorRate = metrics.Invocations > 0 ? (metrics.Errors / metrics.Invocations) * 100 : 0;
  const hasHighErrorRate = errorRate > THRESHOLDS.maxErrorRatePercent;

  const issues: string[] = [];

  if (!hasRecentInvocations) {
    issues.push(
      `No recent invocations (expected ≥${THRESHOLDS.mentionPollerMinInvocations} in last ${THRESHOLDS.mentionPollerCheckWindowMinutes}m)`,
    );
  }

  if (hasThrottles) {
    issues.push(`${metrics.Throttles} throttles detected`);
  }

  if (hasHighErrorRate) {
    issues.push(`High error rate: ${errorRate.toFixed(1)}% (threshold: ${THRESHOLDS.maxErrorRatePercent}%)`);
  }

  const status = issues.length === 0 ? "pass" : "fail";
  const message =
    issues.length === 0
      ? `Mention poller healthy: ${metrics.Invocations} invocations, ${metrics.Errors} errors in last ${THRESHOLDS.mentionPollerCheckWindowMinutes}m`
      : `Mention poller unhealthy: ${issues.join("; ")}`;

  return {
    status,
    message,
    metrics: {
      invocations: metrics.Invocations,
      errors: metrics.Errors,
      errorRate: `${errorRate.toFixed(1)}%`,
      throttles: metrics.Throttles,
      duration: metrics.Duration,
    },
  };
}

// ---------------------------------------------------------------------------
// Alerting
// ---------------------------------------------------------------------------

async function sendSlackAlert(webhookUrl: string, canaryResult: CanaryResult): Promise<void> {
  if (!webhookUrl) return;

  const failures = canaryResult.checks.filter((c) => c.status === "fail");
  if (failures.length === 0) return; // Only alert on failures

  const message = {
    text: `🚨 Twitter Canary Alert`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Twitter Canary Failed* ❌\n${failures.map((f) => `• ${f.name}: ${f.message}`).join("\n")}`,
        },
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `Env: \`${ENVIRONMENT}\` | Duration: ${canaryResult.durationMs}ms | Time: ${canaryResult.timestamp}`,
          },
        ],
      },
    ],
  };

  try {
    await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(message),
    });
  } catch (err) {
    console.error(`Failed to send Slack alert: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const suiteStart = Date.now();
  const environment = requiredEnv("ENVIRONMENT");

  console.error(`[twitter-canary] Starting with environment: ${environment}`);

  const client = new CloudWatchClient({ region: REGION });
  const checks: CheckResult[] = [];

  // Check tweet poster
  console.error("[twitter-canary] Checking tweet poster Lambda...");
  const tweetPosterCheck = await timedCheck("tweet-poster-health", () => checkTweetPosterHealth(client));
  checks.push(tweetPosterCheck);
  console.error(`[twitter-canary] tweet-poster-health: ${tweetPosterCheck.status} (${tweetPosterCheck.durationMs}ms)`);

  // Check mention poller
  console.error("[twitter-canary] Checking mention poller Lambda...");
  const mentionPollerCheck = await timedCheck("mention-poller-health", () => checkMentionPollerHealth(client));
  checks.push(mentionPollerCheck);
  console.error(`[twitter-canary] mention-poller-health: ${mentionPollerCheck.status} (${mentionPollerCheck.durationMs}ms)`);

  // Build result
  const failures = checks.filter((c) => c.status === "fail").length;
  const passed = checks.filter((c) => c.status === "pass").length;

  const result: CanaryResult = {
    timestamp: new Date().toISOString(),
    suite: "twitter-canary",
    status: failures === 0 ? "pass" : "fail",
    durationMs: Date.now() - suiteStart,
    checks,
    summary: `${passed}/${checks.length} checks passed${failures > 0 ? `, ${failures} failed` : ""}`,
  };

  // Structured JSON on stdout
  console.log(JSON.stringify(result, null, 2));

  // Optional Slack alert
  const alertWebhook = process.env.ALERT_WEBHOOK_URL;
  if (alertWebhook) {
    await sendSlackAlert(alertWebhook, result);
  }

  process.exit(failures > 0 ? 1 : 0);
}

main().catch((err) => {
  const result: CanaryResult = {
    timestamp: new Date().toISOString(),
    suite: "twitter-canary",
    status: "fail",
    durationMs: 0,
    checks: [],
    summary: `Fatal error: ${err instanceof Error ? err.message : String(err)}`,
  };
  console.log(JSON.stringify(result, null, 2));
  process.exit(1);
});
