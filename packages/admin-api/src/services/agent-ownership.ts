/**
 * Agent Ownership Service
 * 
 * Manages 1:1 ownership between Solana wallets and agents.
 * Each wallet can only "inhabit" one agent at a time.
 * Owning an agent lets the user appear as that avatar in chat.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import type { AgentRecord } from '../types.js';

const TABLE_NAME = process.env.ADMIN_TABLE || 'SwarmAdminTable';

const client = new DynamoDBClient({});
const ddb = DynamoDBDocumentClient.from(client);

export interface OwnershipResult {
  success: boolean;
  error?: string;
  agentId?: string;
  agentName?: string;
  avatarUrl?: string;
}

/**
 * Get the agent owned by a wallet (if any)
 */
export async function getOwnedAgent(walletAddress: string): Promise<AgentRecord | null> {
  // Query using GSI on ownerWallet (would need to add GSI) 
  // For now, scan with filter - optimize with GSI later
  // Actually, we can just store OWNER#{wallet} -> agentId mapping
  
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
  
  // Now get the actual agent
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
 * Claim ownership of an agent
 * 
 * @param walletAddress - The wallet claiming ownership
 * @param agentId - The agent to claim
 * @returns Result with success/error
 */
export async function claimAgent(
  walletAddress: string, 
  agentId: string
): Promise<OwnershipResult> {
  // First check if wallet already owns an agent
  const existingOwned = await getOwnedAgent(walletAddress);
  if (existingOwned) {
    return {
      success: false,
      error: `You already inhabit ${existingOwned.name}. Release it first to claim another.`,
    };
  }
  
  // Check if agent exists and is not already owned
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
  
  if (agent.ownerWallet) {
    return { 
      success: false, 
      error: `${agent.name} is already inhabited by another wallet`,
    };
  }
  
  // Use transact write for atomicity (simplified version using conditional writes)
  const now = Date.now();
  
  try {
    // Update agent with owner - condition: still no owner
    await ddb.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: `AGENT#${agentId}`,
        sk: 'CONFIG',
      },
      UpdateExpression: 'SET ownerWallet = :wallet, ownerClaimedAt = :now, updatedAt = :now',
      ConditionExpression: 'attribute_not_exists(ownerWallet)',
      ExpressionAttributeValues: {
        ':wallet': walletAddress,
        ':now': now,
      },
    }));
    
    // Create ownership mapping
    await ddb.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: `OWNER#${walletAddress}`,
        sk: 'AGENT',
      },
      UpdateExpression: 'SET agentId = :agentId, claimedAt = :now',
      ExpressionAttributeValues: {
        ':agentId': agentId,
        ':now': now,
      },
    }));
    
    return {
      success: true,
      agentId,
      agentName: agent.name,
      avatarUrl: agent.profileImage?.url,
    };
  } catch (err: any) {
    if (err.name === 'ConditionalCheckFailedException') {
      return { 
        success: false, 
        error: `${agent.name} was just claimed by another wallet`,
      };
    }
    throw err;
  }
}

/**
 * Release ownership of an agent
 * 
 * @param walletAddress - The wallet releasing ownership
 * @returns Result with success/error
 */
export async function releaseAgent(walletAddress: string): Promise<OwnershipResult> {
  // Get the agent they own
  const owned = await getOwnedAgent(walletAddress);
  
  if (!owned) {
    return { success: false, error: 'You do not currently inhabit any agent' };
  }
  
  // Remove owner from agent
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
  
  // Delete ownership mapping
  await ddb.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: {
      pk: `OWNER#${walletAddress}`,
      sk: 'AGENT',
    },
    UpdateExpression: 'REMOVE agentId, claimedAt',
  }));
  
  return {
    success: true,
    agentId: owned.agentId,
    agentName: owned.name,
  };
}

/**
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
