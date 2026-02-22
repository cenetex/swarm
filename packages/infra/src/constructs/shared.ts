/**
 * Shared Infrastructure Construct
 * Creates shared resources used by all avatars
 */
import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as snsSubscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';
import { createManagedWebAcl } from '../utils/waf.js';

import * as path from 'path';
import { fileURLToPath } from 'url';
import { computeDependencyLayerAssetHash } from '../utils/layer-asset-hash.js';

// ESM __dirname equivalent
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface SharedInfrastructureProps {
  /**
   * Environment name
   */
  environment: string;
  /**
   * Optional suffix for resource names/exports (e.g., "-a1b2c3")
   */
  nameSuffix?: string;

  /**
   * Enable CloudFront CDN for media
   */
  enableCdn?: boolean;

  /**
   * Enable WAF on CloudFront distributions.
   * Set to false for staging to reduce idle cost.
   * @default true
   */
  enableWaf?: boolean;

  /**
   * Path to Lambda layers
   */
  layerCodePath?: string;

  /**
   * Custom domain for CDN (e.g., 'rati.chat')
   * If set, images will be served from https://{cdnDomain}/avatars/{avatarId}/images/{imageId}.png
   */
  cdnDomain?: string;

  /**
   * ACM certificate ARN for the CDN custom domain (must be in us-east-1)
   */
  cdnCertificateArn?: string;

  /**
   * Whether to import existing S3 bucket instead of creating a new one.
   * Use this when the bucket already exists (e.g., from a previous stack with RETAIN policy).
   */
  useExistingMediaBucket?: boolean;

  /**
   * Email address for CloudWatch alarm notifications via SNS.
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
   * Used as a fallback when useExistingResources=true and cdnDomain is not set.
   * This allows the split stack to reference the existing CloudFront distribution
   * without needing a custom domain or certificate.
   */
  mediaCdnUrl?: string;
}

export class SharedInfrastructure extends Construct {
  public readonly stateTable: dynamodb.ITable;
  public readonly activityTable: dynamodb.ITable;
  public readonly mediaBucket: s3.IBucket;
  public readonly distribution?: cloudfront.IDistribution;
  public readonly dependencyLayer: lambda.LayerVersion;
  public readonly cdnUrl?: string;
  public readonly alarmTopic: sns.ITopic;
  public readonly discordCluster: ecs.ICluster;

