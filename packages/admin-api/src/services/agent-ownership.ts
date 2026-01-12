/**
 * Agent Inhabitation Service
 *
 * Manages 1:1 inhabitation between Solana wallets and agents.
 * Each wallet can only "inhabit" one agent at a time.
 * Inhabiting an agent lets the user appear as that avatar in chat.
 *
 * Key concepts:
 * - INHABIT = Claim an unclaimed agent (FREE, no NFT required)
 * - ABANDON = Release an agent (REQUIRES burning a Gate NFT)
 *
 * Data Model (uses GSI1 for wallet→agent lookup):
 * - Agent record: pk=AGENT#<id>, sk=CONFIG, inhabitantWallet=<wallet>
 * - Inhabitant mapping: pk=AGENT#<id>, sk=INHABITANT#<wallet>
 * - GSI1 query: sk=INHABITANT#<wallet> → returns pk=AGENT#<id>
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import type { AgentRecord } from '../types.js';
import { getGateStatus, type GateStatus } from './nft-gate.js';
import { verifyGateBurn } from './lineage-nft.js';

const TABLE_NAME = process.env.ADMIN_TABLE || 'SwarmAdminTable';
const GSI1_NAME = 'GSI1';

const client = new DynamoDBClient({});
const ddb = DynamoDBDocumentClient.from(client, {
  marshallOptions: { removeUndefinedValues: true },
});

export interface InhabitResult {
  success: boolean;
  error?: string;
  agentId?: string;
  agentName?: string;
  avatarUrl?: string;
  era?: number;  // Which era they will be when they abandon
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

// Legacy type alias
export type OwnershipResult = InhabitResult;

// =============================================================================
// INHABITATION API (uses GSI1 for wallet→agent lookups)
// =============================================================================

/**
 * Get the agent inhabited by a wallet (if any)
 * Uses GSI1 to query by sk=INHABITANT#<wallet>
 */
export async function getInhabitedAgent(
  walletAddress: string
): Promise<AgentRecord | null> {
  // Query GSI1: sk=INHABITANT#<wallet> returns pk=AGENT#<agentId>
  const result = await ddb.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      IndexName: GSI1_NAME,
      KeyConditionExpression: 'sk = :sk',
      ExpressionAttributeValues: {
        ':sk': `INHABITANT#${walletAddress}`,
      },
      Limit: 1,
    })
  );

  if (!result.Items || result.Items.length === 0) {
    return null;
  }

  // Extract agentId from pk (AGENT#<agentId>)
  const pk = result.Items[0].pk as string;
  const agentId = pk.replace('AGENT#', '');

  // Get the full agent record
  const agentResult = await ddb.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: `AGENT#${agentId}`,
        sk: 'CONFIG',
      },
    })
  );

  return (agentResult.Item as AgentRecord) || null;
}

/**
 * Inhabit an unclaimed agent (FREE - no NFT required)
 *
 * Uses TransactWriteItems for atomic update of both:
 * 1. Agent CONFIG record (set inhabitantWallet)
 * 2. Inhabitant mapping record (for GSI1 lookup)
 *
 * @param walletAddress - The wallet inhabiting the agent
 * @param agentId - The agent to inhabit
 * @returns Result with success/error and agent info
 */
