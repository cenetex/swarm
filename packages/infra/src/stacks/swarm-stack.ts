/**
 * Swarm Stack
 * Main CDK stack that deploys shared infrastructure and agents
 */
import * as cdk from 'aws-cdk-lib';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';
import { Construct } from 'constructs';
import { SharedInfrastructure } from '../constructs/shared.js';
import { AgentConstruct } from '../constructs/agent.js';
import { AdminUi } from '../constructs/admin-ui.js';
import { AdminApiConstruct } from '../constructs/admin-api.js';
import type { AgentConfig } from '@swarm/core';

export interface SwarmStackProps extends cdk.StackProps {
  /**
   * Environment name (dev, staging, prod)
   */
  environment: string;

  /**
   * Path to agents directory
   */
  agentsPath: string;

  /**
   * Path to compiled handlers
   */
  handlersPath: string;

  /**
   * Enable CloudFront CDN
   */
  enableCdn?: boolean;

  /**
   * Specific agents to deploy (default: all)
   */
  agentIds?: string[];

  /**
   * Custom domain for Admin UI (e.g., 'admin-staging.rati.chat')
   */
  adminDomain?: string;

  /**
   * ACM certificate ARN for Admin UI custom domain (must be in us-east-1)
   */
  adminCertificateArn?: string;

  /**
   * Cloudflare Access team domain (e.g., 'yourteam.cloudflareaccess.com')
   */
  cloudflareTeamDomain?: string;

  /**
   * Admin emails (comma-separated)
   */
  adminEmails?: string;

  /**
   * OpenRouter API key secret ARN
   */
  openRouterApiKeyArn?: string;
}

export class SwarmStack extends cdk.Stack {
  public readonly shared: SharedInfrastructure;
  public readonly adminUi: AdminUi;
  public readonly adminApi?: AdminApiConstruct;
  public readonly agents: Map<string, AgentConstruct> = new Map();

  constructor(scope: Construct, id: string, props: SwarmStackProps) {
    super(scope, id, props);

    const { 
      environment, 
      agentsPath, 
      handlersPath, 
      enableCdn = true, 
      agentIds,
      adminDomain,
      adminCertificateArn,
      cloudflareTeamDomain,
      adminEmails,
      openRouterApiKeyArn,
    } = props;

    // Create shared infrastructure
    this.shared = new SharedInfrastructure(this, 'Shared', {
      environment,
      enableCdn,
    });

    // Create Admin API if Cloudflare Access is configured
    if (cloudflareTeamDomain && adminEmails) {
      this.adminApi = new AdminApiConstruct(this, 'AdminApi', {
        cloudflareTeamDomain,
        adminEmails,
        openRouterApiKeyArn,
        environment,
        adminDomain,
      });
    }

    // Create Admin UI with CloudFront
    this.adminUi = new AdminUi(this, 'AdminUi', {
      environment,
      domainName: adminDomain,
      certificateArn: adminCertificateArn,
    });

    // Load and deploy agents (skip if agents directory doesn't exist)
    if (!fs.existsSync(agentsPath)) {
      console.log(`Agents directory not found at ${agentsPath}, skipping agent deployment`);
    } else {
      const agentDirs = fs.readdirSync(agentsPath)
        .filter(f => {
          const fullPath = path.join(agentsPath, f);
          return fs.statSync(fullPath).isDirectory() && !f.startsWith('.') && f !== 'node_modules';
        })
        .filter(f => !agentIds || agentIds.includes(f));

      for (const agentDir of agentDirs) {
        const configPath = path.join(agentsPath, agentDir, 'config.yaml');
        
        if (!fs.existsSync(configPath)) {
          console.warn(`Skipping ${agentDir}: no config.yaml found`);
          continue;
        }

        const configYaml = fs.readFileSync(configPath, 'utf-8');
        const config: AgentConfig = yaml.parse(configYaml);

        // Ensure agent ID matches directory name
        config.id = agentDir;

        // Read persona file if exists
        const personaPath = path.join(agentsPath, agentDir, 'persona.md');
        if (fs.existsSync(personaPath)) {
          config.persona = fs.readFileSync(personaPath, 'utf-8');
        }

        // Create agent
        const agent = new AgentConstruct(this, `Agent-${agentDir}`, {
          config,
          stateTable: this.shared.stateTable,
          activityTable: this.shared.activityTable,
          mediaBucket: this.shared.mediaBucket,
          dependencyLayer: this.shared.dependencyLayer,
          handlersCodePath: handlersPath,
          environment,
        });

        this.agents.set(agentDir, agent);
      }
    }

    // Stack outputs
    new cdk.CfnOutput(this, 'AgentCount', {
      value: String(this.agents.size),
      description: 'Number of agents deployed',
    });
  }
}
