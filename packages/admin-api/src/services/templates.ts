/**
 * Avatar Templates Service - Import/Export avatar configurations
 */
import {
  PutCommand,
  GetCommand,
  ScanCommand,
} from '@swarm/core';
import type { AvatarRecord, UserSession } from '../types.js';
import * as avatarsDefault from './avatars.js';
import { getDynamoClient } from './dynamo-client.js';

/**
 * Dependencies interface for template service (for testing)
 */
export interface TemplateServiceDeps {
  dynamoClient: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    send: (command: any) => Promise<any>;
  };
  avatarService: {
    createAvatar: (name: string, session: UserSession, description?: string) => Promise<AvatarRecord>;
  };
  tableName: string;
}

// Default dependencies
const defaultDynamoClient = getDynamoClient();
const ADMIN_TABLE = process.env.ADMIN_TABLE!;

const defaultDeps: TemplateServiceDeps = {
  dynamoClient: defaultDynamoClient,
  avatarService: avatarsDefault,
  tableName: ADMIN_TABLE,
};

export interface AvatarTemplate {
  templateId: string;
  name: string;
  description: string;
  config: Partial<AvatarRecord>;
  createdAt: number;
}

/**
 * List all available avatar templates
 */
export async function listTemplates(deps: TemplateServiceDeps = defaultDeps): Promise<AvatarTemplate[]> {
  const result = await deps.dynamoClient.send(new ScanCommand({
    TableName: deps.tableName,
    FilterExpression: 'sk = :sk',
    ExpressionAttributeValues: {
      ':sk': 'TEMPLATE',
    },
  })) as { Items?: AvatarTemplate[] };

  return result.Items || [];
}

/**
 * Get a template by ID
 */
export async function getTemplate(templateId: string, deps: TemplateServiceDeps = defaultDeps): Promise<AvatarTemplate | null> {
  const result = await deps.dynamoClient.send(new GetCommand({
    TableName: deps.tableName,
    Key: {
      pk: `TEMPLATE#${templateId}`,
      sk: 'TEMPLATE',
    },
  })) as { Item?: AvatarTemplate };

  return result.Item || null;
}

/**
 * Export an existing avatar as a template
 */
export async function exportAvatarAsTemplate(
  avatar: AvatarRecord,
  templateName: string,
  description: string,
  deps: TemplateServiceDeps = defaultDeps
): Promise<AvatarTemplate> {
  const templateId = `tpl-${avatar.avatarId}-${Date.now().toString(36)}`;

  const template: AvatarTemplate = {
    templateId,
    name: templateName,
    description,
    config: {
      name: avatar.name,
      description: avatar.description,
      persona: avatar.persona,
      platforms: avatar.platforms,
      llmConfig: avatar.llmConfig,
      voiceConfig: avatar.voiceConfig,
      mediaConfig: avatar.mediaConfig,
    },
    createdAt: Date.now(),
  };

  await deps.dynamoClient.send(new PutCommand({
    TableName: deps.tableName,
    Item: {
      pk: `TEMPLATE#${templateId}`,
      sk: 'TEMPLATE',
      ...template,
    },
  }));

  return template;
}

/**
 * Create a new avatar from a template
 */
export async function createAvatarFromTemplate(
  templateId: string,
  session: UserSession,
  avatarName?: string,
  deps: TemplateServiceDeps = defaultDeps
): Promise<AvatarRecord> {
  const template = await getTemplate(templateId, deps);
  if (!template) {
    throw new Error(`Template not found: ${templateId}`);
  }

  const name = avatarName || template.name;
  const avatar = await deps.avatarService.createAvatar(name, session, template.description);

  // Update with template config
  // Note: we don't overwrite ID, status, timestamps etc.
  const { name: _, description: __, ...configToApply } = template.config;

  // We can't use updateAvatar directly because it requires a session
  // But we have createAvatar which already saved it.
  // To keep it simple, we'll just merge the template config into the new avatar.

  const mergedAvatar: AvatarRecord = {
    ...avatar,
    ...configToApply,
    name, // Restore name if overwritten by configToApply accidentally
    updatedAt: Date.now(),
  };

  await deps.dynamoClient.send(new PutCommand({
    TableName: deps.tableName,
    Item: mergedAvatar,
  }));

  return mergedAvatar;
}
