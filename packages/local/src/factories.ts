/**
 * Local service factories — wire up the local-first backends.
 */
import type { KeyValueStore } from '@swarm/core';
import { SqliteRepository } from './sqlite-repository.js';
import { LocalBlobStore } from './blob-store.js';
import { InMemoryQueue } from './queue.js';
import { LocalDynamoClientAdapter } from './dynamo-adapter.js';
import { EncryptedSecretsService } from './encrypted-secrets.js';

export interface LocalServicesOptions {
  dbPath?: string;
  blobDir?: string;
  blobBaseUrl?: string;
  tableName?: string;
}

export interface LocalServices {
  store: KeyValueStore;
  dynamoAdapter: LocalDynamoClientAdapter;
  secrets: EncryptedSecretsService;
  blobs: LocalBlobStore;
  queue: InMemoryQueue;
  shutdown: () => void;
}

export function createLocalServices(options: LocalServicesOptions = {}): LocalServices {
  const store = new SqliteRepository({
    dbPath: options.dbPath,
    tableName: options.tableName ?? 'swarm_items',
  });

  const dynamoAdapter = new LocalDynamoClientAdapter(store);

  const secrets = new EncryptedSecretsService(store);

  const blobs = new LocalBlobStore({
    rootDir: options.blobDir,
    baseUrl: options.blobBaseUrl,
  });

  const queue = new InMemoryQueue();

  return {
    store,
    dynamoAdapter,
    secrets,
    blobs,
    queue,
    shutdown: () => {
      store.close();
    },
  };
}
