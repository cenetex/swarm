/**
 * Operations Dashboard Construct
 *
 * Creates a single CloudWatch dashboard providing a unified view of:
 * - Lambda invocations and errors for all critical handlers
 * - Lambda duration (p50/p95/p99) for latency visibility
 * - Lambda throttles and concurrent executions
 * - SQS queue depths for message, response, media, and post queues
 * - SQS age-of-oldest-message for user-facing queues
 * - DLQ message counts across SharedHandlers and AdminApi
 * - API Gateway latency and error rates (when AdminApi is deployed)
 * - Memory consolidation worker invocations, errors, and duration
 * - Discord gateway runtime drift alarm (when gateway is deployed)
 */
import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatch_actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import type * as ecs from 'aws-cdk-lib/aws-ecs';
import type * as lambda from 'aws-cdk-lib/aws-lambda';
import type * as sns from 'aws-cdk-lib/aws-sns';
import type * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';

export interface OpsDashboardProps {
  /**
   * Environment name (dev, staging, prod)
   */
  environment: string;

  /**
   * Optional suffix for resource names (e.g., "-a1b2c3")
   */
  nameSuffix?: string;

  /**
   * SharedHandlers Lambda functions
   */
  sharedHandlerFunctions: {
    messageProcessor: lambda.IFunction;
    responseSender: lambda.IFunction;
    mediaProcessor: lambda.IFunction;
    tweetSender: lambda.IFunction;
    telegramWebhook: lambda.IFunction;
  };

  /**
   * SharedHandlers SQS queues
   */
  sharedQueues: {
    messageQueue: sqs.IQueue;
    responseQueue: sqs.IQueue;
    mediaQueue: sqs.IQueue;
    postQueue: sqs.IQueue;
  };

  /**
   * SharedHandlers DLQs
   */
  sharedDlqs: {
    dlq: sqs.IQueue;
    schedulerDlq: sqs.IQueue;
  };

  /**
   * AdminApi Lambda functions (optional — dashboard still works if AdminApi is not deployed)
   */
  adminHandlerFunctions?: {
    chatWorker: lambda.IFunction;
    responseSender: lambda.IFunction;
    dreamWorker: lambda.IFunction;
    openaiCompat: lambda.IFunction;
  };

  /**
   * AdminApi DLQs (optional)
   */
  adminDlqs?: {
    responseDlq: sqs.IQueue;
    chatDlq: sqs.IQueue;
    dreamDlq: sqs.IQueue;
    consolidationDlq: sqs.IQueue;
  };

  /**
   * Memory consolidation worker Lambda (optional — used for consolidation metrics)
   */
  consolidationWorker?: lambda.IFunction;

  /**
   * AdminApi SQS queues (optional — used for queue-age metrics)
   */
  adminQueues?: {
    responseQueue: sqs.IQueue;
    chatQueue: sqs.IQueue;
    dreamQueue: sqs.IQueue;
  };

  /**
   * AdminApi HTTP API ID (optional — used for API Gateway latency/error widgets).
   * This is the apiId of the apigatewayv2.HttpApi resource.
   */
  adminApiId?: string;

  /**
   * Discord gateway ECS service (optional — used for runtime drift alarm).
   * When provided, the dashboard creates an alarm that fires when the gateway
   * service has zero running tasks for more than 5 minutes.
   */
  discordGatewayService?: ecs.FargateService;

  /**
   * SNS topic for alarm notifications (optional). When provided, the Discord
   * gateway drift alarm sends notifications to this topic.
   */
  alarmTopic?: sns.ITopic;
}

export class OpsDashboard extends Construct {
  public readonly dashboard: cloudwatch.Dashboard;
  public readonly discordGatewayDriftAlarm?: cloudwatch.Alarm;

