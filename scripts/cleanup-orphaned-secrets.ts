#!/usr/bin/env node
/**
 * Clean up orphaned Secrets Manager secrets.
 *
 * Secrets accumulate when avatars are deleted without secret cleanup
 * (the lifecycle step was added later). Each secret costs ~$0.40/month,
 * so orphaned secrets can significantly inflate the staging bill.
 *
 * This script:
 * 1. Lists all active (non-deleted) avatars from the admin table
 * 2. Enumerates all `swarm/<avatarId>/...` secrets in Secrets Manager
 * 3. Identifies secrets whose avatarId has no active avatar record
 * 4. Deletes orphaned secrets (with ForceDeleteWithoutRecovery)
 *
 * Usage:
 *   # Dry run (default) — shows what would be deleted
 *   ADMIN_TABLE=SwarmAdmin-staging pnpm exec tsx scripts/cleanup-orphaned-secrets.ts
 *
 *   # Actually delete orphaned secrets
 *   ADMIN_TABLE=SwarmAdmin-staging pnpm exec tsx scripts/cleanup-orphaned-secrets.ts --execute
 *
 *   # Custom prefix/region
 *   ADMIN_TABLE=SwarmAdmin-staging pnpm exec tsx scripts/cleanup-orphaned-secrets.ts --prefix swarm --region us-east-1
 */

import {
  SecretsManagerClient,
  ListSecretsCommand,
  DeleteSecretCommand,
  type SecretListEntry,
} from '@aws-sdk/client-secrets-manager';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';

interface Args {
  execute: boolean;
  prefix: string;
  region: string;
  adminTable: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    execute: false,
    prefix: process.env.SECRET_PREFIX || 'swarm',
    region: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1',
    adminTable: process.env.ADMIN_TABLE || '',
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--execute') args.execute = true;
    else if (a === '--dry-run') args.execute = false;
    else if (a === '--prefix') {
      const value = argv[++i];
      if (!value) throw new Error('--prefix requires a value');
      args.prefix = value;
    } else if (a === '--region') {
      const value = argv[++i];
      if (!value) throw new Error('--region requires a value');
      args.region = value;
    } else if (a === '--table') {
      const value = argv[++i];
      if (!value) throw new Error('--table requires a value');
      args.adminTable = value;
    }
  }

  if (!args.adminTable) {
    throw new Error('ADMIN_TABLE env var or --table flag is required');
  }

  return args;
}

async function listActiveAvatarIds(docClient: DynamoDBDocumentClient, tableName: string): Promise<Set<string>> {
  const avatarIds = new Set<string>();
  let lastKey: Record<string, unknown> | undefined;

  do {
    const result = await docClient.send(new QueryCommand({
      TableName: tableName,
      IndexName: 'GSI1',
      KeyConditionExpression: 'sk = :sk',
      FilterExpression: '#s <> :deleted',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: {
        ':sk': 'CONFIG',
        ':deleted': 'deleted',
      },
      ProjectionExpression: 'pk',
      ExclusiveStartKey: lastKey,
    }));

    for (const item of result.Items || []) {
      const pk = item.pk as string;
      if (pk.startsWith('AVATAR#')) {
        avatarIds.add(pk.replace('AVATAR#', ''));
      }
    }
    lastKey = result.LastEvaluatedKey;
  } while (lastKey);

  return avatarIds;
}

async function listAllSecrets(smClient: SecretsManagerClient, prefix: string): Promise<SecretListEntry[]> {
  const secrets: SecretListEntry[] = [];
  let nextToken: string | undefined;

  do {
    const result = await smClient.send(new ListSecretsCommand({
      Filters: [{ Key: 'name', Values: [`${prefix}/`] }],
      MaxResults: 100,
      NextToken: nextToken,
    }));

    secrets.push(...(result.SecretList || []));
    nextToken = result.NextToken;
  } while (nextToken);

  return secrets;
}

