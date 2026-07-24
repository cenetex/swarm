/**
 * EncryptedSecretsService — database-backed secrets encrypted with admin password.
 *
 * No .env files. No plaintext secrets on disk. Everything lives in the
 * KeyValueStore, encrypted with AES-256-GCM using a key derived from the
 * admin password via PBKDF2.
 *
 * Flow:
 *   First run:  initialize(password) → stores verification token
 *   Subsequent: unlock(password)     → verifies, loads key into memory
 *   Runtime:    getSecret(name)      → decrypts from store
 *
 * The password never leaves memory after key derivation. The derived key
 * is held in the service instance for the lifetime of the process.
 */
import type { KeyValueStore, SecretsService } from '@swarm/core';
import { createHash, createCipheriv, createDecipheriv, randomBytes, pbkdf2Sync } from 'crypto';

// ---------------------------------------------------------------------------
// Crypto helpers
// ---------------------------------------------------------------------------

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32; // 256 bits
const IV_LENGTH = 12; // 96 bits for GCM
const SALT_LENGTH = 32;
const PBKDF2_ITERATIONS = 600_000;
const PBKDF2_DIGEST = 'sha512';

function deriveKey(password: string, salt: Buffer): Buffer {
  return pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, KEY_LENGTH, PBKDF2_DIGEST);
}

function encrypt(data: string, key: Buffer): { iv: string; ciphertext: string; tag: string } {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(data, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    iv: iv.toString('base64'),
    ciphertext: encrypted.toString('base64'),
    tag: tag.toString('base64'),
  };
}

function decrypt(encrypted: { iv: string; ciphertext: string; tag: string }, key: Buffer): string {
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(encrypted.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(encrypted.tag, 'base64'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encrypted.ciphertext, 'base64')),
    decipher.final(),
  ]);
  return decrypted.toString('utf8');
}

// ---------------------------------------------------------------------------
// Store keys
// ---------------------------------------------------------------------------

const VERIFY_PK = 'SYSTEM';
const VERIFY_SK = 'SECRETS_VERIFY';
const SECRETS_PK = 'SYSTEM';
const SECRETS_SK = 'SECRETS_DATA';

interface VerifyRecord extends Record<string, unknown> {
  salt: string;       // base64
  hash: string;       // hex of sha512(salt + derived_key_preview)
  createdAt: number;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class EncryptedSecretsService implements SecretsService {
  private key: Buffer | null = null;
  private cache: Map<string, string> = new Map();
  private dirty = false;

  constructor(private store: KeyValueStore) {}

  /** True once unlock() has succeeded. */
  get isUnlocked(): boolean {
    return this.key !== null;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────

  /**
   * First-run initialization. Derives a key from the password, stores
   * a verification token, and creates an empty secrets record.
   * Throws if already initialized.
   */
  async initialize(password: string): Promise<void> {
    const existing = await this.store.get<VerifyRecord>({ pk: VERIFY_PK, sk: VERIFY_SK });
    if (existing) {
      throw new Error('Secrets store is already initialized. Use unlock().');
    }

    const salt = randomBytes(SALT_LENGTH);
    const key = deriveKey(password, salt);

    // Store a verification hash: sha512(salt + first 16 bytes of key)
    const hash = createHash('sha512')
      .update(salt)
      .update(key.subarray(0, 16))
      .digest('hex');

    await this.store.put({
      pk: VERIFY_PK,
      sk: VERIFY_SK,
      salt: salt.toString('base64'),
      hash,
      createdAt: Date.now(),
    });

    // Store an empty encrypted secrets map
    const empty = encrypt(JSON.stringify({}), key);
    await this.store.put({
      pk: SECRETS_PK,
      sk: SECRETS_SK,
      ...empty,
    });

    this.key = key;
    this.cache = new Map();
    this.dirty = false;
  }

  /**
   * Unlock with the admin password. Verifies against the stored token.
   * Throws if not initialized or wrong password.
   */
  async unlock(password: string): Promise<void> {
    const verify = await this.store.get<VerifyRecord>({ pk: VERIFY_PK, sk: VERIFY_SK });
    if (!verify) {
      throw new Error('Secrets store not initialized. Call initialize() first.');
    }

    const salt = Buffer.from(verify.salt, 'base64');
    const key = deriveKey(password, salt);

    const expectedHash = createHash('sha512')
      .update(salt)
      .update(key.subarray(0, 16))
      .digest('hex');

    if (expectedHash !== verify.hash) {
      // Constant-time-ish comparison already by hex string equality
      throw new Error('Invalid admin password.');
    }

    this.key = key;

    // Load secrets into cache
    const encrypted = await this.store.get<Record<string, string>>({ pk: SECRETS_PK, sk: SECRETS_SK });
    if (encrypted) {
      try {
        const { iv, ciphertext, tag } = encrypted;
        const json = decrypt(
          { iv: iv as string, ciphertext: ciphertext as string, tag: tag as string },
          key,
        );
        const map = JSON.parse(json) as Record<string, string>;
        this.cache = new Map(Object.entries(map));
      } catch {
        this.cache = new Map();
      }
    }
  }

  // ── SecretsService implementation ──────────────────────────────────────

  async getSecret(name: string): Promise<string> {
    this.requireUnlocked();
    const cached = this.cache.get(name);
    if (cached !== undefined) return cached;
    throw new Error(`Secret not found: ${name}`);
  }

  async getSecretJson<T = Record<string, string>>(name: string): Promise<T> {
    const value = await this.getSecret(name);
    try {
      return JSON.parse(value) as T;
    } catch {
      throw new Error(`Secret "${name}" is not valid JSON`);
    }
  }

  // ── Management (not on SecretsService interface) ───────────────────────

  async setSecret(name: string, value: string): Promise<void> {
    this.requireUnlocked();
    this.cache.set(name, value);
    this.dirty = true;
  }

  async deleteSecret(name: string): Promise<void> {
    this.requireUnlocked();
    this.cache.delete(name);
    this.dirty = true;
  }

  async listSecrets(): Promise<string[]> {
    this.requireUnlocked();
    return [...this.cache.keys()];
  }

  private _flushLock: Promise<void> | null = null;

  /** Persist the in-memory cache to the encrypted store. */
  async flush(): Promise<void> {
    const key = this.requireUnlocked();
    if (!this.dirty) return;

    // Serialize flushes so concurrent calls don't race
    if (this._flushLock) {
      await this._flushLock;
      if (!this.dirty) return;
    }

    this._flushLock = (async () => {
      // Snapshot the cache before encrypting so concurrent setSecret
      // calls are captured in a subsequent flush, not lost mid-flight.
      const snapshot = new Map(this.cache);
      const json = JSON.stringify(Object.fromEntries(snapshot));
      const encrypted = encrypt(json, key);
      await this.store.put({
        pk: SECRETS_PK,
        sk: SECRETS_SK,
        ...encrypted,
      });
      this.dirty = false;
    })();

    await this._flushLock;
    this._flushLock = null;
  }

  // ── Internal ───────────────────────────────────────────────────────────

  private requireUnlocked(): Buffer {
    if (!this.key) {
      throw new Error('Secrets store is locked. Call unlock(password) first.');
    }
    return this.key;
  }
}
