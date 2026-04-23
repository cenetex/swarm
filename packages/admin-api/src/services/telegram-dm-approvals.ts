/**
 * Telegram DM Approvals Service
 *
 * Singleton wrapper around the DM approval store (#1473). Admin-api uses
 * this to list pending approvals and manage the blocklist from the
 * read-only dashboard (#1474).
 */
import { createTelegramDmApprovalStore } from '@swarm/core';
import { getDynamoClient } from './dynamo-client.js';

const dynamoClient = getDynamoClient();
const ADMIN_TABLE = process.env.ADMIN_TABLE!;

const store = createTelegramDmApprovalStore({
  dynamoClient,
  tableName: ADMIN_TABLE,
});

export const createPendingDm = store.createPendingDm;
export const getPendingDm = store.getPendingDm;
export const deletePendingDm = store.deletePendingDm;
export const listPending = store.listPending;
export const addBlocked = store.addBlocked;
export const isBlocked = store.isBlocked;
export const removeBlocked = store.removeBlocked;

export type { PendingDmRecord, BlockedRecord } from '@swarm/core';
