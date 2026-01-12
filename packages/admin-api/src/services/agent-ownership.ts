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
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand, GetCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import type { AgentRecord } from '../types.js';
import { getGateStatus, type GateStatus } from './nft-gate.js';

const TABLE_NAME = process.env.ADMIN_TABLE || 'SwarmAdminTable';

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
// NEW INHABITATION API (uses inhabitantWallet field)
// =============================================================================

/**
 * Get the agent inhabited by a wallet (if any)
 * Checks both new (inhabitantWallet) and legacy (ownerWallet) mappings
 */
export async function getInhabitedAgent(walletAddress: string): Promise<AgentRecord | null> {
  // Check new INHABITANT mapping first
  const newMapping = await ddb.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: {
      pk: `INHABITANT#${walletAddress}`,
      sk: 'AGENT',
    },
  }));

  if (newMapping.Item?.agentId) {
    const agentResult = await ddb.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: `AGENT#${newMapping.Item.agentId}`,
        sk: 'CONFIG',
      },
    }));
    if (agentResult.Item) {
      return agentResult.Item as AgentRecord;
    }
  }

  // Fall back to legacy OWNER mapping
  const legacyMapping = await ddb.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: {
      pk: `OWNER#${walletAddress}`,
      sk: 'AGENT',
    },
  }));

  if (legacyMapping.Item?.agentId) {
    const agentResult = await ddb.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: `AGENT#${legacyMapping.Item.agentId}`,
        sk: 'CONFIG',
      },
    }));
    if (agentResult.Item) {
      return agentResult.Item as AgentRecord;
    }
  }

  return null;
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

  // Check if already inhabited (check both new and legacy fields)
  if (agent.inhabitantWallet || agent.ownerWallet) {
    return {
      success: false,
      error: `${agent.name} is already inhabited by another wallet`,
    };
  }

  const now = Date.now();

  try {
    // Update agent with inhabitant - condition: still no inhabitant
    await ddb.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: `AGENT#${agentId}`,
        sk: 'CONFIG',
      },
      UpdateExpression: 'SET inhabitantWallet = :wallet, inhabitedAt = :now, updatedAt = :now',
      ConditionExpression: 'attribute_not_exists(inhabitantWallet) AND attribute_not_exists(ownerWallet)',
      ExpressionAttributeValues: {
        ':wallet': walletAddress,
        ':now': now,
      },
    }));

    // Create inhabitant mapping
    await ddb.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: `INHABITANT#${walletAddress}`,
        sk: 'AGENT',
      },
      UpdateExpression: 'SET agentId = :agentId, inhabitedAt = :now',
      ExpressionAttributeValues: {
        ':agentId': agentId,
        ':now': now,
      },
    }));

    console.log(`[Inhabit] Wallet ${walletAddress.slice(0, 8)}... inhabited agent ${agentId}`);

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
  if (agent.inhabitantWallet !== walletAddress && agent.ownerWallet !== walletAddress) {
    return {
      success: false,
      error: 'You do not inhabit this agent',
      gateStatus,
    };
  }

  const now = Date.now();
  const newEra = (agent.currentEra || 0) + 1;

  // Update agent: increment era, clear inhabitant
  await ddb.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: {
      pk: `AGENT#${agent.agentId}`,
      sk: 'CONFIG',
    },
    UpdateExpression: `
      SET currentEra = :era, updatedAt = :now
      REMOVE inhabitantWallet, inhabitedAt, ownerWallet, ownerClaimedAt
    `,
    ExpressionAttributeValues: {
      ':era': newEra,
      ':now': now,
    },
  }));

  // Delete inhabitant mapping
  await ddb.send(new DeleteCommand({
    TableName: TABLE_NAME,
    Key: {
      pk: `INHABITANT#${walletAddress}`,
      sk: 'AGENT',
    },
  }));

  // Also clean up legacy owner mapping if it exists
  await ddb.send(new DeleteCommand({
    TableName: TABLE_NAME,
    Key: {
      pk: `OWNER#${walletAddress}`,
      sk: 'AGENT',
    },
  }));

  console.log(`[Abandon] Wallet ${walletAddress.slice(0, 8)}... abandoned agent ${agent.agentId} (era ${newEra})${burnTxSignature ? `, burn tx: ${burnTxSignature}` : ''}`);

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
// LEGACY API (uses ownerWallet field) - Deprecated, use new API above
// =============================================================================

/**
 * @deprecated Use getInhabitedAgent instead
 * Get the agent owned by a wallet (if any)
 */
export async function getOwnedAgent(walletAddress: string): Promise<AgentRecord | null> {
  const result = await ddb.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: {
      pk: `OWNER#${walletAddress}`,
      sk: 'AGENT',
    },
  }));

  if (!result.Item) {
    return null;
  }

  const agentResult = await ddb.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: {
      pk: `AGENT#${result.Item.agentId}`,
      sk: 'CONFIG',
    },
  }));

  return agentResult.Item as AgentRecord | null;
}

/**
 * @deprecated Use inhabitAgent instead
 * Claim ownership of an agent
 */
export async function claimAgent(
  walletAddress: string,
  agentId: string
): Promise<OwnershipResult> {
  // Delegate to new API
  return inhabitAgent(walletAddress, agentId);
}

/**
 * @deprecated Use abandonAgent instead
 * Release ownership of an agent
 */
export async function releaseAgent(walletAddress: string): Promise<OwnershipResult> {
  // Note: Legacy release doesn't require NFT burn - only use for migration
  const owned = await getOwnedAgent(walletAddress);

  if (!owned) {
    return { success: false, error: 'You do not currently inhabit any agent' };
  }

  await ddb.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: {
      pk: `AGENT#${owned.agentId}`,
      sk: 'CONFIG',
    },
    UpdateExpression: 'REMOVE ownerWallet, ownerClaimedAt SET updatedAt = :now',
    ConditionExpression: 'ownerWallet = :wallet',
    ExpressionAttributeValues: {
      ':wallet': walletAddress,
      ':now': Date.now(),
    },
  }));

  await ddb.send(new DeleteCommand({
    TableName: TABLE_NAME,
    Key: {
      pk: `OWNER#${walletAddress}`,
      sk: 'AGENT',
    },
  }));

  return {
    success: true,
    agentId: owned.agentId,
    agentName: owned.name,
  };
}

/**
 * @deprecated Use getInhabitationInfo instead
 * Get ownership info for display
 */
export async function getOwnershipInfo(walletAddress: string): Promise<{
  inhabitsAgent: boolean;
  agentId?: string;
  agentName?: string;
  avatarUrl?: string;
}> {
  const owned = await getOwnedAgent(walletAddress);

  if (!owned) {
    return { inhabitsAgent: false };
  }

  return {
    inhabitsAgent: true,
    agentId: owned.agentId,
    agentName: owned.name,
    avatarUrl: owned.profileImage?.url,
  };
}
