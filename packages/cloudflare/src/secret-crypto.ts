const ENVELOPE_VERSION = 1 as const;
const ALGORITHM = 'AES-GCM' as const;

export type HostedSecretEnvelope = {
  version: typeof ENVELOPE_VERSION;
  algorithm: typeof ALGORITHM;
  keyVersion: string;
  dataIv: string;
  ciphertext: string;
  wrapIv: string;
  wrappedDataKey: string;
  createdAt: number;
};

type SecretKeyResolver = (keyVersion: string) => string | null;

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function encodeBase64Url(bytes: Uint8Array): string {
  const base64 = btoa(String.fromCharCode(...bytes));
  return base64.replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

function decodeBase64Url(value: string): Uint8Array {
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  try {
    return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
  } catch {
    throw new Error('Secret key material is not valid base64url.');
  }
}

async function importAesKey(raw: Uint8Array, usages: KeyUsage[]): Promise<CryptoKey> {
  if (raw.byteLength !== 32) {
    throw new Error('Hosted secret encryption keys must decode to exactly 32 bytes.');
  }
  return crypto.subtle.importKey('raw', toArrayBuffer(raw), { name: ALGORITHM }, false, usages);
}

async function encrypt(
  key: CryptoKey,
  plaintext: Uint8Array,
  iv: Uint8Array,
  additionalData: Uint8Array,
): Promise<Uint8Array> {
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: ALGORITHM,
      iv: toArrayBuffer(iv),
      additionalData: toArrayBuffer(additionalData),
      tagLength: 128,
    },
    key,
    toArrayBuffer(plaintext),
  );
  return new Uint8Array(ciphertext);
}

async function decrypt(
  key: CryptoKey,
  ciphertext: Uint8Array,
  iv: Uint8Array,
  additionalData: Uint8Array,
): Promise<Uint8Array> {
  try {
    const plaintext = await crypto.subtle.decrypt(
      {
        name: ALGORITHM,
        iv: toArrayBuffer(iv),
        additionalData: toArrayBuffer(additionalData),
        tagLength: 128,
      },
      key,
      toArrayBuffer(ciphertext),
    );
    return new Uint8Array(plaintext);
  } catch {
    throw new Error('Hosted secret authentication failed.');
  }
}

function assertEnvelope(value: unknown): asserts value is HostedSecretEnvelope {
  if (
    !value ||
    typeof value !== 'object' ||
    !('version' in value) ||
    value.version !== ENVELOPE_VERSION ||
    !('algorithm' in value) ||
    value.algorithm !== ALGORITHM ||
    !('keyVersion' in value) ||
    typeof value.keyVersion !== 'string' ||
    !('dataIv' in value) ||
    typeof value.dataIv !== 'string' ||
    !('ciphertext' in value) ||
    typeof value.ciphertext !== 'string' ||
    !('wrapIv' in value) ||
    typeof value.wrapIv !== 'string' ||
    !('wrappedDataKey' in value) ||
    typeof value.wrappedDataKey !== 'string' ||
    !('createdAt' in value) ||
    typeof value.createdAt !== 'number'
  ) {
    throw new Error('Hosted secret envelope is malformed or unsupported.');
  }
}

export class HostedSecretCipher {
  constructor(
    private readonly activeKeyVersion: string,
    private readonly resolveKey: SecretKeyResolver,
  ) {
    if (!activeKeyVersion.trim()) throw new Error('Hosted secret key version is required.');
  }

  async seal(plaintext: string, context: string): Promise<HostedSecretEnvelope> {
    const encodedKek = this.resolveKey(this.activeKeyVersion);
    if (!encodedKek) throw new Error(`Hosted secret encryption key ${this.activeKeyVersion} is not configured.`);

    const kek = await importAesKey(decodeBase64Url(encodedKek), ['encrypt']);
    const rawDataKey = crypto.getRandomValues(new Uint8Array(32));
    const dataKey = await importAesKey(rawDataKey, ['encrypt']);
    const dataIv = crypto.getRandomValues(new Uint8Array(12));
    const wrapIv = crypto.getRandomValues(new Uint8Array(12));
    const additionalData = new TextEncoder().encode(`swarm-secret|${context}|v${ENVELOPE_VERSION}`);
    const wrappedKeyAdditionalData = new TextEncoder().encode(`swarm-secret-key|${context}|${this.activeKeyVersion}`);

    const [ciphertext, wrappedDataKey] = await Promise.all([
      encrypt(dataKey, new TextEncoder().encode(plaintext), dataIv, additionalData),
      encrypt(kek, rawDataKey, wrapIv, wrappedKeyAdditionalData),
    ]);
    rawDataKey.fill(0);

    return {
      version: ENVELOPE_VERSION,
      algorithm: ALGORITHM,
      keyVersion: this.activeKeyVersion,
      dataIv: encodeBase64Url(dataIv),
      ciphertext: encodeBase64Url(ciphertext),
      wrapIv: encodeBase64Url(wrapIv),
      wrappedDataKey: encodeBase64Url(wrappedDataKey),
      createdAt: Date.now(),
    };
  }

  async open(serializedEnvelope: string, context: string): Promise<string> {
    let envelope: unknown;
    try {
      envelope = JSON.parse(serializedEnvelope);
    } catch {
      throw new Error('Hosted secret envelope is not valid JSON.');
    }
    assertEnvelope(envelope);

    const encodedKek = this.resolveKey(envelope.keyVersion);
    if (!encodedKek) throw new Error(`Hosted secret encryption key ${envelope.keyVersion} is not configured.`);
    const kek = await importAesKey(decodeBase64Url(encodedKek), ['decrypt']);
    const wrappedKeyAdditionalData = new TextEncoder().encode(`swarm-secret-key|${context}|${envelope.keyVersion}`);
    const rawDataKey = await decrypt(
      kek,
      decodeBase64Url(envelope.wrappedDataKey),
      decodeBase64Url(envelope.wrapIv),
      wrappedKeyAdditionalData,
    );

    try {
      const dataKey = await importAesKey(rawDataKey, ['decrypt']);
      const additionalData = new TextEncoder().encode(`swarm-secret|${context}|v${envelope.version}`);
      const plaintext = await decrypt(
        dataKey,
        decodeBase64Url(envelope.ciphertext),
        decodeBase64Url(envelope.dataIv),
        additionalData,
      );
      return new TextDecoder().decode(plaintext);
    } finally {
      rawDataKey.fill(0);
    }
  }
}

export function encodeHostedSecretKey(bytes: Uint8Array): string {
  return encodeBase64Url(bytes);
}

export function isHostedSecretKeyValid(value: string | undefined): boolean {
  if (!value) return false;
  try {
    return decodeBase64Url(value).byteLength === 32;
  } catch {
    return false;
  }
}
