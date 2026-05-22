/**
 * Admin API Stack
 * Contains API Gateway and Lambda handlers
 * This stack changes frequently with code updates and deploys faster than full stack
 */
import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { AdminApiConstruct } from '../constructs/admin-api.js';
import { SharedHandlers } from '../constructs/shared-handlers.js';
import { ClaudeCodeWorker } from '../constructs/claude-code-worker.js';
import { DiscordGatewayWorker } from '../constructs/discord-gateway-worker.js';
import { OpsDashboard } from '../constructs/ops-dashboard.js';
import type { SharedInfraStack } from './shared-infra-stack.js';
import type { CoreInfraStack } from './core-infra-stack.js';

/**
 * Computes the SSM parameter name for the Admin API endpoint URL.
 * Shared between AdminApiStack (writer) and AdminUiStack (reader)
 * to decouple CloudFormation cross-stack exports.
 */
export function apiEndpointParamName(environment: string, suffix: string): string {
  return `/swarm/${environment}${suffix}/api-endpoint-url`;
}

export interface AdminApiStackProps extends cdk.StackProps {
  /**
   * Environment name (dev, staging, prod)
   */
  environment: string;
  /**
   * Optional suffix for resource names/exports (e.g., "-a1b2c3")
   */
  nameSuffix?: string;

  /**
   * Reference to the shared infrastructure stack (CoreInfraStack or SharedInfraStack for backwards compatibility)
   */
  sharedInfraStack: SharedInfraStack | CoreInfraStack;

  /**
   * Path to compiled handlers
   */
  handlersPath: string;

  /**
   * Custom domain for Admin UI (e.g., 'admin-staging.rati.chat')
   */
  adminDomain?: string;

  /**
   * Admin emails (comma-separated)
   */
  adminEmails?: string;

  /**
   * Admin wallet addresses (comma-separated Solana public keys)
   */
  adminWallets?: string;

  /**
   * OpenRouter API key secret ARN
   */
  openRouterApiKeyArn?: string;

  /**
   * Replicate API key secret ARN
   */
  replicateApiKeyArn?: string;

  /**
   * Helius API key secret ARN
   */
  heliusApiKeyArn?: string;

  /**
   * Web search API key secret ARN
   */
  webSearchApiKeyArn?: string;

  /**
   * Web search provider
   */
  webSearchProvider?: string;

  /**
   * Privy App ID
   */
  privyAppId?: string;

  /**
   * Privy App Secret ARN
   */
  privyAppSecretArn?: string;

  /**
   * Privy JWT verification key ARN
   */
  privyJwtVerificationKeyArn?: string;

  /**
   * Stripe secret key ARN
   */
  stripeSecretKeyArn?: string;

  /**
   * Stripe webhook secret ARN
   */
  stripeWebhookSecretArn?: string;

  /**
   * Stripe Pro plan price ID
   */
  stripePriceIdPro?: string;

  /**
   * Stripe Enterprise plan price ID
   */
  stripePriceIdEnterprise?: string;

  /**
   * Stripe Team plan price ID
   */
  stripePriceIdTeam?: string;

  /**
   * Anthropic API key secret ARN
   */
  anthropicApiKeyArn?: string;

  /**
   * Enable Claude Code worker
   */
  enableClaudeCode?: boolean;

  /**
   * Claude Code worker min capacity
   */
  claudeCodeMinCapacity?: number;

  /**
   * Claude Code worker max capacity
   */
  claudeCodeMaxCapacity?: number;

  /**
   * Use OpenRouter for Claude Code
   */
  claudeCodeUseOpenRouter?: boolean;

  /**
   * Secrets Manager prefix
   */
  secretPrefix?: string;

  /**
   * Enable Discord gateway worker (always-on ECS Fargate task)
   */
  enableDiscordGateway?: boolean;

  /**
   * When true, import existing resources (AdminTable) instead of creating them.
   */
  useExistingResources?: boolean;

  /**
   * DynamoDB stream ARN for the existing AdminTable (required when useExistingResources=true
   * and GitHub issue sync is enabled). Retrieve via:
   * aws dynamodb describe-table --table-name SwarmAdmin-<env> --query 'Table.LatestStreamArn'
   */
  tableStreamArn?: string;

  /**
   * Secrets Manager ARN for GitHub App credentials JSON.
   * Preferred shape: { "clientId": "Iv1...", "privateKey": "-----BEGIN..." }
   * Legacy shape:    { "appId": "12345", "privateKey": "...", "installationId": "67890" }
   * When provided, enables GitHub issue sync and MCP issue tracking tools.
   */
  githubAppCredentialsArn?: string;

