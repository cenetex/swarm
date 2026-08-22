/**
 * Shared test helper — injects stub DynamoDB + AWS clients
 * so admin-api handler tests can import service modules without
 * hitting the "DynamoDB client not injected" guard.
 *
 * Usage in test files:
 *   import { injectTestClients } from '../__test-helpers__/inject-clients.js';
 *   beforeAll(async () => { await injectTestClients(); });
 */

let injected = false;

export async function injectTestClients(): Promise<void> {
  if (injected) return;

  const { _setDynamoClient } = await import('../../services/dynamo-client.js');
  const aws = await import('../../services/aws-clients.js');
  const stub = { send: async () => ({}), config: {}, destroy: () => {} } as any;

  _setDynamoClient(stub);
  aws._setS3Client(stub);
  aws._setSQSClient(stub);
  aws._setSecretsClient(stub);
  aws._setLambdaClient(stub);

  injected = true;
}
