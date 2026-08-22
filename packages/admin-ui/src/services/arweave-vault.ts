import bs58 from 'bs58';

export type VaultWalletSource = 'phantom' | 'solflare' | 'backpack';

export interface SolanaVaultProvider {
  isConnected?: boolean;
  publicKey?: { toString(): string } | null;
  connect?: () => Promise<{ publicKey: { toString(): string } } | void>;
  signMessage?: (message: Uint8Array, display?: string) => Promise<{ signature: Uint8Array }>;
}

export interface DetectedVaultWallet {
  name: string;
  source: VaultWalletSource;
  provider: SolanaVaultProvider;
}

export interface SwarmLocalSnapshot {
  schema: 'chat.rati.swarm.local-snapshot';
  version: 1;
  createdAt: string;
  origin: string;
  storage: Record<string, string>;
}

export interface SwarmEncryptedVault {
  schema: 'chat.rati.swarm.encrypted-vault';
  version: 1;
  createdAt: string;
  walletAddress: string;
  walletSource: VaultWalletSource;
  key: {
    kind: 'solana-signature-hkdf-aes-gcm';
    message: string;
    salt: string;
    iv: string;
  };
  manifest: {
    app: 'Swarm';
    storageKeys: string[];
    byteLength: number;
  };
  ciphertext: string;
}

const SNAPSHOT_SCHEMA = 'chat.rati.swarm.local-snapshot' as const;
const VAULT_SCHEMA = 'chat.rati.swarm.encrypted-vault' as const;
const VAULT_VERSION = 1 as const;

const STORAGE_KEY_ALLOWLIST = [
  'swarm:web-local:v1',
  'swarm-auth',
  'swarm-theme',
];

const STORAGE_PREFIX_ALLOWLIST = [
  'swarm:',
  'swarm-',
];

function textEncoder(): TextEncoder {
  return new TextEncoder();
}

function textDecoder(): TextDecoder {
  return new TextDecoder();
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function getCrypto(): Crypto {
  if (!globalThis.crypto?.subtle) {
    throw new Error('WebCrypto is not available in this browser.');
  }
  return globalThis.crypto;
}

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  getCrypto().getRandomValues(bytes);
  return bytes;
}

function isSwarmStorageKey(key: string): boolean {
  return STORAGE_KEY_ALLOWLIST.includes(key) || STORAGE_PREFIX_ALLOWLIST.some((prefix) => key.startsWith(prefix));
}

export function createVaultMessage(walletAddress: string): string {
  return [
    'Swarm encrypted vault v1',
    `Wallet: ${walletAddress}`,
    'App: chat.rati.swarm',
    'Purpose: encrypt and decrypt portable local agent state',
    '',
    'Signing this message does not trigger a blockchain transaction or cost fees.',
  ].join('\n');
}

export function detectVaultWallets(): DetectedVaultWallet[] {
  if (typeof window === 'undefined') return [];
  const win = window as unknown as Record<string, unknown>;
  const wallets: DetectedVaultWallet[] = [];

  const phantom = win.phantom as
    | { solana?: SolanaVaultProvider & { isPhantom?: boolean } }
    | undefined;
  if (phantom?.solana?.isPhantom) {
    wallets.push({ name: 'Phantom', source: 'phantom', provider: phantom.solana });
  }

  const solflare = win.solflare as
    | (SolanaVaultProvider & { isSolflare?: boolean })
    | undefined;
  if (solflare?.isSolflare) {
    wallets.push({ name: 'Solflare', source: 'solflare', provider: solflare });
  }

  const backpack = win.backpack as
    | (SolanaVaultProvider & { isBackpack?: boolean })
    | undefined;
  if (backpack?.isBackpack) {
    wallets.push({ name: 'Backpack', source: 'backpack', provider: backpack });
  }

  return wallets;
}

async function connectWallet(provider: SolanaVaultProvider): Promise<string> {
  if (!provider.isConnected && provider.connect) {
    const result = await provider.connect();
    const connectedAddress = result && 'publicKey' in result ? result.publicKey?.toString() : undefined;
    if (connectedAddress) return connectedAddress;
  }

  const walletAddress = provider.publicKey?.toString();
  if (!walletAddress) {
    throw new Error('Wallet did not return a public key.');
  }
  return walletAddress;
}

async function signVaultMessage(provider: SolanaVaultProvider, message: string): Promise<Uint8Array> {
  if (!provider.signMessage) {
    throw new Error('Connected wallet does not support message signing.');
  }
  const messageBytes = textEncoder().encode(message);
  let result: { signature: Uint8Array } | undefined;
  try {
    result = await provider.signMessage(messageBytes, 'utf8');
  } catch {
    result = await provider.signMessage(messageBytes);
  }
  if (!result?.signature?.length) {
    throw new Error('Wallet did not return a signature.');
  }
  return result.signature;
}

async function deriveVaultKey(signature: Uint8Array, salt: Uint8Array): Promise<CryptoKey> {
  const crypto = getCrypto();
  const inputKey = await crypto.subtle.importKey('raw', toArrayBuffer(signature), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: toArrayBuffer(salt),
      info: textEncoder().encode('chat.rati.swarm.encrypted-vault/aes-gcm'),
    },
    inputKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export function createLocalSnapshot(): SwarmLocalSnapshot {
  if (typeof localStorage === 'undefined') {
    throw new Error('localStorage is not available.');
  }

  const storage: Record<string, string> = {};
  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i);
    if (!key || !isSwarmStorageKey(key)) continue;
    const value = localStorage.getItem(key);
    if (value !== null) storage[key] = value;
  }

  return {
    schema: SNAPSHOT_SCHEMA,
    version: VAULT_VERSION,
    createdAt: new Date().toISOString(),
    origin: typeof location === 'undefined' ? 'swarm-local' : location.origin,
    storage,
  };
}

