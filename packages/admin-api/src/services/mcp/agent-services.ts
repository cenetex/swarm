/**
 * MCP Agent Services
 *
 * Service implementations for memory, voice, diagnostics,
 * observability, MCP admin, Moltbook, and media jobs.
 */
import type { AllServices, VoiceServices } from '@swarm/mcp-server';
import {
  listGitHubAvatarIssues,
  getGitHubDeploymentStatus,
  GitHubAppTokenProvider,
  type GitHubClientConfig,
  type GitHubTokenProvider,
} from '@swarm/core';
import type { UserSession } from '../../types.js';
import type { ServiceContainer } from '../service-container.js';
import { getBotToken } from './helpers.js';

type AgentServices = Pick<
  AllServices,
  'memory' | 'voice' | 'diagnostics' | 'observability' | 'mcpAdmin' | 'jobs' | 'githubIssues'
>;

// ---------------------------------------------------------------------------
// GitHub App token provider (lazy singleton)
// ---------------------------------------------------------------------------
let _ghTokenProvider: GitHubTokenProvider | null = null;

function getGitHubTokenProvider(): GitHubTokenProvider | null {
  if (_ghTokenProvider) return _ghTokenProvider;

  const secretArn = process.env.GITHUB_APP_CREDENTIALS_ARN;
  if (!secretArn) return null;

  _ghTokenProvider = new GitHubAppTokenProvider(secretArn);
  return _ghTokenProvider;
}

async function getGitHubConfig(): Promise<GitHubClientConfig | null> {
  const provider = getGitHubTokenProvider();
  if (!provider) return null;

  const token = await provider.getToken();
  return { token, repo: process.env.GITHUB_REPO || 'cenetex/aws-swarm' };
}

/**
 * Create agent-facing MCP services for a specific avatar.
 */
