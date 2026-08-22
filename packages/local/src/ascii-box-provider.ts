export type AsciiBoxState =
  | 'init'
  | 'provisioning'
  | 'provisioned'
  | 'cloning'
  | 'ready'
  | 'idle'
  | 'running'
  | 'archiving'
  | 'archived'
  | 'error';

export type AsciiBox = {
  id: string;
  name?: string | null;
  state: AsciiBoxState;
  url?: string | null;
  ip?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  archiveAfter?: string | null;
  desktopAvailable?: boolean;
  desktopUrl?: string | null;
  snapshotAvailable?: boolean;
  snapshotCompletedAt?: string | null;
  subdomain?: string | null;
};

export type AsciiBoxSession = {
  provider: 'ascii-box';
  backend: string;
  boxId: string;
  state: AsciiBoxState;
  endpoint?: string;
  hostedPort?: number;
  noEnv: boolean;
  ttlSeconds: number | null;
  createdAt: number;
  updatedAt: number;
  launchAttemptedAt?: number;
  runtimeStartedAt?: number;
  lastError?: string;
};

type BoxEnvelope = {
  ok?: boolean;
  box?: AsciiBox;
  status?: AsciiBoxState;
  id?: string;
  code?: string;
  message?: string;
  error?: { code?: string; message?: string; status?: number; details?: Record<string, unknown> };
};

type CommandResponse = {
  ok?: boolean;
  success?: boolean;
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
  timedOut?: boolean;
};

export type AsciiBoxCliOnboardingResult = {
  authenticated: boolean;
  loginUrl?: string;
  checkoutUrl?: string;
  url?: string;
  nextCommand?: string;
  message?: string;
};

export class AsciiBoxApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AsciiBoxApiError';
  }
}

export type AsciiBoxClientOptions = {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
};

const DEFAULT_ASCII_BOX_BASE_URL = 'https://ascii.dev/api/box/v1';
const SECRET_QUERY_KEYS = new Set(['_token', 'token', 'access_token', 'auth', 'key']);

export function redactAsciiBoxUrl(value: string): string {
  try {
    const url = new URL(value);
    for (const key of [...url.searchParams.keys()]) {
      if (SECRET_QUERY_KEYS.has(key.toLowerCase())) {
        url.searchParams.set(key, '[REDACTED]');
      }
    }
    return url.toString();
  } catch {
    return value.replace(/([?&](?:_token|token|access_token|auth|key)=)[^&\s]+/gi, '$1[REDACTED]');
  }
}

export function redactAsciiBoxText(value: string): string {
  return value
    .replace(/\bbox_[A-Za-z0-9_-]{12,}\b/g, 'box_[REDACTED]')
    .replace(/\bhttps?:\/\/[^\s"'<>]+/g, (url) => redactAsciiBoxUrl(url));
}

export function parsePortFromEndpoint(endpoint: string | undefined): number | undefined {
  if (!endpoint) return undefined;
  try {
    const port = Number(new URL(endpoint).port);
    return Number.isInteger(port) && port > 0 ? port : undefined;
  } catch {
    const match = endpoint.match(/:(\d{2,5})(?:\/|$)/);
    if (!match) return undefined;
    const port = Number(match[1]);
    return Number.isInteger(port) && port > 0 ? port : undefined;
  }
}

export function firstUrlFromText(text: string): string | undefined {
  return text.match(/https?:\/\/[^\s"'<>]+/)?.[0];
}

function readStringField(value: unknown, patterns: RegExp[]): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  for (const [key, item] of Object.entries(record)) {
    if (typeof item === 'string' && patterns.some((pattern) => pattern.test(key))) {
      return item;
    }
  }
  return undefined;
}

function collectCliObjects(text: string): Array<Record<string, unknown>> {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        const parsed = JSON.parse(line);
        return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
      } catch {
        return null;
      }
    })
    .filter((value): value is Record<string, unknown> => value !== null);
}

