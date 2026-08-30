import type {
  Integrity,
  Origin,
  Receipt,
  ReceiptFeed,
  SourceStatus,
  SystemName,
} from '../../receipt-types';

export const dynamic = 'force-dynamic';

type JsonRecord = Record<string, unknown>;

type SourceConfig = {
  system: SystemName;
  url: () => string | undefined;
  token: () => string | undefined;
  tokenHeader: string;
  unconfigured: string;
  normalize: (body: JsonRecord) => Receipt[];
};

const MAX_SOURCE_BYTES = 1_000_000;
const MAX_RECEIPTS_PER_SOURCE = 100;
const SOURCE_TIMEOUT_MS = 6_000;

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown, fallback = ''): string {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return fallback;
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function displayName(value: string, fallback: string): string {
  const cleaned = value
    .replace(/[._:-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return fallback;
  return cleaned.replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function compactId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 72);
}

function sourceId(system: SystemName, record: JsonRecord, index: number): string {
  const prefix = {
    Raticross: 'rati',
    Signal: 'sig',
    CosyWorld: 'cosy',
    Swarm: 'swm',
  }[system];
  const candidate = asString(
    record.receipt_hash
      ?? record.id
      ?? record.eventId
      ?? record.event_id
      ?? record.seq
      ?? record.timestamp,
    `${Date.now()}-${index}`,
  );
  return `${prefix}_${compactId(candidate)}`;
}

function timestampValue(value: unknown): number | null {
  if (typeof value === 'string') {
    const parsedDate = Date.parse(value);
    if (Number.isFinite(parsedDate)) return parsedDate;
  }
  const parsed = asNumber(value);
  if (parsed === null) return null;
  return parsed < 10_000_000_000 ? parsed * 1_000 : parsed;
}

function observed(value: unknown, sequence?: unknown): {
  time: string;
  date: string;
  observedAt: string | null;
} {
  const timestamp = timestampValue(value);
  if (timestamp !== null) {
    const date = new Date(timestamp);
    if (!Number.isNaN(date.getTime())) {
      return {
        time: date.toLocaleTimeString('en-GB', {
          timeZone: 'UTC',
          hour12: false,
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        }),
        date: date.toLocaleDateString('en-GB', {
          timeZone: 'UTC',
          day: '2-digit',
          month: 'short',
          year: 'numeric',
        }),
        observedAt: date.toISOString(),
      };
    }
  }
  const seq = asString(sequence);
  return {
    time: seq ? `SEQ ${seq}` : 'NO CLOCK',
    date: seq ? 'Canonical order' : 'Time not emitted',
    observedAt: null,
  };
}

function safeValue(value: unknown, depth = 0): unknown {
  if (depth > 3) return '[truncated]';
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return value.slice(0, 300);
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => safeValue(item, depth + 1));
  if (typeof value !== 'object') return String(value).slice(0, 100);

  return Object.fromEntries(
    Object.entries(value as JsonRecord)
      .slice(0, 40)
      .map(([key, item]) => [
        key,
        /secret|token|pass|auth|cookie|private|content|message|prompt/i.test(key)
          ? '[redacted]'
          : safeValue(item, depth + 1),
      ]),
  );
}

function safePayload(value: unknown): Record<string, unknown> {
  return asRecord(safeValue(asRecord(value)));
}

function normalizeOrigin(value: unknown, actor: string): Origin {
  const origin = asString(value).toLowerCase();
  if (origin === 'human' || origin === 'agent' || origin === 'timer' || origin === 'system' || origin === 'replay') {
    return origin;
  }
  if (/human|owner|admin|player|user/.test(actor.toLowerCase())) return 'human';
  if (/timer|tick|cron|schedule/.test(actor.toLowerCase())) return 'timer';
  if (/replay/.test(actor.toLowerCase())) return 'replay';
  if (/agent|avatar|worker/.test(actor.toLowerCase())) return 'agent';
  return 'system';
}

function baseReceipt(
  system: SystemName,
  record: JsonRecord,
  index: number,
  options: {
    actor: string;
    title: string;
    summary: string;
    integrity: Integrity;
    algorithm: string;
    proof: string;
    timestamp?: unknown;
    sequence?: unknown;
    parent?: string;
    hash?: string;
    origin?: unknown;
    payload?: unknown;
  },
): Receipt {
  const marks = {
    Raticross: { mark: 'R', color: 'coral' as const },
    Signal: { mark: 'S', color: 'blue' as const },
    CosyWorld: { mark: 'C', color: 'gold' as const },
    Swarm: { mark: 'W', color: 'violet' as const },
  };
  const when = observed(options.timestamp, options.sequence);
  const parent = options.parent || 'none';
  return {
    id: sourceId(system, record, index),
    system,
    ...marks[system],
    title: options.title,
    actor: options.actor,
    actorNote: options.sequence ? `sequence · ${asString(options.sequence)}` : 'upstream evidence',
    origin: normalizeOrigin(options.origin, options.actor),
    ...when,
    integrity: options.integrity,
    algorithm: options.algorithm,
    summary: options.summary,
    parent,
    parentLabel: parent === 'none' ? 'No causal link emitted' : 'Upstream causal link',
    hash: options.hash || 'not emitted',
    duration: 'not emitted',
    replay: 'Source record retained',
    proof: options.proof,
    path: [
      { label: 'Source read', note: `${system} returned a bounded evidence record`, ms: 'source' },
      { label: 'Shape checked', note: 'Unsafe and secret-like fields were removed', ms: 'adapter' },
      { label: 'Receipt normalized', note: 'The source record was mapped without upgrading its proof level', ms: 'site' },
    ],
    changes: [],
    payload: safePayload(options.payload ?? record),
  };
}

function normalizeCosyWorld(body: JsonRecord): Receipt[] {
  return asArray(body.events).slice(-MAX_RECEIPTS_PER_SOURCE).reverse().map((value, index) => {
    const event = asRecord(value);
    const sequence = event.seq;
    const type = asString(event.type, 'world event');
    const success = event.success !== false;
    const actorName = asString(event.actor_name);
    const actorId = asString(event.actor_id);
    const actor = actorName || (actorId ? `player:${actorId}` : 'system:cosyworld');
    return baseReceipt('CosyWorld', event, index, {
      actor,
      title: displayName(type, 'World Event'),
      summary: success
        ? `CosyWorld committed ${type} to its canonical action journal.`
        : `CosyWorld recorded a rejected ${type} action in its canonical journal.`,
      integrity: success ? 'recorded' : 'review',
      algorithm: 'SQLite action journal',
      proof: 'This proves the event is present in CosyWorld’s canonical journal and has a stable sequence. The current feed does not emit a cryptographic signature.',
      sequence,
      parent: event.caused_by_event_seq ? `cosy_${asString(event.caused_by_event_seq)}` : undefined,
      origin: event.origin,
      payload: event,
    });
  });
}

function normalizeSignal(body: JsonRecord): Receipt[] {
  const source = asRecord(body.source);
  return asArray(body.receipts).slice(-MAX_RECEIPTS_PER_SOURCE).reverse().map((value, index) => {
    const receipt = asRecord(value);
    const event = asRecord(receipt.event);
    const provenance = asRecord(receipt.provenance);
    const mining = asRecord(receipt.mining);
    const signatureVerified = source.verified === true && provenance.station_signature_verified === true;
    const eventId = event.event_id;
    const station = asString(receipt.station_pubkey_b58 || receipt.station_pubkey, 'unknown station');
    return baseReceipt('Signal', receipt, index, {
      actor: `station:${station.slice(0, 12)}`,
      title: displayName(asString(event.kind, 'chain event'), 'Chain Event'),
      summary: `Signal derived a deterministic RATi receipt for event ${asString(eventId, 'unknown')}.`,
      integrity: signatureVerified ? 'verified' : 'review',
      algorithm: signatureVerified ? 'Ed25519 chain log' : 'Unverified chain receipt',
      proof: signatureVerified
        ? 'The station signature and append-only chain were verified before this receipt was derived. Mining semantics remain station-attested unless the receipt says otherwise.'
        : 'The upstream record did not prove both the chain and station signature. It must be reviewed before it is trusted.',
      sequence: eventId,
      parent: asString(event.prev_hash) || undefined,
      hash: asString(receipt.receipt_hash || event.event_hash) || undefined,
      origin: 'system',
      payload: { event, provenance, mining, claim_match_status: receipt.claim_match_status },
    });
  });
}

function swarmRecords(body: JsonRecord): unknown[] {
  if (Array.isArray(body.items)) return body.items;
  if (Array.isArray(body.events)) return body.events;
  if (Array.isArray(body.logs)) return body.logs;
  return [];
}

function normalizeSwarm(body: JsonRecord): Receipt[] {
  const avatarId = asString(body.avatarId, 'unknown');
  return swarmRecords(body).slice(0, MAX_RECEIPTS_PER_SOURCE).map((value, index) => {
    const item = asRecord(value);
    const data = asRecord(item.data);
    const kind = asString(item.eventType || item.event || item.jobType || item.type, 'activity');
    const level = asString(item.level).toUpperCase();
    const status = asString(item.status).toLowerCase();
    const needsReview = level === 'ERROR' || status === 'failed' || status === 'open';
    const actor = asString(item.actorId)
      || asString(data.actorId)
      || (avatarId === 'unknown' ? 'system:swarm' : `avatar:${avatarId}`);
    const hash = asString(data.digest || data.hash || item.digest || item.hash);
    return baseReceipt('Swarm', item, index, {
      actor,
      title: displayName(kind, 'Activity Recorded'),
      summary: `Swarm recorded ${kind} in its operational evidence store.`,
      integrity: needsReview ? 'review' : 'recorded',
      algorithm: asString(body.source, 'DynamoDB / CloudWatch'),
      proof: 'This proves Swarm recorded the operational event. It is not a cryptographic attestation unless the source record contains a separately verifiable digest.',
      timestamp: item.timestamp,
      sequence: item.id || item.jobId || item.requestId,
      parent: asString(item.requestId || data.parentId) || undefined,
      hash: hash || undefined,
      origin: item.origin || item.actorType || item.type,
      payload: item,
    });
  });
}

function raticrossRecords(body: JsonRecord): unknown[] {
  if (Array.isArray(body.envelopes)) return body.envelopes;
  if (Array.isArray(body.receipts)) return body.receipts;
  if (Array.isArray(body.logs)) return body.logs;
  if (Array.isArray(body.items)) return body.items;
  return [];
}

function normalizeRaticross(body: JsonRecord): Receipt[] {
  return raticrossRecords(body).slice(0, MAX_RECEIPTS_PER_SOURCE).map((value, index) => {
    const item = asRecord(value);
    const from = asRecord(item.from);
    const meta = asRecord(item.meta);
    const kind = asString(item.type || item.event, 'boundary envelope');
    const signatureVerified = item.signature_verified === true || meta.signature_verified === true;
    const rejected = item.ok === false || asString(item.status).toLowerCase() === 'rejected';
    const actor = asString(from.agentId || item.actor, 'system:raticross');
    return baseReceipt('Raticross', item, index, {
      actor: from.system ? `${asString(from.system)}:${actor}` : actor,
      title: displayName(kind, 'Boundary Envelope'),
      summary: `Raticross captured ${kind} at the system boundary.`,
      integrity: rejected ? 'review' : signatureVerified ? 'verified' : 'recorded',
      algorithm: signatureVerified ? 'Verified envelope signature' : 'Boundary log',
      proof: signatureVerified
        ? 'The upstream bridge says the envelope signature was verified. The normalized record preserves that claim and its source fields.'
        : 'This proves the boundary event was observed. Raticross does not yet expose a canonical signed receipt journal, so this is not upgraded to verified.',
      timestamp: item.timestamp,
      sequence: item.id || item.envelopeId,
      parent: asString(item.traceId || item.conversationId) || undefined,
      hash: asString(item.hash || meta.digest) || undefined,
      origin: item.origin || 'agent',
      payload: item,
    });
  });
}

const SOURCES: SourceConfig[] = [
  {
    system: 'Raticross',
    url: () => process.env.RATICROSS_RECEIPTS_URL,
    token: () => process.env.RATICROSS_RECEIPTS_TOKEN,
    tokenHeader: 'x-raticross-key',
    unconfigured: 'Boundary logging exists; no receipt feed URL is configured.',
    normalize: normalizeRaticross,
  },
  {
    system: 'Signal',
    url: () => process.env.SIGNAL_RECEIPTS_URL,
    token: () => process.env.SIGNAL_RECEIPTS_TOKEN,
    tokenHeader: 'authorization',
    unconfigured: 'Verified chain receipts exist; an HTTP feed still needs to be exposed.',
    normalize: normalizeSignal,
  },
  {
    system: 'CosyWorld',
    url: () => process.env.COSYWORLD_RECEIPTS_URL,
    token: () => process.env.COSYWORLD_MODERATION_TOKEN,
    tokenHeader: 'authorization',
    unconfigured: 'The canonical journal is ready; its moderation URL and token are not configured.',
    normalize: normalizeCosyWorld,
  },
  {
    system: 'Swarm',
    url: () => process.env.SWARM_RECEIPTS_URL,
    token: () => process.env.SWARM_RECEIPTS_TOKEN,
    tokenHeader: 'authorization',
    unconfigured: 'Operational evidence is ready; a scoped server token is not configured.',
    normalize: normalizeSwarm,
  },
];

function sourceUrl(raw: string): URL {
  const url = new URL(raw);
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(process.env.NODE_ENV !== 'production' && local)) {
    throw new Error('Source URLs must use HTTPS.');
  }
  return url;
}

