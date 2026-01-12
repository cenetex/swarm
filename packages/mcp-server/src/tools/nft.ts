/**
 * NFT Tools
 *
 * Tools for managing NFT-based agent inhabitation.
 *
 * Key concepts:
 * - Gate NFT: Holding grants creation slots, burning allows abandonment
 * - Inhabitation: User claims an unclaimed agent (FREE)
 * - Abandonment: User releases agent by burning Gate NFT
 * - Lineage NFT: Minted when user abandons, recording their era
 */
import { z } from 'zod';
import { defineTool, defineReadonlyTool, type ToolResult } from '../registry.js';

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

export interface NFTServices {
  // Gate NFT operations
  getGateStatus: (walletAddress: string) => Promise<GateStatus>;
  getGateCollectionAddress: () => string;

  // Inhabitation operations
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

  // Burn verification
  verifyGateBurn: (walletAddress: string, signature: string) => Promise<BurnVerification>;

  // Lineage NFT operations
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
}

// ============================================================================
// Context Builders
// ============================================================================

export async function buildNFTContext(
  services: NFTServices,
  walletAddress?: string
): Promise<string | undefined> {
  if (!walletAddress) {
    return 'Wallet not connected';
  }

  try {
    const info = await services.getInhabitationInfo(walletAddress);

    if (info.inhabitsAgent) {
      return `Inhabiting: ${info.agentName} (Era ${info.era})`;
    }

    if (info.gateStatus) {
      const { nftsHeld, availableSlots } = info.gateStatus;
      return `Ghost mode | ${nftsHeld} Gate NFTs | ${availableSlots} creation slots`;
    }

    return 'Ghost mode (no agent inhabited)';
  } catch {
    return undefined;
  }
}

// ============================================================================
// Tool Definitions
// ============================================================================