export async function inhabitAgent(
  walletAddress: string,
  agentId: string
): Promise<InhabitResult> {
  // Check if wallet already inhabits an agent
  const existingInhabited = await getInhabitedAgent(walletAddress);
  if (existingInhabited) {
    return {
      success: false,
      error: `You already inhabit ${existingInhabited.name}. You must abandon it first (requires burning a Gate NFT).`,
    };
  }

  // Get the agent
  const agentResult = await ddb.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: {
      pk: `AGENT#${agentId}`,
      sk: 'CONFIG',
    },
  }));

  if (!agentResult.Item) {
    return { success: false, error: 'Agent not found' };
  }

  const agent = agentResult.Item as AgentRecord;

  // Check if already inhabited
  if (agent.inhabitantWallet) {
    return {
      success: false,
      error: `${agent.name} is already inhabited by another wallet`,
    };
  }

  const now = Date.now();

  try {
    // Atomic transaction: update agent AND create mapping in one operation
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            // Update agent with inhabitant - condition: still no inhabitant
            Update: {
              TableName: TABLE_NAME,
              Key: {
                pk: `AGENT#${agentId}`,
                sk: 'CONFIG',
              },
              UpdateExpression:
                'SET inhabitantWallet = :wallet, inhabitedAt = :now, updatedAt = :now',
              ConditionExpression: 'attribute_not_exists(inhabitantWallet)',
              ExpressionAttributeValues: {
                ':wallet': walletAddress,
                ':now': now,
              },
            },
          },
          {
            // Create inhabitant mapping record (for GSI1 lookup)
            Put: {
              TableName: TABLE_NAME,
              Item: {
                pk: `AGENT#${agentId}`,
                sk: `INHABITANT#${walletAddress}`,
                agentId,
                walletAddress,
                inhabitedAt: now,
              },
              // Prevent duplicate mappings
              ConditionExpression: 'attribute_not_exists(pk)',
            },
          },
        ],
      })
    );

    console.log(
      `[Inhabit] Wallet ${walletAddress.slice(0, 8)}... inhabited agent ${agentId} (atomic)`
    );

    return {
      success: true,
      agentId,
      agentName: agent.name,
      avatarUrl: agent.profileImage?.url,
      era: (agent.currentEra || 0) + 1, // They will be this era when they abandon
    };
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'TransactionCanceledException') {
      // Check which condition failed
      const message = err.message || '';
      if (message.includes('ConditionalCheckFailed')) {
        return {
          success: false,
          error: `${agent.name} was just inhabited by another wallet`,
        };
      }
    }
    if (err instanceof Error && err.name === 'ConditionalCheckFailedException') {
      return {
        success: false,
        error: `${agent.name} was just inhabited by another wallet`,
      };
    }
    throw err;
  }
}

/**
 * Check if a wallet can abandon their current agent
 * Requires holding at least 1 Gate NFT
 */
export async function canAbandon(walletAddress: string): Promise<{
  canAbandon: boolean;
  gateStatus: GateStatus;
  inhabitedAgent?: AgentRecord;
}> {
  const gateStatus = await getGateStatus(walletAddress);
  const inhabitedAgent = await getInhabitedAgent(walletAddress) ?? undefined;

  return {
    canAbandon: gateStatus.canAbandon && !!inhabitedAgent,
    gateStatus,
    inhabitedAgent,
  };
}

/**
 * Abandon an inhabited agent (REQUIRES burning a Gate NFT)
 *
 * This function:
 * 1. Verifies the burn transaction on-chain (REQUIRED)
 * 2. Increments the agent's era
 * 3. Clears the inhabitant atomically
 * 4. Returns info needed to mint the lineage NFT
 *
 * Flow:
 * 1. Client burns Gate NFT → gets transaction signature
 * 2. Client calls this endpoint with signature
 * 3. Backend verifies burn on-chain
 * 4. Backend releases agent
 *
 * @param walletAddress - The wallet abandoning the agent
 * @param burnTxSignature - REQUIRED: The signature of the Gate NFT burn transaction
 * @returns Result with agent info for lineage minting
 */
