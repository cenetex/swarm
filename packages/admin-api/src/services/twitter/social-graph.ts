/**
 * Twitter Social Graph Adapter
 *
 * Adapts the core TwitterSocialGraphService for use in admin-api.
 * Provides access to social graph operations via the service container.
 */
import { TwitterSocialGraphService } from '@swarm/core';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

export function createTwitterSocialGraphService(
  docClient: DynamoDBDocumentClient,
  tableName: string
): TwitterSocialGraphService {
  return new TwitterSocialGraphService(docClient, tableName);
}

export type TwitterSocialGraphServiceType = TwitterSocialGraphService;
