/**
 * Local HTTP server — runs the swarm admin API and serves the admin UI.
 */
import express from 'express';
import cors from 'cors';
import type { CorsOptions } from 'cors';
import { createInterface } from 'readline';
import { randomBytes, createHash } from "crypto";
import { execFile } from 'node:child_process';
import { startTelegramPolling } from "./telegram-polling.js";
import { isOllamaAvailable, getOllamaModel, getOllamaEndpoint } from "./llm-ollama.js";
import { getRatiBalance, getSolBalance } from "./rati-auto-bridge.js";
import { createLocalServices } from './factories.js';
import { RuntimeSupervisor } from './runtime-supervisor.js';
import {
  AWS_MANAGED_SWARM_STARTER_PLAN,
  parseHostingStatus,
  type HostingStatus,
  type ManagedSwarmInstance,
  type SwarmRunMode,
} from '@swarm/core';
import {
  AsciiBoxApiError,
  AsciiBoxClient,
  firstUrlFromText,
  parseAsciiBoxCliOnboardingOutput,
  parsePortFromEndpoint,
  redactAsciiBoxText,
  redactAsciiBoxUrl,
  sanitizeAsciiBoxForClient,
  shellSingleQuote,
  type AsciiBoxSession,
  type AsciiBoxState,
} from './ascii-box-provider.js';
import { LocalS3Adapter } from './s3-adapter.js';
import { LocalSQSAdapter } from './sqs-adapter.js';
import { LocalSecretsAdapter } from './secrets-adapter.js';
import { LocalLambdaAdapter } from './lambda-adapter.js';
import {
  createLocalLlamaEmbeddingService,
  localLlamaEmbeddingsEnabled,
  type LocalEmbeddingService,
} from './llama-embedding.js';
import {
  createLocalLlamaChatService,
  localLlamaChatEnabled,
  type LocalChatCompletionRequest,
  type LocalLlamaChatService,
} from './llama-chat.js';
import type { UserSession } from '@swarm/admin-api';

export { createLocalServices } from './factories.js';

type LocalServices = ReturnType<typeof createLocalServices>;

// Module-level state for cross-route communication
interface SignalIdentity {
  pubkey?: string;
  encryptedSeed?: string;
}

const _signalState: {
  latestAvatarId: string | null;
  latestPubkey: string | null;
  latestIdentity: SignalIdentity | null;
  treasuryConfig: { minerShare: number; treasuryShare: number; lpPoolAddress?: string };
} = {
  latestAvatarId: null,
  latestPubkey: null,
  latestIdentity: null,
  treasuryConfig: { minerShare: 0.10, treasuryShare: 0.90 },
};
export { SqliteRepository } from './sqlite-repository.js';
export { LocalBlobStore } from './blob-store.js';
export { InMemoryQueue } from './queue.js';
export { EncryptedSecretsService } from './encrypted-secrets.js';
export { LocalDynamoClientAdapter } from './dynamo-adapter.js';
export { LocalS3Adapter } from './s3-adapter.js';
export { LocalSQSAdapter } from './sqs-adapter.js';
export { LocalSecretsAdapter } from './secrets-adapter.js';
export { LocalLambdaAdapter } from './lambda-adapter.js';

// ── Log buffer (in-memory + on-disk) ────────────────────────────────
import { appendFileSync, mkdirSync } from 'fs';

interface LogEntry {
  ts: string;
  level: 'INFO' | 'WARN' | 'ERROR';
  message: string;
}

const logBuffer: LogEntry[] = [];
const MAX_LOG_ENTRIES = 500;
let logFilePath = '';

function initLogFile() {
  const home = process.env.HOME ?? '/tmp';
  const dir = `${home}/Library/Application Support/Swarm`;
  mkdirSync(dir, { recursive: true });
  logFilePath = `${dir}/swarm.log`;
}

function pushLog(level: LogEntry['level'], message: string) {
  const entry = { ts: new Date().toISOString(), level, message };
  logBuffer.push(entry);
  if (logBuffer.length > MAX_LOG_ENTRIES) logBuffer.shift();

  if (logFilePath) {
    try {
      appendFileSync(logFilePath, `[${entry.ts}] ${level} ${message}\n`);
    } catch { /* disk full or permissions */ }
  }
}

initLogFile();

const origLog = console.log;
const origWarn = console.warn;
const origError = console.error;
console.log = (...args: unknown[]) => { pushLog('INFO', args.map(String).join(' ')); origLog(...args); };
console.warn = (...args: unknown[]) => { pushLog('WARN', args.map(String).join(' ')); origWarn(...args); };
console.error = (...args: unknown[]) => { pushLog('ERROR', args.map(String).join(' ')); origError(...args); };

process.on('uncaughtException', (err) => {
  pushLog('ERROR', `Uncaught: ${err.message}\n${err.stack}`);
  if (logFilePath) {
    try { appendFileSync(logFilePath, err.stack + '\n'); } catch {
      // Best-effort crash logging only.
    }
  }
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  pushLog('ERROR', `Unhandled rejection: ${String(reason)}`);
});


export interface ServerOptions {
  port?: number;
  host?: string;
  dbPath?: string;
  blobDir?: string;
  adminUiPath?: string;
  password?: string;
  /** Custom password prompt (e.g. native dialog for GUI apps). */
  promptFn?: (message: string) => Promise<string>;
}

function localAdminSession(): UserSession {
  return {
    email: 'local@swarm.dev',
    userId: 'local-user',
    isAdmin: true,
    accessToken: 'local-admin',
  };
}

// ── Password prompt ──────────────────────────────────────────────────────