export function parseAsciiBoxCliOnboardingOutput(stdout: string, stderr = ''): AsciiBoxCliOnboardingResult {
  const text = `${stdout}\n${stderr}`;
  const events = collectCliObjects(text);
  const joinedKinds = events
    .map((event) => `${event.type ?? ''} ${event.event ?? ''} ${event.status ?? ''} ${event.code ?? ''}`)
    .join(' ')
    .toLowerCase();
  const loginUrl = events
    .map((event) => readStringField(event, [/^login_?url$/i, /^auth(?:orization)?_?url$/i]))
    .find(Boolean);
  const checkoutUrl = events
    .map((event) => readStringField(event, [/checkout.*url/i, /billing.*url/i, /trial.*url/i]))
    .find(Boolean);
  const nextCommand = events
    .map((event) => readStringField(event, [/^next_?command$/i]))
    .find(Boolean);
  const message = events
    .map((event) => readStringField(event, [/^message$/i, /^detail$/i]))
    .filter(Boolean)
    .at(-1);
  const url = loginUrl ?? checkoutUrl ?? firstUrlFromText(text);

  return {
    authenticated: /login_complete|authenticated|already_authenticated|success/.test(joinedKinds),
    ...(loginUrl ? { loginUrl } : {}),
    ...(checkoutUrl ? { checkoutUrl } : {}),
    ...(url ? { url } : {}),
    ...(nextCommand ? { nextCommand } : {}),
    ...(message ? { message: redactAsciiBoxText(message) } : {}),
  };
}

export function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function sanitizeAsciiBoxForClient(box: AsciiBox): Omit<AsciiBox, 'desktopUrl'> & { desktopUrl?: string | null } {
  return {
    ...box,
    desktopUrl: box.desktopUrl ? redactAsciiBoxUrl(box.desktopUrl) : box.desktopUrl,
  };
}

export class AsciiBoxClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: AsciiBoxClientOptions) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_ASCII_BOX_BASE_URL).replace(/\/$/, '');
    this.fetchImpl = options.fetchImpl ?? fetch;
    if (!options.apiKey.trim()) {
      throw new AsciiBoxApiError('Ascii Box API key is not configured.', 401, 'missing_api_key');
    }
    this.apiKey = options.apiKey.trim();
  }

  private readonly apiKey: string;

  async createBox(input: { ttlSeconds?: number | null; noEnv?: boolean }): Promise<AsciiBox> {
    const body: Record<string, unknown> = {
      ttlSeconds: input.ttlSeconds === undefined ? 3600 : input.ttlSeconds,
      noEnv: input.noEnv ?? true,
    };
    const envelope = await this.request<BoxEnvelope>('/boxes', {
      method: 'POST',
      body,
    });
    if (!envelope.box) throw new AsciiBoxApiError('Ascii Box create response did not include a box.', 502, 'invalid_response');
    return envelope.box;
  }

  async getBox(boxId: string): Promise<AsciiBox> {
    const envelope = await this.request<BoxEnvelope>(`/boxes/${encodeURIComponent(boxId)}`);
    if (!envelope.box) throw new AsciiBoxApiError('Ascii Box info response did not include a box.', 502, 'invalid_response');
    return envelope.box;
  }

  async stopBox(boxId: string): Promise<AsciiBox | null> {
    const envelope = await this.request<BoxEnvelope>(`/boxes/${encodeURIComponent(boxId)}/stop`, { method: 'POST' });
    return envelope.box ?? null;
  }

  async resumeBox(boxId: string, input: { noEnv?: boolean } = {}): Promise<AsciiBox | null> {
    const envelope = await this.request<BoxEnvelope>(`/boxes/${encodeURIComponent(boxId)}/resume`, {
      method: 'POST',
      body: input,
    });
    return envelope.box ?? null;
  }

  async deleteBox(boxId: string): Promise<void> {
    await this.request<BoxEnvelope>(`/boxes/${encodeURIComponent(boxId)}`, { method: 'DELETE' });
  }

  async command(
    boxId: string,
    command: string,
    options: { cwd?: string; timeoutSeconds?: number } = {},
  ): Promise<CommandResponse> {
    return this.request<CommandResponse>(`/boxes/${encodeURIComponent(boxId)}/commands`, {
      method: 'POST',
      body: {
        command,
        ...(options.cwd ? { cwd: options.cwd } : {}),
        ...(options.timeoutSeconds ? { timeoutSeconds: options.timeoutSeconds } : {}),
      },
    });
  }

  private async request<T>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: options.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });

    const text = await response.text();
    let parsed: unknown = {};
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { message: text };
      }
    }

    if (!response.ok) {
      const body = parsed as BoxEnvelope;
      const code = body.error?.code ?? body.code;
      const message = body.error?.message ?? body.message ?? `Ascii Box request failed with HTTP ${response.status}`;
      throw new AsciiBoxApiError(message, response.status, code, body.error?.details);
    }

    return parsed as T;
  }
}
