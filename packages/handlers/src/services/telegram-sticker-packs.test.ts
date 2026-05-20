import { describe, expect, it } from 'bun:test';
import { resolveStickerReferenceImageUrls } from './telegram-sticker-packs.js';

describe('resolveStickerReferenceImageUrls', () => {
  it('keeps reachable character references and skips unreachable profile references', async () => {
    const rejected: Array<{ kind: string; reason: string }> = [];
    const urls = await resolveStickerReferenceImageUrls({
      characterReference: { url: 'https://cdn.example.com/character.png' },
      profileImage: { url: 'https://old-cdn.example.com/profile.png' },
    }, {
      fetchImpl: async (url) => {
        if (url.includes('old-cdn')) throw new Error('getaddrinfo ENOTFOUND');
        return new Response(null, { status: 200 });
      },
      onRejected: (candidate, reason) => rejected.push({ kind: candidate.kind, reason }),
    });

    expect(urls).toEqual(['https://cdn.example.com/character.png']);
    expect(rejected).toEqual([{ kind: 'profile', reason: 'fetch_failed' }]);
  });

  it('returns no references when every configured reference is unreachable', async () => {
    const rejected: Array<{ kind: string; reason: string }> = [];
    const urls = await resolveStickerReferenceImageUrls({
      characterReference: { url: 'https://cdn.example.com/missing-character.png' },
      profileImage: { url: 'https://cdn.example.com/missing-profile.png' },
    }, {
      fetchImpl: async () => new Response(null, { status: 404 }),
      onRejected: (candidate, reason) => rejected.push({ kind: candidate.kind, reason }),
    });

    expect(urls).toEqual([]);
    expect(rejected).toEqual([
      { kind: 'character', reason: 'http_404' },
      { kind: 'profile', reason: 'http_404' },
    ]);
  });
});
