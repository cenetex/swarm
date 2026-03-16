/**
 * Pending Tools Service
 *
 * Singleton wrapper around the pending tool store.
 */
import { createPendingToolStore } from './pending-tool-store.js';
import { getDynamoClient } from './dynamo-client.js';

const dynamoClient = getDynamoClient();
const ADMIN_TABLE = process.env.ADMIN_TABLE!;

const store = createPendingToolStore({
  dynamoClient,
  tableName: ADMIN_TABLE,
});

export const savePendingTool = store.save;
export const getPendingTool = store.get;
export const removePendingTool = store.remove;
