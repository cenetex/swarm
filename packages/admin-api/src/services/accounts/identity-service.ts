/**
 * Identity Service
 *
 * Provides a unified interface for resolving and linking identities to accounts.
 * Replaces the separate getOrCreateAccountForWallet and getOrCreateAccountForPrivy
 * functions with a single generic implementation.
 */
import {
  type DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  DeleteCommand,
} from '@swarm/core';
import { randomUUID } from 'crypto';
import { getDynamoClient } from '../dynamo-client.js';

const dynamoClient = getDynamoClient();

const ADMIN_TABLE = process.env.ADMIN_TABLE!;

// Re-export types from accounts.ts for convenience
export type IdentityType = 'wallet' | 'privy';

export interface Identity {
  type: IdentityType;
  providerId: string;
}

export interface IdentityServiceDeps {
  dynamoClient: Pick<DynamoDBDocumentClient, 'send'>;
  tableName: string;
  now: () => number;
  uuid: () => string;
}

function getDefaultDeps(): IdentityServiceDeps {
  return {
    dynamoClient,
    tableName: ADMIN_TABLE,
    now: () => Date.now(),
    uuid: () => randomUUID(),
  };
}

// ============================================================================
// Key Generation Helpers
// ============================================================================

function identityPk(type: IdentityType, providerId: string): string {
  return `IDENTITY#${type}#${providerId}`;
}

function accountPk(accountId: string): string {
  return `ACCOUNT#${accountId}`;
}

function accountIdentitySk(type: IdentityType, providerId: string): string {
  return `IDENTITY#${type}#${providerId}`;
}

// ============================================================================
// Result Types
// ============================================================================

export type ResolveAccountResult =
  | {
      success: true;
      accountId: string;
      created: boolean;
      linkedIdentities: Identity[];
    }
  | {
      success: false;
      error: string;
      conflict: {
        identity: Identity;
        existingAccountId: string;
      };
    };

export type LinkIdentityResult =
  | { success: true; linked: boolean }
  | {
      success: false;
      error: string;
      conflict?: {
        identity: Identity;
        existingAccountId: string;
      };
    };

export type UnlinkIdentityResult =
  | { success: true }
  | { success: false; error: string };

// ============================================================================
// Core Functions
// ============================================================================

/**
 * Get the accountId linked to a specific identity.
 */
export async function getAccountIdForIdentity(
  identity: Identity,
  deps: IdentityServiceDeps = getDefaultDeps()
): Promise<string | null> {
  const result = await deps.dynamoClient.send(
    new GetCommand({
      TableName: deps.tableName,
      Key: { pk: identityPk(identity.type, identity.providerId), sk: 'ACCOUNT' },
    })
  );

  return (result.Item as { accountId?: string } | undefined)?.accountId ?? null;
}

/**
 * Check if multiple identities resolve to conflicting accounts.
 * Returns the first conflict found, or null if no conflicts.
 */
async function checkIdentityConflicts(
  identities: Identity[],
  deps: IdentityServiceDeps
): Promise<{
  accountId: string | null;
  conflict: { identity: Identity; existingAccountId: string } | null;
}> {
  let foundAccountId: string | null = null;

  for (const identity of identities) {
    const accountId = await getAccountIdForIdentity(identity, deps);
    if (accountId) {
      if (foundAccountId && accountId !== foundAccountId) {
        return {
          accountId: foundAccountId,
          conflict: { identity, existingAccountId: accountId },
        };
      }
      foundAccountId = accountId;
    }
  }

  return { accountId: foundAccountId, conflict: null };
}

/**
 * Create a new account.
 */
async function createAccount(deps: IdentityServiceDeps): Promise<string> {
  const now = deps.now();
  const accountId = deps.uuid();

  await deps.dynamoClient.send(
    new PutCommand({
      TableName: deps.tableName,
      Item: {
        pk: accountPk(accountId),
        sk: 'PROFILE',
        accountId,
        role: 'user',
        createdAt: now,
        sessionCount: 0,
        lastSeenAt: now,
      },
      ConditionExpression: 'attribute_not_exists(pk)',
    })
  );

  return accountId;
}

/**
 * Link an identity to an account. Idempotent - succeeds if already linked to same account.
 */
export async function linkIdentity(
  accountId: string,
  identity: Identity,
  deps: IdentityServiceDeps = getDefaultDeps()
): Promise<LinkIdentityResult> {
  const now = deps.now();

  // Check for existing link to a different account
  const existingAccountId = await getAccountIdForIdentity(identity, deps);
  if (existingAccountId && existingAccountId !== accountId) {
    return {
      success: false,
      error: `${identity.type} identity is already linked to another account`,
      conflict: { identity, existingAccountId },
    };
  }

  // Link identity to account (two-way)
  if (!existingAccountId) {
    try {
      await deps.dynamoClient.send(
        new PutCommand({
          TableName: deps.tableName,
          Item: {
            pk: identityPk(identity.type, identity.providerId),
            sk: 'ACCOUNT',
            identityType: identity.type,
            providerId: identity.providerId,
            accountId,
            createdAt: now,
          },
          ConditionExpression: 'attribute_not_exists(pk)',
        })
      );
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'ConditionalCheckFailedException') {
        // Race condition - check who won
        const winner = await getAccountIdForIdentity(identity, deps);
        if (winner && winner !== accountId) {
          return {
            success: false,
            error: `${identity.type} identity is already linked to another account`,
            conflict: { identity, existingAccountId: winner },
          };
        }
        // We won or it's already linked to us - proceed idempotently
      } else {
        throw err;
      }
    }
  }

  // Ensure the identity is also listed under the account (for enumeration)
  await deps.dynamoClient.send(
    new PutCommand({
      TableName: deps.tableName,
      Item: {
        pk: accountPk(accountId),
        sk: accountIdentitySk(identity.type, identity.providerId),
        identityType: identity.type,
        providerId: identity.providerId,
        createdAt: now,
      },
    })
  );

  return { success: true, linked: !existingAccountId };
}

