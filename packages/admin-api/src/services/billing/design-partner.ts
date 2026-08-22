/**
 * Design Partner Beta Service
 *
 * Manages invite-only onboarding for the Design Partner Paid Beta (max 10 partners).
 * Per PROJECT-CHARTER.md Section 1b:
 *   - Invite-only; maximum 10 customers
 *   - Manual onboarding required (no self-serve checkout)
 *   - Support expectations explicitly communicated at signup
 *   - Quick cancellation / full refund available within 30 days
 *   - Board notified when beta is activated
 *   - Purpose: validate ICP, test billing flow end-to-end, gather feedback
 *
 * DynamoDB schema:
 *   Invite codes:  pk=DESIGN_PARTNER, sk=INVITE#<code>
 *   Partner index:  pk=DESIGN_PARTNER, sk=PARTNER#<accountId>
 *   Counter:        pk=DESIGN_PARTNER, sk=META
 */
import {
  GetCommand,
  PutCommand,
  UpdateCommand,
  QueryCommand,
} from '@swarm/core';
import { getDynamoClient } from '../dynamo-client.js';
import { createSystemLogger } from '../structured-logger.js';

const log = createSystemLogger('design-partner');
const ADMIN_TABLE = process.env.ADMIN_TABLE!;

/** Maximum concurrent design partners per charter */
export const MAX_DESIGN_PARTNERS = 10;

/** 30-day refund window in milliseconds */
export const REFUND_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

// ============================================================================
// Types
// ============================================================================

export type InviteCodeStatus = 'active' | 'redeemed' | 'revoked' | 'expired';
export type PartnerStatus = 'invited' | 'active' | 'churned' | 'refunded';

export interface DesignPartnerInvite {
  pk: 'DESIGN_PARTNER';
  sk: string;                     // INVITE#<code>
  code: string;
  status: InviteCodeStatus;
  plan: 'pro' | 'enterprise';
  createdAt: number;
  createdBy: string;
  expiresAt?: number;             // Optional expiration timestamp
  redeemedAt?: number;
  redeemedBy?: string;            // accountId of redeemer
  revokedAt?: number;
  revokedBy?: string;
  note?: string;                  // Admin note about who this code is for
}

export interface DesignPartnerRecord {
  pk: 'DESIGN_PARTNER';
  sk: string;                     // PARTNER#<accountId>
  accountId: string;
  avatarId: string;
  inviteCode: string;
  plan: 'pro' | 'enterprise';
  status: PartnerStatus;
  refundEligible: boolean;        // True within 30-day window
  refundDeadline: number;         // Timestamp when refund window closes
  onboardedAt: number;
  onboardedBy: string;            // Actor who redeemed the code
  feedbackSchedule?: {
    day1?: number;                // Timestamp of day-1 checkpoint
    day7?: number;                // Timestamp of day-7 check-in
    day14?: number;               // Timestamp of day-14 feedback session
    day30?: number;               // Timestamp of day-30 review
  };
  cancelledAt?: number;
  cancelledBy?: string;
  cancelReason?: string;
  note?: string;
}

export interface DesignPartnerMeta {
  pk: 'DESIGN_PARTNER';
  sk: 'META';
  activePartnerCount: number;
  totalCodesIssued: number;
  totalRedeemed: number;
  updatedAt: number;
}

// ============================================================================
// Code Generation
// ============================================================================

/**
 * Generate a human-readable invite code: DP-XXXX-XXXX
 */
export function generateInviteCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // No I, O, 0, 1 to reduce confusion
  const segment = () =>
    Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  return `DP-${segment()}-${segment()}`;
}

// ============================================================================
// Invite Code Management (Admin-only)
// ============================================================================

/**
 * Create a new invite code. Admin-only.
 * Returns null if the max partner limit has been reached.
 */
export async function createInviteCode(params: {
  plan: 'pro' | 'enterprise';
  createdBy: string;
  note?: string;
  expiresAt?: number;
}): Promise<DesignPartnerInvite | null> {
  const meta = await getDesignPartnerMeta();
  const activeCount = meta?.activePartnerCount ?? 0;

  if (activeCount >= MAX_DESIGN_PARTNERS) {
    return null;
  }

  const code = generateInviteCode();
  const now = Date.now();

  const invite: DesignPartnerInvite = {
    pk: 'DESIGN_PARTNER',
    sk: `INVITE#${code}`,
    code,
    status: 'active',
    plan: params.plan,
    createdAt: now,
    createdBy: params.createdBy,
    expiresAt: params.expiresAt,
    note: params.note,
  };

  await getDynamoClient().send(new PutCommand({
    TableName: ADMIN_TABLE,
    Item: invite,
    ConditionExpression: 'attribute_not_exists(pk)',
  }));

  // Update meta counter
  await incrementMetaCounter('totalCodesIssued');

  log.info('invite', 'invite_created', {
    code,
    plan: params.plan,
    createdBy: params.createdBy,
  });

  return invite;
}

/**
 * Get an invite code by its code string.
 */
