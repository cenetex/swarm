/**
 * Chat Modification Voting Service
 * 
 * Implements a voting system for chat modifications (photo, description, title).
 * All bots in a chat must unanimously approve before changes are made.
 * Rate limited to once per week per modification type.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { randomUUID } from 'crypto';
import type {
  ChatModificationProposal,
  ChatModificationLimit,
  ChatModificationType,
  ChatModificationStatus,
} from '../types.js';
import * as telegram from './telegram.js';

const dynamoClient = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
const ADMIN_TABLE = process.env.ADMIN_TABLE!;

// Rate limit: once per week (7 days in ms)
const MODIFICATION_RATE_LIMIT_MS = 7 * 24 * 60 * 60 * 1000;

// Proposal expiration: 7 days
const PROPOSAL_EXPIRATION_MS = 7 * 24 * 60 * 60 * 1000;

// ============================================================================
// Helper Functions
// ============================================================================

function makePk(chatId: number): string {
  return `CHAT_VOTE#${chatId}`;
}

function makeProposalSk(proposalId: string): string {
  return `PROPOSAL#${proposalId}`;
}

function makeLimitPk(chatId: number): string {
  return `CHAT_MOD_LIMIT#${chatId}`;
}

function makeLimitSk(type: ChatModificationType): string {
  return `TYPE#${type}`;
}

// ============================================================================
// Rate Limiting
// ============================================================================

/**
 * Check if a modification is allowed (not rate limited)
 */
export async function canModifyChat(
  chatId: number,
  type: ChatModificationType
): Promise<{
  allowed: boolean;
  reason?: string;
  lastModifiedAt?: number;
  nextAllowedAt?: number;
}> {
  const result = await dynamoClient.send(new GetCommand({
    TableName: ADMIN_TABLE,
    Key: {
      pk: makeLimitPk(chatId),
      sk: makeLimitSk(type),
    },
  }));

  const limit = result.Item as ChatModificationLimit | undefined;
  
  if (!limit) {
    return { allowed: true };
  }

  const now = Date.now();
  const timeSinceLastMod = now - limit.lastModifiedAt;
  
  if (timeSinceLastMod < MODIFICATION_RATE_LIMIT_MS) {
    const nextAllowedAt = limit.lastModifiedAt + MODIFICATION_RATE_LIMIT_MS;
    const daysRemaining = Math.ceil((nextAllowedAt - now) / (24 * 60 * 60 * 1000));
    
    return {
      allowed: false,
      reason: `Chat ${type} was modified ${Math.floor(timeSinceLastMod / (24 * 60 * 60 * 1000))} days ago. Can be modified again in ${daysRemaining} day(s).`,
      lastModifiedAt: limit.lastModifiedAt,
      nextAllowedAt,
    };
  }

  return { allowed: true, lastModifiedAt: limit.lastModifiedAt };
}

/**
 * Record a successful modification
 */
async function recordModification(
  chatId: number,
  type: ChatModificationType,
  proposalId: string,
  agentId: string
): Promise<void> {
  const now = Date.now();
  const ttl = Math.floor((now + 30 * 24 * 60 * 60 * 1000) / 1000); // 30 days
  
  const limit: ChatModificationLimit = {
    pk: makeLimitPk(chatId),
    sk: makeLimitSk(type),
    chatId,
    type,
    lastModifiedAt: now,
    lastModifiedBy: agentId,
    proposalId,
    ttl,
  };

  await dynamoClient.send(new PutCommand({
    TableName: ADMIN_TABLE,
    Item: limit,
  }));
}

// ============================================================================
// Proposals
// ============================================================================

/**
 * Get list of bots in a chat from SharedChannelRecord
 */
export async function getChatBots(
  chatId: number
): Promise<Array<{ agentId: string; botUsername: string }>> {
  const result = await dynamoClient.send(new QueryCommand({
    TableName: ADMIN_TABLE,
    KeyConditionExpression: 'pk = :pk',
    ExpressionAttributeValues: {
      ':pk': `SHARED_CHANNEL#${chatId}`,
    },
  }));

  if (!result.Items || result.Items.length === 0) {
    return [];
  }

  return result.Items.map(item => ({
    agentId: item.agentId,
    botUsername: item.botUsername,
  }));
}