/**
 * Unlink an identity from an account.
 * Fails if:
 * - Identity is not linked to the account
 * - This is the last identity on the account (would orphan it)
 */
export async function unlinkIdentity(
  accountId: string,
  identity: Identity,
  deps: IdentityServiceDeps = getDefaultDeps()
): Promise<UnlinkIdentityResult> {
  // Verify identity is linked to this account
  const linkedAccountId = await getAccountIdForIdentity(identity, deps);
  if (!linkedAccountId) {
    return { success: false, error: 'Identity is not linked to any account' };
  }
  if (linkedAccountId !== accountId) {
    return { success: false, error: 'Identity is linked to a different account' };
  }

  // Check this isn't the last identity
  const identitiesResult = await deps.dynamoClient.send(
    new QueryCommand({
      TableName: deps.tableName,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: {
        ':pk': accountPk(accountId),
        ':prefix': 'IDENTITY#',
      },
    })
  );

  const identityCount = identitiesResult.Items?.length ?? 0;
  if (identityCount <= 1) {
    return { success: false, error: 'Cannot unlink the last identity from an account' };
  }

  // Delete the identity mapping
  await deps.dynamoClient.send(
    new DeleteCommand({
      TableName: deps.tableName,
      Key: { pk: identityPk(identity.type, identity.providerId), sk: 'ACCOUNT' },
    })
  );

  // Delete the identity record under the account
  await deps.dynamoClient.send(
    new DeleteCommand({
      TableName: deps.tableName,
      Key: { pk: accountPk(accountId), sk: accountIdentitySk(identity.type, identity.providerId) },
    })
  );

  return { success: true };
}

/**
 * Get all identities linked to an account.
 */
export async function getAccountIdentities(
  accountId: string,
  deps: IdentityServiceDeps = getDefaultDeps()
): Promise<Identity[]> {
  const result = await deps.dynamoClient.send(
    new QueryCommand({
      TableName: deps.tableName,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: {
        ':pk': accountPk(accountId),
        ':prefix': 'IDENTITY#',
      },
    })
  );

  return (result.Items ?? []).map((item: Record<string, unknown>) => ({
    type: item.identityType as IdentityType,
    providerId: item.providerId as string,
  }));
}

/**
 * Resolve an account for a set of identities.
 *
 * This is the unified replacement for getOrCreateAccountForWallet
 * and getOrCreateAccountForPrivy.
 *
 * @param params.primaryIdentity - The main identity to resolve (e.g., wallet for wallet auth)
 * @param params.additionalIdentities - Additional identities to link (e.g., privy ID)
 * @param params.createIfNotFound - If true, creates a new account if no identity matches
 *
 * Behavior:
 * 1. Check all identities for existing account mappings
 * 2. If any identities map to different accounts, return a conflict error
 * 3. If an existing account is found, link any unlinked identities to it
 * 4. If no account found and createIfNotFound is true, create one and link all identities
 */
export async function resolveAccountForIdentity(
  params: {
    primaryIdentity: Identity;
    additionalIdentities?: Identity[];
    createIfNotFound?: boolean;
  },
  deps: IdentityServiceDeps = getDefaultDeps()
): Promise<ResolveAccountResult> {
  const { primaryIdentity, additionalIdentities = [], createIfNotFound = true } = params;
  const allIdentities = [primaryIdentity, ...additionalIdentities];

  // Check for conflicts across all provided identities
  const { accountId: existingAccountId, conflict } = await checkIdentityConflicts(
    allIdentities,
    deps
  );

  if (conflict) {
    return {
      success: false,
      error: `${conflict.identity.type} identity is already linked to another account`,
      conflict,
    };
  }

  let accountId = existingAccountId;
  let created = false;

  // Create account if none exists and creation is requested
  if (!accountId) {
    if (!createIfNotFound) {
      return {
        success: false,
        error: 'No account found for the provided identities',
        conflict: { identity: primaryIdentity, existingAccountId: '' },
      };
    }

    accountId = await createAccount(deps);
    created = true;
  }

  // Link all identities to the account
  const linkedIdentities: Identity[] = [];
  for (const identity of allIdentities) {
    const result = await linkIdentity(accountId, identity, deps);
    if (!result.success) {
      // This shouldn't happen if we checked conflicts correctly, but handle it
      return {
        success: false,
        error: result.error,
        conflict: result.conflict!,
      };
    }
    if (result.linked) {
      linkedIdentities.push(identity);
    }
  }

  return {
    success: true,
    accountId,
    created,
    linkedIdentities,
  };
}