async function promptPassword(prompt: string, options: ServerOptions): Promise<string> {
  if (options.promptFn) return options.promptFn(prompt);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// ── Server ───────────────────────────────────────────────────────────────
async function startTgPolling(services: ReturnType<typeof createLocalServices>) {
  try {
    const tgToken = await services.secrets.getSecret("telegram_bot_token").catch(() => null);
    if (!tgToken) {
      console.log("[local] No Telegram bot token configured, skipping polling.");
      return;
    }
    console.log("[local] Telegram bot token found, starting polling...");

    let cachedAvatarId: string | null = null;
    const stopPolling = startTelegramPolling({
      getToken: () => services.secrets.getSecret("telegram_bot_token").catch(() => null),
      getAvatarId: async () => {
        if (cachedAvatarId) return cachedAvatarId;
        const { listAvatars } = await import("../../admin-api/src/services/avatars.js");
        const avatars = await listAvatars();
        const first = avatars[0] as { avatarId?: string; id?: string } | undefined;
        if (first) cachedAvatarId = first.avatarId || first.id || null;
        return cachedAvatarId;
      },
      loadHistory: async (session, avatarId) => {
        const { getChatHistory } = await import("../../admin-api/src/services/chat-history.js");
        return getChatHistory(session, avatarId);
      },
      saveHistory: async (session, avatarId, history) => {
        const { saveChatHistory } = await import("../../admin-api/src/services/chat-history.js");
        await saveChatHistory(session, history, avatarId);
      },
      processMessage: async (text, history, session, avatarId) => {
        const { processChat } = await import("../../admin-api/src/handlers/chat.js");
        return processChat(text, history, session, { id: avatarId });
      },
    });
    process.on("SIGINT", stopPolling);
    process.on("SIGTERM", stopPolling);
  } catch (err) {
    console.warn("[local] Telegram polling setup failed:", (err as Error).message);
  }
}

// ── Extracted helpers (testable independently) ──────────────────────────

/** Set local-mode env vars so admin-api services don't crash on missing config. */
export function setupLocalEnv(): void {
  if (!process.env.LLM_API_KEY_SECRET_ARN) process.env.LLM_API_KEY_SECRET_ARN = "llm-api-key";
  if (!process.env.ADMIN_TABLE) process.env.ADMIN_TABLE = "swarm-local-admin";
  if (!process.env.STATE_TABLE) process.env.STATE_TABLE = "swarm-local-state";
  if (!process.env.MESSAGE_QUEUE_URL) process.env.MESSAGE_QUEUE_URL = "https://localhost/queue";
  if (!process.env.S3_BUCKET) process.env.S3_BUCKET = "swarm-local-blobs";

  const port = parseInt(process.env.PORT || '3000', 10);
  if (!process.env.CDN_URL) process.env.CDN_URL = `http://localhost:${port}/blobs`;
  if (!process.env.MEDIA_BUCKET) process.env.MEDIA_BUCKET = "swarm-local-blobs";
}

export interface InitSecretsOptions {
  password?: string;
  /** Called when a password is needed interactively. Only used in TTY mode. */
  onPasswordNeeded?: (prompt: string) => Promise<string>;
}

export interface InitSecretsResult {
  outcome: 'unlocked' | 'initialized' | 'needs_password';
  error?: string;
}

/**
 * Initialize or unlock the secrets store.
 *
 * In test/CI environments, pass `password` directly.
 * In interactive mode, provide `onPasswordNeeded` for prompting.
 * Does NOT call process.exit() — callers handle errors.
 */
export async function initSecrets(
  services: ReturnType<typeof createLocalServices>,
  options: InitSecretsOptions = {},
): Promise<InitSecretsResult> {
  const verify = await services.store.get({ pk: 'SYSTEM', sk: 'SECRETS_VERIFY' });
  const isInitialized = verify !== null;

  // Fall back to SWARM_ADMIN_PASSWORD env var if no password provided
  const resolvedPassword = options.password || process.env.SWARM_ADMIN_PASSWORD;

  if (isInitialized) {
    const pw = resolvedPassword ?? (options.onPasswordNeeded
      ? await options.onPasswordNeeded('Enter admin password: ')
      : undefined);
    if (!pw) return { outcome: 'needs_password', error: 'No password provided for existing secrets store.' };
    try {
      await services.secrets.unlock(pw);
      return { outcome: 'unlocked' };
    } catch (err) {
      return { outcome: 'needs_password', error: (err as Error).message };
    }
  }

  // First run — initialize
  const pw = resolvedPassword ?? (options.onPasswordNeeded
    ? await options.onPasswordNeeded('Choose an admin password (min 8 chars): ')
    : undefined);
  if (!pw) return { outcome: 'needs_password', error: 'No password provided for first-run initialization.' };
  if (pw.length < 8) return { outcome: 'needs_password', error: 'Password must be at least 8 characters.' };

  if (!resolvedPassword && options.onPasswordNeeded) {
    const confirm = await options.onPasswordNeeded('Confirm password: ');
    if (pw !== confirm) return { outcome: 'needs_password', error: 'Passwords do not match.' };
  }

  await services.secrets.initialize(pw);
  return { outcome: 'initialized' };
}

/**
 * Inject local adapters into admin-api + core modules.
 * Must be called BEFORE any admin-api handlers are imported.
 */
export async function injectLocalAdapters(
  services: ReturnType<typeof createLocalServices>,
  embeddingService?: LocalEmbeddingService,
): Promise<void> {
  const { _setDynamoClient } = await import('../../admin-api/src/services/dynamo-client.js');
  _setDynamoClient(services.dynamoAdapter);

  const aws = await import('../../admin-api/src/services/aws-clients.js');
  aws._setS3Client(new LocalS3Adapter(services.blobs));
  aws._setSQSClient(new LocalSQSAdapter(services.queue));
  aws._setSecretsClient(new LocalSecretsAdapter(services.secrets));
  aws._setLambdaClient(new LocalLambdaAdapter());

  const core = await import('@swarm/core');
  const adapter = services.dynamoAdapter;
  const setters = [
    '_setCanonicalDynamoClient', '_setTierDynamoClient',
    '_setSharedRoomDynamoClient', '_setLongFormDynamoClient',
    '_setIdentityLinkDynamoClient',
  ];
  let injected = 0;
  for (const setter of setters) {
    const fn = (core as Record<string, unknown>)[setter];
    if (typeof fn === 'function') { fn(adapter); injected++; }
  }
  if (injected > 0) console.log(`[local] Core setters injected (${injected})`);

  if (embeddingService) {
    const coreEmbeddingSetter = (core as Record<string, unknown>)._setEmbeddingService;
    if (typeof coreEmbeddingSetter === 'function') {
      coreEmbeddingSetter(embeddingService);
    }
    const adminEmbedding = await import('../../admin-api/src/services/embedding.js');
    adminEmbedding._setEmbeddingService(embeddingService);
    console.log(`[local] Embedded llama.cpp embeddings enabled (${embeddingService.modelId})`);
  }
}


export async function startServer(options: ServerOptions = {}) {
  const port = options.port ?? 3000;
  const host = options.host ?? '127.0.0.1';
  const dataDir = options.blobDir ?? './data/blobs';
  const dbPath = options.dbPath ?? './data/swarm.db';

  setupLocalEnv();


  // ── Create local backends ──────────────────────────────────────────
  const services = createLocalServices({
    dbPath,
    blobDir: dataDir,
    blobBaseUrl: `http://localhost:${port}/blobs`,
  });
  const embeddingService = localLlamaEmbeddingsEnabled()
    ? createLocalLlamaEmbeddingService()
    : undefined;
  const chatService = localLlamaChatEnabled()
    ? createLocalLlamaChatService()
    : undefined;
  const embeddedLlmEndpoint = chatService?.endpoint(port, host);

  // ── Unlock secrets ─────────────────────────────────────────────────
  const secretsResult = await initSecrets(services, {
    password: options.password,
    onPasswordNeeded: options.password
      ? undefined
      : async (prompt: string) => {
          // Interactive password prompt (TTY only)
          if (process.stdin.isTTY) return promptPassword(prompt, options);
          throw new Error('No password provided and stdin is not a TTY.');
        },
  });

  if (secretsResult.outcome === 'needs_password') {
    console.error('[local]', secretsResult.error);
    if (!options.password) process.exit(1);
    throw new Error(secretsResult.error!);
  }
  console.log(`[local] Secrets ${secretsResult.outcome}`);

  // ── Local LLM fallback (set before admin LLM imports) ──────────────
  const selectedLlmProvider = await services.secrets.getSecret('llm-provider').catch(() => null);
  if (!process.env.LLM_API_KEY && !process.env.OPENROUTER_API_KEY) {
    if ((selectedLlmProvider === 'embedded' || !selectedLlmProvider) && chatService && embeddedLlmEndpoint) {
      process.env.LLM_ENDPOINT = embeddedLlmEndpoint;
      process.env.LLM_API_KEY = 'embedded';
      process.env.LLM_MODEL = chatService.modelId;
      console.log(`[local] Embedded llama.cpp chat enabled (${chatService.modelId}) at ${embeddedLlmEndpoint}`);
    } else if (selectedLlmProvider === 'ollama' || (!selectedLlmProvider && !chatService)) {
      const ollamaAvailable = await isOllamaAvailable();
      if (ollamaAvailable) {
        const ollamaModel = await getOllamaModel();
        if (ollamaModel) {
          process.env.LLM_ENDPOINT = getOllamaEndpoint();
          process.env.LLM_API_KEY = "ollama";
          process.env.LLM_MODEL = ollamaModel;
          console.log(`[local] Ollama detected — using model "${ollamaModel}" at ${process.env.LLM_ENDPOINT}`);
        }
      }
    }
  }

  await injectLocalAdapters(services, embeddingService);

  // ── Express ────────────────────────────────────────────────────────
  const app = express();
  app.use(cors(localCorsOptions(port)));
  installLocalRequestGuard(app, port);
  app.use(express.json({ limit: '10mb' }));

  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      backend: 'local',
      db: dbPath,
      secrets: services.secrets.isUnlocked ? 'unlocked' : 'locked',
      logFile: logFilePath,
    });
  });

  app.get('/api/health', (_req, res) => {
    res.json({
      status: 'ok',
      backend: 'local',
      db: dbPath,
      secrets: services.secrets.isUnlocked ? 'unlocked' : 'locked',
      logFile: logFilePath,
    });
  });
  // Log viewer
  app.get('/api/logs', (_req, res) => {
    const limit = Math.min(parseInt(String(_req.query.limit)) || 50, MAX_LOG_ENTRIES);
    const level = String(_req.query.level || '').toUpperCase();
    const query = String(_req.query.query || '').toLowerCase();

    let entries = [...logBuffer];
    if (level) entries = entries.filter(e => e.level === level);
    if (query) entries = entries.filter(e => e.message.toLowerCase().includes(query));
    entries = entries.slice(-limit);

    res.json({ count: entries.length, total: logBuffer.length, entries });
  });

  // ── Auth routes (local mode: always authenticated as admin) ───────
  function localAuthMe(_req: express.Request, res: express.Response) {
    res.json({
      authenticated: true,
      local: true,
      user: {
        walletAddress: 'local-admin',
        displayName: 'Local Admin',
        email: 'local@swarm.dev',
      },
      account: {
        accountId: 'local-account',
        role: 'admin',
        identities: [{ type: 'wallet' as const, providerId: 'local-admin' }],
      },
      gateStatus: {
        nftsHeld: 999,
        avatarsCreated: 0,
        availableSlots: 999,
        canCreate: true,
        canAbandon: true,
        ownedNFTs: [],
      },
      gateWallet: null,
      gateStatusByWallet: {},
    });
  }

  app.get('/auth/me', localAuthMe);
  app.get('/api/auth/me', localAuthMe);

  async function localLogout(_req: express.Request, res: express.Response) {
    await services.secrets.deleteSecret('llm-provider').catch(() => undefined);
    await services.secrets.deleteSecret('llm-api-key').catch(() => undefined);
    await services.secrets.deleteSecret('agent-backend').catch(() => undefined);
    await services.secrets.deleteSecret('agent-backend-endpoint').catch(() => undefined);
    await services.secrets.deleteSecret('agent-backend-api-key').catch(() => undefined);
    await services.secrets.flush();
    try {
      const { clearChatHistory } = await import('../../admin-api/src/services/chat-history.js');
      const { listAvatars } = await import('../../admin-api/src/services/avatars.js');
      const session = {
        email: 'local@swarm.dev',
        userId: 'local-user',
        isAdmin: true,
        accessToken: 'local',
      };
      await clearChatHistory(session, undefined);
      const avatars = await listAvatars();
      await Promise.all(avatars.map((avatar) => clearChatHistory(
        session,
        (avatar as { avatarId?: string; id?: string }).avatarId || (avatar as { id?: string }).id,
      )));
    } catch (err) {
      console.warn('[local] Failed to clear chat history on logout:', err);
    }
    res.json({ success: true, aiDisconnected: true });
  }

  app.post('/auth/logout', localLogout);
  app.post('/api/auth/logout', localLogout);

  // -- OpenRouter PKCE OAuth ----------------------------------------
  const pendingPkce = new Map<string, { verifier: string; createdAt: number }>();

  app.get("/api/auth/openrouter", (_req, res) => {
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest().toString("base64url");
    const state = randomBytes(24).toString("base64url");
    pendingPkce.set(state, { verifier, createdAt: Date.now() });

    const authUrl = new URL("https://openrouter.ai/auth");
    authUrl.searchParams.set("callback_url", `http://localhost:${port}/callback`);
    authUrl.searchParams.set("code_challenge", challenge);
    authUrl.searchParams.set("code_challenge_method", "S256");
    authUrl.searchParams.set("state", state);

    // Return HTML that breaks out of iframe and redirects top window
    res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"></head><body><script>window.top.location.href = "${authUrl.toString()}";</script></body></html>`);
  });

  app.get("/api/auth/openrouter/callback", (req, res) => {
    const query = new URLSearchParams(
      Object.entries(req.query).flatMap(([key, value]) => {
        if (Array.isArray(value)) {
          return value.map((item) => [key, String(item)] as [string, string]);
        }
        return [[key, String(value)] as [string, string]];
      }),
    );
    return res.redirect(`/callback?${query.toString()}`);
  });

  app.get("/callback", async (req, res) => {
    const code = String(req.query.code || "");
    const state = String(req.query.state || "");

    const pending = pendingPkce.get(state);
    if (!pending) { res.status(400).send("Unknown or expired auth state"); return; }
    pendingPkce.delete(state);
    if (Date.now() - pending.createdAt > 600_000) { res.status(400).send("Auth state expired"); return; }

    try {
      const r = await fetch("https://openrouter.ai/api/v1/auth/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, code_verifier: pending.verifier, code_challenge_method: "S256" }),
      });
      if (!r.ok) { res.status(502).send("Exchange failed (" + r.status + ")"); return; }
      const body = await r.json() as { key?: string };
      if (!body.key) { res.status(502).send("No key in response"); return; }

      await services.secrets.setSecret("llm-api-key", body.key);
      await services.secrets.setSecret("llm-provider", "openrouter");
      await services.secrets.flush();
      res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="font-family:system-ui;text-align:center;padding-top:80px;background:#0d0d0d;color:#e0e0e0"><h1>Connected</h1><p>Your OpenRouter API key has been saved.</p><p>You may close this window.</p></body></html>`);
    } catch (err) {
      console.error("[local] PKCE error:", err);
      res.status(502).send("Exchange failed");
    }
  });


  // -- Consent routes (local mode: always consented) ----------------
  app.get('/consent', (_req, res) => {
    res.json({
      consented: true,
      consent: {
        policyVersion: '1.3',
        acceptedAt: Date.now(),
        status: 'active',
      },
    });
  });

  app.post('/consent', (_req, res) => {
    res.json({
      consent: {
        policyVersion: '1.3',
        acceptedAt: Date.now(),
        status: 'active',
      },
    });
  });

  app.post('/consent/revoke', (_req, res) => {
    res.json({ success: true });
  });

  app.get("/api/consent", (_req, res) => {
    res.json({ consented: true, consent: { policyVersion: "1.3", acceptedAt: Date.now(), status: "active" } });
  });

  app.post("/api/consent", (_req, res) => {
    res.json({ consent: { policyVersion: "1.3", acceptedAt: Date.now(), status: "active" } });
  });

  app.post("/api/consent/revoke", (_req, res) => {
    res.json({ success: true });
  });


  // -- Secrets management (local mode) ------------------------------
  app.get("/api/secrets", async (_req, res) => {
    try {
      const names = await services.secrets.listSecrets();
      res.json({ secrets: names });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get("/api/secrets/:name", async (req, res) => {
    try {
      await services.secrets.getSecret(req.params.name);
      res.json({ name: req.params.name, exists: true });
    } catch {
      res.json({ name: req.params.name, exists: false });
    }
  });

  app.post("/api/secrets/:name", async (req, res) => {
    try {
      const { value } = req.body as { value: string };
      if (!value) { res.status(400).json({ error: "value required" }); return; }
      await services.secrets.setSecret(req.params.name, value);
      if (req.params.name === 'llm-api-key') {
        await services.secrets.setSecret('llm-provider', 'openrouter');
      }
      await services.secrets.flush();
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.delete("/api/secrets/:name", async (req, res) => {
    try {
      await services.secrets.deleteSecret(req.params.name);
      await services.secrets.flush();
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Blob storage
  app.get('/blobs/:key', (req, res) => {
  // ── Auth routes (local mode: always authenticated as admin) ───────
    const key = req.params['key'] as string;
    const blob = services.blobs.get(key);
    if (!blob) { res.status(404).json({ error: 'Not found' }); return; }
    const ext = key.split('.').pop()?.toLowerCase();
    const mimeTypes: Record<string, string> = {
      png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
      gif: 'image/gif', webp: 'image/webp',
      mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav',
      mp4: 'video/mp4', webm: 'video/webm', json: 'application/json',
    };
    res.type(mimeTypes[ext ?? ''] ?? 'application/octet-stream');
    res.send(blob);
  });

  // ── RATi wallet balance ─────────────────────────────────────────
  app.get("/api/rati/treasury", (_req, res) => {
    res.json({
      minerShare: _signalState.treasuryConfig.minerShare,
      treasuryShare: _signalState.treasuryConfig.treasuryShare,
      lpPoolAddress: _signalState.treasuryConfig.lpPoolAddress || null,
      description: "10% to miners (relay bounty), 90% locked in station treasury for LP deposit.",
    });
  });

  app.get("/api/rati/balance", async (_req, res) => {
    try {
      if (!_signalState.latestPubkey) {
        res.json({ balance: 0, message: "No avatar yet. Create one first." });
        return;
      }
      const [ratiBalance, solBalance] = await Promise.all([
        getRatiBalance(_signalState.latestPubkey),
        getSolBalance(_signalState.latestPubkey),
      ]);
      res.json({
        pubkey: _signalState.latestPubkey,
        ratiBalance,
        solBalance,
        ratiMint: "8ZscSWe5ZSFbGYg4JzA3eqpf6iCnwT72i8TZvVni2yMY",
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Admin API routes ───────────────────────────────────────────────
  try {
    await mountAdminRoutes(app, services, undefined, embeddingService, chatService, embeddedLlmEndpoint);
  } catch (err) {
    console.warn('[local] Admin API routes unavailable:', (err as Error).message);
    mountStubRoutes(app);
  }

  // ── Client-side error reporting (always available) ───────────
  app.get("/api/log-client-error", (req, res) => {
    const m = String(req.query.m || "");
    const s = String(req.query.s || "");
    if (m) pushLog("ERROR", `[UI] ${m}${s ? " | " + s : ""}`);
    res.json({ ok: true });
  });

  app.post("/api/log-client-error", (req, res) => {
    const { message, stack, url } = req.body as { message?: string; stack?: string; url?: string };
    if (message) pushLog("ERROR", `[UI] ${message}${stack ? " | " + stack.split("\\n").slice(0, 2).join(" <- ") : ""} (at ${url || "unknown"})`);
    res.json({ ok: true });
  });




  // ── Admin UI ─────────────────────────────────────────────────
  if (options.adminUiPath) {
    app.use(express.static(options.adminUiPath));
    app.get('*', (_req, res) => {
      res.sendFile('index.html', { root: options.adminUiPath });
    });
  }

  return new Promise<{ app: express.Express; services: typeof services }>(
    (resolve, reject) => {
      const server = app.listen(port, host, () => {
        console.log(`[local] Swarm server running at http://${host}:${port}`);
        console.log(`[local]   Database: ${dbPath}`);
        console.log(`[local]   Blobs:    ${dataDir}`);

        // ── Telegram polling (local mode) ──────────────────────────
        startTgPolling(services).catch(err =>
          console.warn("[local] Telegram polling setup failed:", (err as Error).message)
        );

        resolve({ app, services });
      });
      server.on("error", reject);
    },
  );
}

// ── Route mounting ──────────────────────────────────────────────────────

type ChatHistoryMessage = { role: string; content: string; [key: string]: unknown };
type LocalSession = { email: string; userId: string; isAdmin: boolean; accessToken: string };
type PendingToolCall = { id: string; name: string; arguments: Record<string, unknown> };
type ChatRouteResult = {
  response?: string;
  history?: ChatHistoryMessage[];
  avatar?: unknown;
  pendingToolCall?: PendingToolCall;
  taskActions?: unknown;
  media?: unknown;
  pendingJobs?: unknown;
  avatarUpdates?: unknown;
};
type ChatProcessor = (
  message: string | null,
  history: ChatHistoryMessage[],
  session: LocalSession,
  avatar?: { id: string },
) => Promise<ChatRouteResult>;

