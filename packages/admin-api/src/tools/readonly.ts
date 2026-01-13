/**
 * Read-only tools that query state without modification
 */
import { tool } from '@openrouter/sdk';
import { z } from 'zod/v4';

/**
 * Get current LLM model configuration
 */
export const getMyModelConfig = (
  _agentId: string,
  getAgentConfig: () => Promise<unknown>
) => tool({
  name: 'get_my_model_config',
  description: 'Get my current LLM model configuration (model, temperature, max tokens)',
  inputSchema: z.object({}),
  execute: async () => {
    const agent = await getAgentConfig();
    if (!agent || typeof agent !== 'object') {
      return { error: 'Agent not found' };
    }
    const config = (agent as Record<string, unknown>).llmConfig as Record<string, unknown> | undefined;
    return {
      model: config?.model ?? 'anthropic/claude-sonnet-4',
      temperature: config?.temperature ?? 0.7,
      maxTokens: config?.maxTokens ?? 4096,
      provider: config?.provider ?? 'openrouter',
    };
  },
});

/**
 * List all Solana wallets with public keys
 */
export const getMyWallets = (
  _agentId: string,
  listWallets: () => Promise<unknown[]>
) => tool({
  name: 'get_my_wallets',
  description: 'List all my Solana wallets with their public keys and balances',
  inputSchema: z.object({}),
  execute: async () => {
    const wallets = await listWallets();
    if (!wallets || wallets.length === 0) {
      return { wallets: [], message: 'No wallets configured yet. Use create_solana_wallet to create one.' };
    }
    return { wallets };
  },
});

/**
 * List configured secrets (not values, just types)
 */
export const getMySecrets = (
  _agentId: string,
  listSecrets: () => Promise<unknown[]>
) => tool({
  name: 'get_my_secrets',
  description: 'List which secrets I have configured (not the values, just which types are set)',
  inputSchema: z.object({}),
  execute: async () => {
    const secrets = await listSecrets();
    if (!secrets || secrets.length === 0) {
      return { secrets: [], message: 'No secrets configured yet.' };
    }
    return {
      secrets: secrets.map((s: unknown) => {
        const secret = s as Record<string, unknown>;
        return {
          type: secret.secretType,
          name: secret.name,
          createdAt: secret.createdAt,
        };
      }),
    };
  },
});

/**
 * Get pending media generation jobs
 */
export const getPendingJobs = (
  _agentId: string,
  listPendingJobs: () => Promise<unknown[]>
) => tool({
  name: 'get_pending_jobs',
  description: 'Check the status of pending media generation jobs. Images and videos are generated asynchronously.',
  inputSchema: z.object({}),
  execute: async () => {
    const jobs = await listPendingJobs();
    if (!jobs || jobs.length === 0) {
      return { jobs: [], message: 'No pending jobs.' };
    }
    return { jobs };
  },
});

/**
 * Get status of a specific job
 */
export const getJobStatus = (
  _agentId: string,
  getJob: (jobId: string) => Promise<unknown>
) => tool({
  name: 'get_job_status',
  description: 'Get the status of a specific media generation job by its ID.',
  inputSchema: z.object({
    jobId: z.string().describe('The job ID to check status for'),
  }),
  execute: async ({ jobId }) => {
    const job = await getJob(jobId);
    if (!job) {
      return { error: `Job ${jobId} not found` };
    }
    return job;
  },
});

/**
 * Get tool credits/limits
 */
export const getToolCredits = (
  _agentId: string,
  getCredits: () => Promise<unknown>
) => tool({
  name: 'get_tool_credits',
  description: 'Check my available credits for media generation tools',
  inputSchema: z.object({}),
  execute: async () => {
    const credits = await getCredits();
    return credits || { message: 'No credit limits configured.' };
  },
});
