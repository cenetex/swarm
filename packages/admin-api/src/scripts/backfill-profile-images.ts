#!/usr/bin/env tsx

import { execFileSync } from 'node:child_process';
import { S3Client, ListObjectsV2Command } from '@swarm/core';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, UpdateCommand } from '@swarm/core';

type EnvName = 'dev' | 'staging' | 'prod';

function parseArgs(argv: string[]) {
  const args = new Map<string, string>();
  const flags = new Set<string>();

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg) continue;

    if (arg.startsWith('--')) {
      const [key, value] = arg.split('=', 2);
      if (value === undefined) {
        flags.add(key);
      } else {
        args.set(key, value);
      }
      continue;
    }

    // Support: --key value
    if (arg.startsWith('-')) {
      flags.add(arg);
      continue;
    }
  }

  const env = (args.get('--env') ?? 'staging') as EnvName;
  const apply = flags.has('--apply');
  const limit = Number.parseInt(args.get('--limit') ?? '', 10);
  const concurrency = Number.parseInt(args.get('--concurrency') ?? '', 10);

  const region = args.get('--region');
  const adminTable = args.get('--admin-table');
  const mediaBucket = args.get('--media-bucket');
  const mediaCdnUrl = args.get('--cdn-url');

  return {
    env,
    apply,
    limit: Number.isFinite(limit) && limit > 0 ? limit : undefined,
    concurrency: Number.isFinite(concurrency) && concurrency > 0 ? concurrency : 5,
    region,
    adminTable,
    mediaBucket,
    mediaCdnUrl,
  };
}

function buildPublicUrl(cdnUrl: string | undefined, bucket: string, key: string): string {
  if (cdnUrl) return `${cdnUrl.replace(/\/$/, '')}/${key}`;
  return `https://${bucket}.s3.amazonaws.com/${key}`;
}

function getStackOutputsViaAwsCli(env: EnvName, region: string) {
  const stackName = `SwarmStack-${env}`;

  const raw = execFileSync(
    'aws',
    [
      'cloudformation',
      'describe-stacks',
      '--stack-name',
      stackName,
      '--query',
      'Stacks[0].Outputs',
      '--output',
      'json',
      '--region',
      region,
    ],
    { encoding: 'utf-8' }
  );

  const outputs = JSON.parse(raw) as Array<{ OutputKey?: string; OutputValue?: string }>;

  const findOutput = (needle: RegExp): string | undefined => {
    const match = outputs.find(o => (o.OutputKey ?? '').match(needle));
    return match?.OutputValue;
  };

  const adminTable = findOutput(/AdminApiAdminTableName/i);
  const mediaBucket = findOutput(/SharedMediaBucketName/i);
  const mediaCdnUrl = findOutput(/SharedMediaCdnUrl/i);

  if (!adminTable) throw new Error(`Could not find Admin API table output for ${stackName}`);
  if (!mediaBucket) throw new Error(`Could not find Media bucket output for ${stackName}`);

  return { stackName, adminTable, mediaBucket, mediaCdnUrl };
}

async function listLatestLegacyProfileKey(s3: S3Client, bucket: string, avatarId: string): Promise<{ key: string; updatedAt: number } | null> {
  const prefix = `agents/${avatarId}/profile/`;

  const resp = await s3.send(new ListObjectsV2Command({
    Bucket: bucket,
    Prefix: prefix,
    MaxKeys: 20,
  }));

  const objects = (resp.Contents ?? []).filter((o: { Key?: string }) => !!o.Key);
  if (objects.length === 0) return null;

  objects.sort((a: { LastModified?: Date }, b: { LastModified?: Date }) => {
    const aTime = a.LastModified?.getTime() ?? 0;
    const bTime = b.LastModified?.getTime() ?? 0;
    return bTime - aTime;
  });

  const best = objects[0];
  if (!best?.Key) return null;

  return {
    key: best.Key,
    updatedAt: best.LastModified?.getTime() ?? Date.now(),
  };
}

