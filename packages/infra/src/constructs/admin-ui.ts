/**
 * Admin UI Infrastructure
 * S3 + CloudFront for hosting the admin dashboard with custom domain support
 */
import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import { Construct } from 'constructs';

export interface AdminUiProps {
  /**
   * Environment name
   */
  environment: string;

  /**
   * Custom domain name (e.g., 'admin-staging.rati.chat')
   */
  domainName?: string;

  /**
   * ARN of ACM certificate for the custom domain (must be in us-east-1)
   */
  certificateArn?: string;
}

export class AdminUi extends Construct {
  public readonly bucket: s3.Bucket;
  public readonly distribution: cloudfront.Distribution;
  public readonly domainUrl: string;

  constructor(scope: Construct, id: string, props: AdminUiProps) {
    super(scope, id);

    const { environment, domainName, certificateArn } = props;

    // S3 bucket for static hosting
    this.bucket = new s3.Bucket(this, 'Bucket', {
      bucketName: `swarm-admin-ui-${environment}-${cdk.Aws.ACCOUNT_ID}`,
      removalPolicy: environment === 'prod'
        ? cdk.RemovalPolicy.RETAIN
        : cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: environment !== 'prod',
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
    });

    // CloudFront Origin Access Identity
    const originAccessIdentity = new cloudfront.OriginAccessIdentity(this, 'OAI', {
      comment: `OAI for Admin UI (${environment})`,
    });

    // Grant read access to CloudFront
    this.bucket.grantRead(originAccessIdentity);

    // Prepare domain settings
    const domainNames = domainName ? [domainName] : undefined;
    const certificate = certificateArn
      ? acm.Certificate.fromCertificateArn(this, 'Certificate', certificateArn)
      : undefined;

    // CloudFront distribution
    this.distribution = new cloudfront.Distribution(this, 'Distribution', {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessIdentity(this.bucket, {
          originAccessIdentity,
        }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
      },
      domainNames,
      certificate,
      defaultRootObject: 'index.html',
      errorResponses: [
        {
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: cdk.Duration.seconds(0),
        },
        {
          httpStatus: 403,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: cdk.Duration.seconds(0),
        },
      ],
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      comment: `Admin UI - ${environment}`,
    });

    // Set domain URL
    this.domainUrl = domainName 
      ? `https://${domainName}`
      : `https://${this.distribution.distributionDomainName}`;

    // Outputs
    new cdk.CfnOutput(this, 'BucketName', {
      value: this.bucket.bucketName,
      description: 'Admin UI S3 bucket name',
      exportName: `swarm-admin-ui-bucket-${environment}`,
    });

    new cdk.CfnOutput(this, 'DistributionId', {
      value: this.distribution.distributionId,
      description: 'CloudFront distribution ID',
      exportName: `swarm-admin-ui-distribution-${environment}`,
    });

    new cdk.CfnOutput(this, 'DistributionDomain', {
      value: this.distribution.distributionDomainName,
      description: 'CloudFront domain name',
      exportName: `swarm-admin-ui-cf-domain-${environment}`,
    });

    new cdk.CfnOutput(this, 'AdminUrl', {
      value: this.domainUrl,
      description: 'Admin UI URL',
      exportName: `swarm-admin-ui-url-${environment}`,
    });
  }
}
