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

/**
 * Create MCP-compatible services for a specific avatar.
 *
 * @param _avatarId  The avatar to bind services to
 * @param session    The authenticated user session
 * @param svc        Optional service container override (for testing)
 */
export function createMCPServices(
  _avatarId: string,
  session: UserSession,
  svc: ServiceContainer = getDefaultContainer(),
): AllServices {
  return {
    ...createMediaServices(_avatarId, session, svc),
    ...createPlatformServices(_avatarId, session, svc),
    ...createIdentityServices(_avatarId, session, svc),
    ...createAgentServices(_avatarId, session, svc),
    nft: createNFTServices(svc),
    property: createPropertyServices(_avatarId, session, svc),
  };
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