/**
 * Create a new modification proposal
 */
export async function createProposal(
  agentId: string,
  chatId: number,
  type: ChatModificationType,
  newValue: string,
  reason?: string
): Promise<ChatModificationProposal> {
  // Check rate limit first
  const rateCheck = await canModifyChat(chatId, type);
  if (!rateCheck.allowed) {
    throw new Error(rateCheck.reason || 'Rate limited');
  }

  // Check if there's already a pending proposal for this type
  const existing = await getActiveProposals(chatId);
  const existingOfType = existing.find(p => p.type === type && p.status === 'pending');
  if (existingOfType) {
    throw new Error(`There's already a pending proposal to change the chat ${type}. Vote on that first.`);
  }

  // Get list of bots in the chat
  const bots = await getChatBots(chatId);
  if (bots.length === 0) {
    throw new Error('No bots registered in this chat');
  }

  const proposalId = randomUUID();
  const now = Date.now();
  const ttl = Math.floor((now + PROPOSAL_EXPIRATION_MS) / 1000);

  const proposal: ChatModificationProposal = {
    pk: makePk(chatId),
    sk: makeProposalSk(proposalId),
    proposalId,
    chatId,
    type,
    proposedBy: agentId,
    proposedAt: now,
    newValue,
    reason,
    status: 'pending',
    votes: {
      // Proposer automatically votes approve
      [agentId]: {
        agentId,
        vote: 'approve',
        votedAt: now,
      },
    },
    requiredVotes: bots.length,
    ttl,
  };

  await dynamoClient.send(new PutCommand({
    TableName: ADMIN_TABLE,
    Item: proposal,
  }));

  // Check if auto-approved (single bot case)
  if (bots.length === 1) {
    return {
      ...proposal,
      status: 'approved',
    };
  }

  return proposal;
}

/**
 * Vote on a proposal
 */
export async function voteOnProposal(
  agentId: string,
  proposalId: string,
  vote: 'approve' | 'reject',
  comment?: string
): Promise<ChatModificationProposal> {
  // Get the proposal first
  const proposal = await getProposal(proposalId);
  if (!proposal) {
    throw new Error('Proposal not found');
  }

  if (proposal.status !== 'pending') {
    throw new Error(`Proposal is already ${proposal.status}`);
  }

  // Check if this agent is in the chat
  const bots = await getChatBots(proposal.chatId);
  const isInChat = bots.some(b => b.agentId === agentId);
  if (!isInChat) {
    throw new Error('You are not a member of this chat');
  }

  // Record the vote
  const now = Date.now();
  const updatedVotes = {
    ...proposal.votes,
    [agentId]: {
      agentId,
      vote,
      votedAt: now,
      comment,
    },
  };

  // Determine new status
  let newStatus: ChatModificationStatus = 'pending';
  const approvals = Object.values(updatedVotes).filter(v => v.vote === 'approve').length;
  const rejections = Object.values(updatedVotes).filter(v => v.vote === 'reject').length;

  // Any rejection = rejected
  if (rejections > 0) {
    newStatus = 'rejected';
  }
  // All approved = approved
  else if (approvals >= proposal.requiredVotes) {
    newStatus = 'approved';
  }

  await dynamoClient.send(new UpdateCommand({
    TableName: ADMIN_TABLE,
    Key: {
      pk: proposal.pk,
      sk: proposal.sk,
    },
    UpdateExpression: 'SET votes = :votes, #status = :status',
    ExpressionAttributeNames: {
      '#status': 'status',
    },
    ExpressionAttributeValues: {
      ':votes': updatedVotes,
      ':status': newStatus,
    },
  }));

  return {
    ...proposal,
    votes: updatedVotes,
    status: newStatus,
  };
}

/**
 * Get a proposal by ID
 */
