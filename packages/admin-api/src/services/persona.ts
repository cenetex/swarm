/**
 * Shared persona preview and update workflow.
 *
 * Direct HTTP edits and conversational tool edits use this service so persona
 * locks, normalization, preview metadata, and audit records stay consistent.
 */
import { createHash } from 'crypto';
import {
  buildDynamicSystemPrompt,
  logger,
  type ProcessorAvatarConfig,
} from '@swarm/core';
import type { UserSession } from '../types.js';
import type { AvatarRecord } from '../types/avatar.js';
import * as avatarService from './avatars.js';
import * as auditLogService from './audit-log.js';
import type { ActorType } from './audit-log.js';

export class PersonaValidationError extends Error {
  override name = 'PersonaValidationError';
}

export class PersonaNotFoundError extends Error {
  override name = 'PersonaNotFoundError';
}

export class PersonaLockedError extends Error {
  override name = 'PersonaLockedError';
}

export interface PersonaPreview {
  systemPrompt: string;
  diff: {
    added: string[];
    removed: string[];
  };
  tokenDelta: number;
  preview: {
    oldLength: number;
    newLength: number;
    oldTokens: number;
    newTokens: number;
  };
}

export interface PersonaUpdateResult {
  avatarId: string;
  name: string;
  persona: string;
  updatedAt: number;
  updatedBy?: string;
  tokenDelta: number;
}

export interface PersonaServiceDeps {
  getAvatar: typeof avatarService.getAvatar;
  updateAvatar: typeof avatarService.updateAvatar;
  recordAuditEvent: typeof auditLogService.recordAuditEvent;
}

const defaultDeps: PersonaServiceDeps = {
  getAvatar: avatarService.getAvatar,
  updateAvatar: avatarService.updateAvatar,
  recordAuditEvent: auditLogService.recordAuditEvent,
};

function normalizePersona(persona: unknown): string {
  if (typeof persona !== 'string' || persona.trim().length === 0) {
    throw new PersonaValidationError('persona must be a non-empty string');
  }
  return persona.trim();
}

function hashPersona(persona: string): string {
  return createHash('sha256').update(persona).digest('hex');
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function computePersonaDiff(oldPersona: string, newPersona: string): PersonaPreview['diff'] {
  const oldLines = oldPersona.trim().split('\n').filter((line) => line.trim().length > 0);
  const newLines = newPersona.trim().split('\n').filter((line) => line.trim().length > 0);
  const oldSet = new Set(oldLines);
  const newSet = new Set(newLines);

  return {
    added: newLines.filter((line) => !oldSet.has(line)),
    removed: oldLines.filter((line) => !newSet.has(line)),
  };
}

export function previewPersonaChange(
  avatar: Pick<AvatarRecord, 'avatarId' | 'name' | 'description' | 'persona'>,
  persona: unknown,
): PersonaPreview {
  const newPersona = normalizePersona(persona);
  const oldPersona = avatar.persona || '';
  const oldTokens = estimateTokens(oldPersona);
  const newTokens = estimateTokens(newPersona);
  const config: ProcessorAvatarConfig = {
    avatarId: avatar.avatarId,
    name: avatar.name,
    description: avatar.description,
    persona: newPersona,
    enabledCategories: [],
  };

  return {
    systemPrompt: buildDynamicSystemPrompt(config, 'admin-ui'),
    diff: computePersonaDiff(oldPersona, newPersona),
    tokenDelta: newTokens - oldTokens,
    preview: {
      oldLength: oldPersona.length,
      newLength: newPersona.length,
      oldTokens,
      newTokens,
    },
  };
}

export async function updatePersona(
  params: {
    avatarId: string;
    persona: unknown;
    session: UserSession;
    actorId: string;
    actorType: ActorType;
  },
  deps: PersonaServiceDeps = defaultDeps,
): Promise<PersonaUpdateResult> {
  const newPersona = normalizePersona(params.persona);
  const avatar = await deps.getAvatar(params.avatarId);
  if (!avatar) {
    throw new PersonaNotFoundError(`Avatar not found: ${params.avatarId}`);
  }
  if (avatar.isAscended) {
    throw new PersonaLockedError('Cannot update persona of ascended avatar - it is permanently locked');
  }

  const oldPersona = avatar.persona || '';
  const oldTokens = estimateTokens(oldPersona);
  const newTokens = estimateTokens(newPersona);
  const tokenDelta = newTokens - oldTokens;
  const updated = await deps.updateAvatar(
    params.avatarId,
    { persona: newPersona },
    params.session,
  );

  try {
    await deps.recordAuditEvent({
      avatarId: params.avatarId,
      eventType: 'persona_updated',
      actorId: params.actorId,
      actorType: params.actorType,
      details: {
        oldHash: hashPersona(oldPersona),
        newHash: hashPersona(newPersona),
        oldLength: oldPersona.length,
        newLength: newPersona.length,
        oldTokens,
        newTokens,
        tokenDelta,
      },
    });
  } catch (error) {
    logger.warn('Failed to record persona_updated audit event', {
      avatarId: params.avatarId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return {
    avatarId: updated.avatarId,
    name: updated.name,
    persona: updated.persona || newPersona,
    updatedAt: updated.updatedAt,
    updatedBy: updated.updatedBy,
    tokenDelta,
  };
}