  constructor(scope: Construct, id: string, props: OpsDashboardProps) {
    super(scope, id);

    const { environment } = props;
    const suffix = props.nameSuffix ?? '';

    this.dashboard = new cloudwatch.Dashboard(this, 'Dashboard', {
      dashboardName: `swarm-ops-${environment}${suffix}`,
      defaultInterval: cdk.Duration.hours(6),
    });

    const period = cdk.Duration.minutes(5);

    // ========================================================================
    // Row 1: Per-Platform Invocations (Telegram, Discord, Twitter, Relay)
    // ========================================================================
    // Platform routing:
    // • Telegram: telegramWebhook → messageProcessor (inbound) → responseSender (outbound)
    // • Discord, Twitter, Web, Relay: messageProcessor with platform-specific handlers +
    //   platform-heartbeat + relay handlers
    // • Media (all platforms): mediaProcessor
    // • Twitter posting: tweetSender (consumes POST_QUEUE for rate-limited async posting)
    const sharedFns = props.sharedHandlerFunctions;

    this.dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Platform Handlers - Invocations',
        width: 12,
        height: 6,
        left: [
          sharedFns.messageProcessor.metricInvocations({ period, label: 'MessageProcessor (all platforms)' }),
          sharedFns.telegramWebhook.metricInvocations({ period, label: 'Telegram Webhook (inbound)' }),
          sharedFns.tweetSender.metricInvocations({ period, label: 'Tweet Sender (async postings)' }),
        ],
      }),
      new cloudwatch.GraphWidget({
        title: 'Platform Handlers - Error Rate',
        width: 12,
        height: 6,
        left: [
          sharedFns.messageProcessor.metricErrors({ period, label: 'MessageProcessor' }),
          sharedFns.telegramWebhook.metricErrors({ period, label: 'TelegramWebhook' }),
          sharedFns.tweetSender.metricErrors({ period, label: 'TweetSender' }),
        ],
      }),
    );

    // ========================================================================
    // Row 2: Response & Media Processing
    // ========================================================================
    this.dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Response Sender - Invocations & Errors',
        width: 12,
        height: 6,
        left: [
          sharedFns.responseSender.metricInvocations({ period, label: 'Invocations' }),
        ],
        right: [
          sharedFns.responseSender.metricErrors({ period, label: 'Errors' }),
        ],
      }),
      new cloudwatch.GraphWidget({
        title: 'Media Processor - Invocations & Errors',
        width: 12,
        height: 6,
        left: [
          sharedFns.mediaProcessor.metricInvocations({ period, label: 'Invocations' }),
        ],
        right: [
          sharedFns.mediaProcessor.metricErrors({ period, label: 'Errors' }),
        ],
      }),
    );

    // ========================================================================
    // Row 3: Platform Latency (p50 / p95 / p99)
    // ========================================================================
    this.dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'MessageProcessor Duration - p50 / p95 / p99 (ms)',
        width: 12,
        height: 6,
        left: [
          sharedFns.messageProcessor.metricDuration({ period, statistic: 'p50', label: 'p50' }),
          sharedFns.messageProcessor.metricDuration({ period, statistic: 'p95', label: 'p95' }),
          sharedFns.messageProcessor.metricDuration({ period, statistic: 'p99', label: 'p99' }),
        ],
      }),
      new cloudwatch.GraphWidget({
        title: 'TelegramWebhook Duration - p50 / p95 / p99 (ms)',
        width: 12,
        height: 6,
        left: [
          sharedFns.telegramWebhook.metricDuration({ period, statistic: 'p50', label: 'p50' }),
          sharedFns.telegramWebhook.metricDuration({ period, statistic: 'p95', label: 'p95' }),
          sharedFns.telegramWebhook.metricDuration({ period, statistic: 'p99', label: 'p99' }),
        ],
      }),
    );

    this.dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'ResponseSender Duration - p50 / p95 / p99 (ms)',
        width: 12,
        height: 6,
        left: [
          sharedFns.responseSender.metricDuration({ period, statistic: 'p50', label: 'p50' }),
          sharedFns.responseSender.metricDuration({ period, statistic: 'p95', label: 'p95' }),
          sharedFns.responseSender.metricDuration({ period, statistic: 'p99', label: 'p99' }),
        ],
      }),
      new cloudwatch.GraphWidget({
        title: 'MediaProcessor Duration - p50 / p95 / p99 (ms)',
        width: 12,
        height: 6,
        left: [
          sharedFns.mediaProcessor.metricDuration({ period, statistic: 'p50', label: 'p50' }),
          sharedFns.mediaProcessor.metricDuration({ period, statistic: 'p95', label: 'p95' }),
          sharedFns.mediaProcessor.metricDuration({ period, statistic: 'p99', label: 'p99' }),
        ],
      }),
    );

    // ========================================================================
    // Row 4: Throttling & Concurrency (Platform Handlers)
    // ========================================================================
    this.dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Platform Handlers - Throttles',
        width: 12,
        height: 6,
        left: [
          sharedFns.messageProcessor.metricThrottles({ period, label: 'MessageProcessor' }),
          sharedFns.telegramWebhook.metricThrottles({ period, label: 'TelegramWebhook' }),
          sharedFns.tweetSender.metricThrottles({ period, label: 'TweetSender' }),
        ],
      }),
      new cloudwatch.GraphWidget({
        title: 'Platform Handlers - Current Concurrency (max)',
        width: 12,
        height: 6,
        left: [
          sharedFns.messageProcessor.metric('ConcurrentExecutions', { period, statistic: 'Maximum', label: 'MessageProcessor' }),
          sharedFns.telegramWebhook.metric('ConcurrentExecutions', { period, statistic: 'Maximum', label: 'TelegramWebhook' }),
          sharedFns.tweetSender.metric('ConcurrentExecutions', { period, statistic: 'Maximum', label: 'TweetSender' }),
        ],
      }),
    );

    this.dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'ResponseSender & MediaProcessor - Throttles',
        width: 12,
        height: 6,
        left: [
          sharedFns.responseSender.metricThrottles({ period, label: 'ResponseSender' }),
          sharedFns.mediaProcessor.metricThrottles({ period, label: 'MediaProcessor' }),
        ],
      }),
      new cloudwatch.GraphWidget({
        title: 'ResponseSender & MediaProcessor - Concurrency (max)',
        width: 12,
        height: 6,
        left: [
          sharedFns.responseSender.metric('ConcurrentExecutions', { period, statistic: 'Maximum', label: 'ResponseSender' }),
          sharedFns.mediaProcessor.metric('ConcurrentExecutions', { period, statistic: 'Maximum', label: 'MediaProcessor' }),
        ],
      }),
    );

    // ========================================================================
    // Row 5: SQS Queue Pipeline Health
    // ========================================================================
    // Message flow: webhooks → messageQueue → messageProcessor → responseQueue →
    // responseSender → platform APIs (Telegram, Discord, Twitter)
    // Media flow: messageProcessor → mediaQueue → mediaProcessor → CDN/storage
    // Post flow (Twitter): internal services → postQueue → tweetSender → Twitter API
    const queues = props.sharedQueues;

    this.dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Message Pipeline - Queue Depths',
        width: 12,
        height: 6,
        left: [
          queues.messageQueue.metricApproximateNumberOfMessagesVisible({ period, label: 'Incoming (messageQueue)' }),
          queues.responseQueue.metricApproximateNumberOfMessagesVisible({ period, label: 'Responses (responseQueue)' }),
          queues.postQueue.metricApproximateNumberOfMessagesVisible({ period, label: 'Posts (postQueue)' }),
        ],
      }),
      new cloudwatch.GraphWidget({
        title: 'Media Processing - Queue Depth & Age',
        width: 12,
        height: 6,
        left: [
          queues.mediaQueue.metricApproximateNumberOfMessagesVisible({ period, label: 'Queue Depth' }),
        ],
        right: [
          queues.mediaQueue.metricApproximateAgeOfOldestMessage({ period, label: 'Age of Oldest (sec)' }),
        ],
      }),
    );

    this.dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Queue Age - Message Processing Pipeline (seconds)',
        width: 12,
        height: 6,
        left: [
          queues.messageQueue.metricApproximateAgeOfOldestMessage({ period, label: 'Incoming' }),
          queues.responseQueue.metricApproximateAgeOfOldestMessage({ period, label: 'Responses' }),
          queues.postQueue.metricApproximateAgeOfOldestMessage({ period, label: 'Posts' }),
        ],
      }),
      new cloudwatch.GraphWidget({
        title: 'Admin Queues - Age of Oldest (seconds)',
        width: 12,
        height: 6,
        left: [
          ...(props.adminQueues ? [
            props.adminQueues.responseQueue.metricApproximateAgeOfOldestMessage({ period, label: 'Admin Response' }),
            props.adminQueues.chatQueue.metricApproximateAgeOfOldestMessage({ period, label: 'Admin Chat' }),
            props.adminQueues.dreamQueue.metricApproximateAgeOfOldestMessage({ period, label: 'Admin Dream' }),
          ] : [new cloudwatch.Metric({
            namespace: 'AWS/SQS',
            metricName: 'ApproximateAgeOfOldestMessage',
            period: cdk.Duration.minutes(5),
            statistic: 'Average',
          })]),
        ],
      }),
    );

    // ========================================================================
    // Row 6: Dead Letter Queues (Platform Failures)
    // ========================================================================
    // Any message in a DLQ indicates critical failures that require investigation:
    // - Shared DLQ: Platform message processing exhausted retries (platform adapters,
    //   response sending, media processing)
    // - Scheduler DLQ: Scheduled events (Twitter poller, heartbeats, DLQ processor) failed
    // - Admin DLQs (when deployed): Chat, response, dreams, or consolidation workers failed
    this.dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Dead Letter Queues - Message Depth',
        width: 24,
        height: 6,
        left: [
          props.sharedDlqs.dlq.metricApproximateNumberOfMessagesVisible({ period, label: 'Platform Message DLQ (Telegram, Discord, Twitter, etc)' }),
          props.sharedDlqs.schedulerDlq.metricApproximateNumberOfMessagesVisible({ period, label: 'Scheduler DLQ (pollers, heartbeats)' }),
          ...(props.adminDlqs ? [
            props.adminDlqs.chatDlq.metricApproximateNumberOfMessagesVisible({ period, label: 'Admin Chat DLQ' }),
            props.adminDlqs.responseDlq.metricApproximateNumberOfMessagesVisible({ period, label: 'Admin Response DLQ' }),
            props.adminDlqs.dreamDlq.metricApproximateNumberOfMessagesVisible({ period, label: 'Admin Dream DLQ' }),
            props.adminDlqs.consolidationDlq.metricApproximateNumberOfMessagesVisible({ period, label: 'Admin Consolidation DLQ' }),
          ] : []),
        ],
      }),
    );

    // ========================================================================
    // Row 7: Admin API Workers (if deployed)
    // ========================================================================
    if (props.adminHandlerFunctions) {
      const adminFns = props.adminHandlerFunctions;

      // Admin API invocations and errors
      this.dashboard.addWidgets(
        new cloudwatch.GraphWidget({
          title: 'Admin Chat - Invocations & Errors',
          width: 12,
          height: 6,
          left: [
            adminFns.chatWorker.metricInvocations({ period, label: 'Invocations' }),
          ],
          right: [
            adminFns.chatWorker.metricErrors({ period, label: 'Errors' }),
          ],
        }),
        new cloudwatch.GraphWidget({
          title: 'Admin Dream - Invocations & Errors',
          width: 12,
          height: 6,
          left: [
            adminFns.dreamWorker.metricInvocations({ period, label: 'Invocations' }),
          ],
          right: [
            adminFns.dreamWorker.metricErrors({ period, label: 'Errors' }),
          ],
        }),
      );

      // Admin API latency
      this.dashboard.addWidgets(
        new cloudwatch.GraphWidget({
          title: 'Admin Chat - Latency (p50/p95/p99)',
          width: 12,
          height: 6,
          left: [
            adminFns.chatWorker.metricDuration({ period, statistic: 'p50', label: 'p50' }),
            adminFns.chatWorker.metricDuration({ period, statistic: 'p95', label: 'p95' }),
            adminFns.chatWorker.metricDuration({ period, statistic: 'p99', label: 'p99' }),
          ],
        }),
        new cloudwatch.GraphWidget({
          title: 'Admin Dream - Latency (p50/p95/p99)',
          width: 12,
          height: 6,
          left: [
            adminFns.dreamWorker.metricDuration({ period, statistic: 'p50', label: 'p50' }),
            adminFns.dreamWorker.metricDuration({ period, statistic: 'p95', label: 'p95' }),
            adminFns.dreamWorker.metricDuration({ period, statistic: 'p99', label: 'p99' }),
          ],
        }),
      );

      // Admin API response handlers and OpenAI compat
      this.dashboard.addWidgets(
        new cloudwatch.GraphWidget({
          title: 'Admin Response Sender - Invocations / Errors / Throttles',
          width: 12,
          height: 6,
          left: [
            adminFns.responseSender.metricInvocations({ period, label: 'Invocations' }),
            adminFns.responseSender.metricErrors({ period, label: 'Errors' }),
          ],
          right: [
            adminFns.responseSender.metricThrottles({ period, label: 'Throttles' }),
          ],
        }),
        new cloudwatch.GraphWidget({
          title: 'OpenAI Compat - Invocations / Errors / Throttles',
          width: 12,
          height: 6,
          left: [
            adminFns.openaiCompat.metricInvocations({ period, label: 'Invocations' }),
            adminFns.openaiCompat.metricErrors({ period, label: 'Errors' }),
          ],
          right: [
            adminFns.openaiCompat.metricThrottles({ period, label: 'Throttles' }),
          ],
        }),
      );
    }

    // ========================================================================
    // Row 8: API Gateway (Admin API REST endpoints)
    // ========================================================================
    if (props.adminApiId) {
      const apiDimensions = { ApiId: props.adminApiId };

      this.dashboard.addWidgets(
        new cloudwatch.GraphWidget({
          title: 'API Gateway - Latency (ms)',
          width: 12,
          height: 6,
          left: [
            new cloudwatch.Metric({
              namespace: 'AWS/ApiGateway',
              metricName: 'Latency',
              dimensionsMap: apiDimensions,
              period,
              statistic: 'p50',
              label: 'API Gateway p50',
            }),
            new cloudwatch.Metric({
              namespace: 'AWS/ApiGateway',
              metricName: 'Latency',
              dimensionsMap: apiDimensions,
              period,
              statistic: 'p95',
              label: 'API Gateway p95',
            }),
            new cloudwatch.Metric({
              namespace: 'AWS/ApiGateway',
              metricName: 'IntegrationLatency',
              dimensionsMap: apiDimensions,
              period,
              statistic: 'p50',
              label: 'Integration Latency p50',
            }),
            new cloudwatch.Metric({
              namespace: 'AWS/ApiGateway',
              metricName: 'IntegrationLatency',
              dimensionsMap: apiDimensions,
              period,
              statistic: 'p95',
              label: 'Integration Latency p95',
            }),
          ],
        }),
        new cloudwatch.GraphWidget({
          title: 'API Gateway - Error Rates & Request Count',
          width: 12,
          height: 6,
          left: [
            new cloudwatch.Metric({
              namespace: 'AWS/ApiGateway',
              metricName: '4xx',
              dimensionsMap: apiDimensions,
              period,
              statistic: 'Sum',
              label: '4xx Client Errors',
            }),
            new cloudwatch.Metric({
              namespace: 'AWS/ApiGateway',
              metricName: '5xx',
              dimensionsMap: apiDimensions,
              period,
              statistic: 'Sum',
              label: '5xx Server Errors',
            }),
          ],
          right: [
            new cloudwatch.Metric({
              namespace: 'AWS/ApiGateway',
              metricName: 'Count',
              dimensionsMap: apiDimensions,
              period,
              statistic: 'Sum',
              label: 'Total Requests',
            }),
          ],
        }),
      );
    }

    // ========================================================================
    // Row 9: Memory Consolidation Worker (if present)
    // ========================================================================
    if (props.consolidationWorker) {
      const consolidationFn = props.consolidationWorker;

      this.dashboard.addWidgets(
        new cloudwatch.GraphWidget({
          title: 'Memory Consolidation - Invocations & Errors',
          width: 12,
          height: 6,
          left: [
            consolidationFn.metricInvocations({ period, label: 'Invocations' }),
          ],
          right: [
            consolidationFn.metricErrors({ period, label: 'Errors' }),
          ],
        }),
        new cloudwatch.GraphWidget({
          title: 'Memory Consolidation - Duration (p50/p95/p99)',
          width: 12,
          height: 6,
          left: [
            consolidationFn.metricDuration({ period, statistic: 'p50', label: 'p50' }),
            consolidationFn.metricDuration({ period, statistic: 'p95', label: 'p95' }),
            consolidationFn.metricDuration({ period, statistic: 'p99', label: 'p99' }),
          ],
        }),
      );
    }

    // ========================================================================
    // Row 10: ECS Discord Gateway Health (if deployed)
    // ========================================================================
    // The Discord gateway is a Fargate service that receives inbound Discord messages
    // via websocket. Avatars configured with bot/hybrid mode depend on this service.
    // When running tasks drops to zero, those avatars cannot receive Discord messages.
    if (props.discordGatewayService) {
      // Use standard AWS/ECS metrics for running task count. These are
      // always available and do not require Container Insights to be enabled.
      const serviceName = props.discordGatewayService.serviceName;
      const clusterName = props.discordGatewayService.cluster.clusterName;

      const desiredCountMetric = new cloudwatch.Metric({
        namespace: 'AWS/ECS',
        metricName: 'DesiredTaskCount',
        dimensionsMap: {
          ServiceName: serviceName,
          ClusterName: clusterName,
        },
        period: cdk.Duration.minutes(5),
        statistic: 'Average',
      });

      const runningTaskCountMetric = new cloudwatch.Metric({
        namespace: 'AWS/ECS',
        metricName: 'RunningTaskCount',
        dimensionsMap: {
          ServiceName: serviceName,
          ClusterName: clusterName,
        },
        period: cdk.Duration.minutes(5),
        statistic: 'Average',
      });

      // Alarm: running tasks drops to zero while we expect at least one
      this.discordGatewayDriftAlarm = new cloudwatch.Alarm(this, 'DiscordGatewayDriftAlarm', {
        alarmName: `swarm-discord-gateway-drift-${environment}${suffix}`,
        alarmDescription:
          'Discord gateway service has zero running tasks. ' +
          'Avatars configured with bot/hybrid mode cannot receive inbound Discord messages. ' +
          'Investigate ECS task failures or restore the gateway service.',
        metric: runningTaskCountMetric,
        threshold: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
        evaluationPeriods: 2,
        datapointsToAlarm: 2,
        treatMissingData: cloudwatch.TreatMissingData.BREACHING,
      });

      // Route alarm to SNS topic if provided
      if (props.alarmTopic) {
        this.discordGatewayDriftAlarm.addAlarmAction(
          new cloudwatch_actions.SnsAction(props.alarmTopic)
        );
        this.discordGatewayDriftAlarm.addOkAction(
          new cloudwatch_actions.SnsAction(props.alarmTopic)
        );
      }

      // Add gateway health widget to dashboard
      this.dashboard.addWidgets(
        new cloudwatch.GraphWidget({
          title: 'Discord Gateway ECS - Running vs Desired Tasks',
          width: 12,
          height: 6,
          left: [
            desiredCountMetric,
            runningTaskCountMetric,
          ],
        }),
        new cloudwatch.AlarmWidget({
          title: 'Discord Gateway - Runtime Drift Alarm',
          width: 12,
          height: 6,
          alarm: this.discordGatewayDriftAlarm,
        }),
      );
    }
  }
}
