/**
 * EncryptedSecretsService tests.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import { SqliteRepository } from './sqlite-repository.js';
import { EncryptedSecretsService } from './encrypted-secrets.js';

describe('EncryptedSecretsService', () => {
  let store: SqliteRepository;
  let secrets: EncryptedSecretsService;

  beforeEach(async () => {
    store = new SqliteRepository({ dbPath: ':memory:', tableName: 'test_secrets' });
    secrets = new EncryptedSecretsService(store);
  });

  it('is locked initially', () => {
    expect(secrets.isUnlocked).toBe(false);
  });

  it('throws when locked', async () => {
    await expect(secrets.getSecret('test')).rejects.toThrow('locked');
  });

  it('initializes and unlocks', async () => {
    await secrets.initialize('my-admin-password');
    expect(secrets.isUnlocked).toBe(true);
  });

  it('cannot initialize twice', async () => {
    await secrets.initialize('pass1');
    await expect(secrets.initialize('pass2')).rejects.toThrow('already initialized');
  });

  it('unlocks with correct password after initialize', async () => {
    await secrets.initialize('correct-horse-battery-staple');

    // Simulate new process — create fresh instance against same store
    const fresh = new EncryptedSecretsService(store);
    await fresh.unlock('correct-horse-battery-staple');
    expect(fresh.isUnlocked).toBe(true);
  });

  it('rejects wrong password on unlock', async () => {
    await secrets.initialize('right-password');

    const fresh = new EncryptedSecretsService(store);
    await expect(fresh.unlock('wrong-password')).rejects.toThrow('Invalid admin password');
  });

  it('stores and retrieves a secret', async () => {
    await secrets.initialize('admin123');
    await secrets.setSecret('OPENAI_API_KEY', 'sk-test-123');
    await secrets.flush();

    // Fresh instance
    const fresh = new EncryptedSecretsService(store);
    await fresh.unlock('admin123');

    const value = await fresh.getSecret('OPENAI_API_KEY');
    expect(value).toBe('sk-test-123');
  });

  it('stores and retrieves JSON secrets', async () => {
    await secrets.initialize('admin123');
    await secrets.setSecret('twitter_creds', JSON.stringify({ key: 'abc', secret: 'xyz' }));
    await secrets.flush();

    const fresh = new EncryptedSecretsService(store);
    await fresh.unlock('admin123');

    const creds = await fresh.getSecretJson<{ key: string; secret: string }>('twitter_creds');
    expect(creds.key).toBe('abc');
    expect(creds.secret).toBe('xyz');
  });

  it('returns 404-style error for missing secret', async () => {
    await secrets.initialize('admin123');
    await expect(secrets.getSecret('nonexistent')).rejects.toThrow('not found');
  });

  it('deletes a secret', async () => {
    await secrets.initialize('admin123');
    await secrets.setSecret('TEMP_KEY', 'temp');
    await secrets.flush();
    await secrets.deleteSecret('TEMP_KEY');
    await secrets.flush();

    const fresh = new EncryptedSecretsService(store);
    await fresh.unlock('admin123');
    await expect(fresh.getSecret('TEMP_KEY')).rejects.toThrow('not found');
  });

  it('lists all secret names', async () => {
    await secrets.initialize('admin123');
    await secrets.setSecret('A', '1');
    await secrets.setSecret('B', '2');
    await secrets.flush();

    const names = await secrets.listSecrets();
    expect(names.sort()).toEqual(['A', 'B']);
  });

  it('data is encrypted at rest', async () => {
    await secrets.initialize('admin123');
    await secrets.setSecret('KEY', 'super-secret-value');
    await secrets.flush();

    // Read raw data from store — should not contain plaintext
    const raw = await store.get<Record<string, unknown>>({ pk: 'SYSTEM', sk: 'SECRETS_DATA' });
    expect(raw).not.toBeNull();
    const rawStr = JSON.stringify(raw);
    expect(rawStr).not.toContain('super-secret-value');
    expect(rawStr).toContain('iv');
    expect(rawStr).toContain('ciphertext');
    expect(rawStr).toContain('tag');
  });

  it('password is never stored (only salt + hash)', async () => {
    await secrets.initialize('my-secret-password');

    const verify = await store.get<Record<string, unknown>>({ pk: 'SYSTEM', sk: 'SECRETS_VERIFY' });
    expect(verify).not.toBeNull();
    const verifyStr = JSON.stringify(verify);
    expect(verifyStr).not.toContain('my-secret-password');
    expect(verifyStr).toContain('salt');
    expect(verifyStr).toContain('hash');
  });
});
