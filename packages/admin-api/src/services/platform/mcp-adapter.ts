/**
 * MCP Service Adapter
 *
 * Thin orchestration layer that composes focused MCP service modules
 * into the unified AllServices interface expected by mcp-server.
 *
 * Implementation details are split across services/mcp/*.ts modules;
 * this file exists at platform/ to preserve the re-export chain:
 *   services/mcp-adapter.ts → platform/mcp-adapter.ts → mcp/*.ts
 */
import type { AllServices } from '@swarm/mcp-server';
import type { UserSession } from '../../types.js';
import { getDefaultContainer, type ServiceContainer } from '../service-container.js';
import { createMediaServices } from '../mcp/media-services.js';
import { createPlatformServices } from '../mcp/platform-services.js';
import { createIdentityServices } from '../mcp/identity-services.js';
import { createAgentServices } from '../mcp/agent-services.js';
import { createNFTServices } from '../mcp/nft-services.js';
import { createPropertyServices } from '../mcp/property-services.js';
import { createDesignPartnerServices } from '../mcp/design-partner-services.js';

export interface MCPServicesOptions {
  /** When true, skip services that perform write operations (for preview/read-only contexts) */
  readOnly?: boolean;
}

/**
 * Create MCP-compatible services for a specific avatar.
 *
 * @param _avatarId  The avatar to bind services to
 * @param session    The authenticated user session
 * @param svc        Optional service container override (for testing)
 * @param options    Optional configuration (e.g. readOnly mode for preview)
 */
export function createMCPServices(
  _avatarId: string,
  session: UserSession,
  svc: ServiceContainer = getDefaultContainer(),
  options: MCPServicesOptions = {},
): AllServices {
  if (options.readOnly) {
    return createReadOnlyMCPServices(_avatarId, session, svc);
  }

  return {
    ...createMediaServices(_avatarId, session, svc),
    ...createPlatformServices(_avatarId, session, svc),
    ...createIdentityServices(_avatarId, session, svc),
    ...createAgentServices(_avatarId, session, svc),
    nft: createNFTServices(svc),
    property: createPropertyServices(_avatarId, session, svc),
    designPartner: session.isAdmin ? createDesignPartnerServices() : undefined,
  };
}

/**
 * Create a read-only subset of MCP services for preview contexts.
 *
 * Returns only the service bindings needed for tool metadata resolution
 * (shouldShow / contextBuilder). Write-capable methods are replaced with
 * safe no-ops so that DynamoDB UpdateItem / PutItem calls are never issued.
 */
function createReadOnlyMCPServices(
  _avatarId: string,
  session: UserSession,
  svc: ServiceContainer,
): AllServices {
  const full: AllServices = {
    ...createMediaServices(_avatarId, session, svc),
    ...createPlatformServices(_avatarId, session, svc),
    ...createIdentityServices(_avatarId, session, svc),
    ...createAgentServices(_avatarId, session, svc),
    nft: createNFTServices(svc),
    property: createPropertyServices(_avatarId, session, svc),
  };

  // Wrap profile write methods with no-ops
  if (full.profile) {
    full.profile = {
      ...full.profile,
      updateProfile: async () => {},
      setProfileImage: async () => ({ url: '' }),
      saveProfileImage: async () => {},
      setCharacterReference: async () => ({ url: '' }),
      saveCharacterReference: async () => {},
    };
  }

  // Wrap secret write methods with no-ops
  if (full.secrets) {
    full.secrets = {
      ...full.secrets,
      storeSecret: async () => {},
    };
  }

  // Wrap model write methods with no-ops
  if (full.models) {
    full.models = {
      ...full.models,
      updateConfig: async () => {},
    };
  }

  // Wrap avatar write methods with no-ops
  if (full.avatar) {
    full.avatar = {
      ...full.avatar,
      setStatus: async () => ({ success: true, name: '' }),
    };
  }

  // Wrap memory write methods with no-ops
  if (full.memory) {
    full.memory = {
      ...full.memory,
      remember: async () => ({ saved: false }),
      backfillEmbeddings: async () => ({ processed: 0, succeeded: 0, failed: 0, skipped: 0 }),
      consolidate: async () => ({
        avatarId: '',
        success: true,
        decay: { recent: { decayed: 0, pruned: 0 }, core: { decayed: 0, pruned: 0 } },
        promotion: { promoted: 0 },
        durationMs: 0,
      }),
    };
  }

  // Wrap diagnostics write methods with no-ops
  if (full.diagnostics) {
    full.diagnostics = {
      ...full.diagnostics,
      recordIssue: async () => ({ id: '', type: 'issue' as const, timestamp: 0, avatarId: '', platform: '', severity: 'low' as const, category: 'other' as const, title: '', description: '' }),
      recordFeedback: async () => ({ id: '', type: 'feedback' as const, timestamp: 0, avatarId: '', platform: '', sentiment: 'neutral' as const, feature: '', feedback: '' }),
    };
  }

  // Wrap MCP admin write methods with no-ops
  if (full.mcpAdmin) {
    full.mcpAdmin = {
      ...full.mcpAdmin,
      updateMcpConfig: async () => {},
    };
  }

  // Wrap jobs — getPendingJobs triggers pollAndCompleteJob (UpdateItem)
  if (full.jobs) {
    full.jobs = {
      getPendingJobs: async (avatarId) => {
        // Read-only: just list jobs without polling/updating status
        const jobs = await svc.mediaJobs.getPendingJobs(avatarId);
        return jobs.map(job => ({
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
        // Read-only: return job without polling
        const job = await svc.mediaJobs.getJob(jobId);
        if (!job || job.avatarId !== avatarId) return null;
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
    };
  }

  return full;
}

/**
 * Create MCP services for Telegram context (minimal session)
 */
export function createTelegramMCPServices(
  avatarId: string,
  svc: ServiceContainer = getDefaultContainer(),
): AllServices {
  const telegramSession: UserSession = {
    email: 'telegram-user@telegram.bot',
    userId: `telegram-${avatarId}`,
    isAdmin: false,
    accessToken: '',
  };
  return createMCPServices(avatarId, telegramSession, svc);
}
