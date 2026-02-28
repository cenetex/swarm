/**
 * MCP Property Research Services
 *
 * Service implementations for property research authorization,
 * job management, and research execution.
 */
import type { PropertyServices } from '@swarm/mcp-server';
import type { UserSession } from '../../types.js';
import type { ServiceContainer } from '../service-container.js';

/**
 * Create property research services.
 */
export function createPropertyServices(
  _avatarId: string,
  _session: UserSession,
  svc: ServiceContainer,
): PropertyServices {
  const { propertyResearch } = svc;
  const webSearch = svc.createWebSearch();

  const isPropertyResearchStatus = (
    value: string
  ): value is 'queued' | 'researching' | 'completed' | 'failed' => {
    return value === 'queued' || value === 'researching' || value === 'completed' || value === 'failed';
  };

  return {
    // Authorization
    checkAuth: async (avatarId: string, walletAddress: string) => {
      return propertyResearch.checkAuth(avatarId, walletAddress);
    },

    grantAuth: async (avatarId: string, walletAddress: string) => {
      await propertyResearch.grantAuth(avatarId, walletAddress);
    },

    revokeAuth: async (avatarId: string, walletAddress: string) => {
      await propertyResearch.revokeAuth(avatarId, walletAddress);
    },

    // Job management
    createJob: async (avatarId: string, property, requestedBy) => {
      return propertyResearch.createJob(avatarId, property, requestedBy);
    },

    getJob: async (jobId: string) => {
      return propertyResearch.getJob(jobId);
    },

    getJobsForAvatar: async (avatarId: string, statusFilter?: string) => {
      const parsedStatus = statusFilter && isPropertyResearchStatus(statusFilter) ? statusFilter : undefined;
      return propertyResearch.getJobsForAvatar(avatarId, parsedStatus);
    },

    deleteJob: async (jobId: string) => {
      await propertyResearch.deleteJob(jobId);
    },

    // Research execution
    executeResearch: async (jobId: string) => {
      return propertyResearch.executeResearch(jobId, webSearch);
    },
  };
}
