import { DynamoDBClient, GetItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';

const tableNames = {
  prod: 'SwarmAdmin-prod',
  staging: 'SwarmAdmin-staging',
  dev: 'SwarmAdmin-dev',
};

async function main() {
  const [env = 'prod', avatarId, model = 'google/gemini-2.0-flash-001'] = process.argv.slice(2);
  if (!avatarId) {
    console.error('Usage: node scripts/reset-avatar-model.mjs <env> <avatarId> [model]');
    process.exit(1);
  }

  const tableName = tableNames[env];
  if (!tableName) {
    console.error(`Unknown environment: ${env}`);
    process.exit(1);
  }

  const region = process.env.AWS_REGION || 'us-east-1';
  const client = new DynamoDBClient({ region });

  const key = {
    pk: { S: `AVATAR#${avatarId}` },
    sk: { S: 'CONFIG' },
  };

  const getResult = await client.send(
    new GetItemCommand({
      TableName: tableName,
      Key: key,
      ProjectionExpression: 'avatarId, llmConfig',
    }),
  );

  console.log('Current avatar model:', getResult.Item?.llmConfig?.M?.model?.S ?? 'n/a');

  await client.send(
    new UpdateItemCommand({
      TableName: tableName,
      Key: key,
      UpdateExpression: 'SET llmConfig.model = :model',
      ExpressionAttributeValues: {
        ':model': { S: model },
      },
    }),
  );

  console.log(`Updated avatar ${avatarId} model -> ${model}`);
}

main().catch((error) => {
  console.error('Failed to reset avatar model', error);
  process.exit(1);
});
