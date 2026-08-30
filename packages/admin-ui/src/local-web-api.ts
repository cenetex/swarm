type LocalAvatar = {
  avatarId: string;
  name: string;
  description?: string;
  persona?: string;
  status: 'shell' | 'configured' | 'active' | 'error' | 'draft' | 'paused';
  createdAt: number;
  updatedAt: number;
  createdBy: string;
  slotType?: 'free' | 'orb' | 'nft';
  mediaConfig?: { enabled: boolean; provider?: string };
  voiceConfig?: { enabled: boolean; provider?: string };
  platforms?: {
    telegram?: { enabled: boolean; botUsername?: string };
    twitter?: { enabled: boolean; username?: string };
    discord?: { enabled: boolean; guildId?: string };
  };
  profileImage?: { url: string; updatedAt?: number };
  llmConfig?: Record<string, unknown>;
};

type LocalState = {
  avatars: LocalAvatar[];
  chats: Record<string, Array<{ role: string; content: string; media?: unknown[] }>>;
  agentBackends: Record<string, {
    backend: string;
    endpoint?: string;
    deploymentTarget: 'local' | 'ascii-box';
  }>;
  hostingMode?: 'local' | 'hosted';
  hostingSubstrate?: 'fly' | 'aws' | 'ascii-box';
  consentAcceptedAt?: number;
  credentialMigrationRequired?: boolean;
};

const STORAGE_KEY = 'swarm:web-local:v1';
const MAX_CHAT_MESSAGES = 100;

const isBrowser = typeof window !== 'undefined' && typeof localStorage !== 'undefined';

export function isWebLocalHostAllowed(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
}

export function shouldInstallLocalWebApi(): boolean {
  if (!isBrowser) return false;
  if (!isWebLocalHostAllowed(window.location.hostname)) return false;
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};
  if (env.VITE_WEB_LOCAL === '1' || env.VITE_SWARM_WEB_LOCAL === '1') return true;
  const params = new URLSearchParams(window.location.search);
  return params.get('local') === '1';
}

function sanitizeChatHistory(value: unknown): LocalState['chats'] {
  if (!value || typeof value !== 'object') return {};
  const histories: LocalState['chats'] = {};
  for (const [avatarId, history] of Object.entries(value)) {
    if (!Array.isArray(history)) continue;
    histories[avatarId] = history
      .filter((message): message is { role: string; content: string; media?: unknown[] } => (
        Boolean(message)
        && typeof message === 'object'
        && typeof (message as { role?: unknown }).role === 'string'
        && typeof (message as { content?: unknown }).content === 'string'
      ))
      .slice(-MAX_CHAT_MESSAGES);
  }
  return histories;
}

export function readLocalWebState(): LocalState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const legacyBackends = parsed.agentBackends && typeof parsed.agentBackends === 'object'
        ? parsed.agentBackends as Record<string, Record<string, unknown>>
        : {};
      const agentBackends = Object.fromEntries(
        Object.entries(legacyBackends).map(([scope, backend]) => [scope, {
          backend: typeof backend.backend === 'string' ? backend.backend : 'swarm-native',
          endpoint: typeof backend.endpoint === 'string' ? backend.endpoint : undefined,
          deploymentTarget: backend.deploymentTarget === 'ascii-box' ? 'ascii-box' as const : 'local' as const,
        }]),
      );
      const hadPlaintextCredentials = Boolean(
        parsed.secrets
        || parsed.avatarSecrets
        || Object.values(legacyBackends).some((backend) => typeof backend.apiKey === 'string'),
      );
      const credentialMigrationRequired = hadPlaintextCredentials || parsed.credentialMigrationRequired === true;
      const chatHistoryRequiredSanitizing = parsed.chats && typeof parsed.chats === 'object'
        ? Object.values(parsed.chats).some((history) => !Array.isArray(history) || history.length > MAX_CHAT_MESSAGES)
        : Boolean(parsed.chats);
      const sanitized: LocalState = {
        ...emptyState(),
        avatars: Array.isArray(parsed.avatars) ? parsed.avatars as LocalAvatar[] : [],
        chats: sanitizeChatHistory(parsed.chats),
        agentBackends,
        hostingMode: parsed.hostingMode === 'hosted' ? 'hosted' : 'local',
        hostingSubstrate: parsed.hostingSubstrate === 'fly'
          || parsed.hostingSubstrate === 'aws'
          || parsed.hostingSubstrate === 'ascii-box'
          ? parsed.hostingSubstrate
          : undefined,
        consentAcceptedAt: typeof parsed.consentAcceptedAt === 'number' ? parsed.consentAcceptedAt : undefined,
        credentialMigrationRequired,
      };
      if (hadPlaintextCredentials || chatHistoryRequiredSanitizing) {
        writeState(sanitized);
      }
      return sanitized;
    }
  } catch {
    // Fall through to a fresh local store.
  }
  return emptyState();
}

