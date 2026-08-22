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

export interface CloudflareDurableObjectNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(request: Request): Promise<Response> };
}

export type CloudflareHostedBindings = {
  SWARM_STATE: CloudflareD1Database;
  SWARM_BLOBS: CloudflareR2Bucket;
  SWARM_QUEUE?: CloudflareQueue;
  SWARM_AVATAR_COORDINATORS?: CloudflareDurableObjectNamespace;
  SWARM_ENV?: string;
  [binding: string]: unknown;
};