export async function getProposal(
  proposalId: string
): Promise<ChatModificationProposal | null> {
  // We need to scan for it since we don't know the chatId
  // In production, you'd want a GSI on proposalId
  const result = await dynamoClient.send(new QueryCommand({
    TableName: ADMIN_TABLE,
    IndexName: 'sk-index', // Assumes GSI exists
    KeyConditionExpression: 'sk = :sk',
    ExpressionAttributeValues: {
      ':sk': makeProposalSk(proposalId),
    },
  }));

  if (!result.Items || result.Items.length === 0) {
    return null;
  }

  const proposal = result.Items[0] as ChatModificationProposal;
  
  // Check if expired
  const now = Date.now();
  if (proposal.status === 'pending' && proposal.proposedAt + PROPOSAL_EXPIRATION_MS < now) {
    // Mark as expired
    await dynamoClient.send(new UpdateCommand({
      TableName: ADMIN_TABLE,
      Key: { pk: proposal.pk, sk: proposal.sk },
      UpdateExpression: 'SET #status = :status',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':status': 'expired' },
    }));
    return { ...proposal, status: 'expired' };
  }

  return proposal;
}

/**
 * Get active proposals for a chat
 */
export async function getActiveProposals(
  chatId: number
): Promise<ChatModificationProposal[]> {
  const result = await dynamoClient.send(new QueryCommand({
    TableName: ADMIN_TABLE,
    KeyConditionExpression: 'pk = :pk AND begins_with(sk, :skPrefix)',
    ExpressionAttributeValues: {
      ':pk': makePk(chatId),
      ':skPrefix': 'PROPOSAL#',
    },
  }));

  if (!result.Items) {
    return [];
  }

  const now = Date.now();
  const proposals: ChatModificationProposal[] = [];

  for (const item of result.Items) {
    const proposal = item as ChatModificationProposal;
    
    // Check if expired
    if (proposal.status === 'pending' && proposal.proposedAt + PROPOSAL_EXPIRATION_MS < now) {
      proposal.status = 'expired';
    }
    
    // Only return pending proposals as "active"
    if (proposal.status === 'pending') {
      proposals.push(proposal);
    }
  }

  return proposals;
}

// ============================================================================
// Execution
// ============================================================================

/**
 * Execute an approved modification
 */
export async function executeModification(
  agentId: string,
  proposalId: string,
  botToken: string
): Promise<{ success: boolean; error?: string }> {
  const proposal = await getProposal(proposalId);
  
  if (!proposal) {
    return { success: false, error: 'Proposal not found' };
  }

  if (proposal.status !== 'approved') {
    return { success: false, error: `Proposal is ${proposal.status}, not approved` };
  }

  // Check rate limit one more time
  const rateCheck = await canModifyChat(proposal.chatId, proposal.type);
  if (!rateCheck.allowed) {
    return { success: false, error: rateCheck.reason };
  }

  try {
    // Execute the modification
    switch (proposal.type) {
      case 'photo':
        await telegram.setChatPhoto(botToken, proposal.chatId, proposal.newValue);
        break;
      case 'description':
        await telegram.setChatDescription(botToken, proposal.chatId, proposal.newValue);
        break;
      case 'title':
        await telegram.setChatTitle(botToken, proposal.chatId, proposal.newValue);
        break;
    }

    // Record the modification for rate limiting
    await recordModification(proposal.chatId, proposal.type, proposalId, agentId);

    // Update proposal status
    await dynamoClient.send(new UpdateCommand({
      TableName: ADMIN_TABLE,
      Key: { pk: proposal.pk, sk: proposal.sk },
      UpdateExpression: 'SET #status = :status, executedAt = :executedAt, executedBy = :executedBy',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':status': 'executed',
        ':executedAt': Date.now(),
        ':executedBy': agentId,
      },
    }));

    return { success: true };
  } catch (err) {
    console.error('Failed to execute chat modification:', err);
    return { success: false, error: String(err) };
  }
}

// ============================================================================
// Helper: Proposal with computed fields
// ============================================================================

export interface ProposalWithCounts extends ChatModificationProposal {
  approvalCount: number;
  rejectionCount: number;
}

export function computeProposalCounts(proposal: ChatModificationProposal): ProposalWithCounts {
  const approvalCount = Object.values(proposal.votes).filter(v => v.vote === 'approve').length;
  const rejectionCount = Object.values(proposal.votes).filter(v => v.vote === 'reject').length;
  
  return {
    ...proposal,
    approvalCount,
    rejectionCount,
  };
}