export function createAgentServices(
  avatarId: string,
  session: UserSession,
  svc: ServiceContainer,
): AgentServices {
  const {
    media,
    mediaJobs,
    voice,
    avatarObservability: avatarvents,
    memory,
    memoryMigration,
    memoryConsolidation,
    observability,
  } = svc;

  // Voice tools enabled by default; set ENABLE_VOICE_TOOLS=false to disable
  const voiceEnabled = process.env.ENABLE_VOICE_TOOLS !== 'false';
  const voiceServices: VoiceServices | undefined = voiceEnabled ? {
    transcribeAudio: async (params: Parameters<VoiceServices['transcribeAudio']>[0]) => {
      let audioUrl = params.url;
      if (!audioUrl && params.platformFileId) {
        const botToken = await getBotToken(svc, avatarId);
        audioUrl = await svc.telegram.getFileUrl(botToken, params.platformFileId);
      }
      return svc.voice.transcribeAudio({
        avatarId,
        assetId: params.assetId,
        url: audioUrl,
        language: params.language,
        model: params.model,
        diarize: params.diarize,
      });
    },
    createMyVoice: async (params: Parameters<VoiceServices['createMyVoice']>[0]) => {
      return voice.createMyVoice({
        avatarId: params.avatarId,
        description: params.description,
        updatedBy: session.email,
      });
    },
    hasVoice: async (avatardParam: string) => {
      return voice.hasVoice(avatardParam);
    },
    sendVoiceMessage: async (params: Parameters<VoiceServices['sendVoiceMessage']>[0]) => {
      return voice.sendVoiceMessage({
        avatarId,
        platform: params.platform,
        text: params.text,
        conversationId: params.conversationId,
        voiceId: params.voiceId,
        format: params.format,
        speed: params.speed,
        replyToMessageId: params.replyToMessageId,
      });
    },
  } : undefined;

  return {
    // =========================================================================
    // Voice Services (optional)
    // =========================================================================
    voice: voiceServices,

    // =========================================================================
    // Memory Services
    // =========================================================================
    memory: {
      remember: async (fact: string, about?: string, userId?: string) => {
        const result = await memory.remember(avatarId, fact, about, userId);
        return { saved: result.saved };
      },

      recall: async (query: string, userId?: string) => {
        const result = await memory.recall(avatarId, query, userId);
        return {
          facts: result.facts.map(f => ({
            fact: f.fact,
            about: f.about,
            userId,
            timestamp: f.timestamp,
            strength: f.strength,
          })),
        };
      },

      graphRecall: async (query: string, userId?: string) => {
        const searchResult = await memory.graphSearch(avatarId, query, {
          directLimit: 8,
          maxGraphMatches: 6,
          graphDepth: 1,
        });
        const mapMem = (m: { content: string; about?: string; createdAt: number; strength: number }) => ({
          fact: m.content,
          about: m.about,
          userId,
          timestamp: m.createdAt,
          strength: m.strength,
        });
        const filterByUser = (items: typeof searchResult.directMatches) =>
          userId ? items.filter(m => !m.userId || m.userId === userId) : items;

        return {
          facts: filterByUser(searchResult.directMatches).map(mapMem),
          associatedFacts: filterByUser(searchResult.graphMatches).map(mapMem),
          edgesTraversed: searchResult.edgesTraversed,
        };
      },

      getEmbeddingStats: async () => {
        return memoryMigration.getEmbeddingStats(avatarId);
      },

      backfillEmbeddings: async (options?: { dryRun?: boolean }) => {
        return memoryMigration.backfillEmbeddings(avatarId, {
          dryRun: options?.dryRun,
        });
      },

      consolidate: async (options?: { skipIdentity?: boolean }) => {
        return memoryConsolidation.triggerConsolidation(avatarId, {
          skipIdentity: options?.skipIdentity,
        });
      },

      getGraphStats: async () => {
        return memory.getGraphStats(avatarId);
      },
    },

    // =========================================================================
    // Job Services
    // =========================================================================
    jobs: {
      getPendingJobs: async (avatarId) => {
        let pendingJobs = await mediaJobs.getPendingJobs(avatarId);

        if (pendingJobs.length > 0) {
          for (const job of pendingJobs) {
            if ((job.status === 'processing' || job.status === 'pending') && job.externalId) {
              if (job.provider === 'openrouter') {
                const openRouterKey = await media.getProviderApiKey(avatarId, 'openrouter');
                if (openRouterKey) {
                  await mediaJobs.pollAndCompleteOpenRouterJob(job.jobId, openRouterKey);
                }
              } else {
                const replicateKey = await media.getProviderApiKey(avatarId, 'replicate');
                if (replicateKey) {
                  await mediaJobs.pollAndCompleteJob(job.jobId, replicateKey);
                }
              }
            }
          }
          pendingJobs = await mediaJobs.getPendingJobs(avatarId);
        }

        return pendingJobs.map(job => ({
          jobId: job.jobId,
          type: job.type as 'image' | 'video' | 'sticker',
          status: job.status as 'pending' | 'processing' | 'completed' | 'failed',
          prompt: job.prompt,
          resultUrl: job.resultUrl,
          createdAt: job.createdAt,
          completedAt: job.completedAt,
        }));
      },

      getJob: async (avatarId, jobId) => {
        let job = await mediaJobs.getJob(jobId);
        if (!job) return null;

        if (job.avatarId !== avatarId) {
          return null;
        }

        if ((job.status === 'processing' || job.status === 'pending') && job.externalId) {
          const provider = job.provider === 'openrouter' ? 'openrouter' : 'replicate';
          const apiKey = await media.getProviderApiKey(job.avatarId, provider);
          if (apiKey) {
            const polledJob = provider === 'openrouter'
              ? await mediaJobs.pollAndCompleteOpenRouterJob(job.jobId, apiKey)
              : await mediaJobs.pollAndCompleteJob(job.jobId, apiKey);
            if (polledJob) job = polledJob;
          }
        }

        return {
          jobId: job.jobId,
          type: job.type as 'image' | 'video' | 'sticker',
          status: job.status as 'pending' | 'processing' | 'completed' | 'failed',
          prompt: job.prompt,
          resultUrl: job.resultUrl,
          error: job.error,
          createdAt: job.createdAt,
          completedAt: job.completedAt,
        };
      },
    },

    // =========================================================================
    // Diagnostics Services (Issues & Feedback)
    // =========================================================================
    diagnostics: {
      recordIssue: async (params) => {
        return avatarvents.recordIssue({
          avatarId: params.avatarId,
          platform: params.platform,
          severity: params.severity,
          category: params.category,
          title: params.title,
          description: params.description,
          userMessage: params.userMessage,
          context: params.context,
        });
      },
      recordFeedback: async (params) => {
        return avatarvents.recordFeedback({
          avatarId: params.avatarId,
          platform: params.platform,
          sentiment: params.sentiment,
          feature: params.feature,
          feedback: params.feedback,
        });
      },
    },

    // =========================================================================
    // Observability Services
    // =========================================================================
    observability: {
      getSystemStatus: async (options) => {
        return observability.getSystemStatus(options);
      },
      getAvatarActivity: async (avatarId, options) => {
        const activity = await observability.getAvatarActivity(avatarId, options);
        return {
          ...activity,
          items: activity.items.map(item => item as unknown as Record<string, unknown>),
        };
      },
    },

    // =========================================================================
    // MCP Admin Services (Toolset & External Server Management)
    // =========================================================================
    mcpAdmin: svc.createMcpAdminServices(),

    // =========================================================================
    // GitHub Issue Tracking (read-only, avatar-scoped)
    // =========================================================================
    githubIssues: {
      getMyIssues: async (reqAvatarId, state) => {
        const cfg = await getGitHubConfig();
        if (!cfg) return [];

        const issues = await listGitHubAvatarIssues(cfg, reqAvatarId, state);
        return Promise.all(issues.map(async (issue) => {
          const deployment = issue.state === 'closed'
            ? await getGitHubDeploymentStatus(cfg, issue)
            : null;
          return {
            number: issue.number,
            title: issue.title,
            state: issue.state,
            labels: issue.labels,
            assignee: issue.assignee,
            updatedAt: issue.updatedAt,
            closedAt: issue.closedAt,
            deployedIn: deployment?.status === 'released' ? (deployment.releaseName ?? 'yes') : null,
            url: issue.htmlUrl,
          };
        }));
      },
    },
  };
}
