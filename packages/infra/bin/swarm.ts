#!/usr/bin/env node
/**
 * CDK App Entry Point
 * 
 * Stacks are organized for parallel deployment:
 * 1. SharedInfraStack - DynamoDB, S3, CDN, Lambda layer (rarely changes)
 * 2. AdminApiStack - API Gateway, Lambda handlers (changes with code)
 * 3. AdminUiStack - CloudFront for UI (changes with UI)
 */
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { SharedInfraStack } from '../src/stacks/shared-infra-stack.js';
import { AdminApiStack } from '../src/stacks/admin-api-stack.js';
import { AdminUiStack } from '../src/stacks/admin-ui-stack.js';
import { ProfilePageStack } from '../src/stacks/profile-page-stack.js';

// ESM equivalent of __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = new cdk.App();

type EnvConfig = Record<string, unknown>;

function parseBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  if (normalized === '1') return true;
  if (normalized === '0') return false;
  return undefined;
}

function normalizeEnvironmentName(env: string): string {
  // Support both "production" (GitHub env) and "prod" (CDK stack env)
  return env === 'production' ? 'prod' : env;
}

function computeStackDomain(args: { environment: string; stackSubdomain: string; baseDomain: string }): string | undefined {
  const environment = normalizeEnvironmentName(args.environment);
  if (!args.stackSubdomain || !args.baseDomain) return undefined;

  if (environment === 'prod') {
    return `${args.stackSubdomain}.${args.baseDomain}`;
  }

  // Common pattern: <env>-<stack>.<base>
  if (environment === 'staging') {
    return `${environment}-${args.stackSubdomain}.${args.baseDomain}`;
  }

  return undefined;
}

function getContextValue<T>(key: string, envConfig: EnvConfig): T | undefined {
  // Prefer explicit CDK context overrides (e.g. `-c adminDomain=...`) over envConfig.
  const fromContext = app.node.tryGetContext(key);
  if (fromContext !== undefined) return fromContext as T;

  const fromEnv = (envConfig as Record<string, unknown>)[key];
  return fromEnv as T | undefined;
}

// Get environment from context or default
const rawEnvironment = (app.node.tryGetContext('environment') as string | undefined) || 'dev';
const environment = normalizeEnvironmentName(rawEnvironment);

// Get environment-specific config
const environments = (app.node.tryGetContext('environments') as Record<string, EnvConfig> | undefined) || {};
const envConfig = environments[environment] || environments[rawEnvironment] || {};

// Domain configuration
// Prefer explicit adminDomain, but allow a computed stack domain for easier multi-stack deployments.
const disableComputedAdminDomain =
  parseBoolean(getContextValue<unknown>('disableComputedAdminDomain', envConfig)) ?? false;
const domainBase = getContextValue<string>('domainBase', envConfig) || 'rati.chat';
const stackSubdomain = getContextValue<string>('stackSubdomain', envConfig) || 'swarm';
const computedAdminDomain = disableComputedAdminDomain
  ? undefined
  : computeStackDomain({ environment, stackSubdomain, baseDomain: domainBase });

const adminDomain = getContextValue<string>('adminDomain', envConfig) || computedAdminDomain;
const adminCertificateArn = getContextValue<string>('adminCertificateArn', envConfig);
const adminEmails = getContextValue<string>('adminEmails', envConfig);
const adminWallets = getContextValue<string>('adminWallets', envConfig);
const openRouterApiKeyArn = getContextValue<string>('openRouterApiKeyArn', envConfig);
const replicateApiKeyArn = getContextValue<string>('replicateApiKeyArn', envConfig);
const heliusApiKeyArn = getContextValue<string>('heliusApiKeyArn', envConfig);
const webSearchApiKeyArn = getContextValue<string>('webSearchApiKeyArn', envConfig);
const webSearchProvider = getContextValue<string>('webSearchProvider', envConfig);
const privyAppId = getContextValue<string>('privyAppId', envConfig);
const privyAppSecretArn = getContextValue<string>('privyAppSecretArn', envConfig);
const privyJwtVerificationKeyArn = getContextValue<string>('privyJwtVerificationKeyArn', envConfig);
const stripeSecretKeyArn = getContextValue<string>('stripeSecretKeyArn', envConfig);
const stripeWebhookSecretArn = getContextValue<string>('stripeWebhookSecretArn', envConfig);
const stripePriceIdPro = getContextValue<string>('stripePriceIdPro', envConfig);
const stripePriceIdEnterprise = getContextValue<string>('stripePriceIdEnterprise', envConfig);
const galleryDomain = getContextValue<string>('galleryDomain', envConfig);
const galleryCertificateArn = getContextValue<string>('galleryCertificateArn', envConfig);
const mediaCdnUrl = getContextValue<string>('mediaCdnUrl', envConfig);
const profileDomain = getContextValue<string>('profileDomain', envConfig);
const profileCertificateArn = getContextValue<string>('profileCertificateArn', envConfig);
const profileApiUrl = getContextValue<string>('profileApiUrl', envConfig);
const alarmNotificationEmail = getContextValue<string>('alarmNotificationEmail', envConfig) || process.env.ALARM_EMAIL;
const enableWaf = parseBoolean(getContextValue<unknown>('enableWaf', envConfig)) ?? true;
const enableClaudeCode = parseBoolean(getContextValue<unknown>('enableClaudeCode', envConfig)) ?? false;
const claudeCodeUseOpenRouter = parseBoolean(getContextValue<unknown>('claudeCodeUseOpenRouter', envConfig)) ?? false;
const enableDiscordGateway = parseBoolean(getContextValue<unknown>('enableDiscordGateway', envConfig)) ?? false;
const useExistingResources = parseBoolean(getContextValue<unknown>('useExistingResources', envConfig)) ?? false;
const useExistingBuckets = parseBoolean(getContextValue<unknown>('useExistingBuckets', envConfig)) ?? false;
const skipDomainAliases = parseBoolean(getContextValue<unknown>('skipDomainAliases', envConfig)) ?? false;
const anthropicApiKeyArn = getContextValue<string>('anthropicApiKeyArn', envConfig);
const secretPrefixRaw = getContextValue<string>('secretPrefix', envConfig);
const stackHashRaw = getContextValue<string>('stackHash', envConfig);

