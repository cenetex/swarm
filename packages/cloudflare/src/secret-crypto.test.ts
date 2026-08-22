import { describe, expect, it } from 'bun:test';
import { encodeHostedSecretKey, HostedSecretCipher, isHostedSecretKeyValid } from './secret-crypto.js';

function fixedKey(fill: number): string {
  return encodeHostedSecretKey(new Uint8Array(32).fill(fill));
}

describe('HostedSecretCipher', () => {
  it('envelope-encrypts and decrypts a user credential', async () => {
    const cipher = new HostedSecretCipher('v1', (version) => (version === 'v1' ? fixedKey(7) : null));
    const envelope = await cipher.seal('sk-user-secret', 'acct-1|tenant-1|llm-api-key');

    expect(envelope.ciphertext).not.toContain('sk-user-secret');
    expect(envelope.wrappedDataKey).not.toBe('');
    expect(envelope.keyVersion).toBe('v1');
    await expect(cipher.open(JSON.stringify(envelope), 'acct-1|tenant-1|llm-api-key')).resolves.toBe('sk-user-secret');
  });

  it('binds ciphertext to the account, tenant, and secret name', async () => {
    const cipher = new HostedSecretCipher('v1', () => fixedKey(3));
    const envelope = await cipher.seal('telegram-token', 'acct-1||telegram');

    await expect(cipher.open(JSON.stringify(envelope), 'acct-2||telegram')).rejects.toThrow(/authentication failed/i);
  });

  it('can decrypt an older key version during rotation', async () => {
    const keys: Record<string, string> = { v1: fixedKey(1), v2: fixedKey(2) };
    const oldCipher = new HostedSecretCipher('v1', (version) => keys[version] ?? null);
    const envelope = await oldCipher.seal('rotatable', 'acct-1||llm-api-key');
    const rotatedCipher = new HostedSecretCipher('v2', (version) => keys[version] ?? null);

    await expect(rotatedCipher.open(JSON.stringify(envelope), 'acct-1||llm-api-key')).resolves.toBe('rotatable');
  });

  it('rejects incorrectly sized key material', async () => {
    const cipher = new HostedSecretCipher('v1', () => encodeHostedSecretKey(new Uint8Array(16)));
    await expect(cipher.seal('secret', 'acct-1||name')).rejects.toThrow(/32 bytes/i);
  });

  it('validates key bindings before advertising encrypted-secret capability', () => {
    expect(isHostedSecretKeyValid(fixedKey(8))).toBe(true);
    expect(isHostedSecretKeyValid(encodeHostedSecretKey(new Uint8Array(16)))).toBe(false);
    expect(isHostedSecretKeyValid('not-base64url!')).toBe(false);
  });
});