type ExternalBackendPayload = {
  message: string | null;
  history: ChatHistoryMessage[];
  avatar?: { id: string };
  session: LocalSession;
  backend: AgentBackendId;
};

type AgentBackendId =
  | 'swarm-native'
  | 'hermes'
  | 'elizaos'
  | 'milady'
  | 'claude-code'
  | 'codex'
  | 'openclaw'
  | 'cosyworld'
  | 'custom';
type AgentBackendAuthMode = 'none' | 'api-key' | 'oauth' | 'local-process';
type AgentRuntimeDeploymentTarget = 'local' | 'ascii-box';
type AgentBackendCapabilities = {
  chat: boolean;
  tools: boolean;
  memory: boolean;
  autonomousLoop: boolean;
  codeExecution: boolean;
  multimodal: boolean;
};
type AgentBackendDefinition = {
  id: AgentBackendId;
  name: string;
  description: string;
  authMode: AgentBackendAuthMode;
  requiresEndpoint: boolean;
  contextWindow: number;
  install: {
    summary: string;
    commands: string[];
    docsUrl?: string;
    endpointHint?: string;
  };
  /** Best-guess default for launching this runtime locally; editable in the UI. */
  launch?: {
    command: string;
    endpoint?: string;
    /** Containerized launch template (image is a placeholder to fill in). */
    docker?: { command: string; endpoint?: string };
  };
  cloud?: {
    asciiBox?: {
      command?: string;
      endpointHint: string;
    };
  };
  capabilities: AgentBackendCapabilities;
};
type AsciiBoxComputeStatus = {
  provider: 'ascii-box';
  backend: AgentBackendId;
  configured: boolean;
  connected: boolean;
  supported: boolean;
  session: AsciiBoxSession | null;
  endpoint?: string;
  box?: ReturnType<typeof sanitizeAsciiBoxForClient>;
  error?: string;
};
type AgentBackendStatus = {
  selected: AgentBackendId;
  selectedBackend: AgentBackendDefinition;
  configured: boolean;
  endpoint?: string;
  hasApiKey: boolean;
  deploymentTarget: AgentRuntimeDeploymentTarget;
  compute?: {
    asciiBox?: AsciiBoxComputeStatus;
  };
  scope: {
    avatarId?: string;
    label: string;
  };
  backends: AgentBackendDefinition[];
};

type HostingMode = SwarmRunMode;
type HostingSubstrateProvider = 'fly' | 'aws' | 'ascii-box';
type HostingSubstrateProviderStatus = {
  id: HostingSubstrateProvider;
  label: string;
  cliInstalled: boolean;
  authenticated: boolean;
  enabled: boolean;
  detail: string;
  account?: string;
  loginCommand: string;
  connectUrl?: string;
  connectLabel?: string;
};
type HostingSubstratesStatus = {
  selected?: HostingSubstrateProvider;
  providers: HostingSubstrateProviderStatus[];
};
type LocalLlmProvider = 'embedded' | 'openrouter' | 'ollama';

const AGENT_BACKENDS: AgentBackendDefinition[] = [
  {
    id: 'swarm-native',
    name: 'Swarm Native',
    description: 'Built-in Swarm chat loop, MCP tools, avatar state, and local context management.',
    authMode: 'none',
    requiresEndpoint: false,
    contextWindow: 4096,
    install: {
      summary: 'Built in. No separate runtime install is required.',
      commands: [],
    },
    capabilities: {
      chat: true,
      tools: true,
      memory: true,
      autonomousLoop: true,
      codeExecution: false,
      multimodal: true,
    },
  },
  {
    id: 'hermes',
    name: 'Hermes',
    description: 'External Hermes-compatible agent runtime reached through a configured HTTP endpoint.',
    authMode: 'api-key',
    requiresEndpoint: true,
    contextWindow: 4096,
    install: {
      summary: 'Install Hermes Agent, complete portal setup, then start the local proxy. Swarm will use the default proxy endpoint automatically.',
      commands: [
        'curl -fsSL https://hermes-agent.nousresearch.com/install.sh | sh',
        'hermes setup --portal',
      ],
      docsUrl: 'https://hermes-agent.nousresearch.com/docs/',
      endpointHint: 'Swarm uses the default local Hermes endpoint automatically.',
    },
    launch: {
      command: 'hermes proxy start --port 8645',
      endpoint: 'http://localhost:8645',
      docker: {
        command: 'docker run --rm --name swarm-rt-hermes -p 8645:8645 your-hermes-image proxy start --host 0.0.0.0 --port 8645',
        endpoint: 'http://localhost:8645',
      },
    },
    cloud: {
      asciiBox: {
        command: 'hermes proxy start --host 0.0.0.0 --port 8645',
        endpointHint: 'Provision a Box and Swarm will start the Hermes proxy and attach the hosted endpoint automatically.',
      },
    },
    capabilities: {
      chat: true,
      tools: true,
      memory: true,
      autonomousLoop: true,
      codeExecution: false,
      multimodal: false,
    },
  },
  {
    id: 'elizaos',
    name: 'elizaOS',
    description: 'TypeScript agent framework backend for personalities, plugins, and autonomous actions.',
    authMode: 'api-key',
    requiresEndpoint: true,
    contextWindow: 4096,
    install: {
      summary: 'Install the elizaOS CLI, create or open an agent project, start it, then paste the local server endpoint.',
      commands: [
        'bun i -g @elizaos/cli',
        'elizaos create',
        'elizaos start',
      ],
      docsUrl: 'https://docs.elizaos.ai/',
      endpointHint: 'Swarm uses the default local elizaOS endpoint automatically.',
    },
    launch: {
      command: 'elizaos start',
      endpoint: 'http://localhost:3000',
      docker: {
        command: 'docker run --rm --name swarm-rt-elizaos -p 3000:3000 your-elizaos-image start',
        endpoint: 'http://localhost:3000',
      },
    },
    cloud: {
      asciiBox: {
        command: 'HOST=0.0.0.0 elizaos start',
        endpointHint: 'Provision a Box and Swarm will start elizaOS and attach the hosted endpoint automatically.',
      },
    },
    capabilities: {
      chat: true,
      tools: true,
      memory: true,
      autonomousLoop: true,
      codeExecution: false,
      multimodal: true,
    },
  },
  {
    id: 'milady',
    name: 'milady.ai',
    description: 'External milady.ai agent backend for hosted avatar runtime experiments.',
    authMode: 'api-key',
    requiresEndpoint: true,
    contextWindow: 4096,
    install: {
      summary: 'Connect a hosted or self-managed milady.ai-compatible agent endpoint.',
      commands: [],
      endpointHint: 'Paste the milady.ai agent endpoint and API key from your runtime.',
    },
    capabilities: {
      chat: true,
      tools: true,
      memory: true,
      autonomousLoop: true,
      codeExecution: false,
      multimodal: true,
    },
  },
  {
    id: 'claude-code',
    name: 'Claude Code',
    description: 'Local Claude Code or Agent SDK runtime for code-aware agent work.',
    authMode: 'local-process',
    requiresEndpoint: false,
    contextWindow: 4096,
    install: {
      summary: 'Install Claude Code locally and sign in. Swarm can then use the local process adapter once execution wiring is enabled.',
      commands: [
        'npm install -g @anthropic-ai/claude-code',
        'claude',
      ],
      docsUrl: 'https://code.claude.com/docs/en/quickstart',
    },
    capabilities: {
      chat: true,
      tools: true,
      memory: false,
      autonomousLoop: true,
      codeExecution: true,
      multimodal: false,
    },
  },
  {
    id: 'codex',
    name: 'Codex',
    description: 'Local Codex CLI runtime for code-aware agent work and repository operations.',
    authMode: 'local-process',
    requiresEndpoint: false,
    contextWindow: 4096,
    install: {
      summary: 'Install Codex CLI locally and sign in with ChatGPT or an API key.',
      commands: [
        'curl -fsSL https://chatgpt.com/codex/install.sh | sh',
        'codex',
      ],
      docsUrl: 'https://developers.openai.com/codex/cli',
    },
    capabilities: {
      chat: true,
      tools: true,
      memory: false,
      autonomousLoop: true,
      codeExecution: true,
      multimodal: false,
    },
  },
  {
    id: 'openclaw',
    name: 'OpenClaw',
    description: 'External OpenClaw personal-agent backend for messaging, scheduling, and workflow actions.',
    authMode: 'api-key',
    requiresEndpoint: true,
    contextWindow: 4096,
    install: {
      summary: 'Install OpenClaw, run onboarding, then paste the gateway endpoint.',
      commands: [
        'npm install -g openclaw@latest',
        'openclaw onboard --install-daemon',
        'openclaw setup',
      ],
      docsUrl: 'https://docs.openclaw.ai/install',
      endpointHint: 'Swarm uses the default local OpenClaw gateway endpoint automatically.',
    },
    launch: {
      command: 'openclaw gateway',
      endpoint: 'http://localhost:8787',
      docker: {
        command: 'docker run --rm --name swarm-rt-openclaw -p 8787:8787 your-openclaw-image gateway',
        endpoint: 'http://localhost:8787',
      },
    },
    capabilities: {
      chat: true,
      tools: true,
      memory: true,
      autonomousLoop: true,
      codeExecution: false,
      multimodal: true,
    },
  },
  {
    id: 'cosyworld',
    name: 'CosyWorld',
    description: 'Sibling ../cosyworld runtime for world, avatar, Discord, memory, and story systems.',
    authMode: 'api-key',
    requiresEndpoint: true,
    contextWindow: 4096,
    install: {
      summary: 'Use the sibling ../cosyworld checkout. Install dependencies once, then launch it on a Swarm-safe port.',
      commands: [
        'cd ../cosyworld && npm install',
        'cd ../cosyworld && WEB_PORT=3101 npm run dev',
      ],
      endpointHint: 'Swarm uses the default local CosyWorld endpoint automatically.',
    },
    launch: {
      command: 'cd ../cosyworld && WEB_PORT=3101 npm run dev',
      endpoint: 'http://localhost:3101',
      docker: {
        command: 'docker run --rm --name swarm-rt-cosyworld -p 3101:3000 your-cosyworld-image',
        endpoint: 'http://localhost:3101',
      },
    },
    cloud: {
      asciiBox: {
        command: 'cd ../cosyworld && HOST=0.0.0.0 WEB_PORT=3101 npm run dev',
        endpointHint: 'Provision a Box and Swarm will start CosyWorld and attach the hosted endpoint automatically.',
      },
    },
    capabilities: {
      chat: true,
      tools: true,
      memory: true,
      autonomousLoop: true,
      codeExecution: false,
      multimodal: true,
    },
  },
  {
    id: 'custom',
    name: 'Custom',
    description: 'Bring your own agent backend through an HTTP endpoint.',
    authMode: 'api-key',
    requiresEndpoint: true,
    contextWindow: 4096,
    install: {
      summary: 'Run any OpenAI-compatible or custom agent service, then paste its HTTP endpoint.',
      commands: [],
      endpointHint: 'Paste the custom agent backend endpoint.',
    },
    capabilities: {
      chat: true,
      tools: true,
      memory: false,
      autonomousLoop: false,
      codeExecution: false,
      multimodal: false,
    },
  },
];

function isAgentBackendId(value: unknown): value is AgentBackendId {
  return typeof value === 'string' && AGENT_BACKENDS.some((backend) => backend.id === value);
}

function getAgentBackendDefinition(id: AgentBackendId): AgentBackendDefinition {
  return AGENT_BACKENDS.find((backend) => backend.id === id) ?? AGENT_BACKENDS[0];
}

function getDefaultAgentBackendEndpoint(definition: AgentBackendDefinition): string | undefined {
  return definition.launch?.endpoint;
}

function isAgentRuntimeDeploymentTarget(value: unknown): value is AgentRuntimeDeploymentTarget {
  return value === 'local' || value === 'ascii-box';
}

const HOSTING_MODE_SECRET = 'hosting:global:mode';
const AWS_MANAGED_INSTANCE_SECRET = 'hosting:global:aws-managed-instance';
const HOSTING_SUBSTRATE_SECRET = 'hosting:global:substrate';

function hostedEntitlementActive(): boolean {
  return process.env.SWARM_HOSTED_ENTITLEMENT_ACTIVE === '1';
}

function isHostingSubstrateProvider(value: unknown): value is HostingSubstrateProvider {
  return value === 'fly' || value === 'aws' || value === 'ascii-box';
}

