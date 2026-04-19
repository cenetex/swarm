/**
 * Signal Station Tools.
 *
 * MCP tools for governing stations in the Signal space mining game.
 * An avatar can observe station state (inventory, asteroids, players,
 * contracts) and issue commands (set prices, build modules, set hail).
 */
import { z } from 'zod';
import { defineTool, defineReadonlyTool, type ToolResult } from '../registry.js';

// =============================================================================
// Service Interface
// =============================================================================

export interface StationState {
  station: {
    index: number;
    name: string;
    signal_range: number;
    scaffold: boolean;
    inventory: Record<string, number>;
    modules: Array<{
      type: string;
      ring: number;
      slot: number;
      scaffold: boolean;
      progress: number;
    }>;
  };
  visible_asteroids: Array<{
    index: number;
    tier: number;
    commodity: number;
    x: number;
    y: number;
    hp: number;
  }>;
  visible_players: Array<{
    id: number;
    x: number;
    y: number;
    docked: boolean;
  }>;
  visible_stations: Array<{
    index: number;
    name: string;
    x: number;
    y: number;
    signal_overlap: boolean;
  }>;
  active_contracts: Array<{
    index: number;
    action: number;
    commodity: number;
    quantity: number;
    base_price: number;
    age: number;
  }>;
  hail: string;
}

export interface CommandResult {
  ok: boolean;
  action?: string;
  error?: string;
  [key: string]: unknown;
}

export interface ChannelMessage {
  id: number;
  timestamp: number;
  sender_station_id: number;
  text: string;
  audio_url?: string;
}

export interface ChannelReadResponse {
  messages: ChannelMessage[];
}

export interface ChannelPostResponse {
  ok: boolean;
  id: number;
  timestamp: number;
}

export interface SignalStationServices {
  getStationState: (stationId: number) => Promise<StationState>;
  sendCommand: (stationId: number, command: Record<string, unknown>) => Promise<CommandResult>;
  readChannelMessages: (since?: number, limit?: number) => Promise<ChannelReadResponse>;
  postChannelMessage: (stationId: number, text: string, audioUrl?: string) => Promise<ChannelPostResponse>;
}

// =============================================================================
// Constants
// =============================================================================

const COMMODITY_NAMES = [
  'ferrite_ore', 'cuprite_ore', 'crystal_ore',
  'ferrite_ingot', 'cuprite_ingot', 'crystal_ingot',
  'frame', 'laser_module', 'tractor_module',
] as const;

const MODULE_TYPES = [
  'Dock', 'Hopper', 'Iron Furnace', 'Copper Furnace', 'Crystal Furnace',
  'Repair Bay', 'Signal Relay', 'Frame Press', 'Laser Fab', 'Tractor Fab',
  'Ore Silo', 'Shipyard', 'Cargo Bay',
] as const;

// =============================================================================
// Tool Definitions
// =============================================================================

