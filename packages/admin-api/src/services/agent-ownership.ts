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
  UpdateCommand,
  GetCommand,
  DeleteCommand,
  QueryCommand,
  PutCommand,
} from '@aws-sdk/lib-dynamodb';
import type { AgentRecord } from '../types.js';
import { getGateStatus, type GateStatus } from './nft-gate.js';

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
    // Update agent with inhabitant - condition: still no inhabitant
    await ddb.send(
      new UpdateCommand({
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
      })
    );

    // Create inhabitant mapping record (for GSI1 lookup)
    await ddb.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          pk: `AGENT#${agentId}`,
          sk: `INHABITANT#${walletAddress}`,
          agentId,
          walletAddress,
          inhabitedAt: now,
        },
      })
    );

    console.log(
      `[Inhabit] Wallet ${walletAddress.slice(0, 8)}... inhabited agent ${agentId}`
    );

    return {
      success: true,
      agentId,
      agentName: agent.name,
      avatarUrl: agent.profileImage?.url,
      era: (agent.currentEra || 0) + 1, // They will be this era when they abandon
    };
  } catch (err: unknown) {
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
 * 1. Verifies the wallet holds a Gate NFT
 * 2. Increments the agent's era
 * 3. Clears the inhabitant
 * 4. Returns info needed to mint the lineage NFT and burn the Gate NFT
 *
 * Note: The actual NFT burn and lineage mint happen client-side after this call
 *
 * @param walletAddress - The wallet abandoning the agent
 * @param burnTxSignature - Optional: The signature of the Gate NFT burn transaction
 * @returns Result with agent info for lineage minting
 */
export async function abandonAgent(
  walletAddress: string,
  burnTxSignature?: string
): Promise<AbandonResult> {
  // Get current gate status
  const gateStatus = await getGateStatus(walletAddress);

  if (!gateStatus.canAbandon) {
    return {
      success: false,
      error: 'You must hold at least 1 Gate NFT to abandon an agent. Purchase one to leave.',
      gateStatus,
    };
  }

  // Get the inhabited agent
  const agent = await getInhabitedAgent(walletAddress);

  if (!agent) {
    return {
      success: false,
      error: 'You do not currently inhabit any agent',
      gateStatus,
    };
  }

  // Verify this wallet is the inhabitant
  if (agent.inhabitantWallet !== walletAddress) {
    return {
      success: false,
      error: 'You do not inhabit this agent',
      gateStatus,
    };
  }

  const now = Date.now();
  const newEra = (agent.currentEra || 0) + 1;

  // Update agent: increment era, clear inhabitant
  await ddb.send(
    new UpdateCommand({
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
    })
  );

  // Delete inhabitant mapping record
  await ddb.send(
    new DeleteCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: `AGENT#${agent.agentId}`,
        sk: `INHABITANT#${walletAddress}`,
      },
    })
  );

  console.log(
    `[Abandon] Wallet ${walletAddress.slice(0, 8)}... abandoned agent ${agent.agentId} (era ${newEra})${burnTxSignature ? `, burn tx: ${burnTxSignature}` : ''}`
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
 * @deprecated Use abandonAgent instead
 */
export async function releaseAgent(
  walletAddress: string
): Promise<OwnershipResult> {
  const result = await abandonAgent(walletAddress);
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
