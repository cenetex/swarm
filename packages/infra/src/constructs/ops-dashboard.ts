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
    // Row 1: Shared Handlers — Lambda Invocations & Errors
    // ========================================================================
    const sharedFns = props.sharedHandlerFunctions;

    this.dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Shared Handlers - Invocations',
        width: 12,
        height: 6,
        left: [
          sharedFns.messageProcessor.metricInvocations({ period, label: 'MessageProcessor' }),
          sharedFns.responseSender.metricInvocations({ period, label: 'ResponseSender' }),
          sharedFns.mediaProcessor.metricInvocations({ period, label: 'MediaProcessor' }),
          sharedFns.tweetSender.metricInvocations({ period, label: 'TweetSender' }),
          sharedFns.telegramWebhook.metricInvocations({ period, label: 'TelegramWebhook' }),
        ],
      }),
      new cloudwatch.GraphWidget({
        title: 'Shared Handlers - Errors',
        width: 12,
        height: 6,
        left: [
          sharedFns.messageProcessor.metricErrors({ period, label: 'MessageProcessor' }),
          sharedFns.responseSender.metricErrors({ period, label: 'ResponseSender' }),
          sharedFns.mediaProcessor.metricErrors({ period, label: 'MediaProcessor' }),
          sharedFns.tweetSender.metricErrors({ period, label: 'TweetSender' }),
          sharedFns.telegramWebhook.metricErrors({ period, label: 'TelegramWebhook' }),
        ],
      }),
    );

    // ========================================================================
    // Row 2: Shared Handlers — Lambda Duration (p50 / p95)
    // ========================================================================
    this.dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Shared Handlers - Duration p50 (ms)',
        width: 12,
        height: 6,
        left: [
          sharedFns.messageProcessor.metricDuration({ period, statistic: 'p50', label: 'MessageProcessor' }),
          sharedFns.responseSender.metricDuration({ period, statistic: 'p50', label: 'ResponseSender' }),
          sharedFns.mediaProcessor.metricDuration({ period, statistic: 'p50', label: 'MediaProcessor' }),
          sharedFns.tweetSender.metricDuration({ period, statistic: 'p50', label: 'TweetSender' }),
          sharedFns.telegramWebhook.metricDuration({ period, statistic: 'p50', label: 'TelegramWebhook' }),
        ],
      }),
      new cloudwatch.GraphWidget({
        title: 'Shared Handlers - Duration p95 (ms)',
        width: 12,
        height: 6,
        left: [
          sharedFns.messageProcessor.metricDuration({ period, statistic: 'p95', label: 'MessageProcessor' }),
          sharedFns.responseSender.metricDuration({ period, statistic: 'p95', label: 'ResponseSender' }),
          sharedFns.mediaProcessor.metricDuration({ period, statistic: 'p95', label: 'MediaProcessor' }),
          sharedFns.tweetSender.metricDuration({ period, statistic: 'p95', label: 'TweetSender' }),
          sharedFns.telegramWebhook.metricDuration({ period, statistic: 'p95', label: 'TelegramWebhook' }),
        ],
      }),
    );

    // ========================================================================
    // Row 3: Shared Handlers — Duration p99
    // ========================================================================
    this.dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Shared Handlers - Duration p99 (ms)',
        width: 24,
        height: 6,
        left: [
          sharedFns.messageProcessor.metricDuration({ period, statistic: 'p99', label: 'MessageProcessor' }),
          sharedFns.responseSender.metricDuration({ period, statistic: 'p99', label: 'ResponseSender' }),
          sharedFns.mediaProcessor.metricDuration({ period, statistic: 'p99', label: 'MediaProcessor' }),
          sharedFns.tweetSender.metricDuration({ period, statistic: 'p99', label: 'TweetSender' }),
          sharedFns.telegramWebhook.metricDuration({ period, statistic: 'p99', label: 'TelegramWebhook' }),
        ],
      }),
    );

    // ========================================================================
    // Row 4: Shared Handlers — Throttles & Concurrent Executions
    // ========================================================================
    this.dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Shared Handlers - Throttles',
        width: 12,
        height: 6,
        left: [
          sharedFns.messageProcessor.metricThrottles({ period, label: 'MessageProcessor' }),
          sharedFns.responseSender.metricThrottles({ period, label: 'ResponseSender' }),
          sharedFns.mediaProcessor.metricThrottles({ period, label: 'MediaProcessor' }),
          sharedFns.tweetSender.metricThrottles({ period, label: 'TweetSender' }),
          sharedFns.telegramWebhook.metricThrottles({ period, label: 'TelegramWebhook' }),
        ],
      }),
      new cloudwatch.GraphWidget({
        title: 'Shared Handlers - Concurrent Executions',
        width: 12,
        height: 6,
        left: [
          sharedFns.messageProcessor.metric('ConcurrentExecutions', { period, statistic: 'Maximum', label: 'MessageProcessor' }),
          sharedFns.responseSender.metric('ConcurrentExecutions', { period, statistic: 'Maximum', label: 'ResponseSender' }),
          sharedFns.mediaProcessor.metric('ConcurrentExecutions', { period, statistic: 'Maximum', label: 'MediaProcessor' }),
          sharedFns.tweetSender.metric('ConcurrentExecutions', { period, statistic: 'Maximum', label: 'TweetSender' }),
          sharedFns.telegramWebhook.metric('ConcurrentExecutions', { period, statistic: 'Maximum', label: 'TelegramWebhook' }),
        ],
      }),
    );

    // ========================================================================
    // Row 4: SQS Queue Depths & Age of Oldest Message
    // ========================================================================
    const queues = props.sharedQueues;

    this.dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'SQS Queue Depths (Shared)',
        width: 12,
        height: 6,
        left: [
          queues.messageQueue.metricApproximateNumberOfMessagesVisible({ period, label: 'Messages' }),
          queues.responseQueue.metricApproximateNumberOfMessagesVisible({ period, label: 'Responses' }),
          queues.mediaQueue.metricApproximateNumberOfMessagesVisible({ period, label: 'Media' }),
          queues.postQueue.metricApproximateNumberOfMessagesVisible({ period, label: 'Posts' }),
        ],
      }),
      new cloudwatch.GraphWidget({
        title: 'SQS Age of Oldest Message (seconds)',
        width: 12,
        height: 6,
        left: [
          queues.messageQueue.metricApproximateAgeOfOldestMessage({ period, label: 'Messages' }),
          queues.responseQueue.metricApproximateAgeOfOldestMessage({ period, label: 'Responses' }),
          queues.mediaQueue.metricApproximateAgeOfOldestMessage({ period, label: 'Media' }),
          queues.postQueue.metricApproximateAgeOfOldestMessage({ period, label: 'Posts' }),
          ...(props.adminQueues ? [
            props.adminQueues.responseQueue.metricApproximateAgeOfOldestMessage({ period, label: 'Admin Responses' }),
            props.adminQueues.chatQueue.metricApproximateAgeOfOldestMessage({ period, label: 'Admin Chat' }),
            props.adminQueues.dreamQueue.metricApproximateAgeOfOldestMessage({ period, label: 'Admin Dreams' }),
          ] : []),
        ],
      }),
    );

    // ========================================================================
    // Row 5: DLQ Message Counts
    // ========================================================================
    this.dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'DLQ Message Counts',
        width: 24,
        height: 6,
        left: [
          props.sharedDlqs.dlq.metricApproximateNumberOfMessagesVisible({ period, label: 'Shared FIFO DLQ' }),
          props.sharedDlqs.schedulerDlq.metricApproximateNumberOfMessagesVisible({ period, label: 'Scheduler DLQ' }),
          ...(props.adminDlqs ? [
            props.adminDlqs.responseDlq.metricApproximateNumberOfMessagesVisible({ period, label: 'Admin Response DLQ' }),
            props.adminDlqs.chatDlq.metricApproximateNumberOfMessagesVisible({ period, label: 'Admin Chat DLQ' }),
            props.adminDlqs.dreamDlq.metricApproximateNumberOfMessagesVisible({ period, label: 'Admin Dream DLQ' }),
            props.adminDlqs.consolidationDlq.metricApproximateNumberOfMessagesVisible({ period, label: 'Admin Consolidation DLQ' }),
          ] : []),
        ],
      }),
    );

    // ========================================================================
    // Row 6: Admin API — Lambda Invocations & Errors (if present)
    // ========================================================================
    if (props.adminHandlerFunctions) {
      const adminFns = props.adminHandlerFunctions;

      this.dashboard.addWidgets(
        new cloudwatch.GraphWidget({
          title: 'Admin API - Invocations',
          width: 12,
          height: 6,
          left: [
            adminFns.chatWorker.metricInvocations({ period, label: 'ChatWorker' }),
            adminFns.responseSender.metricInvocations({ period, label: 'ResponseSender' }),
            adminFns.dreamWorker.metricInvocations({ period, label: 'DreamWorker' }),
            adminFns.openaiCompat.metricInvocations({ period, label: 'OpenAICompat' }),
          ],
        }),
        new cloudwatch.GraphWidget({
          title: 'Admin API - Errors',
          width: 12,
          height: 6,
          left: [
            adminFns.chatWorker.metricErrors({ period, label: 'ChatWorker' }),
            adminFns.responseSender.metricErrors({ period, label: 'ResponseSender' }),
            adminFns.dreamWorker.metricErrors({ period, label: 'DreamWorker' }),
            adminFns.openaiCompat.metricErrors({ period, label: 'OpenAICompat' }),
          ],
        }),
      );

      // ======================================================================
      // Row 7: Admin API — Lambda Duration (p50 / p95)
      // ======================================================================
      this.dashboard.addWidgets(
        new cloudwatch.GraphWidget({
          title: 'Admin API - Duration p50 (ms)',
          width: 12,
          height: 6,
          left: [
            adminFns.chatWorker.metricDuration({ period, statistic: 'p50', label: 'ChatWorker' }),
            adminFns.responseSender.metricDuration({ period, statistic: 'p50', label: 'ResponseSender' }),
            adminFns.dreamWorker.metricDuration({ period, statistic: 'p50', label: 'DreamWorker' }),
            adminFns.openaiCompat.metricDuration({ period, statistic: 'p50', label: 'OpenAICompat' }),
          ],
        }),
        new cloudwatch.GraphWidget({
          title: 'Admin API - Duration p95 (ms)',
          width: 12,
          height: 6,
          left: [
            adminFns.chatWorker.metricDuration({ period, statistic: 'p95', label: 'ChatWorker' }),
            adminFns.responseSender.metricDuration({ period, statistic: 'p95', label: 'ResponseSender' }),
            adminFns.dreamWorker.metricDuration({ period, statistic: 'p95', label: 'DreamWorker' }),
            adminFns.openaiCompat.metricDuration({ period, statistic: 'p95', label: 'OpenAICompat' }),
          ],
        }),
      );

      // ======================================================================
      // Admin API — Duration p99
      // ======================================================================
      this.dashboard.addWidgets(
        new cloudwatch.GraphWidget({
          title: 'Admin API - Duration p99 (ms)',
          width: 24,
          height: 6,
          left: [
            adminFns.chatWorker.metricDuration({ period, statistic: 'p99', label: 'ChatWorker' }),
            adminFns.responseSender.metricDuration({ period, statistic: 'p99', label: 'ResponseSender' }),
            adminFns.dreamWorker.metricDuration({ period, statistic: 'p99', label: 'DreamWorker' }),
            adminFns.openaiCompat.metricDuration({ period, statistic: 'p99', label: 'OpenAICompat' }),
          ],
        }),
      );

      // ======================================================================
      // Admin API — Throttles & Concurrent Executions
      // ======================================================================
      this.dashboard.addWidgets(
        new cloudwatch.GraphWidget({
          title: 'Admin API - Throttles',
          width: 12,
          height: 6,
          left: [
            adminFns.chatWorker.metricThrottles({ period, label: 'ChatWorker' }),
            adminFns.responseSender.metricThrottles({ period, label: 'ResponseSender' }),
            adminFns.dreamWorker.metricThrottles({ period, label: 'DreamWorker' }),
            adminFns.openaiCompat.metricThrottles({ period, label: 'OpenAICompat' }),
          ],
        }),
        new cloudwatch.GraphWidget({
          title: 'Admin API - Concurrent Executions',
          width: 12,
          height: 6,
          left: [
            adminFns.chatWorker.metric('ConcurrentExecutions', { period, statistic: 'Maximum', label: 'ChatWorker' }),
            adminFns.responseSender.metric('ConcurrentExecutions', { period, statistic: 'Maximum', label: 'ResponseSender' }),
            adminFns.dreamWorker.metric('ConcurrentExecutions', { period, statistic: 'Maximum', label: 'DreamWorker' }),
            adminFns.openaiCompat.metric('ConcurrentExecutions', { period, statistic: 'Maximum', label: 'OpenAICompat' }),
          ],
        }),
      );
    }

    // ========================================================================
    // Row 9: API Gateway — Latency & Error Rates (if AdminApi is deployed)
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
              label: 'Latency p50',
            }),
            new cloudwatch.Metric({
              namespace: 'AWS/ApiGateway',
              metricName: 'Latency',
              dimensionsMap: apiDimensions,
              period,
              statistic: 'p95',
              label: 'Latency p95',
            }),
            new cloudwatch.Metric({
              namespace: 'AWS/ApiGateway',
              metricName: 'IntegrationLatency',
              dimensionsMap: apiDimensions,
              period,
              statistic: 'p50',
              label: 'Integration p50',
            }),
            new cloudwatch.Metric({
              namespace: 'AWS/ApiGateway',
              metricName: 'IntegrationLatency',
              dimensionsMap: apiDimensions,
              period,
              statistic: 'p95',
              label: 'Integration p95',
            }),
          ],
        }),
        new cloudwatch.GraphWidget({
          title: 'API Gateway - 4xx / 5xx Error Rates',
          width: 12,
          height: 6,
          left: [
            new cloudwatch.Metric({
              namespace: 'AWS/ApiGateway',
              metricName: '4xx',
              dimensionsMap: apiDimensions,
              period,
              statistic: 'Sum',
              label: '4xx Errors',
            }),
            new cloudwatch.Metric({
              namespace: 'AWS/ApiGateway',
              metricName: '5xx',
              dimensionsMap: apiDimensions,
              period,
              statistic: 'Sum',
              label: '5xx Errors',
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
    // Memory Consolidation Worker (if present)
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
          title: 'Memory Consolidation - Duration (ms)',
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
    // Discord Gateway Runtime Drift Alarm
    // ========================================================================
    // When the Discord gateway service is deployed, create an alarm that fires
    // when it has zero running tasks for more than 5 minutes. This detects the
    // "config drift" scenario where bot/hybrid avatars expect inbound Discord
    // messages but the gateway container is down.
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
          title: 'Discord Gateway - Task Count',
          width: 12,
          height: 6,
          left: [
            desiredCountMetric,
            runningTaskCountMetric,
          ],
        }),
        new cloudwatch.AlarmWidget({
          title: 'Discord Gateway - Drift Alarm',
          width: 12,
          height: 6,
          alarm: this.discordGatewayDriftAlarm,
        }),
      );
    }
  }
}
