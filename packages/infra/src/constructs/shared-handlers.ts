/**
 * Shared Handlers Construct
 *
 * Deploys a shared (multi-tenant) runtime based on @swarm/handlers:
 * - Shared FIFO message/response/media queues
 * - Message processor + response sender + media processor consumers
 * - Shared Twitter mention poller schedule (multi-tenant)
 */
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cw_actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import type * as sns from 'aws-cdk-lib/aws-sns';
import type * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import type * as s3 from 'aws-cdk-lib/aws-s3';
import * as path from 'path';
import { fileURLToPath } from 'url';

import { LogGroupWithRetention } from '../utils/log-group-with-retention.js';

// ESM equivalent of __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BEDROCK_ALLOWED_MODEL_ARNS = [
  'arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-*',
];

export interface SharedHandlersProps {
  environment: string;
  /**
   * Optional suffix for resource names/exports (e.g., "-a1b2c3")
   */
  nameSuffix?: string;
  /**
   * Optional dependency layer for native modules like sharp.
   * When using NodejsFunction bundling, this is only needed for native deps.
   */
  dependencyLayer?: lambda.ILayerVersion;
  stateTable: dynamodb.ITable;
  activityTable: dynamodb.ITable;
  mediaBucket: s3.IBucket;
  /**
   * Admin table for DM bot creation flow sessions.
   * Required for the Telegram admin service to store user sessions and bot mappings.
   */
  adminTable?: dynamodb.ITable;
  cdnUrl?: string;
  replicateApiKeyArn?: string;
  secretPrefix?: string;
  /**
   * Twitter API tier: 'free' (100 tweets/month) or 'basic' (15,000 tweets/month)
   * @default 'basic'
   */
  twitterApiTier?: 'free' | 'basic';
  /**
   * Override the monthly Twitter API budget (reads)
   * @default tier default (100 for free, 15000 for basic)
   */
  twitterMonthlyBudget?: number;
  /**
   * Percentage of daily budget to reserve for spikes (0-100)
   * @default 20
   */
  twitterDailyReservePct?: number;
  /**
   * Internal test key for bypassing webhook auth in non-production environments.
   * If not provided, one will be generated.
   */
  internalTestKey?: string;
  /**
   * SNS topic for CloudWatch alarm notifications.
   * When provided, all alarms in this construct will send notifications to this topic.
   */
  alarmTopic?: sns.ITopic;
}

export class SharedHandlers extends Construct {
  public readonly messageQueue: sqs.Queue;
  public readonly responseQueue: sqs.Queue;
  public readonly mediaQueue: sqs.Queue;
  public readonly postQueue: sqs.Queue;
  public readonly telegramWebhook: lambda.Function;
  public readonly messageProcessor: nodejs.NodejsFunction;
  public readonly responseSender: nodejs.NodejsFunction;
  public readonly mediaProcessor: nodejs.NodejsFunction;
  public readonly tweetSender: nodejs.NodejsFunction;
  public readonly moltbookHeartbeat: nodejs.NodejsFunction;
  public readonly dlq: sqs.Queue;
  public readonly schedulerDlq: sqs.Queue;