async function readAwsManagedInstance(services: LocalServices): Promise<ManagedSwarmInstance | undefined> {
  const raw = await readFirstSecretOrNull(services, [AWS_MANAGED_INSTANCE_SECRET]);
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as ManagedSwarmInstance;
    if (parsed.provider !== 'aws' || parsed.architecture !== 'aws-managed-ec2-pool') return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

async function readActiveAwsManagedInstance(services: LocalServices): Promise<ManagedSwarmInstance | undefined> {
  if (!hostedEntitlementActive()) return undefined;
  const persisted = await readAwsManagedInstance(services);
  const endpoint = process.env.SWARM_HOSTED_INSTANCE_ENDPOINT?.trim();
  const instanceId = process.env.SWARM_HOSTED_INSTANCE_ID?.trim();
  if (!endpoint || !instanceId) {
    if (
      persisted?.status === 'running'
      && persisted.endpoint
      && persisted.instanceId
    ) {
      return persisted;
    }
    return undefined;
  }
  const now = Date.now();
  return {
    provider: 'aws',
    architecture: 'aws-managed-ec2-pool',
    planId: AWS_MANAGED_SWARM_STARTER_PLAN.id,
    status: 'running',
    requestedAt: persisted?.requestedAt ?? now,
    updatedAt: now,
    region: process.env.SWARM_AWS_HOSTED_REGION || process.env.AWS_REGION || persisted?.region || 'us-east-1',
    tenantId: process.env.SWARM_HOSTED_TENANT_ID || persisted?.tenantId || 'local-dev',
    instanceId,
    endpoint,
  };
}

async function readHostingMode(services: LocalServices): Promise<HostingMode> {
  return (await readFirstSecretOrNull(services, [HOSTING_MODE_SECRET])) === 'hosted' ? 'hosted' : 'local';
}

async function writeHostingMode(services: LocalServices, mode: HostingMode): Promise<void> {
  await services.secrets.setSecret(HOSTING_MODE_SECRET, mode);
  await services.secrets.flush();
}

async function readHostingSubstrate(services: LocalServices): Promise<HostingSubstrateProvider | undefined> {
  const value = await readFirstSecretOrNull(services, [HOSTING_SUBSTRATE_SECRET]);
  return isHostingSubstrateProvider(value) ? value : undefined;
}

async function writeHostingSubstrate(services: LocalServices, provider: HostingSubstrateProvider): Promise<void> {
  await services.secrets.setSecret(HOSTING_SUBSTRATE_SECRET, provider);
  await services.secrets.flush();
}

async function getHostingStatus(services: LocalServices, mode?: HostingMode): Promise<HostingStatus> {
  const requestedMode = mode ?? await readHostingMode(services);
  const entitlement = hostedEntitlementActive() ? 'active' as const : 'none' as const;
  const instance = await readActiveAwsManagedInstance(services);
  const hostedActive = Boolean(instance);
  return parseHostingStatus({
    mode: requestedMode === 'hosted' && hostedActive ? 'hosted' : 'local',
    local: {
      available: true,
      running: requestedMode !== 'hosted' || !hostedActive,
      label: 'This device',
      detail: 'Runs while the app is open. Uses local encrypted storage and local runtime supervision.',
    },
    hosted: {
      available: hostedActive,
      configured: hostedActive,
      label: AWS_MANAGED_SWARM_STARTER_PLAN.label,
      priceUsdMonthly: AWS_MANAGED_SWARM_STARTER_PLAN.priceUsdMonthly,
      provider: 'aws',
      architecture: AWS_MANAGED_SWARM_STARTER_PLAN.architecture,
      status: hostedActive ? 'active' : 'not-configured',
      entitlement,
      plan: AWS_MANAGED_SWARM_STARTER_PLAN,
      ...(instance ? { instance } : {}),
      detail: hostedActive
        ? 'Hosted entitlement and runtime health are confirmed.'
        : entitlement === 'active'
          ? 'Hosted entitlement is active, but no healthy provisioned runtime is configured.'
          : 'Hosted checkout and provisioning are not connected in this build.',
    },
  });
}

function normalizeAvatarScope(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 80) || undefined;
}

export function agentRuntimeSecretKey(name: string, avatarId?: string): string {
  return avatarId ? `agent:${avatarId}:${name}` : `agent:global:${name}`;
}

export function legacyAgentRuntimeSecretKey(name: string, avatarId?: string): string {
  return avatarId ? agentRuntimeSecretKey(name, avatarId) : name;
}

export function runtimeSecretKey(name: string, backend: AgentBackendId, avatarId?: string): string {
  return avatarId ? `runtime:${avatarId}:${backend}:${name}` : `runtime:global:${backend}:${name}`;
}

export function legacyRuntimeSecretKey(name: string, backend: AgentBackendId, avatarId?: string): string {
  return avatarId ? runtimeSecretKey(name, backend, avatarId) : `runtime-${name}:${backend}`;
}

function runtimeSupervisorKey(backend: AgentBackendId, avatarId?: string): string {
  return avatarId ? `${avatarId}:${backend}` : backend;
}

function asciiBoxSessionSecretKey(backend: AgentBackendId, avatarId?: string): string {
  return avatarId ? `compute:${avatarId}:${backend}:ascii-box` : `compute:global:${backend}:ascii-box`;
}

async function readFirstSecretOrNull(services: LocalServices, names: string[]): Promise<string | null> {
  for (const name of names) {
    try {
      const value = (await services.secrets.getSecret(name))?.trim();
      if (value) return value;
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

async function getAsciiBoxApiKey(services: LocalServices): Promise<string | null> {
  const envKey = (process.env.ASCII_BOX_API_KEY || process.env.BOX_API_KEY || '').trim();
  if (envKey) return envKey;
  return readFirstSecretOrNull(services, [
    'ASCII_BOX_API_KEY',
    'BOX_API_KEY',
    'ascii-box-api-key',
    'box-api-key',
  ]);
}

function createAsciiBoxClient(apiKey: string): AsciiBoxClient {
  return new AsciiBoxClient({
    apiKey,
    baseUrl: process.env.ASCII_BOX_API_BASE || process.env.BOX_API_BASE,
  });
}

const ASCII_BOX_INSTALL_COMMAND = 'curl -fsSL https://box.ascii.dev/install | sh';
const ASCII_BOX_QUICKSTART_URL = 'https://docs.ascii.dev/box/quickstart';

type ExecFileTextResult = {
  stdout: string;
  stderr: string;
  success: boolean;
  timedOut: boolean;
  errorCode?: string;
  errorMessage?: string;
};

function execFileText(file: string, args: string[], timeoutMs: number): Promise<ExecFileTextResult> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      {
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, NO_COLOR: '1' },
      },
      (err, stdout, stderr) => {
        const childErr = err as (Error & { code?: string | number; killed?: boolean; signal?: string }) | null;
        resolve({
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
          success: !err,
          timedOut: Boolean(childErr?.killed || childErr?.signal === 'SIGTERM'),
          ...(typeof childErr?.code === 'string' ? { errorCode: childErr.code } : {}),
          ...(childErr ? { errorMessage: childErr.message } : {}),
        });
      },
    );
  });
}

async function asciiBoxCliInstalled(): Promise<boolean> {
  const result = await execFileText('box', ['--version'], 2500);
  return result.success || Boolean(`${result.stdout}\n${result.stderr}`.match(/\bbox\b/i));
}

