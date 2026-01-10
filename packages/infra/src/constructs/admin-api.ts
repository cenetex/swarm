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
}

export class AdminApiConstruct extends Construct {
  public readonly api: apigateway.HttpApi;
  public readonly customDomain?: apigateway.DomainName;
  public readonly table: dynamodb.Table;
  public readonly encryptionKey: kms.Key;
  public readonly chatHandler: lambda.Function;

  constructor(scope: Construct, id: string, props: AdminApiConstructProps) {
    super(scope, id);

    const { cloudflareTeamDomain, adminEmails, environment = 'development', adminDomain, stateTable } = props;

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
    });

    // GSI for listing by type
    this.table.addGlobalSecondaryIndex({
      indexName: 'GSI1',
      partitionKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
    });

    // Secret for OpenRouter API key
    const llmApiKey = props.openRouterApiKeyArn 
      ? secretsmanager.Secret.fromSecretCompleteArn(this, 'LLMApiKey', props.openRouterApiKeyArn)
      : new secretsmanager.Secret(this, 'LLMApiKey', {
          secretName: 'swarm/admin/llm-api-key',
          description: 'API key for the admin chatbot LLM',
        });

    // Lambda function for chat handler
    this.chatHandler = new nodejs.NodejsFunction(this, 'ChatHandler', {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, '../../../admin-api/src/handlers/chat.ts'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(60),
      memorySize: 512,
      environment: {
        ADMIN_TABLE: this.table.tableName,
        STATE_TABLE: stateTable?.tableName || '',
        SECRETS_PREFIX: 'swarm/',
        KMS_KEY_ID: this.encryptionKey.keyId,
        CF_ACCESS_TEAM_DOMAIN: cloudflareTeamDomain,
        ADMIN_EMAILS: adminEmails,
        LLM_ENDPOINT: 'https://openrouter.ai/api/v1/chat/completions',
        LLM_MODEL: 'anthropic/claude-sonnet-4',
        LLM_API_KEY_SECRET_ARN: llmApiKey.secretArn,
        API_DOMAIN: props.apiDomain || '',
        NODE_ENV: environment,
      },
      bundling: {
        externalModules: ['@aws-sdk/*'],
        minify: true,
        sourceMap: true,
      },
    });

    // Grant permissions
    this.table.grantReadWriteData(this.chatHandler);
    this.encryptionKey.grantEncryptDecrypt(this.chatHandler);
    llmApiKey.grantRead(this.chatHandler);

    // Grant permissions to state table for agent config sync
    if (stateTable) {
      stateTable.grantReadWriteData(this.chatHandler);
    }

    // Grant secrets manager permissions
    this.chatHandler.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'secretsmanager:CreateSecret',
        'secretsmanager:UpdateSecret',
        'secretsmanager:DeleteSecret',
        'secretsmanager:PutSecretValue',
        'secretsmanager:DescribeSecret',
        'secretsmanager:ListSecrets',
        'secretsmanager:TagResource',
      ],
      resources: ['*'],
      conditions: {
        'StringLike': {
          'secretsmanager:Name': 'swarm/*',
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
      methods: [apigateway.HttpMethod.POST],
      integration: chatIntegration,
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
      },
      bundling: {
        externalModules: ['@aws-sdk/*'],
        minify: true,
        sourceMap: true,
      },
    });

    // Grant permissions to agents handler
    this.table.grantReadWriteData(agentsHandler);
    if (stateTable) {
      stateTable.grantReadWriteData(agentsHandler);
    }

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

    // Shared Telegram webhook handler - handles ALL agents dynamically
    const telegramWebhookHandler = new nodejs.NodejsFunction(this, 'TelegramWebhookHandler', {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, '../../../admin-api/src/handlers/telegram-webhook.ts'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: {
        ADMIN_TABLE: this.table.tableName,
        STATE_TABLE: stateTable?.tableName || '',
        LLM_ENDPOINT: 'https://openrouter.ai/api/v1/chat/completions',
        LLM_MODEL: 'anthropic/claude-sonnet-4',
        LLM_API_KEY_SECRET_ARN: llmApiKey.secretArn,
        API_DOMAIN: props.apiDomain || '',
        NODE_ENV: environment,
      },
      bundling: {
        externalModules: ['@aws-sdk/*'],
        minify: true,
        sourceMap: true,
      },
    });

    // Grant permissions to telegram handler
    this.table.grantReadData(telegramWebhookHandler);
    if (stateTable) {
      stateTable.grantReadData(telegramWebhookHandler);
    }
    llmApiKey.grantRead(telegramWebhookHandler);

    // Grant read access to agent secrets
    telegramWebhookHandler.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['secretsmanager:GetSecretValue'],
      resources: ['*'],
      conditions: {
        'StringLike': {
          'secretsmanager:Name': 'swarm/*',
        },
      },
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
