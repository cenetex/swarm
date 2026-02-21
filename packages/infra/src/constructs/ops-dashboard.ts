/**
 * Operations Dashboard Construct
 *
 * Creates a single CloudWatch dashboard providing a unified view of:
 * - Lambda invocations and errors for all critical handlers
 * - SQS queue depths for message, response, media, and post queues
 * - DLQ message counts across SharedHandlers and AdminApi
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
    // Row 2: SQS Queue Depths
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
        title: 'DLQ Message Counts',
        width: 12,
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
    // Row 3: Admin API — Lambda Invocations & Errors (if present)
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
