/**
 * Shared Infrastructure Construct
 * Creates shared resources used by all agents
 */
import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import { Construct } from 'constructs';

import * as path from 'path';
import { fileURLToPath } from 'url';

// ESM __dirname equivalent
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface SharedInfrastructureProps {
  /**
   * Environment name
   */
  environment: string;

  /**
   * Enable CloudFront CDN for media
   */
  enableCdn?: boolean;

  /**
   * Path to Lambda layers
   */
  layerCodePath?: string;

  /**
   * Custom domain for CDN (e.g., 'rati.chat')
   * If set, images will be served from https://{cdnDomain}/agents/{agentId}/images/{imageId}.png
   */
  cdnDomain?: string;

  /**
   * ACM certificate ARN for the CDN custom domain (must be in us-east-1)
   */
  cdnCertificateArn?: string;
}

export class SharedInfrastructure extends Construct {
  public readonly stateTable: dynamodb.Table;
  public readonly activityTable: dynamodb.Table;
  public readonly mediaBucket: s3.Bucket;
  public readonly distribution?: cloudfront.Distribution;
  public readonly dependencyLayer: lambda.LayerVersion;
  public readonly cdnUrl?: string;

  constructor(scope: Construct, id: string, props: SharedInfrastructureProps) {
    super(scope, id);

    const { environment, enableCdn = true, layerCodePath, cdnDomain, cdnCertificateArn } = props;

    // State table (multi-tenant)
    this.stateTable = new dynamodb.Table(this, 'StateTable', {
      tableName: `swarm-state-${environment}`,
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: environment === 'prod' 
        ? cdk.RemovalPolicy.RETAIN 
        : cdk.RemovalPolicy.DESTROY,
      timeToLiveAttribute: 'ttl',
    });

    // GSI for listing by type
    this.stateTable.addGlobalSecondaryIndex({
      indexName: 'gsi1',
      partitionKey: { name: 'gsi1pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'gsi1sk', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // Activity table
    this.activityTable = new dynamodb.Table(this, 'ActivityTable', {
      tableName: `swarm-activity-${environment}`,
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'timestamp', type: dynamodb.AttributeType.NUMBER },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: environment === 'prod' 
        ? cdk.RemovalPolicy.RETAIN 
        : cdk.RemovalPolicy.DESTROY,
      timeToLiveAttribute: 'ttl',
    });

    // Media bucket
    this.mediaBucket = new s3.Bucket(this, 'MediaBucket', {
      bucketName: `swarm-media-${environment}-${cdk.Aws.ACCOUNT_ID}`,
      removalPolicy: environment === 'prod' 
        ? cdk.RemovalPolicy.RETAIN 
        : cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: environment !== 'prod',
      cors: [
        {
          allowedMethods: [s3.HttpMethods.GET, s3.HttpMethods.PUT],
          allowedOrigins: ['*'],
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

      this.distribution = new cloudfront.Distribution(this, 'MediaCdn', {
        defaultBehavior: {
          origin: origins.S3BucketOrigin.withOriginAccessControl(this.mediaBucket),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        },
        comment: `Swarm media CDN (${environment})`,
        ...domainConfig,
      });

      // Set cdnUrl - use custom domain if configured, otherwise use CloudFront domain
      this.cdnUrl = cdnDomain
        ? `https://${cdnDomain}`
        : `https://${this.distribution.distributionDomainName}`;

      // Output the CDN URL for debugging
      new cdk.CfnOutput(this, 'MediaCdnUrl', {
        value: this.cdnUrl,
        description: 'CloudFront CDN URL for media files',
        exportName: `swarm-cdn-url-${environment}`,
      });

      if (cdnDomain) {
        new cdk.CfnOutput(this, 'CdnCnameTarget', {
          value: this.distribution.distributionDomainName,
          description: `Create CNAME: ${cdnDomain} -> this value`,
          exportName: `swarm-cdn-cname-target-${environment}`,
        });
      }
    } else {
      console.warn('WARNING: enableCdn is false! Media files will NOT be accessible.');
    }

    // Lambda layer with shared dependencies
    // The layer is pre-built in CI workflow before CDK deploy
    const layerPath = path.resolve(__dirname, '../../../layer');
    this.dependencyLayer = new lambda.LayerVersion(this, 'DependencyLayer', {
      layerVersionName: `swarm-deps-${environment}`,
      description: 'Shared dependencies for swarm handlers',
      compatibleRuntimes: [lambda.Runtime.NODEJS_20_X],
      code: layerCodePath 
        ? lambda.Code.fromAsset(layerCodePath)
        : lambda.Code.fromAsset(layerPath),
    });

    // Outputs
    new cdk.CfnOutput(this, 'StateTableName', {
      value: this.stateTable.tableName,
      exportName: `swarm-state-table-${environment}`,
    });

    new cdk.CfnOutput(this, 'ActivityTableName', {
      value: this.activityTable.tableName,
      exportName: `swarm-activity-table-${environment}`,
    });

    new cdk.CfnOutput(this, 'MediaBucketName', {
      value: this.mediaBucket.bucketName,
      exportName: `swarm-media-bucket-${environment}`,
    });

    if (this.distribution) {
      new cdk.CfnOutput(this, 'CdnDomain', {
        value: this.distribution.distributionDomainName,
        exportName: `swarm-cdn-domain-${environment}`,
      });
    }
  }
}
