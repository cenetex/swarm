/**
 * Shared DynamoDB client (handlers). Injection is MANDATORY.
 */
export interface DynamoLikeClient {
  send(command: { constructor: { name: string }; input: unknown }): Promise<any>;
}

let _client: DynamoLikeClient | null = null;

export function getDynamoClient(): DynamoLikeClient {
  if (!_client) {
    throw new Error('DynamoDB client not injected. Call _setDynamoClient() before importing services.');
  }
  return _client;
}

export function _setDynamoClient(client: DynamoLikeClient | null): void {
  _client = client;
}
