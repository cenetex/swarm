/**
 * CDK Construct for Admin API Infrastructure
 */
import { Construct } from 'constructs';
import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as apigateway from 'aws-cdk-lib/aws-apigatewayv2';
import * as integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as path from 'path';
import { fileURLToPath } from 'url';

// ESM equivalent of __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cw_actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';

export interface AdminApiConstructProps {
  /**
   * Comma-separated list of admin emails
   */
  adminEmails: string;

  /**
   * Comma-separated list of admin wallet addresses (Solana public keys)
   * These wallets can see all avatars regardless of creator
   */
  adminWallets?: string;

  /**
   * Global OpenRouter API key (stored in Secrets Manager)
   */
  openRouterApiKeyArn?: string;

  /**
   * Global Replicate API key (stored in Secrets Manager)
   * Used for image/video generation with a trial limit per avatar
   */
  replicateApiKeyArn?: string;

  /**
   * Secret used to authenticate Replicate webhook callbacks.
   * If omitted, a random value is generated at synth/deploy time.
   */
  replicateWebhookSecret?: string;

  /**
   * Helius API key for Solana RPC (NFT queries, etc.)
   * Required for NFT-gated access
   */
  heliusApiKey?: string;

  /**
   * Helius API key secret ARN (preferred over inline value)
   */
  heliusApiKeyArn?: string;

  /**
   * Web search API key (for property research)
   */
  webSearchApiKeyArn?: string;

  /**
   * Web search provider (default: serpapi)
   */
  webSearchProvider?: string;

  /**
   * Privy App ID (non-secret)
   */
  privyAppId?: string;

  /**
   * Privy App Secret ARN (required to fetch Privy users server-side)
   */
  privyAppSecretArn?: string;

  /**
   * Privy JWT verification key ARN (required to verify Privy access tokens)
   */
  privyJwtVerificationKeyArn?: string;

  /**
   * Stripe secret key ARN (required for Checkout/Portal API calls)
   */
  stripeSecretKeyArn?: string;

  /**
   * Stripe webhook secret ARN (required to verify Stripe signatures)
   */
  stripeWebhookSecretArn?: string;

  /**
   * Stripe price ID for Pro monthly plan.
   */
  stripePriceIdPro?: string;

  /**
   * Stripe price ID for Enterprise monthly plan.
   */
  stripePriceIdEnterprise?: string;

  /**
   * Stripe price ID for Team monthly plan.
   */
  stripePriceIdTeam?: string;

  /**
   * Environment (development/production)
   */
  environment?: string;
  /**
   * Secrets Manager prefix (e.g., "swarm" or "swarm-abcdef")
   */
  secretPrefix?: string;
  /**
   * Optional suffix for resource names/exports (e.g., "-a1b2c3")
   */
  nameSuffix?: string;

  /**
   * Admin UI domain for CORS (e.g., 'admin.example.com')
   */
  adminDomain?: string;

  /**
   * Custom domain for the API (e.g., 'api.example.com')
   */
  apiDomain?: string;

  /**
   * Domain used specifically for Telegram webhooks (host only, no scheme).
   * Useful when the main apiDomain is protected by upstream auth/WAF rules
   * that Telegram cannot satisfy.
   *
   * Example: "hs38po7mq0.execute-api.us-east-1.amazonaws.com"
   */
  telegramWebhookDomain?: string;

  /**
   * ACM certificate ARN for the API custom domain
   */
  apiCertificateArn?: string;

  /**
   * Shared state table for syncing avatar configs to handlers
   */
  stateTable?: dynamodb.ITable;

  /**
   * Media bucket for storing generated images/videos
   */
  mediaBucket?: s3.IBucket;

  /**
   * CDN distribution for media
   */
  mediaCdn?: cloudfront.IDistribution;

  /**
   * CDN URL for media (e.g., 'https://gallery.rati.chat')
   * If provided, this takes precedence over mediaCdn.distributionDomainName
   */
  cdnUrl?: string;

  /**
   * Lambda layer with shared dependencies (including sharp for image processing)
   */
  dependencyLayer?: lambda.ILayerVersion;

  /**
   * Telegram webhook Lambda from @swarm/handlers SharedHandlers construct.
   */
  telegramWebhookFunction: lambda.IFunction;

  /**
   * Raticross relay Lambda from @swarm/handlers SharedHandlers construct.
   */
  raticrossRelayFunction?: lambda.IFunction;

  /**
   * Internal test key for bypassing auth in E2E tests.
   * Should be shared across all constructs in the stack.
   */
  internalTestKey?: string;

  /**
   * POST_QUEUE for decoupled Twitter posting.
   * When provided, approved posts will be enqueued for the tweet-sender to process.
   */
  postQueue?: sqs.IQueue;

  /**
   * Shared handlers queues surfaced in /system/status queue health.
   */
  sharedMessageQueue?: sqs.IQueue;
  sharedResponseQueue?: sqs.IQueue;
  sharedMediaQueue?: sqs.IQueue;
  sharedDlq?: sqs.IQueue;
  sharedSchedulerDlq?: sqs.IQueue;

  /**
   * SNS topic for CloudWatch alarm notifications.
   * When provided, all alarms in this construct will send notifications to this topic.
   */
  alarmTopic?: sns.ITopic;

  /**
   * When true, import the AdminTable by name instead of creating it.
   * Use when the table is still owned by the legacy monolith stack.
   */
  useExistingResources?: boolean;

  /**
   * Whether the Discord gateway worker (ECS Fargate) is deployed.
   * Passed as DISCORD_GATEWAY_ENABLED env var to Lambda so the admin API
   * can accurately report runtime health for bot/hybrid mode avatars.
   */
  enableDiscordGateway?: boolean;

  /**
   * Secrets Manager ARN for a GitHub Personal Access Token (PAT).
   * When provided, enables the DynamoDB Streams-based issue sync Lambda
   * that automatically creates GitHub issues from new ISSUE# records.
   */
  githubTokenSecretArn?: string;

  /**
   * GitHub repository (owner/name) for issue sync (e.g., "cenetex/aws-swarm").
   * @default "cenetex/aws-swarm"
   */
  githubRepo?: string;
}

export class AdminApiConstruct extends Construct {
  public readonly api: apigateway.HttpApi;
  public readonly apiEndpoint: string;
  public readonly customDomain?: apigateway.DomainName;
  public readonly table: dynamodb.ITable;
  public readonly chatHandler: lambda.Function;
  public readonly mediaConvertHandler?: lambda.Function;
  // Exposed for the ops dashboard
  public readonly chatWorkerHandler: lambda.Function;
  public readonly responseSenderHandler: lambda.Function;
  public readonly dreamWorker: lambda.Function;
  public readonly openaiCompatHandler: lambda.Function;
  public readonly responseDlq: sqs.Queue;
  public readonly chatDlq: sqs.Queue;
  public readonly dreamDlq: sqs.Queue;
  public readonly consolidationDlq: sqs.Queue;
  public readonly consolidationWorker: lambda.Function;
  // Exposed for ops dashboard queue-age metrics
  public readonly responseQueue: sqs.Queue;
  public readonly chatQueue: sqs.Queue;
  public readonly dreamQueue: sqs.Queue;