async function run() {
  const { env, apply, limit, concurrency, region: regionArg, adminTable: adminTableArg, mediaBucket: mediaBucketArg, mediaCdnUrl: mediaCdnUrlArg } = parseArgs(process.argv);
  const region = regionArg ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? 'us-east-1';

  const stackOutputs = (!adminTableArg || !mediaBucketArg)
    ? getStackOutputsViaAwsCli(env, region)
    : { stackName: `SwarmStack-${env}`, adminTable: adminTableArg, mediaBucket: mediaBucketArg, mediaCdnUrl: mediaCdnUrlArg };

  const { stackName, adminTable, mediaBucket, mediaCdnUrl } = stackOutputs;

  console.log(`[backfill-profile-images] env=${env} apply=${apply} limit=${limit ?? '∞'} concurrency=${concurrency}`);
  console.log(`[backfill-profile-images] stack=${stackName}`);
  console.log(`[backfill-profile-images] adminTable=${adminTable}`);
  console.log(`[backfill-profile-images] mediaBucket=${mediaBucket}`);
  console.log(`[backfill-profile-images] mediaCdnUrl=${mediaCdnUrl ?? '<none>'}`);

  const s3 = new S3Client({ region });
  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region }), {
    marshallOptions: { removeUndefinedValues: true },
  });

  let scanned = 0;
  let updated = 0;
  let skippedNoLegacy = 0;
  let alreadyHasProfile = 0;

  let lastEvaluatedKey: Record<string, unknown> | undefined;

  // Simple promise pool
  const inFlight = new Set<Promise<void>>();
  const enqueue = async (fn: () => Promise<void>) => {
    const p = fn().finally(() => inFlight.delete(p));
    inFlight.add(p);
    if (inFlight.size >= concurrency) {
      await Promise.race(inFlight);
    }
  };

  const flush = async () => {
    await Promise.all([...inFlight]);
  };

  while (true) {
    const resp = await ddb.send(new ScanCommand({
      TableName: adminTable,
      FilterExpression: 'sk = :sk AND #status <> :deleted',
      ExpressionAttributeNames: {
        '#status': 'status',
      },
      ExpressionAttributeValues: {
        ':sk': 'CONFIG',
        ':deleted': 'deleted',
      },
      ExclusiveStartKey: lastEvaluatedKey,
    }));

    type AvatarConfigItem = {
      avatarId?: string;
      profileImage?: { url?: string };
    } & Record<string, unknown>;

    const items = (resp.Items ?? []) as AvatarConfigItem[];
    for (const item of items) {
      if (limit && updated >= limit) break;

      const avatarId = item.avatarId as string | undefined;
      if (!avatarId) continue;

      scanned++;

      if (item.profileImage?.url) {
        alreadyHasProfile++;
        continue;
      }

      await enqueue(async () => {
        const legacy = await listLatestLegacyProfileKey(s3, mediaBucket, avatarId);
        if (!legacy) {
          skippedNoLegacy++;
          return;
        }

        const url = buildPublicUrl(mediaCdnUrl, mediaBucket, legacy.key);

        if (!apply) {
          updated++;
          if (updated <= 10) {
            console.log(`[dry-run] avatar=${avatarId} profileImage.s3Key=${legacy.key} url=${url}`);
          }
          return;
        }

        await ddb.send(new UpdateCommand({
          TableName: adminTable,
          Key: { pk: `AVATAR#${avatarId}`, sk: 'CONFIG' },
          UpdateExpression: 'SET profileImage = :pi, updatedAt = :now, updatedBy = :by',
          ExpressionAttributeValues: {
            ':pi': {
              url,
              s3Key: legacy.key,
              updatedAt: legacy.updatedAt,
            },
            ':now': Date.now(),
            ':by': 'backfill-profile-images',
          },
        }));

        updated++;
        if (updated % 25 === 0) {
          console.log(`[apply] updated=${updated} scanned=${scanned} skippedNoLegacy=${skippedNoLegacy}`);
        }
      });
    }

    await flush();

    if (limit && updated >= limit) break;

    lastEvaluatedKey = resp.LastEvaluatedKey as Record<string, unknown> | undefined;
    if (!lastEvaluatedKey) break;
  }

  console.log('[backfill-profile-images] done');
  console.log(JSON.stringify({ env, apply, scanned, updated, skippedNoLegacy, alreadyHasProfile }, null, 2));

  if (!apply) {
    console.log('To apply changes, rerun with: --apply');
  }
}

run().catch(err => {
  console.error('[backfill-profile-images] error', err);
  process.exitCode = 1;
});