  constructor(scope: Construct, id: string, props: SharedInfrastructureProps) {
    super(scope, id);

    const {
      environment, enableCdn = true, enableWaf = true, layerCodePath, cdnDomain, cdnCertificateArn,
      nameSuffix, useExistingMediaBucket, alarmNotificationEmail, useExistingResources,
      mediaCdnUrl,
    } = props;
    const suffix = nameSuffix ?? '';
    const isPersistentEnv = environment === 'prod' || environment === 'production' || environment === 'staging';

    // ───── Lambda layer (always created, owned by this stack) ─────
    const layerPath = path.resolve(__dirname, '../../../layer');
    this.dependencyLayer = new lambda.LayerVersion(this, 'DependencyLayer', {
      layerVersionName: `swarm-deps-${environment}${suffix}`,
      description: 'Shared dependencies for swarm handlers',
      compatibleRuntimes: [lambda.Runtime.NODEJS_20_X],
      code: layerCodePath
        ? lambda.Code.fromAsset(layerCodePath)
        : lambda.Code.fromAsset(layerPath, {
            assetHash: computeDependencyLayerAssetHash(layerPath),
          }),
    });

    if (useExistingResources) {
      // ───── Import existing resources owned by legacy monolith stack ─────
      this.stateTable = dynamodb.Table.fromTableName(
        this, 'StateTable', `swarm-state-${environment}${suffix}`,
      );
      this.activityTable = dynamodb.Table.fromTableName(
        this, 'ActivityTable', `swarm-activity-${environment}${suffix}`,
      );

      const mediaBucketName = `swarm-media-${environment}${suffix}-${cdk.Aws.ACCOUNT_ID}`;
      this.mediaBucket = s3.Bucket.fromBucketName(this, 'MediaBucket', mediaBucketName);

      // Alarm topic – create fresh (not in legacy monolith)
      this.alarmTopic = new sns.Topic(this, 'AlarmTopic', {
        topicName: `swarm-alarms-${environment}${suffix}`,
        displayName: `Swarm Alarms (${environment})`,
      });
      if (alarmNotificationEmail) {
        this.alarmTopic.addSubscription(
          new snsSubscriptions.EmailSubscription(alarmNotificationEmail),
        );
      }

      // Discord cluster – import by name
      const vpc = ec2.Vpc.fromLookup(this, 'DefaultVpc', { isDefault: true });
      this.discordCluster = ecs.Cluster.fromClusterAttributes(this, 'DiscordCluster', {
        clusterName: `swarm-discord-${environment}${suffix}`,
        vpc,
        securityGroups: [],
      });

      // CDN – reference the existing distribution managed by legacy stack.
      // Prefer cdnDomain (custom domain), then mediaCdnUrl (explicit CloudFront URL).
      if (enableCdn) {
        if (cdnDomain) {
          this.cdnUrl = `https://${cdnDomain}`;
        } else if (mediaCdnUrl) {
          // mediaCdnUrl is the explicit CloudFront distribution URL (e.g. https://d1234.cloudfront.net)
          this.cdnUrl = mediaCdnUrl.startsWith('https://') ? mediaCdnUrl : `https://${mediaCdnUrl}`;
        }

        // Synth-time validation: fail early if CDN is enabled but no URL could be resolved
        if (!this.cdnUrl) {
          throw new Error(
            `[SharedInfrastructure] useExistingResources=true with enableCdn=true but no CDN URL could be resolved. ` +
            `Set either 'galleryDomain' (custom domain) or 'mediaCdnUrl' (CloudFront distribution URL) ` +
            `in cdk.context.json or via -c context args.`
          );
        }
      }
      // No CfnOutputs – exports from legacy stack still active
      return;
    }

    // ═════ Create resources from scratch ═════

    // State table (multi-tenant)
    const stateTable = new dynamodb.Table(this, 'StateTable', {
      tableName: `swarm-state-${environment}${suffix}`,
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: isPersistentEnv
        ? cdk.RemovalPolicy.RETAIN
        : cdk.RemovalPolicy.DESTROY,
      deletionProtection: isPersistentEnv,
      pointInTimeRecoverySpecification: isPersistentEnv
        ? { pointInTimeRecoveryEnabled: true }
        : undefined,
      timeToLiveAttribute: 'ttl',
    });

    // GSI for listing by type
    stateTable.addGlobalSecondaryIndex({
      indexName: 'GSI1',
      partitionKey: { name: 'gsi1pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'gsi1sk', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });
    this.stateTable = stateTable;

    // Activity table
    this.activityTable = new dynamodb.Table(this, 'ActivityTable', {
      tableName: `swarm-activity-${environment}${suffix}`,
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'timestamp', type: dynamodb.AttributeType.NUMBER },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: isPersistentEnv
        ? cdk.RemovalPolicy.RETAIN
        : cdk.RemovalPolicy.DESTROY,
      deletionProtection: isPersistentEnv,
      pointInTimeRecoverySpecification: isPersistentEnv
        ? { pointInTimeRecoveryEnabled: true }
        : undefined,
      timeToLiveAttribute: 'ttl',
    });

    // Media bucket - import existing or create new
    const mediaBucketName = `swarm-media-${environment}${suffix}-${cdk.Aws.ACCOUNT_ID}`;
    if (useExistingMediaBucket) {
      this.mediaBucket = s3.Bucket.fromBucketName(this, 'MediaBucket', mediaBucketName);
    } else {
      this.mediaBucket = new s3.Bucket(this, 'MediaBucket', {
        bucketName: mediaBucketName,
        removalPolicy: isPersistentEnv
          ? cdk.RemovalPolicy.RETAIN
          : cdk.RemovalPolicy.DESTROY,
        autoDeleteObjects: !isPersistentEnv,
        versioned: isPersistentEnv,
        encryption: s3.BucketEncryption.S3_MANAGED,
        blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        enforceSSL: true,
        cors: [
          {
            allowedMethods: [s3.HttpMethods.GET, s3.HttpMethods.PUT],
            allowedOrigins: ['*'], // Restricted to CloudFront at the origin level
            allowedHeaders: ['*'],
          },
        ],
        lifecycleRules: [
          {
            id: 'expire-temp-files',
            prefix: 'temp/',
            expiration: cdk.Duration.days(1),
          },
          {
            id: 'intelligent-tiering',
            transitions: [
              {
                storageClass: s3.StorageClass.INTELLIGENT_TIERING,
                transitionAfter: cdk.Duration.days(30),
              },
            ],
          },
        ],
      });
    }

    // CloudFront CDN - REQUIRED for media to be accessible
    // S3 bucket is private, only CloudFront can access it via OAI
    if (enableCdn) {
      // Configure custom domain if provided
      const domainConfig: {
        domainNames?: string[];
        certificate?: acm.ICertificate;
      } = {};

      if (cdnDomain && cdnCertificateArn) {
        domainConfig.domainNames = [cdnDomain];
        domainConfig.certificate = acm.Certificate.fromCertificateArn(
          this,
          'CdnCertificate',
          cdnCertificateArn
        );
      }

      // Access log bucket for CloudFront (persistent environments only)
      const logBucket = isPersistentEnv
        ? new s3.Bucket(this, 'CdnLogBucket', {
            bucketName: `swarm-cdn-logs-${environment}${suffix}-${cdk.Aws.ACCOUNT_ID}`,
            removalPolicy: cdk.RemovalPolicy.RETAIN,
            encryption: s3.BucketEncryption.S3_MANAGED,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            enforceSSL: true,
            lifecycleRules: [{
              id: 'expire-old-logs',
              expiration: cdk.Duration.days(90),
            }],
            objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_PREFERRED,
          })
        : undefined;

      this.distribution = new cloudfront.Distribution(this, 'MediaCdn', {
        defaultBehavior: {
          origin: origins.S3BucketOrigin.withOriginAccessControl(this.mediaBucket),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        },
        comment: `Swarm media CDN (${environment})`,
        ...(logBucket ? { logBucket, logFilePrefix: 'cdn/' } : {}),
        ...domainConfig,
        ...(enableWaf ? {
          webAclId: createManagedWebAcl(this, 'MediaCdnWebAcl', {
            scope: 'CLOUDFRONT',
            name: `swarm-media-cdn-${environment}${suffix}-webacl`,
            metricPrefix: `swarm-media-cdn-${environment}${suffix}`,
          }).attrArn,
        } : {}),
      });

      // Set cdnUrl - use custom domain if configured, otherwise use CloudFront domain
      this.cdnUrl = cdnDomain
        ? `https://${cdnDomain}`
        : `https://${this.distribution.distributionDomainName}`;

      // Output the CDN URL for debugging
      new cdk.CfnOutput(this, 'MediaCdnUrl', {
        value: this.cdnUrl,
        description: 'CloudFront CDN URL for media files',
        exportName: `swarm-cdn-url-${environment}${suffix}`,
      });

      if (cdnDomain) {
        new cdk.CfnOutput(this, 'CdnCnameTarget', {
          value: this.distribution.distributionDomainName,
          description: `Create CNAME: ${cdnDomain} -> this value`,
          exportName: `swarm-cdn-cname-target-${environment}${suffix}`,
        });
      }
    } else {
      console.warn('WARNING: enableCdn is false! Media files will NOT be accessible.');
    }

    // SNS topic for CloudWatch alarm notifications
    this.alarmTopic = new sns.Topic(this, 'AlarmTopic', {
      topicName: `swarm-alarms-${environment}${suffix}`,
      displayName: `Swarm Alarms (${environment})`,
    });

    if (alarmNotificationEmail) {
      this.alarmTopic.addSubscription(
        new snsSubscriptions.EmailSubscription(alarmNotificationEmail)
      );
    }

    const vpc = ec2.Vpc.fromLookup(this, 'DefaultVpc', { isDefault: true });
    this.discordCluster = new ecs.Cluster(this, 'DiscordCluster', {
      vpc,
      clusterName: `swarm-discord-${environment}${suffix}`,
    });

    // Outputs
    new cdk.CfnOutput(this, 'StateTableName', {
      value: this.stateTable.tableName,
      exportName: `swarm-state-table-${environment}${suffix}`,
    });

    new cdk.CfnOutput(this, 'ActivityTableName', {
      value: this.activityTable.tableName,
      exportName: `swarm-activity-table-${environment}${suffix}`,
    });

    new cdk.CfnOutput(this, 'MediaBucketName', {
      value: this.mediaBucket.bucketName,
      exportName: `swarm-media-bucket-${environment}${suffix}`,
    });

    if (this.distribution) {
      new cdk.CfnOutput(this, 'CdnDomain', {
        value: this.distribution.distributionDomainName,
        exportName: `swarm-cdn-domain-${environment}${suffix}`,
      });
    }

    // Note: AlarmTopicArn export is handled by SharedInfraStack (not here)
    // to avoid duplicate CloudFormation export names.
  }
}