export async function abandonAgent(
  walletAddress: string,
  burnTxSignature: string
): Promise<AbandonResult> {
  // Burn verification is REQUIRED
  if (!burnTxSignature) {
    return {
      success: false,
      error: 'Burn transaction signature is required. You must burn a Gate NFT to abandon.',
    };
  }

  // Get the inhabited agent first (before verification, for better UX)
  const agent = await getInhabitedAgent(walletAddress);

  if (!agent) {
    return {
      success: false,
      error: 'You do not currently inhabit any agent',
    };
  }

  // Verify this wallet is the inhabitant
  if (agent.inhabitantWallet !== walletAddress) {
    return {
      success: false,
      error: 'You do not inhabit this agent',
    };
  }

  // Verify the burn transaction on-chain
  const burnVerification = await verifyGateBurn(walletAddress, burnTxSignature);
  if (!burnVerification.verified) {
    return {
      success: false,
      error: `Burn verification failed: ${burnVerification.error || 'Invalid transaction'}`,
    };
  }

  const now = Date.now();
  const newEra = (agent.currentEra || 0) + 1;

  try {
    // Atomic transaction: update agent AND delete mapping
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            // Update agent: increment era, clear inhabitant
            Update: {
              TableName: TABLE_NAME,
              Key: {
                pk: `AGENT#${agent.agentId}`,
                sk: 'CONFIG',
              },
              UpdateExpression: `
                SET currentEra = :era, updatedAt = :now, lastBurnTx = :burnTx
                REMOVE inhabitantWallet, inhabitedAt
              `,
              // Ensure we're still the inhabitant
              ConditionExpression: 'inhabitantWallet = :wallet',
              ExpressionAttributeValues: {
                ':era': newEra,
                ':now': now,
                ':burnTx': burnTxSignature,
                ':wallet': walletAddress,
              },
            },
          },
          {
            // Delete inhabitant mapping record
            Delete: {
              TableName: TABLE_NAME,
              Key: {
                pk: `AGENT#${agent.agentId}`,
                sk: `INHABITANT#${walletAddress}`,
              },
            },
          },
        ],
      })
    );

    console.log(
      `[Abandon] Wallet ${walletAddress.slice(0, 8)}... abandoned agent ${agent.agentId} (era ${newEra}, burn tx: ${burnTxSignature.slice(0, 16)}...)`
    );

    // Get updated gate status
    const gateStatus = await getGateStatus(walletAddress);

    return {
      success: true,
      agentId: agent.agentId,
      agentName: agent.name,
      era: newEra,
      lineageNftMint: agent.nftCollectionMint,
      gateStatus,
    };
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'TransactionCanceledException') {
      return {
        success: false,
        error: 'Agent state changed during abandon. Please try again.',
      };
    }
    throw err;
  }
}

/**
 * Abandon without burn verification (LEGACY - for migration only)
 * @deprecated Use abandonAgent with burnTxSignature instead
 */
export async function abandonAgentLegacy(
  walletAddress: string
): Promise<AbandonResult> {
  // Get current gate status
  const gateStatus = await getGateStatus(walletAddress);

  if (!gateStatus.canAbandon) {
    return {
      success: false,
      error: 'You must hold at least 1 Gate NFT to abandon an agent.',
      gateStatus,
    };
  }

  const agent = await getInhabitedAgent(walletAddress);

  if (!agent) {
    return {
      success: false,
      error: 'You do not currently inhabit any agent',
      gateStatus,
    };
  }

  if (agent.inhabitantWallet !== walletAddress) {
    return {
      success: false,
      error: 'You do not inhabit this agent',
      gateStatus,
    };
  }

  const now = Date.now();
  const newEra = (agent.currentEra || 0) + 1;

  await ddb.send(
    new TransactWriteCommand({
      TransactItems: [
        {
          Update: {
            TableName: TABLE_NAME,
            Key: {
              pk: `AGENT#${agent.agentId}`,
              sk: 'CONFIG',
            },
            UpdateExpression: `
              SET currentEra = :era, updatedAt = :now
              REMOVE inhabitantWallet, inhabitedAt
            `,
            ExpressionAttributeValues: {
              ':era': newEra,
              ':now': now,
            },
          },
        },
        {
          Delete: {
            TableName: TABLE_NAME,
            Key: {
              pk: `AGENT#${agent.agentId}`,
              sk: `INHABITANT#${walletAddress}`,
            },
          },
        },
      ],
    })
  );

  console.log(
    `[Abandon] LEGACY: Wallet ${walletAddress.slice(0, 8)}... abandoned agent ${agent.agentId} (era ${newEra})`
  );

  return {
    success: true,
    agentId: agent.agentId,
    agentName: agent.name,
    era: newEra,
    lineageNftMint: agent.nftCollectionMint,
    gateStatus,
  };
}

