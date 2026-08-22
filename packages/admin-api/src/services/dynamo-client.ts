/**
 * Shared DynamoDB client (admin-api).
 *
 * Injection is MANDATORY. Call `_setDynamoClient()` before any service
 * imports. In local mode this is handled by the server entry point.
 * In production this is handled by the Lambda bootstrap.
 */
export interface DynamoLikeClient {
  send(command: { constructor: { name: string }; input: unknown }): Promise<any>;
}

let _client: DynamoLikeClient | null = null;

export function getDynamoClient(): DynamoLikeClient {
  if (!_client) {
    throw new Error(
      'DynamoDB client not injected. Call _setDynamoClient() before importing any services.',
    );
  }
  return _client;
}

export function _setDynamoClient(client: DynamoLikeClient | null): void {
  _client = client;
}
