/**
 * Signal Station MCP Services
 *
 * HTTP client for the Signal space mining game station REST API.
 * Connects aws-swarm avatars to the game server so they can govern
 * stations: observe state, set prices, build modules, broadcast hails.
 */
import type { SignalStationServices, StationState, CommandResult } from '@swarm/mcp-server';

const SIGNAL_API_BASE = process.env.SIGNAL_API_URL || 'https://signal-ws.ratimics.com';

export function createSignalStationServices(
  apiToken: string,
): SignalStationServices {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${apiToken}`,
  };

  return {
    getStationState: async (stationId) => {
      const res = await fetch(`${SIGNAL_API_BASE}/api/station/${stationId}/state`, { headers });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Station state failed (${res.status}): ${body}`);
      }
      return res.json() as Promise<StationState>;
    },

    sendCommand: async (stationId, command) => {
      const res = await fetch(`${SIGNAL_API_BASE}/api/station/${stationId}/command`, {
        method: 'POST',
        headers,
        body: JSON.stringify(command),
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Station command failed (${res.status}): ${body}`);
      }
      return res.json() as Promise<CommandResult>;
    },
  };
}