/**
 * Get inhabitation info for display
 * Returns ghost status for unauthenticated or non-inhabiting users
 */
export async function getInhabitationInfo(walletAddress: string): Promise<{
  isGhost: boolean;
  inhabitsAgent: boolean;
  agentId?: string;
  agentName?: string;
  avatarUrl?: string;
  era?: number;
  gateStatus?: GateStatus;
}> {
  const agent = await getInhabitedAgent(walletAddress);

  if (!agent) {
    const gateStatus = await getGateStatus(walletAddress);
    return {
      isGhost: true,
      inhabitsAgent: false,
      gateStatus,
    };
  }

  return {
    isGhost: false,
    inhabitsAgent: true,
    agentId: agent.agentId,
    agentName: agent.name,
    avatarUrl: agent.profileImage?.url,
    era: agent.currentEra || 0,
  };
}

// =============================================================================
// RECONCILIATION - Fix orphaned mappings
// =============================================================================

export interface ReconciliationResult {
  orphanedMappings: number;
  orphanedAgents: number;
  fixed: number;
  errors: string[];
}

/**
 * Find and fix orphaned inhabitant mappings
 *
 * Orphaned states can occur if:
 * 1. Mapping exists but agent.inhabitantWallet is null (mapping orphan)
 * 2. Agent.inhabitantWallet is set but no mapping exists (agent orphan)
 *
 * This function scans for both cases and reconciles them.
 */
