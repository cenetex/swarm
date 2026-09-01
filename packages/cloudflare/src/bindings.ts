export type CloudflareD1Result<T = unknown> = {
  results?: T[];
  success: boolean;
  error?: string;
  meta?: Record<string, unknown>;
};

export interface CloudflareD1PreparedStatement {
  bind(...values: unknown[]): CloudflareD1PreparedStatement;
  first<T = unknown>(column?: string): Promise<T | null>;
  all<T = unknown>(): Promise<CloudflareD1Result<T>>;
  run(): Promise<CloudflareD1Result>;
}

export interface CloudflareD1Database {
  prepare(query: string): CloudflareD1PreparedStatement;
  batch?(statements: CloudflareD1PreparedStatement[]): Promise<CloudflareD1Result[]>;
}

export type CloudflareR2Object = {
  key: string;
  httpMetadata?: {
    contentType?: string;
  };
  customMetadata?: Record<string, string>;
  arrayBuffer(): Promise<ArrayBuffer>;
};

export interface CloudflareR2Bucket {
  get(key: string): Promise<CloudflareR2Object | null>;
  put(
    key: string,
    body: string | ArrayBuffer | Uint8Array,
    options?: {
      httpMetadata?: { contentType?: string };
      customMetadata?: Record<string, string>;
    },
  ): Promise<unknown>;
  delete(key: string): Promise<void>;
}

export interface CloudflareQueue<T = unknown> {
  send(message: T, options?: { delaySeconds?: number }): Promise<void>;
}

export interface CloudflareQueueMessage<T = unknown> {
  body: T;
  ack(): void;
  retry(options?: { delaySeconds?: number }): void;
}

export interface CloudflareQueueBatch<T = unknown> {
  messages: CloudflareQueueMessage<T>[];
}

export interface CloudflareDurableObjectStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
}

export interface CloudflareDurableObjectState {
  storage: CloudflareDurableObjectStorage;
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
}

export interface CloudflareDurableObjectNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(request: Request): Promise<Response> };
}

export interface CloudflareAssetFetcher {
  fetch(request: Request): Promise<Response>;
}

export type CloudflareHostedBindings = {
  SWARM_STATE: CloudflareD1Database;
  SWARM_BLOBS: CloudflareR2Bucket;
  SWARM_QUEUE?: CloudflareQueue;
  SWARM_AVATAR_COORDINATORS?: CloudflareDurableObjectNamespace;
  SWARM_ASSETS?: CloudflareAssetFetcher;
  SWARM_ENV?: string;
  SWARM_HOSTED_ENABLED?: string;
  SWARM_PUBLIC_URL?: string;
  SWARM_PASSKEY_RP_ID?: string;
  SWARM_SOLANA_CHAIN_ID?: string;
  SWARM_USER_SECRET_KEK?: string;
  SWARM_USER_SECRET_KEY_VERSION?: string;
  SWARM_OPENROUTER_RETURN_PATH?: string;
  SWARM_OPENROUTER_CHAT_URL?: string;
  SWARM_OPENROUTER_MODEL?: string;
  SWARM_HOSTED_CHAT_RATE_LIMIT?: string;
  SWARM_X_API_KEY?: string;
  SWARM_X_API_SECRET?: string;
  SWARM_X_RETURN_PATH?: string;
  [binding: string]: unknown;
};