function emptyState(): LocalState {
  return {
    avatars: [],
    chats: {},
    agentBackends: {},
  };
}

function writeState(state: LocalState): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function localHostingStatus(_state: LocalState) {
  return {
    mode: 'local' as const,
    local: {
      available: true,
      running: true,
      label: 'This browser',
      detail: 'Runs in this browser tab. Use the native app for encrypted local secrets and runtime supervision.',
    },
    hosted: {
      available: false,
      configured: false,
      label: 'Hosted 24/7',
      priceUsdMonthly: 9,
      provider: 'external' as const,
      architecture: 'not-configured',
      status: 'not-configured' as const,
      entitlement: 'none' as const,
      detail: 'Hosted service is not available from browser-local mode. Use the native app after hosted checkout and provisioning are connected.',
    },
  };
}

function localHostingSubstratesStatus(state: LocalState) {
  return {
    ...(state.hostingSubstrate ? { selected: state.hostingSubstrate } : {}),
    providers: [
      {
        id: 'fly',
        label: 'Fly',
        cliInstalled: false,
        authenticated: false,
        enabled: false,
        detail: 'Browser build cannot read local Fly auth. Connect in Fly, then use the native app for one-click provision.',
        loginCommand: 'fly auth login',
        connectUrl: 'https://fly.io/docs/flyctl/auth-login/',
        connectLabel: 'Connect Fly',
      },
      {
        id: 'aws',
        label: 'AWS',
        cliInstalled: false,
        authenticated: false,
        enabled: false,
        detail: 'Browser build cannot read local AWS SSO. Connect AWS locally, then use the native app for one-click provision.',
        loginCommand: 'aws sso login',
        connectUrl: 'https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-sso.html',
        connectLabel: 'Connect AWS',
      },
      {
        id: 'ascii-box',
        label: 'Ascii Box',
        cliInstalled: false,
        authenticated: false,
        enabled: false,
        detail: 'Browser build cannot read Box auth. Start the Box quickstart, then use the native app for one-click provision.',
        loginCommand: 'box login',
        connectUrl: 'https://docs.ascii.dev/box/quickstart',
        connectLabel: 'Connect Box',
      },
    ],
  };
}

