#!/usr/bin/env node
/**
 * CDK App Entry Point
 */
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import * as path from 'path';
import { SwarmStack } from '../src/stacks/swarm-stack.js';

const app = new cdk.App();

// Get environment from context or default
const environment = app.node.tryGetContext('environment') || 'dev';
const agentIds = app.node.tryGetContext('agents')?.split(',');

// Resolve paths relative to monorepo root
const monorepoRoot = path.resolve(__dirname, '../../../..');
const agentsPath = path.join(monorepoRoot, 'agents');
const handlersPath = path.join(monorepoRoot, 'packages/handlers/dist');

new SwarmStack(app, `SwarmStack-${environment}`, {
  environment,
  agentsPath,
  handlersPath,
  enableCdn: environment === 'prod',
  agentIds,
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION || 'us-east-1',
  },
  description: `Swarm AI Agent Framework (${environment})`,
});

app.synth();