  constructor(scope: Construct, id: string, props: AdminApiConstructProps) {
    super(scope, id);

    const {
      adminEmails,
      environment = 'development',
      adminDomain,
      webSearchProvider,
      stateTable,
      mediaBucket,
      mediaCdn,
      cdnUrl: propsCdnUrl,
      dependencyLayer,
    } = props;
    const suffix = props.nameSuffix ?? '';
    const secretPrefix = props.secretPrefix ?? 'swarm';

    const isProd = environment === 'prod' || environment === 'production';
    const isPersistentEnv = isProd || environment === 'staging';

    // -----------------------------------------------------------------------
    // Synth-time config validation
    // Fail fast during `cdk synth` when required props are missing or invalid,
    // rather than discovering the problem after deploy via request-time errors.
    // -----------------------------------------------------------------------
    if (!adminEmails || adminEmails.trim().length === 0) {
      throw new Error(
        '[AdminApiConstruct] adminEmails is required but was empty. ' +
        'Set it in cdk.context.json or pass it as a construct prop.',
      );
    }

    if (isPersistentEnv && !props.openRouterApiKeyArn) {
      throw new Error(
        `[AdminApiConstruct] openRouterApiKeyArn is required for ${environment} environments. ` +
        'The LLM subsystem cannot function without an API key.',
      );
    }

    if (propsCdnUrl) {
      try {
        new URL(propsCdnUrl);
      } catch {
        throw new Error(
          `[AdminApiConstruct] cdnUrl "${propsCdnUrl}" is not a valid URL. ` +
          'Media delivery will fail at runtime.',
        );
      }
    }
    const logLevel = isProd ? 'warn' : 'info';
    const logRetention = isProd
      ? logs.RetentionDays.TWO_WEEKS
      : logs.RetentionDays.THREE_DAYS;

    // In production, cap non-Orb authenticated access to the top N most recent logins.
    // Orb holders bypass this limit (enforced in the admin-api auth layer).
    const activeUserLimitEnvVars: Record<string, string> = isProd ? { SWARM_ACTIVE_USER_LIMIT: '12' } : {};

    // Use provided CDN URL or fall back to distribution domain
    const cdnUrl = propsCdnUrl || (mediaCdn ? `https://${mediaCdn.distributionDomainName}` : undefined);

    // Build CORS allowed origins
    const allowedOrigins = adminDomain 
      ? [`https://${adminDomain}`]
      : ['http://localhost:5173', 'http://localhost:3000'];

    const secretPrefixSet = new Set([secretPrefix, 'swarm']);
    const secretNamePatterns = Array.from(secretPrefixSet).map(prefix => `${prefix}/*`);
    const secretArnPatterns = Array.from(secretPrefixSet).map(prefix =>
      `arn:aws:secretsmanager:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:secret:${prefix}/*`
    );

    // NOTE: ApiGatewayV2 CORS allowOrigins does not support wildcard origins.
    // Bot subdomains are expected to use the same-origin CloudFront `/api/*` proxy,
    // so we do not need to enumerate each subdomain here.

    // Secrets Manager uses AWS-managed KMS key by default (alias/aws/secretsmanager).
    // We intentionally do not provision a customer-managed key to avoid the monthly CMK charge.

    // DynamoDB table for admin data
    if (props.useExistingResources) {
      // Import from legacy monolith — the AdminTable has no resource suffix
      // because it is a shared resource owned by the old SwarmStack.
      this.table = dynamodb.Table.fromTableName(
        this, 'AdminTable', `SwarmAdmin-${environment}`,
      );
    } else {
      const adminTable = new dynamodb.Table(this, 'AdminTable', {
        tableName: `SwarmAdmin-${environment}${suffix}`,
        partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
        sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
        billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
        // Staging contains real state we often want to preserve while iterating on infra.
        // This also enables safe cleanup of legacy stacks without data loss.
        removalPolicy: isPersistentEnv
          ? cdk.RemovalPolicy.RETAIN
          : cdk.RemovalPolicy.DESTROY,
        // Deletion protection prevents accidental deletion during rollbacks
        deletionProtection: isPersistentEnv,
        pointInTimeRecoverySpecification: {
          pointInTimeRecoveryEnabled: isPersistentEnv,
        },
        timeToLiveAttribute: 'ttl',
        // Enable DynamoDB Streams for event-driven GitHub issue sync.
        // NEW_IMAGE provides the full item after insert, which is all we need
        // to create the GitHub issue without a separate GetItem call.
        stream: dynamodb.StreamViewType.NEW_IMAGE,
      });

      // GSI1 for inverted lookups (sk → pk)
      // Used for:
      // - Finding avatar by inhabitant: sk=INHABITANT#<wallet> returns pk=AVATAR#<avatarId>
      // - Listing items by type: sk=CONFIG returns all avatars
      adminTable.addGlobalSecondaryIndex({
        indexName: 'GSI1',
        partitionKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
        sortKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      });

      // Sparse GSI for Stripe subscription lookups.
      // Only entitlement items with stripeSubscriptionId are projected,
      // replacing the O(table-size) Scan in findEntitlementByStripeSubscriptionId.
      adminTable.addGlobalSecondaryIndex({
        indexName: 'StripeSubscriptionIndex',
        partitionKey: { name: 'stripeSubscriptionId', type: dynamodb.AttributeType.STRING },
        projectionType: dynamodb.ProjectionType.ALL,
      });

      this.table = adminTable;
    }


      // Note: Media jobs are queried using Scan with filter (no GSI needed)
    // Jobs have TTL so the scan is bounded by recent jobs only

    // External provider ID lookups use a mapping item (no extra GSI).

    // Response queue for async media generation callbacks
    // When Replicate finishes generating an image/video, it calls our webhook
    // which puts a message in this queue. The response sender Lambda then
    // delivers the media to Telegram.
    this.responseDlq = new sqs.Queue(this, 'ResponseDLQ', {
      queueName: `swarm-response-dlq-${environment}${suffix}`,
      retentionPeriod: cdk.Duration.days(14),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
    });

    const responseQueue = new sqs.Queue(this, 'ResponseQueue', {
      queueName: `swarm-response-queue-${environment}${suffix}`,
      visibilityTimeout: cdk.Duration.seconds(120), // Match Lambda timeout
      retentionPeriod: cdk.Duration.days(1),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      deadLetterQueue: {
        queue: this.responseDlq,
        maxReceiveCount: 3,
      },
    });

    // Chat queue for async /chat jobs (admin UI polling)
    this.chatDlq = new sqs.Queue(this, 'ChatDLQ', {
      queueName: `swarm-chat-dlq-${environment}${suffix}`,
      retentionPeriod: cdk.Duration.days(14),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
    });

    const chatQueue = new sqs.Queue(this, 'ChatQueue', {
      queueName: `swarm-chat-queue-${environment}${suffix}`,
      visibilityTimeout: cdk.Duration.seconds(600),
      retentionPeriod: cdk.Duration.days(1),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      deadLetterQueue: {
        queue: this.chatDlq,
        maxReceiveCount: 3,
      },
    });

    // Dreams queue (FIFO) for async dream generation jobs
    this.dreamDlq = new sqs.Queue(this, 'DreamDLQ', {
      queueName: `swarm-dream-dlq-${environment}${suffix}.fifo`,
      fifo: true,
      retentionPeriod: cdk.Duration.days(14),
    });

    const dreamQueue = new sqs.Queue(this, 'DreamQueue', {
      queueName: `swarm-dream-queue-${environment}${suffix}.fifo`,
      fifo: true,
      // We provide explicit MessageDeduplicationId (jobId)
      contentBasedDeduplication: false,
      // Allow enough time for LLM + Dynamo + memory resonance work
      visibilityTimeout: cdk.Duration.minutes(5),
      retentionPeriod: cdk.Duration.days(1),
      deadLetterQueue: {
        queue: this.dreamDlq,
        maxReceiveCount: 3,
      },
    });

    // Expose queues for ops dashboard age-of-oldest-message metrics
    this.responseQueue = responseQueue;
    this.chatQueue = chatQueue;
    this.dreamQueue = dreamQueue;

    this.consolidationDlq = new sqs.Queue(this, 'ConsolidationScheduleDLQ', {
      retentionPeriod: cdk.Duration.days(14),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
    });

    // Secret for OpenRouter API key
    const llmApiKey = props.openRouterApiKeyArn
      ? secretsmanager.Secret.fromSecretCompleteArn(this, 'LLMApiKey', props.openRouterApiKeyArn)
      : new secretsmanager.Secret(this, 'LLMApiKey', {
          secretName: `${secretPrefix}/admin/llm-api-key`,
          description: 'API key for the admin chatbot LLM',
        });

    // Secret for Replicate API key (optional - enables free trial image generation)
    const replicateApiKey = props.replicateApiKeyArn
      ? secretsmanager.Secret.fromSecretCompleteArn(this, 'ReplicateApiKey', props.replicateApiKeyArn)
      : undefined;

    // Secret for Helius API key (optional, preferred over inline value)
    const heliusApiKeySecret = props.heliusApiKeyArn
      ? secretsmanager.Secret.fromSecretCompleteArn(this, 'HeliusApiKey', props.heliusApiKeyArn)
      : undefined;

    const webSearchApiKey = props.webSearchApiKeyArn
      ? secretsmanager.Secret.fromSecretCompleteArn(this, 'WebSearchApiKey', props.webSearchApiKeyArn)
      : undefined;

    // Secrets for Privy (optional - required if Privy auth endpoints are enabled)
    const privyAppSecret = props.privyAppSecretArn
      ? secretsmanager.Secret.fromSecretCompleteArn(this, 'PrivyAppSecret', props.privyAppSecretArn)
      : undefined;

    const privyJwtVerificationKey = props.privyJwtVerificationKeyArn
      ? secretsmanager.Secret.fromSecretCompleteArn(this, 'PrivyJwtVerificationKey', props.privyJwtVerificationKeyArn)
      : undefined;

    // Secrets for Stripe billing (optional - required for self-serve subscriptions)
    const stripeSecretKey = props.stripeSecretKeyArn
      ? secretsmanager.Secret.fromSecretCompleteArn(this, 'StripeSecretKey', props.stripeSecretKeyArn)
      : undefined;

    const stripeWebhookSecret = props.stripeWebhookSecretArn
      ? secretsmanager.Secret.fromSecretCompleteArn(this, 'StripeWebhookSecret', props.stripeWebhookSecretArn)
      : undefined;

    // Twitter App credentials for OAuth flow (needed by both Chat and Twitter OAuth handlers)
    const twitterAppCredentialsSecret = secretsmanager.Secret.fromSecretNameV2(
      this, 'TwitterAppCredentials', 'swarm/global/twitter-app-credentials'
    );
    // When `apiCertificateArn` is not set, the API is served via the Admin UI CloudFront
    // distribution under the `/api/*` path (see SwarmStack wiring). In that case, OAuth
    // callbacks must include the `/api` prefix so the callback reaches the Lambda.
    const twitterOAuthCallbackUrl = props.apiDomain
      ? `https://${props.apiDomain}${props.apiCertificateArn ? '' : '/api'}/oauth/twitter/callback`
      : '';

    // Build webhook URL for Replicate callbacks
    // Note: We'll use the raw API Gateway URL (not custom domain) since Replicate
    // webhooks need to bypass upstream auth layers. The actual URL is set after API creation.
    let replicateWebhookUrl = ''; // Will be updated after API is created
    const replicateWebhookSecret =
      props.replicateWebhookSecret
      || process.env.REPLICATE_WEBHOOK_SECRET
      || `replicate-${Date.now()}-${Math.random().toString(36).substring(2)}`;

    // Internal test key for direct API testing (only in non-production)
    // Use passed key if provided, otherwise generate a random key
    const internalTestKey = !isProd
      ? props.internalTestKey || process.env.INTERNAL_TEST_KEY || `test-${Date.now()}-${Math.random().toString(36).substring(2)}`
      : '';

    // Lambda function for chat handler
    this.chatHandler = new nodejs.NodejsFunction(this, 'ChatHandler', {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, '../../../admin-api/src/handlers/chat.ts'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(180), // Increased for image generation with Nano Banana Pro
      memorySize: 1024, // Increased for image processing
      // Use dependency layer for sharp (pre-built with linux binaries)
      layers: dependencyLayer ? [dependencyLayer] : undefined,
      environment: {
        ADMIN_TABLE: this.table.tableName,
        STATE_TABLE: stateTable?.tableName || '',
        DREAM_QUEUE_URL: dreamQueue.queueUrl,
        DREAMS_ENABLED: isProd ? 'false' : 'true',
        SECRET_PREFIX: secretPrefix,
        ADMIN_EMAILS: adminEmails,
        LLM_ENDPOINT: 'https://openrouter.ai/api/v1/chat/completions',
        LLM_MODEL: 'anthropic/claude-haiku-4.5',
        // Keep /chat under API Gateway/CloudFront response time limits.
        // These can be overridden per-environment via Lambda env vars if needed.
        LLM_TIMEOUT_MS: '27000',
        LLM_MAX_RETRIES: '0',
        LLM_MAX_STEPS: '4',
        LLM_API_KEY_SECRET_ARN: llmApiKey.secretArn,
        WEB_SEARCH_PROVIDER: webSearchProvider || 'serpapi',
        WEB_SEARCH_API_KEY_SECRET_ARN: webSearchApiKey?.secretArn || '',
        API_DOMAIN: props.apiDomain || '',
        NODE_ENV: environment,
        LOG_LEVEL: logLevel,
        // Media generation config
        MEDIA_BUCKET: mediaBucket?.bucketName || '',
        CDN_URL: cdnUrl || '',
        REPLICATE_WEBHOOK_URL: replicateWebhookUrl,
        REPLICATE_WEBHOOK_SECRET: replicateWebhookSecret,
        REPLICATE_API_KEY_SECRET_ARN: replicateApiKey?.secretArn || '',
        RESPONSE_QUEUE_URL: responseQueue.queueUrl,
        CHAT_QUEUE_URL: chatQueue.queueUrl,
        ALLOWED_ORIGINS: allowedOrigins.join(','),
        // Twitter OAuth (for twitter_request_integration tool)
        TWITTER_APP_CREDENTIALS_ARN: twitterAppCredentialsSecret.secretArn,
        TWITTER_OAUTH_CALLBACK_URL: twitterOAuthCallbackUrl,
        // Internal testing (non-production only)
        INTERNAL_TEST_KEY: internalTestKey,
        // Discord gateway runtime status (so admin API can report accurate health)
        DISCORD_GATEWAY_ENABLED: props.enableDiscordGateway ? 'true' : 'false',
        // GitHub issue tracking (read-only, for MCP tools)
        ...(props.githubTokenSecretArn ? {
          GITHUB_TOKEN_SECRET_ARN: props.githubTokenSecretArn,
          GITHUB_REPO: props.githubRepo || 'cenetex/aws-swarm',
        } : {}),
        ...activeUserLimitEnvVars,
      },
      bundling: {
        // Sharp is provided via dependency layer (no Docker bundling needed)
        externalModules: ['@aws-sdk/*', 'sharp'],
        minify: true,
        sourceMap: true,
        commandHooks: {
          beforeBundling: () => [],
          beforeInstall: () => [],
          afterBundling: (inputDir: string, outputDir: string) => [
            // Copy platform prompts to Lambda bundle
            `mkdir -p ${outputDir}/prompts/platforms`,
            `cp -r ${inputDir}/../../../../prompts/platforms/* ${outputDir}/prompts/platforms/ 2>/dev/null || true`,
          ],
        },
      },
      logRetention,
      tracing: lambda.Tracing.ACTIVE,
    });

    // Grant permissions
    this.table.grantReadWriteData(this.chatHandler);
    llmApiKey.grantRead(this.chatHandler);
    dreamQueue.grantSendMessages(this.chatHandler);
    if (replicateApiKey) {
      replicateApiKey.grantRead(this.chatHandler);
    }
    if (webSearchApiKey) {
      webSearchApiKey.grantRead(this.chatHandler);
    }

    // Grant permissions to state table for avatar config sync
    if (stateTable) {
      stateTable.grantReadWriteData(this.chatHandler);
    }

    // Grant S3 permissions for media operations
    if (mediaBucket) {
      mediaBucket.grantReadWrite(this.chatHandler);
    }

    // Grant Twitter OAuth credentials access
    twitterAppCredentialsSecret.grantRead(this.chatHandler);

    // Grant SQS permissions for async callbacks
    responseQueue.grantSendMessages(this.chatHandler);
    chatQueue.grantSendMessages(this.chatHandler);

    // Grant secrets manager permissions for swarm secrets
    // CreateSecret needs wildcard since the secret doesn't exist yet
    this.chatHandler.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['secretsmanager:CreateSecret'],
      resources: ['*'],
      conditions: {
        'StringLike': {
          'secretsmanager:Name': secretNamePatterns,
        },
      },
    }));

    // Other operations can use ARN pattern
    this.chatHandler.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'secretsmanager:UpdateSecret',
        'secretsmanager:DeleteSecret',
        'secretsmanager:PutSecretValue',
        'secretsmanager:DescribeSecret',
        'secretsmanager:GetSecretValue',
        'secretsmanager:TagResource',
      ],
      resources: secretArnPatterns,
    }));

    // ListSecrets needs wildcard resource (API limitation)
    this.chatHandler.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['secretsmanager:ListSecrets'],
      resources: ['*'],
    }));

    // KMS permissions for Secrets Manager (AWS-managed key)
    // Scoped to keys in this account/region (not wildcard) to limit blast radius.
    const kmsKeyArnPattern = `arn:aws:kms:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:key/*`;
    this.chatHandler.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'kms:Decrypt',
        'kms:GenerateDataKey',
        'kms:GenerateDataKeyWithoutPlaintext',
      ],
      resources: [kmsKeyArnPattern],
      conditions: {
        StringEquals: {
          'kms:ViaService': `secretsmanager.${cdk.Stack.of(this).region}.amazonaws.com`,
        },
      },
    }));

    // HTTP API Gateway
    this.api = new apigateway.HttpApi(this, 'AdminApi', {
      apiName: `SwarmAdminApi-${environment}`,
      description: `API for Swarm admin interface (${environment})`,
      corsPreflight: {
        allowOrigins: allowedOrigins,
        allowMethods: [
          apigateway.CorsHttpMethod.GET,
          apigateway.CorsHttpMethod.POST,
          apigateway.CorsHttpMethod.PUT,
          apigateway.CorsHttpMethod.DELETE,
          apigateway.CorsHttpMethod.OPTIONS,
        ],
        allowHeaders: ['Content-Type', 'Authorization', 'Prefer', 'Idempotency-Key'],
        allowCredentials: true,
        maxAge: cdk.Duration.hours(24),
      },
    });

    // Access logging for forensics & compliance
    // Staging gets ONE_WEEK (7 days) to reduce CloudWatch idle cost (~$6.81/week).
    const accessLogRetention = isProd
      ? logs.RetentionDays.ONE_MONTH
      : logs.RetentionDays.ONE_WEEK;

    const accessLogGroupName = `/aws/apigateway/SwarmAdminApi-${environment}${suffix}-access-logs`;
    const accessLogGroup = props.useExistingResources
      ? logs.LogGroup.fromLogGroupName(this, 'ApiAccessLogs', accessLogGroupName)
      : new logs.LogGroup(this, 'ApiAccessLogs', {
          logGroupName: accessLogGroupName,
          retention: accessLogRetention,
          removalPolicy: isPersistentEnv
            ? cdk.RemovalPolicy.RETAIN
            : cdk.RemovalPolicy.DESTROY,
        });

    // Apply throttling and access logging to the default stage
    const defaultStage = this.api.defaultStage?.node.defaultChild as cdk.CfnResource | undefined;
    if (defaultStage) {
      defaultStage.addPropertyOverride('DefaultRouteSettings', {
        ThrottlingBurstLimit: 100,
        ThrottlingRateLimit: 50,
      });

      defaultStage.addPropertyOverride('AccessLogSettings', {
        DestinationArn: accessLogGroup.logGroupArn,
        Format: JSON.stringify({
          requestId: '$context.requestId',
          ip: '$context.identity.sourceIp',
          requestTime: '$context.requestTime',
          httpMethod: '$context.httpMethod',
          path: '$context.path',
          routeKey: '$context.routeKey',
          status: '$context.status',
          responseLength: '$context.responseLength',
          protocol: '$context.protocol',
          integrationError: '$context.integrationErrorMessage',
          integrationLatency: '$context.integrationLatency',
          responseLatency: '$context.responseLatency',
        }),
      });
    }

    // NOTE: WAFv2 WebACL association is not supported for API Gateway HTTP APIs (v2).
    // The Admin API uses an HTTP API, so WAF protection must be applied at a
    // different layer (e.g., CloudFront or an ALB in front of the API).

    // Telegram needs a publicly reachable webhook URL. Prefer the CloudFront
    // domain (apiDomain / adminDomain) so webhooks route through the CDN —
    // the Admin UI CloudFront distribution already has a /webhook/* behavior
    // that proxies to the API Gateway origin. Fall back to the raw API Gateway
    // host only when no custom domain is configured.
    const rawApiHost = cdk.Fn.select(2, cdk.Fn.split('/', this.api.apiEndpoint));
    const telegramWebhookDomain = props.telegramWebhookDomain
      || props.apiDomain
      || rawApiHost;

    // Chat Worker Lambda - processes async admin chat jobs
    this.chatWorkerHandler = new nodejs.NodejsFunction(this, 'ChatWorkerHandler', {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, '../../../admin-api/src/handlers/chat-worker.ts'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(600),
      memorySize: 1024,
      reservedConcurrentExecutions: 10,
      layers: dependencyLayer ? [dependencyLayer] : undefined,
      environment: {
        ADMIN_TABLE: this.table.tableName,
        STATE_TABLE: stateTable?.tableName || '',
        DREAM_QUEUE_URL: dreamQueue.queueUrl,
        DREAMS_ENABLED: isProd ? 'false' : 'true',
        SECRET_PREFIX: secretPrefix,
        // LLM config (worker is not API-gateway constrained)
        LLM_ENDPOINT: 'https://openrouter.ai/api/v1/chat/completions',
        LLM_MODEL: 'anthropic/claude-haiku-4.5',
        LLM_TIMEOUT_MS: '120000',
        LLM_MAX_RETRIES: '1',
        LLM_MAX_STEPS: '6',
        LLM_API_KEY_SECRET_ARN: llmApiKey.secretArn,
        WEB_SEARCH_PROVIDER: webSearchProvider || 'serpapi',
        WEB_SEARCH_API_KEY_SECRET_ARN: webSearchApiKey?.secretArn || '',
        API_DOMAIN: props.apiDomain || '',
        NODE_ENV: environment,
        LOG_LEVEL: logLevel,
        // Media generation config
        MEDIA_BUCKET: mediaBucket?.bucketName || '',
        CDN_URL: cdnUrl || '',
        REPLICATE_WEBHOOK_URL: replicateWebhookUrl,
        REPLICATE_WEBHOOK_SECRET: replicateWebhookSecret,
        REPLICATE_API_KEY_SECRET_ARN: replicateApiKey?.secretArn || '',
        RESPONSE_QUEUE_URL: responseQueue.queueUrl,
        // Twitter OAuth (for twitter_request_integration tool)
        TWITTER_APP_CREDENTIALS_ARN: twitterAppCredentialsSecret.secretArn,
        TWITTER_OAUTH_CALLBACK_URL: twitterOAuthCallbackUrl,
        ...activeUserLimitEnvVars,
      },
      bundling: {
        externalModules: ['@aws-sdk/*', 'sharp'],
        minify: true,
        sourceMap: true,
        commandHooks: {
          beforeBundling: () => [],
          beforeInstall: () => [],
          afterBundling: (inputDir: string, outputDir: string) => [
            `mkdir -p ${outputDir}/prompts/platforms`,
            `cp -r ${inputDir}/../../../../prompts/platforms/* ${outputDir}/prompts/platforms/ 2>/dev/null || true`,
          ],
        },
      },
      logRetention,
      tracing: lambda.Tracing.ACTIVE,
    });

    // Worker permissions
    this.table.grantReadWriteData(this.chatWorkerHandler);
    // Grant permission to query GSI1 (for entitlement lookups)
    this.chatWorkerHandler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:Query'],
        resources: [`${this.table.tableArn}/index/GSI1`],
      })
    );
    llmApiKey.grantRead(this.chatWorkerHandler);
    dreamQueue.grantSendMessages(this.chatWorkerHandler);
    if (replicateApiKey) {
      replicateApiKey.grantRead(this.chatWorkerHandler);
    }
    if (webSearchApiKey) {
      webSearchApiKey.grantRead(this.chatWorkerHandler);
    }
    if (stateTable) {
      stateTable.grantReadWriteData(this.chatWorkerHandler);
    }
    if (mediaBucket) {
      mediaBucket.grantReadWrite(this.chatWorkerHandler);
    }
    twitterAppCredentialsSecret.grantRead(this.chatWorkerHandler);
    responseQueue.grantSendMessages(this.chatWorkerHandler);

    // Secrets Manager permissions (same as chat handler)
    this.chatWorkerHandler.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['secretsmanager:CreateSecret'],
      resources: ['*'],
      conditions: {
        'StringLike': {
          'secretsmanager:Name': secretNamePatterns,
        },
      },
    }));

    this.chatWorkerHandler.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'secretsmanager:UpdateSecret',
        'secretsmanager:DeleteSecret',
        'secretsmanager:PutSecretValue',
        'secretsmanager:DescribeSecret',
        'secretsmanager:GetSecretValue',
        'secretsmanager:TagResource',
      ],
      resources: [
        ...secretArnPatterns,
      ],
    }));

    this.chatWorkerHandler.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['secretsmanager:ListSecrets'],
      resources: ['*'],
    }));

    this.chatWorkerHandler.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'kms:Decrypt',
        'kms:GenerateDataKey',
        'kms:GenerateDataKeyWithoutPlaintext',
      ],
      resources: [kmsKeyArnPattern],
      conditions: {
        StringEquals: {
          'kms:ViaService': `secretsmanager.${cdk.Stack.of(this).region}.amazonaws.com`,
        },
      },
    }));

    this.chatWorkerHandler.addEventSource(new lambdaEventSources.SqsEventSource(chatQueue, {
      batchSize: 1,
      maxBatchingWindow: cdk.Duration.seconds(2),
    }));

    // Expose the API endpoint for CloudFront to use as origin
    this.apiEndpoint = this.api.apiEndpoint;

    // Update Replicate webhook URL to use raw API Gateway URL (bypasses upstream auth)
    // Extract hostname from API endpoint (e.g., "https://xxx.execute-api.us-east-1.amazonaws.com")
    replicateWebhookUrl = cdk.Fn.join('', [this.api.apiEndpoint, '/webhook/replicate']);

    // Update Lambda environment variables that need the API endpoint
    // ChatHandler
    (this.chatHandler.node.defaultChild as lambda.CfnFunction).addPropertyOverride(
      'Environment.Variables.REPLICATE_WEBHOOK_URL',
      replicateWebhookUrl
    );

    // ChatWorkerHandler
    (this.chatWorkerHandler.node.defaultChild as lambda.CfnFunction).addPropertyOverride(
      'Environment.Variables.REPLICATE_WEBHOOK_URL',
      replicateWebhookUrl
    );

    // Add routes
    const chatIntegration = new integrations.HttpLambdaIntegration(
      'ChatIntegration',
      this.chatHandler
    );

    this.api.addRoutes({
      path: '/chat',
      methods: [apigateway.HttpMethod.GET, apigateway.HttpMethod.POST, apigateway.HttpMethod.DELETE],
      integration: chatIntegration,
    });

      // Media conversion handler (audio/video transcoding)
      const mediaConvertHandler = new nodejs.NodejsFunction(this, 'MediaConvertHandler', {
        runtime: lambda.Runtime.NODEJS_20_X,
        entry: path.join(__dirname, '../../../admin-api/src/handlers/media-convert.ts'),
        handler: 'handler',
        timeout: cdk.Duration.seconds(60),
        memorySize: 1024,
        environment: {
          MEDIA_BUCKET: mediaBucket?.bucketName || '',
          CDN_URL: cdnUrl || '',
          NODE_ENV: environment,
        LOG_LEVEL: logLevel,
          ...activeUserLimitEnvVars,
        },
        bundling: {
          externalModules: ['@aws-sdk/*'],
          nodeModules: ['ffmpeg-static'],
          minify: true,
          sourceMap: true,
        },
        logRetention,
        tracing: lambda.Tracing.ACTIVE,
      });

      this.mediaConvertHandler = mediaConvertHandler;

      if (mediaBucket) {
        mediaBucket.grantReadWrite(mediaConvertHandler);
      }

    // Transcribe handler - for audio transcription
    const transcribeHandler = new nodejs.NodejsFunction(this, 'TranscribeHandler', {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, '../../../admin-api/src/handlers/transcribe.ts'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: {
        ADMIN_TABLE: this.table.tableName,
        ADMIN_EMAILS: adminEmails,
        NODE_ENV: environment,
        LOG_LEVEL: logLevel,
        ALLOWED_ORIGINS: allowedOrigins.join(','),
        LLM_API_KEY_SECRET_ARN: llmApiKey.secretArn,
        CDN_URL: cdnUrl || '',
        INTERNAL_TEST_KEY: internalTestKey,
        ...activeUserLimitEnvVars,
      },
      bundling: {
        externalModules: ['@aws-sdk/*'],
        nodeModules: ['ffmpeg-static'],
        minify: true,
        sourceMap: true,
      },
      logRetention,
      tracing: lambda.Tracing.ACTIVE,
    });

    // Grant permissions to transcribe handler
    this.table.grantReadWriteData(transcribeHandler);
    llmApiKey.grantRead(transcribeHandler);

    const transcribeIntegration = new integrations.HttpLambdaIntegration(
      'TranscribeIntegration',
      transcribeHandler
    );

    this.api.addRoutes({
      path: '/transcribe',
      methods: [apigateway.HttpMethod.POST, apigateway.HttpMethod.OPTIONS],
      integration: transcribeIntegration,
    });

    // Shared chat handler (public group chat)
    const sharedChatHandler = new nodejs.NodejsFunction(this, 'SharedChatHandler', {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, '../../../admin-api/src/handlers/shared-chat.ts'),
      handler: 'handleSharedChat',
      timeout: cdk.Duration.seconds(15),
      memorySize: 256,
      environment: {
        ADMIN_TABLE: this.table.tableName,
        NODE_ENV: environment,
        LOG_LEVEL: logLevel,
        ALLOWED_ORIGINS: allowedOrigins.join(','),
        CDN_URL: cdnUrl || '',
        ...activeUserLimitEnvVars,
      },
      bundling: {
        externalModules: ['@aws-sdk/*'],
        minify: true,
        sourceMap: true,
      },
      logRetention,
      tracing: lambda.Tracing.ACTIVE,
    });

    this.table.grantReadWriteData(sharedChatHandler);
    // Grant permission to query GSI1 (for inhabitant avatar lookups)
    sharedChatHandler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:Query'],
        resources: [`${this.table.tableArn}/index/GSI1`],
      })
    );

    const sharedChatIntegration = new integrations.HttpLambdaIntegration(
      'SharedChatIntegration',
      sharedChatHandler
    );

    this.api.addRoutes({
      path: '/shared-chat/{proxy+}',
      methods: [apigateway.HttpMethod.GET, apigateway.HttpMethod.POST, apigateway.HttpMethod.OPTIONS],
      integration: sharedChatIntegration,
    });

    // Avatars handler - for CRUD operations on avatars
    const avatarsHandler = new nodejs.NodejsFunction(this, 'Avatarsandler', {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, '../../../admin-api/src/handlers/avatars.ts'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: {
        ADMIN_TABLE: this.table.tableName,
        STATE_TABLE: stateTable?.tableName || '',
        ADMIN_EMAILS: adminEmails,
        ADMIN_WALLETS: props.adminWallets || '',
        // Public domain used to compute Telegram webhook URLs (bots should follow CloudFront cutovers).
        API_DOMAIN: props.apiDomain || '',
        TELEGRAM_WEBHOOK_DOMAIN: telegramWebhookDomain,
        NODE_ENV: environment,
        LOG_LEVEL: logLevel,
        ALLOWED_ORIGINS: allowedOrigins.join(','),
        SECRET_PREFIX: secretPrefix,
        // Burn-to-energy configuration
        ENERGY_BURN_RATE: process.env.ENERGY_BURN_RATE || '100',
        ENERGY_BURN_DEFAULT_MINT: process.env.ENERGY_BURN_DEFAULT_MINT || 'Ci6Y1UX8bY4jxn6YiogJmdCxFEu2jmZhCcG65PStpump',
        ENERGY_BURN_ALLOWED_MINTS:
          process.env.ENERGY_BURN_ALLOWED_MINTS ||
          process.env.ENERGY_BURN_DEFAULT_MINT ||
          'Ci6Y1UX8bY4jxn6YiogJmdCxFEu2jmZhCcG65PStpump',
        LLM_API_KEY_SECRET_ARN: llmApiKey.secretArn,
        REPLICATE_API_KEY_SECRET_ARN: replicateApiKey?.secretArn || '',
        // POST_QUEUE for decoupled Twitter posting
        POST_QUEUE_URL: props.postQueue?.queueUrl || '',
        // Expanded /system/status queue health telemetry
        SYSTEM_SHARED_MESSAGE_QUEUE_URL: props.sharedMessageQueue?.queueUrl || '',
        SYSTEM_SHARED_RESPONSE_QUEUE_URL: props.sharedResponseQueue?.queueUrl || '',
        SYSTEM_SHARED_MEDIA_QUEUE_URL: props.sharedMediaQueue?.queueUrl || '',
        SYSTEM_SHARED_POST_QUEUE_URL: props.postQueue?.queueUrl || '',
        SYSTEM_SHARED_DLQ_URL: props.sharedDlq?.queueUrl || '',
        SYSTEM_SHARED_SCHEDULER_DLQ_URL: props.sharedSchedulerDlq?.queueUrl || '',
        SYSTEM_ADMIN_RESPONSE_QUEUE_URL: responseQueue.queueUrl,
        SYSTEM_ADMIN_CHAT_QUEUE_URL: chatQueue.queueUrl,
        SYSTEM_ADMIN_DREAM_QUEUE_URL: dreamQueue.queueUrl,
        SYSTEM_ADMIN_RESPONSE_DLQ_URL: this.responseDlq.queueUrl,
        SYSTEM_ADMIN_CHAT_DLQ_URL: this.chatDlq.queueUrl,
        SYSTEM_ADMIN_DREAM_DLQ_URL: this.dreamDlq.queueUrl,
        SYSTEM_ADMIN_CONSOLIDATION_DLQ_URL: this.consolidationDlq.queueUrl,
        // Internal testing (non-production only)
        INTERNAL_TEST_KEY: internalTestKey,
        // Discord gateway runtime status (so admin API can report accurate health)
        DISCORD_GATEWAY_ENABLED: props.enableDiscordGateway ? 'true' : 'false',
        CDN_URL: cdnUrl || '',
        ...activeUserLimitEnvVars,
      },
      bundling: {
        externalModules: ['@aws-sdk/*'],
        minify: true,
        sourceMap: true,
      },
      logRetention,
      tracing: lambda.Tracing.ACTIVE,
    });

    // Grant permissions to avatars handler
    llmApiKey.grantRead(avatarsHandler);
    this.table.grantReadWriteData(avatarsHandler);
    avatarsHandler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:Query'],
        resources: [`${this.table.tableArn}/index/GSI1`],
      })
    );
    if (stateTable) {
      stateTable.grantReadWriteData(avatarsHandler);
    }
    if (props.postQueue) {
      props.postQueue.grantSendMessages(avatarsHandler);
    }

    const statusQueues: Array<sqs.IQueue | undefined> = [
      props.sharedMessageQueue,
      props.sharedResponseQueue,
      props.sharedMediaQueue,
      props.postQueue,
      props.sharedDlq,
      props.sharedSchedulerDlq,
      responseQueue,
      chatQueue,
      dreamQueue,
      this.responseDlq,
      this.chatDlq,
      this.dreamDlq,
      this.consolidationDlq,
    ];
    for (const queue of statusQueues) {
      if (queue) {
        queue.grant(avatarsHandler, 'sqs:GetQueueAttributes');
      }
    }

    // Grant secrets manager permissions to avatars handler
    // CreateSecret needs wildcard since the secret doesn't exist yet
    avatarsHandler.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
        actions: ['secretsmanager:CreateSecret'],
        resources: ['*'],
        conditions: {
          'StringLike': {
            'secretsmanager:Name': secretNamePatterns,
          },
        },
      }));

    avatarsHandler.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'secretsmanager:UpdateSecret',
        'secretsmanager:PutSecretValue',
        'secretsmanager:RestoreSecret',
        'secretsmanager:DeleteSecret',
        'secretsmanager:DescribeSecret',
        'secretsmanager:GetSecretValue',
        'secretsmanager:TagResource',
      ],
      resources: [
        ...secretArnPatterns,
      ],
    }));

    // ListSecrets doesn't support resource-level permissions
    avatarsHandler.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['secretsmanager:ListSecrets'],
      resources: ['*'],
    }));

    // KMS permissions for Secrets Manager (AWS-managed key)
    avatarsHandler.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'kms:Decrypt',
        'kms:GenerateDataKey',
        'kms:GenerateDataKeyWithoutPlaintext',
      ],
      resources: [kmsKeyArnPattern],
      conditions: {
        StringEquals: {
          'kms:ViaService': `secretsmanager.${cdk.Stack.of(this).region}.amazonaws.com`,
        },
      },
    }));

    (this.chatHandler.node.defaultChild as lambda.CfnFunction).addPropertyOverride(
      'Environment.Variables.MEDIA_CONVERT_FUNCTION',
      mediaConvertHandler.functionName
    );

    this.chatHandler.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['lambda:InvokeFunction'],
      resources: [mediaConvertHandler.functionArn],
    }));

    // CloudWatch Logs access for consolidated avatar logs
    avatarsHandler.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'logs:StartQuery',
        'logs:GetQueryResults',
        'logs:DescribeLogGroups',
      ],
      resources: ['*'],
    }));

    const avatarsIntegration = new integrations.HttpLambdaIntegration(
      'Avatarsntegration',
      avatarsHandler
    );

    // Avatar routes
    this.api.addRoutes({
      path: '/avatars',
      methods: [apigateway.HttpMethod.GET, apigateway.HttpMethod.POST],
      integration: avatarsIntegration,
    });

    this.api.addRoutes({
      path: '/avatars/{avatarId}',
      methods: [apigateway.HttpMethod.GET, apigateway.HttpMethod.PUT, apigateway.HttpMethod.DELETE],
      integration: avatarsIntegration,
    });

    this.api.addRoutes({
      path: '/avatars/{avatarId}/secrets',
      methods: [apigateway.HttpMethod.GET, apigateway.HttpMethod.POST],
      integration: avatarsIntegration,
    });

    this.api.addRoutes({
      path: '/avatars/{avatarId}/api-keys',
      methods: [apigateway.HttpMethod.POST],
      integration: avatarsIntegration,
    });

    this.api.addRoutes({
      path: '/avatars/{avatarId}/tools/{toolCallId}',
      methods: [apigateway.HttpMethod.POST],
      integration: avatarsIntegration,
    });

    this.api.addRoutes({
      path: '/api-keys',
      methods: [apigateway.HttpMethod.POST],
      integration: avatarsIntegration,
    });

    this.api.addRoutes({
      path: '/avatars/{avatarId}/integrations',
      methods: [apigateway.HttpMethod.GET],
      integration: avatarsIntegration,
    });

    this.api.addRoutes({
      path: '/avatars/{avatarId}/validate-token',
      methods: [apigateway.HttpMethod.POST],
      integration: avatarsIntegration,
    });

    this.api.addRoutes({
      path: '/avatars/{avatarId}/validate-ai-key',
      methods: [apigateway.HttpMethod.POST],
      integration: avatarsIntegration,
    });

    this.api.addRoutes({
      path: '/integrations/models',
      methods: [apigateway.HttpMethod.GET],
      integration: avatarsIntegration,
    });

    this.api.addRoutes({
      path: '/integrations/models/search',
      methods: [apigateway.HttpMethod.GET],
      integration: avatarsIntegration,
    });

    this.api.addRoutes({
      path: '/system/status',
      methods: [apigateway.HttpMethod.GET],
      integration: avatarsIntegration,
    });

    this.api.addRoutes({
      path: '/avatars/{avatarId}/logs',
      methods: [apigateway.HttpMethod.GET],
      integration: avatarsIntegration,
    });

    this.api.addRoutes({
      path: '/avatars/{avatarId}/issues',
      methods: [apigateway.HttpMethod.GET],
      integration: avatarsIntegration,
    });

    this.api.addRoutes({
      path: '/avatars/{avatarId}/events',
      methods: [apigateway.HttpMethod.GET, apigateway.HttpMethod.PATCH],
      integration: avatarsIntegration,
    });

    this.api.addRoutes({
      path: '/avatars/{avatarId}/activity',
      methods: [apigateway.HttpMethod.GET],
      integration: avatarsIntegration,
    });

    // Plan/entitlements routes
    this.api.addRoutes({
      path: '/avatars/{avatarId}/entitlement',
      methods: [apigateway.HttpMethod.GET, apigateway.HttpMethod.PUT],
      integration: avatarsIntegration,
    });

    this.api.addRoutes({
      path: '/avatars/{avatarId}/effective-limits',
      methods: [apigateway.HttpMethod.GET],
      integration: avatarsIntegration,
    });

    // Usage metering routes
    this.api.addRoutes({
      path: '/avatars/{avatarId}/usage',
      methods: [apigateway.HttpMethod.GET],
      integration: avatarsIntegration,
    });

    this.api.addRoutes({
      path: '/avatars/{avatarId}/usage/history',
      methods: [apigateway.HttpMethod.GET],
      integration: avatarsIntegration,
    });

    this.api.addRoutes({
      path: '/avatars/{avatarId}/activation-readiness',
      methods: [apigateway.HttpMethod.GET],
      integration: avatarsIntegration,
    });

    this.api.addRoutes({
      path: '/avatars/{avatarId}/activate',
      methods: [apigateway.HttpMethod.POST],
      integration: avatarsIntegration,
    });

    this.api.addRoutes({
      path: '/avatars/{avatarId}/deactivate',
      methods: [apigateway.HttpMethod.POST],
      integration: avatarsIntegration,
    });

    // Energy routes
    this.api.addRoutes({
      path: '/avatars/{avatarId}/energy',
      methods: [apigateway.HttpMethod.GET],
      integration: avatarsIntegration,
    });

    this.api.addRoutes({
      path: '/avatars/{avatarId}/energy/history',
      methods: [apigateway.HttpMethod.GET],
      integration: avatarsIntegration,
    });

    this.api.addRoutes({
      path: '/avatars/{avatarId}/energy/set',
      methods: [apigateway.HttpMethod.POST],
      integration: avatarsIntegration,
    });

    this.api.addRoutes({
      path: '/avatars/{avatarId}/energy/add',
      methods: [apigateway.HttpMethod.POST],
      integration: avatarsIntegration,
    });

    this.api.addRoutes({
      path: '/avatars/{avatarId}/energy/burn',
      methods: [apigateway.HttpMethod.POST],
      integration: avatarsIntegration,
    });

    // Gallery routes
    this.api.addRoutes({
      path: '/avatars/{avatarId}/gallery',
      methods: [apigateway.HttpMethod.GET],
      integration: avatarsIntegration,
    });

    this.api.addRoutes({
      path: '/avatars/{avatarId}/gallery/upload-url',
      methods: [apigateway.HttpMethod.POST],
      integration: avatarsIntegration,
    });

    this.api.addRoutes({
      path: '/avatars/{avatarId}/gallery/save',
      methods: [apigateway.HttpMethod.POST],
      integration: avatarsIntegration,
    });

    // Telegram diagnostics and repair routes
    this.api.addRoutes({
      path: '/avatars/{avatarId}/telegram/diagnostics',
      methods: [apigateway.HttpMethod.GET],
      integration: avatarsIntegration,
    });

    this.api.addRoutes({
      path: '/avatars/{avatarId}/telegram/repair',
      methods: [apigateway.HttpMethod.POST],
      integration: avatarsIntegration,
    });

    // Onboarding orchestrator routes
    this.api.addRoutes({
      path: '/onboarding/{avatarId}',
      methods: [apigateway.HttpMethod.GET],
      integration: avatarsIntegration,
    });

    this.api.addRoutes({
      path: '/onboarding/{avatarId}/restart',
      methods: [apigateway.HttpMethod.POST],
      integration: avatarsIntegration,
    });

    this.api.addRoutes({
      path: '/onboarding/{avatarId}/steps/{stepId}/execute',
      methods: [apigateway.HttpMethod.POST],
      integration: avatarsIntegration,
    });

    this.api.addRoutes({
      path: '/onboarding/{avatarId}/steps/{stepId}/skip-optional',
      methods: [apigateway.HttpMethod.POST],
      integration: avatarsIntegration,
    });

    // Issues handler - for auto-issue tracking system (used by CI/CD, browser tests)
    const issuesHandler = new nodejs.NodejsFunction(this, 'IssuesHandler', {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, '../../../admin-api/src/handlers/issues.ts'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(15),
      memorySize: 256,
      environment: {
        ADMIN_TABLE: this.table.tableName,
        NODE_ENV: environment,
        LOG_LEVEL: logLevel,
        ALLOWED_ORIGINS: allowedOrigins.join(','),
        CDN_URL: cdnUrl || '',
        INTERNAL_TEST_KEY: internalTestKey,
        ...activeUserLimitEnvVars,
      },
      bundling: {
        externalModules: ['@aws-sdk/*'],
        minify: true,
        sourceMap: true,
      },
      logRetention,
      tracing: lambda.Tracing.ACTIVE,
    });

    // Grant permissions to issues handler
    this.table.grantReadWriteData(issuesHandler);

    const issuesIntegration = new integrations.HttpLambdaIntegration(
      'IssuesIntegration',
      issuesHandler
    );

    // Issues routes
    this.api.addRoutes({
      path: '/issues',
      methods: [apigateway.HttpMethod.GET, apigateway.HttpMethod.POST],
      integration: issuesIntegration,
    });

    this.api.addRoutes({
      path: '/issues/{issueId}',
      methods: [apigateway.HttpMethod.GET, apigateway.HttpMethod.PATCH],
      integration: issuesIntegration,
    });

    // DSAR handler - privacy data export and erasure (GDPR Article 15/17)
    const dsarHandler = new nodejs.NodejsFunction(this, 'DSARHandler', {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, '../../../admin-api/src/handlers/dsar.ts'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: {
        ADMIN_TABLE: this.table.tableName,
        NODE_ENV: environment,
        LOG_LEVEL: logLevel,
        ALLOWED_ORIGINS: allowedOrigins.join(','),
        CDN_URL: cdnUrl || '',
        ...activeUserLimitEnvVars,
      },
      bundling: {
        externalModules: ['@aws-sdk/*'],
        minify: true,
        sourceMap: true,
      },
      logRetention,
      tracing: lambda.Tracing.ACTIVE,
    });

    // Grant permissions to DSAR handler
    this.table.grantReadWriteData(dsarHandler);

    const dsarIntegration = new integrations.HttpLambdaIntegration(
      'DSARIntegration',
      dsarHandler
    );

    // DSAR routes
    this.api.addRoutes({
      path: '/dsar/inventory',
      methods: [apigateway.HttpMethod.GET],
      integration: dsarIntegration,
    });

    this.api.addRoutes({
      path: '/dsar/export',
      methods: [apigateway.HttpMethod.POST],
      integration: dsarIntegration,
    });

    this.api.addRoutes({
      path: '/dsar/erase',
      methods: [apigateway.HttpMethod.POST],
      integration: dsarIntegration,
    });

    // Health check endpoint
    const healthHandler = new nodejs.NodejsFunction(this, 'HealthHandler', {
      runtime: lambda.Runtime.NODEJS_20_X,
      code: lambda.Code.fromInline(`
        exports.handler = async () => ({
          statusCode: 200,
          body: JSON.stringify({ status: 'ok', timestamp: Date.now() }),
        });
      `),
      handler: 'index.handler',
      logRetention,
      tracing: lambda.Tracing.ACTIVE,
    });

    const healthIntegration = new integrations.HttpLambdaIntegration(
      'HealthIntegration',
      healthHandler
    );

    this.api.addRoutes({
      path: '/health',
      methods: [apigateway.HttpMethod.GET],
      integration: healthIntegration,
    });

    // ==========================================================================
    // Public Profile API (No auth required)
    // ==========================================================================
    // Public endpoints for avatar profile pages and leaderboard.
    // CORS is handled in the handler itself with Access-Control-Allow-Origin: *
    const publicProfileHandler = new nodejs.NodejsFunction(this, 'PublicProfileHandler', {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, '../../../admin-api/src/handlers/public-profile.ts'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(15),
      memorySize: 256,
      environment: {
        ADMIN_TABLE: this.table.tableName,
        NODE_ENV: environment,
        LOG_LEVEL: logLevel,
        CDN_URL: cdnUrl || '',
      },
      bundling: {
        externalModules: ['@aws-sdk/*'],
        minify: true,
        sourceMap: true,
      },
      logRetention,
      tracing: lambda.Tracing.ACTIVE,
    });

    // Grant read access to admin table for profile data
    this.table.grantReadData(publicProfileHandler);

    const publicProfileIntegration = new integrations.HttpLambdaIntegration(
      'PublicProfileIntegration',
      publicProfileHandler
    );

    // Public profile route: GET /api/profile/{avatarId}
    this.api.addRoutes({
      path: '/api/profile/{avatarId}',
      methods: [apigateway.HttpMethod.GET, apigateway.HttpMethod.OPTIONS],
      integration: publicProfileIntegration,
    });

    // Leaderboard handler - separate for potential different scaling needs
    const leaderboardHandler = new nodejs.NodejsFunction(this, 'LeaderboardHandler', {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, '../../../admin-api/src/handlers/public-profile.ts'),
      handler: 'leaderboardHandler',
      timeout: cdk.Duration.seconds(15),
      memorySize: 256,
      environment: {
        ADMIN_TABLE: this.table.tableName,
        NODE_ENV: environment,
        LOG_LEVEL: logLevel,
        CDN_URL: cdnUrl || '',
      },
      bundling: {
        externalModules: ['@aws-sdk/*'],
        minify: true,
        sourceMap: true,
      },
      logRetention,
      tracing: lambda.Tracing.ACTIVE,
    });

    // Grant read access to admin table for leaderboard data
    this.table.grantReadData(leaderboardHandler);

    const leaderboardIntegration = new integrations.HttpLambdaIntegration(
      'LeaderboardIntegration',
      leaderboardHandler
    );

    // Leaderboard route: GET /api/leaderboard
    this.api.addRoutes({
      path: '/api/leaderboard',
      methods: [apigateway.HttpMethod.GET, apigateway.HttpMethod.OPTIONS],
      integration: leaderboardIntegration,
    });

    // ==========================================================================
    // OpenAI-Compatible API (Public with API Key auth)
    // ==========================================================================
    // This provides a /v1/chat/completions endpoint that external applications
    // can use with the familiar OpenAI API format. Authentication is via API key
    // (Bearer token in Authorization header).
    this.openaiCompatHandler = new nodejs.NodejsFunction(this, 'OpenAICompatHandler', {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, '../../../admin-api/src/handlers/openai-compat.ts'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(120), // Longer timeout for chat completions
      memorySize: 1024,
      reservedConcurrentExecutions: 5,
      layers: dependencyLayer ? [dependencyLayer] : undefined,
      environment: {
        ADMIN_TABLE: this.table.tableName,
        STATE_TABLE: stateTable?.tableName || '',
        SECRET_PREFIX: secretPrefix,
        LLM_ENDPOINT: 'https://openrouter.ai/api/v1/chat/completions',
        LLM_MODEL: 'anthropic/claude-haiku-4.5',
        LLM_TIMEOUT_MS: '60000', // More generous timeout for public API
        LLM_MAX_RETRIES: '1',
        LLM_MAX_STEPS: '4',
        LLM_API_KEY_SECRET_ARN: llmApiKey.secretArn,
        NODE_ENV: environment,
        LOG_LEVEL: logLevel,
        ALLOWED_ORIGINS: '*', // Public API allows all origins
        // Media bucket for voice audio storage
        MEDIA_BUCKET: mediaBucket?.bucketName || '',
        CDN_URL: cdnUrl || '',
      },
      bundling: {
        externalModules: ['@aws-sdk/*', 'sharp'],
        minify: true,
        sourceMap: true,
      },
      logRetention,
      tracing: lambda.Tracing.ACTIVE,
    });

    // Grant permissions to OpenAI compat handler
    this.table.grantReadWriteData(this.openaiCompatHandler);
    llmApiKey.grantRead(this.openaiCompatHandler);
    if (stateTable) {
      stateTable.grantReadData(this.openaiCompatHandler);
    }
    if (mediaBucket) {
      mediaBucket.grantReadWrite(this.openaiCompatHandler);
    }

    // Grant secrets manager read for avatar secrets (persona/config)
    this.openaiCompatHandler.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['secretsmanager:GetSecretValue'],
      resources: secretArnPatterns,
    }));

    // ─── OpenAI-Compatible Streaming Handler (Function URL) ──────────
    // True token-by-token SSE streaming via Lambda response streaming.
    // Separate from the buffered API Gateway path above.
    const openaiStreamHandler = new nodejs.NodejsFunction(this, 'OpenAIStreamHandler', {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, '../../../admin-api/src/handlers/openai-compat-stream.ts'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(120),
      memorySize: 1024,
      reservedConcurrentExecutions: 5,
      layers: dependencyLayer ? [dependencyLayer] : undefined,
      environment: {
        ADMIN_TABLE: this.table.tableName,
        STATE_TABLE: stateTable?.tableName || '',
        SECRET_PREFIX: secretPrefix,
        LLM_TIMEOUT_MS: '90000',
        LLM_API_KEY_SECRET_ARN: llmApiKey.secretArn,
        NODE_ENV: environment,
        LOG_LEVEL: logLevel,
      },
      bundling: {
        externalModules: ['@aws-sdk/*', 'sharp'],
        minify: true,
        sourceMap: true,
      },
      logRetention,
      tracing: lambda.Tracing.ACTIVE,
    });

    // Grant same permissions as the buffered handler
    this.table.grantReadWriteData(openaiStreamHandler);
    llmApiKey.grantRead(openaiStreamHandler);
    if (stateTable) {
      stateTable.grantReadData(openaiStreamHandler);
    }
    openaiStreamHandler.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['secretsmanager:GetSecretValue'],
      resources: secretArnPatterns,
    }));

    // Function URL with response streaming for true SSE
    const streamFunctionUrl = openaiStreamHandler.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE, // Auth handled in handler via API key
      invokeMode: lambda.InvokeMode.RESPONSE_STREAM,
      cors: {
        allowedOrigins: ['*'],
        allowedHeaders: ['Content-Type', 'Authorization'],
        allowedMethods: [lambda.HttpMethod.POST],
      },
    });

    new cdk.CfnOutput(this, 'StreamingApiUrl', {
      value: streamFunctionUrl.url,
      description: 'OpenAI-compatible streaming API URL (Function URL)',
    });

    const openaiCompatIntegration = new integrations.HttpLambdaIntegration(
      'OpenAICompatIntegration',
      this.openaiCompatHandler
    );

    // OpenAI-compatible routes
    this.api.addRoutes({
      path: '/v1/chat/completions',
      methods: [apigateway.HttpMethod.POST, apigateway.HttpMethod.OPTIONS],
      integration: openaiCompatIntegration,
    });

    this.api.addRoutes({
      path: '/v1/models',
      methods: [apigateway.HttpMethod.GET, apigateway.HttpMethod.OPTIONS],
      integration: openaiCompatIntegration,
    });

    // Jobs handler - for polling media job status
    const jobsHandler = new nodejs.NodejsFunction(this, 'JobsHandler', {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, '../../../admin-api/src/handlers/jobs.ts'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(10),
      memorySize: 256,
      environment: {
        ADMIN_TABLE: this.table.tableName,
        ADMIN_EMAILS: adminEmails,
        NODE_ENV: environment,
        LOG_LEVEL: logLevel,
        ALLOWED_ORIGINS: allowedOrigins.join(','),
        CDN_URL: cdnUrl || '',
        ...activeUserLimitEnvVars,
      },
      bundling: {
        externalModules: ['@aws-sdk/*'],
        minify: true,
        sourceMap: true,
      },
      logRetention,
      tracing: lambda.Tracing.ACTIVE,
    });

    // Grant permissions to jobs handler
    this.table.grantReadWriteData(jobsHandler);

    const jobsIntegration = new integrations.HttpLambdaIntegration(
      'JobsIntegration',
      jobsHandler
    );

    this.api.addRoutes({
      path: '/jobs',
      methods: [apigateway.HttpMethod.GET],
      integration: jobsIntegration,
    });

    this.api.addRoutes({
      path: '/jobs/{jobId}',
      methods: [apigateway.HttpMethod.GET],
      integration: jobsIntegration,
    });

    // Prompt Preview handler - shows what would be sent to the LLM
    // The handler calls createMCPServices() which initializes the full service
    // container. Services read env vars at module load time, so we must provide
    // the same core env vars that the chat handler uses.
    const promptPreviewHandler = new nodejs.NodejsFunction(this, 'PromptPreviewHandler', {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, '../../../admin-api/src/handlers/prompt-preview.ts'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: {
        ADMIN_TABLE: this.table.tableName,
        STATE_TABLE: stateTable?.tableName || '',
        SECRET_PREFIX: secretPrefix,
        MEDIA_BUCKET: mediaBucket?.bucketName || '',
        CDN_URL: cdnUrl || '',
        LLM_API_KEY_SECRET_ARN: llmApiKey.secretArn,
        REPLICATE_API_KEY_SECRET_ARN: replicateApiKey?.secretArn || '',
        ADMIN_EMAILS: adminEmails,
        NODE_ENV: environment,
        LOG_LEVEL: logLevel,
        ALLOWED_ORIGINS: allowedOrigins.join(','),
        INTERNAL_TEST_KEY: internalTestKey,
      },
      bundling: {
        externalModules: ['@aws-sdk/*'],
        minify: true,
        sourceMap: true,
      },
      logRetention,
      tracing: lambda.Tracing.ACTIVE,
    });

    // Grant permissions to prompt preview handler
    // Needs read-write because transitive services (session touch, audit log) perform UpdateItem
    this.table.grantReadWriteData(promptPreviewHandler);
    if (stateTable) {
      stateTable.grantReadData(promptPreviewHandler);
    }
    llmApiKey.grantRead(promptPreviewHandler);
    if (replicateApiKey) {
      replicateApiKey.grantRead(promptPreviewHandler);
    }

    // Grant read-only access to avatar secrets (needed by service container for
    // tool shouldShow/contextBuilder checks, e.g. checking if a bot token exists)
    promptPreviewHandler.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['secretsmanager:GetSecretValue', 'secretsmanager:DescribeSecret'],
      resources: secretArnPatterns,
    }));

    // ListSecrets needed by service container
    promptPreviewHandler.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['secretsmanager:ListSecrets'],
      resources: ['*'],
    }));

    const promptPreviewIntegration = new integrations.HttpLambdaIntegration(
      'PromptPreviewIntegration',
      promptPreviewHandler
    );

    this.api.addRoutes({
      path: '/prompt-preview',
      methods: [apigateway.HttpMethod.POST, apigateway.HttpMethod.OPTIONS],
      integration: promptPreviewIntegration,
    });

    // Wallet authentication handler - for Solana wallet sign-in
    const walletAuthHandler = new nodejs.NodejsFunction(this, 'WalletAuthHandler', {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, '../../../admin-api/src/handlers/wallet-auth.ts'),
      handler: 'handleWalletAuth',
      timeout: cdk.Duration.seconds(15), // Increased for NFT verification
      memorySize: 256,
      environment: {
        ADMIN_TABLE: this.table.tableName,
        NODE_ENV: environment,
        LOG_LEVEL: logLevel,
        ALLOWED_ORIGINS: allowedOrigins.join(','),
        AUTH_DOMAIN: adminDomain || 'admin.rati.chat',
        // Helius for NFT gating - pass ARN for runtime fetch instead of inline value
        HELIUS_API_KEY_ARN: heliusApiKeySecret?.secretArn || '',
        HELIUS_API_KEY: props.heliusApiKey || '',
        // Privy configuration
        PRIVY_APP_ID: props.privyAppId || '',
        PRIVY_APP_SECRET_ARN: privyAppSecret?.secretArn || '',
        PRIVY_JWT_VERIFICATION_KEY_ARN: privyJwtVerificationKey?.secretArn || '',
        CDN_URL: cdnUrl || '',
        ...activeUserLimitEnvVars,
      },
      bundling: {
        externalModules: ['@aws-sdk/*'],
        minify: true,
        sourceMap: true,
      },
      logRetention,
      tracing: lambda.Tracing.ACTIVE,
    });

    // Grant permissions to wallet auth handler
    this.table.grantReadWriteData(walletAuthHandler);
    // Grant permission to query GSI1 (for finding avatars by inhabitant wallet)
    walletAuthHandler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:Query'],
        resources: [`${this.table.tableArn}/index/GSI1`],
      })
    );
    if (heliusApiKeySecret) {
      heliusApiKeySecret.grantRead(walletAuthHandler);
    }
    if (privyAppSecret) {
      privyAppSecret.grantRead(walletAuthHandler);
    }
    if (privyJwtVerificationKey) {
      privyJwtVerificationKey.grantRead(walletAuthHandler);
    }

    const walletAuthIntegration = new integrations.HttpLambdaIntegration(
      'WalletAuthIntegration',
      walletAuthHandler
    );

    // Wallet auth routes
    this.api.addRoutes({
      path: '/auth/challenge',
      methods: [apigateway.HttpMethod.POST, apigateway.HttpMethod.OPTIONS],
      integration: walletAuthIntegration,
    });

    this.api.addRoutes({
      path: '/auth/verify',
      methods: [apigateway.HttpMethod.POST, apigateway.HttpMethod.OPTIONS],
      integration: walletAuthIntegration,
    });

    this.api.addRoutes({
      path: '/auth/me',
      methods: [apigateway.HttpMethod.GET, apigateway.HttpMethod.OPTIONS],
      integration: walletAuthIntegration,
    });

    this.api.addRoutes({
      path: '/auth/logout',
      methods: [apigateway.HttpMethod.POST, apigateway.HttpMethod.OPTIONS],
      integration: walletAuthIntegration,
    });

    // Wallet-link routes - link additional wallet identities to the current account
    this.api.addRoutes({
      path: '/auth/link/wallet/challenge',
      methods: [apigateway.HttpMethod.POST, apigateway.HttpMethod.OPTIONS],
      integration: walletAuthIntegration,
    });

    this.api.addRoutes({
      path: '/auth/link/wallet/verify',
      methods: [apigateway.HttpMethod.POST, apigateway.HttpMethod.OPTIONS],
      integration: walletAuthIntegration,
    });

    // Privy auth routes - for email/social login via Privy
    this.api.addRoutes({
      path: '/auth/privy/verify',
      methods: [apigateway.HttpMethod.POST, apigateway.HttpMethod.OPTIONS],
      integration: walletAuthIntegration,
    });

    this.api.addRoutes({
      path: '/auth/link/privy/verify',
      methods: [apigateway.HttpMethod.POST, apigateway.HttpMethod.OPTIONS],
      integration: walletAuthIntegration,
    });

    // Auth utility routes
    this.api.addRoutes({
      path: '/auth/gate-status',
      methods: [apigateway.HttpMethod.GET, apigateway.HttpMethod.OPTIONS],
      integration: walletAuthIntegration,
    });

    // Billing handler - Stripe checkout + customer portal + webhook sync
    const billingHandler = new nodejs.NodejsFunction(this, 'BillingHandler', {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, '../../../admin-api/src/handlers/billing.ts'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: {
        ADMIN_TABLE: this.table.tableName,
        NODE_ENV: environment,
        LOG_LEVEL: logLevel,
        ALLOWED_ORIGINS: allowedOrigins.join(','),
        AUTH_DOMAIN: adminDomain || 'admin.rati.chat',
        ADMIN_WALLETS: props.adminWallets || '',
        STRIPE_SECRET_KEY_ARN: stripeSecretKey?.secretArn || '',
        STRIPE_WEBHOOK_SECRET_ARN: stripeWebhookSecret?.secretArn || '',
        STRIPE_PRICE_ID_PRO: props.stripePriceIdPro || '',
        STRIPE_PRICE_ID_ENTERPRISE: props.stripePriceIdEnterprise || '',
        STRIPE_PRICE_ID_TEAM: props.stripePriceIdTeam || '',
        CDN_URL: cdnUrl || '',
        ...activeUserLimitEnvVars,
      },
      bundling: {
        externalModules: ['@aws-sdk/*'],
        minify: true,
        sourceMap: true,
      },
      logRetention,
      tracing: lambda.Tracing.ACTIVE,
    });

    this.table.grantReadWriteData(billingHandler);
    if (stripeSecretKey) {
      stripeSecretKey.grantRead(billingHandler);
    }
    if (stripeWebhookSecret) {
      stripeWebhookSecret.grantRead(billingHandler);
    }

    const billingIntegration = new integrations.HttpLambdaIntegration(
      'BillingIntegration',
      billingHandler
    );

    this.api.addRoutes({
      path: '/billing/checkout',
      methods: [apigateway.HttpMethod.POST, apigateway.HttpMethod.OPTIONS],
      integration: billingIntegration,
    });

    this.api.addRoutes({
      path: '/billing/portal',
      methods: [apigateway.HttpMethod.POST, apigateway.HttpMethod.OPTIONS],
      integration: billingIntegration,
    });

    // Public webhook endpoint (signature-verified in handler)
    this.api.addRoutes({
      path: '/webhook/stripe',
      methods: [apigateway.HttpMethod.POST, apigateway.HttpMethod.OPTIONS],
      integration: billingIntegration,
    });

    // Consent handler - privacy-policy consent persistence
    const consentHandler = new nodejs.NodejsFunction(this, 'ConsentHandler', {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, '../../../admin-api/src/handlers/consent.ts'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(10),
      memorySize: 128,
      environment: {
        ADMIN_TABLE: this.table.tableName,
        NODE_ENV: environment,
        LOG_LEVEL: logLevel,
        ALLOWED_ORIGINS: allowedOrigins.join(','),
        AUTH_DOMAIN: adminDomain || 'admin.rati.chat',
        ...activeUserLimitEnvVars,
      },
      bundling: {
        externalModules: ['@aws-sdk/*'],
        minify: true,
        sourceMap: true,
      },
      logRetention,
      tracing: lambda.Tracing.ACTIVE,
    });

    this.table.grantReadWriteData(consentHandler);

    const consentIntegration = new integrations.HttpLambdaIntegration(
      'ConsentIntegration',
      consentHandler,
    );

    this.api.addRoutes({
      path: '/consent',
      methods: [apigateway.HttpMethod.GET, apigateway.HttpMethod.POST, apigateway.HttpMethod.OPTIONS],
      integration: consentIntegration,
    });

    this.api.addRoutes({
      path: '/consent/revoke',
      methods: [apigateway.HttpMethod.POST, apigateway.HttpMethod.OPTIONS],
      integration: consentIntegration,
    });

    // Telegram webhook handler - MUST use shared @swarm/handlers multi-tenant webhook.
    // The legacy admin-api implementation has been removed.
    if (!props.telegramWebhookFunction) {
      throw new Error(
        'AdminApiConstruct requires telegramWebhookFunction (SharedHandlers.telegramWebhook). '
        + 'Create SharedHandlers and pass its telegramWebhook into AdminApiConstruct.'
      );
    }
    const telegramWebhookHandler: lambda.IFunction = props.telegramWebhookFunction;

    // Dream worker: consumes from dreamQueue and writes dream state
    this.dreamWorker = new nodejs.NodejsFunction(this, 'DreamWorkerHandler', {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, '../../../admin-api/src/handlers/dream-worker.ts'),
      handler: 'handler',
      timeout: cdk.Duration.minutes(5),
      memorySize: 512,
      reservedConcurrentExecutions: 5,
      layers: dependencyLayer ? [dependencyLayer] : undefined,
      environment: {
        ADMIN_TABLE: this.table.tableName,
        STATE_TABLE: stateTable?.tableName || '',
        LLM_API_KEY_SECRET_ARN: llmApiKey.secretArn,
        // Match chat/telegram model unless overridden at runtime
        LLM_MODEL: 'anthropic/claude-haiku-4.5',
        NODE_ENV: environment,
        LOG_LEVEL: logLevel,
        NODE_OPTIONS: '--enable-source-maps',
        CDN_URL: cdnUrl || '',
        ...activeUserLimitEnvVars,
      },
      bundling: {
        externalModules: ['@aws-sdk/*'],
        minify: true,
        sourceMap: true,
      },
      logRetention,
      tracing: lambda.Tracing.ACTIVE,
    });

    this.table.grantReadWriteData(this.dreamWorker);
    if (stateTable) {
      stateTable.grantReadWriteData(this.dreamWorker);
    }
    llmApiKey.grantRead(this.dreamWorker);
    dreamQueue.grantConsumeMessages(this.dreamWorker);

    // Grant Bedrock access for embeddings (used in dream memory search)
    this.dreamWorker.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['bedrock:InvokeModel'],
      resources: ['arn:aws:bedrock:*::foundation-model/amazon.titan-embed-text-v2:0'],
    }));

    // Ensure the worker processes one SQS message per invocation (avoid whole-batch retries)
    this.dreamWorker.addEventSource(new lambdaEventSources.SqsEventSource(dreamQueue, {
      batchSize: 1,
    }));

    // Memory Consolidation Worker: scheduled daily to decay/promote/evolve memories
    this.consolidationWorker = new nodejs.NodejsFunction(this, 'ConsolidationWorkerHandler', {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, '../../../admin-api/src/handlers/consolidation-worker.ts'),
      handler: 'handler',
      timeout: cdk.Duration.minutes(10),
      memorySize: 512,
      layers: dependencyLayer ? [dependencyLayer] : undefined,
      environment: {
        ADMIN_TABLE: this.table.tableName,
        STATE_TABLE: stateTable?.tableName || '',
        LLM_API_KEY_SECRET_ARN: llmApiKey.secretArn,
        OPENROUTER_API_KEY: '', // Populated from secret at runtime
        CONSOLIDATION_MODEL: 'anthropic/claude-3-5-haiku-latest',
        NODE_ENV: environment,
        LOG_LEVEL: logLevel,
        CDN_URL: cdnUrl || '',
        ...activeUserLimitEnvVars,
      },
      bundling: {
        externalModules: ['@aws-sdk/*'],
        minify: true,
        sourceMap: true,
      },
      logRetention,
      tracing: lambda.Tracing.ACTIVE,
    });

    this.table.grantReadWriteData(this.consolidationWorker);
    if (stateTable) {
      stateTable.grantReadData(this.consolidationWorker);
    }
    llmApiKey.grantRead(this.consolidationWorker);

    // Grant Bedrock access for embeddings (used in identity evolution memory search)
    this.consolidationWorker.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['bedrock:InvokeModel'],
      resources: ['arn:aws:bedrock:*::foundation-model/amazon.titan-embed-text-v2:0'],
    }));

    // Schedule consolidation to run daily at 3 AM UTC
    new events.Rule(this, 'ConsolidationSchedule', {
      schedule: events.Schedule.cron({
        minute: '0',
        hour: '3',
        day: '*',
        month: '*',
      }),
      targets: [new targets.LambdaFunction(this.consolidationWorker, {
        deadLetterQueue: this.consolidationDlq,
        retryAttempts: 2,
        maxEventAge: cdk.Duration.hours(2),
      })],
      description: 'Daily memory consolidation for all avatars',
    });

    // Metadata Evolution Worker: scheduled monthly to evolve Ascension NFT metadata
    const metadataEvolutionWorker = new nodejs.NodejsFunction(this, 'MetadataEvolutionHandler', {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, '../../../admin-api/src/handlers/metadata-evolution.ts'),
      handler: 'handler',
      timeout: cdk.Duration.minutes(10),
      memorySize: 512,
      layers: dependencyLayer ? [dependencyLayer] : undefined,
      environment: {
        ADMIN_TABLE: this.table.tableName,
        ARWEAVE_NETWORK: environment === 'production' ? 'mainnet' : 'devnet',
        ARWEAVE_WALLET_SECRET: `${props.secretPrefix || 'swarm'}/arweave-wallet`,
        EVOLUTION_COOLDOWN_DAYS: '7',
        NODE_ENV: environment,
        LOG_LEVEL: logLevel,
      },
      bundling: {
        externalModules: ['@aws-sdk/*'],
        minify: true,
        sourceMap: true,
      },
      logRetention,
      tracing: lambda.Tracing.ACTIVE,
    });

    this.table.grantReadWriteData(metadataEvolutionWorker);

    // Grant Secrets Manager access for the Arweave wallet keypair
    metadataEvolutionWorker.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['secretsmanager:GetSecretValue'],
      resources: [`arn:aws:secretsmanager:*:*:secret:${props.secretPrefix || 'swarm'}/arweave-wallet*`],
    }));

    // Schedule metadata evolution: 1st of every month at 4 AM UTC
    new events.Rule(this, 'MetadataEvolutionSchedule', {
      schedule: events.Schedule.cron({
        minute: '0',
        hour: '4',
        day: '1',
        month: '*',
      }),
      targets: [new targets.LambdaFunction(metadataEvolutionWorker, {
        deadLetterQueue: this.consolidationDlq,
        retryAttempts: 2,
        maxEventAge: cdk.Duration.hours(2),
      })],
      description: 'Monthly Ascension NFT metadata evolution',
    });

    const telegramIntegration = new integrations.HttpLambdaIntegration(
      'TelegramWebhookIntegration',
      telegramWebhookHandler
    );

    // Webhook route: /webhook/telegram/{avatarId}
    this.api.addRoutes({
      path: '/webhook/telegram/{avatarId}',
      methods: [apigateway.HttpMethod.POST],
      integration: telegramIntegration,
    });

    // Raticross relay route: /relay/inbound
    if (props.raticrossRelayFunction) {
      const raticrossIntegration = new integrations.HttpLambdaIntegration(
        'RaticrossRelayIntegration',
        props.raticrossRelayFunction,
      );

      this.api.addRoutes({
        path: '/relay/inbound',
        methods: [apigateway.HttpMethod.POST],
        integration: raticrossIntegration,
      });
    }

    // Replicate webhook handler - for async video generation callbacks
    const replicateWebhookHandler = new nodejs.NodejsFunction(this, 'ReplicateWebhookHandler', {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, '../../../admin-api/src/handlers/replicate-webhook.ts'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(60),
      memorySize: 512,
      environment: {
        ADMIN_TABLE: this.table.tableName,
        MEDIA_BUCKET: mediaBucket?.bucketName || '',
        CDN_URL: cdnUrl || '',
        RESPONSE_QUEUE_URL: responseQueue.queueUrl,
        REPLICATE_WEBHOOK_SECRET: replicateWebhookSecret,
        NODE_ENV: environment,
        LOG_LEVEL: logLevel,
        ...activeUserLimitEnvVars,
      },
      bundling: {
        externalModules: ['@aws-sdk/*'],
        minify: true,
        sourceMap: true,
      },
      logRetention,
      tracing: lambda.Tracing.ACTIVE,
    });

    // Grant permissions to Replicate webhook handler
    this.table.grantReadWriteData(replicateWebhookHandler);
    if (mediaBucket) {
      mediaBucket.grantReadWrite(replicateWebhookHandler);
    }
    responseQueue.grantSendMessages(replicateWebhookHandler);

    const replicateIntegration = new integrations.HttpLambdaIntegration(
      'ReplicateWebhookIntegration',
      replicateWebhookHandler
    );

    // Webhook route: /webhook/replicate (with jobId query param)
    this.api.addRoutes({
      path: '/webhook/replicate',
      methods: [apigateway.HttpMethod.POST],
      integration: replicateIntegration,
    });

    // Response Sender Lambda - delivers generated media to platforms
    // Triggered by SQS messages from the Replicate webhook handler
    this.responseSenderHandler = new nodejs.NodejsFunction(this, 'ResponseSenderHandler', {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, '../../../admin-api/src/handlers/response-sender.ts'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(60),
      memorySize: 256,
      environment: {
        ADMIN_TABLE: this.table.tableName,
        NODE_ENV: environment,
        LOG_LEVEL: logLevel,
        CDN_URL: cdnUrl || '',
        ...activeUserLimitEnvVars,
      },
      bundling: {
        externalModules: ['@aws-sdk/*'],
        minify: true,
        sourceMap: true,
      },
      logRetention,
      tracing: lambda.Tracing.ACTIVE,
    });

    // Grant permissions to response sender
    this.table.grantReadData(this.responseSenderHandler);

    // Grant secrets manager access (for bot tokens)
    this.responseSenderHandler.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['secretsmanager:GetSecretValue'],
      resources: [
        ...secretArnPatterns,
      ],
    }));

    // KMS permissions for Secrets Manager (customer-managed keys in some envs)
    // Required when secrets are encrypted with a CMK (e.g. admin secrets key in staging).
    // Scoped to keys in this account/region to limit blast radius.
    this.responseSenderHandler.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'kms:Decrypt',
        'kms:GenerateDataKey',
      ],
      resources: [kmsKeyArnPattern],
      conditions: {
        StringEquals: {
          'kms:ViaService': `secretsmanager.${cdk.Stack.of(this).region}.amazonaws.com`,
        },
      },
    }));

    // Add SQS trigger
    this.responseSenderHandler.addEventSource(new lambdaEventSources.SqsEventSource(responseQueue, {
      batchSize: 5,
      maxBatchingWindow: cdk.Duration.seconds(5),
    }));

    // Twitter OAuth handler - for connecting X/Twitter accounts via OAuth 1.0a
    const twitterOAuthHandler = new nodejs.NodejsFunction(this, 'TwitterOAuthHandler', {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, '../../../admin-api/src/handlers/twitter-oauth.ts'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: {
        ADMIN_TABLE: this.table.tableName,
        ADMIN_EMAILS: adminEmails,
        NODE_ENV: environment,
        LOG_LEVEL: logLevel,
        ALLOWED_ORIGINS: allowedOrigins.join(','),
        ADMIN_UI_URL: allowedOrigins[0] || 'http://localhost:5173',
        SECRET_PREFIX: secretPrefix,
        // Internal testing (non-production only)
        INTERNAL_TEST_KEY: internalTestKey,
        // Twitter App credentials from Secrets Manager
        TWITTER_APP_CREDENTIALS_ARN: twitterAppCredentialsSecret.secretArn,
        TWITTER_OAUTH_CALLBACK_URL: twitterOAuthCallbackUrl,
        CDN_URL: cdnUrl || '',
        ...activeUserLimitEnvVars,
      },
      bundling: {
        externalModules: ['@aws-sdk/*'],
        minify: true,
        sourceMap: true,
      },
      logRetention,
      tracing: lambda.Tracing.ACTIVE,
    });

    // Grant read access to Twitter app credentials
    twitterAppCredentialsSecret.grantRead(twitterOAuthHandler);

    // Grant permissions to Twitter OAuth handler
    this.table.grantReadWriteData(twitterOAuthHandler);
    if (stateTable) {
      stateTable.grantReadWriteData(twitterOAuthHandler);
    }

    // Grant Secrets Manager permissions for storing Twitter tokens
    twitterOAuthHandler.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
        actions: ['secretsmanager:CreateSecret'],
        resources: ['*'],
        conditions: {
          'StringLike': {
            'secretsmanager:Name': secretNamePatterns,
          },
        },
      }));

    twitterOAuthHandler.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'secretsmanager:UpdateSecret',
        'secretsmanager:PutSecretValue',
        'secretsmanager:DeleteSecret',
        'secretsmanager:DescribeSecret',
        'secretsmanager:GetSecretValue',
        'secretsmanager:TagResource',
      ],
      resources: [
        ...secretArnPatterns,
      ],
    }));

    // KMS permissions for Secrets Manager (AWS-managed key)
    twitterOAuthHandler.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'kms:Decrypt',
        'kms:GenerateDataKey',
        'kms:GenerateDataKeyWithoutPlaintext',
      ],
      resources: [kmsKeyArnPattern],
      conditions: {
        StringEquals: {
          'kms:ViaService': `secretsmanager.${cdk.Stack.of(this).region}.amazonaws.com`,
        },
      },
    }));

    const twitterOAuthIntegration = new integrations.HttpLambdaIntegration(
      'TwitterOAuthIntegration',
      twitterOAuthHandler
    );

    // Twitter OAuth routes
    this.api.addRoutes({
      path: '/oauth/twitter/start',
      methods: [apigateway.HttpMethod.GET],
      integration: twitterOAuthIntegration,
    });

    this.api.addRoutes({
      path: '/oauth/twitter/callback',
      methods: [apigateway.HttpMethod.GET],
      integration: twitterOAuthIntegration,
    });

    this.api.addRoutes({
      path: '/oauth/twitter/status/{avatarId}',
      methods: [apigateway.HttpMethod.GET],
      integration: twitterOAuthIntegration,
    });

    this.api.addRoutes({
      path: '/oauth/twitter/{avatarId}',
      methods: [apigateway.HttpMethod.DELETE],
      integration: twitterOAuthIntegration,
    });

    // Configure log group prefixes for the consolidated logs endpoint
    // This allows querying logs across all admin API handlers for a given avatar
    const stackPrefix = cdk.Stack.of(this).stackName;
    avatarsHandler.addEnvironment('ADMIN_LOG_GROUPS', '');
    avatarsHandler.addEnvironment('LOG_GROUP_PREFIX', '/aws/lambda/');
    avatarsHandler.addEnvironment('ADMIN_LOG_GROUP_PREFIXES', [
      `/aws/lambda/${stackPrefix}-AdminApi`,  // All admin API handlers (chat, avatars, telegram)
    ].join(','));

    // Custom domain configuration
    if (props.apiDomain && props.apiCertificateArn) {
      const certificate = acm.Certificate.fromCertificateArn(
        this, 'ApiCertificate', props.apiCertificateArn
      );

      this.customDomain = new apigateway.DomainName(this, 'ApiDomain', {
        domainName: props.apiDomain,
        certificate,
      });

      new apigateway.ApiMapping(this, 'ApiMapping', {
        api: this.api,
        domainName: this.customDomain,
      });

      new cdk.CfnOutput(this, 'ApiCustomDomain', {
        value: props.apiDomain,
        description: 'Admin API custom domain',
        exportName: `swarm-admin-api-domain-${environment}${suffix}`,
      });

      new cdk.CfnOutput(this, 'ApiDomainTarget', {
        value: this.customDomain.regionalDomainName,
        description: 'Target for CNAME record',
        exportName: `swarm-admin-api-target-${environment}${suffix}`,
      });
    }

    // ========================================================================
    // CloudWatch Alarms
    // ========================================================================
    const alarmPrefix = `swarm-${environment}-admin`;
    const snsAction = props.alarmTopic ? new cw_actions.SnsAction(props.alarmTopic) : undefined;

    // DLQ depth alarms (threshold: >0 messages — any message in DLQ is actionable)
    // 1-minute evaluation period for fastest possible detection.
    // See RUNBOOK.md Section 3 "SQS DLQ Recovery" for triage steps.
    const responseDlqAlarm = new cloudwatch.Alarm(this, 'ResponseDlqDepthAlarm', {
      alarmName: `${alarmPrefix}-response-dlq-depth`,
      alarmDescription:
        'Messages detected in the admin response DLQ. Admin API response delivery is failing. ' +
        'Runbook: docs/RUNBOOK.md § 3 "SQS DLQ Recovery" — inspect, correlate, and redrive.',
      metric: this.responseDlq.metricApproximateNumberOfMessagesVisible({
        period: cdk.Duration.minutes(1),
      }),
      threshold: 0,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    const chatDlqAlarm = new cloudwatch.Alarm(this, 'ChatDlqDepthAlarm', {
      alarmName: `${alarmPrefix}-chat-dlq-depth`,
      alarmDescription:
        'Messages detected in the admin chat DLQ. Chat worker message processing is failing. ' +
        'Runbook: docs/RUNBOOK.md § 3 "SQS DLQ Recovery" — inspect, correlate, and redrive.',
      metric: this.chatDlq.metricApproximateNumberOfMessagesVisible({
        period: cdk.Duration.minutes(1),
      }),
      threshold: 0,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    const dreamDlqAlarm = new cloudwatch.Alarm(this, 'DreamDlqDepthAlarm', {
      alarmName: `${alarmPrefix}-dream-dlq-depth`,
      alarmDescription:
        'Messages detected in the admin dream DLQ. Dream worker processing is failing. ' +
        'Runbook: docs/RUNBOOK.md § 3 "SQS DLQ Recovery" — inspect, correlate, and redrive.',
      metric: this.dreamDlq.metricApproximateNumberOfMessagesVisible({
        period: cdk.Duration.minutes(1),
      }),
      threshold: 0,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    const consolidationDlqAlarm = new cloudwatch.Alarm(this, 'ConsolidationDlqDepthAlarm', {
      alarmName: `${alarmPrefix}-consolidation-dlq-depth`,
      alarmDescription:
        'Messages detected in the admin consolidation DLQ. Memory consolidation scheduling is failing. ' +
        'Runbook: docs/RUNBOOK.md § 3 "SQS DLQ Recovery" — inspect, correlate, and redrive.',
      metric: this.consolidationDlq.metricApproximateNumberOfMessagesVisible({
        period: cdk.Duration.minutes(1),
      }),
      threshold: 0,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // Lambda error alarms for critical handlers
    const chatWorkerErrorsAlarm = new cloudwatch.Alarm(this, 'ChatWorkerErrorsAlarm', {
      alarmName: `${alarmPrefix}-chat-worker-errors`,
      metric: this.chatWorkerHandler.metricErrors({
        period: cdk.Duration.minutes(5),
      }),
      threshold: 1,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    const responseSenderErrorsAlarm = new cloudwatch.Alarm(this, 'ResponseSenderErrorsAlarm', {
      alarmName: `${alarmPrefix}-response-sender-errors`,
      metric: this.responseSenderHandler.metricErrors({
        period: cdk.Duration.minutes(5),
      }),
      threshold: 1,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    const dreamWorkerErrorsAlarm = new cloudwatch.Alarm(this, 'DreamWorkerErrorsAlarm', {
      alarmName: `${alarmPrefix}-dream-worker-errors`,
      metric: this.dreamWorker.metricErrors({
        period: cdk.Duration.minutes(5),
      }),
      threshold: 1,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    const openaiCompatErrorsAlarm = new cloudwatch.Alarm(this, 'OpenAICompatErrorsAlarm', {
      alarmName: `${alarmPrefix}-openai-compat-errors`,
      metric: this.openaiCompatHandler.metricErrors({
        period: cdk.Duration.minutes(5),
      }),
      threshold: 1,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // Public profile handler error alarm (public-facing, silent failures affect SEO/users)
    const publicProfileErrorsAlarm = new cloudwatch.Alarm(this, 'PublicProfileErrorsAlarm', {
      alarmName: `${alarmPrefix}-public-profile-errors`,
      metric: publicProfileHandler.metricErrors({
        period: cdk.Duration.minutes(5),
      }),
      threshold: 1,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // Leaderboard handler error alarm (public-facing)
    const leaderboardErrorsAlarm = new cloudwatch.Alarm(this, 'LeaderboardErrorsAlarm', {
      alarmName: `${alarmPrefix}-leaderboard-errors`,
      metric: leaderboardHandler.metricErrors({
        period: cdk.Duration.minutes(5),
      }),
      threshold: 1,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // Bedrock embedding invocation errors (used by dream worker and consolidation worker)
    // A custom metric alarm on the Bedrock InvocationErrors dimension catches silent
    // degradation of the embedding pipeline that Lambda-level error alarms may miss
    // (e.g., the Lambda succeeds but the Bedrock call inside it returns an error that
    // is caught and logged rather than thrown).
    const bedrockEmbeddingErrorsAlarm = new cloudwatch.Alarm(this, 'BedrockEmbeddingErrorsAlarm', {
      alarmName: `${alarmPrefix}-bedrock-embedding-errors`,
      metric: new cloudwatch.Metric({
        namespace: 'AWS/Bedrock',
        metricName: 'InvocationClientErrors',
        dimensionsMap: {
          ModelId: 'amazon.titan-embed-text-v2:0',
        },
        period: cdk.Duration.minutes(15),
        statistic: 'Sum',
      }),
      threshold: 1,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // Entitlement fallback alarm (issue #232)
    // Fires when getEntitlement fails repeatedly and the system degrades to free tier.
    // The EMF metric is emitted by the entitlements service under the Swarm namespace.
    const entitlementFallbackAlarm = new cloudwatch.Alarm(this, 'EntitlementFallbackAlarm', {
      alarmName: `${alarmPrefix}-entitlement-fallback`,
      alarmDescription:
        'Entitlement lookups are failing and falling back to free tier defaults. ' +
        'Check IAM permissions on the admin table GSI1 and DynamoDB health.',
      metric: new cloudwatch.Metric({
        namespace: 'Swarm',
        metricName: 'EntitlementFallback',
        dimensionsMap: {
          Subsystem: 'Entitlements',
        },
        period: cdk.Duration.minutes(15),
        statistic: 'Sum',
      }),
      threshold: 5,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // -----------------------------------------------------------------------
    // Lambda throttle alarms
    // Any throttle indicates concurrency exhaustion — alert immediately.
    // The chat worker is particularly important as it powers the admin UI.
    // -----------------------------------------------------------------------
    const chatWorkerThrottlesAlarm = new cloudwatch.Alarm(this, 'ChatWorkerThrottlesAlarm', {
      alarmName: `${alarmPrefix}-chat-worker-throttles`,
      alarmDescription: 'Chat worker Lambda is being throttled — admin UI users will experience failures.',
      metric: this.chatWorkerHandler.metricThrottles({
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
      alarmDescription: 'Admin response sender Lambda is being throttled.',
      metric: this.responseSenderHandler.metricThrottles({
        period: cdk.Duration.minutes(5),
      }),
      threshold: 0,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    const dreamWorkerThrottlesAlarm = new cloudwatch.Alarm(this, 'DreamWorkerThrottlesAlarm', {
      alarmName: `${alarmPrefix}-dream-worker-throttles`,
      alarmDescription: 'Dream worker Lambda is being throttled.',
      metric: this.dreamWorker.metricThrottles({
        period: cdk.Duration.minutes(5),
      }),
      threshold: 0,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    const openaiCompatThrottlesAlarm = new cloudwatch.Alarm(this, 'OpenAICompatThrottlesAlarm', {
      alarmName: `${alarmPrefix}-openai-compat-throttles`,
      alarmDescription: 'OpenAI-compatible endpoint Lambda is being throttled.',
      metric: this.openaiCompatHandler.metricThrottles({
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
    //   - Production: 60s for chat worker (timeout 600s via SQS visibility),
    //     30s for response sender, 60s for dream worker
    //   - Staging: 2x production thresholds to reduce noise
    // Admin Lambdas get higher thresholds than shared handlers because they
    // call LLMs with tool-use loops that are inherently slower.
    // -----------------------------------------------------------------------
    const adminDurationThresholds = isProd
      ? { chatWorker: 60_000, responseSender: 30_000, dreamWorker: 60_000, openaiCompat: 60_000 }
      : { chatWorker: 120_000, responseSender: 60_000, dreamWorker: 120_000, openaiCompat: 120_000 };

    const chatWorkerDurationAlarm = new cloudwatch.Alarm(this, 'ChatWorkerDurationAlarm', {
      alarmName: `${alarmPrefix}-chat-worker-duration-p95`,
      alarmDescription:
        `Chat worker p95 latency > ${adminDurationThresholds.chatWorker / 1000}s. ` +
        'Investigate LLM tool-call depth or DynamoDB latency.',
      metric: this.chatWorkerHandler.metricDuration({
        period: cdk.Duration.minutes(5),
        statistic: 'p95',
      }),
      threshold: adminDurationThresholds.chatWorker,
      evaluationPeriods: 3,
      datapointsToAlarm: 2,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    const adminResponseSenderDurationAlarm = new cloudwatch.Alarm(this, 'AdminResponseSenderDurationAlarm', {
      alarmName: `${alarmPrefix}-response-sender-duration-p95`,
      alarmDescription:
        `Admin response sender p95 latency > ${adminDurationThresholds.responseSender / 1000}s. ` +
        'Check downstream API latency.',
      metric: this.responseSenderHandler.metricDuration({
        period: cdk.Duration.minutes(5),
        statistic: 'p95',
      }),
      threshold: adminDurationThresholds.responseSender,
      evaluationPeriods: 3,
      datapointsToAlarm: 2,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    const dreamWorkerDurationAlarm = new cloudwatch.Alarm(this, 'DreamWorkerDurationAlarm', {
      alarmName: `${alarmPrefix}-dream-worker-duration-p95`,
      alarmDescription:
        `Dream worker p95 latency > ${adminDurationThresholds.dreamWorker / 1000}s. ` +
        'Investigate LLM or embedding pipeline latency.',
      metric: this.dreamWorker.metricDuration({
        period: cdk.Duration.minutes(5),
        statistic: 'p95',
      }),
      threshold: adminDurationThresholds.dreamWorker,
      evaluationPeriods: 3,
      datapointsToAlarm: 2,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    const openaiCompatDurationAlarm = new cloudwatch.Alarm(this, 'OpenAICompatDurationAlarm', {
      alarmName: `${alarmPrefix}-openai-compat-duration-p95`,
      alarmDescription:
        `OpenAI-compat endpoint p95 latency > ${adminDurationThresholds.openaiCompat / 1000}s. ` +
        'Check LLM provider response times.',
      metric: this.openaiCompatHandler.metricDuration({
        period: cdk.Duration.minutes(5),
        statistic: 'p95',
      }),
      threshold: adminDurationThresholds.openaiCompat,
      evaluationPeriods: 3,
      datapointsToAlarm: 2,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // -----------------------------------------------------------------------
    // SQS age-of-oldest-message alarms
    // Tracks how long the oldest message has been waiting in the queue.
    // A growing age indicates consumers are falling behind or stalled.
    // Thresholds:
    //   - Production: 300s (5 min) — tight; stale messages degrade admin UX
    //   - Staging: 600s (10 min) — relaxed to reduce noise
    // Chat queue gets a higher threshold because chat worker invocations
    // can be long-running (LLM tool-use loops).
    // -----------------------------------------------------------------------
    const adminQueueAgeThreshold = isProd ? 300 : 600;
    const adminChatQueueAgeThreshold = isProd ? 600 : 1200;

    const chatQueueAgeAlarm = new cloudwatch.Alarm(this, 'ChatQueueAgeAlarm', {
      alarmName: `${alarmPrefix}-chat-queue-age`,
      alarmDescription:
        `Oldest message in chat queue > ${adminChatQueueAgeThreshold}s. ` +
        'Chat worker may be stalled or concurrency exhausted.',
      metric: chatQueue.metricApproximateAgeOfOldestMessage({
        period: cdk.Duration.minutes(5),
      }),
      threshold: adminChatQueueAgeThreshold,
      evaluationPeriods: 2,
      datapointsToAlarm: 2,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    const adminResponseQueueAgeAlarm = new cloudwatch.Alarm(this, 'ResponseQueueAgeAlarm', {
      alarmName: `${alarmPrefix}-response-queue-age`,
      alarmDescription:
        `Oldest message in response queue > ${adminQueueAgeThreshold}s. ` +
        'Response sender may be stalled.',
      metric: responseQueue.metricApproximateAgeOfOldestMessage({
        period: cdk.Duration.minutes(5),
      }),
      threshold: adminQueueAgeThreshold,
      evaluationPeriods: 2,
      datapointsToAlarm: 2,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    const dreamQueueAgeAlarm = new cloudwatch.Alarm(this, 'DreamQueueAgeAlarm', {
      alarmName: `${alarmPrefix}-dream-queue-age`,
      alarmDescription:
        `Oldest message in dream queue > ${adminQueueAgeThreshold}s. ` +
        'Dream worker may be stalled.',
      metric: dreamQueue.metricApproximateAgeOfOldestMessage({
        period: cdk.Duration.minutes(5),
      }),
      threshold: adminQueueAgeThreshold,
      evaluationPeriods: 2,
      datapointsToAlarm: 2,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // Wire all alarms to SNS topic for notifications
    if (snsAction) {
      for (const alarm of [
        responseDlqAlarm,
        chatDlqAlarm,
        dreamDlqAlarm,
        consolidationDlqAlarm,
        chatWorkerErrorsAlarm,
        responseSenderErrorsAlarm,
        dreamWorkerErrorsAlarm,
        openaiCompatErrorsAlarm,
        publicProfileErrorsAlarm,
        leaderboardErrorsAlarm,
        bedrockEmbeddingErrorsAlarm,
        entitlementFallbackAlarm,
        chatWorkerThrottlesAlarm,
        responseSenderThrottlesAlarm,
        dreamWorkerThrottlesAlarm,
        openaiCompatThrottlesAlarm,
        chatWorkerDurationAlarm,
        adminResponseSenderDurationAlarm,
        dreamWorkerDurationAlarm,
        openaiCompatDurationAlarm,
        chatQueueAgeAlarm,
        adminResponseQueueAgeAlarm,
        dreamQueueAgeAlarm,
      ]) {
        alarm.addAlarmAction(snsAction);
      }
    }

    // ========================================================================
    // GitHub Issue Sync (DynamoDB Streams → GitHub REST API)
    // ========================================================================
    // Replaces the polling-based sync-runtime-issues.yml cron workflow.
    // When a new ISSUE#<id>/META record is inserted into the admin table,
    // this Lambda creates a corresponding GitHub issue within seconds.
    if (props.githubTokenSecretArn) {
      const githubTokenSecret = secretsmanager.Secret.fromSecretCompleteArn(
        this, 'GitHubTokenSecret', props.githubTokenSecretArn,
      );

      const handlersEntry = path.join(__dirname, '../../../handlers/src');

      const githubIssueSyncLogGroup = new logs.LogGroup(this, 'GitHubIssueSyncLogGroup', {
        logGroupName: `/aws/lambda/swarm-${environment}${suffix}-github-issue-sync`,
        retention: logRetention,
        removalPolicy: isPersistentEnv ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      });

      const githubIssueSyncFn = new nodejs.NodejsFunction(this, 'GitHubIssueSync', {
        functionName: `swarm-${environment}${suffix}-github-issue-sync`,
        runtime: lambda.Runtime.NODEJS_20_X,
        entry: path.join(handlersEntry, 'issue-sync/github-issue-sync.ts'),
        handler: 'handler',
        layers: dependencyLayer ? [dependencyLayer] : undefined,
        timeout: cdk.Duration.seconds(60),
        memorySize: 256,
        environment: {
          ADMIN_TABLE: this.table.tableName,
          GITHUB_TOKEN_SECRET_ARN: props.githubTokenSecretArn,
          GITHUB_REPO: props.githubRepo || 'cenetex/aws-swarm',
          ENVIRONMENT: environment,
          LOG_LEVEL: logLevel,
          NODE_OPTIONS: '--enable-source-maps',
        },
        bundling: {
          externalModules: ['@aws-sdk/*'],
          minify: true,
          sourceMap: true,
        },
        tracing: lambda.Tracing.ACTIVE,
        logGroup: githubIssueSyncLogGroup,
      });

      // Grant permissions
      this.table.grantReadWriteData(githubIssueSyncFn);
      githubTokenSecret.grantRead(githubIssueSyncFn);
      // Also grant chat handler read access for MCP issue tracking tools
      githubTokenSecret.grantRead(this.chatHandler);

      // Wire DynamoDB Streams event source with filter for ISSUE#/META inserts.
      // The filter uses DynamoDB JSON format for stream record matching.
      githubIssueSyncFn.addEventSource(
        new lambdaEventSources.DynamoEventSource(this.table, {
          startingPosition: lambda.StartingPosition.TRIM_HORIZON,
          batchSize: 10,
          maxBatchingWindow: cdk.Duration.seconds(30),
          retryAttempts: 3,
          bisectBatchOnError: true,
          reportBatchItemFailures: true,
          filters: [
            lambda.FilterCriteria.filter({
              eventName: lambda.FilterRule.isEqual('INSERT'),
              dynamodb: {
                NewImage: {
                  pk: { S: lambda.FilterRule.beginsWith('ISSUE#') },
                  sk: { S: lambda.FilterRule.isEqual('META') },
                },
              },
            }),
          ],
        }),
      );

      // CloudWatch alarm for sync errors
      const githubIssueSyncErrorsAlarm = new cloudwatch.Alarm(this, 'GitHubIssueSyncErrorsAlarm', {
        alarmName: `swarm-${environment}-admin-github-issue-sync-errors`,
        metric: githubIssueSyncFn.metricErrors({
          period: cdk.Duration.minutes(5),
        }),
        threshold: 1,
        evaluationPeriods: 1,
        datapointsToAlarm: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });

      if (snsAction) {
        githubIssueSyncErrorsAlarm.addAlarmAction(snsAction);
      }
    }

    // Outputs
    new cdk.CfnOutput(this, 'ApiEndpoint', {
      value: props.apiDomain ? `https://${props.apiDomain}` : this.api.apiEndpoint,
      description: 'Admin API endpoint URL',
      exportName: `swarm-admin-api-url-${environment}${suffix}`,
    });

    new cdk.CfnOutput(this, 'AdminTableName', {
      value: this.table.tableName,
      description: 'DynamoDB table name for admin data',
    });

  }
}
