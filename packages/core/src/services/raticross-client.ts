/**
 * Raticross Bridge Client
 *
 * Provides send/receive and health-check capabilities against a paired
 * raticross relay endpoint. Used by Swarm avatars to communicate with
 * external agent systems (e.g., Kyro).
 */
import { randomUUID } from 'crypto';
import { logger } from '../utils/logger.js';
import {
  RATICROSS_PROTOCOL_VERSION,
  type RaticrossActor,
  type RaticrossBridgeConfig,
  type RaticrossContext,
  type RaticrossEnvelope,
  type RaticrossEnvelopeType,
  type RaticrossHealthRequest,
  type RaticrossHealthResponse,
  type RaticrossMeta,
  type RaticrossSendResult,
} from '../types/raticross.js';

const DEFAULT_TIMEOUT_MS = 10_000;

export interface RaticrossBridgeClient {
  /**
   * Send an envelope to the remote system via the relay.
   */
  send(params: {
    fromAgentId: string;
    toAgentId: string;
    conversationId: string;
    content: string;
    type?: RaticrossEnvelopeType;
    traceId?: string;
    context?: RaticrossContext;
    meta?: RaticrossMeta;
  }): Promise<RaticrossSendResult>;

  /**
   * Check health/connectivity of the remote relay endpoint.
   * Returns the parsed health response or an error.
   */
  healthCheck(fromAgentId?: string): Promise<RaticrossHealthResponse>;

  /**
   * Returns the underlying configuration (for diagnostics).
   */
  getConfig(): Readonly<RaticrossBridgeConfig>;
}

/**
 * Create a raticross bridge client.
 *
 * @param config - Bridge connection configuration
 * @param fetchImpl - Optional fetch implementation for testing
 */
export function createRaticrossBridgeClient(
  config: RaticrossBridgeConfig,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): RaticrossBridgeClient {
  const relayUrl = config.relayUrl.replace(/\/+$/, '');
  const localSystem = config.localSystem ?? 'swarm';
  const remoteSystem = config.remoteSystem ?? 'kyro';
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  function buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (config.relayKey) {
      headers['x-raticross-key'] = config.relayKey;
    }
    return headers;
  }

  async function send(params: {
    fromAgentId: string;
    toAgentId: string;
    conversationId: string;
    content: string;
    type?: RaticrossEnvelopeType;
    traceId?: string;
    context?: RaticrossContext;
    meta?: RaticrossMeta;
  }): Promise<RaticrossSendResult> {
    const id = randomUUID();
    const envelope: RaticrossEnvelope = {
      id,
      traceId: params.traceId,
      protocol: RATICROSS_PROTOCOL_VERSION,
      timestamp: Date.now(),
      from: {
        system: localSystem,
        agentId: params.fromAgentId,
      } as RaticrossActor,
      to: {
        system: remoteSystem,
        agentId: params.toAgentId,
      } as RaticrossActor,
      type: params.type ?? 'message',
      conversationId: params.conversationId,
      content: params.content,
      context: params.context,
      meta: params.meta,
    };

    try {
      const response = await fetchImpl(`${relayUrl}/raticross/inbound`, {
        method: 'POST',
        headers: buildHeaders(),
        body: JSON.stringify(envelope),
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        logger.error('Raticross bridge send rejected', undefined, {
          event: 'bridge_send_rejected',
          subsystem: 'raticross-client',
          status: response.status,
          body,
          envelopeId: id,
        });
        return { ok: false, id, error: `HTTP ${response.status}: ${body}` };
      }

      logger.info('Raticross bridge message sent', {
        event: 'bridge_send_ok',
        subsystem: 'raticross-client',
        envelopeId: id,
        fromAgent: params.fromAgentId,
        toAgent: params.toAgentId,
        remoteSystem,
      });

      return { ok: true, id };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('Raticross bridge send failed', err, {
        event: 'bridge_send_error',
        subsystem: 'raticross-client',
        envelopeId: id,
      });
      return { ok: false, id, error: message };
    }
  }

  async function healthCheck(fromAgentId = 'health-probe'): Promise<RaticrossHealthResponse> {
    const req: RaticrossHealthRequest = {
      type: 'health',
      timestamp: Date.now(),
      from: { system: localSystem, agentId: fromAgentId },
      protocol: RATICROSS_PROTOCOL_VERSION,
    };

    try {
      const response = await fetchImpl(`${relayUrl}/raticross/health`, {
        method: 'POST',
        headers: buildHeaders(),
        body: JSON.stringify(req),
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!response.ok) {
        return {
          ok: false,
          system: remoteSystem,
          protocol: RATICROSS_PROTOCOL_VERSION,
          timestamp: Date.now(),
        };
      }

      const body = (await response.json()) as RaticrossHealthResponse;
      return {
        ok: true,
        system: body.system ?? remoteSystem,
        protocol: body.protocol ?? RATICROSS_PROTOCOL_VERSION,
        timestamp: body.timestamp ?? Date.now(),
        uptime: body.uptime,
        agents: body.agents,
      };
    } catch (err) {
      logger.error('Raticross health check failed', err, {
        event: 'health_check_error',
        subsystem: 'raticross-client',
      });
      return {
        ok: false,
        system: remoteSystem,
        protocol: RATICROSS_PROTOCOL_VERSION,
        timestamp: Date.now(),
      };
    }
  }

  function getConfig(): Readonly<RaticrossBridgeConfig> {
    return { ...config };
  }

  return { send, healthCheck, getConfig };
}