function normalizeStackHash(value?: string): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!/^[a-f0-9]{6}$/i.test(trimmed)) {
    throw new Error(`Invalid stackHash "${value}". Expected 6 hex chars.`);
  }
  return trimmed.toLowerCase();
}

const stackHash = normalizeStackHash(stackHashRaw);
const nameSuffix = stackHash ? `-${stackHash}` : '';

// Suffix strategy for migration mode (useExistingResources=true):
// - SharedInfra: no suffix — imports existing resources from legacy monolith
// - AdminApi/AdminUi: '-split' suffix — avoids collisions with legacy monolith's non-shared resources
// When no migration (useExistingResources=false or stackHash provided): all use nameSuffix.
const nonSharedResourceSuffix = (useExistingResources && !nameSuffix) ? '-split' : nameSuffix;

const secretPrefix = (secretPrefixRaw && secretPrefixRaw.trim())
  ? secretPrefixRaw.trim()
  : (useExistingResources && nonSharedResourceSuffix)
    ? `swarm${nonSharedResourceSuffix}`
    : (nameSuffix ? `swarm${nameSuffix}` : 'swarm');

// Resolve paths relative to monorepo root
// From packages/infra/bin/ -> go up 3 levels to reach monorepo root
const monorepoRoot = path.resolve(__dirname, '../../..');
const handlersPath = path.join(monorepoRoot, 'packages/handlers/dist');

const stackEnv = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION || 'us-east-1',
};

// ============================================
// Deploy Validation
// ============================================

// Persistent environments (prod, staging) have pre-existing shared resources
// (DynamoDB tables, S3 buckets, ECS clusters) from the legacy monolith stack.
// Deploying without useExistingResources=true would attempt to create duplicate
// resources and fail with "already exists" errors.
if ((environment === 'prod' || environment === 'staging') && !useExistingResources) {
  console.warn(
    `⚠️  WARNING: Deploying to '${environment}' without useExistingResources=true. ` +
    `This will attempt to create DynamoDB tables, S3 buckets, and ECS clusters that ` +
    `may already exist from the legacy SwarmStack-${environment}. ` +
    `Set -c useExistingResources=true or configure it in cdk.context.json.`
  );
}

// ============================================
// Split Stacks for Parallel Deployment
// ============================================

// 1. Shared Infrastructure Stack (deploys first, rarely changes)
const sharedInfraStack = new SharedInfraStack(app, `SwarmShared-${environment}${nameSuffix}`, {
  environment,
  nameSuffix,
  enableCdn: true,
  enableWaf,
  galleryDomain,
  galleryCertificateArn,
  mediaCdnUrl,
  alarmNotificationEmail,
  useExistingResources,
  env: stackEnv,
  description: `Swarm Shared Infrastructure (${environment})`,
});

// 2. Admin API Stack (depends on shared, changes with code updates)
const adminApiStack = new AdminApiStack(app, `SwarmApi-${environment}${nameSuffix}`, {
  environment,
  nameSuffix: nonSharedResourceSuffix,
  sharedInfraStack,
  handlersPath,
  adminDomain,
  adminEmails,
  adminWallets,
  openRouterApiKeyArn,
  replicateApiKeyArn,
  heliusApiKeyArn,
  webSearchApiKeyArn,
  webSearchProvider,
  privyAppId,
  privyAppSecretArn,
  privyJwtVerificationKeyArn,
  stripeSecretKeyArn,
  stripeWebhookSecretArn,
  stripePriceIdPro,
  stripePriceIdEnterprise,
  anthropicApiKeyArn,
  enableClaudeCode,
  enableDiscordGateway,
  claudeCodeUseOpenRouter,
  secretPrefix,
  useExistingResources,
  env: stackEnv,
  description: `Swarm Admin API (${environment})`,
});
adminApiStack.addDependency(sharedInfraStack);

// 3. Admin UI Stack (depends on API for origin, changes with UI updates)
const adminUiStack = new AdminUiStack(app, `SwarmUi-${environment}${nameSuffix}`, {
  environment,
  nameSuffix: nonSharedResourceSuffix,
  adminApiStack,
  adminDomain,
  adminCertificateArn,
  enableWaf,
  useExistingBuckets,
  skipDomainAliases,
  env: stackEnv,
  description: `Swarm Admin UI (${environment})`,
});
adminUiStack.addDependency(adminApiStack);

// 4. Profile Page Stack (independent, changes with profile page updates)
// Hosts public avatar profile pages at *.rati.chat subdomains
if (profileDomain || app.node.tryGetContext('deployProfilePage')) {
  new ProfilePageStack(app, `SwarmProfilePage-${environment}${nameSuffix}`, {
    environment,
    nameSuffix: nonSharedResourceSuffix,
    profileDomain,
    profileCertificateArn,
    includeWildcardAliases: environment === 'prod',
    enableWaf,
    apiUrl: profileApiUrl,
    env: stackEnv,
    description: `Swarm Profile Page (${environment})`,
  });
}

app.synth();