function extractAvatarIdFromSecretName(secretName: string, prefix: string): string | null {
  // Pattern: <prefix>/<avatarId>/<secretType>/<name>
  // Skip global secrets: <prefix>/global/...
  // Skip env-scoped secrets: <prefix>/staging/..., <prefix>/prod/...
  const parts = secretName.split('/');
  if (parts.length < 3 || parts[0] !== prefix) return null;

  const segment = parts[1];
  // Skip non-avatar secrets
  if (segment === 'global' || segment === 'staging' || segment === 'prod' || segment === 'admin') {
    return null;
  }

  return segment;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  console.log(`Mode: ${args.execute ? 'EXECUTE (will delete)' : 'DRY RUN (read-only)'}`);
  console.log(`Table: ${args.adminTable}`);
  console.log(`Secret prefix: ${args.prefix}`);
  console.log(`Region: ${args.region}`);
  console.log('');

  const smClient = new SecretsManagerClient({ region: args.region });
  const dynamoClient = DynamoDBDocumentClient.from(
    new DynamoDBClient({ region: args.region })
  );

  // Step 1: Get active avatar IDs
  console.log('Fetching active avatars...');
  const activeAvatarIds = await listActiveAvatarIds(dynamoClient, args.adminTable);
  console.log(`Found ${activeAvatarIds.size} active avatars`);

  // Step 2: List all secrets
  console.log('Listing all secrets...');
  const allSecrets = await listAllSecrets(smClient, args.prefix);
  console.log(`Found ${allSecrets.length} total secrets with prefix "${args.prefix}/"`);

  // Step 3: Identify orphaned secrets
  const orphaned: SecretListEntry[] = [];
  const active: SecretListEntry[] = [];
  const nonAvatar: SecretListEntry[] = [];

  for (const secret of allSecrets) {
    const avatarId = extractAvatarIdFromSecretName(secret.Name || '', args.prefix);
    if (!avatarId) {
      nonAvatar.push(secret);
      continue;
    }

    if (activeAvatarIds.has(avatarId)) {
      active.push(secret);
    } else {
      orphaned.push(secret);
    }
  }

  console.log('');
  console.log(`Active avatar secrets: ${active.length}`);
  console.log(`Non-avatar secrets (global/env): ${nonAvatar.length}`);
  console.log(`Orphaned secrets: ${orphaned.length}`);

  if (orphaned.length === 0) {
    console.log('\nNo orphaned secrets found. Nothing to clean up.');
    return;
  }

  // Group orphaned secrets by avatar for readable output
  const byAvatar = new Map<string, string[]>();
  for (const secret of orphaned) {
    const avatarId = extractAvatarIdFromSecretName(secret.Name || '', args.prefix) || 'unknown';
    const list = byAvatar.get(avatarId) || [];
    list.push(secret.Name || '');
    byAvatar.set(avatarId, list);
  }

  console.log('\nOrphaned secrets by avatar:');
  for (const [avatarId, secrets] of byAvatar) {
    console.log(`  ${avatarId}: ${secrets.length} secrets`);
    for (const name of secrets) {
      console.log(`    - ${name}`);
    }
  }

  // Step 4: Delete if --execute
  if (!args.execute) {
    console.log(`\nDry run complete. Run with --execute to delete ${orphaned.length} orphaned secrets.`);
    const monthlySavings = (orphaned.length * 0.40).toFixed(2);
    console.log(`Estimated monthly savings: ~$${monthlySavings}`);
    return;
  }

  console.log(`\nDeleting ${orphaned.length} orphaned secrets...`);
  let deleted = 0;
  let errors = 0;

  for (const secret of orphaned) {
    try {
      await smClient.send(new DeleteSecretCommand({
        SecretId: secret.ARN,
        ForceDeleteWithoutRecovery: true,
      }));
      deleted++;
      process.stdout.write('.');
    } catch (err) {
      errors++;
      console.error(`\nFailed to delete ${secret.Name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log('');
  console.log(`\nDone. Deleted: ${deleted}, Errors: ${errors}`);
  const monthlySavings = (deleted * 0.40).toFixed(2);
  console.log(`Estimated monthly savings: ~$${monthlySavings}`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
