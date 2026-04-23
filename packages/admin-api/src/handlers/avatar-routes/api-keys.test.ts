/**
 * Tests for api-keys route-matching regexes.
 *
 * The DynamoDB/ownership paths are covered by integration tests; these unit
 * tests guard the URL shapes the handler claims to own so typo regressions
 * surface immediately.
 */
import { describe, test, expect } from 'bun:test';

const LIST_OR_CREATE_RE = /^\/avatars\/([^/]+)\/api-keys$/;
const REVOKE_RE = /^\/avatars\/([^/]+)\/api-keys\/([^/]+)$/;
const TOOL_RESUME_RE = /^\/avatars\/([^/]+)\/tools\/([^/]+)$/;
const KEY_USAGE_RE = /^\/api-keys\/([^/]+)\/usage\/tokens$/;

describe('api-keys path matching', () => {
  test('list/create path captures avatarId', () => {
    const m = '/avatars/chamuel/api-keys'.match(LIST_OR_CREATE_RE);
    expect(m?.[1]).toBe('chamuel');
  });

  test('list/create path rejects nested segments', () => {
    expect('/avatars/chamuel/api-keys/sk-rati-abc'.match(LIST_OR_CREATE_RE)).toBeNull();
    expect('/avatars/chamuel/api-keys/'.match(LIST_OR_CREATE_RE)).toBeNull();
  });

  test('revoke path captures avatarId + keyPrefix', () => {
    const m = '/avatars/chamuel/api-keys/sk-rati-abc12'.match(REVOKE_RE);
    expect(m?.[1]).toBe('chamuel');
    expect(m?.[2]).toBe('sk-rati-abc12');
  });

  test('revoke path rejects an empty keyPrefix', () => {
    expect('/avatars/chamuel/api-keys/'.match(REVOKE_RE)).toBeNull();
  });

  test('tool resume and api-keys shapes do not collide', () => {
    // Same avatar segment, different second segment — must match distinct regexes.
    expect('/avatars/chamuel/tools/tc-123'.match(TOOL_RESUME_RE)?.[2]).toBe('tc-123');
    expect('/avatars/chamuel/tools/tc-123'.match(REVOKE_RE)).toBeNull();
    expect('/avatars/chamuel/api-keys/sk-rati-x'.match(TOOL_RESUME_RE)).toBeNull();
  });

  test('key usage path captures keyHash', () => {
    const m = '/api-keys/abc123deadbeef/usage/tokens'.match(KEY_USAGE_RE);
    expect(m?.[1]).toBe('abc123deadbeef');
  });
});
