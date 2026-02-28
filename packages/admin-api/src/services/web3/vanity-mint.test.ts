import { describe, expect, it } from 'vitest';
import {
  createVanityMatcher,
  evaluateVanityMatch,
  getVanityMatchPosition,
  resolveVanityMintConfig,
  selectVanityCandidate,
} from './vanity-mint.js';

describe('vanity-mint', () => {
  describe('resolveVanityMintConfig', () => {
    it('returns null when config is not provided', () => {
      expect(resolveVanityMintConfig(undefined)).toBeNull();
    });

    it('applies defaults when fields are omitted', () => {
      const resolved = resolveVanityMintConfig({});
      expect(resolved).toEqual({
        pattern: 'RATi',
        mode: 'best_effort',
        maxSearchMs: 15000,
        maxAttempts: 11316496,
      });
    });

    it('rejects non-base58 patterns', () => {
      expect(() => resolveVanityMintConfig({ pattern: 'RATI' })).toThrow(
        'Vanity mint pattern must use base58 characters only'
      );
    });
  });

  describe('getVanityMatchPosition', () => {
    it('returns prefix when address starts with pattern', () => {
      expect(getVanityMatchPosition('RATiabc123', 'RATi')).toBe('prefix');
    });

    it('returns suffix when address ends with pattern', () => {
      expect(getVanityMatchPosition('abc123RATi', 'RATi')).toBe('suffix');
    });

    it('returns contains when address includes pattern internally', () => {
      expect(getVanityMatchPosition('abcRATixyz', 'RATi')).toBe('contains');
    });

    it('returns none when there is no match', () => {
      expect(getVanityMatchPosition('abcxyz123', 'RATi')).toBe('none');
    });
  });

  describe('evaluateVanityMatch', () => {
    const strictConfig = {
      pattern: 'RATi',
      mode: 'strict' as const,
      maxSearchMs: 15000,
      maxAttempts: 11316496,
    };

    const bestEffortConfig = {
      pattern: 'RATi',
      mode: 'best_effort' as const,
      maxSearchMs: 15000,
      maxAttempts: 11316496,
    };

    it('matches strict when pattern is prefix', () => {
      const match = evaluateVanityMatch('RATiabc123', strictConfig);
      expect(match).toEqual({ matched: true, position: 'prefix' });
    });

    it('matches strict when pattern is suffix', () => {
      const match = evaluateVanityMatch('abc123RATi', strictConfig);
      expect(match).toEqual({ matched: true, position: 'suffix' });
    });

    it('does not match strict when pattern is only internal', () => {
      const match = evaluateVanityMatch('abcRATixyz', strictConfig);
      expect(match).toEqual({ matched: false, position: 'contains' });
    });

    it('matches best_effort when pattern appears anywhere', () => {
      const match = evaluateVanityMatch('abcRATixyz', bestEffortConfig);
      expect(match).toEqual({ matched: true, position: 'contains' });
    });
  });

  describe('createVanityMatcher', () => {
    it('returns suffix for strict mode even if pattern also appears earlier', () => {
      const matcher = createVanityMatcher({
        pattern: 'RATi',
        mode: 'strict',
        maxSearchMs: 15000,
        maxAttempts: 11316496,
      });
      const match = matcher('fooRATibarRATi');
      expect(match).toEqual({ matched: true, position: 'suffix' });
    });
  });

  describe('selectVanityCandidate', () => {
    it('best_effort selects the most recent matching candidate', () => {
      const selected = selectVanityCandidate(
        [
          { value: 1, address: 'abc123' },
          { value: 2, address: 'abcRATixyz' },
          { value: 3, address: 'fooRATibar' },
        ],
        {
          pattern: 'RATi',
          mode: 'best_effort',
          maxSearchMs: 15000,
          maxAttempts: 11316496,
        }
      );

      expect(selected?.selected.value).toBe(3);
      expect(selected?.match.position).toBe('contains');
      expect(selected?.satisfied).toBe(true);
    });

    it('strict returns null when no prefix/suffix candidate exists', () => {
      const selected = selectVanityCandidate(
        [
          { value: 1, address: 'abcRATixyz' },
          { value: 2, address: 'fooRATibar' },
        ],
        {
          pattern: 'RATi',
          mode: 'strict',
          maxSearchMs: 15000,
          maxAttempts: 11316496,
        }
      );

      expect(selected).toBeNull();
    });
  });
});
