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
import { createManagedWebAcl } from '../utils/waf.js';

export interface AdminUiProps {
  /**
   * Environment name
   */
  environment: string;
  /**
   * Optional suffix for resource names/exports (e.g., "-a1b2c3")
   */
  nameSuffix?: string;

  /**
   * Custom domain name (e.g., 'admin-staging.rati.chat')
   */
  domainName?: string;

  /**
   * ARN of ACM certificate for the custom domain (must be in us-east-1)
   */
  certificateArn?: string;

  /**
  * Optional API domain to proxy under /api (e.g., 'staging-swarm.rati.chat')
   * When set, CloudFront will forward /api/* requests to this origin (same-origin API).
   */
  apiDomain?: string;

  /**
   * Whether to include wildcard aliases (e.g. '*.rati.chat') on the CloudFront distribution.
   *
   * Default: enabled only for `prod`. For staging, keep this off so production can own the
   * wildcard in a separate account/distribution.
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
}

export class AdminUi extends Construct {
  public readonly bucket: s3.IBucket;
  public readonly distribution: cloudfront.Distribution;
  public readonly domainUrl: string;

  constructor(scope: Construct, id: string, props: AdminUiProps) {
    super(scope, id);

    const { environment, domainName, certificateArn, apiDomain, nameSuffix, includeWildcardAliases, useExistingBucket, skipDomainAliases, enableWaf = true } = props;
    const suffix = nameSuffix ?? '';
    const bucketName = `swarm-admin-ui-${environment}${suffix}-${cdk.Aws.ACCOUNT_ID}`;

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
      comment: `OAI for Admin UI (${environment})`,
    });

    // Grant read access to CloudFront
    this.bucket.grantRead(originAccessIdentity);

    // Prepare domain settings
    // For bot subdomains (e.g. '<bot-id>.rati.chat'), CloudFront must be configured to
    // serve TLS for those hostnames; otherwise Cloudflare will fail to handshake (525)
    // when proxying with SNI.
    const wildcardForDomain = (host: string): string | null => {
      const parts = host.split('.').filter(Boolean);
      if (parts.length < 2) return null;
      const baseDomain = parts.slice(-2).join('.');
      return `*.${baseDomain}`;
    };

    const shouldIncludeWildcardAliases = includeWildcardAliases ?? environment === 'prod';

    // When skipDomainAliases is true, we deploy without CNAME aliases.
    // This is useful when the CNAME is locked by an orphaned distribution and
    // needs to be associated after deployment using `aws cloudfront associate-alias`.
    const domainNames = (domainName && !skipDomainAliases)
      ? Array.from(
          new Set([
            domainName,
            // Wildcard is optional; only include it when we intend this distribution to serve
            // arbitrary subdomains for the base domain.
            ...(shouldIncludeWildcardAliases && wildcardForDomain(domainName)
              ? [wildcardForDomain(domainName)!]
              : []),
          ])
        )
      : undefined;

    const certificate = (certificateArn && !skipDomainAliases)
      ? acm.Certificate.fromCertificateArn(this, 'Certificate', certificateArn)
      : undefined;

    // Rewrite SPA routes to /index.html (but never touch /api/*)
    const spaRewriteFunction = new cloudfront.Function(this, 'SpaRewriteFunction', {
      comment: 'Rewrite non-file routes to /index.html for SPA routing (excluding /api/*)',
      code: cloudfront.FunctionCode.fromInline(`function handler(event) {
  var request = event.request;
  var uri = request.uri;

  // Never rewrite API requests
  if (uri === '/api' || uri.indexOf('/api/') === 0) {
    return request;
  }

  // If the URI looks like a static file (has an extension), leave it alone
  if (uri.indexOf('.') !== -1) {
    return request;
  }

  // Rewrite all other paths to the SPA entrypoint
  request.uri = '/index.html';
  return request;
}`),
    });

    // Strip /api prefix before proxying to the API origin
    const apiRewriteFunction = apiDomain
      ? new cloudfront.Function(this, 'ApiRewriteFunction', {
          comment: 'Strip /api prefix before forwarding to API origin',
          code: cloudfront.FunctionCode.fromInline(`function handler(event) {
  var request = event.request;
  var uri = request.uri;

  if (uri === '/api') {
    request.uri = '/';
    return request;
  }

  if (uri.indexOf('/api/') === 0) {
    request.uri = uri.substring(4);
  }

  return request;
}`),
        })
      : undefined;

    const cloudFrontWebAcl = enableWaf
      ? createManagedWebAcl(this, 'CloudFrontWebAcl', {
          scope: 'CLOUDFRONT',
          name: `swarm-admin-ui-${environment}${suffix}-webacl`,
          metricPrefix: `swarm-admin-ui-${environment}${suffix}`,
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
      additionalBehaviors: apiDomain && apiRewriteFunction
        ? {
            '/api/*': {
              origin: new origins.HttpOrigin(apiDomain, {
                protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
              }),
              viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
              allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
              cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
              // Forward cookies and auth headers.
              originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
              functionAssociations: [
                {
                  eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
                  function: apiRewriteFunction,
                },
              ],
            },

            // Telegram (and other) webhooks must accept POST, and should be reachable
            // at the public domain without requiring callers to know the raw API Gateway URL.
            '/webhook/*': {
              origin: new origins.HttpOrigin(apiDomain, {
                protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
              }),
              viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
              allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
              cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
              // Forward Telegram's secret header and other request headers
              originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
            },
          }
        : undefined,
      domainNames,
      certificate,
      defaultRootObject: 'index.html',
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      comment: `Admin UI - ${environment}`,
      webAclId: cloudFrontWebAcl?.attrArn,
      // SPA routing is handled by spaRewriteFunction (viewer-request).
      // Do NOT add errorResponses here — they intercept API Gateway 403/404
      // errors and serve index.html HTML, breaking JSON API calls.
    });

    // Set domain URL
    this.domainUrl = domainName 
      ? `https://${domainName}`
      : `https://${this.distribution.distributionDomainName}`;

    // Outputs
    new cdk.CfnOutput(this, 'BucketName', {
      value: this.bucket.bucketName,
      description: 'Admin UI S3 bucket name',
      exportName: `swarm-admin-ui-bucket-${environment}${suffix}`,
    });

    new cdk.CfnOutput(this, 'DistributionId', {
      value: this.distribution.distributionId,
      description: 'CloudFront distribution ID',
      exportName: `swarm-admin-ui-distribution-${environment}${suffix}`,
    });

    new cdk.CfnOutput(this, 'DistributionDomain', {
      value: this.distribution.distributionDomainName,
      description: 'CloudFront domain name',
      exportName: `swarm-admin-ui-cf-domain-${environment}${suffix}`,
    });

    new cdk.CfnOutput(this, 'AdminUrl', {
      value: this.domainUrl,
      description: 'Admin UI URL',
      exportName: `swarm-admin-ui-url-${environment}${suffix}`,
    });
  }
}
