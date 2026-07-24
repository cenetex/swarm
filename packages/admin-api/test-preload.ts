// Test environment setup - preloaded before test files.
import { beforeEach } from 'bun:test';

process.env.ADMIN_TABLE = process.env.ADMIN_TABLE || 'test-admin-table';
process.env.STATE_TABLE = process.env.STATE_TABLE || 'test-state-table';
process.env.MEDIA_BUCKET = process.env.MEDIA_BUCKET || 'test-media-bucket';
process.env.LLM_API_KEY_SECRET_ARN = process.env.LLM_API_KEY_SECRET_ARN || 'test/llm-api-key';

const stub = {
  config: {},
  destroy: () => {},
  send: async (command: { constructor?: { name?: string }; input?: Record<string, unknown> }) => {
    const name = command.constructor?.name ?? '';
    if (name.startsWith('GetSecretValue')) {
      return { SecretString: 'test-secret' };
    }
    if (name.startsWith('GetQueueAttributes')) {
      return {
        Attributes: {
          ApproximateNumberOfMessages: '0',
          ApproximateNumberOfMessagesNotVisible: '0',
        },
      };
    }
    return {};
  },
};

const { _setDynamoClient } = await import('./src/services/dynamo-client.js');
const aws = await import('./src/services/aws-clients.js');

function injectDefaultClients(): void {
  _setDynamoClient(stub);
  aws._setS3Client(stub);
  aws._setSQSClient(stub);
  aws._setSecretsClient(stub);
  aws._setLambdaClient(stub);
}

injectDefaultClients();
beforeEach(() => {
  injectDefaultClients();
});
