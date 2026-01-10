#!/usr/bin/env node
/**
 * CDK App Entry Point
 */
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { SwarmStack } from '../src/stacks/swarm-stack.js';

// ESM equivalent of __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = new cdk.App();

// Get environment from context or default
const environment = app.node.tryGetContext('environment') || 'dev';
const agentIds = app.node.tryGetContext('agents')?.split(',');

// Get environment-specific config
const environments = app.node.tryGetContext('environments') || {};
const envConfig = environments[environment] || {};
const adminDomain = app.node.tryGetContext('adminDomain') || envConfig.adminDomain;
const adminCertificateArn = app.node.tryGetContext('adminCertificateArn') || envConfig.adminCertificateArn;
const cloudflareTeamDomain = app.node.tryGetContext('cloudflareTeamDomain') || envConfig.cloudflareTeamDomain;
const adminEmails = app.node.tryGetContext('adminEmails') || envConfig.adminEmails;
const openRouterApiKeyArn = app.node.tryGetContext('openRouterApiKeyArn') || envConfig.openRouterApiKeyArn;

// Resolve paths relative to monorepo root
const monorepoRoot = path.resolve(__dirname, '../../../..');
const agentsPath = path.join(monorepoRoot, 'agents');
const handlersPath = path.join(monorepoRoot, 'packages/handlers/dist');

new SwarmStack(app, `SwarmStack-${environment}`, {
  environment,
  agentsPath,
  handlersPath,
  enableCdn: true, // CDN required for media to be accessible (S3 bucket is private)
  agentIds,
  adminDomain,
  adminCertificateArn,
  cloudflareTeamDomain,
  adminEmails,
  openRouterApiKeyArn,
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION || 'us-east-1',
  },
  description: `Swarm AI Agent Framework (${environment})`,
});

app.synth();