export async function reconcileInhabitantMappings(
  dryRun: boolean = true
): Promise<ReconciliationResult> {
  const result: ReconciliationResult = {
    orphanedMappings: 0,
    orphanedAgents: 0,
    fixed: 0,
    errors: [],
  };

  console.log(`[Reconcile] Starting reconciliation (dryRun=${dryRun})`);

  try {
    // Scan for all INHABITANT# mappings
    const { ScanCommand } = await import('@aws-sdk/lib-dynamodb');

    const mappingScan = await ddb.send(
      new ScanCommand({
        TableName: TABLE_NAME,
        FilterExpression: 'begins_with(sk, :prefix)',
        ExpressionAttributeValues: {
          ':prefix': 'INHABITANT#',
        },
      })
    );

    const mappings = mappingScan.Items || [];
    console.log(`[Reconcile] Found ${mappings.length} inhabitant mappings`);

    for (const mapping of mappings) {
      const agentId = mapping.agentId as string;
      const walletAddress = mapping.walletAddress as string;

      // Get the agent record
      const agentResult = await ddb.send(
        new GetCommand({
          TableName: TABLE_NAME,
          Key: {
            pk: `AGENT#${agentId}`,
            sk: 'CONFIG',
          },
        })
      );

      const agent = agentResult.Item as AgentRecord | undefined;

      if (!agent) {
        // Agent doesn't exist - delete orphaned mapping
        result.orphanedMappings++;
        result.errors.push(`Mapping for non-existent agent: ${agentId}`);

        if (!dryRun) {
          const { DeleteCommand } = await import('@aws-sdk/lib-dynamodb');
          await ddb.send(
            new DeleteCommand({
              TableName: TABLE_NAME,
              Key: {
                pk: `AGENT#${agentId}`,
                sk: `INHABITANT#${walletAddress}`,
              },
            })
          );
          result.fixed++;
          console.log(`[Reconcile] Deleted orphaned mapping for agent ${agentId}`);
        }
      } else if (agent.inhabitantWallet !== walletAddress) {
        // Agent has different or no inhabitant - delete stale mapping
        result.orphanedMappings++;
        result.errors.push(
          `Stale mapping: agent ${agentId} has inhabitant ${agent.inhabitantWallet || 'none'}, but mapping points to ${walletAddress}`
        );

        if (!dryRun) {
          const { DeleteCommand } = await import('@aws-sdk/lib-dynamodb');
          await ddb.send(
            new DeleteCommand({
              TableName: TABLE_NAME,
              Key: {
                pk: `AGENT#${agentId}`,
                sk: `INHABITANT#${walletAddress}`,
              },
            })
          );
          result.fixed++;
          console.log(`[Reconcile] Deleted stale mapping for agent ${agentId}`);
        }
      }
    }

    // Also scan for agents with inhabitantWallet but no mapping
    const agentScan = await ddb.send(
      new ScanCommand({
        TableName: TABLE_NAME,
        FilterExpression: 'sk = :config AND attribute_exists(inhabitantWallet)',
        ExpressionAttributeValues: {
          ':config': 'CONFIG',
        },
      })
    );

    const agents = agentScan.Items || [];
    console.log(`[Reconcile] Found ${agents.length} agents with inhabitantWallet`);

    for (const agent of agents) {
      const agentId = agent.agentId as string;
      const walletAddress = agent.inhabitantWallet as string;

      // Check if mapping exists
      const mappingResult = await ddb.send(
        new GetCommand({
          TableName: TABLE_NAME,
          Key: {
            pk: `AGENT#${agentId}`,
            sk: `INHABITANT#${walletAddress}`,
          },
        })
      );

      if (!mappingResult.Item) {
        // No mapping exists - create it
        result.orphanedAgents++;
        result.errors.push(`Agent ${agentId} has inhabitant ${walletAddress} but no mapping`);

        if (!dryRun) {
          const { PutCommand } = await import('@aws-sdk/lib-dynamodb');
          await ddb.send(
            new PutCommand({
              TableName: TABLE_NAME,
              Item: {
                pk: `AGENT#${agentId}`,
                sk: `INHABITANT#${walletAddress}`,
                agentId,
                walletAddress,
                inhabitedAt: agent.inhabitedAt || Date.now(),
                reconciledAt: Date.now(),
              },
            })
          );
          result.fixed++;
          console.log(`[Reconcile] Created missing mapping for agent ${agentId}`);
        }
      }
    }

    console.log(
      `[Reconcile] Complete: ${result.orphanedMappings} orphaned mappings, ${result.orphanedAgents} orphaned agents, ${result.fixed} fixed`
    );
  } catch (err) {
    console.error('[Reconcile] Error:', err);
    result.errors.push(`Scan error: ${err instanceof Error ? err.message : 'Unknown'}`);
  }

  return result;
}

// =============================================================================
// LEGACY API - Deprecated aliases for backwards compatibility
// =============================================================================

/**
 * @deprecated Use getInhabitedAgent instead
 */
export const getOwnedAgent = getInhabitedAgent;

/**
 * @deprecated Use inhabitAgent instead
 */
export const claimAgent = inhabitAgent;

/**
 * @deprecated Use abandonAgent with burnTxSignature instead
 */
export async function releaseAgent(
  walletAddress: string
): Promise<OwnershipResult> {
  // Use legacy abandon which doesn't require burn verification
  const result = await abandonAgentLegacy(walletAddress);
  return {
    success: result.success,
    error: result.error,
    agentId: result.agentId,
    agentName: result.agentName,
  };
}

/**
 * @deprecated Use getInhabitationInfo instead
 */
export async function getOwnershipInfo(walletAddress: string): Promise<{
  inhabitsAgent: boolean;
  agentId?: string;
  agentName?: string;
  avatarUrl?: string;
}> {
  const info = await getInhabitationInfo(walletAddress);
  return {
    inhabitsAgent: info.inhabitsAgent,
    agentId: info.agentId,
    agentName: info.agentName,
    avatarUrl: info.avatarUrl,
  };
}