async function readSource(config: SourceConfig): Promise<{
  receipts: Receipt[];
  status: SourceStatus;
}> {
  const rawUrl = config.url()?.trim();
  if (!rawUrl) {
    return {
      receipts: [],
      status: { system: config.system, state: 'unconfigured', detail: config.unconfigured, receiptCount: 0 },
    };
  }

  try {
    const url = sourceUrl(rawUrl);
    const token = config.token()?.trim();
    const headers: Record<string, string> = { accept: 'application/json' };
    if (token) {
      headers[config.tokenHeader] = config.tokenHeader === 'authorization' ? `Bearer ${token}` : token;
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), SOURCE_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(url, { headers, cache: 'no-store', signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) throw new Error(`Upstream returned ${response.status}`);
    const text = await response.text();
    if (text.length > MAX_SOURCE_BYTES) throw new Error('Upstream response was too large');
    const body = asRecord(JSON.parse(text));
    const receipts = config.normalize(body).slice(0, MAX_RECEIPTS_PER_SOURCE);
    return {
      receipts,
      status: {
        system: config.system,
        state: receipts.length ? 'live' : 'empty',
        detail: receipts.length ? 'Connected to the real source.' : 'Connected; the source returned no receipts.',
        receiptCount: receipts.length,
      },
    };
  } catch {
    return {
      receipts: [],
      status: {
        system: config.system,
        state: 'error',
        detail: 'Configured, but the source could not be read safely.',
        receiptCount: 0,
      },
    };
  }
}

export async function GET(): Promise<Response> {
  const results = await Promise.all(SOURCES.map(readSource));
  const receipts = results
    .flatMap((result) => result.receipts)
    .sort((left, right) => {
      const leftTime = left.observedAt ? Date.parse(left.observedAt) : 0;
      const rightTime = right.observedAt ? Date.parse(right.observedAt) : 0;
      return rightTime - leftTime;
    });
  const feed: ReceiptFeed = {
    mode: 'live',
    generatedAt: new Date().toISOString(),
    receipts,
    sources: results.map((result) => result.status),
  };

  return Response.json(feed, {
    headers: {
      'cache-control': 'no-store, max-age=0',
      'x-content-type-options': 'nosniff',
    },
  });
}
