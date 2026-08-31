import { beforeAll, describe, expect, it } from 'vitest';
import { injectTestClients } from '../handlers/__test-helpers__/inject-clients.js';
import type { AvatarRecord } from '../types/avatar.js';
import type { UserSession } from '../types/common.js';
import type { PersonaServiceDeps } from './persona.js';

let PersonaLockedError: typeof import('./persona.js')['PersonaLockedError'];
let PersonaNotFoundError: typeof import('./persona.js')['PersonaNotFoundError'];
let previewPersonaChange: typeof import('./persona.js')['previewPersonaChange'];
let updatePersona: typeof import('./persona.js')['updatePersona'];

beforeAll(async () => {
  await injectTestClients();
  const persona = await import('./persona.js');
  PersonaLockedError = persona.PersonaLockedError;
  PersonaNotFoundError = persona.PersonaNotFoundError;
  previewPersonaChange = persona.previewPersonaChange;
  updatePersona = persona.updatePersona;
});

const session: UserSession = {
  email: 'owner@example.com',
  userId: 'user-1',
  isAdmin: false,
  accessToken: 'test-token',
};

const avatar = {
  avatarId: 'avatar-1',
  name: 'Opus',
  persona: 'Old voice\nCareful and formal',
  isAscended: false,
  createdAt: 1,
  updatedAt: 1,
} as AvatarRecord;

function makeDeps(overrides: Partial<PersonaServiceDeps> = {}) {
  const auditCalls: Array<Record<string, unknown>> = [];
  const deps: PersonaServiceDeps = {
    getAvatar: async () => avatar,
    updateAvatar: async (_avatarId, updates) => ({
      ...avatar,
      ...updates,
      updatedAt: 2,
      updatedBy: session.email,
    }),
    recordAuditEvent: async (params) => {
      auditCalls.push(params);
      return {
        id: 'audit-1',
        ...params,
        timestamp: 2,
      };
    },
    ...overrides,
  };
  return { deps, auditCalls };
}

describe('persona service', () => {
  it('previews line and token changes without writing', () => {
    const result = previewPersonaChange(avatar, 'Old voice\nWarm and playful');

    expect(result.diff.added).toEqual(['Warm and playful']);
    expect(result.diff.removed).toEqual(['Careful and formal']);
    expect(result.preview.oldLength).toBe(avatar.persona?.length);
    expect(result.preview.newLength).toBe('Old voice\nWarm and playful'.length);
    expect(result.systemPrompt).toContain('Warm and playful');
  });

  it('updates a persona and audits hashes without storing persona text', async () => {
    const { deps, auditCalls } = makeDeps();

    const result = await updatePersona({
      avatarId: avatar.avatarId,
      persona: '  New voice\nWarm and playful  ',
      session,
      actorId: session.email,
      actorType: 'owner',
    }, deps);

    expect(result.persona).toBe('New voice\nWarm and playful');
    expect(auditCalls).toHaveLength(1);
    const auditJson = JSON.stringify(auditCalls[0]);
    expect(auditJson).not.toContain('Old voice');
    expect(auditJson).not.toContain('New voice');
    const details = auditCalls[0].details as Record<string, unknown>;
    expect(details.oldHash).toMatch(/^[a-f0-9]{64}$/);
    expect(details.newHash).toMatch(/^[a-f0-9]{64}$/);
    expect(details.tokenDelta).toBe(result.tokenDelta);
  });

  it('rejects updates for ascended avatars', async () => {
    const { deps } = makeDeps({
      getAvatar: async () => ({ ...avatar, isAscended: true }),
    });

    await expect(updatePersona({
      avatarId: avatar.avatarId,
      persona: 'New persona',
      session,
      actorId: session.email,
      actorType: 'owner',
    }, deps)).rejects.toBeInstanceOf(PersonaLockedError);
  });

  it('rejects updates when the avatar does not exist', async () => {
    const { deps } = makeDeps({ getAvatar: async () => null });

    await expect(updatePersona({
      avatarId: 'missing',
      persona: 'New persona',
      session,
      actorId: session.email,
      actorType: 'owner',
    }, deps)).rejects.toBeInstanceOf(PersonaNotFoundError);
  });
});