export const createSignalStationTools = (services: SignalStationServices) => [
  defineReadonlyTool({
    name: 'signal_station_state',
    description:
      'Get the current state of a Signal space mining station. Returns inventory levels, ' +
      'installed modules, visible asteroids and players within signal range, active contracts, ' +
      'and the hail message. Use this to observe the world before making decisions.',
    toolset: 'signal-station',
    inputSchema: z.object({
      station_id: z.number().int().min(0).max(7).describe('Station index (0-7)'),
    }),
    execute: async (input, _context): Promise<ToolResult> => {
      try {
        const state = await services.getStationState(input.station_id);
        return { success: true, data: state };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to get station state',
        };
      }
    },
  }),

  defineTool({
    name: 'signal_set_price',
    description:
      'Set the buy/sell price for a commodity at a station. Prices are clamped to ±50% of ' +
      'the default base price. Use this to attract players to sell ore you need or to ' +
      'discourage selling commodities you have excess of. Commodities: ' +
      COMMODITY_NAMES.join(', '),
    category: 'signal-station',
    inputSchema: z.object({
      station_id: z.number().int().min(0).max(7).describe('Station index (0-7)'),
      commodity: z.number().int().min(0).max(8).describe(
        'Commodity index: 0=ferrite_ore, 1=cuprite_ore, 2=crystal_ore, ' +
        '3=ferrite_ingot, 4=cuprite_ingot, 5=crystal_ingot, ' +
        '6=frame, 7=laser_module, 8=tractor_module'
      ),
      price: z.number().positive().describe('Price per unit (will be clamped to ±50% of default)'),
    }),
    execute: async (input, _context): Promise<ToolResult> => {
      try {
        const result = await services.sendCommand(input.station_id, {
          action: 'set_price',
          commodity: input.commodity,
          price: input.price,
        });
        if (!result.ok) {
          return { success: false, error: result.error || 'Command failed' };
        }
        return {
          success: true,
          data: {
            commodity: COMMODITY_NAMES[input.commodity] || `commodity_${input.commodity}`,
            price: result.price ?? input.price,
          },
        };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to set price',
        };
      }
    },
  }),

  defineTool({
    name: 'signal_build_module',
    description:
      'Start construction of a new module at a station. The server picks the placement slot ' +
      'automatically. Modules expand station capabilities: furnaces smelt ore into ingots, ' +
      'fabs produce ship components, docks allow player docking, etc. Module types: ' +
      MODULE_TYPES.map((name, i) => `${i}=${name}`).join(', '),
    category: 'signal-station',
    inputSchema: z.object({
      station_id: z.number().int().min(0).max(7).describe('Station index (0-7)'),
      module_type: z.number().int().min(0).max(12).describe(
        'Module type: 0=Dock, 1=Hopper, 2=Iron Furnace, 3=Copper Furnace, ' +
        '4=Crystal Furnace, 5=Repair Bay, 6=Signal Relay, 7=Frame Press, ' +
        '8=Laser Fab, 9=Tractor Fab, 10=Ore Silo, 11=Shipyard, 12=Cargo Bay'
      ),
    }),
    execute: async (input, _context): Promise<ToolResult> => {
      try {
        const result = await services.sendCommand(input.station_id, {
          action: 'build_module',
          module_type: input.module_type,
        });
        if (!result.ok) {
          return { success: false, error: result.error || 'Build failed' };
        }
        return {
          success: true,
          data: {
            module: MODULE_TYPES[input.module_type] || `module_${input.module_type}`,
          },
        };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to build module',
        };
      }
    },
  }),

  defineTool({
    name: 'signal_set_hail',
    description:
      'Set the hail message broadcast by a station. This is visible to players approaching ' +
      'the station. Use it to communicate station status, welcome messages, trade offers, ' +
      'or roleplay as the station governor.',
    category: 'signal-station',
    inputSchema: z.object({
      station_id: z.number().int().min(0).max(7).describe('Station index (0-7)'),
      message: z.string().min(1).max(200).describe('Hail message (max 200 chars)'),
    }),
    execute: async (input, _context): Promise<ToolResult> => {
      try {
        const result = await services.sendCommand(input.station_id, {
          action: 'set_hail',
          hail: input.message,
        });
        if (!result.ok) {
          return { success: false, error: result.error || 'Command failed' };
        }
        return { success: true, data: { hail: input.message } };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to set hail',
        };
      }
    },
  }),

  defineReadonlyTool({
    name: 'signal_channel_read',
    description:
      'Read recent messages from the ensemble station-band channel. Returns messages posted by ' +
      'the three stations (Helios, Kepler, Prospect) including their hail updates and audio URLs. ' +
      'Use this to see what other stations are broadcasting and stay in character with the ensemble.',
    toolset: 'signal-station',
    inputSchema: z.object({
      limit: z.number().int().min(1).max(100).optional().describe('Max messages to fetch (default 10)'),
      since: z.number().int().min(0).optional().describe('Fetch only messages with id > this value'),
    }),
    execute: async (input, _context): Promise<ToolResult> => {
      try {
        const response = await services.readChannelMessages(input.since, input.limit);
        return { success: true, data: response };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to read channel',
        };
      }
    },
  }),

  defineTool({
    name: 'signal_channel_post',
    description:
      'Post a message to the ensemble station-band channel so other stations can see your hail ' +
      'and any generated audio. Include your station ID, the message text, and optionally a URL ' +
      'to the generated audio file.',
    category: 'signal-station',
    inputSchema: z.object({
      station_id: z.number().int().min(0).max(7).describe('Station index (0-7)'),
      text: z.string().min(1).max(200).describe('Message text (max 200 chars)'),
      audio_url: z.string().url().optional().describe('Optional URL to audio file'),
    }),
    execute: async (input, _context): Promise<ToolResult> => {
      try {
        const result = await services.postChannelMessage(input.station_id, input.text, input.audio_url);
        if (!result.ok) {
          return { success: false, error: 'Failed to post message' };
        }
        return {
          success: true,
          data: {
            id: result.id,
            timestamp: result.timestamp,
            text: input.text,
            audio_url: input.audio_url,
          },
        };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to post to channel',
        };
      }
    },
  }),
];

export default createSignalStationTools;
