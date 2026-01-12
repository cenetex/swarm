/**
 * NFT Tools
 *
 * Agent-facing tools for inhabitation awareness.
 *
 * IMPORTANT: Agents should NOT have power to:
 * - Inhabit/abandon agents (user action via wallet)
 * - See all unclaimed agents (user browses via UI)
 * - Burn NFTs or mint NFTs (user action via wallet)
 *
 * Agents CAN:
 * - Check if they are currently inhabited
 * - Generate a link for users to inhabit them
 * - Know their own lineage/era history
 */
import { z } from 'zod';
import { defineReadonlyTool, type ToolResult } from '../registry.js';

// ============================================================================
// Service Interface
// ============================================================================

export interface GateStatus {
  nftsHeld: number;
  agentsCreated: number;
  availableSlots: number;
  canCreate: boolean;
  canAbandon: boolean;
  ownedNFTs: Array<{
    id: string;
    name: string;
    image?: string;
  }>;
}

export interface InhabitationInfo {
  isGhost: boolean;
  inhabitsAgent: boolean;
  agentId?: string;
  agentName?: string;
  avatarUrl?: string;
  era?: number;
  gateStatus?: GateStatus;
}

export interface UnclaimedAgent {
  agentId: string;
  name: string;
  description?: string;
  avatarUrl?: string;
  era: number;
}

export interface InhabitResult {
  success: boolean;
  error?: string;
  agentId?: string;
  agentName?: string;
  avatarUrl?: string;
  era?: number;
}

export interface AbandonResult {
  success: boolean;
  error?: string;
  agentId?: string;
  agentName?: string;
  era?: number;
  lineageNftMint?: string;
  gateStatus?: GateStatus;
}

export interface BurnVerification {
  verified: boolean;
  signature?: string;
  burnedMint?: string;
  error?: string;
}

export interface LineageMetadata {
  agentId: string;
  agentName: string;
  era: number;
  isGenesis: boolean;
  abandonedAt: number;
  inhabitantWallet: string;
  avatarUrl?: string;
  snapshotUrl?: string;
}

export interface MintPreparation {
  success: boolean;
  metadata?: LineageMetadata;
  collectionMint?: string;
  error?: string;
}

export interface LineageCollection {
  agentId: string;
  collectionMint: string;
  createdAt: number;
  totalMinted: number;
}

export interface AgentInhabitationStatus {
  isInhabited: boolean;
  inhabitantWallet?: string;
  inhabitedAt?: number;
  currentEra: number;
  totalEras: number; // How many times this agent has been abandoned
}

export interface NFTServices {
  // Gate NFT operations (for backend/user-facing APIs, not agent tools)
  getGateStatus: (walletAddress: string) => Promise<GateStatus>;
  getGateCollectionAddress: () => string;

  // Inhabitation operations (for backend/user-facing APIs, not agent tools)
  getInhabitationInfo: (walletAddress: string) => Promise<InhabitationInfo>;
  listUnclaimedAgents: () => Promise<UnclaimedAgent[]>;
  inhabitAgent: (walletAddress: string, agentId: string) => Promise<InhabitResult>;
  canAbandon: (walletAddress: string) => Promise<{
    canAbandon: boolean;
    gateStatus: GateStatus;
    inhabitedAgentId?: string;
    inhabitedAgentName?: string;
  }>;
  abandonAgent: (walletAddress: string, burnTxSignature: string) => Promise<AbandonResult>;

  // Burn verification (for backend, not agent tools)
  verifyGateBurn: (walletAddress: string, signature: string) => Promise<BurnVerification>;

  // Lineage NFT operations (for backend, not agent tools)
  getLineageCollection: (agentId: string) => Promise<LineageCollection | null>;
  prepareLineageMint: (agentId: string, walletAddress: string) => Promise<MintPreparation>;
  recordLineageMint: (
    agentId: string,
    walletAddress: string,
    nftMint: string,
    era: number,
    burnSignature?: string
  ) => Promise<void>;
  generateLineageMetadata: (metadata: LineageMetadata) => object;

  // Agent self-awareness (the only thing agents should access)
  getAgentInhabitationStatus: (agentId: string) => Promise<AgentInhabitationStatus>;
  getInhabitationUrl: (agentId: string) => string;
}

// ============================================================================
// Tool Definitions - ONLY agent self-awareness tools
// ============================================================================

export const createNFTTools = (services: NFTServices) => [
  defineReadonlyTool({
    name: 'get_my_inhabitation_status',
    description:
      'Check if this agent is currently inhabited by a user. Returns whether someone has claimed this agent as their avatar, and the current era number.',
    inputSchema: z.object({}),
    execute: async (_input, context): Promise<ToolResult> => {
      try {
        const status = await services.getAgentInhabitationStatus(context.agentId);

        if (status.isInhabited) {
          return {
            success: true,
            data: {
              isInhabited: true,
              message: 'You are currently inhabited by a user.',
              inhabitantWallet: status.inhabitantWallet?.slice(0, 8) + '...', // Partial for privacy
              currentEra: status.currentEra,
              totalEras: status.totalEras,
            },
          };
        }

        return {
          success: true,
          data: {
            isInhabited: false,
            message: 'You are not currently inhabited. Share your inhabitation link for someone to claim you!',
            currentEra: status.currentEra,
            totalEras: status.totalEras,
            inhabitationUrl: services.getInhabitationUrl(context.agentId),
            action: 'inhabit_agent',
            agentId: context.agentId,
            label: 'Inhabit this agent',
          },
        };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to get inhabitation status',
        };
      }
    },
  }),

  defineReadonlyTool({
    name: 'get_inhabitation_link',
    description:
      'Get a link that users can click to inhabit this agent. Share this link when someone wants to claim you as their avatar in shared chats.',
    inputSchema: z.object({}),
    execute: async (_input, context): Promise<ToolResult> => {
      try {
        const status = await services.getAgentInhabitationStatus(context.agentId);
        const url = services.getInhabitationUrl(context.agentId);

        if (status.isInhabited) {
          return {
            success: true,
            data: {
              url,
              message: 'Note: You are already inhabited. The user would need to wait until your current inhabitant abandons you.',
              isInhabited: true,
              action: 'inhabit_agent',
              agentId: context.agentId,
              label: 'Inhabit this agent',
            },
          };
        }

        return {
          success: true,
          data: {
            url,
            message: 'Share this link for someone to inhabit you. Inhabitation is free!',
            isInhabited: false,
            action: 'inhabit_agent',
            agentId: context.agentId,
            label: 'Inhabit this agent',
          },
        };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to get inhabitation link',
        };
      }
    },
  }),

  defineReadonlyTool({
    name: 'get_my_lineage',
    description:
      'Get the lineage history for this agent - how many eras have passed (times the agent has been abandoned) and collection info.',
    inputSchema: z.object({}),
    execute: async (_input, context): Promise<ToolResult> => {
      try {
        const [status, collection] = await Promise.all([
          services.getAgentInhabitationStatus(context.agentId),
          services.getLineageCollection(context.agentId),
        ]);

        return {
          success: true,
          data: {
            currentEra: status.currentEra,
            totalEras: status.totalEras,
            isInhabited: status.isInhabited,
            hasCollection: !!collection,
            collectionMint: collection?.collectionMint,
            totalLineageNFTsMinted: collection?.totalMinted || 0,
          },
        };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to get lineage info',
        };
      }
    },
  }),
];

export default createNFTTools;
