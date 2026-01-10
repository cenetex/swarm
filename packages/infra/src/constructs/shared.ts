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
}

export class SharedInfrastructure extends Construct {
  public readonly stateTable: dynamodb.Table;
  public readonly activityTable: dynamodb.Table;
  public readonly mediaBucket: s3.Bucket;
  public readonly distribution?: cloudfront.Distribution;
  public readonly dependencyLayer: lambda.LayerVersion;

  constructor(scope: Construct, id: string, props: SharedInfrastructureProps) {
    super(scope, id);

    const { environment, enableCdn = true, layerCodePath } = props;

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

    // CloudFront CDN
    if (enableCdn) {
      this.distribution = new cloudfront.Distribution(this, 'MediaCdn', {
        defaultBehavior: {
          origin: new origins.S3Origin(this.mediaBucket),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        },
        comment: `Swarm media CDN (${environment})`,
      });
    }

    // Lambda layer with shared dependencies
    // Use local bundling to avoid Docker issues with pnpm workspaces
    const layerPath = path.resolve(__dirname, '../../../layer');
    this.dependencyLayer = new lambda.LayerVersion(this, 'DependencyLayer', {
      layerVersionName: `swarm-deps-${environment}`,
      description: 'Shared dependencies for swarm handlers',
      compatibleRuntimes: [lambda.Runtime.NODEJS_20_X],
      code: layerCodePath 
        ? lambda.Code.fromAsset(layerCodePath)
        : lambda.Code.fromAsset(layerPath, {
            bundling: {
              image: lambda.Runtime.NODEJS_20_X.bundlingImage,
              local: {
                tryBundle(outputDir: string): boolean {
                  // Use local bundling with npm (not pnpm) for layer
                  const { execSync } = require('child_process');
                  const fs = require('fs');
                  const pathMod = require('path');
                  
                  const nodejsDir = pathMod.join(outputDir, 'nodejs');
                  fs.mkdirSync(nodejsDir, { recursive: true });
                  
                  // Copy layer package.json
                  fs.copyFileSync(
                    pathMod.join(layerPath, 'package.json'),
                    pathMod.join(nodejsDir, 'package.json')
                  );
                  
                  // Install with npm (not pnpm) to avoid workspace protocol issues
                  execSync('npm install --omit=dev --legacy-peer-deps', {
                    cwd: nodejsDir,
                    stdio: 'inherit',
                  });
                  
                  return true;
                },
              },
              command: ['echo', 'Docker bundling not used'],
            },
          }),
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
