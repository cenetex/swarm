/**
 * CDK Construct for Admin API Infrastructure
 */
import { Construct } from 'constructs';
import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as apigateway from 'aws-cdk-lib/aws-apigatewayv2';
import * as integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as path from 'path';
import { fileURLToPath } from 'url';

// ESM equivalent of __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';

export interface AdminApiConstructProps {
  /**
   * Cloudflare Access team domain (e.g., 'yourteam.cloudflareaccess.com')
   */
  cloudflareTeamDomain: string;

  /**
   * Comma-separated list of admin emails
   */
  adminEmails: string;

  /**
   * Global OpenRouter API key (stored in Secrets Manager)
   */
  openRouterApiKeyArn?: string;

  /**
   * Global Replicate API key (stored in Secrets Manager)
   * Used for image/video generation with a trial limit per agent
   */
  replicateApiKeyArn?: string;

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
   * Environment (development/production)
   */
  environment?: string;

  /**
   * Admin UI domain for CORS (e.g., 'admin.example.com')
   */
  adminDomain?: string;

  /**
   * Custom domain for the API (e.g., 'api.example.com')
   */
  apiDomain?: string;

  /**
   * ACM certificate ARN for the API custom domain
   */
  apiCertificateArn?: string;

  /**
   * Shared state table for syncing agent configs to handlers
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
}

export class AdminApiConstruct extends Construct {
  public readonly api: apigateway.HttpApi;
  public readonly customDomain?: apigateway.DomainName;
  public readonly table: dynamodb.Table;
  public readonly encryptionKey: kms.Key;
  public readonly chatHandler: lambda.Function;

  constructor(scope: Construct, id: string, props: AdminApiConstructProps) {
    super(scope, id);

    const {
      cloudflareTeamDomain,
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

    // Use provided CDN URL or fall back to distribution domain
    const cdnUrl = propsCdnUrl || (mediaCdn ? `https://${mediaCdn.distributionDomainName}` : undefined);

    // Build CORS allowed origins
    const allowedOrigins = adminDomain 
      ? [`https://${adminDomain}`]
      : ['http://localhost:5173', 'http://localhost:3000'];

    // KMS key for encrypting secrets
    this.encryptionKey = new kms.Key(this, 'AdminEncryptionKey', {
      alias: `swarm/admin-secrets-${environment}`,
      description: `KMS key for encrypting Swarm admin secrets (${environment})`,
      enableKeyRotation: true,
      removalPolicy: environment === 'production' 
        ? cdk.RemovalPolicy.RETAIN 
        : cdk.RemovalPolicy.DESTROY,
    });

    // DynamoDB table for admin data
    this.table = new dynamodb.Table(this, 'AdminTable', {
      tableName: `SwarmAdmin-${environment}`,
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: environment === 'production' 
        ? cdk.RemovalPolicy.RETAIN 
        : cdk.RemovalPolicy.DESTROY,
      pointInTimeRecoverySpecification: {
        pointInTimeRecoveryEnabled: environment === 'production',
      },
      timeToLiveAttribute: 'ttl',
    });

    // GSI1 for inverted lookups (sk → pk)
    // Used for:
    // - Finding agent by inhabitant: sk=INHABITANT#<wallet> returns pk=AGENT#<agentId>
    // - Listing items by type: sk=CONFIG returns all agents
    this.table.addGlobalSecondaryIndex({
      indexName: 'GSI1',
      partitionKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
    });


    // Note: Media jobs are queried using Scan with filter (no GSI needed)
    // Jobs have TTL so the scan is bounded by recent jobs only

    // External provider ID lookups use a mapping item (no extra GSI).

    // Response queue for async media generation callbacks
    // When Replicate finishes generating an image/video, it calls our webhook
    // which puts a message in this queue. The response sender Lambda then
    // delivers the media to Telegram.
    const responseQueue = new sqs.Queue(this, 'ResponseQueue', {
      queueName: `swarm-response-queue-${environment}`,
      visibilityTimeout: cdk.Duration.seconds(120), // Match Lambda timeout
      retentionPeriod: cdk.Duration.days(1),
      deadLetterQueue: {
        queue: new sqs.Queue(this, 'ResponseDLQ', {
          queueName: `swarm-response-dlq-${environment}`,
          retentionPeriod: cdk.Duration.days(14),
        }),
        maxReceiveCount: 3,
      },
    });

    // Secret for OpenRouter API key
    const llmApiKey = props.openRouterApiKeyArn
      ? secretsmanager.Secret.fromSecretCompleteArn(this, 'LLMApiKey', props.openRouterApiKeyArn)
      : new secretsmanager.Secret(this, 'LLMApiKey', {
          secretName: 'swarm/admin/llm-api-key',
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

    // Build webhook URL for Replicate callbacks
    const replicateWebhookUrl = props.apiDomain
      ? `https://${props.apiDomain}/webhook/replicate`
      : ''; // Will be set after API is created

    // Internal test key for direct API testing (only in non-production)
    // Generate a random key if not in production
    const internalTestKey = environment !== 'production' 
      ? process.env.INTERNAL_TEST_KEY || `test-${Date.now()}-${Math.random().toString(36).substring(2)}`
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
        SECRET_PREFIX: 'swarm',
        KMS_KEY_ID: this.encryptionKey.keyId,
        CF_ACCESS_TEAM_DOMAIN: cloudflareTeamDomain,
        ADMIN_EMAILS: adminEmails,
        LLM_ENDPOINT: 'https://openrouter.ai/api/v1/chat/completions',
        LLM_MODEL: 'anthropic/claude-sonnet-4',
        LLM_API_KEY_SECRET_ARN: llmApiKey.secretArn,
        WEB_SEARCH_PROVIDER: webSearchProvider || 'serpapi',
        WEB_SEARCH_API_KEY_SECRET_ARN: webSearchApiKey?.secretArn || '',
        API_DOMAIN: props.apiDomain || '',
        NODE_ENV: environment,
        // Media generation config
        MEDIA_BUCKET: mediaBucket?.bucketName || '',
        CDN_URL: cdnUrl || '',
        REPLICATE_WEBHOOK_URL: replicateWebhookUrl,
        REPLICATE_API_KEY_SECRET_ARN: replicateApiKey?.secretArn || '',
        RESPONSE_QUEUE_URL: responseQueue.queueUrl,
        ALLOWED_ORIGINS: allowedOrigins.join(','),
        // Internal testing (non-production only)
        INTERNAL_TEST_KEY: internalTestKey,
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
    });

    // Grant permissions
    this.table.grantReadWriteData(this.chatHandler);
    this.encryptionKey.grantEncryptDecrypt(this.chatHandler);
    llmApiKey.grantRead(this.chatHandler);
    if (replicateApiKey) {
      replicateApiKey.grantRead(this.chatHandler);
    }
    if (webSearchApiKey) {
      webSearchApiKey.grantRead(this.chatHandler);
    }

    // Grant permissions to state table for agent config sync
    if (stateTable) {
      stateTable.grantReadWriteData(this.chatHandler);
    }

    // Grant S3 permissions for media operations
    if (mediaBucket) {
      mediaBucket.grantReadWrite(this.chatHandler);
    }

    // Grant SQS permissions for async callbacks
    responseQueue.grantSendMessages(this.chatHandler);

    // Grant secrets manager permissions for swarm secrets
    // CreateSecret needs wildcard since the secret doesn't exist yet
    this.chatHandler.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['secretsmanager:CreateSecret'],
      resources: ['*'],
      conditions: {
        'StringLike': {
          'secretsmanager:Name': 'swarm/*',
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
      resources: [
        `arn:aws:secretsmanager:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:secret:swarm/*`,
      ],
    }));

    // ListSecrets needs wildcard resource (API limitation)
    this.chatHandler.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['secretsmanager:ListSecrets'],
      resources: ['*'],
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
        allowHeaders: ['Content-Type', 'Authorization', 'CF-Access-JWT-Assertion'],
        allowCredentials: true,
        maxAge: cdk.Duration.hours(24),
      },
    });

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

    // Transcribe handler - for audio transcription
    const transcribeHandler = new nodejs.NodejsFunction(this, 'TranscribeHandler', {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, '../../../admin-api/src/handlers/transcribe.ts'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: {
        CF_ACCESS_TEAM_DOMAIN: cloudflareTeamDomain,
        ADMIN_EMAILS: adminEmails,
        NODE_ENV: environment,
        ALLOWED_ORIGINS: allowedOrigins.join(','),
        LLM_API_KEY_SECRET_ARN: llmApiKey.secretArn,
        INTERNAL_TEST_KEY: internalTestKey,
      },
      bundling: {
        externalModules: ['@aws-sdk/*'],
        minify: true,
        sourceMap: true,
      },
    });

    // Grant permissions to transcribe handler
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

    // Agents handler - for CRUD operations on agents
    const agentsHandler = new nodejs.NodejsFunction(this, 'AgentsHandler', {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, '../../../admin-api/src/handlers/agents.ts'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: {
        ADMIN_TABLE: this.table.tableName,
        STATE_TABLE: stateTable?.tableName || '',
        CF_ACCESS_TEAM_DOMAIN: cloudflareTeamDomain,
        ADMIN_EMAILS: adminEmails,
        NODE_ENV: environment,
        ALLOWED_ORIGINS: allowedOrigins.join(','),
        KMS_KEY_ID: this.encryptionKey.keyId,
        SECRET_PREFIX: 'swarm',
        // Internal testing (non-production only)
        INTERNAL_TEST_KEY: internalTestKey,
      },
      bundling: {
        externalModules: ['@aws-sdk/*'],
        minify: true,
        sourceMap: true,
      },
    });

    // Grant permissions to agents handler
    this.table.grantReadWriteData(agentsHandler);
    this.encryptionKey.grantEncryptDecrypt(agentsHandler);
    if (stateTable) {
      stateTable.grantReadWriteData(agentsHandler);
    }

    // Grant secrets manager permissions to agents handler
    // CreateSecret needs wildcard since the secret doesn't exist yet
    agentsHandler.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['secretsmanager:CreateSecret'],
      resources: ['*'],
      conditions: {
        'StringLike': {
          'secretsmanager:Name': 'swarm/*',
        },
      },
    }));

    agentsHandler.addToRolePolicy(new iam.PolicyStatement({
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
        `arn:aws:secretsmanager:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:secret:swarm/*`,
      ],
    }));

    // ListSecrets doesn't support resource-level permissions
    agentsHandler.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['secretsmanager:ListSecrets'],
      resources: ['*'],
    }));

    // CloudWatch Logs access for consolidated agent logs
    agentsHandler.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'logs:StartQuery',
        'logs:GetQueryResults',
        'logs:DescribeLogGroups',
      ],
      resources: ['*'],
    }));

    const agentsIntegration = new integrations.HttpLambdaIntegration(
      'AgentsIntegration',
      agentsHandler
    );

    // Agent routes
    this.api.addRoutes({
      path: '/agents',
      methods: [apigateway.HttpMethod.GET, apigateway.HttpMethod.POST],
      integration: agentsIntegration,
    });

    this.api.addRoutes({
      path: '/agents/{agentId}',
      methods: [apigateway.HttpMethod.GET, apigateway.HttpMethod.PUT, apigateway.HttpMethod.DELETE],
      integration: agentsIntegration,
    });

    this.api.addRoutes({
      path: '/agents/{agentId}/secrets',
      methods: [apigateway.HttpMethod.GET, apigateway.HttpMethod.POST],
      integration: agentsIntegration,
    });

    this.api.addRoutes({
      path: '/agents/{agentId}/logs',
      methods: [apigateway.HttpMethod.GET],
      integration: agentsIntegration,
    });

    this.api.addRoutes({
      path: '/agents/{agentId}/issues',
      methods: [apigateway.HttpMethod.GET],
      integration: agentsIntegration,
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

    // Jobs handler - for polling media job status
    const jobsHandler = new nodejs.NodejsFunction(this, 'JobsHandler', {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, '../../../admin-api/src/handlers/jobs.ts'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(10),
      memorySize: 256,
      environment: {
        ADMIN_TABLE: this.table.tableName,
        CF_ACCESS_TEAM_DOMAIN: cloudflareTeamDomain,
        ADMIN_EMAILS: adminEmails,
        NODE_ENV: environment,
        ALLOWED_ORIGINS: allowedOrigins.join(','),
      },
      bundling: {
        externalModules: ['@aws-sdk/*'],
        minify: true,
        sourceMap: true,
      },
    });

    // Grant permissions to jobs handler
    this.table.grantReadData(jobsHandler);

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
        ALLOWED_ORIGINS: allowedOrigins.join(','),
        AUTH_DOMAIN: adminDomain || 'admin.rati.chat',
        // Helius for NFT gating - pass ARN for runtime fetch instead of inline value
        HELIUS_API_KEY_ARN: heliusApiKeySecret?.secretArn || '',
        HELIUS_API_KEY: props.heliusApiKey || '',
      },
      bundling: {
        externalModules: ['@aws-sdk/*'],
        minify: true,
        sourceMap: true,
      },
    });

    // Grant permissions to wallet auth handler
    this.table.grantReadWriteData(walletAuthHandler);
    if (heliusApiKeySecret) {
      heliusApiKeySecret.grantRead(walletAuthHandler);
    }

    const walletAuthIntegration = new integrations.HttpLambdaIntegration(
      'WalletAuthIntegration',
      walletAuthHandler
    );

    // Wallet auth routes - no Cloudflare Access required
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

    // Shared Telegram webhook handler - handles ALL agents dynamically
    const telegramWebhookHandler = new nodejs.NodejsFunction(this, 'TelegramWebhookHandler', {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, '../../../admin-api/src/handlers/telegram-webhook.ts'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(120), // Increased for image generation
      memorySize: 512, // Increased for image processing
      environment: {
        ADMIN_TABLE: this.table.tableName,
        STATE_TABLE: stateTable?.tableName || '',
        LLM_ENDPOINT: 'https://openrouter.ai/api/v1/chat/completions',
        LLM_MODEL: 'anthropic/claude-sonnet-4',
        LLM_API_KEY_SECRET_ARN: llmApiKey.secretArn,
        API_DOMAIN: props.apiDomain || '',
        NODE_ENV: environment,
        // Internal test key for E2E tests (bypasses IP check in non-prod)
        INTERNAL_TEST_KEY: environment !== 'prod' ? internalTestKey : '',
        // Media generation config - REQUIRED for image/video generation
        MEDIA_BUCKET: mediaBucket?.bucketName || '',
        CDN_URL: cdnUrl || '',
        REPLICATE_WEBHOOK_URL: replicateWebhookUrl,
        REPLICATE_API_KEY_SECRET_ARN: replicateApiKey?.secretArn || '',
      },
      bundling: {
        externalModules: ['@aws-sdk/*'],
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
    });

    // Grant permissions to telegram handler
    this.table.grantReadWriteData(telegramWebhookHandler); // Need write for conversation history
    if (stateTable) {
      stateTable.grantReadData(telegramWebhookHandler);
    }
    llmApiKey.grantRead(telegramWebhookHandler);
    if (replicateApiKey) {
      replicateApiKey.grantRead(telegramWebhookHandler);
    }

    // Grant KMS decrypt for agent secrets
    this.encryptionKey.grantDecrypt(telegramWebhookHandler);

    // Grant S3 permissions for media operations
    if (mediaBucket) {
      mediaBucket.grantReadWrite(telegramWebhookHandler);
    }

    // Grant read access to agent secrets (bot tokens and webhook secrets)
    telegramWebhookHandler.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['secretsmanager:GetSecretValue'],
      resources: [
        `arn:aws:secretsmanager:*:${cdk.Stack.of(this).account}:secret:swarm/*`,
      ],
    }));

    const telegramIntegration = new integrations.HttpLambdaIntegration(
      'TelegramWebhookIntegration',
      telegramWebhookHandler
    );

    // Webhook route: /webhook/telegram/{agentId}
    this.api.addRoutes({
      path: '/webhook/telegram/{agentId}',
      methods: [apigateway.HttpMethod.POST],
      integration: telegramIntegration,
    });

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
        NODE_ENV: environment,
      },
      bundling: {
        externalModules: ['@aws-sdk/*'],
        minify: true,
        sourceMap: true,
      },
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
    const responseSenderHandler = new nodejs.NodejsFunction(this, 'ResponseSenderHandler', {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, '../../../admin-api/src/handlers/response-sender.ts'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(60),
      memorySize: 256,
      environment: {
        ADMIN_TABLE: this.table.tableName,
        NODE_ENV: environment,
      },
      bundling: {
        externalModules: ['@aws-sdk/*'],
        minify: true,
        sourceMap: true,
      },
    });

    // Grant permissions to response sender
    this.table.grantReadData(responseSenderHandler);
    this.encryptionKey.grantDecrypt(responseSenderHandler);

    // Grant secrets manager access (for bot tokens)
    responseSenderHandler.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['secretsmanager:GetSecretValue'],
      resources: [
        `arn:aws:secretsmanager:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:secret:swarm/*`,
      ],
    }));

    // Add SQS trigger
    responseSenderHandler.addEventSource(new lambdaEventSources.SqsEventSource(responseQueue, {
      batchSize: 5,
      maxBatchingWindow: cdk.Duration.seconds(5),
    }));

    // Twitter OAuth handler - for connecting X/Twitter accounts via OAuth 1.0a
    const twitterAppCredentialsSecret = secretsmanager.Secret.fromSecretNameV2(
      this, 'TwitterAppCredentials', 'swarm/global/twitter-app-credentials'
    );

    const twitterOAuthHandler = new nodejs.NodejsFunction(this, 'TwitterOAuthHandler', {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, '../../../admin-api/src/handlers/twitter-oauth.ts'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: {
        ADMIN_TABLE: this.table.tableName,
        CF_ACCESS_TEAM_DOMAIN: cloudflareTeamDomain,
        ADMIN_EMAILS: adminEmails,
        NODE_ENV: environment,
        ALLOWED_ORIGINS: allowedOrigins.join(','),
        ADMIN_UI_URL: allowedOrigins[0] || 'http://localhost:5173',
        KMS_KEY_ID: this.encryptionKey.keyId,
        SECRET_PREFIX: 'swarm',
        // Twitter App credentials from Secrets Manager
        TWITTER_APP_CREDENTIALS_ARN: twitterAppCredentialsSecret.secretArn,
        TWITTER_OAUTH_CALLBACK_URL: props.apiDomain 
          ? `https://${props.apiDomain}/oauth/twitter/callback`
          : '',
      },
      bundling: {
        externalModules: ['@aws-sdk/*'],
        minify: true,
        sourceMap: true,
      },
    });

    // Grant read access to Twitter app credentials
    twitterAppCredentialsSecret.grantRead(twitterOAuthHandler);

    // Grant permissions to Twitter OAuth handler
    this.table.grantReadWriteData(twitterOAuthHandler);
    this.encryptionKey.grantEncryptDecrypt(twitterOAuthHandler);
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
          'secretsmanager:Name': 'swarm/*',
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
        `arn:aws:secretsmanager:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:secret:swarm/*`,
      ],
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
      path: '/oauth/twitter/status/{agentId}',
      methods: [apigateway.HttpMethod.GET],
      integration: twitterOAuthIntegration,
    });

    this.api.addRoutes({
      path: '/oauth/twitter/{agentId}',
      methods: [apigateway.HttpMethod.DELETE],
      integration: twitterOAuthIntegration,
    });

    // Configure log group prefixes for the consolidated logs endpoint
    // This allows querying logs across all admin API handlers for a given agent
    const stackPrefix = cdk.Stack.of(this).stackName;
    agentsHandler.addEnvironment('ADMIN_LOG_GROUPS', '');
    agentsHandler.addEnvironment('LOG_GROUP_PREFIX', '/aws/lambda/');
    agentsHandler.addEnvironment('ADMIN_LOG_GROUP_PREFIXES', [
      `/aws/lambda/${stackPrefix}-AdminApi`,  // All admin API handlers (chat, agents, telegram)
    ].join(','));

    // Custom domain configuration (for Cloudflare Access proxy)
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
        exportName: `swarm-admin-api-domain-${environment}`,
      });

      new cdk.CfnOutput(this, 'ApiDomainTarget', {
        value: this.customDomain.regionalDomainName,
        description: 'Target for CNAME record',
        exportName: `swarm-admin-api-target-${environment}`,
      });
    }

    // Outputs
    new cdk.CfnOutput(this, 'ApiEndpoint', {
      value: props.apiDomain ? `https://${props.apiDomain}` : this.api.apiEndpoint,
      description: 'Admin API endpoint URL',
      exportName: `swarm-admin-api-url-${environment}`,
    });

    new cdk.CfnOutput(this, 'AdminTableName', {
      value: this.table.tableName,
      description: 'DynamoDB table name for admin data',
    });

    new cdk.CfnOutput(this, 'EncryptionKeyArn', {
      value: this.encryptionKey.keyArn,
      description: 'KMS key ARN for secret encryption',
    });
  }
}
