/**
 * Shared Infrastructure Stack
 * Contains stable resources that rarely change: DynamoDB tables, S3 bucket, CDN, Lambda layer
 * This stack is deployed first and exports resources for other stacks
 */
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { SharedInfrastructure } from '../constructs/shared.js';
import { BudgetGuardrails } from '../constructs/budget-guardrails.js';

export interface SharedInfraStackProps extends cdk.StackProps {
  /**
   * Environment name (dev, staging, prod)
   */
  environment: string;
  /**
   * Optional suffix for resource names/exports (e.g., "-a1b2c3")
   */
  nameSuffix?: string;

  /**
   * Enable CloudFront CDN
   */
  enableCdn?: boolean;

  /**
   * Enable WAF on CloudFront distributions.
   * Set to false for staging to reduce idle cost (~$3.92/week per WAF).
   * @default true
   */
  enableWaf?: boolean;

  /**
   * Custom domain for gallery CDN (e.g., 'gallery.rati.chat')
   */
  galleryDomain?: string;

  /**
   * ACM certificate ARN for gallery CDN (must be in us-east-1)
   */
  galleryCertificateArn?: string;

  /**
   * Email address for CloudWatch alarm notifications.
   * When provided, an email subscription is added to the alarm SNS topic.
   */
  alarmNotificationEmail?: string;

  /**
   * When true, import shared resources (tables, buckets, cluster) by name
   * instead of creating new ones. Use when resources are still owned by
   * the legacy monolith stack (SwarmStack-{env}).
   */
  useExistingResources?: boolean;

  /**
   * Explicit CDN URL for media (e.g., 'https://dodxbiygmi95j.cloudfront.net').
   * Used as a fallback when useExistingResources=true and galleryDomain is not set.
   */
  mediaCdnUrl?: string;

  /**
   * Monthly budget limit in USD for cost governance.
   * When provided, creates an AWS Budget with alert thresholds (50/80/100%)
   * and a Cost Anomaly Detection monitor, both routed to the alarm SNS topic.
   * Recommended: staging=$100, prod=$500
   */
  monthlyBudgetUsd?: number;
}

export class SharedInfraStack extends cdk.Stack {
  public readonly shared: SharedInfrastructure;

  // Cross-stack references (exported via CloudFormation)
  public readonly stateTableArn: string;
  public readonly stateTableName: string;
  public readonly activityTableArn: string;
  public readonly activityTableName: string;
  public readonly mediaBucketArn: string;
  public readonly mediaBucketName: string;
  public readonly dependencyLayerArn: string;
  /**
   * SSM parameter name for the dependency layer ARN.
   * Consumer stacks should use this via SSM lookup to avoid CloudFormation export conflicts.
   */
  public readonly dependencyLayerArnParamName: string;
  public readonly cdnUrl?: string;
  public readonly cdnDistributionId?: string;
  public readonly alarmTopicArn: string;
  public readonly discordClusterArn: string;
  public readonly discordClusterName: string;

  constructor(scope: Construct, id: string, props: SharedInfraStackProps) {
    super(scope, id, props);

    const {
      environment,
      enableCdn = true,
      enableWaf = true,
      galleryDomain,
      galleryCertificateArn,
      nameSuffix,
      alarmNotificationEmail,
      useExistingResources,
      mediaCdnUrl,
      monthlyBudgetUsd,
    } = props;
    const suffix = nameSuffix ?? '';

    // SSM parameter name for dependency layer ARN. See #1654 for the
    // `/split` path rationale during migration off the legacy SwarmStack-*
    // monolith. Mirrors the gating in core-infra-stack.ts.
    const ssmPathSuffix = useExistingResources ? '/split' : '';
    this.dependencyLayerArnParamName = `/swarm/${environment}${suffix}/dependency-layer-arn${ssmPathSuffix}`;

    // Create shared infrastructure
    this.shared = new SharedInfrastructure(this, 'Shared', {
      environment,
      nameSuffix,
      enableCdn,
      enableWaf,
      cdnDomain: galleryDomain,
      cdnCertificateArn: galleryCertificateArn,
      alarmNotificationEmail,
      useExistingResources,
      mediaCdnUrl,
    });

    // Store references for cross-stack access
    this.stateTableArn = this.shared.stateTable.tableArn;
    this.stateTableName = this.shared.stateTable.tableName;
    this.activityTableArn = this.shared.activityTable.tableArn;
    this.activityTableName = this.shared.activityTable.tableName;
    this.mediaBucketArn = this.shared.mediaBucket.bucketArn;
    this.mediaBucketName = this.shared.mediaBucket.bucketName;
    this.dependencyLayerArn = this.shared.dependencyLayer.layerVersionArn;
    this.cdnUrl = this.shared.cdnUrl;
    this.cdnDistributionId = this.shared.distribution?.distributionId;
    this.alarmTopicArn = this.shared.alarmTopic.topicArn;
    this.discordClusterArn = this.shared.discordCluster.clusterArn;
    this.discordClusterName = this.shared.discordCluster.clusterName;

    // ───── Budget & Cost Anomaly Guardrails ─────
    if (monthlyBudgetUsd !== undefined && monthlyBudgetUsd > 0) {
      new BudgetGuardrails(this, 'BudgetGuardrails', {
        environment,
        nameSuffix,
        monthlyBudgetUsd,
        alarmTopic: this.shared.alarmTopic,
      });
    }

    // Store dependency layer ARN in SSM to allow updates without breaking cross-stack refs.
    // CloudFormation exports fail to update when imported by another stack, but SSM parameters
    // can be updated freely.
    new ssm.StringParameter(this, 'DependencyLayerArnParam', {
      parameterName: this.dependencyLayerArnParamName,
      stringValue: this.dependencyLayerArn,
      description: 'Dependency layer ARN for swarm handlers',
    });

    // Export values for cross-stack references
    new cdk.CfnOutput(this, 'StateTableArnExport', {
      value: this.stateTableArn,
      exportName: `swarm-state-table-arn-${environment}${suffix}`,
    });

    new cdk.CfnOutput(this, 'StateTableNameExport', {
      value: this.stateTableName,
      exportName: `swarm-state-table-name-${environment}${suffix}`,
    });

    new cdk.CfnOutput(this, 'ActivityTableArnExport', {
      value: this.activityTableArn,
      exportName: `swarm-activity-table-arn-${environment}${suffix}`,
    });

    new cdk.CfnOutput(this, 'MediaBucketArnExport', {
      value: this.mediaBucketArn,
      exportName: `swarm-media-bucket-arn-${environment}${suffix}`,
    });

    new cdk.CfnOutput(this, 'MediaBucketNameExport', {
      value: this.mediaBucketName,
      exportName: `swarm-media-bucket-name-${environment}${suffix}`,
    });

    new cdk.CfnOutput(this, 'DependencyLayerArnExport', {
      value: this.dependencyLayerArn,
      exportName: `swarm-dependency-layer-arn-${environment}${suffix}`,
    });

    if (this.cdnDistributionId) {
      new cdk.CfnOutput(this, 'CdnDistributionIdExport', {
        value: this.cdnDistributionId,
        exportName: `swarm-cdn-distribution-id-${environment}${suffix}`,
      });
    }

    new cdk.CfnOutput(this, 'DiscordClusterArnExport', {
      value: this.discordClusterArn,
      exportName: `swarm-discord-cluster-arn-${environment}${suffix}`,
    });

    new cdk.CfnOutput(this, 'AlarmTopicArnExport', {
      value: this.alarmTopicArn,
      exportName: `swarm-alarm-topic-arn-${environment}${suffix}`,
    });
  }
}