  /**
   * GitHub repository (owner/name) for issue sync.
   * @default "cenetex/aws-swarm"
   */
  githubRepo?: string;

  /**
   * Raticross relay inbound authentication key.
   * The relay will use this key to authenticate when sending messages to aws-swarm.
   */
  raticrossInboundKey?: string;

  /**
   * Secrets Manager ARN holding the bearer token for the Signal space mining
   * game station REST API. When set, admin chat exposes the `signal_*` MCP
   * tools to avatars that opt into the `signal-station` toolset.
   */
  signalApiTokenSecretArn?: string;

  /**
   * Twitter API tier: 'free' (100 tweets/month) or 'basic' (15,000 tweets/month)
   * @default 'basic'
   */
  twitterApiTier?: 'free' | 'basic';

  /**
   * Override the monthly Twitter API budget (reads)
   */
  twitterMonthlyBudget?: number;

  /**
   * Percentage of daily budget to reserve for spikes (0-100)
   * @default 20
   */
  twitterDailyReservePct?: number;
}

export class AdminApiStack extends cdk.Stack {
  public readonly adminApi?: AdminApiConstruct;
  public readonly sharedHandlers?: SharedHandlers;
  public readonly claudeCodeWorker?: ClaudeCodeWorker;
  public readonly discordGatewayWorker?: DiscordGatewayWorker;
  public readonly apiEndpoint?: string;
  /**
   * SSM parameter name where the API endpoint URL is stored.
   * Consumer stacks should read from this SSM parameter instead of
   * referencing apiEndpoint directly, to avoid CloudFormation export-in-use errors.
   */
  public readonly apiEndpointParamName: string;

