/**
 * Profile Page Infrastructure
 * S3 + CloudFront for hosting public avatar profile pages at *.rati.chat subdomains
 */
import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import { Construct } from 'constructs';
import { createManagedWebAcl } from '../utils/waf.js';

export interface ProfilePageProps {
  /**
   * Environment name (dev, staging, prod)
   */
  environment: string;

  /**
   * Optional suffix for resource names/exports (e.g., "-a1b2c3")
   */
  nameSuffix?: string;

  /**
   * Custom domain name for the profile page (e.g., 'profiles.rati.chat')
   * This will also add wildcard support for *.rati.chat if includeWildcardAliases is true
   */
  domainName?: string;

  /**
   * ARN of ACM certificate for the custom domain (must be in us-east-1)
   * This certificate should cover both the domain and wildcard (e.g., *.rati.chat)
   */
  certificateArn?: string;

  /**
   * Whether to include wildcard aliases (e.g., '*.rati.chat') on the CloudFront distribution.
   * Default: enabled only for `prod`.
   */
  includeWildcardAliases?: boolean;

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

  /**
   * API URL for the profile page to fetch data from (e.g., 'https://api.rati.chat')
   * This is used to configure CORS and pass to the frontend if needed.
   */
  apiUrl?: string;
}

export class ProfilePage extends Construct {
  public readonly bucket: s3.IBucket;
  public readonly distribution: cloudfront.Distribution;
  public readonly domainUrl: string;

  constructor(scope: Construct, id: string, props: ProfilePageProps) {
    super(scope, id);

    const {
      environment,
      domainName,
      certificateArn,
      nameSuffix,
      includeWildcardAliases,
      useExistingBucket,
      skipDomainAliases,
      enableWaf = true,
    } = props;

    const suffix = nameSuffix ?? '';
    const bucketName = `swarm-profile-page-${environment}${suffix}-${cdk.Aws.ACCOUNT_ID}`;

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
      comment: `OAI for Profile Page (${environment})`,
    });

    // Grant read access to CloudFront
    this.bucket.grantRead(originAccessIdentity);

    // Prepare domain settings
    // For avatar subdomains (e.g. '<avatar-id>.rati.chat'), CloudFront must be configured to
    // serve TLS for those hostnames
    const wildcardForDomain = (host: string): string | null => {
      const parts = host.split('.').filter(Boolean);
      if (parts.length < 2) return null;
      const baseDomain = parts.slice(-2).join('.');
      return `*.${baseDomain}`;
    };

    const shouldIncludeWildcardAliases = includeWildcardAliases ?? environment === 'prod';

    // When skipDomainAliases is true, we deploy without CNAME aliases.
    const domainNames = (domainName && !skipDomainAliases)
      ? Array.from(
          new Set([
            domainName,
            // Wildcard for avatar subdomains (e.g., avatar-id.rati.chat)
            ...(shouldIncludeWildcardAliases && wildcardForDomain(domainName)
              ? [wildcardForDomain(domainName)!]
              : []),
          ])
        )
      : undefined;

    const certificate = (certificateArn && !skipDomainAliases)
      ? acm.Certificate.fromCertificateArn(this, 'Certificate', certificateArn)
      : undefined;

    // CloudFront Function to rewrite requests for SPA-style routing
    // Since we're using subdomains for avatar IDs, we always serve index.html
    // The frontend JavaScript extracts the avatar ID from the subdomain
    const spaRewriteFunction = new cloudfront.Function(this, 'SpaRewriteFunction', {
      comment: 'Rewrite non-file routes to /index.html for SPA routing',
      code: cloudfront.FunctionCode.fromInline(`function handler(event) {
  var request = event.request;
  var uri = request.uri;

  // If the URI looks like a static file (has an extension), leave it alone
  if (uri.indexOf('.') !== -1) {
    return request;
  }

  // Rewrite all other paths to the SPA entrypoint
  request.uri = '/index.html';
  return request;
}`),
    });

    // CloudFront distribution
    const cloudFrontWebAcl = enableWaf
      ? createManagedWebAcl(this, 'CloudFrontWebAcl', {
          scope: 'CLOUDFRONT',
          name: `swarm-profile-page-${environment}${suffix}-webacl`,
          metricPrefix: `swarm-profile-page-${environment}${suffix}`,
        })
      : undefined;

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
      comment: `Profile Page - ${environment}`,
      webAclId: cloudFrontWebAcl?.attrArn,
      // Custom error responses for SPA routing fallback
      // If S3 returns 403/404 for a path, serve index.html instead (for client-side routing)
      errorResponses: [
        {
          httpStatus: 403,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: cdk.Duration.seconds(0),
        },
        {
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: cdk.Duration.seconds(0),
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
      description: 'Profile Page S3 bucket name',
      exportName: `swarm-profile-page-bucket-${environment}${suffix}`,
    });

    new cdk.CfnOutput(this, 'DistributionId', {
      value: this.distribution.distributionId,
      description: 'Profile Page CloudFront distribution ID',
      exportName: `swarm-profile-page-distribution-${environment}${suffix}`,
    });

    new cdk.CfnOutput(this, 'DistributionDomain', {
      value: this.distribution.distributionDomainName,
      description: 'Profile Page CloudFront domain name',
      exportName: `swarm-profile-page-cf-domain-${environment}${suffix}`,
    });

    new cdk.CfnOutput(this, 'ProfilePageUrl', {
      value: this.domainUrl,
      description: 'Profile Page URL',
      exportName: `swarm-profile-page-url-${environment}${suffix}`,
    });
  }
}