export async function getInviteCode(code: string): Promise<DesignPartnerInvite | null> {
  const result = await getDynamoClient().send(new GetCommand({
    TableName: ADMIN_TABLE,
    Key: {
      pk: 'DESIGN_PARTNER',
      sk: `INVITE#${code}`,
    },
  }));

  return (result.Item as DesignPartnerInvite) || null;
}

/**
 * List all invite codes.
 */
export async function listInviteCodes(): Promise<DesignPartnerInvite[]> {
  const result = await getDynamoClient().send(new QueryCommand({
    TableName: ADMIN_TABLE,
    KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
    ExpressionAttributeValues: {
      ':pk': 'DESIGN_PARTNER',
      ':prefix': 'INVITE#',
    },
  }));

  return (result.Items || []) as DesignPartnerInvite[];
}

/**
 * Revoke an active invite code. Admin-only.
 */
export async function revokeInviteCode(
  code: string,
  actorId: string,
): Promise<boolean> {
  const invite = await getInviteCode(code);
  if (!invite || invite.status !== 'active') return false;

  await getDynamoClient().send(new UpdateCommand({
    TableName: ADMIN_TABLE,
    Key: {
      pk: 'DESIGN_PARTNER',
      sk: `INVITE#${code}`,
    },
    UpdateExpression: 'SET #status = :status, revokedAt = :now, revokedBy = :actor',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: {
      ':status': 'revoked',
      ':now': Date.now(),
      ':actor': actorId,
    },
  }));

  log.info('invite', 'invite_revoked', { code, actorId });
  return true;
}

// ============================================================================
// Invite Redemption
// ============================================================================

export type RedeemResult =
  | { success: true; partner: DesignPartnerRecord }
  | { success: false; error: 'invalid_code' | 'already_redeemed' | 'expired' | 'revoked' | 'max_partners' | 'already_partner' };

/**
 * Redeem an invite code, creating a design partner record and returning it.
 * On successful redemption, the caller is responsible for calling setEntitlement()
 * to provision the partner's Pro/Enterprise tier.
 */
export async function redeemInviteCode(params: {
  code: string;
  accountId: string;
  avatarId: string;
  actorId: string;
}): Promise<RedeemResult> {
  const { code, accountId, avatarId, actorId } = params;

  // 1. Validate the code
  const invite = await getInviteCode(code);
  if (!invite) {
    return { success: false, error: 'invalid_code' };
  }

  if (invite.status === 'revoked') {
    return { success: false, error: 'revoked' };
  }

  if (invite.status === 'redeemed') {
    return { success: false, error: 'already_redeemed' };
  }

  if (invite.status === 'expired' || (invite.expiresAt && invite.expiresAt < Date.now())) {
    return { success: false, error: 'expired' };
  }

  // 2. Check if account is already a design partner
  const existingPartner = await getPartner(accountId);
  if (existingPartner && existingPartner.status === 'active') {
    return { success: false, error: 'already_partner' };
  }

  // 3. Check partner count
  const meta = await getDesignPartnerMeta();
  const activeCount = meta?.activePartnerCount ?? 0;
  if (activeCount >= MAX_DESIGN_PARTNERS) {
    return { success: false, error: 'max_partners' };
  }

  const now = Date.now();
  const refundDeadline = now + REFUND_WINDOW_MS;

  // 4. Mark invite as redeemed
  await getDynamoClient().send(new UpdateCommand({
    TableName: ADMIN_TABLE,
    Key: {
      pk: 'DESIGN_PARTNER',
      sk: `INVITE#${code}`,
    },
    UpdateExpression: 'SET #status = :status, redeemedAt = :now, redeemedBy = :accountId',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: {
      ':status': 'redeemed',
      ':now': now,
      ':accountId': accountId,
    },
  }));

  // 5. Create partner record
  const partner: DesignPartnerRecord = {
    pk: 'DESIGN_PARTNER',
    sk: `PARTNER#${accountId}`,
    accountId,
    avatarId,
    inviteCode: code,
    plan: invite.plan,
    status: 'active',
    refundEligible: true,
    refundDeadline,
    onboardedAt: now,
    onboardedBy: actorId,
    feedbackSchedule: {
      day1: now + 1 * 24 * 60 * 60 * 1000,
      day7: now + 7 * 24 * 60 * 60 * 1000,
      day14: now + 14 * 24 * 60 * 60 * 1000,
      day30: now + 30 * 24 * 60 * 60 * 1000,
    },
  };

  await getDynamoClient().send(new PutCommand({
    TableName: ADMIN_TABLE,
    Item: partner,
  }));

  // 6. Update meta counters
  await updateMetaCounters({ activePartnerDelta: 1, totalRedeemedDelta: 1 });

  log.info('invite', 'invite_redeemed', {
    code,
    accountId,
    avatarId,
    plan: invite.plan,
  });

  return { success: true, partner };
}

// ============================================================================
// Partner Management
// ============================================================================

/**
 * Get a design partner record by account ID.
 */