  constructor(scope: Construct, id: string, props: AdminApiStackProps) {
    super(scope, id, props);

    const {
      environment,
      sharedInfraStack,
      handlersPath,
      adminDomain,
      adminEmails,
      adminWallets,
      openRouterApiKeyArn,
      replicateApiKeyArn,
      heliusApiKeyArn,
      webSearchApiKeyArn,
      webSearchProvider,
      privyAppId,
      privyAppSecretArn,
      privyJwtVerificationKeyArn,
      stripeSecretKeyArn,
      stripeWebhookSecretArn,
      stripePriceIdPro,
      stripePriceIdEnterprise,
      stripePriceIdTeam,
      signalApiTokenSecretArn,
      anthropicApiKeyArn,
      enableClaudeCode = false,
      claudeCodeMinCapacity = 0,
      claudeCodeMaxCapacity = 5,
      claudeCodeUseOpenRouter = false,
      secretPrefix,
      nameSuffix,
      enableDiscordGateway = false,
      raticrossInboundKey,
      twitterApiTier,
      twitterMonthlyBudget,
      twitterDailyReservePct,
    } = props;

    // Read CDK context for NFT ownership enforcement flag. In prod, default
    // to enforcement when Helius is configured so NFT revocation cannot be
    // silently left dormant.
    const nftOwnershipEnforcementContext = this.node.tryGetContext('nftOwnershipEnforcement') as 'on' | 'off' | undefined;
    const nftOwnershipEnforcement = nftOwnershipEnforcementContext
      ?? (environment === 'prod' && heliusApiKeyArn ? 'on' : 'off');

    // SSM parameter name for the API endpoint URL — used by AdminUiStack
    // to avoid CloudFormation cross-stack export dependencies.
    this.apiEndpointParamName = apiEndpointParamName(environment, nameSuffix ?? '');

    // Import shared resources from the shared infrastructure stack
    // Note: CDK requires only one of tableArn or tableName, not both
    const stateTable = dynamodb.Table.fromTableAttributes(this, 'StateTable', {
      tableArn: sharedInfraStack.stateTableArn,
      globalIndexes: ['GSI1'],
    });

    const activityTable = dynamodb.Table.fromTableAttributes(this, 'ActivityTable', {
      tableArn: sharedInfraStack.activityTableArn,
    });

    const mediaBucket = s3.Bucket.fromBucketAttributes(this, 'MediaBucket', {
      bucketArn: sharedInfraStack.mediaBucketArn,
      bucketName: sharedInfraStack.mediaBucketName,
    });

    // Use SSM dynamic reference for layer ARN to avoid CloudFormation export conflicts.
    // When the layer changes, the SSM parameter is updated, and consumer stacks
    // can be deployed without the export-in-use error.
    // Note: valueForStringParameter resolves at deploy-time, not synth-time.
    const dependencyLayerArn = ssm.StringParameter.valueForStringParameter(
      this,
      sharedInfraStack.dependencyLayerArnParamName
    );
    const dependencyLayer = lambda.LayerVersion.fromLayerVersionArn(
      this,
      'DependencyLayer',
      dependencyLayerArn
    );

    const mediaCdn = sharedInfraStack.cdnDistributionId
      ? cloudfront.Distribution.fromDistributionAttributes(this, 'MediaCdn', {
          distributionId: sharedInfraStack.cdnDistributionId,
          domainName: sharedInfraStack.cdnUrl?.replace('https://', '') || '',
        })
      : undefined;

    // Look up default VPC for ECS cluster
    const vpc = ec2.Vpc.fromLookup(this, 'DefaultVpc', { isDefault: true });
    const discordCluster = ecs.Cluster.fromClusterAttributes(this, 'DiscordCluster', {
      clusterArn: sharedInfraStack.discordClusterArn,
      clusterName: sharedInfraStack.discordClusterName,
      vpc,
      securityGroups: [],
    });

    // Import the alarm SNS topic from the shared infrastructure stack
    const alarmTopic = sns.Topic.fromTopicArn(
      this,
      'AlarmTopic',
      sharedInfraStack.alarmTopicArn
    );

    // Generate internal test key for non-production
    const isProd = environment === 'prod' || environment === 'production';
    const internalTestKey = isProd
      ? ''
      : process.env.INTERNAL_TEST_KEY || `test-${Date.now()}-${Math.random().toString(36).substring(2)}`;

    // Shared handlers (e.g., platform heartbeat) require ADMIN_TABLE at runtime.
    // Provide a stable table reference here so environment wiring does not depend
    // on post-hoc Lambda property overrides.
    //
    // When useExistingResources is true, the admin table is imported from the
    // legacy monolith stack and has NO suffix (e.g., "SwarmAdmin-prod").
    // When useExistingResources is false, the table is created with the suffix
    // (e.g., "SwarmAdmin-prod-split").
    const adminTableName = props.useExistingResources
      ? `SwarmAdmin-${environment}`
      : `SwarmAdmin-${environment}${nameSuffix ?? ''}`;
    const sharedAdminTable =
      adminEmails || enableDiscordGateway
        ? dynamodb.Table.fromTableName(this, 'SharedAdminTableRef', adminTableName)
        : undefined;

    // Create SharedHandlers for shared multi-tenant ingress
    this.sharedHandlers = new SharedHandlers(this, 'SharedHandlers', {
      environment,
      nameSuffix,
      dependencyLayer,
      stateTable,
      activityTable,
      mediaBucket,
      adminTable: sharedAdminTable,
      cdnUrl: sharedInfraStack.cdnUrl,
      replicateApiKeyArn,
      secretPrefix,
      twitterApiTier,
      twitterMonthlyBudget,
      twitterDailyReservePct,
      internalTestKey,
      alarmTopic,
      raticrossInboundKey,
      heliusApiKeyArn,
      nftOwnershipEnforcement,
    });

    // Create Admin API if configured
    if (adminEmails) {
      this.adminApi = new AdminApiConstruct(this, 'AdminApi', {
        adminEmails,
        adminWallets,
        openRouterApiKeyArn,
        replicateApiKeyArn,
        heliusApiKeyArn,
        webSearchApiKeyArn,
        webSearchProvider,
        privyAppId,
        privyAppSecretArn,
        privyJwtVerificationKeyArn,
        stripeSecretKeyArn,
        stripeWebhookSecretArn,
        stripePriceIdPro,
        stripePriceIdEnterprise,
        stripePriceIdTeam,
        signalApiTokenSecretArn,
        environment,
        nameSuffix,
        secretPrefix,
        adminDomain,
        apiDomain: adminDomain,
        stateTable,
        mediaBucket,
        mediaCdn,
        cdnUrl: sharedInfraStack.cdnUrl,
        dependencyLayer,
        telegramWebhookFunction: this.sharedHandlers.telegramWebhook,
        raticrossRelayFunction: this.sharedHandlers.raticrossRelay,
        raticrossHealthFunction: this.sharedHandlers.raticrossHealth,
        postQueue: this.sharedHandlers?.postQueue,
        sharedMessageQueue: this.sharedHandlers?.messageQueue,
        sharedResponseQueue: this.sharedHandlers?.responseQueue,
        sharedMediaQueue: this.sharedHandlers?.mediaQueue,
        sharedDlq: this.sharedHandlers?.dlq,
        sharedSchedulerDlq: this.sharedHandlers?.schedulerDlq,
        internalTestKey,
        alarmTopic,
        useExistingResources: props.useExistingResources,
        tableStreamArn: props.tableStreamArn,
        enableDiscordGateway,
        githubAppCredentialsArn: props.githubAppCredentialsArn,
        githubRepo: props.githubRepo,
      });

      this.apiEndpoint = this.adminApi.apiEndpoint;

      // ── GitHub App Credentials Guardrail ──────────────────────────────────
      // Warn when GitHub App credentials are not configured, which disables
      // auto-issue sync and MCP GitHub tools.
      if (!props.githubAppCredentialsArn) {
        const isPersistentEnv = environment === 'prod' || environment === 'staging';
        const message =
          'githubAppCredentialsArn is not set. GitHub issue sync and MCP GitHub ' +
          'tools will be disabled. To enable: (1) register a GitHub App, ' +
          '(2) store credentials in Secrets Manager as ' +
          'swarm/<env>/github-app-credentials, (3) add the ARN to ' +
          'cdk.context.json under githubAppCredentialsArn.';
        if (isPersistentEnv) {
          cdk.Annotations.of(this).addWarning(message);
        }
      }

      // Store API endpoint in SSM so consumer stacks (AdminUiStack) can read it
      // without creating a CloudFormation cross-stack export dependency.
      // This mirrors the pattern used for dependencyLayerArn in SharedInfraStack.
      new ssm.StringParameter(this, 'ApiEndpointParam', {
        parameterName: this.apiEndpointParamName,
        stringValue: this.apiEndpoint,
        description: 'Admin API endpoint URL for cross-stack consumption',
      });

      // Backward-compat: preserve the CDK auto-generated cross-stack export that
      // the old AdminUiStack consumed via Fn::ImportValue. The new code reads from
      // SSM, but already-deployed SwarmUi stacks still hold the import until they
      // are updated. Removing this export before SwarmUi deploys causes
      // "Cannot delete export ... as it is in use" failures.
      // Safe to remove once both stacks have deployed with the SSM-based flow.
      const legacyExportName = `${this.stackName}:ExportsOutputFnGetAttAdminApi2FF51FB1ApiEndpoint9B063669`;
      const legacyExport = new cdk.CfnOutput(this, 'LegacyApiEndpointExport', {
        value: this.adminApi.apiEndpoint,
        exportName: legacyExportName,
      });
      legacyExport.overrideLogicalId('ExportsOutputFnGetAttAdminApi2FF51FB1ApiEndpoint9B063669');

      // SharedHandlers receives ADMIN_TABLE directly via `adminTable` above.
      // Keep this stack focused on Admin API construct wiring.
    }

    // Create Discord gateway worker if enabled.
    // In non-production environments, default to desiredCount=0 to avoid idle ECS cost.
    if (enableDiscordGateway) {
      const isProd = environment === 'prod' || environment === 'production';
      this.discordGatewayWorker = new DiscordGatewayWorker(this, 'DiscordGatewayWorker', {
        environment,
        nameSuffix,
        cluster: discordCluster,
        stateTable,
        activityTable,
        adminTable: sharedAdminTable,
        mediaBucket,
        cdnUrl: sharedInfraStack.cdnUrl,
        messageQueue: this.sharedHandlers.messageQueue,
        secretPrefix,
        desiredCount: isProd ? 1 : 0,
      });
    }

    // ── Discord Gateway Guardrail ─────────────────────────────────────────────
    // When the gateway is disabled, add a CDK annotation warning operators that
    // any avatars configured with Discord bot/hybrid mode will be unable to
    // receive inbound messages. This surfaces as a warning in `cdk diff/synth`
    // and fails the build if the environment variable DISCORD_GATEWAY_GUARDRAIL_STRICT
    // is set to "true" (e.g., in CI release gates).
    if (!enableDiscordGateway) {
      const strict = process.env.DISCORD_GATEWAY_GUARDRAIL_STRICT === 'true';
      const message =
        'Discord gateway is disabled (enableDiscordGateway=false). ' +
        'Avatars configured with Discord bot or hybrid mode will not receive ' +
        'inbound Discord messages. Set enableDiscordGateway=true to restore ' +
        'gateway functionality, or set DISCORD_GATEWAY_GUARDRAIL_STRICT=true ' +
        'in CI to block deployments with this configuration.';

      if (strict) {
        cdk.Annotations.of(this).addError(message);
      } else {
        cdk.Annotations.of(this).addWarning(message);
      }

      // Export a flag so downstream consumers (admin API Lambda, alarms) can
      // query whether the gateway was deployed for this environment.
      new cdk.CfnOutput(this, 'DiscordGatewayEnabled', {
        value: 'false',
        description: 'Whether the Discord gateway worker is deployed',
        exportName: `swarm-discord-gateway-enabled-${environment}${nameSuffix ?? ''}`,
      });
    } else {
      new cdk.CfnOutput(this, 'DiscordGatewayEnabled', {
        value: 'true',
        description: 'Whether the Discord gateway worker is deployed',
        exportName: `swarm-discord-gateway-enabled-${environment}${nameSuffix ?? ''}`,
      });
    }

    // Create Claude Code worker if enabled
    if (enableClaudeCode) {
      const claudeCodeCallbackQueue = new sqs.Queue(this, 'ClaudeCodeCallbackQueue', {
        queueName: `swarm-claude-code-callbacks-${environment}${nameSuffix ?? ''}.fifo`,
        fifo: true,
        contentBasedDeduplication: true,
        visibilityTimeout: cdk.Duration.seconds(60),
      });

      this.claudeCodeWorker = new ClaudeCodeWorker(this, 'ClaudeCodeWorker', {
        environment,
        nameSuffix,
        cluster: discordCluster,
        stateTable,
        responseQueue: claudeCodeCallbackQueue,
        anthropicApiKeyArn,
        openRouterApiKeyArn,
        useOpenRouter: claudeCodeUseOpenRouter,
        minCapacity: claudeCodeMinCapacity,
        maxCapacity: claudeCodeMaxCapacity,
        handlersCodePath: handlersPath,
        dependencyLayer,
        secretPrefix,
        alarmTopic,
      });

      new cdk.CfnOutput(this, 'ClaudeCodeQueueUrl', {
        value: this.claudeCodeWorker.queue.queueUrl,
        description: 'Claude Code task queue URL',
        exportName: `swarm-claude-code-queue-url-${environment}${nameSuffix ?? ''}`,
      });

      new cdk.CfnOutput(this, 'ClaudeCodeCallbackQueueUrl', {
        value: claudeCodeCallbackQueue.queueUrl,
        description: 'Claude Code callback queue URL',
        exportName: `swarm-claude-code-callback-queue-url-${environment}${nameSuffix ?? ''}`,
      });
    }

    // CloudWatch Operations Dashboard
    new OpsDashboard(this, 'OpsDashboard', {
      environment,
      nameSuffix,
      sharedHandlerFunctions: {
        messageProcessor: this.sharedHandlers.messageProcessor,
        responseSender: this.sharedHandlers.responseSender,
        mediaProcessor: this.sharedHandlers.mediaProcessor,
        tweetSender: this.sharedHandlers.tweetSender,
        telegramWebhook: this.sharedHandlers.telegramWebhook,
      },
      sharedQueues: {
        messageQueue: this.sharedHandlers.messageQueue,
        responseQueue: this.sharedHandlers.responseQueue,
        mediaQueue: this.sharedHandlers.mediaQueue,
        postQueue: this.sharedHandlers.postQueue,
      },
      sharedDlqs: {
        dlq: this.sharedHandlers.dlq,
        schedulerDlq: this.sharedHandlers.schedulerDlq,
      },
      ...(this.adminApi ? {
        adminHandlerFunctions: {
          chatWorker: this.adminApi.chatWorkerHandler,
          responseSender: this.adminApi.responseSenderHandler,
          dreamWorker: this.adminApi.dreamWorker,
          openaiCompat: this.adminApi.openaiCompatHandler,
        },
        adminDlqs: {
          responseDlq: this.adminApi.responseDlq,
          chatDlq: this.adminApi.chatDlq,
          dreamDlq: this.adminApi.dreamDlq,
          consolidationDlq: this.adminApi.consolidationDlq,
        },
        adminQueues: {
          responseQueue: this.adminApi.responseQueue,
          chatQueue: this.adminApi.chatQueue,
          dreamQueue: this.adminApi.dreamQueue,
        },
        adminApiId: this.adminApi.api.apiId,
        consolidationWorker: this.adminApi.consolidationWorker,
      } : {}),
      // Wire Discord gateway service for runtime drift alarm
      discordGatewayService: this.discordGatewayWorker?.service,
      alarmTopic,
    });

    // Export API endpoint
    if (this.apiEndpoint) {
      new cdk.CfnOutput(this, 'ApiEndpointExport', {
        value: this.apiEndpoint,
        exportName: `swarm-api-endpoint-${environment}${nameSuffix ?? ''}`,
      });
    }
  }
}