  constructor(scope: Construct, id: string, props: SharedHandlersProps) {
    super(scope, id);

    const {
      environment,
      dependencyLayer,
      stateTable,
      activityTable,
      mediaBucket,
      adminTable,
      cdnUrl,
      replicateApiKeyArn,
      secretPrefix = 'swarm',
      twitterApiTier = 'basic',
      twitterMonthlyBudget,
      twitterDailyReservePct = 20,
      internalTestKey,
    } = props;
    const suffix = props.nameSuffix ?? '';

    // Generate internal test key if not provided (non-production only).
    // Production MUST NOT have a test key to prevent auth bypass.
    const isProd = environment === 'prod' || environment === 'production';
    const effectiveInternalTestKey = !isProd
      ? internalTestKey || process.env.INTERNAL_TEST_KEY || `test-${Date.now()}-${Math.random().toString(36).substring(2)}`
      : '';

    // Path to handlers source files
    const handlersEntry = path.join(__dirname, '../../../handlers/src');

    this.dlq = new sqs.Queue(this, 'DeadLetterQueue', {
      queueName: `swarm-${environment}${suffix}-dlq.fifo`,
      fifo: true,
      retentionPeriod: cdk.Duration.days(14),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
    });

    this.messageQueue = new sqs.Queue(this, 'MessageQueue', {
      queueName: `swarm-${environment}${suffix}-messages.fifo`,
      fifo: true,
      contentBasedDeduplication: true,
      // Must be >= the message-processor Lambda timeout to avoid duplicate deliveries.
      visibilityTimeout: cdk.Duration.seconds(180),
      deadLetterQueue: { queue: this.dlq, maxReceiveCount: 3 },
      encryption: sqs.QueueEncryption.SQS_MANAGED,
    });

    this.responseQueue = new sqs.Queue(this, 'ResponseQueue', {
      queueName: `swarm-${environment}${suffix}-responses.fifo`,
      fifo: true,
      contentBasedDeduplication: true,
      // Keep some headroom for retries within a single invocation.
      visibilityTimeout: cdk.Duration.seconds(180),
      deadLetterQueue: { queue: this.dlq, maxReceiveCount: 3 },
      encryption: sqs.QueueEncryption.SQS_MANAGED,
    });

    this.mediaQueue = new sqs.Queue(this, 'MediaQueue', {
      queueName: `swarm-${environment}${suffix}-media.fifo`,
      fifo: true,
      contentBasedDeduplication: true,
      visibilityTimeout: cdk.Duration.minutes(5),
      deadLetterQueue: { queue: this.dlq, maxReceiveCount: 3 },
      encryption: sqs.QueueEncryption.SQS_MANAGED,
    });

    // POST_QUEUE for decoupled Twitter posting with rate limit handling
    this.postQueue = new sqs.Queue(this, 'PostQueue', {
      queueName: `swarm-${environment}${suffix}-posts.fifo`,
      fifo: true,
      // No content-based deduplication - we need explicit dedup IDs for retries
      visibilityTimeout: cdk.Duration.seconds(120),
      deadLetterQueue: { queue: this.dlq, maxReceiveCount: 5 },
      encryption: sqs.QueueEncryption.SQS_MANAGED,
    });

    const lambdaRole = new iam.Role(this, 'LambdaRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('AWSXRayDaemonWriteAccess'),
      ],
    });

    stateTable.grantReadWriteData(lambdaRole);
    activityTable.grantReadWriteData(lambdaRole);
    mediaBucket.grantReadWrite(lambdaRole);
    if (adminTable) {
      adminTable.grantReadWriteData(lambdaRole);
    }
    this.messageQueue.grantSendMessages(lambdaRole);
    this.messageQueue.grantConsumeMessages(lambdaRole);
    this.responseQueue.grantSendMessages(lambdaRole);
    this.responseQueue.grantConsumeMessages(lambdaRole);
    this.mediaQueue.grantSendMessages(lambdaRole);
    this.mediaQueue.grantConsumeMessages(lambdaRole);
    this.postQueue.grantSendMessages(lambdaRole);
    this.postQueue.grantConsumeMessages(lambdaRole);

    // Secrets: allow reading any secret under the configured prefix (e.g. swarm/<avatarId>/secrets)
    lambdaRole.addToPolicy(new iam.PolicyStatement({
      actions: ['secretsmanager:GetSecretValue'],
      resources: [
        `arn:aws:secretsmanager:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:secret:${secretPrefix}/*`,
      ],
    }));

    // KMS: allow decrypting secrets (required for KMS-encrypted secrets)
    lambdaRole.addToPolicy(new iam.PolicyStatement({
      actions: ['kms:Decrypt'],
      resources: ['*'],
      conditions: {
        StringEquals: {
          'kms:ViaService': `secretsmanager.${cdk.Aws.REGION}.amazonaws.com`,
        },
      },
    }));

    if (replicateApiKeyArn) {
      lambdaRole.addToPolicy(new iam.PolicyStatement({
        actions: ['secretsmanager:GetSecretValue'],
        resources: [replicateApiKeyArn],
      }));
    }

    // Grant Bedrock access (used by core LLM service if configured)
    lambdaRole.addToPolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
      resources: BEDROCK_ALLOWED_MODEL_ARNS,
    }));

    const commonEnv: Record<string, string> = {
      NODE_OPTIONS: '--enable-source-maps',
      STATE_TABLE: stateTable.tableName,
      ACTIVITY_TABLE: activityTable.tableName,
      MEDIA_BUCKET: mediaBucket.bucketName,
      MESSAGE_QUEUE_URL: this.messageQueue.queueUrl,
      RESPONSE_QUEUE_URL: this.responseQueue.queueUrl,
      MEDIA_QUEUE_URL: this.mediaQueue.queueUrl,
      POST_QUEUE_URL: this.postQueue.queueUrl,
      CDN_URL: cdnUrl || '',
      ENVIRONMENT: environment,
      SECRET_PREFIX: secretPrefix,
      // Runtime cache defaults (explicitly set in infra for predictable behavior).
      AVATAR_RUNTIME_CACHE_TTL_MS: '300000',
      AVATAR_RUNTIME_CACHE_MAX_SIZE: '200',
      AVATAR_RUNTIME_CACHE_LOG_INTERVAL_MS: '60000',
      OUTBOUND_CACHE_TTL_MS: '300000',
      OUTBOUND_CACHE_MAX_SIZE: '200',
      OUTBOUND_CACHE_LOG_INTERVAL_MS: '60000',
      MEDIA_RUNTIME_CACHE_TTL_MS: '300000',
      MEDIA_RUNTIME_CACHE_MAX_SIZE: '200',
      MEDIA_RUNTIME_CACHE_LOG_INTERVAL_MS: '60000',
      // Admin table for DM bot creation flow (Telegram admin service)
      ...(adminTable ? { ADMIN_TABLE: adminTable.tableName } : {}),
      // Twitter API budget configuration
      TWITTER_API_TIER: twitterApiTier,
      TWITTER_DAILY_RESERVE_PCT: String(twitterDailyReservePct),
      ...(twitterMonthlyBudget ? { TWITTER_MONTHLY_BUDGET: String(twitterMonthlyBudget) } : {}),
      // Enable unified MessageProcessor for consistent tool access across platforms
      USE_UNIFIED_PROCESSOR: 'true',
      // Internal test key for bypassing webhook auth in E2E tests
      ...(effectiveInternalTestKey ? { INTERNAL_TEST_KEY: effectiveInternalTestKey } : {}),
    };

    if (replicateApiKeyArn) {
      commonEnv.REPLICATE_API_KEY_SECRET_ARN = replicateApiKeyArn;
    }

    // Common bundling options: bundle AWS SDK (don't externalize) to avoid layer CJS/ESM conflicts
    // Externalize sharp (native layer) and node-fetch (to use native fetch in Node.js 20+)
    // The externalModules for node-fetch forces grammy to fail import and fall back to native fetch
    const bundlingOptions = {
      format: nodejs.OutputFormat.CJS,
      externalModules: ['sharp', 'node-fetch', 'abort-controller'],
      minify: true,
      sourceMap: true,
    };


    // ========================================================================
    // CloudWatch Log Groups (explicit management replaces deprecated logRetention)
    // ========================================================================
    // Using LogGroupWithRetention to safely adopt existing log groups that were
    // previously created by the logRetention custom resource or Lambda runtime.
    const logRemovalPolicy = isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY;

    const messageProcessorLogGroup = new LogGroupWithRetention(this, 'MessageProcessorLogGroup', {
      logGroupName: `/aws/lambda/swarm-${environment}${suffix}-message-processor`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: logRemovalPolicy,
    });

    const telegramWebhookLogGroup = new LogGroupWithRetention(this, 'TelegramWebhookLogGroup', {
      logGroupName: `/aws/lambda/swarm-${environment}${suffix}-telegram-webhook`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: logRemovalPolicy,
    });

    const responseSenderLogGroup = new LogGroupWithRetention(this, 'ResponseSenderLogGroup', {
      logGroupName: `/aws/lambda/swarm-${environment}${suffix}-response-sender`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: logRemovalPolicy,
    });

    const mediaProcessorLogGroup = new LogGroupWithRetention(this, 'MediaProcessorLogGroup', {
      logGroupName: `/aws/lambda/swarm-${environment}${suffix}-media-processor`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: logRemovalPolicy,
    });

    const twitterMentionPollerLogGroup = new LogGroupWithRetention(this, 'TwitterMentionPollerLogGroup', {
      logGroupName: `/aws/lambda/swarm-${environment}${suffix}-twitter-mention-poller`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: logRemovalPolicy,
    });

    const autonomousTweetPosterLogGroup = new LogGroupWithRetention(this, 'AutonomousTweetPosterLogGroup', {
      logGroupName: `/aws/lambda/swarm-${environment}${suffix}-autonomous-tweet-poster`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: logRemovalPolicy,
    });

    const moltbookHeartbeatLogGroup = new LogGroupWithRetention(this, 'MoltbookHeartbeatLogGroup', {
      logGroupName: `/aws/lambda/swarm-${environment}${suffix}-moltbook-heartbeat`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: logRemovalPolicy,
    });

    const tweetSenderLogGroup = new LogGroupWithRetention(this, 'TweetSenderLogGroup', {
      logGroupName: `/aws/lambda/swarm-${environment}${suffix}-tweet-sender`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: logRemovalPolicy,
    });

    this.messageProcessor = new nodejs.NodejsFunction(this, 'MessageProcessor', {
      functionName: `swarm-${environment}${suffix}-message-processor`,
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(handlersEntry, 'message-processor.ts'),
      handler: 'handler',
      layers: dependencyLayer ? [dependencyLayer] : undefined,
      role: lambdaRole,
      // LLM calls, image generation, and Twitter posting can exceed 120s.
      timeout: cdk.Duration.seconds(180),
      memorySize: 1024,
      reservedConcurrentExecutions: 20,
      environment: commonEnv,
      bundling: bundlingOptions,
      tracing: lambda.Tracing.ACTIVE,
      logGroup: messageProcessorLogGroup.logGroup,
    });

    this.telegramWebhook = new nodejs.NodejsFunction(this, 'TelegramWebhookShared', {
      functionName: `swarm-${environment}${suffix}-telegram-webhook`,
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(handlersEntry, 'telegram-webhook-shared.ts'),
      handler: 'handler',
      layers: dependencyLayer ? [dependencyLayer] : undefined,
      role: lambdaRole,
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
      environment: commonEnv,
      bundling: bundlingOptions,
      tracing: lambda.Tracing.ACTIVE,
      logGroup: telegramWebhookLogGroup.logGroup,
    });

    this.messageProcessor.addEventSource(new lambdaEventSources.SqsEventSource(this.messageQueue, {
      batchSize: 10,
      reportBatchItemFailures: true,
    }));

    this.responseSender = new nodejs.NodejsFunction(this, 'ResponseSender', {
      functionName: `swarm-${environment}${suffix}-response-sender`,
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(handlersEntry, 'response-sender.ts'),
      handler: 'handler',
      layers: dependencyLayer ? [dependencyLayer] : undefined,
      role: lambdaRole,
      timeout: cdk.Duration.seconds(60),
      memorySize: 1024,
      reservedConcurrentExecutions: 10,
      environment: commonEnv,
      bundling: bundlingOptions,
      tracing: lambda.Tracing.ACTIVE,
      logGroup: responseSenderLogGroup.logGroup,
    });

    this.responseSender.addEventSource(new lambdaEventSources.SqsEventSource(this.responseQueue, {
      batchSize: 10,
      reportBatchItemFailures: true,
    }));

    this.mediaProcessor = new nodejs.NodejsFunction(this, 'MediaProcessor', {
      functionName: `swarm-${environment}${suffix}-media-processor`,
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(handlersEntry, 'media-processor.ts'),
      handler: 'handler',
      layers: dependencyLayer ? [dependencyLayer] : undefined,
      role: lambdaRole,
      timeout: cdk.Duration.minutes(5),
      memorySize: 1024,
      reservedConcurrentExecutions: 10,
      environment: commonEnv,
      bundling: bundlingOptions,
      tracing: lambda.Tracing.ACTIVE,
      logGroup: mediaProcessorLogGroup.logGroup,
    });

    this.mediaProcessor.addEventSource(new lambdaEventSources.SqsEventSource(this.mediaQueue, {
      batchSize: 5,
      reportBatchItemFailures: true,
    }));

    const twitterMentionPoller = new nodejs.NodejsFunction(this, 'TwitterMentionPollerShared', {
      functionName: `swarm-${environment}${suffix}-twitter-mention-poller`,
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(handlersEntry, 'twitter-mention-poller-shared.ts'),
      handler: 'handler',
      layers: dependencyLayer ? [dependencyLayer] : undefined,
      role: lambdaRole,
      timeout: cdk.Duration.minutes(2),
      memorySize: 512,
      environment: commonEnv,
      bundling: bundlingOptions,
      tracing: lambda.Tracing.ACTIVE,
      logGroup: twitterMentionPollerLogGroup.logGroup,
    });

    this.schedulerDlq = new sqs.Queue(this, 'SchedulerDLQ', {
      queueName: `swarm-${environment}${suffix}-scheduler-dlq`,
      retentionPeriod: cdk.Duration.days(14),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
    });

    new events.Rule(this, 'TwitterMentionPollSchedule', {
      schedule: events.Schedule.rate(cdk.Duration.minutes(1)),
      targets: [new targets.LambdaFunction(twitterMentionPoller, {
        deadLetterQueue: this.schedulerDlq,
        retryAttempts: 2,
        maxEventAge: cdk.Duration.hours(2),
      })],
    });

    // Autonomous Tweet Poster - runs hourly, manages per-avatar timing internally
    // Each avatar has 4-6 hour randomized intervals configured in their autonomousPosts settings
    const autonomousTweetPoster = new nodejs.NodejsFunction(this, 'AutonomousTweetPoster', {
      functionName: `swarm-${environment}${suffix}-autonomous-tweet-poster`,
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(handlersEntry, 'autonomous-tweet-poster.ts'),
      handler: 'handler',
      layers: dependencyLayer ? [dependencyLayer] : undefined,
      role: lambdaRole,
      timeout: cdk.Duration.minutes(5), // Longer timeout for multi-avatar processing
      memorySize: 1024,
      environment: commonEnv,
      bundling: bundlingOptions,
      tracing: lambda.Tracing.ACTIVE,
      logGroup: autonomousTweetPosterLogGroup.logGroup,
    });

    new events.Rule(this, 'AutonomousTweetSchedule', {
      schedule: events.Schedule.rate(cdk.Duration.hours(1)),
      targets: [new targets.LambdaFunction(autonomousTweetPoster, {
        deadLetterQueue: this.schedulerDlq,
        retryAttempts: 2,
        maxEventAge: cdk.Duration.hours(2),
      })],
    });

    // Moltbook Heartbeat - runs every 33 minutes, manages per-avatar timing internally
    // Each avatar with Moltbook enabled gets feed checks and optional engagement
    this.moltbookHeartbeat = new nodejs.NodejsFunction(this, 'MoltbookHeartbeat', {
      functionName: `swarm-${environment}${suffix}-moltbook-heartbeat`,
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(handlersEntry, 'moltbook-heartbeat.ts'),
      handler: 'handler',
      layers: dependencyLayer ? [dependencyLayer] : undefined,
      role: lambdaRole,
      timeout: cdk.Duration.minutes(5), // Longer timeout for multi-avatar processing
      memorySize: 1024,
      environment: commonEnv,
      bundling: bundlingOptions,
      tracing: lambda.Tracing.ACTIVE,
      logGroup: moltbookHeartbeatLogGroup.logGroup,
    });

    new events.Rule(this, 'MoltbookHeartbeatSchedule', {
      schedule: events.Schedule.rate(cdk.Duration.minutes(33)),
      targets: [new targets.LambdaFunction(this.moltbookHeartbeat, {
        deadLetterQueue: this.schedulerDlq,
        retryAttempts: 2,
        maxEventAge: cdk.Duration.hours(2),
      })],
    });

    // Tweet Sender - Consumes POST_QUEUE for decoupled Twitter posting
    // Handles rate limiting, backoff, and content store integration
    this.tweetSender = new nodejs.NodejsFunction(this, 'TweetSender', {
      functionName: `swarm-${environment}${suffix}-tweet-sender`,
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(handlersEntry, 'tweet-sender.ts'),
      handler: 'handler',
      layers: dependencyLayer ? [dependencyLayer] : undefined,
      role: lambdaRole,
      timeout: cdk.Duration.seconds(120),
      memorySize: 512,
      environment: {
        ...commonEnv,
        // Enable decoupled posting feature
        ENABLE_DECOUPLED_POSTING: 'true',
        // Enable content store for post tracking
        ENABLE_CONTENT_STORE: 'true',
      },
      bundling: bundlingOptions,
      tracing: lambda.Tracing.ACTIVE,
      logGroup: tweetSenderLogGroup.logGroup,
    });

    this.tweetSender.addEventSource(new lambdaEventSources.SqsEventSource(this.postQueue, {
      batchSize: 5,
      reportBatchItemFailures: true,
    }));

    // ========================================================================
    // CloudWatch Alarms
    // ========================================================================
    const alarmPrefix = `swarm-${environment}-shared`;
    const snsAction = props.alarmTopic ? new cw_actions.SnsAction(props.alarmTopic) : undefined;

    // Queue depth alarms
    const messageQueueDepthAlarm = new cloudwatch.Alarm(this, 'MessageQueueDepthAlarm', {
      alarmName: `${alarmPrefix}-messages-queue-depth`,
      metric: this.messageQueue.metricApproximateNumberOfMessagesVisible({
        period: cdk.Duration.minutes(5),
      }),
      threshold: 10,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    const responseQueueDepthAlarm = new cloudwatch.Alarm(this, 'ResponseQueueDepthAlarm', {
      alarmName: `${alarmPrefix}-responses-queue-depth`,
      metric: this.responseQueue.metricApproximateNumberOfMessagesVisible({
        period: cdk.Duration.minutes(5),
      }),
      threshold: 10,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    const mediaQueueDepthAlarm = new cloudwatch.Alarm(this, 'MediaQueueDepthAlarm', {
      alarmName: `${alarmPrefix}-media-queue-depth`,
      metric: this.mediaQueue.metricApproximateNumberOfMessagesVisible({
        period: cdk.Duration.minutes(5),
      }),
      threshold: 5,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    const postQueueDepthAlarm = new cloudwatch.Alarm(this, 'PostQueueDepthAlarm', {
      alarmName: `${alarmPrefix}-posts-queue-depth`,
      metric: this.postQueue.metricApproximateNumberOfMessagesVisible({
        period: cdk.Duration.minutes(5),
      }),
      threshold: 10,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // DLQ depth alarms (threshold: 1 message — any message in DLQ is actionable)
    const dlqDepthAlarm = new cloudwatch.Alarm(this, 'DlqDepthAlarm', {
      alarmName: `${alarmPrefix}-dlq-depth`,
      metric: this.dlq.metricApproximateNumberOfMessagesVisible({
        period: cdk.Duration.minutes(5),
      }),
      threshold: 1,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    const schedulerDlqDepthAlarm = new cloudwatch.Alarm(this, 'SchedulerDlqDepthAlarm', {
      alarmName: `${alarmPrefix}-scheduler-dlq-depth`,
      metric: this.schedulerDlq.metricApproximateNumberOfMessagesVisible({
        period: cdk.Duration.minutes(5),
      }),
      threshold: 1,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // Lambda error alarms
    const messageProcessorErrorsAlarm = new cloudwatch.Alarm(this, 'MessageProcessorErrorsAlarm', {
      alarmName: `${alarmPrefix}-message-processor-errors`,
      metric: this.messageProcessor.metricErrors({
        period: cdk.Duration.minutes(5),
      }),
      threshold: 1,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    const responseSenderErrorsAlarm = new cloudwatch.Alarm(this, 'ResponseSenderErrorsAlarm', {
      alarmName: `${alarmPrefix}-response-sender-errors`,
      metric: this.responseSender.metricErrors({
        period: cdk.Duration.minutes(5),
      }),
      threshold: 1,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    const mediaProcessorErrorsAlarm = new cloudwatch.Alarm(this, 'MediaProcessorErrorsAlarm', {
      alarmName: `${alarmPrefix}-media-processor-errors`,
      metric: this.mediaProcessor.metricErrors({
        period: cdk.Duration.minutes(5),
      }),
      threshold: 1,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    const tweetSenderErrorsAlarm = new cloudwatch.Alarm(this, 'TweetSenderErrorsAlarm', {
      alarmName: `${alarmPrefix}-tweet-sender-errors`,
      metric: this.tweetSender.metricErrors({
        period: cdk.Duration.minutes(5),
      }),
      threshold: 1,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // Wire all alarms to SNS topic for notifications
    if (snsAction) {
      for (const alarm of [
        messageQueueDepthAlarm,
        responseQueueDepthAlarm,
        mediaQueueDepthAlarm,
        postQueueDepthAlarm,
        dlqDepthAlarm,
        schedulerDlqDepthAlarm,
        messageProcessorErrorsAlarm,
        responseSenderErrorsAlarm,
        mediaProcessorErrorsAlarm,
        tweetSenderErrorsAlarm,
      ]) {
        alarm.addAlarmAction(snsAction);
      }
    }
  }
}
