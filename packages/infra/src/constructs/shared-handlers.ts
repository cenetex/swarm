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
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
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
  /**
   * Raticross relay inbound authentication key.
   * The relay will use this key to authenticate when sending messages to aws-swarm.
   * Should be stored in AWS Secrets Manager in production.
   */
  raticrossInboundKey?: string;
}

export class SharedHandlers extends Construct {
  public readonly messageQueue: sqs.Queue;
  public readonly responseQueue: sqs.Queue;
  public readonly mediaQueue: sqs.Queue;
  public readonly postQueue: sqs.Queue;
  public readonly chatWorkerQueue: sqs.Queue;
  public readonly telegramWebhook: lambda.Function;
  public readonly raticrossRelay: nodejs.NodejsFunction;
  public readonly raticrossHealth: nodejs.NodejsFunction;
  public readonly messageProcessor: nodejs.NodejsFunction;
  public readonly chatWorker: nodejs.NodejsFunction;
  public readonly responseSender: nodejs.NodejsFunction;
  public readonly mediaProcessor: nodejs.NodejsFunction;
  public readonly tweetSender: nodejs.NodejsFunction;
  public readonly platformHeartbeat: nodejs.NodejsFunction;
  public readonly dlq: sqs.Queue;
  public readonly dlqProcessor: nodejs.NodejsFunction;
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
      raticrossInboundKey,
    } = props;
    const suffix = props.nameSuffix ?? '';

    // Generate internal test key if not provided (non-production only).
    // Production MUST NOT have a test key to prevent auth bypass.
    const isProd = environment === 'prod' || environment === 'production';
    const effectiveInternalTestKey = !isProd
      ? internalTestKey || process.env.INTERNAL_TEST_KEY || `test-${Date.now()}-${Math.random().toString(36).substring(2)}`
      : '';

    // Import Replicate API key secret as a CDK resource (same pattern as admin-api)
    // This ensures the correct full ARN is used for both env vars and IAM grants.
    const replicateApiKeySecret = replicateApiKeyArn
      ? secretsmanager.Secret.fromSecretCompleteArn(this, 'ReplicateApiKey', replicateApiKeyArn)
      : undefined;

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
      // Must be > the message-processor Lambda timeout to avoid duplicate deliveries.
      // Lambda timeout is 180s; add 60s buffer to prevent re-delivery on near-timeout runs.
      visibilityTimeout: cdk.Duration.seconds(240),
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
      // Lambda timeout is 300s; add 60s buffer to prevent re-delivery on near-timeout runs.
      visibilityTimeout: cdk.Duration.seconds(360),
      deadLetterQueue: { queue: this.dlq, maxReceiveCount: 3 },
      encryption: sqs.QueueEncryption.SQS_MANAGED,
    });

    // CHAT_WORKER_QUEUE for async tool-call loop processing
    this.chatWorkerQueue = new sqs.Queue(this, 'ChatWorkerQueue', {
      queueName: `swarm-${environment}${suffix}-chat-worker.fifo`,
      fifo: true,
      contentBasedDeduplication: true,
      // Lambda timeout is 300s; add 60s buffer.
      visibilityTimeout: cdk.Duration.seconds(360),
      deadLetterQueue: { queue: this.dlq, maxReceiveCount: 3 },
      encryption: sqs.QueueEncryption.SQS_MANAGED,
    });

    // POST_QUEUE for decoupled Twitter posting with rate limit handling
    this.postQueue = new sqs.Queue(this, 'PostQueue', {
      queueName: `swarm-${environment}${suffix}-posts.fifo`,
      fifo: true,
      // No content-based deduplication - we need explicit dedup IDs for retries
      // Lambda timeout is 120s; add 60s buffer to prevent re-delivery on near-timeout runs.
      visibilityTimeout: cdk.Duration.seconds(180),
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
    this.chatWorkerQueue.grantSendMessages(lambdaRole);
    this.chatWorkerQueue.grantConsumeMessages(lambdaRole);
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
    // Scoped to keys in this account/region (not wildcard) to limit blast radius.
    // The kms:ViaService condition further restricts to Secrets Manager usage only.
    lambdaRole.addToPolicy(new iam.PolicyStatement({
      actions: ['kms:Decrypt'],
      resources: [
        `arn:aws:kms:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:key/*`,
      ],
      conditions: {
        StringEquals: {
          'kms:ViaService': `secretsmanager.${cdk.Aws.REGION}.amazonaws.com`,
        },
      },
    }));

    if (replicateApiKeySecret) {
      replicateApiKeySecret.grantRead(lambdaRole);
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
      // SQS payload offload uses the same media bucket with a distinct key prefix
      SQS_OFFLOAD_BUCKET: mediaBucket.bucketName,
      MESSAGE_QUEUE_URL: this.messageQueue.queueUrl,
      RESPONSE_QUEUE_URL: this.responseQueue.queueUrl,
      MEDIA_QUEUE_URL: this.mediaQueue.queueUrl,
      CHAT_WORKER_QUEUE_URL: this.chatWorkerQueue.queueUrl,
      POST_QUEUE_URL: this.postQueue.queueUrl,
      CDN_URL: cdnUrl || '',
      ENVIRONMENT: environment,
      LOG_LEVEL: isProd ? 'warn' : 'info',
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
      // Raticross relay inbound authentication key (for inbound and health handlers)
      // The relay will use this key to authenticate when sending messages to aws-swarm
      ...(raticrossInboundKey ? { RATICROSS_INBOUND_KEY: raticrossInboundKey } : {}),
    };

    if (replicateApiKeySecret) {
      commonEnv.REPLICATE_API_KEY_SECRET_ARN = replicateApiKeySecret.secretArn;
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
    const logRetention = isProd
      ? logs.RetentionDays.ONE_MONTH
      : logs.RetentionDays.THREE_DAYS;

    const messageProcessorLogGroup = new LogGroupWithRetention(this, 'MessageProcessorLogGroup', {
      logGroupName: `/aws/lambda/swarm-${environment}${suffix}-message-processor`,
      retention: logRetention,
      removalPolicy: logRemovalPolicy,
    });

    const telegramWebhookLogGroup = new LogGroupWithRetention(this, 'TelegramWebhookLogGroup', {
      logGroupName: `/aws/lambda/swarm-${environment}${suffix}-telegram-webhook`,
      retention: logRetention,
      removalPolicy: logRemovalPolicy,
    });

    const responseSenderLogGroup = new LogGroupWithRetention(this, 'ResponseSenderLogGroup', {
      logGroupName: `/aws/lambda/swarm-${environment}${suffix}-response-sender`,
      retention: logRetention,
      removalPolicy: logRemovalPolicy,
    });

    const mediaProcessorLogGroup = new LogGroupWithRetention(this, 'MediaProcessorLogGroup', {
      logGroupName: `/aws/lambda/swarm-${environment}${suffix}-media-processor`,
      retention: logRetention,
      removalPolicy: logRemovalPolicy,
    });

    const twitterMentionPollerLogGroup = new LogGroupWithRetention(this, 'TwitterMentionPollerLogGroup', {
      logGroupName: `/aws/lambda/swarm-${environment}${suffix}-twitter-mention-poller`,
      retention: logRetention,
      removalPolicy: logRemovalPolicy,
    });

    const autonomousTweetPosterLogGroup = new LogGroupWithRetention(this, 'AutonomousTweetPosterLogGroup', {
      logGroupName: `/aws/lambda/swarm-${environment}${suffix}-autonomous-tweet-poster`,
      retention: logRetention,
      removalPolicy: logRemovalPolicy,
    });

    const platformHeartbeatLogGroup = new LogGroupWithRetention(this, 'PlatformHeartbeatLogGroup', {
      logGroupName: `/aws/lambda/swarm-${environment}${suffix}-platform-heartbeat`,
      retention: logRetention,
      removalPolicy: logRemovalPolicy,
    });

    const tweetSenderLogGroup = new LogGroupWithRetention(this, 'TweetSenderLogGroup', {
      logGroupName: `/aws/lambda/swarm-${environment}${suffix}-tweet-sender`,
      retention: logRetention,
      removalPolicy: logRemovalPolicy,
    });

    const chatWorkerLogGroup = new LogGroupWithRetention(this, 'ChatWorkerLogGroup', {
      logGroupName: `/aws/lambda/swarm-${environment}${suffix}-chat-worker`,
      retention: logRetention,
      removalPolicy: logRemovalPolicy,
    });

    this.messageProcessor = new nodejs.NodejsFunction(this, 'MessageProcessor', {
      functionName: `swarm-${environment}${suffix}-message-processor`,
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(handlersEntry, 'messaging/message-processor.ts'),
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
      entry: path.join(handlersEntry, 'telegram/telegram-webhook-shared.ts'),
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

    // Raticross relay handler - receives inbound messages from peer systems
    const raticrossRelayLogGroup = new LogGroupWithRetention(this, 'RaticrossRelayLogGroup', {
      logGroupName: `/aws/lambda/swarm-${environment}${suffix}-raticross-relay`,
      retention: logRetention,
      removalPolicy: logRemovalPolicy,
    });

    this.raticrossRelay = new nodejs.NodejsFunction(this, 'RaticrossRelay', {
      functionName: `swarm-${environment}${suffix}-raticross-relay`,
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(handlersEntry, 'relay/raticross-inbound.ts'),
      handler: 'handler',
      layers: dependencyLayer ? [dependencyLayer] : undefined,
      role: lambdaRole,
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
      environment: commonEnv,
      bundling: bundlingOptions,
      tracing: lambda.Tracing.ACTIVE,
      logGroup: raticrossRelayLogGroup.logGroup,
    });

    // Raticross health handler - responds to health probes from the relay
    const raticrossHealthLogGroup = new LogGroupWithRetention(this, 'RaticrossHealthLogGroup', {
      logGroupName: `/aws/lambda/swarm-${environment}${suffix}-raticross-health`,
      retention: logRetention,
      removalPolicy: logRemovalPolicy,
    });

    this.raticrossHealth = new nodejs.NodejsFunction(this, 'RaticrossHealth', {
      functionName: `swarm-${environment}${suffix}-raticross-health`,
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(handlersEntry, 'relay/raticross-health.ts'),
      handler: 'handler',
      layers: dependencyLayer ? [dependencyLayer] : undefined,
      role: lambdaRole,
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
      environment: commonEnv,
      bundling: bundlingOptions,
      tracing: lambda.Tracing.ACTIVE,
      logGroup: raticrossHealthLogGroup.logGroup,
    });

    this.messageProcessor.addEventSource(new lambdaEventSources.SqsEventSource(this.messageQueue, {
      batchSize: 10,
      reportBatchItemFailures: true,
    }));

    this.chatWorker = new nodejs.NodejsFunction(this, 'ChatWorker', {
      functionName: `swarm-${environment}${suffix}-chat-worker`,
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(handlersEntry, 'messaging/chat-worker.ts'),
      handler: 'handler',
      layers: dependencyLayer ? [dependencyLayer] : undefined,
      role: lambdaRole,
      timeout: cdk.Duration.seconds(300),
      memorySize: 1024,
      reservedConcurrentExecutions: 20,
      environment: commonEnv,
      bundling: bundlingOptions,
      tracing: lambda.Tracing.ACTIVE,
      logGroup: chatWorkerLogGroup.logGroup,
    });

    this.chatWorker.addEventSource(new lambdaEventSources.SqsEventSource(this.chatWorkerQueue, {
      batchSize: 1,
      reportBatchItemFailures: true,
    }));

    this.responseSender = new nodejs.NodejsFunction(this, 'ResponseSender', {
      functionName: `swarm-${environment}${suffix}-response-sender`,
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(handlersEntry, 'messaging/response-sender.ts'),
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
      entry: path.join(handlersEntry, 'media/media-processor.ts'),
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
      entry: path.join(handlersEntry, 'twitter/twitter-mention-poller-shared.ts'),
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

    const twitterMentionPollRule = new events.Rule(this, 'TwitterMentionPollSchedule', {
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
      entry: path.join(handlersEntry, 'twitter/autonomous-tweet-poster.ts'),
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

    const autonomousTweetRule = new events.Rule(this, 'AutonomousTweetSchedule', {
      schedule: events.Schedule.rate(cdk.Duration.hours(1)),
      targets: [new targets.LambdaFunction(autonomousTweetPoster, {
        deadLetterQueue: this.schedulerDlq,
        retryAttempts: 2,
        maxEventAge: cdk.Duration.hours(2),
      })],
    });

    // Platform Heartbeat - runs every 15 minutes, manages per-avatar per-platform timing internally
    // Each avatar gets platform-specific feed checks and optional engagement via adapters
    this.platformHeartbeat = new nodejs.NodejsFunction(this, 'PlatformHeartbeat', {
      functionName: `swarm-${environment}${suffix}-platform-heartbeat`,
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(handlersEntry, 'social/platform-heartbeat.ts'),
      handler: 'handler',
      layers: dependencyLayer ? [dependencyLayer] : undefined,
      role: lambdaRole,
      timeout: cdk.Duration.minutes(5), // Longer timeout for multi-avatar, multi-platform processing
      memorySize: 1024,
      environment: commonEnv,
      bundling: bundlingOptions,
      tracing: lambda.Tracing.ACTIVE,
      logGroup: platformHeartbeatLogGroup.logGroup,
    });

    const platformHeartbeatRule = new events.Rule(this, 'PlatformHeartbeatSchedule', {
      schedule: events.Schedule.rate(cdk.Duration.minutes(15)),
      targets: [new targets.LambdaFunction(this.platformHeartbeat, {
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
      entry: path.join(handlersEntry, 'twitter/tweet-sender.ts'),
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


    // DLQ Processor - inspects, categorizes, and optionally redrives failed messages
    // Runs every 15 minutes to batch-process DLQ entries
    this.dlqProcessor = new nodejs.NodejsFunction(this, 'DlqProcessor', {
      functionName: `swarm-${environment}${suffix}-dlq-processor`,
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(handlersEntry, 'dlq-processor.ts'),
      handler: 'handler',
      layers: dependencyLayer ? [dependencyLayer] : undefined,
      role: lambdaRole,
      timeout: cdk.Duration.minutes(2),
      memorySize: 256,
      environment: {
        ...commonEnv,
        DLQ_URL: this.dlq.queueUrl,
        DLQ_REDRIVE_ENABLED: 'true', // Auto-redrive transient failures (see #643)
      },
      bundling: bundlingOptions,
      tracing: lambda.Tracing.ACTIVE,
      logRetention: logRetention,
    });

    // Grant DLQ processor permissions to read/delete from DLQ
    this.dlq.grantConsumeMessages(lambdaRole);
    this.dlq.grantSendMessages(lambdaRole);

    // Grant CloudWatch PutMetricData for DLQ processing metrics
    lambdaRole.addToPolicy(new iam.PolicyStatement({
      actions: ['cloudwatch:PutMetricData'],
      resources: ['*'],
      conditions: {
        StringEquals: {
          'cloudwatch:namespace': `Swarm/${environment}`,
        },
      },
    }));

    const dlqProcessorRule = new events.Rule(this, 'DlqProcessorSchedule', {
      schedule: events.Schedule.rate(cdk.Duration.minutes(15)),
      targets: [new targets.LambdaFunction(this.dlqProcessor, {
        deadLetterQueue: this.schedulerDlq,
        retryAttempts: 1,
        maxEventAge: cdk.Duration.hours(1),
      })],
    });

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

    // DLQ depth alarms (threshold: >0 messages — any message in DLQ is actionable)
    // 1-minute evaluation period for fastest possible detection.
    // See RUNBOOK.md Section 3 "SQS DLQ Recovery" for triage steps.
    const dlqDepthAlarm = new cloudwatch.Alarm(this, 'DlqDepthAlarm', {
      alarmName: `${alarmPrefix}-dlq-depth`,
      alarmDescription:
        'Messages detected in the shared FIFO DLQ. At least one webhook, message-processor, ' +
        'response-sender, or media-processor message has exhausted retries. ' +
        'Runbook: docs/RUNBOOK.md § 3 "SQS DLQ Recovery" — inspect, correlate, and redrive.',
      metric: this.dlq.metricApproximateNumberOfMessagesVisible({
        period: cdk.Duration.minutes(1),
      }),
      threshold: 0,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    const schedulerDlqDepthAlarm = new cloudwatch.Alarm(this, 'SchedulerDlqDepthAlarm', {
      alarmName: `${alarmPrefix}-scheduler-dlq-depth`,
      alarmDescription:
        'Messages detected in the scheduler DLQ. Scheduled events (Twitter poller, autonomous tweets, ' +
        'platform heartbeats, DLQ processor) are failing. ' +
        'Runbook: docs/RUNBOOK.md § 3 "SQS DLQ Recovery" — inspect, correlate, and redrive.',
      metric: this.schedulerDlq.metricApproximateNumberOfMessagesVisible({
        period: cdk.Duration.minutes(1),
      }),
      threshold: 0,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
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

    const dlqProcessorErrorsAlarm = new cloudwatch.Alarm(this, 'DlqProcessorErrorsAlarm', {
      alarmName: `${alarmPrefix}-dlq-processor-errors`,
      metric: this.dlqProcessor.metricErrors({
        period: cdk.Duration.minutes(15),
      }),
      threshold: 1,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // -----------------------------------------------------------------------
    // Lambda throttle alarms
    // Any throttle indicates concurrency exhaustion — alert immediately.
    // Shared handlers have reservedConcurrentExecutions caps, so throttles
    // mean the cap is too low or a traffic spike exceeded it.
    // -----------------------------------------------------------------------
    const messageProcessorThrottlesAlarm = new cloudwatch.Alarm(this, 'MessageProcessorThrottlesAlarm', {
      alarmName: `${alarmPrefix}-message-processor-throttles`,
      alarmDescription: 'Message processor Lambda is being throttled — reserved concurrency may be exhausted.',
      metric: this.messageProcessor.metricThrottles({
        period: cdk.Duration.minutes(5),
      }),
      threshold: 0,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    const responseSenderThrottlesAlarm = new cloudwatch.Alarm(this, 'ResponseSenderThrottlesAlarm', {
      alarmName: `${alarmPrefix}-response-sender-throttles`,
      alarmDescription: 'Response sender Lambda is being throttled — reserved concurrency may be exhausted.',
      metric: this.responseSender.metricThrottles({
        period: cdk.Duration.minutes(5),
      }),
      threshold: 0,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    const mediaProcessorThrottlesAlarm = new cloudwatch.Alarm(this, 'MediaProcessorThrottlesAlarm', {
      alarmName: `${alarmPrefix}-media-processor-throttles`,
      alarmDescription: 'Media processor Lambda is being throttled — reserved concurrency may be exhausted.',
      metric: this.mediaProcessor.metricThrottles({
        period: cdk.Duration.minutes(5),
      }),
      threshold: 0,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    const tweetSenderThrottlesAlarm = new cloudwatch.Alarm(this, 'TweetSenderThrottlesAlarm', {
      alarmName: `${alarmPrefix}-tweet-sender-throttles`,
      alarmDescription: 'Tweet sender Lambda is being throttled — reserved concurrency may be exhausted.',
      metric: this.tweetSender.metricThrottles({
        period: cdk.Duration.minutes(5),
      }),
      threshold: 0,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // -----------------------------------------------------------------------
    // Lambda p95 duration alarms
    // Thresholds are environment-aware:
    //   - Production: 30s for message processor (timeout 180s → 17% headroom),
    //     15s for response sender (timeout 60s → 25% headroom)
    //   - Staging: 2x production thresholds to reduce noise during development
    // p95 is used instead of p99 to catch sustained latency increases while
    // tolerating occasional slow outliers from cold starts.
    // -----------------------------------------------------------------------
    const durationThresholds = isProd
      ? { messageProcessor: 30_000, responseSender: 15_000, mediaProcessor: 120_000, tweetSender: 30_000 }
      : { messageProcessor: 60_000, responseSender: 30_000, mediaProcessor: 240_000, tweetSender: 60_000 };

    const messageProcessorDurationAlarm = new cloudwatch.Alarm(this, 'MessageProcessorDurationAlarm', {
      alarmName: `${alarmPrefix}-message-processor-duration-p95`,
      alarmDescription:
        `Message processor p95 latency > ${durationThresholds.messageProcessor / 1000}s ` +
        `(timeout 180s). Investigate LLM call latency or cold-start frequency.`,
      metric: this.messageProcessor.metricDuration({
        period: cdk.Duration.minutes(5),
        statistic: 'p95',
      }),
      threshold: durationThresholds.messageProcessor,
      evaluationPeriods: 3,
      datapointsToAlarm: 2,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    const responseSenderDurationAlarm = new cloudwatch.Alarm(this, 'ResponseSenderDurationAlarm', {
      alarmName: `${alarmPrefix}-response-sender-duration-p95`,
      alarmDescription:
        `Response sender p95 latency > ${durationThresholds.responseSender / 1000}s ` +
        `(timeout 60s). Check platform API latency (Telegram, Twitter).`,
      metric: this.responseSender.metricDuration({
        period: cdk.Duration.minutes(5),
        statistic: 'p95',
      }),
      threshold: durationThresholds.responseSender,
      evaluationPeriods: 3,
      datapointsToAlarm: 2,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    const mediaProcessorDurationAlarm = new cloudwatch.Alarm(this, 'MediaProcessorDurationAlarm', {
      alarmName: `${alarmPrefix}-media-processor-duration-p95`,
      alarmDescription:
        `Media processor p95 latency > ${durationThresholds.mediaProcessor / 1000}s ` +
        `(timeout 300s). Investigate Replicate API or image processing bottlenecks.`,
      metric: this.mediaProcessor.metricDuration({
        period: cdk.Duration.minutes(5),
        statistic: 'p95',
      }),
      threshold: durationThresholds.mediaProcessor,
      evaluationPeriods: 3,
      datapointsToAlarm: 2,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    const tweetSenderDurationAlarm = new cloudwatch.Alarm(this, 'TweetSenderDurationAlarm', {
      alarmName: `${alarmPrefix}-tweet-sender-duration-p95`,
      alarmDescription:
        `Tweet sender p95 latency > ${durationThresholds.tweetSender / 1000}s ` +
        `(timeout 120s). Check Twitter API rate limits or backoff behavior.`,
      metric: this.tweetSender.metricDuration({
        period: cdk.Duration.minutes(5),
        statistic: 'p95',
      }),
      threshold: durationThresholds.tweetSender,
      evaluationPeriods: 3,
      datapointsToAlarm: 2,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // -----------------------------------------------------------------------
    // SQS age-of-oldest-message alarms
    // Tracks how long the oldest message has been waiting in the queue.
    // A growing age indicates consumers are falling behind or stalled.
    // Thresholds:
    //   - Production: 300s (5 min) — tight; stale messages degrade user experience
    //   - Staging: 600s (10 min) — relaxed to reduce noise
    // -----------------------------------------------------------------------
    const queueAgeThreshold = isProd ? 300 : 600;

    const messageQueueAgeAlarm = new cloudwatch.Alarm(this, 'MessageQueueAgeAlarm', {
      alarmName: `${alarmPrefix}-messages-queue-age`,
      alarmDescription:
        `Oldest message in message queue > ${queueAgeThreshold}s. ` +
        'Consumer may be stalled or concurrency exhausted.',
      metric: this.messageQueue.metricApproximateAgeOfOldestMessage({
        period: cdk.Duration.minutes(5),
      }),
      threshold: queueAgeThreshold,
      evaluationPeriods: 2,
      datapointsToAlarm: 2,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    const responseQueueAgeAlarm = new cloudwatch.Alarm(this, 'ResponseQueueAgeAlarm', {
      alarmName: `${alarmPrefix}-responses-queue-age`,
      alarmDescription:
        `Oldest message in response queue > ${queueAgeThreshold}s. ` +
        'Consumer may be stalled or concurrency exhausted.',
      metric: this.responseQueue.metricApproximateAgeOfOldestMessage({
        period: cdk.Duration.minutes(5),
      }),
      threshold: queueAgeThreshold,
      evaluationPeriods: 2,
      datapointsToAlarm: 2,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    const mediaQueueAgeAlarm = new cloudwatch.Alarm(this, 'MediaQueueAgeAlarm', {
      alarmName: `${alarmPrefix}-media-queue-age`,
      alarmDescription:
        `Oldest message in media queue > ${queueAgeThreshold}s. ` +
        'Consumer may be stalled or concurrency exhausted.',
      metric: this.mediaQueue.metricApproximateAgeOfOldestMessage({
        period: cdk.Duration.minutes(5),
      }),
      threshold: queueAgeThreshold,
      evaluationPeriods: 2,
      datapointsToAlarm: 2,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    const postQueueAgeAlarm = new cloudwatch.Alarm(this, 'PostQueueAgeAlarm', {
      alarmName: `${alarmPrefix}-posts-queue-age`,
      alarmDescription:
        `Oldest message in post queue > ${queueAgeThreshold}s. ` +
        'Consumer may be stalled or concurrency exhausted.',
      metric: this.postQueue.metricApproximateAgeOfOldestMessage({
        period: cdk.Duration.minutes(5),
      }),
      threshold: queueAgeThreshold,
      evaluationPeriods: 2,
      datapointsToAlarm: 2,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // Scheduler aged-out event alarm
    // When maxEventAge expires, EventBridge increments FailedInvocations on the rule.
    // A combined alarm across all four scheduler rules catches silently dropped events
    // (Twitter poller, autonomous tweets, platform heartbeats, DLQ processor).
    const schedulerFailedInvocationsAlarm = new cloudwatch.Alarm(this, 'SchedulerFailedInvocationsAlarm', {
      alarmName: `${alarmPrefix}-scheduler-failed-invocations`,
      metric: new cloudwatch.MathExpression({
        expression: 'twitter + tweets + heartbeat + dlqProc',
        usingMetrics: {
          twitter: new cloudwatch.Metric({
            namespace: 'AWS/Events',
            metricName: 'FailedInvocations',
            dimensionsMap: { RuleName: twitterMentionPollRule.ruleName },
            period: cdk.Duration.minutes(15),
            statistic: 'Sum',
          }),
          tweets: new cloudwatch.Metric({
            namespace: 'AWS/Events',
            metricName: 'FailedInvocations',
            dimensionsMap: { RuleName: autonomousTweetRule.ruleName },
            period: cdk.Duration.minutes(15),
            statistic: 'Sum',
          }),
          heartbeat: new cloudwatch.Metric({
            namespace: 'AWS/Events',
            metricName: 'FailedInvocations',
            dimensionsMap: { RuleName: platformHeartbeatRule.ruleName },
            period: cdk.Duration.minutes(15),
            statistic: 'Sum',
          }),
          dlqProc: new cloudwatch.Metric({
            namespace: 'AWS/Events',
            metricName: 'FailedInvocations',
            dimensionsMap: { RuleName: dlqProcessorRule.ruleName },
            period: cdk.Duration.minutes(15),
            statistic: 'Sum',
          }),
        },
        period: cdk.Duration.minutes(15),
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
        dlqProcessorErrorsAlarm,
        messageProcessorThrottlesAlarm,
        responseSenderThrottlesAlarm,
        mediaProcessorThrottlesAlarm,
        tweetSenderThrottlesAlarm,
        messageProcessorDurationAlarm,
        responseSenderDurationAlarm,
        mediaProcessorDurationAlarm,
        tweetSenderDurationAlarm,
        messageQueueAgeAlarm,
        responseQueueAgeAlarm,
        mediaQueueAgeAlarm,
        postQueueAgeAlarm,
        schedulerFailedInvocationsAlarm,
      ]) {
        alarm.addAlarmAction(snsAction);
      }
    }
  }
}
