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
   * Reference to the shared infrastructure stack
   */
  sharedInfraStack: SharedInfraStack;

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
}

export class AdminApiStack extends cdk.Stack {
  public readonly adminApi?: AdminApiConstruct;
  public readonly sharedHandlers?: SharedHandlers;
  public readonly claudeCodeWorker?: ClaudeCodeWorker;
  public readonly discordGatewayWorker?: DiscordGatewayWorker;
  public readonly apiEndpoint?: string;

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
      anthropicApiKeyArn,
      enableClaudeCode = false,
      claudeCodeMinCapacity = 0,
      claudeCodeMaxCapacity = 5,
      claudeCodeUseOpenRouter = false,
      secretPrefix,
      nameSuffix,
      enableDiscordGateway = false,
    } = props;

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
    const sharedAdminTable = adminEmails
      ? dynamodb.Table.fromTableName(
          this,
          'SharedAdminTableRef',
          adminTableName
        )
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
      internalTestKey,
      alarmTopic,
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
        postQueue: this.sharedHandlers?.postQueue,
        internalTestKey,
        alarmTopic,
        useExistingResources: props.useExistingResources,
        enableDiscordGateway,
      });

      this.apiEndpoint = this.adminApi.apiEndpoint;

      // SharedHandlers receives ADMIN_TABLE directly via `adminTable` above.
      // Keep this stack focused on Admin API construct wiring.
    }

    // Create Discord gateway worker if enabled
    if (enableDiscordGateway) {
      this.discordGatewayWorker = new DiscordGatewayWorker(this, 'DiscordGatewayWorker', {
        environment,
        nameSuffix,
        cluster: discordCluster,
        stateTable,
        activityTable,
        messageQueue: this.sharedHandlers.messageQueue,
        secretPrefix,
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
