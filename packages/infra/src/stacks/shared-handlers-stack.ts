/**
 * Shared Handlers Nested Stack
 * Reduces the top-level AdminApiStack resource count by moving SharedHandlers (~100+ resources)
 * into a nested CDK stack, allowing prod deployment to stay under CloudFormation's 500-resource limit.
 */
import * as cdk from 'aws-cdk-lib';
import type * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import type * as s3 from 'aws-cdk-lib/aws-s3';
import type * as lambda from 'aws-cdk-lib/aws-lambda';
import type * as sns from 'aws-cdk-lib/aws-sns';
import { Construct } from 'constructs';
import { SharedHandlers } from '../constructs/shared-handlers.js';

export interface SharedHandlersStackProps extends cdk.NestedStackProps {
  /**
   * Environment name (dev, staging, prod)
   */
  environment: string;

  /**
   * Optional suffix for resource names (e.g., "-a1b2c3")
   */
  nameSuffix?: string;

  /**
   * Dependency layer for Lambda functions
   */
  dependencyLayer: lambda.ILayerVersion;

  /**
   * State DynamoDB table
   */
  stateTable: dynamodb.ITable;

  /**
   * Activity DynamoDB table
   */
  activityTable: dynamodb.ITable;

  /**
   * Media S3 bucket
   */
  mediaBucket: s3.IBucket;

  /**
   * Admin table for DM bot creation (optional)
   */
  adminTable?: dynamodb.ITable;

  /**
   * CDN URL for media delivery
   */
  cdnUrl?: string;

  /**
   * Replicate API key secret ARN
   */
  replicateApiKeyArn?: string;

  /**
   * Secrets Manager prefix
   */
  secretPrefix?: string;

  /**
   * Twitter API tier
   */
  twitterApiTier?: 'free' | 'basic';

  /**
   * Monthly Twitter API budget override
   */
  twitterMonthlyBudget?: number;

  /**
   * Percentage of daily budget to reserve for spikes
   */
  twitterDailyReservePct?: number;

  /**
   * Internal test key for non-production environments
   */
  internalTestKey?: string;

  /**
   * SNS topic for CloudWatch alarm notifications
   */
  alarmTopic?: sns.ITopic;

  /**
   * Raticross relay inbound authentication key
   */
  raticrossInboundKey?: string;
}

/**
 * Nested stack containing SharedHandlers and all associated resources.
 * This stack is deployed as a child of AdminApiStack to reduce the top-level stack's resource count.
 */
export class SharedHandlersStack extends cdk.NestedStack {
  public readonly sharedHandlers: SharedHandlers;

  constructor(scope: Construct, id: string, props: SharedHandlersStackProps) {
    super(scope, id, props);

    const {
      environment,
      nameSuffix,
      dependencyLayer,
      stateTable,
      activityTable,
      mediaBucket,
      adminTable,
      cdnUrl,
      replicateApiKeyArn,
      secretPrefix,
      twitterApiTier,
      twitterMonthlyBudget,
      twitterDailyReservePct,
      internalTestKey,
      alarmTopic,
      raticrossInboundKey,
    } = props;

    // Create SharedHandlers construct in the nested stack
    this.sharedHandlers = new SharedHandlers(this, 'SharedHandlers', {
      environment,
      nameSuffix,
      dependencyLayer,
      stateTable,
      activityTable,
      mediaBucket,
      adminTable,
      cdnUrl,
      replicateApiKeyArn,
      secretPrefix,
      twitterApiTier,
      twitterMonthlyBudget,
      twitterDailyReservePct,
      internalTestKey,
      alarmTopic,
      raticrossInboundKey,
    });
  }
}
