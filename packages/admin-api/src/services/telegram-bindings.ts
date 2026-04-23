/**
 * Telegram Bindings Service
 *
 * Singleton wrapper around the telegram-binding store (#1471). The store
 * implementation lives in `@swarm/core` so `@swarm/handlers` can share it
 * from the webhook side without depending on admin-api.
 */
import { createTelegramBindingStore } from '@swarm/core';
import { getDynamoClient } from './dynamo-client.js';

const dynamoClient = getDynamoClient();
const ADMIN_TABLE = process.env.ADMIN_TABLE!;

const store = createTelegramBindingStore({
  dynamoClient,
  tableName: ADMIN_TABLE,
});

export const issueBindCode = store.issueBindCode;
export const consumeBindCode = store.consumeBindCode;
export const getOwnerBinding = store.getOwnerBinding;
export const deleteOwnerBinding = store.deleteOwnerBinding;

export type { OwnerBindingRecord, BindCodeRecord } from '@swarm/core';