export function restoreLocalSnapshot(snapshot: SwarmLocalSnapshot): void {
  if (snapshot.schema !== SNAPSHOT_SCHEMA || snapshot.version !== VAULT_VERSION) {
    throw new Error('Unsupported Swarm snapshot format.');
  }
  if (typeof localStorage === 'undefined') {
    throw new Error('localStorage is not available.');
  }

  const nextKeys = new Set(Object.keys(snapshot.storage));
  for (let i = localStorage.length - 1; i >= 0; i -= 1) {
    const key = localStorage.key(i);
    if (key && isSwarmStorageKey(key) && !nextKeys.has(key)) {
      localStorage.removeItem(key);
    }
  }

  for (const [key, value] of Object.entries(snapshot.storage)) {
    if (isSwarmStorageKey(key)) localStorage.setItem(key, value);
  }
}

export async function encryptLocalSnapshot(wallet: DetectedVaultWallet): Promise<SwarmEncryptedVault> {
  const walletAddress = await connectWallet(wallet.provider);
  const message = createVaultMessage(walletAddress);
  const signature = await signVaultMessage(wallet.provider, message);
  const salt = randomBytes(32);
  const iv = randomBytes(12);
  const key = await deriveVaultKey(signature, salt);
  const snapshot = createLocalSnapshot();
  const plaintext = textEncoder().encode(JSON.stringify(snapshot));
  const encrypted = await getCrypto().subtle.encrypt(
    { name: 'AES-GCM', iv: toArrayBuffer(iv) },
    key,
    toArrayBuffer(plaintext),
  );
  const ciphertext = new Uint8Array(encrypted);

  return {
    schema: VAULT_SCHEMA,
    version: VAULT_VERSION,
    createdAt: new Date().toISOString(),
    walletAddress,
    walletSource: wallet.source,
    key: {
      kind: 'solana-signature-hkdf-aes-gcm',
      message,
      salt: bytesToBase64(salt),
      iv: bytesToBase64(iv),
    },
    manifest: {
      app: 'Swarm',
      storageKeys: Object.keys(snapshot.storage).sort(),
      byteLength: plaintext.byteLength,
    },
    ciphertext: bytesToBase64(ciphertext),
  };
}

export async function decryptVault(vault: SwarmEncryptedVault, wallet: DetectedVaultWallet): Promise<SwarmLocalSnapshot> {
  if (vault.schema !== VAULT_SCHEMA || vault.version !== VAULT_VERSION) {
    throw new Error('Unsupported Swarm vault format.');
  }

  const walletAddress = await connectWallet(wallet.provider);
  if (walletAddress !== vault.walletAddress) {
    throw new Error(`Connect ${vault.walletAddress.slice(0, 4)}...${vault.walletAddress.slice(-4)} to decrypt this vault.`);
  }

  const signature = await signVaultMessage(wallet.provider, vault.key.message);
  const key = await deriveVaultKey(signature, base64ToBytes(vault.key.salt));
  const decrypted = await getCrypto().subtle.decrypt(
    { name: 'AES-GCM', iv: toArrayBuffer(base64ToBytes(vault.key.iv)) },
    key,
    toArrayBuffer(base64ToBytes(vault.ciphertext)),
  );
  return JSON.parse(textDecoder().decode(decrypted)) as SwarmLocalSnapshot;
}

export function vaultToJson(vault: SwarmEncryptedVault): string {
  return JSON.stringify(vault, null, 2);
}

export function parseVaultJson(json: string): SwarmEncryptedVault {
  const parsed = JSON.parse(json) as SwarmEncryptedVault;
  if (parsed.schema !== VAULT_SCHEMA || parsed.version !== VAULT_VERSION || !parsed.ciphertext) {
    throw new Error('This is not a Swarm encrypted vault.');
  }
  return parsed;
}

export function downloadVault(vault: SwarmEncryptedVault): void {
  const blob = new Blob([vaultToJson(vault)], { type: 'application/vnd.swarm.vault+json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `swarm-vault-${vault.walletAddress.slice(0, 6)}-${Date.now()}.json`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export function normalizeArweaveId(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) throw new Error('Enter an Arweave transaction id or URL.');
  try {
    const url = new URL(trimmed);
    const id = url.pathname.split('/').filter(Boolean).pop();
    if (id) return id;
  } catch {
    // Plain transaction id.
  }
  return trimmed;
}

export async function fetchVaultFromArweave(input: string): Promise<SwarmEncryptedVault> {
  const id = normalizeArweaveId(input);
  const response = await fetch(`https://arweave.net/${encodeURIComponent(id)}`);
  if (!response.ok) {
    throw new Error(`Arweave fetch failed (${response.status}).`);
  }
  return parseVaultJson(await response.text());
}

export function walletAddressFromSignature(signatureBytes: Uint8Array): string {
  return bs58.encode(signatureBytes);
}