function runMacTerminalCommand(command: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const escaped = command.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const script = `tell application "Terminal"\n  activate\n  do script "${escaped}"\nend tell`;
    execFile('osascript', ['-e', script], (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

async function asciiBoxOnboardingStatus(services: LocalServices) {
  const apiKey = await getAsciiBoxApiKey(services);
  const cliInstalled = await asciiBoxCliInstalled();
  return {
    provider: 'ascii-box',
    readyForApiProvisioning: Boolean(apiKey),
    apiKeyConfigured: Boolean(apiKey),
    cliInstalled,
    installCommand: ASCII_BOX_INSTALL_COMMAND,
    docsUrl: ASCII_BOX_QUICKSTART_URL,
    freeTrial: {
      available: true,
      days: 7,
      detail: 'Ascii Box onboarding uses browser-based GitHub sign-in and checkout for the free trial.',
    },
  };
}

function compactCommandOutput(result: ExecFileTextResult): string {
  return redactAsciiBoxText(`${result.stdout}\n${result.stderr}`.trim()).split(/\r?\n/).find(Boolean) ?? '';
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

async function awsSubstrateStatus(): Promise<HostingSubstrateProviderStatus> {
  const setup = {
    loginCommand: 'aws sso login',
    connectUrl: 'https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-sso.html',
    connectLabel: 'Connect AWS',
  };
  const result = await execFileText('aws', ['sts', 'get-caller-identity', '--output', 'json'], 4_000);
  if (result.success) {
    const parsed = parseJsonObject(result.stdout);
    const account = typeof parsed?.Account === 'string' ? parsed.Account : undefined;
    const arn = typeof parsed?.Arn === 'string' ? parsed.Arn : undefined;
    return {
      id: 'aws',
      label: 'AWS',
      cliInstalled: true,
      authenticated: true,
      enabled: true,
      detail: account ? `Signed in as ${account}` : 'Signed in locally',
      ...(account || arn ? { account: account ?? arn } : {}),
      ...setup,
    };
  }
  const cliInstalled = result.errorCode !== 'ENOENT';
  return {
    id: 'aws',
    label: 'AWS',
    cliInstalled,
    authenticated: false,
    enabled: false,
    detail: cliInstalled ? compactCommandOutput(result) || 'Not signed in locally' : 'AWS CLI not found',
    ...setup,
  };
}

async function flySubstrateStatus(): Promise<HostingSubstrateProviderStatus> {
  const setup = {
    loginCommand: 'fly auth login',
    connectUrl: 'https://fly.io/docs/flyctl/auth-login/',
    connectLabel: 'Connect Fly',
  };
  let result = await execFileText('fly', ['auth', 'whoami'], 4_000);
  let cliInstalled = result.errorCode !== 'ENOENT';
  if (!cliInstalled) {
    result = await execFileText('flyctl', ['auth', 'whoami'], 4_000);
    cliInstalled = result.errorCode !== 'ENOENT';
  }
  if (result.success) {
    const account = compactCommandOutput(result);
    return {
      id: 'fly',
      label: 'Fly',
      cliInstalled: true,
      authenticated: true,
      enabled: true,
      detail: account ? `Signed in as ${account}` : 'Signed in locally',
      ...(account ? { account } : {}),
      ...setup,
    };
  }
  return {
    id: 'fly',
    label: 'Fly',
    cliInstalled,
    authenticated: false,
    enabled: false,
    detail: cliInstalled ? compactCommandOutput(result) || 'Not signed in locally' : 'Fly CLI not found',
    ...setup,
  };
}

async function asciiBoxSubstrateStatus(services: LocalServices): Promise<HostingSubstrateProviderStatus> {
  const setup = {
    loginCommand: 'box login',
    connectUrl: 'https://docs.ascii.dev/box/quickstart',
    connectLabel: 'Connect Box',
  };
  const apiKey = await getAsciiBoxApiKey(services);
  if (apiKey) {
    return {
      id: 'ascii-box',
      label: 'Ascii Box',
      cliInstalled: await asciiBoxCliInstalled(),
      authenticated: true,
      enabled: true,
      detail: 'Signed in locally',
      ...setup,
    };
  }

  const cliInstalled = await asciiBoxCliInstalled();
  if (!cliInstalled) {
    return {
      id: 'ascii-box',
      label: 'Ascii Box',
      cliInstalled: false,
      authenticated: false,
      enabled: false,
      detail: 'Box CLI not found',
      ...setup,
    };
  }

  let last: ExecFileTextResult | undefined;
  for (const args of [['whoami', '--json'], ['auth', 'status', '--json']]) {
    last = await execFileText('box', args, 4_000);
    if (!last.success) continue;
    const parsed = parseJsonObject(last.stdout);
    const account = ['email', 'username', 'user', 'id']
      .map((key) => parsed?.[key])
      .find((value): value is string => typeof value === 'string' && value.length > 0);
    return {
      id: 'ascii-box',
      label: 'Ascii Box',
      cliInstalled: true,
      authenticated: true,
      enabled: true,
      detail: account ? `Signed in as ${account}` : 'Signed in locally',
      ...(account ? { account } : {}),
      ...setup,
    };
  }

  return {
    id: 'ascii-box',
    label: 'Ascii Box',
    cliInstalled: true,
    authenticated: false,
    enabled: false,
    detail: last ? compactCommandOutput(last) || 'Not signed in locally' : 'Not signed in locally',
    ...setup,
  };
}

async function getHostingSubstratesStatus(services: LocalServices): Promise<HostingSubstratesStatus> {
  const [selected, fly, aws, asciiBox] = await Promise.all([
    readHostingSubstrate(services),
    flySubstrateStatus(),
    awsSubstrateStatus(),
    asciiBoxSubstrateStatus(services),
  ]);
  return {
    ...(selected ? { selected } : {}),
    providers: [fly, aws, asciiBox],
  };
}

function isRunnableAsciiBoxState(state: AsciiBoxState): boolean {
  return state === 'ready' || state === 'idle';
}

async function readAsciiBoxSession(
  services: LocalServices,
  backend: AgentBackendId,
  avatarId?: string,
): Promise<AsciiBoxSession | null> {
  const raw = await readFirstSecretOrNull(services, [asciiBoxSessionSecretKey(backend, avatarId)]);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as AsciiBoxSession;
    if (parsed.provider !== 'ascii-box' || parsed.backend !== backend || !parsed.boxId) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function writeAsciiBoxSession(
  services: LocalServices,
  session: AsciiBoxSession,
  avatarId?: string,
): Promise<void> {
  await services.secrets.setSecret(
    asciiBoxSessionSecretKey(session.backend as AgentBackendId, avatarId),
    JSON.stringify({ ...session, updatedAt: Date.now() }),
  );
}

async function deleteAsciiBoxSession(
  services: LocalServices,
  backend: AgentBackendId,
  avatarId?: string,
): Promise<void> {
  await services.secrets.deleteSecret(asciiBoxSessionSecretKey(backend, avatarId)).catch(() => undefined);
}

function safeAsciiError(err: unknown): { status: number; code?: string; message: string } {
  if (err instanceof AsciiBoxApiError) {
    return {
      status: err.status,
      code: err.code,
      message: redactAsciiBoxText(err.message),
    };
  }
  return {
    status: 500,
    message: err instanceof Error ? redactAsciiBoxText(err.message) : 'Ascii Box request failed',
  };
}

function asciiBoxEndpointForClient(endpoint: string | undefined): string | undefined {
  return endpoint ? redactAsciiBoxUrl(endpoint) : undefined;
}

function asciiBoxSessionForClient(session: AsciiBoxSession): AsciiBoxSession {
  return {
    ...session,
    endpoint: asciiBoxEndpointForClient(session.endpoint),
  };
}

async function maybeEnsureAsciiBoxRuntimeEndpoint(params: {
  services: LocalServices;
  client: AsciiBoxClient;
  backend: AgentBackendId;
  avatarId?: string;
  session: AsciiBoxSession;
}): Promise<AsciiBoxSession> {
  const definition = getAgentBackendDefinition(params.backend);
  const command = definition.cloud?.asciiBox?.command ?? definition.launch?.command;
  const port = parsePortFromEndpoint(definition.launch?.endpoint);
  if (!command || !port || params.session.endpoint) return params.session;

  const now = Date.now();
  if (params.session.launchAttemptedAt && now - params.session.launchAttemptedAt < 60_000) {
    return params.session;
  }

  let next: AsciiBoxSession = {
    ...params.session,
    launchAttemptedAt: now,
    lastError: undefined,
  };

  try {
    const logPath = `/tmp/swarm-runtime-${params.backend}.log`;
    const detached = `sh -lc ${shellSingleQuote(`nohup ${command} >${logPath} 2>&1 < /dev/null & echo started`)}`;
    const launchResult = await params.client.command(params.session.boxId, detached, { timeoutSeconds: 10 });
    if (launchResult.success === false) {
      throw new Error(launchResult.stderr || launchResult.stdout || 'runtime launch command failed');
    }

    const title = `Swarm ${definition.name}`;
    const hostResult = await params.client.command(
      params.session.boxId,
      `host ${port} --title ${shellSingleQuote(title)}`,
      { timeoutSeconds: 30 },
    );
    if (hostResult.success === false) {
      throw new Error(hostResult.stderr || hostResult.stdout || 'host command failed');
    }

    const hostedUrl = firstUrlFromText(`${hostResult.stdout ?? ''}\n${hostResult.stderr ?? ''}`);
    if (!hostedUrl) {
      throw new Error('host command did not return a URL');
    }

    next = {
      ...next,
      endpoint: hostedUrl,
      hostedPort: port,
      runtimeStartedAt: now,
      lastError: undefined,
    };
    await params.services.secrets.setSecret(agentRuntimeSecretKey('agent-backend-endpoint', params.avatarId), hostedUrl);
    await params.services.secrets.setSecret(runtimeSecretKey('endpoint', params.backend, params.avatarId), hostedUrl);
  } catch (err) {
    next = {
      ...next,
      lastError: safeAsciiError(err).message,
    };
  }

  return next;
}

async function asciiBoxStatusPayload(
  services: LocalServices,
  backend: AgentBackendId,
  avatarId?: string,
): Promise<AsciiBoxComputeStatus> {
  const apiKey = await getAsciiBoxApiKey(services);
  const configured = Boolean(apiKey);
  const session = await readAsciiBoxSession(services, backend, avatarId);
  if (!session) {
    return {
      provider: 'ascii-box',
      backend,
      configured,
      connected: configured,
      supported: true,
      session: null,
    };
  }

  if (!apiKey) {
    const clientSession = asciiBoxSessionForClient(session);
    return {
      provider: 'ascii-box',
      backend,
      configured: false,
      connected: false,
      supported: true,
      session: clientSession,
      endpoint: clientSession.endpoint,
      error: 'Ascii Box API key is not configured.',
    };
  }

  try {
    const client = createAsciiBoxClient(apiKey);
    const box = await client.getBox(session.boxId);
    let next: AsciiBoxSession = {
      ...session,
      state: box.state,
      updatedAt: Date.now(),
    };
    if (isRunnableAsciiBoxState(box.state)) {
      next = await maybeEnsureAsciiBoxRuntimeEndpoint({ services, client, backend, avatarId, session: next });
    }
    await writeAsciiBoxSession(services, next, avatarId);
    await services.secrets.flush();
    return {
      provider: 'ascii-box',
      backend,
      configured: true,
      connected: true,
      supported: true,
      session: asciiBoxSessionForClient(next),
      endpoint: asciiBoxEndpointForClient(next.endpoint),
      box: sanitizeAsciiBoxForClient(box),
      ...(next.lastError ? { error: next.lastError } : {}),
    };
  } catch (err) {
    const safe = safeAsciiError(err);
    const next = {
      ...session,
      lastError: safe.message,
      updatedAt: Date.now(),
    };
    await writeAsciiBoxSession(services, next, avatarId);
    await services.secrets.flush();
    return {
      provider: 'ascii-box',
      backend,
      configured: true,
      connected: false,
      supported: true,
      session: asciiBoxSessionForClient(next),
      endpoint: asciiBoxEndpointForClient(next.endpoint),
      error: safe.message,
    };
  }
}

function localAppOrigins(port: number): Set<string> {
  const configuredOrigins = (process.env.SWARM_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  return new Set([
    `http://localhost:${port}`,
    `http://127.0.0.1:${port}`,
    ...configuredOrigins,
  ]);
}

export function isAllowedLocalOrigin(origin: string | undefined, port: number): boolean {
  if (!origin) return false;
  return localAppOrigins(port).has(origin);
}

function localCorsOptions(port: number): CorsOptions {
  return {
    credentials: true,
    origin(origin, callback) {
      // CORS is not authentication. Requests without Origin still need the
      // write guard below, while reads and command-line clients remain usable.
      callback(null, !origin || isAllowedLocalOrigin(origin, port));
    },
  };
}

export function isLocalApiWriteAllowed(params: {
  method: string;
  origin?: string;
  providedToken?: string;
  expectedToken?: string;
  port: number;
}): boolean {
  const unsafeMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
  if (!unsafeMethods.has(params.method.toUpperCase())) return true;
  if (params.expectedToken) return params.providedToken === params.expectedToken;
  return isAllowedLocalOrigin(params.origin, params.port);
}

function installLocalRequestGuard(app: express.Express, port: number): void {
  const expectedToken = process.env.SWARM_LOCAL_API_TOKEN?.trim();

  app.use((req, res, next) => {
    if (isLocalApiWriteAllowed({
      method: req.method,
      origin: req.get('origin'),
      providedToken: req.get('x-swarm-local-token'),
      expectedToken,
      port,
    })) {
      next();
      return;
    }

    res.status(403).json({ error: 'Local API token required' });
  });
}

export function isAllowedRuntimeLaunchCommand(backend: AgentBackendId, command: string): boolean {
  const definition = getAgentBackendDefinition(backend);
  const allowed = new Set<string>();
  if (definition.launch?.command) allowed.add(definition.launch.command);
  if (definition.launch?.docker?.command) allowed.add(definition.launch.docker.command);
  return allowed.has(command);
}

export function isAuthorizedCustomRuntimeCommand(req: express.Request): boolean {
  const token = process.env.SWARM_LOCAL_API_TOKEN?.trim();
  return Boolean(
    token &&
    process.env.SWARM_LOCAL_ALLOW_CUSTOM_RUNTIME_COMMANDS === '1' &&
    req.get('x-swarm-local-token') === token,
  );
}

function hasConfiguredLocalApiToken(req: express.Request): boolean {
  const token = process.env.SWARM_LOCAL_API_TOKEN?.trim();
  return !token || req.get('x-swarm-local-token') === token;
}

async function dispatchExternalAgentBackend(params: {
  status: AgentBackendStatus;
  apiKey: string | null;
  payload: ExternalBackendPayload;
}): Promise<ChatRouteResult> {
  const endpoint = params.status.endpoint?.trim();
  if (!endpoint) {
    throw new Error(`${params.status.selectedBackend.name} needs an endpoint before chat can route to it.`);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(params.apiKey ? { Authorization: `Bearer ${params.apiKey}` } : {}),
      },
      body: JSON.stringify(params.payload),
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`${params.status.selectedBackend.name} chat timed out after 15s`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }

  const text = await response.text();
  let body: unknown = text;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }

  if (!response.ok) {
    const message = typeof body === 'object' && body && 'error' in body
      ? String((body as { error?: unknown }).error)
      : text || `HTTP ${response.status}`;
    throw new Error(`${params.status.selectedBackend.name} chat failed: ${message}`);
  }

  if (typeof body === 'string') {
    return {
      response: body,
      history: params.payload.history,
      avatar: params.payload.avatar ?? null,
    };
  }

  const result = (body ?? {}) as Partial<ChatRouteResult> & {
    message?: string;
    content?: string;
  };

  return {
    response: result.response ?? result.message ?? result.content ?? '',
    history: result.history ?? params.payload.history,
    avatar: result.avatar ?? params.payload.avatar ?? null,
    pendingToolCall: result.pendingToolCall,
    taskActions: result.taskActions,
    media: result.media,
    pendingJobs: result.pendingJobs,
    avatarUpdates: result.avatarUpdates,
  };
}

async function getLocalAgentBackendStatus(
  services: LocalServices,
  avatarId?: string,
): Promise<AgentBackendStatus> {
  let selected: AgentBackendId = 'swarm-native';
  const stored = await readFirstSecretOrNull(services, [
    agentRuntimeSecretKey('agent-backend', avatarId),
    legacyAgentRuntimeSecretKey('agent-backend', avatarId),
  ]);
  if (isAgentBackendId(stored)) {
    selected = stored;
  }

  let endpoint: string | undefined;
  let hasApiKey = false;
  let deploymentTarget: AgentRuntimeDeploymentTarget = 'local';
  endpoint = (await readFirstSecretOrNull(services, [
    agentRuntimeSecretKey('agent-backend-endpoint', avatarId),
    legacyAgentRuntimeSecretKey('agent-backend-endpoint', avatarId),
  ])) ?? undefined;
  hasApiKey = Boolean(await readFirstSecretOrNull(services, [
    agentRuntimeSecretKey('agent-backend-api-key', avatarId),
    legacyAgentRuntimeSecretKey('agent-backend-api-key', avatarId),
  ]));
  const storedTarget = await readFirstSecretOrNull(services, [
    agentRuntimeSecretKey('agent-backend-deployment-target', avatarId),
    legacyAgentRuntimeSecretKey('agent-backend-deployment-target', avatarId),
  ]);
  if (isAgentRuntimeDeploymentTarget(storedTarget)) deploymentTarget = storedTarget;

  const selectedBackend = getAgentBackendDefinition(selected);
  endpoint = endpoint || (deploymentTarget === 'local' ? getDefaultAgentBackendEndpoint(selectedBackend) : undefined);
  const asciiBox = deploymentTarget === 'ascii-box'
    ? await asciiBoxStatusPayload(services, selected, avatarId)
    : undefined;
  endpoint = endpoint || asciiBox?.endpoint;
  const clientEndpoint = deploymentTarget === 'ascii-box'
    ? asciiBoxEndpointForClient(endpoint)
    : endpoint;
  const configured = selectedBackend.id === 'swarm-native' ||
    selectedBackend.authMode === 'local-process' ||
    (!selectedBackend.requiresEndpoint || Boolean(endpoint));

  return {
    selected,
    selectedBackend,
    configured,
    endpoint: clientEndpoint,
    hasApiKey,
    deploymentTarget,
    ...(asciiBox ? { compute: { asciiBox } } : {}),
    scope: {
      ...(avatarId ? { avatarId } : {}),
      label: avatarId ? `Avatar ${avatarId}` : 'New agents',
    },
    backends: AGENT_BACKENDS,
  };
}

async function getLocalLlmStatus(
  services: LocalServices,
  chatService?: LocalLlamaChatService,
  embeddedEndpoint = '',
): Promise<{
  configured: boolean;
  provider: LocalLlmProvider | null;
  selectedProvider: LocalLlmProvider | null;
  embedded: Awaited<ReturnType<LocalLlamaChatService['status']>>;
  openrouter: { configured: boolean };
  ollama: { available: boolean; model?: string; endpoint: string };
}> {
  const embedded = chatService
    ? await chatService.status(true, embeddedEndpoint)
    : {
        provider: 'llama.cpp' as const,
        enabled: false,
        ready: false,
        modelExists: false,
        modelPath: '',
        modelId: '',
        contextSize: 0,
        downloadUrl: '',
        endpoint: embeddedEndpoint,
        error: 'Local embedded chat is disabled.',
      };

  let selectedProvider: LocalLlmProvider | null = null;
  try {
    const rawProvider = await services.secrets.getSecret('llm-provider');
    if (rawProvider === 'embedded' || rawProvider === 'openrouter' || rawProvider === 'ollama') {
      selectedProvider = rawProvider;
    }
  } catch {
    selectedProvider = null;
  }

  const envLlmKey = process.env.LLM_API_KEY;
  const envSelectedProvider: LocalLlmProvider | null = envLlmKey === 'embedded'
    ? 'embedded'
    : envLlmKey === 'ollama'
      ? 'ollama'
      : null;
  const effectiveSelectedProvider = selectedProvider ?? envSelectedProvider ?? (chatService ? 'embedded' : null);
  let hasOpenRouterKey = Boolean(
    process.env.OPENROUTER_API_KEY ||
    (envLlmKey && envLlmKey !== 'embedded' && envLlmKey !== 'ollama')
  );
  if (!hasOpenRouterKey) {
    try {
      const key = await services.secrets.getSecret('llm-api-key');
      hasOpenRouterKey = Boolean(key?.trim());
    } catch {
      hasOpenRouterKey = false;
    }
  }

  if ((effectiveSelectedProvider === 'openrouter' || (!effectiveSelectedProvider && hasOpenRouterKey)) && hasOpenRouterKey) {
    return {
      configured: true,
      provider: 'openrouter',
      selectedProvider: 'openrouter',
      embedded,
      openrouter: { configured: true },
      ollama: { available: false, endpoint: getOllamaEndpoint() },
    };
  }

  if (effectiveSelectedProvider === 'embedded') {
    if (chatService && embedded.endpoint) {
      process.env.LLM_ENDPOINT = embedded.endpoint;
      process.env.LLM_API_KEY = 'embedded';
      process.env.LLM_MODEL = chatService.modelId;
    }
    return {
      configured: Boolean(chatService && embedded.enabled && embedded.packageAvailable !== false),
      provider: chatService && embedded.enabled && embedded.packageAvailable !== false ? 'embedded' : null,
      selectedProvider: 'embedded',
      embedded,
      openrouter: { configured: false },
      ollama: { available: false, endpoint: getOllamaEndpoint() },
    };
  }

  const model = await getOllamaModel();
  const ollamaAvailable = Boolean(model) || await isOllamaAvailable();
  if (model) {
    process.env.LLM_ENDPOINT = getOllamaEndpoint();
    process.env.LLM_API_KEY = 'ollama';
    process.env.LLM_MODEL = model;
  }

  return {
    configured: effectiveSelectedProvider === 'ollama' && Boolean(model),
    provider: effectiveSelectedProvider === 'ollama' && model ? 'ollama' : null,
    selectedProvider: effectiveSelectedProvider,
    embedded,
    openrouter: { configured: false },
    ollama: { available: ollamaAvailable, model, endpoint: getOllamaEndpoint() },
  };
}

export async function mountAdminRoutes(
  app: express.Express,
  services: LocalServices,
  processChatOverride?: ChatProcessor,
  embeddingService?: LocalEmbeddingService,
  chatService?: LocalLlamaChatService,
  embeddedLlmEndpoint = '',
) {
  const { processChat } = await import(
    '../../admin-api/src/handlers/chat.js'
  );
  const chat = processChatOverride ?? (processChat as unknown as ChatProcessor);

  // ── Runtime supervisor (launch/stop external agent backends) ────────
  const supervisor = new RuntimeSupervisor();
  const stopSupervised = () => supervisor.stopAll();
  process.once('exit', stopSupervised);
  process.once('SIGINT', stopSupervised);
  process.once('SIGTERM', stopSupervised);

  const makeLocalSession = (sessionOverride?: { email?: string; userId?: string; isAdmin?: boolean }): LocalSession => ({
    email: sessionOverride?.email ?? 'local@swarm.dev',
    userId: sessionOverride?.userId ?? 'local-user',
    isAdmin: sessionOverride?.isAdmin ?? true,
    accessToken: 'local',
  });

  app.get('/v1/models', (_req, res) => {
    if (!chatService) {
      res.status(404).json({ error: { message: 'Local embedded chat is disabled.' } });
      return;
    }
    res.json({
      object: 'list',
      data: [{
        id: chatService.modelId,
        object: 'model',
        created: 0,
        owned_by: 'swarm-local',
      }],
    });
  });

  app.post('/v1/chat/completions', async (req, res) => {
    if (!chatService) {
      res.status(503).json({ error: { message: 'Local embedded chat is disabled.' } });
      return;
    }
    const body = req.body as LocalChatCompletionRequest;
    if (body.stream) {
      res.status(400).json({ error: { message: 'Streaming is not supported by the embedded local chat endpoint yet.' } });
      return;
    }
    try {
      // Bun 1.4 exposes an inherited Request.signal getter that expects Bun's
      // internal request slots. Express and test request objects do not have
      // those slots, so only consume signals explicitly attached by middleware.
      const ownSignal = Object.getOwnPropertyDescriptor(req, 'signal')?.value;
      const requestSignal = ownSignal instanceof AbortSignal ? ownSignal : undefined;
      const response = await chatService.complete(body, requestSignal);
      res.json(response);
    } catch (err) {
      res.status(500).json({
        error: {
          message: err instanceof Error ? err.message : 'Local embedded chat failed',
          type: 'local_llama_error',
        },
      });
    }
  });

  app.post('/api/chat', async (req, res) => {
    try {
      const { message, history = [], avatar, session: sessionOverride } =
        req.body as {
          message?: string;
          history?: Array<{ role: string; content: string }>;
          avatar?: { id: string };
          session?: { email?: string; userId?: string; isAdmin?: boolean };
        };

      if (!message && !history.length) {
        res.status(400).json({ error: 'message or history required' });
        return;
      }

      const session = makeLocalSession(sessionOverride);
      const avatarScope = normalizeAvatarScope(avatar?.id);
      const backendStatus = await getLocalAgentBackendStatus(services, avatarScope);

      const result = backendStatus.selected === 'swarm-native'
        ? await (async () => {
            const llmStatus = await getLocalLlmStatus(services, chatService, embeddedLlmEndpoint);
            if (!llmStatus.configured) {
              res.status(409).json({
                error: 'AI provider setup required',
                code: 'AI_PROVIDER_REQUIRED',
                message: 'Connect OpenRouter or start Ollama before chatting.',
                providerStatus: llmStatus,
              });
              return null;
            }
            return chat(
              message ?? null,
              history,
              session,
              avatar ? { id: avatar.id } : undefined,
            );
          })()
        : await (async () => {
            if (!backendStatus.configured || !backendStatus.endpoint) {
              res.status(409).json({
                error: 'Agent backend setup required',
                code: 'AGENT_BACKEND_REQUIRED',
                message: `Configure or launch ${backendStatus.selectedBackend.name} before chatting.`,
                backendStatus,
              });
              return null;
            }
            const apiKey = await readFirstSecretOrNull(services, [
              agentRuntimeSecretKey('agent-backend-api-key', avatarScope),
              legacyAgentRuntimeSecretKey('agent-backend-api-key', avatarScope),
            ]);
            return dispatchExternalAgentBackend({
              status: backendStatus,
              apiKey,
              payload: {
                message: message ?? null,
                history,
                session,
                avatar: avatar ? { id: avatar.id } : undefined,
                backend: backendStatus.selected,
              },
            });
          })();

      if (!result) return;

      // Persist pending tool call so the tools resume endpoint can validate it
      const pendingToolCall = result.pendingToolCall;
      if (pendingToolCall && avatar?.id) {
        try {
          const { savePendingTool } = await import(
            "../../admin-api/src/services/pending-tools.js"
          );
          await savePendingTool({
            email: session.email,
            avatarId: avatar.id,
            toolCallId: pendingToolCall.id,
            toolName: pendingToolCall.name,
            arguments: pendingToolCall.arguments,
          });
          console.log(`[local] Persisted pending tool call ${pendingToolCall.id}`);
        } catch (e) {
          console.error("[local] Failed to persist pending tool:", e);
        }
      }

      res.json({
        response: result.response,
        history: result.history,
        avatar: result.avatar,
        pendingToolCall,
        taskActions: result.taskActions,
        media: result.media,
        pendingJobs: result.pendingJobs,
        avatarUpdates: result.avatarUpdates,
      });
    } catch (err) {
      console.error('[local] Chat error:', err);
      res.status(500).json({
        error: 'Chat processing failed',
        detail: (err as Error).message,
      });
    }
  });

  app.get('/api/chat', async (req, res) => {
    try {
      const { getChatHistory } = await import('../../admin-api/src/services/chat-history.js');
      const avatarId = typeof req.query.avatarId === 'string' ? req.query.avatarId : undefined;
      const history = await getChatHistory(makeLocalSession(), avatarId);
      res.json({ history });
    } catch (err) {
      console.error('[local] Chat history load error:', err);
      res.status(500).json({ error: 'Failed to load chat history' });
    }
  });

  app.delete('/api/chat', async (req, res) => {
    try {
      const { clearChatHistory } = await import('../../admin-api/src/services/chat-history.js');
      const avatarId = typeof req.query.avatarId === 'string' ? req.query.avatarId : undefined;
      await clearChatHistory(makeLocalSession(), avatarId);
      res.json({ success: true });
    } catch (err) {
      console.error('[local] Chat history clear error:', err);
      res.status(500).json({ error: 'Failed to clear chat history' });
    }
  });

  app.post('/api/chat/message', async (req, res) => {
    try {
      const { appendSystemMessage } = await import('../../admin-api/src/services/chat-history.js');
      const { avatarId, message } = req.body as {
        avatarId?: string;
        message?: { role?: 'assistant' | 'user'; content?: string };
      };
      if (!avatarId || !message?.role || !message.content) {
        res.status(400).json({ error: 'avatarId and message required' });
        return;
      }
      const history = await appendSystemMessage(makeLocalSession(), avatarId, {
        role: message.role,
        content: message.content,
      });
      res.json({ history });
    } catch (err) {
      console.error('[local] Chat history append error:', err);
      res.status(500).json({ error: 'Failed to append chat message' });
    }
  });

  app.get('/api/llm/status', async (_req, res) => {
    res.json(await getLocalLlmStatus(services, chatService, embeddedLlmEndpoint));
  });

  app.post('/api/llm/prepare', async (req, res) => {
    if (!chatService) {
      res.status(409).json({
        provider: 'llama.cpp',
        enabled: false,
        ready: false,
        error: 'Local embedded chat is disabled.',
      });
      return;
    }
    const { sampleText } = req.body as { sampleText?: unknown };
    try {
      res.json(await chatService.prepare(
        typeof sampleText === 'string' && sampleText.trim() ? sampleText.trim() : undefined,
      ));
    } catch (err) {
      res.status(500).json({
        ...(await chatService.status(true, embeddedLlmEndpoint)),
        ready: false,
        error: err instanceof Error ? err.message : 'Failed to prepare local chat model',
      });
    }
  });

  app.get('/api/embeddings/status', async (_req, res) => {
    if (!embeddingService) {
      res.json({
        provider: 'llama.cpp',
        enabled: false,
        ready: false,
        modelExists: false,
        error: 'Local embedded embeddings are disabled.',
      });
      return;
    }
    res.json(await embeddingService.status(true));
  });

  app.post('/api/embeddings/prepare', async (req, res) => {
    if (!embeddingService) {
      res.status(409).json({
        provider: 'llama.cpp',
        enabled: false,
        ready: false,
        error: 'Local embedded embeddings are disabled.',
      });
      return;
    }
    const { sampleText } = req.body as { sampleText?: unknown };
    try {
      res.json(await embeddingService.prepare(
        typeof sampleText === 'string' && sampleText.trim() ? sampleText.trim() : undefined,
      ));
    } catch (err) {
      res.status(500).json({
        ...(await embeddingService.status(true)),
        ready: false,
        error: err instanceof Error ? err.message : 'Failed to prepare local embeddings',
      });
    }
  });

  app.get('/api/hosting/status', async (_req, res) => {
    res.json(await getHostingStatus(services));
  });

  app.get('/api/hosting/substrates/status', async (_req, res) => {
    res.json(await getHostingSubstratesStatus(services));
  });

  app.post('/api/hosting/substrates/select', async (req, res) => {
    const { provider } = req.body as { provider?: unknown };
    if (!isHostingSubstrateProvider(provider)) {
      res.status(400).json({ error: 'provider must be fly, aws, or ascii-box' });
      return;
    }
    const status = await getHostingSubstratesStatus(services);
    const selected = status.providers.find((item) => item.id === provider);
    if (!selected?.authenticated) {
      res.status(409).json({
        error: `${selected?.label ?? 'Provider'} is not signed in locally`,
        status,
      });
      return;
    }
    await writeHostingSubstrate(services, provider);
    res.json(await getHostingSubstratesStatus(services));
  });

  app.post('/api/hosting/mode', async (req, res) => {
    const { mode } = req.body as { mode?: unknown };
    if (mode !== 'local' && mode !== 'hosted') {
      res.status(400).json({ error: 'mode must be local or hosted' });
      return;
    }
    if (mode === 'hosted') {
      res.status(501).json({
        error: 'Hosted checkout and provisioning are not connected in this build.',
        status: await getHostingStatus(services),
      });
      return;
    }
    await writeHostingMode(services, mode);
    res.json(await getHostingStatus(services, mode));
  });

  app.post('/api/hosting/provision', async (_req, res) => {
    res.status(501).json({
      error: 'Hosted checkout and provisioning are not connected in this build.',
      status: await getHostingStatus(services),
    });
  });

  app.post('/api/llm/provider', async (req, res) => {
    const { provider } = req.body as { provider?: string };
    if (provider !== 'embedded' && provider !== 'openrouter' && provider !== 'ollama') {
      res.status(400).json({ error: 'provider must be embedded, openrouter, or ollama' });
      return;
    }

    await services.secrets.setSecret('llm-provider', provider);
    if (provider === 'embedded' && chatService && embeddedLlmEndpoint) {
      process.env.LLM_ENDPOINT = embeddedLlmEndpoint;
      process.env.LLM_API_KEY = 'embedded';
      process.env.LLM_MODEL = chatService.modelId;
    }
    await services.secrets.flush();
    res.json(await getLocalLlmStatus(services, chatService, embeddedLlmEndpoint));
  });

  app.delete('/api/llm/provider', async (_req, res) => {
    await services.secrets.deleteSecret('llm-provider').catch(() => undefined);
    await services.secrets.deleteSecret('llm-api-key').catch(() => undefined);
    await services.secrets.flush();
    res.json(await getLocalLlmStatus(services, chatService, embeddedLlmEndpoint));
  });

  app.get('/api/agent-backends', async (req, res) => {
    const avatarId = normalizeAvatarScope(req.query.avatarId);
    res.json(await getLocalAgentBackendStatus(services, avatarId));
  });

  app.post('/api/agent-backends/select', async (req, res) => {
    const { backend, endpoint, apiKey, avatarId, deploymentTarget } = req.body as {
      backend?: unknown;
      endpoint?: unknown;
      apiKey?: unknown;
      avatarId?: unknown;
      deploymentTarget?: unknown;
    };

    if (!isAgentBackendId(backend)) {
      res.status(400).json({ error: 'backend must be a supported agent backend id' });
      return;
    }
    if (deploymentTarget !== undefined && !isAgentRuntimeDeploymentTarget(deploymentTarget)) {
      res.status(400).json({ error: 'deploymentTarget must be local or ascii-box' });
      return;
    }

    const definition = getAgentBackendDefinition(backend);
    const target = deploymentTarget ?? 'local';
    const scopedAvatarId = normalizeAvatarScope(avatarId);
    const defaultEndpoint = target === 'local' ? getDefaultAgentBackendEndpoint(definition) ?? '' : '';
    const providedEndpoint = typeof endpoint === 'string' ? endpoint.trim() : '';
    const trimmedEndpoint = providedEndpoint || defaultEndpoint;
    const trimmedApiKey = typeof apiKey === 'string' ? apiKey.trim() : '';

    if (definition.requiresEndpoint && target !== 'ascii-box' && !trimmedEndpoint) {
      res.status(400).json({ error: `${definition.name} requires an endpoint` });
      return;
    }

    await services.secrets.setSecret(agentRuntimeSecretKey('agent-backend', scopedAvatarId), backend);
    await services.secrets.setSecret(agentRuntimeSecretKey('agent-backend-deployment-target', scopedAvatarId), target);
    if (trimmedEndpoint) {
      await services.secrets.setSecret(agentRuntimeSecretKey('agent-backend-endpoint', scopedAvatarId), trimmedEndpoint);
    } else {
      await services.secrets.deleteSecret(agentRuntimeSecretKey('agent-backend-endpoint', scopedAvatarId)).catch(() => undefined);
    }
    if (definition.authMode !== 'api-key' && definition.authMode !== 'oauth') {
      await services.secrets.deleteSecret(agentRuntimeSecretKey('agent-backend-api-key', scopedAvatarId)).catch(() => undefined);
    } else if (trimmedApiKey) {
      await services.secrets.setSecret(agentRuntimeSecretKey('agent-backend-api-key', scopedAvatarId), trimmedApiKey);
    }
    await services.secrets.flush();
    res.json(await getLocalAgentBackendStatus(services, scopedAvatarId));
  });

  app.delete('/api/agent-backends/select', async (req, res) => {
    const avatarId = normalizeAvatarScope(req.query.avatarId);
    await services.secrets.deleteSecret(agentRuntimeSecretKey('agent-backend', avatarId)).catch(() => undefined);
    await services.secrets.deleteSecret(agentRuntimeSecretKey('agent-backend-endpoint', avatarId)).catch(() => undefined);
    await services.secrets.deleteSecret(agentRuntimeSecretKey('agent-backend-api-key', avatarId)).catch(() => undefined);
    await services.secrets.deleteSecret(agentRuntimeSecretKey('agent-backend-deployment-target', avatarId)).catch(() => undefined);
    for (const backend of AGENT_BACKENDS) {
      await deleteAsciiBoxSession(services, backend.id, avatarId);
    }
    await services.secrets.flush();
    res.json(await getLocalAgentBackendStatus(services, avatarId));
  });

  app.get('/api/compute/ascii-box/status', async (req, res) => {
    const backend = req.query.backend;
    const avatarId = normalizeAvatarScope(req.query.avatarId);
    if (!isAgentBackendId(backend)) {
      res.status(400).json({ error: 'backend query param required' });
      return;
    }
    res.json(await asciiBoxStatusPayload(services, backend, avatarId));
  });

  app.get('/api/compute/ascii-box/onboarding/status', async (_req, res) => {
    res.json(await asciiBoxOnboardingStatus(services));
  });

  app.post('/api/compute/ascii-box/onboarding/start', async (req, res) => {
    try {
      const action = (req.body as { action?: unknown } | undefined)?.action === 'continue' ? 'continue' : 'start';
      const status = await asciiBoxOnboardingStatus(services);
      if (status.readyForApiProvisioning) {
        res.json({
          ...status,
          action: 'ready',
          message: 'Ascii Box provider auth is already configured for automatic provisioning.',
        });
        return;
      }

      if (!status.cliInstalled) {
        if (process.platform !== 'darwin') {
          res.status(409).json({
            ...status,
            action: 'install',
            error: `Install the Box CLI, then start onboarding (${process.platform} cannot open the installer automatically yet).`,
          });
          return;
        }
        await runMacTerminalCommand(ASCII_BOX_INSTALL_COMMAND);
        res.status(202).json({
          ...status,
          action: 'install',
          terminalOpened: true,
          message: 'Opened the Box installer in Terminal. The installer starts browser onboarding and the free trial flow.',
        });
        return;
      }

      const args = action === 'continue' ? ['onboard', '--json'] : ['login', '--json'];
      const result = await execFileText('box', args, 15_000);
      const parsed = parseAsciiBoxCliOnboardingOutput(result.stdout, result.stderr);
      const safeMessage = parsed.message ?? redactAsciiBoxText(result.stderr || result.stdout || '');
      if (parsed.url || parsed.authenticated || result.success || result.timedOut) {
        res.status(parsed.authenticated || result.success ? 200 : 202).json({
          ...status,
          cliInstalled: true,
          action,
          command: `box ${args.join(' ')}`,
          authenticated: parsed.authenticated,
          loginUrl: parsed.loginUrl,
          checkoutUrl: parsed.checkoutUrl,
          url: parsed.url,
          nextCommand: parsed.nextCommand,
          message: parsed.url
            ? 'Continue the Ascii Box browser flow to start the free trial.'
            : safeMessage || 'Ascii Box browser login started. Complete it, then check again.',
        });
        return;
      }

      res.status(500).json({
        ...status,
        cliInstalled: true,
        action,
        command: `box ${args.join(' ')}`,
        error: safeMessage || 'Ascii Box onboarding did not return a login URL.',
      });
    } catch (err) {
      res.status(500).json({
        ...(await asciiBoxOnboardingStatus(services).catch(() => ({ provider: 'ascii-box' }))),
        error: err instanceof Error ? redactAsciiBoxText(err.message) : 'Ascii Box onboarding failed',
      });
    }
  });

  app.post('/api/compute/ascii-box/provision', async (req, res) => {
    try {
      const { backend, avatarId, ttlSeconds, noEnv } = req.body as {
        backend?: unknown;
        avatarId?: unknown;
        ttlSeconds?: unknown;
        noEnv?: unknown;
      };
      if (!isAgentBackendId(backend)) {
        res.status(400).json({ error: 'backend must be a supported agent backend id' });
        return;
      }
      if (backend === 'swarm-native') {
        res.status(400).json({ error: 'Swarm Native does not need an external compute provider' });
        return;
      }
      const apiKey = await getAsciiBoxApiKey(services);
      if (!apiKey) {
        res.status(409).json({ error: 'Ascii Box API key is not configured', code: 'ASCII_BOX_API_KEY_REQUIRED' });
        return;
      }

      const scopedAvatarId = normalizeAvatarScope(avatarId);
      const resolvedTtl = ttlSeconds === null
        ? null
        : typeof ttlSeconds === 'number' && Number.isFinite(ttlSeconds)
          ? Math.max(60, Math.floor(ttlSeconds))
          : 3600;
      const resolvedNoEnv = typeof noEnv === 'boolean' ? noEnv : true;
      const client = createAsciiBoxClient(apiKey);
      const box = await client.createBox({ ttlSeconds: resolvedTtl, noEnv: resolvedNoEnv });
      const session: AsciiBoxSession = {
        provider: 'ascii-box',
        backend,
        boxId: box.id,
        state: box.state,
        noEnv: resolvedNoEnv,
        ttlSeconds: resolvedTtl,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      await writeAsciiBoxSession(services, session, scopedAvatarId);
      await services.secrets.setSecret(agentRuntimeSecretKey('agent-backend', scopedAvatarId), backend);
      await services.secrets.setSecret(agentRuntimeSecretKey('agent-backend-deployment-target', scopedAvatarId), 'ascii-box');
      await services.secrets.deleteSecret(agentRuntimeSecretKey('agent-backend-endpoint', scopedAvatarId)).catch(() => undefined);
      await services.secrets.flush();

      res.status(202).json({
        provider: 'ascii-box',
        backend,
        configured: true,
        connected: true,
        supported: true,
        session: asciiBoxSessionForClient(session),
        box: sanitizeAsciiBoxForClient(box),
      });
    } catch (err) {
      const safe = safeAsciiError(err);
      res.status(safe.status >= 400 && safe.status < 600 ? safe.status : 500).json({
        error: safe.message,
        code: safe.code,
      });
    }
  });

  app.post('/api/compute/ascii-box/stop', async (req, res) => {
    try {
      const { backend, avatarId } = req.body as { backend?: unknown; avatarId?: unknown };
      if (!isAgentBackendId(backend)) {
        res.status(400).json({ error: 'backend must be a supported agent backend id' });
        return;
      }
      const scopedAvatarId = normalizeAvatarScope(avatarId);
      const session = await readAsciiBoxSession(services, backend, scopedAvatarId);
      if (!session) {
        res.status(404).json({ error: 'Ascii Box session not found' });
        return;
      }
      const apiKey = await getAsciiBoxApiKey(services);
      if (!apiKey) {
        res.status(409).json({ error: 'Ascii Box API key is not configured', code: 'ASCII_BOX_API_KEY_REQUIRED' });
        return;
      }
      const box = await createAsciiBoxClient(apiKey).stopBox(session.boxId);
      const next: AsciiBoxSession = {
        ...session,
        state: box?.state ?? 'archiving',
        updatedAt: Date.now(),
      };
      await writeAsciiBoxSession(services, next, scopedAvatarId);
      await services.secrets.flush();
      res.json(await asciiBoxStatusPayload(services, backend, scopedAvatarId));
    } catch (err) {
      const safe = safeAsciiError(err);
      res.status(safe.status >= 400 && safe.status < 600 ? safe.status : 500).json({ error: safe.message, code: safe.code });
    }
  });

  app.post('/api/compute/ascii-box/resume', async (req, res) => {
    try {
      const { backend, avatarId } = req.body as { backend?: unknown; avatarId?: unknown };
      if (!isAgentBackendId(backend)) {
        res.status(400).json({ error: 'backend must be a supported agent backend id' });
        return;
      }
      const scopedAvatarId = normalizeAvatarScope(avatarId);
      const session = await readAsciiBoxSession(services, backend, scopedAvatarId);
      if (!session) {
        res.status(404).json({ error: 'Ascii Box session not found' });
        return;
      }
      const apiKey = await getAsciiBoxApiKey(services);
      if (!apiKey) {
        res.status(409).json({ error: 'Ascii Box API key is not configured', code: 'ASCII_BOX_API_KEY_REQUIRED' });
        return;
      }
      const box = await createAsciiBoxClient(apiKey).resumeBox(session.boxId, { noEnv: session.noEnv });
      const next: AsciiBoxSession = {
        ...session,
        state: box?.state ?? 'provisioning',
        endpoint: undefined,
        hostedPort: undefined,
        launchAttemptedAt: undefined,
        runtimeStartedAt: undefined,
        lastError: undefined,
        updatedAt: Date.now(),
      };
      await writeAsciiBoxSession(services, next, scopedAvatarId);
      await services.secrets.deleteSecret(agentRuntimeSecretKey('agent-backend-endpoint', scopedAvatarId)).catch(() => undefined);
      await services.secrets.flush();
      res.json(await asciiBoxStatusPayload(services, backend, scopedAvatarId));
    } catch (err) {
      const safe = safeAsciiError(err);
      res.status(safe.status >= 400 && safe.status < 600 ? safe.status : 500).json({ error: safe.message, code: safe.code });
    }
  });

  app.delete('/api/compute/ascii-box/session', async (req, res) => {
    try {
      const backend = req.query.backend;
      const avatarId = normalizeAvatarScope(req.query.avatarId);
      if (!isAgentBackendId(backend)) {
        res.status(400).json({ error: 'backend query param required' });
        return;
      }
      const session = await readAsciiBoxSession(services, backend, avatarId);
      const apiKey = await getAsciiBoxApiKey(services);
      if (session && apiKey) {
        await createAsciiBoxClient(apiKey).deleteBox(session.boxId).catch(() => undefined);
      }
      await deleteAsciiBoxSession(services, backend, avatarId);
      await services.secrets.deleteSecret(agentRuntimeSecretKey('agent-backend-endpoint', avatarId)).catch(() => undefined);
      await services.secrets.flush();
      res.json({
        provider: 'ascii-box',
        backend,
        configured: Boolean(apiKey),
        connected: Boolean(apiKey),
        supported: true,
        session: null,
      });
    } catch (err) {
      const safe = safeAsciiError(err);
      res.status(safe.status >= 400 && safe.status < 600 ? safe.status : 500).json({ error: safe.message, code: safe.code });
    }
  });

  // ── Runtime supervisor: launch/stop external agent backends ─────────
  const runtimeStatePayload = async (backend: AgentBackendId, avatarId?: string) => {
    const definition = getAgentBackendDefinition(backend);
    const runtimeKey = runtimeSupervisorKey(backend, avatarId);
    const live = supervisor.status(runtimeKey);
    const command =
      live.command ??
      (await readFirstSecretOrNull(services, [
        runtimeSecretKey('launch', backend, avatarId),
        legacyRuntimeSecretKey('launch', backend, avatarId),
      ])) ??
      definition.launch?.command ??
      '';
    const endpoint =
      live.endpoint ??
      (await readFirstSecretOrNull(services, [
        runtimeSecretKey('endpoint', backend, avatarId),
        legacyRuntimeSecretKey('endpoint', backend, avatarId),
      ])) ??
      definition.launch?.endpoint ??
      '';
    return { ...live, backend, command, endpoint, supported: process.platform !== 'win32' };
  };

  app.get('/api/runtime/status', async (req, res) => {
    const backend = req.query.backend;
    const avatarId = normalizeAvatarScope(req.query.avatarId);
    if (!isAgentBackendId(backend)) {
      res.status(400).json({ error: 'backend query param required' });
      return;
    }
    res.json(await runtimeStatePayload(backend, avatarId));
  });

  app.get('/api/runtime/logs', (req, res) => {
    if (!hasConfiguredLocalApiToken(req)) {
      res.status(403).json({ error: 'Local API token required' });
      return;
    }
    const backend = req.query.backend;
    const avatarId = normalizeAvatarScope(req.query.avatarId);
    if (!isAgentBackendId(backend)) {
      res.status(400).json({ error: 'backend query param required' });
      return;
    }
    res.json({ logs: supervisor.logs(runtimeSupervisorKey(backend, avatarId)) });
  });

  app.post('/api/runtime/start', async (req, res) => {
    try {
      const { backend, command, endpoint, avatarId } = req.body as {
        backend?: unknown;
        command?: unknown;
        endpoint?: unknown;
        avatarId?: unknown;
      };
      if (!isAgentBackendId(backend)) {
        res.status(400).json({ error: 'backend must be a supported agent backend id' });
        return;
      }
      const cmd = typeof command === 'string' ? command.trim() : '';
      if (!cmd) {
        res.status(400).json({ error: 'launch command required' });
        return;
      }
      if (!isAllowedRuntimeLaunchCommand(backend, cmd) && !isAuthorizedCustomRuntimeCommand(req)) {
        res.status(400).json({ error: 'Launch command must match a known runtime template' });
        return;
      }
      const ep = typeof endpoint === 'string' ? endpoint.trim() : '';
      const scopedAvatarId = normalizeAvatarScope(avatarId);
      await services.secrets.setSecret(runtimeSecretKey('launch', backend, scopedAvatarId), cmd);
      if (ep) await services.secrets.setSecret(runtimeSecretKey('endpoint', backend, scopedAvatarId), ep);
      await services.secrets.flush();
      supervisor.start(runtimeSupervisorKey(backend, scopedAvatarId), cmd, ep || null);
      res.json(await runtimeStatePayload(backend, scopedAvatarId));
    } catch (err) {
      console.error('[local] runtime start error:', err);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.post('/api/runtime/stop', async (req, res) => {
    const { backend, avatarId } = req.body as { backend?: unknown; avatarId?: unknown };
    if (!isAgentBackendId(backend)) {
      res.status(400).json({ error: 'backend must be a supported agent backend id' });
      return;
    }
    const scopedAvatarId = normalizeAvatarScope(avatarId);
    await supervisor.stopAndWait(runtimeSupervisorKey(backend, scopedAvatarId));
    res.json(await runtimeStatePayload(backend, scopedAvatarId));
  });

  app.post('/api/runtime/restart', async (req, res) => {
    try {
      const { backend, command, endpoint, avatarId } = req.body as {
        backend?: unknown;
        command?: unknown;
        endpoint?: unknown;
        avatarId?: unknown;
      };
      if (!isAgentBackendId(backend)) {
        res.status(400).json({ error: 'backend must be a supported agent backend id' });
        return;
      }
      const scopedAvatarId = normalizeAvatarScope(avatarId);
      const current = await runtimeStatePayload(backend, scopedAvatarId);
      await supervisor.stopAndWait(runtimeSupervisorKey(backend, scopedAvatarId));
      const cmd = (typeof command === 'string' && command.trim()) || current.command;
      const ep = (typeof endpoint === 'string' && endpoint.trim()) || current.endpoint;
      if (cmd) {
        if (!isAllowedRuntimeLaunchCommand(backend, cmd) && !isAuthorizedCustomRuntimeCommand(req)) {
          res.status(400).json({ error: 'Launch command must match a known runtime template' });
          return;
        }
        await services.secrets.setSecret(runtimeSecretKey('launch', backend, scopedAvatarId), cmd);
        if (ep) await services.secrets.setSecret(runtimeSecretKey('endpoint', backend, scopedAvatarId), ep);
        await services.secrets.flush();
        supervisor.start(runtimeSupervisorKey(backend, scopedAvatarId), cmd, ep || null);
      }
      res.json(await runtimeStatePayload(backend, scopedAvatarId));
    } catch (err) {
      console.error('[local] runtime restart error:', err);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Reset a backend's launch command/endpoint back to the built-in default.
  app.delete('/api/runtime/launch', async (req, res) => {
    const backend = req.query.backend;
    const avatarId = normalizeAvatarScope(req.query.avatarId);
    if (!isAgentBackendId(backend)) {
      res.status(400).json({ error: 'backend query param required' });
      return;
    }
    await services.secrets.deleteSecret(runtimeSecretKey('launch', backend, avatarId)).catch(() => undefined);
    await services.secrets.deleteSecret(runtimeSecretKey('endpoint', backend, avatarId)).catch(() => undefined);
    await services.secrets.flush();
    res.json(await runtimeStatePayload(backend, avatarId));
  });

  // Open the user's terminal to run a known install command (visible, allows sudo prompts).
  app.post('/api/runtime/open-terminal', (req, res) => {
    const { command } = req.body as { command?: unknown };
    if (typeof command !== 'string' || !command.trim()) {
      res.status(400).json({ error: 'command required' });
      return;
    }
    const known = new Set(AGENT_BACKENDS.flatMap((b) => b.install.commands));
    if (!known.has(command)) {
      res.status(400).json({ error: 'Unrecognized install command' });
      return;
    }
    if (process.platform !== 'darwin') {
      res.status(501).json({ error: `Run-in-terminal is only supported on macOS right now (platform: ${process.platform}).` });
      return;
    }
    const escaped = command.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const script = `tell application "Terminal"\n  activate\n  do script "${escaped}"\nend tell`;
    execFile('osascript', ['-e', script], (err) => {
      if (err) {
        console.error('[local] open-terminal error:', err);
        res.status(500).json({ error: err.message });
        return;
      }
      res.json({ success: true });
    });
  });

  app.get('/api/avatars', async (_req, res) => {
    try {
      const { listAvatars } = await import(
        '../../admin-api/src/services/avatars.js'
      );
      const avatars = await listAvatars();
      res.json(avatars);
    } catch (err) {
      console.error('[local] Avatars error:', err);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  console.log('[local] Admin API routes mounted');



  app.post("/api/avatars", async (req, res) => {
    try {
      const { createAvatar } = await import("../../admin-api/src/services/avatars.js");
      const session = localAdminSession();
      const { name, description } = req.body as { name?: string; description?: string };
      if (!name) { res.status(400).json({ error: "name required" }); return; }
      const avatar = await createAvatar(name, session, description);
      _signalState.latestAvatarId = avatar.avatarId;
      _signalState.latestPubkey = avatar.identity?.pubkey || null;
      _signalState.latestIdentity = avatar.identity || null;
      res.json(avatar);
    } catch (err) {
      console.error("[local] Create avatar error:", err);
      res.status(500).json({ error: (err as Error).message });
    }
  });
  // ── Avatar sub-routes (secrets, integrations, tokens) ────────────
  app.post("/api/avatars/:id/secrets", async (req, res) => {
    try {
      const { key, value } = req.body as { key?: string; value?: string };
      if (!key || !value) { res.status(400).json({ error: "key and value required" }); return; }
      const secretName = key.includes("_") ? key : `${key}_api_key`;
      console.log(`[local] Saving secret ${secretName} for avatar ${req.params.id}`);
      await services.secrets.setSecret(secretName, value);
      await services.secrets.flush();
      console.log(`[local] Secret ${secretName} saved successfully`);
      res.json({ success: true, message: `${key} stored securely` });
    } catch (err) {
      console.error(`[local] Secret save error for ${req.params.id}:`, err);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get("/api/avatars/:id/secrets", async (_req, res) => {
    try {
      const names = await services.secrets.listSecrets();
      res.json(names);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.post("/api/avatars/:id/validate-token", async (req, res) => {
    try {
      const { type, value } = req.body as { type?: string; value?: string };
      if (!type || !value) { res.status(400).json({ error: "type and value required" }); return; }
      console.log(`[local] Validating token type=${type} for avatar ${req.params.id}`);
      if (type === "telegram_bot_token" || type === "discord_bot_token") {
        const looksValid = value.length > 20;
        res.json({ valid: looksValid, botInfo: looksValid ? { username: "local_bot" } : undefined });
      } else {
        res.json({ valid: true });
      }
    } catch (err) {
      console.error(`[local] Token validation error for ${req.params.id}:`, err);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.post("/api/avatars/:id/validate-ai-key", async (_req, res) => {
    res.json({ valid: true });  // local mode always accepts keys
  });

  app.get("/api/avatars/:id/telegram/diagnose", async (_req, res) => {
    res.json({ status: "not_configured", message: "Telegram not configured in local mode" });
  });

  app.post("/api/avatars/:id/telegram/repair", async (_req, res) => {
    res.json({ success: false, message: "Telegram webhook repair not available in local mode" });
  });

  app.put("/api/avatars/:id", async (req, res) => {
    try {
      const { updateAvatar } = await import("../../admin-api/src/services/avatars.js");
      const session = localAdminSession();
      console.log(`[local] Updating avatar ${req.params.id}:`, JSON.stringify(req.body).slice(0, 200));
      const result = await updateAvatar(req.params.id, req.body, session);
      res.json(result);
    } catch (err) {
      console.error(`[local] Avatar update error for ${req.params.id}:`, err);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.patch("/api/avatars/:id", async (req, res) => {
    try {
      const { updateAvatar } = await import("../../admin-api/src/services/avatars.js");
      const session = localAdminSession();
      const result = await updateAvatar(req.params.id, req.body, session);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.post("/api/avatars/:id/activate", async (req, res) => {
    try {
      const { activateAvatar } = await import("../../admin-api/src/services/avatars.js");
      const session = localAdminSession();
      const result = await activateAvatar(req.params.id, session.userId);
      if (!result.success) {
        res.status(400).json({ error: result.error ?? "Failed to activate avatar" });
        return;
      }
      console.log(`[local] Activated avatar ${req.params.id}`);
      res.json({ success: true, status: "active" });
    } catch (err) {
      console.error(`[local] Activate error for ${req.params.id}:`, err);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.post("/api/avatars/:id/deactivate", async (req, res) => {
    try {
      const { deactivateAvatar } = await import("../../admin-api/src/services/avatars.js");
      const session = localAdminSession();
      const result = await deactivateAvatar(req.params.id, session.userId);
      if (!result.success) {
        res.status(400).json({ error: result.error ?? "Failed to deactivate avatar" });
        return;
      }
      console.log(`[local] Deactivated avatar ${req.params.id}`);
      res.json({ success: true, status: "paused" });
    } catch (err) {
      console.error(`[local] Deactivate error for ${req.params.id}:`, err);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get("/api/avatars/:id/integrations", async (_req, res) => {
    res.json({ integrations: {} });  // local mode: no integrations configured yet
  });

  app.post("/api/avatars/:id/integrations", async (req, res) => {
    try {
      const { updateAvatar } = await import("../../admin-api/src/services/avatars.js");
      const session = localAdminSession();
      const result = await updateAvatar(req.params.id, req.body, session);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get("/api/integrations/models", async (req, res) => {
    try {
      const integration = String(req.query.integration || "");
      // Return a basic model list for the integration
      const models = integration === "openrouter" ? [
        { id: "openai/gpt-4o", name: "GPT-4o", provider: "openai" },
        { id: "anthropic/claude-sonnet-4-20250514", name: "Claude Sonnet 4", provider: "anthropic" },
        { id: "google/gemini-2.5-flash", name: "Gemini 2.5 Flash", provider: "google" },
        { id: "amazon/nova-2-lite-v1", name: "Nova 2 Lite", provider: "amazon" },
      ] : [];
      res.json({ models });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get("/api/avatars/:id/discord/status", async (_req, res) => {
    res.json({ connected: false, mode: "bot" });
  });

  app.get("/api/avatars/:id", async (req, res) => {
    try {
      const { getAvatar } = await import("../../admin-api/src/services/avatars.js");
      const avatar = await getAvatar(req.params.id);
      res.json(avatar);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Resume chat after tool result ───────────────────────────────
  app.post("/api/avatars/:id/tools/:toolCallId", async (req, res) => {
    try {
      const { result } = req.body as { result?: unknown };
      if (result === undefined) { res.status(400).json({ error: "result is required" }); return; }
      const { resumeChatAfterToolResult } = await import(
        "../../admin-api/src/handlers/chat.js"
      );
      const session = localAdminSession();
      const resumed = await resumeChatAfterToolResult({
        avatarId: req.params.id,
        toolCallId: req.params.toolCallId,
        result,
        session,
      });
      res.json({
        response: resumed.response,
        history: resumed.history,
        media: resumed.media,
        pendingJobs: resumed.pendingJobs,
        pendingToolCall: resumed.pendingToolCall,
        avatarUpdates: resumed.avatarUpdates,
      });
    } catch (err) {
      console.error(`[local] Tool resume error for ${req.params.id}:`, err);
      res.status(400).json({ error: (err as Error).message });
    }
  });

}

function mountStubRoutes(app: express.Express) {
  app.post('/api/chat', async (_req, res) => {
    res.json({ response: 'Chat endpoint (stub).', history: [] });
  });
  app.get('/api/avatars', async (_req, res) => {
    res.json({ avatars: [] });
  });
}
