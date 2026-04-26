/**
 * Messaging Stack
 * Contains Telegram webhooks, Discord gateway, Twitter mention poller, and shared message queues
 * Depends on CoreInfraStack for tables and SNS topic
 */
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { SharedHandlers } from '../constructs/shared-handlers.js';
import { DiscordGatewayWorker } from '../constructs/discord-gateway-worker.js';
import type { CoreInfraStack } from './core-infra-stack.js';

export interface MessagingStackProps extends cdk.StackProps {
  /**
   * Environment name (dev, staging, prod)
   */
  environment: string;
  /**
   * Optional suffix for resource names/exports (e.g., "-a1b2c3")
   */
  nameSuffix?: string;

  /**
   * Reference to the core infrastructure stack
   */
  coreInfraStack: CoreInfraStack;

  /**
   * Path to compiled handlers
   */
  handlersPath: string;

  /**
   * Secrets Manager prefix (e.g., "swarm" or "swarm-abcdef")
   */
  secretPrefix?: string;

  /**
   * Optional dependency layer for native modules like sharp.
   */
  dependencyLayer?: any;

  /**
   * Optional suffix for messaging-specific resources (e.g., "-split")
   */
  messagingNameSuffix?: string;

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

  /**
   * Internal test key for bypassing webhook auth in non-production environments.
   */
  internalTestKey?: string;

  /**
   * Raticross relay inbound authentication key.
   */
  raticrossInboundKey?: string;

  /**
   * Helius API key for NFT ownership verification.
   */
  heliusApiKey?: string;

  /**
   * Helius API key secret ARN.
   */
  heliusApiKeyArn?: string;

  /**
   * NFT ownership enforcement flag: 'on' or 'off'.
   * @default 'off'
   */
  nftOwnershipEnforcement?: 'on' | 'off';

  /**
   * Replicate API key secret ARN
   */
  replicateApiKeyArn?: string;

  /**
   * Enable Discord gateway worker
   */
  enableDiscordGateway?: boolean;
}

export class MessagingStack extends cdk.Stack {
  public readonly sharedHandlers: SharedHandlers;

  constructor(scope: Construct, id: string, props: MessagingStackProps) {
    super(scope, id, props);

    const {
      environment,
      nameSuffix,
      coreInfraStack,
      secretPrefix = 'swarm',
      dependencyLayer,
      messagingNameSuffix = nameSuffix,
      twitterApiTier = 'basic',
      twitterMonthlyBudget,
      twitterDailyReservePct = 20,
      internalTestKey,
      raticrossInboundKey,
      heliusApiKey,
      heliusApiKeyArn,
      nftOwnershipEnforcement = 'off',
      replicateApiKeyArn,
      enableDiscordGateway = false,
    } = props;

    // Create shared handlers (messaging queues + processors)
    this.sharedHandlers = new SharedHandlers(this, 'SharedHandlers', {
      environment,
      nameSuffix: messagingNameSuffix,
      dependencyLayer,
      stateTable: coreInfraStack.shared.stateTable,
      activityTable: coreInfraStack.shared.activityTable,
      mediaBucket: coreInfraStack.shared.mediaBucket,
      cdnUrl: coreInfraStack.cdnUrl,
      secretPrefix,
      twitterApiTier,
      twitterMonthlyBudget,
      twitterDailyReservePct,
      internalTestKey,
      raticrossInboundKey,
      heliusApiKey,
      heliusApiKeyArn,
      nftOwnershipEnforcement,
      replicateApiKeyArn,
      alarmTopic: coreInfraStack.shared.alarmTopic,
    });

    // Optionally deploy Discord gateway worker
    if (enableDiscordGateway) {
      new DiscordGatewayWorker(this, 'DiscordGateway', {
        environment,
        nameSuffix: messagingNameSuffix,
        cluster: coreInfraStack.shared.discordCluster,
        stateTable: coreInfraStack.shared.stateTable,
        activityTable: coreInfraStack.shared.activityTable,
        messageQueue: this.sharedHandlers.messageQueue,
      });
    }
  }
}
