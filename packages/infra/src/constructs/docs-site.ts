/**
 * Docs Site Infrastructure
 * S3 + CloudFront for hosting the VitePress documentation site at docs.rati.chat
 */
import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import { Construct } from 'constructs';
import { createManagedWebAcl } from '../utils/waf.js';

export interface DocsSiteProps {
  /**
   * Environment name (dev, staging, prod)
   */
  environment: string;

  /**
   * Optional suffix for resource names/exports (e.g., "-a1b2c3")
   */
  nameSuffix?: string;

  /**
   * Custom domain name for the docs site (e.g., 'docs.rati.chat')
   */
  domainName?: string;

  /**
   * ARN of ACM certificate for the custom domain (must be in us-east-1)
   */
  certificateArn?: string;

  /**
   * Whether to import an existing bucket instead of creating a new one.
   * Use this when the bucket already exists (e.g., from a previous stack with RETAIN policy).
   */
  useExistingBucket?: boolean;

  /**
   * Whether to skip adding domain aliases to the CloudFront distribution.
   * Use this when the CNAME is locked by an orphaned distribution and needs to be
   * associated after deployment using `aws cloudfront associate-alias`.
   */
  skipDomainAliases?: boolean;

  /**
   * Enable WAF on the CloudFront distribution.
   * Set to false for staging to reduce idle cost.
   * @default true
   */
  enableWaf?: boolean;
}

export class DocsSite extends Construct {
  public readonly bucket: s3.IBucket;
  public readonly distribution: cloudfront.Distribution;
  public readonly domainUrl: string;

  constructor(scope: Construct, id: string, props: DocsSiteProps) {
    super(scope, id);

    const {
      environment,
      domainName,
      certificateArn,
      nameSuffix,
      useExistingBucket,
      skipDomainAliases,
      enableWaf = true,
    } = props;

    const suffix = nameSuffix ?? '';
    const bucketName = `swarm-docs-site-${environment}${suffix}-${cdk.Aws.ACCOUNT_ID}`;

    // S3 bucket for static hosting - import existing or create new
    if (useExistingBucket) {
      this.bucket = s3.Bucket.fromBucketName(this, 'Bucket', bucketName);
    } else {
      this.bucket = new s3.Bucket(this, 'Bucket', {
        bucketName,
        removalPolicy: environment === 'prod'
          ? cdk.RemovalPolicy.RETAIN
          : cdk.RemovalPolicy.DESTROY,
        autoDeleteObjects: environment !== 'prod',
        blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        encryption: s3.BucketEncryption.S3_MANAGED,
      });
    }

    // CloudFront Origin Access Identity
    const originAccessIdentity = new cloudfront.OriginAccessIdentity(this, 'OAI', {
      comment: `OAI for Docs Site (${environment})`,
    });

    // Grant read access to CloudFront
    this.bucket.grantRead(originAccessIdentity);

    // When skipDomainAliases is true, we deploy without CNAME aliases.
    const domainNames = (domainName && !skipDomainAliases)
      ? [domainName]
      : undefined;

    const certificate = (certificateArn && !skipDomainAliases)
      ? acm.Certificate.fromCertificateArn(this, 'Certificate', certificateArn)
      : undefined;

    // CloudFront Function to rewrite requests for VitePress clean URLs
    // Rewrites paths without extensions to /index.html or appends .html
    const spaRewriteFunction = new cloudfront.Function(this, 'SpaRewriteFunction', {
      comment: 'Rewrite non-file routes for VitePress clean URL support',
      code: cloudfront.FunctionCode.fromInline(`function handler(event) {
  var request = event.request;
  var uri = request.uri;

  // If the URI has a file extension, serve it as-is
  if (uri.indexOf('.') !== -1) {
    return request;
  }

  // If the URI ends with /, serve index.html in that directory
  if (uri.endsWith('/')) {
    request.uri = uri + 'index.html';
    return request;
  }

  // Otherwise append .html (VitePress clean URLs)
  request.uri = uri + '.html';
  return request;
}`),
    });

    // WAF Web ACL (optional)
    const cloudFrontWebAcl = enableWaf
      ? createManagedWebAcl(this, 'CloudFrontWebAcl', {
          scope: 'CLOUDFRONT',
          name: `swarm-docs-site-${environment}${suffix}-webacl`,
          metricPrefix: `swarm-docs-site-${environment}${suffix}`,
        })
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
        functionAssociations: [
          {
            eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
            function: spaRewriteFunction,
          },
        ],
      },
      domainNames,
      certificate,
      defaultRootObject: 'index.html',
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      comment: `Docs Site - ${environment}`,
      webAclId: cloudFrontWebAcl?.attrArn,
      // Custom error responses: serve 404.html for missing pages
      errorResponses: [
        {
          httpStatus: 403,
          responseHttpStatus: 404,
          responsePagePath: '/404.html',
          ttl: cdk.Duration.seconds(10),
        },
        {
          httpStatus: 404,
          responseHttpStatus: 404,
          responsePagePath: '/404.html',
          ttl: cdk.Duration.seconds(10),
        },
      ],
    });

    // Set domain URL
    this.domainUrl = domainName
      ? `https://${domainName}`
      : `https://${this.distribution.distributionDomainName}`;

    // Outputs
    new cdk.CfnOutput(this, 'BucketName', {
      value: this.bucket.bucketName,
      description: 'Docs Site S3 bucket name',
      exportName: `swarm-docs-site-bucket-${environment}${suffix}`,
    });

    new cdk.CfnOutput(this, 'DistributionId', {
      value: this.distribution.distributionId,
      description: 'Docs Site CloudFront distribution ID',
      exportName: `swarm-docs-site-distribution-${environment}${suffix}`,
    });

    new cdk.CfnOutput(this, 'DistributionDomain', {
      value: this.distribution.distributionDomainName,
      description: 'Docs Site CloudFront domain name',
      exportName: `swarm-docs-site-cf-domain-${environment}${suffix}`,
    });

    new cdk.CfnOutput(this, 'DocsSiteUrl', {
      value: this.domainUrl,
      description: 'Docs Site URL',
      exportName: `swarm-docs-site-url-${environment}${suffix}`,
    });
  }
}
