/**
 * Tests for avatar-scoped key model defaulting.
 *
 * Exercises the real `resolveModel` + `parseAvatarId` helpers from
 * `openai-compat.ts` so schema drift or behavior regressions are caught.
 */
import { describe, test, expect } from 'bun:test';
import { parseAvatarId, resolveModel } from './openai-compat.js';

describe('parseAvatarId', () => {
  test('extracts avatar ID from avatar: format', () => {
    expect(parseAvatarId('avatar:test-bot')).toBe('test-bot');
    expect(parseAvatarId('avatar:my-avatar-123')).toBe('my-avatar-123');
  });

  test('treats bare string as avatar ID', () => {
    expect(parseAvatarId('test-bot')).toBe('test-bot');
    expect(parseAvatarId('my-avatar-123')).toBe('my-avatar-123');
  });
});

describe('resolveModel', () => {
  test('scoped key + no model → defaults to avatar:{avatarId}', () => {
    const result = resolveModel(undefined, { avatarId: 'chamuel' });
    expect(result).toEqual({ model: 'avatar:chamuel' });
  });

  test('scoped key + empty string model → defaults to avatar:{avatarId}', () => {
    // Empty string is falsy — treat the same as missing so callers don't
    // accidentally parse an empty avatarId.
    const result = resolveModel('', { avatarId: 'chamuel' });
    expect(result).toEqual({ model: 'avatar:chamuel' });
  });

  test('scoped key + matching explicit model → preserves the request model', () => {
    const result = resolveModel('avatar:chamuel', { avatarId: 'chamuel' });
    expect(result).toEqual({ model: 'avatar:chamuel' });
  });

  test('scoped key + mismatched model → preserves caller model (mismatch enforced downstream)', () => {
    // resolveModel does not enforce scope; the handler compares
    // parseAvatarId(resolved.model) against validation.avatarId and returns 403.
    const resolved = resolveModel('avatar:other', { avatarId: 'chamuel' });
    expect(resolved).toEqual({ model: 'avatar:other' });
    if (!('error' in resolved)) {
      expect(parseAvatarId(resolved.model)).toBe('other');
    }
  });

  test('wildcard key + no model → error', () => {
    const result = resolveModel(undefined, {});
    expect(result).toEqual({
      error: 'model parameter is required for wildcard API keys',
    });
  });

  test('wildcard key + explicit model → preserves the request model', () => {
    const result = resolveModel('avatar:anything', {});
    expect(result).toEqual({ model: 'avatar:anything' });
  });
});