export async function getPartner(accountId: string): Promise<DesignPartnerRecord | null> {
  const result = await getDynamoClient().send(new GetCommand({
    TableName: ADMIN_TABLE,
    Key: {
      pk: 'DESIGN_PARTNER',
      sk: `PARTNER#${accountId}`,
    },
  }));

  return (result.Item as DesignPartnerRecord) || null;
}

/**
 * List all design partners.
 */
export async function listPartners(): Promise<DesignPartnerRecord[]> {
  const result = await getDynamoClient().send(new QueryCommand({
    TableName: ADMIN_TABLE,
    KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
    ExpressionAttributeValues: {
      ':pk': 'DESIGN_PARTNER',
      ':prefix': 'PARTNER#',
    },
  }));

  return (result.Items || []) as DesignPartnerRecord[];
}

/**
 * Cancel a design partner. Sets status to 'churned' or 'refunded'.
 * The caller is responsible for downgrading the entitlement.
 */
export async function cancelPartner(params: {
  accountId: string;
  reason?: string;
  isRefund: boolean;
  actorId: string;
}): Promise<DesignPartnerRecord | null> {
  const { accountId, reason, isRefund, actorId } = params;

  const partner = await getPartner(accountId);
  if (!partner || partner.status !== 'active') return null;

  const now = Date.now();
  const newStatus: PartnerStatus = isRefund ? 'refunded' : 'churned';

  await getDynamoClient().send(new UpdateCommand({
    TableName: ADMIN_TABLE,
    Key: {
      pk: 'DESIGN_PARTNER',
      sk: `PARTNER#${accountId}`,
    },
    UpdateExpression: `
      SET #status = :status,
          cancelledAt = :now,
          cancelledBy = :actor,
          cancelReason = :reason,
          refundEligible = :refundEligible
    `,
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: {
      ':status': newStatus,
      ':now': now,
      ':actor': actorId,
      ':reason': reason || (isRefund ? 'Full refund within 30-day window' : 'Partner cancelled'),
      ':refundEligible': false,
    },
  }));

  // Decrement active partner count
  await updateMetaCounters({ activePartnerDelta: -1, totalRedeemedDelta: 0 });

  log.info('partner', 'partner_cancelled', {
    accountId,
    status: newStatus,
    actorId,
  });

  return { ...partner, status: newStatus, cancelledAt: now, cancelledBy: actorId };
}

/**
 * Check whether a partner is still eligible for a refund (within 30-day window).
 */
export function isRefundEligible(partner: DesignPartnerRecord): boolean {
  if (partner.status !== 'active') return false;
  return Date.now() < partner.refundDeadline;
}

// ============================================================================
// Meta / Counters
// ============================================================================

/**
 * Get the design partner meta record (counter aggregates).
 */
export async function getDesignPartnerMeta(): Promise<DesignPartnerMeta | null> {
  const result = await getDynamoClient().send(new GetCommand({
    TableName: ADMIN_TABLE,
    Key: {
      pk: 'DESIGN_PARTNER',
      sk: 'META',
    },
  }));

  return (result.Item as DesignPartnerMeta) || null;
}

async function incrementMetaCounter(
  field: 'totalCodesIssued' | 'totalRedeemed',
): Promise<void> {
  await getDynamoClient().send(new UpdateCommand({
    TableName: ADMIN_TABLE,
    Key: {
      pk: 'DESIGN_PARTNER',
      sk: 'META',
    },
    UpdateExpression: `
      SET #field = if_not_exists(#field, :zero) + :one,
          updatedAt = :now
    `,
    ExpressionAttributeNames: { '#field': field },
    ExpressionAttributeValues: {
      ':zero': 0,
      ':one': 1,
      ':now': Date.now(),
    },
  }));
}

async function updateMetaCounters(params: {
  activePartnerDelta: number;
  totalRedeemedDelta: number;
}): Promise<void> {
  const expressions: string[] = ['updatedAt = :now'];
  const values: Record<string, unknown> = { ':now': Date.now(), ':zero': 0 };
  const names: Record<string, string> = {};

  if (params.activePartnerDelta !== 0) {
    expressions.push('#active = if_not_exists(#active, :zero) + :activeDelta');
    names['#active'] = 'activePartnerCount';
    values[':activeDelta'] = params.activePartnerDelta;
  }

  if (params.totalRedeemedDelta !== 0) {
    expressions.push('#redeemed = if_not_exists(#redeemed, :zero) + :redeemedDelta');
    names['#redeemed'] = 'totalRedeemed';
    values[':redeemedDelta'] = params.totalRedeemedDelta;
  }

  await getDynamoClient().send(new UpdateCommand({
    TableName: ADMIN_TABLE,
    Key: {
      pk: 'DESIGN_PARTNER',
      sk: 'META',
    },
    UpdateExpression: `SET ${expressions.join(', ')}`,
    ExpressionAttributeNames: Object.keys(names).length ? names : undefined,
    ExpressionAttributeValues: values,
  }));
}