export const createNFTTools = (services: NFTServices) => [
  // -------------------------------------------------------------------------
  // Read-only tools
  // -------------------------------------------------------------------------

  defineReadonlyTool({
    name: 'get_gate_status',
    description:
      'Check Gate NFT holdings for a wallet. Shows how many Gate NFTs are held, how many agents have been created, and available creation slots. Gate NFTs grant permission to create agents (1 held = 1 slot) and to abandon inhabited agents (requires burning).',
    inputSchema: z.object({
      walletAddress: z.string().describe('The Solana wallet address to check'),
    }),
    execute: async (input, _context): Promise<ToolResult> => {
      try {
        const status = await services.getGateStatus(input.walletAddress);
        return {
          success: true,
          data: {
            ...status,
            gateCollection: services.getGateCollectionAddress(),
          },
        };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to get gate status',
        };
      }
    },
  }),

  defineReadonlyTool({
    name: 'get_inhabitation_status',
    description:
      'Get the current inhabitation status for a wallet. Shows whether the user is a "ghost" (no avatar) or inhabits an agent. Returns agent details if inhabited.',
    inputSchema: z.object({
      walletAddress: z.string().describe('The Solana wallet address to check'),
    }),
    contextBuilder: async (context) => {
      // Could use context.session to get wallet address if available
      return buildNFTContext(services, context.userId);
    },
    execute: async (input, _context): Promise<ToolResult> => {
      try {
        const info = await services.getInhabitationInfo(input.walletAddress);
        return {
          success: true,
          data: info,
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
    name: 'list_unclaimed_agents',
    description:
      'List all agents that are not currently inhabited and can be claimed. Anyone with a connected wallet can inhabit an unclaimed agent for FREE.',
    inputSchema: z.object({}),
    execute: async (_input, _context): Promise<ToolResult> => {
      try {
        const agents = await services.listUnclaimedAgents();
        return {
          success: true,
          data: {
            count: agents.length,
            agents,
          },
        };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to list unclaimed agents',
        };
      }
    },
  }),

  defineReadonlyTool({
    name: 'check_can_abandon',
    description:
      'Check if a wallet can abandon their current agent. Requires holding at least 1 Gate NFT (which must be burned to complete abandonment).',
    inputSchema: z.object({
      walletAddress: z.string().describe('The Solana wallet address to check'),
    }),
    execute: async (input, _context): Promise<ToolResult> => {
      try {
        const result = await services.canAbandon(input.walletAddress);
        return {
          success: true,
          data: result,
        };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to check abandon eligibility',
        };
      }
    },
  }),

  defineReadonlyTool({
    name: 'get_lineage_collection',
    description:
      'Get the lineage NFT collection info for an agent. Each agent has its own NFT collection that tracks abandonment history through "eras".',
    inputSchema: z.object({
      agentId: z.string().describe('The agent ID to get lineage info for'),
    }),
    execute: async (input, _context): Promise<ToolResult> => {
      try {
        const collection = await services.getLineageCollection(input.agentId);
        if (!collection) {
          return {
            success: true,
            data: {
              hasCollection: false,
              message: 'No lineage collection exists yet. It will be created on first abandonment.',
            },
          };
        }
        return {
          success: true,
          data: {
            hasCollection: true,
            ...collection,
          },
        };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to get lineage collection',
        };
      }
    },
  }),

  // -------------------------------------------------------------------------
  // Action tools
  // -------------------------------------------------------------------------

  defineTool({
    name: 'inhabit_agent',
    description:
      'Inhabit (claim) an unclaimed agent. This is FREE - no NFT required. The wallet will appear as this agent in shared chats. A wallet can only inhabit one agent at a time.',
    category: 'wallet',
    platforms: ['admin-ui', 'api'], // Not from Telegram/Discord for security
    inputSchema: z.object({
      walletAddress: z.string().describe('The wallet address inhabiting the agent'),
      agentId: z.string().describe('The ID of the agent to inhabit'),
    }),
    execute: async (input, _context): Promise<ToolResult> => {
      try {
        const result = await services.inhabitAgent(input.walletAddress, input.agentId);

        if (!result.success) {
          return {
            success: false,
            error: result.error,
          };
        }

        return {
          success: true,
          data: {
            message: `Successfully inhabited ${result.agentName}!`,
            agentId: result.agentId,
            agentName: result.agentName,
            avatarUrl: result.avatarUrl,
            era: result.era,
          },
        };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to inhabit agent',
        };
      }
    },
  }),

  defineTool({
    name: 'verify_gate_burn',
    description:
      'Verify a Gate NFT burn transaction on-chain. This is step 1 of the abandon flow: burn a Gate NFT, then call this to verify, then complete abandonment.',
    category: 'wallet',
    platforms: ['admin-ui', 'api'],
    inputSchema: z.object({
      walletAddress: z.string().describe('The wallet that burned the NFT'),
      signature: z.string().describe('The Solana transaction signature of the burn'),
    }),
    execute: async (input, _context): Promise<ToolResult> => {
      try {
        const result = await services.verifyGateBurn(input.walletAddress, input.signature);

        if (!result.verified) {
          return {
            success: false,
            error: result.error || 'Burn verification failed',
          };
        }

        return {
          success: true,
          data: {
            verified: true,
            signature: result.signature,
            burnedMint: result.burnedMint,
            message: 'Gate NFT burn verified. You can now complete the abandon.',
          },
        };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to verify burn',
        };
      }
    },
  }),

  defineTool({
    name: 'abandon_agent',
    description:
      'Abandon the currently inhabited agent. REQUIRES a verified Gate NFT burn transaction. The agent becomes unclaimed and available for others to inhabit. User receives a Lineage NFT commemorating their era.',
    category: 'wallet',
    platforms: ['admin-ui', 'api'],
    inputSchema: z.object({
      walletAddress: z.string().describe('The wallet abandoning the agent'),
      burnTxSignature: z.string().describe('The transaction signature of the Gate NFT burn'),
    }),
    execute: async (input, _context): Promise<ToolResult> => {
      try {
        const result = await services.abandonAgent(input.walletAddress, input.burnTxSignature);

        if (!result.success) {
          return {
            success: false,
            error: result.error,
          };
        }

        return {
          success: true,
          data: {
            message: `Successfully abandoned ${result.agentName}. Era ${result.era} complete.`,
            agentId: result.agentId,
            agentName: result.agentName,
            era: result.era,
            lineageNftMint: result.lineageNftMint,
            gateStatus: result.gateStatus,
            nextStep: 'You can now mint your Lineage NFT to commemorate Era ' + result.era,
          },
        };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to abandon agent',
        };
      }
    },
  }),

  defineTool({
    name: 'prepare_lineage_mint',
    description:
      'Prepare metadata for minting a Lineage NFT. Call this after abandoning an agent to get the metadata needed to mint the commemorative NFT.',
    category: 'wallet',
    platforms: ['admin-ui', 'api'],
    inputSchema: z.object({
      agentId: z.string().describe('The agent ID that was abandoned'),
      walletAddress: z.string().describe('The wallet that abandoned the agent'),
    }),
    execute: async (input, _context): Promise<ToolResult> => {
      try {
        const prep = await services.prepareLineageMint(input.agentId, input.walletAddress);

        if (!prep.success) {
          return {
            success: false,
            error: prep.error,
          };
        }

        // Generate the full metadata JSON
        const metadataJson = services.generateLineageMetadata(prep.metadata!);

        return {
          success: true,
          data: {
            metadata: prep.metadata,
            metadataJson,
            collectionMint: prep.collectionMint,
            message: `Ready to mint Lineage NFT for Era ${prep.metadata!.era}${prep.metadata!.isGenesis ? ' (Genesis!)' : ''}`,
          },
        };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to prepare lineage mint',
        };
      }
    },
  }),

  defineTool({
    name: 'record_lineage_mint',
    description:
      'Record a successful Lineage NFT mint in the database. Call this after the on-chain mint transaction succeeds.',
    category: 'wallet',
    platforms: ['admin-ui', 'api'],
    inputSchema: z.object({
      agentId: z.string().describe('The agent ID'),
      walletAddress: z.string().describe('The wallet that minted'),
      nftMint: z.string().describe('The mint address of the new Lineage NFT'),
      era: z.number().describe('The era number of this lineage NFT'),
      burnSignature: z.string().optional().describe('The burn transaction signature (for audit)'),
    }),
    execute: async (input, _context): Promise<ToolResult> => {
      try {
        await services.recordLineageMint(
          input.agentId,
          input.walletAddress,
          input.nftMint,
          input.era,
          input.burnSignature
        );

        return {
          success: true,
          data: {
            message: `Lineage NFT recorded for Era ${input.era}`,
            nftMint: input.nftMint,
            agentId: input.agentId,
          },
        };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to record lineage mint',
        };
      }
    },
  }),
];

export default createNFTTools;