function json(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data), {
    status: init.status ?? 200,
    headers: {
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

function localUser() {
  return {
    authenticated: true,
    user: {
      walletAddress: 'local-web',
      displayName: 'Local Web',
      email: 'local@rati.chat',
    },
    account: {
      accountId: 'local-web',
      role: 'admin',
      identities: [{ type: 'wallet', providerId: 'local-web' }],
    },
    gateStatus: {
      nftsHeld: 1,
      avatarsCreated: 0,
      availableSlots: 999,
      canCreate: true,
      canAbandon: true,
      ownedNFTs: [],
    },
  };
}

function toPublicAvatar(avatar: LocalAvatar): LocalAvatar {
  return {
    ...avatar,
    avatarId: avatar.avatarId,
    status: avatar.status,
  };
}

function defaultAssistantReply(message: string, avatar?: LocalAvatar): string {
  const target = avatar?.name || 'this avatar';
  if (/personality|persona|style|voice/i.test(message)) {
    return `Got it. I saved that direction for ${target}. You can keep refining the personality here, and this web build will keep the state in this browser.`;
  }
  if (/runtime|backend|hermes|cosy|codex|eliza|openclaw/i.test(message)) {
    return `Use the Run Swarm panel to choose local or hosted mode. Advanced runtime endpoints are remembered in localStorage.`;
  }
  if (/download|desktop|native|mac|windows|linux/i.test(message)) {
    return 'Use the Native clients panel to open the latest desktop release for macOS, Windows, or Linux.';
  }
  return `I am running in browser-local mode. I can help configure ${target}, but anything that needs a server, OAuth callback, or background worker should use the native client.`;
}

function estimateLocalTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function localPersonaDiff(oldPersona: string, newPersona: string) {
  const oldLines = oldPersona.trim().split('\n').filter((line) => line.trim().length > 0);
  const newLines = newPersona.trim().split('\n').filter((line) => line.trim().length > 0);
  const oldSet = new Set(oldLines);
  const newSet = new Set(newLines);
  return {
    added: newLines.filter((line) => !oldSet.has(line)),
    removed: oldLines.filter((line) => !newSet.has(line)),
  };
}

const AGENT_BACKENDS = [
  {
    id: 'swarm-native',
    name: 'Swarm Native',
    description: 'Built-in browser-local Swarm chat and avatar state.',
    authMode: 'none',
    requiresEndpoint: false,
    contextWindow: 4096,
    install: { summary: 'Built in. No install required for the web-local client.', commands: [] },
    capabilities: { chat: true, tools: true, memory: true, autonomousLoop: false, codeExecution: false, multimodal: false },
  },
  {
    id: 'hermes',
    name: 'Hermes',
    description: 'External Hermes-compatible agent runtime reached through a configured HTTP endpoint.',
    authMode: 'api-key',
    requiresEndpoint: true,
    contextWindow: 4096,
    install: {
      summary: 'Install Hermes Agent, complete portal setup, then start the local proxy.',
      commands: ['curl -fsSL https://hermes-agent.nousresearch.com/install.sh | sh', 'hermes setup --portal'],
      docsUrl: 'https://hermes-agent.nousresearch.com/docs/',
      endpointHint: 'The web client remembers the Hermes endpoint in localStorage.',
    },
    launch: { command: 'hermes proxy start --port 8645', endpoint: 'http://localhost:8645' },
    cloud: { asciiBox: { command: 'hermes proxy start --host 0.0.0.0 --port 8645', endpointHint: 'Provision Hermes on Ascii Box from the native client.' } },
    capabilities: { chat: true, tools: true, memory: true, autonomousLoop: true, codeExecution: false, multimodal: false },
  },
  {
    id: 'cosyworld',
    name: 'CosyWorld',
    description: 'Sibling ../cosyworld runtime for world, avatar, Discord, memory, and story systems.',
    authMode: 'api-key',
    requiresEndpoint: true,
    contextWindow: 4096,
    install: {
      summary: 'Use the sibling ../cosyworld checkout locally, or paste a hosted endpoint.',
      commands: ['cd ../cosyworld && npm install', 'cd ../cosyworld && WEB_PORT=3101 npm run dev'],
      endpointHint: 'The web client remembers the CosyWorld endpoint in localStorage.',
    },
    launch: { command: 'cd ../cosyworld && WEB_PORT=3101 npm run dev', endpoint: 'http://localhost:3101' },
    cloud: { asciiBox: { command: 'cd ../cosyworld && HOST=0.0.0.0 WEB_PORT=3101 npm run dev', endpointHint: 'Provision CosyWorld on Ascii Box from the native client.' } },
    capabilities: { chat: true, tools: true, memory: true, autonomousLoop: true, codeExecution: false, multimodal: true },
  },
  {
    id: 'codex',
    name: 'Codex',
    description: 'Local Codex CLI runtime for code-aware agent work.',
    authMode: 'local-process',
    requiresEndpoint: false,
    contextWindow: 4096,
    install: { summary: 'Install Codex CLI locally and sign in.', commands: ['curl -fsSL https://chatgpt.com/codex/install.sh | sh', 'codex'], docsUrl: 'https://developers.openai.com/codex/cli' },
    capabilities: { chat: true, tools: true, memory: false, autonomousLoop: true, codeExecution: true, multimodal: false },
  },
  {
    id: 'custom',
    name: 'Custom',
    description: 'Bring your own agent backend through an HTTP endpoint.',
    authMode: 'api-key',
    requiresEndpoint: true,
    contextWindow: 4096,
    install: { summary: 'Run any custom agent service, then paste its HTTP endpoint.', commands: [], endpointHint: 'Paste the custom agent backend endpoint.' },
    capabilities: { chat: true, tools: true, memory: false, autonomousLoop: false, codeExecution: false, multimodal: false },
  },
];

function backendStatus(state: LocalState, avatarId?: string) {
  const key = avatarId || 'global';
  const stored = state.agentBackends[key] ?? { backend: 'swarm-native', deploymentTarget: 'local' as const };
  const selectedBackend = AGENT_BACKENDS.find((backend) => backend.id === stored.backend) ?? AGENT_BACKENDS[0];
  const endpoint = stored.endpoint || (stored.deploymentTarget === 'local' ? selectedBackend.launch?.endpoint : undefined);
  return {
    selected: selectedBackend.id,
    selectedBackend,
    configured: selectedBackend.id === 'swarm-native' || selectedBackend.authMode === 'local-process' || !selectedBackend.requiresEndpoint || Boolean(endpoint),
    endpoint,
    hasApiKey: false,
    deploymentTarget: stored.deploymentTarget,
    scope: avatarId ? { avatarId, label: `Avatar ${avatarId}` } : { label: 'New agents' },
    backends: AGENT_BACKENDS,
  };
}

export function routeLocalApi(request: Request): Response | Promise<Response> | null {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/api')) return null;

  const path = url.pathname.slice('/api'.length) || '/';
  const method = request.method.toUpperCase();
  const state = readLocalWebState();

  if (path === '/health') return json({ ok: true, mode: 'web-local' });
  if (path === '/auth/me') return json(localUser());
  if (path === '/auth/logout' && method === 'POST') return json({ ok: true });
  if (path.startsWith('/oauth/twitter/status/')) return json({ connected: false });
  if (path === '/hosting/status' && method === 'GET') {
    return json(localHostingStatus(state));
  }
  if (path === '/hosting/substrates/status' && method === 'GET') {
    return json(localHostingSubstratesStatus(state));
  }
  if (path === '/hosting/substrates/select' && method === 'POST') {
    return readJson(request).then((body) => {
      const provider = body.provider === 'fly' || body.provider === 'aws' || body.provider === 'ascii-box'
        ? body.provider
        : undefined;
      if (!provider) return json({ error: 'provider must be fly, aws, or ascii-box' }, { status: 400 });
      return json({ error: 'Native app required', status: localHostingSubstratesStatus(state) }, { status: 409 });
    });
  }
  if (path === '/hosting/mode' && method === 'POST') {
    return readJson(request).then((body) => {
      if (body.mode === 'hosted') {
        return json({
          error: 'Hosted checkout and provisioning are not available in browser-local mode.',
          status: localHostingStatus(state),
        }, { status: 501 });
      }
      state.hostingMode = 'local';
      writeState(state);
      return json(localHostingStatus(state));
    });
  }
  if (path === '/hosting/provision' && method === 'POST') {
    return json({
      error: 'Hosted checkout and provisioning are not available in browser-local mode.',
      status: localHostingStatus(state),
    }, { status: 501 });
  }

  if (path.startsWith('/consent')) {
    const policyVersion = url.searchParams.get('policyVersion') || '1.3';
    if (method === 'POST') {
      return readJson(request).then((body) => {
        const acceptedAt = Date.now();
        state.consentAcceptedAt = acceptedAt;
        writeState(state);
        return json({
          consent: {
            policyVersion: String(body.policyVersion || policyVersion),
            acceptedAt,
            status: 'active',
          },
        });
      });
    }
    return json({
      consented: true,
      consent: {
        policyVersion,
        acceptedAt: state.consentAcceptedAt ?? Date.now(),
        status: 'active',
      },
    });
  }

  if (path === '/avatars' && method === 'GET') return json(state.avatars.map(toPublicAvatar));
  if (path === '/avatars' && method === 'POST') {
    return readJson(request).then((body) => {
      const now = Date.now();
      const name = String(body.name || `Avatar ${state.avatars.length + 1}`);
      const avatar: LocalAvatar = {
        avatarId: `avatar-${now.toString(36)}`,
        name,
        description: typeof body.description === 'string' ? body.description : undefined,
        status: 'draft',
        createdAt: now,
        updatedAt: now,
        createdBy: 'local-web',
        slotType: 'free',
        mediaConfig: { enabled: false },
        voiceConfig: { enabled: false },
        platforms: {},
      };
      state.avatars.unshift(avatar);
      state.chats[avatar.avatarId] = [{
        role: 'assistant',
        content: `Hi! I'm ${name}. Talk to me to configure my integrations.`,
      }];
      writeState(state);
      return json(toPublicAvatar(avatar));
    });
  }
  if (path === '/avatars/health') return json({ avatars: [] });
  if (path === '/avatars/scan-nft' && method === 'POST') {
    return json({ created: [], skippedAlreadyClaimed: 0, available: 0, capped: false });
  }

  const avatarMatch = path.match(/^\/avatars\/([^/]+)(?:\/([^/]+))?/);
  if (avatarMatch) {
    const avatarId = decodeURIComponent(avatarMatch[1]);
    const action = avatarMatch[2];
    const avatar = state.avatars.find((item) => item.avatarId === avatarId);
    if (!avatar) return json({ error: 'Avatar not found' }, { status: 404 });

    if (!action && method === 'GET') return json(toPublicAvatar(avatar));
    if (!action && method === 'DELETE') {
      state.avatars = state.avatars.filter((item) => item.avatarId !== avatarId);
      delete state.chats[avatarId];
      writeState(state);
      return json({ ok: true });
    }
    if (!action && (method === 'PUT' || method === 'PATCH')) {
      return readJson(request).then((body) => {
        Object.assign(avatar, body, { updatedAt: Date.now(), status: avatar.status === 'draft' ? 'configured' : avatar.status });
        writeState(state);
        return json(toPublicAvatar(avatar));
      });
    }
    if (action === 'persona' && path.endsWith('/persona/preview') && method === 'POST') {
      return readJson(request).then((body) => {
        const persona = typeof body.persona === 'string' ? body.persona.trim() : '';
        if (!persona) return json({ error: 'persona must be a non-empty string' }, { status: 400 });
        const currentPersona = avatar.persona || '';
        const oldTokens = estimateLocalTokens(currentPersona);
        const newTokens = estimateLocalTokens(persona);
        return json({
          systemPrompt: `You are ${avatar.name}.\n\n${persona}`,
          diff: localPersonaDiff(currentPersona, persona),
          tokenDelta: newTokens - oldTokens,
          preview: {
            oldLength: currentPersona.length,
            newLength: persona.length,
            oldTokens,
            newTokens,
          },
        });
      });
    }
    if (action === 'persona' && path.endsWith('/persona/history') && method === 'GET') {
      return json({ avatarId, personas: [], total: 0 });
    }
    if (action === 'persona' && method === 'GET') {
      return json({ avatarId, name: avatar.name, persona: avatar.persona || '' });
    }
    if (action === 'persona' && method === 'PATCH') {
      return readJson(request).then((body) => {
        const persona = typeof body.persona === 'string' ? body.persona.trim() : '';
        if (!persona) return json({ error: 'persona must be a non-empty string' }, { status: 400 });
        const oldTokens = estimateLocalTokens(avatar.persona || '');
        avatar.persona = persona;
        avatar.updatedAt = Date.now();
        writeState(state);
        return json({
          avatarId,
          name: avatar.name,
          persona,
          updatedAt: avatar.updatedAt,
          updatedBy: 'local-web',
          tokenDelta: estimateLocalTokens(persona) - oldTokens,
        });
      });
    }
    if (action === 'activate' && method === 'POST') {
      avatar.status = 'active';
      avatar.updatedAt = Date.now();
      writeState(state);
      return json({ success: true, status: 'active' });
    }
    if (action === 'deactivate' && method === 'POST') {
      avatar.status = 'paused';
      avatar.updatedAt = Date.now();
      writeState(state);
      return json({ success: true, status: 'paused' });
    }
    if (action === 'secrets' && method === 'POST') {
      return json({
        error: 'The native app credential store is required for avatar secrets.',
        code: 'NATIVE_CREDENTIAL_STORE_REQUIRED',
      }, { status: 501 });
    }
    if (action === 'energy') return json({ avatarId, current: 100, max: 100, nextRefillIn: 0, refillPerHour: 0, baseRefillPerHour: 0, bonusRefillPerHour: 0, ownerTokenBalance: 0 });
    if (action === 'gallery') return json({ items: [] });
    if (action === 'integrations') return json({ integrations: {} });
    if (action === 'discord') return json({ connected: false, mode: 'bot' });
    if (action === 'telegram') return json({ connected: false });
  }

  if (path === '/chat' && method === 'GET') {
    const avatarId = url.searchParams.get('avatarId') || 'global';
    return json({ history: state.chats[avatarId] ?? [] });
  }
  if (path === '/chat' && method === 'DELETE') {
    const avatarId = url.searchParams.get('avatarId') || 'global';
    state.chats[avatarId] = [];
    writeState(state);
    return json({ history: [] });
  }
  if (path === '/chat/message' && method === 'POST') {
    return readJson(request).then((body) => {
      const avatarId = String(body.avatarId || 'global');
      const message = body.message as { role?: string; content?: string } | undefined;
      state.chats[avatarId] = [
        ...(state.chats[avatarId] ?? []),
        { role: message?.role || 'assistant', content: message?.content || '' },
      ].slice(-MAX_CHAT_MESSAGES);
      writeState(state);
      return json({ history: state.chats[avatarId] });
    });
  }
  if (path === '/chat' && method === 'POST') {
    return readJson(request).then((body) => {
      const message = String(body.message || '');
      const avatarId = (body.avatar as { id?: string } | undefined)?.id || 'global';
      const avatar = state.avatars.find((item) => item.avatarId === avatarId);
      const history = [...(body.history as Array<{ role: string; content: string }> || [])];
      const reply = defaultAssistantReply(message, avatar);
      const nextHistory = [
        ...history,
        { role: 'user', content: message },
        { role: 'assistant', content: reply },
      ].slice(-MAX_CHAT_MESSAGES);
      state.chats[avatarId] = nextHistory;
      writeState(state);
      return json({ response: reply, history: nextHistory });
    });
  }

  if (path === '/llm/status') {
    return json({
      configured: false,
      provider: null,
      selectedProvider: null,
      openrouter: { configured: false },
      ollama: { available: false, endpoint: 'http://localhost:11434/v1' },
      credentialMigrationRequired: Boolean(state.credentialMigrationRequired),
    });
  }
  if (path === '/llm/provider' && method === 'POST') {
    return json({
      error: 'The native app is required to configure an AI provider securely.',
      code: 'NATIVE_CREDENTIAL_STORE_REQUIRED',
    }, { status: 501 });
  }
  if (path === '/llm/provider' && method === 'DELETE') {
    return json({ success: true });
  }
  if (path === '/secrets/llm-api-key') {
    if (method === 'GET') {
      return json({
        exists: false,
        credentialMigrationRequired: Boolean(state.credentialMigrationRequired),
      });
    }
    if (method === 'PUT' || method === 'POST') {
      return json({
        error: 'The native app credential store is required for provider API keys.',
        code: 'NATIVE_CREDENTIAL_STORE_REQUIRED',
      }, { status: 501 });
    }
  }

  if (path === '/agent-backends') {
    return json(backendStatus(state, url.searchParams.get('avatarId') || undefined));
  }
  if (path === '/agent-backends/select' && method === 'POST') {
    return readJson(request).then((body) => {
      if (typeof body.apiKey === 'string' && body.apiKey.trim()) {
        return json({
          error: 'The native app credential store is required for backend API keys.',
          code: 'NATIVE_CREDENTIAL_STORE_REQUIRED',
        }, { status: 501 });
      }
      const avatarId = typeof body.avatarId === 'string' ? body.avatarId : undefined;
      const key = avatarId || 'global';
      state.agentBackends[key] = {
        backend: String(body.backend || 'swarm-native'),
        endpoint: typeof body.endpoint === 'string' ? body.endpoint : undefined,
        deploymentTarget: body.deploymentTarget === 'ascii-box' ? body.deploymentTarget : 'local',
      };
      writeState(state);
      return json(backendStatus(state, avatarId));
    });
  }
  if (path === '/agent-backends/select' && method === 'DELETE') {
    delete state.agentBackends[url.searchParams.get('avatarId') || 'global'];
    writeState(state);
    return json(backendStatus(state, url.searchParams.get('avatarId') || undefined));
  }

  if (path.startsWith('/compute/ascii-box/')) {
    if (path === '/compute/ascii-box/onboarding/status' && method === 'GET') {
      return json({
        provider: 'ascii-box',
        readyForApiProvisioning: false,
        apiKeyConfigured: false,
        cliInstalled: false,
        installCommand: 'curl -fsSL https://box.ascii.dev/install | sh',
        docsUrl: 'https://docs.ascii.dev/box/quickstart',
        freeTrial: {
          available: true,
          days: 7,
          detail: 'Ascii Box onboarding requires the native/local server.',
        },
      });
    }
    if (path === '/compute/ascii-box/onboarding/start' && method === 'POST') {
      return json({
        provider: 'ascii-box',
        readyForApiProvisioning: false,
        apiKeyConfigured: false,
        cliInstalled: false,
        installCommand: 'curl -fsSL https://box.ascii.dev/install | sh',
        docsUrl: 'https://docs.ascii.dev/box/quickstart',
        freeTrial: {
          available: true,
          days: 7,
          detail: 'Ascii Box onboarding requires the native/local server.',
        },
        error: 'Ascii Box quickstart requires the native/local server.',
      }, { status: 501 });
    }
    const backend = url.searchParams.get('backend') || 'swarm-native';
    if (path.endsWith('/status') && method === 'GET') {
      return json({
        provider: 'ascii-box',
        backend,
        configured: false,
        connected: false,
        supported: false,
        session: null,
        error: 'Ascii Box provisioning requires the native/local server.',
      });
    }
    return json({ error: 'Ascii Box provisioning requires the native/local server.' }, { status: 501 });
  }

  if (path.startsWith('/runtime/')) {
    const backend = url.searchParams.get('backend') || 'swarm-native';
    const definition = AGENT_BACKENDS.find((item) => item.id === backend);
    if (path.endsWith('/logs')) return json({ logs: ['Browser web client cannot supervise native processes. Use a native client to launch runtimes.'] });
    return json({
      backend,
      running: false,
      pid: null,
      startedAt: null,
      command: definition?.launch?.command ?? '',
      endpoint: definition?.launch?.endpoint ?? '',
      exitCode: null,
      lastError: null,
      supported: false,
    });
  }

  if (path.startsWith('/jobs')) return json(path === '/jobs' ? { count: 0, jobs: [] } : { status: 'completed' });
  if (path.startsWith('/shared-chat')) return json({ messages: [] });
  if (path.startsWith('/prompt-preview')) return json({ systemPrompt: '', tools: [] });
  if (path.startsWith('/issues')) return json({ issues: [] });

  return json({ error: `Web-local route not implemented: ${path}` }, { status: 404 });
}

export function installLocalWebApi(): void {
  if (!shouldInstallLocalWebApi()) return;
  const originalFetch = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const routed = routeLocalApi(request);
    if (routed) return Promise.resolve(routed);
    return originalFetch(input, init);
  };
  document.documentElement.dataset.swarmWebLocal = 'true';
}
