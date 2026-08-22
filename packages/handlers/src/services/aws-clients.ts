/**
 * Shared AWS clients with mandatory injection (handlers).
 */
export interface S3LikeClient {
  send(command: { constructor: { name: string }; input: Record<string, unknown> }): Promise<any>;
}
export interface SQSLikeClient {
  send(command: { constructor: { name: string }; input: Record<string, unknown> }): Promise<any>;
  destroy?: () => void;
}
export interface SecretsLikeClient {
  send(command: { constructor: { name: string }; input: Record<string, unknown> }): Promise<any>;
}
export interface LambdaLikeClient {
  send(command: { constructor: { name: string }; input: Record<string, unknown> }): Promise<any>;
}

let _s3: S3LikeClient | null = null;
let _sqs: SQSLikeClient | null = null;
let _secrets: SecretsLikeClient | null = null;
let _lambda: LambdaLikeClient | null = null;

function requireClient<T>(client: T | null, name: string): T {
  if (!client) throw new Error(`${name} not injected. Call _set${name}() before importing services.`);
  return client;
}

export function getS3Client(): S3LikeClient { return requireClient(_s3, 'S3Client'); }
export function _setS3Client(c: S3LikeClient | null): void { _s3 = c; }
export function getSQSClient(): SQSLikeClient { return requireClient(_sqs, 'SQSClient'); }
export function _setSQSClient(c: SQSLikeClient | null): void { _sqs = c; }
export function getSecretsClient(): SecretsLikeClient { return requireClient(_secrets, 'SecretsClient'); }
export function _setSecretsClient(c: SecretsLikeClient | null): void { _secrets = c; }
export function getLambdaClient(): LambdaLikeClient { return requireClient(_lambda, 'LambdaClient'); }
export function _setLambdaClient(c: LambdaLikeClient | null): void { _lambda = c; }
