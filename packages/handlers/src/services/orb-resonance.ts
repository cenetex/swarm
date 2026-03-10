/**
 * Orb Resonance Tracker (handlers)
 *
 * Lightweight fire-and-forget helper that atomically increments the
 * resonance counter on the Orb slotted to an avatar.  Designed to be
 * called after every successful message processing without awaiting.
 *
 * Uses ADMIN_TABLE (where Orb slot records live) via GSI1 to look up
 * the Orb record by avatarId.
 */
import { QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { logger } from '@swarm/core';
import { getDynamoClient } from './dynamo-client.js';

const ORB_SLOT_SK = 'SLOT';

function orbSlotKey(mintAddress: string) {
  return { pk: `ORB#${mintAddress}`, sk: ORB_SLOT_SK };
}

/**
 * Increment the resonance counter on the Orb slotted to the given avatar.
 *
 * Fire-and-forget — logs errors but never throws.
 */
export async function incrementOrbResonance(
  avatarId: string,
  amount = 1,
): Promise<void> {
  const tableName = process.env.ADMIN_TABLE;
  if (!tableName) {
    // ADMIN_TABLE not available in this handler — skip silently.
    return;
  }

  const ddb = getDynamoClient();

  try {
    // Look up the Orb slotted to this avatar via GSI1
    const queryResult = await ddb.send(
      new QueryCommand({
        TableName: tableName,
        IndexName: 'gsi1',
        KeyConditionExpression: 'gsi1pk = :avatarKey AND gsi1sk = :slot',
        ExpressionAttributeValues: {
          ':avatarKey': `AVATAR#${avatarId}`,
          ':slot': ORB_SLOT_SK,
        },
        Limit: 1,
      }),
    );

    if (!queryResult.Items || queryResult.Items.length === 0) {
      // No Orb slotted — nothing to do.
      return;
    }

    const mintAddress = queryResult.Items[0].mintAddress as string;

    await ddb.send(
      new UpdateCommand({
        TableName: tableName,
        Key: orbSlotKey(mintAddress),
        UpdateExpression:
          'SET resonance = if_not_exists(resonance, :zero) + :amount, resonanceUpdatedAt = :now',
        ExpressionAttributeValues: {
          ':zero': 0,
          ':amount': amount,
          ':now': Date.now(),
        },
      }),
    );
  } catch (err) {
    logger.warn('Failed to increment Orb resonance', {
      avatarId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
