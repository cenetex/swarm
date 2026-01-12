/**
 * Voice Tools
 *
 * Tools for audio transcription and voice generation.
 */
import { z } from 'zod';
import { defineTool, type ToolResult } from '../registry.js';

// ============================================================================
// Service Interface
// ============================================================================

export interface VoiceTranscriptSegment {
  startMs: number;
  endMs: number;
  text: string;
}

export interface VoiceTranscription {
  text: string;
  language?: string;
  confidence?: number;
  segments?: VoiceTranscriptSegment[];
}

export interface VoiceSeed {
  assetId: string;
  url: string;
  durationMs?: number;
}

export interface VoiceCloneResult {
  voiceId: string;
  status: 'creating' | 'ready' | 'failed';
  previewAssetId?: string;
}

export interface VoiceProfileResult {
  voiceId: string;
  status: 'creating' | 'ready' | 'failed';
}

export interface VoiceMessage {
  assetId: string;
  url: string;
  durationMs?: number;
  format?: 'ogg' | 'mp3' | 'wav';
}

export interface VoiceServices {
  transcribeAudio: (params: {
    assetId?: string;
    url?: string;
    platformFileId?: string;
    language?: string;
    model?: string;
    diarize?: boolean;
  }) => Promise<VoiceTranscription>;
  createVoiceSeed: (params: {
    prompt: string;
    durationMs: number;
    styleTags?: string[];
    negativeTags?: string[];
  }) => Promise<VoiceSeed>;
  cloneVoiceFromSeed: (params: {
    seedAssetId: string;
    name?: string;
  }) => Promise<VoiceCloneResult>;
  createVoiceProfile: (params: {
    seedPrompt?: string;
    seedAssetId?: string;
    voiceName?: string;
  }) => Promise<VoiceProfileResult>;
  setActiveVoiceProfile: (params: {
    agentId: string;
    voiceId: string;
  }) => Promise<void>;
  generateVoiceMessage: (params: {
    agentId: string;
    platform: string;
    text: string;
    voiceId?: string;
    format?: 'ogg' | 'mp3' | 'wav';
    speed?: number;
    pitch?: number;
    emotion?: string;
    maxDurationMs?: number;
  }) => Promise<VoiceMessage>;
  sendVoiceMessage: (params: {
    agentId: string;
    platform: string;
    conversationId: string;
    assetId?: string;
    url?: string;
    caption?: string;
    replyToMessageId?: string;
  }) => Promise<{ success: boolean }>;
}

// ============================================================================
// Tool Definitions
// ============================================================================

const audioSourceSchema = z.object({
  assetId: z.string().optional().describe('Audio asset ID (preferred)'),
  url: z.string().optional().describe('Public URL to audio file'),
  platformFileId: z.string().optional().describe('Platform-specific file ID'),
  language: z.string().optional().describe('Language hint (e.g., en, es)'),
  model: z.string().optional().describe('Transcription model name'),
  diarize: z.boolean().optional().describe('Enable speaker diarization'),
});

export const createVoiceTools = (services: VoiceServices) => [
  defineTool({
    name: 'transcribe_audio',
    description: 'Transcribe an audio asset into text for agent understanding. Provide assetId, url, or platformFileId.',
    category: 'media',
    inputSchema: audioSourceSchema,
    execute: async (input): Promise<ToolResult> => {
      if (!input.assetId && !input.url && !input.platformFileId) {
        return { success: false, error: 'Provide assetId, url, or platformFileId' };
      }
      const result = await services.transcribeAudio(input);
      return { success: true, data: result };
    },
  }),

  defineTool({
    name: 'create_voice_seed',
    description: 'Generate a seed audio clip for voice cloning.',
    category: 'media',
    inputSchema: z.object({
      prompt: z.string().min(1).describe('Prompt describing the desired voice or sound'),
      durationMs: z.number().min(1000).max(30000).describe('Seed audio duration in milliseconds'),
      styleTags: z.array(z.string()).optional().describe('Optional style tags'),
      negativeTags: z.array(z.string()).optional().describe('Optional negative tags'),
    }),
    execute: async (input): Promise<ToolResult> => {
      const result = await services.createVoiceSeed(input);
      return { success: true, data: result };
    },
  }),

  defineTool({
    name: 'clone_voice_from_seed',
    description: 'Create a voice clone from a seed audio clip.',
    category: 'config',
    inputSchema: z.object({
      seedAssetId: z.string().min(1).describe('Audio asset ID to clone from'),
      name: z.string().optional().describe('Optional name for the voice'),
    }),
    execute: async (input): Promise<ToolResult> => {
      const result = await services.cloneVoiceFromSeed(input);
      return { success: true, data: result };
    },
  }),

  defineTool({
    name: 'create_voice_profile',
    description: 'Create or update a voice profile for the agent.',
    category: 'config',
    inputSchema: z.object({
      seedPrompt: z.string().optional().describe('Prompt for seed generation (if no seedAssetId)'),
      seedAssetId: z.string().optional().describe('Seed audio asset ID'),
      voiceName: z.string().optional().describe('Name for this voice profile'),
    }),
    execute: async (input): Promise<ToolResult> => {
      const result = await services.createVoiceProfile(input);
      return { success: true, data: result };
    },
  }),

  defineTool({
    name: 'set_active_voice_profile',
    description: 'Set the active/default voice profile for the agent.',
    category: 'config',
    inputSchema: z.object({
      voiceId: z.string().min(1).describe('Voice profile ID to activate'),
    }),
    execute: async (input, context): Promise<ToolResult> => {
      await services.setActiveVoiceProfile({
        agentId: context.agentId,
        voiceId: input.voiceId,
      });
      return { success: true, data: { message: 'Active voice profile updated' } };
    },
  }),

  defineTool({
    name: 'generate_voice_message',
    description: 'Generate a voice message (speech audio) from text.',
    category: 'media',
    inputSchema: z.object({
      text: z.string().min(1).describe('Text to convert to speech'),
      voiceId: z.string().optional().describe('Voice profile ID to use'),
      format: z.enum(['ogg', 'mp3', 'wav']).optional().describe('Audio format'),
      speed: z.number().min(0.5).max(2).optional().describe('Playback speed'),
      pitch: z.number().min(-1).max(1).optional().describe('Pitch adjustment'),
      emotion: z.string().optional().describe('Emotion or style hint'),
      maxDurationMs: z.number().min(1000).optional().describe('Max duration cap in ms'),
    }),
    execute: async (input, context): Promise<ToolResult> => {
      const result = await services.generateVoiceMessage({
        agentId: context.agentId,
        platform: context.platform,
        ...input,
      });
      return { success: true, data: result };
    },
  }),

  defineTool({
    name: 'send_voice_message',
    description: 'Send a voice message to a conversation. Provide assetId or url.',
    category: 'media',
    inputSchema: z.object({
      conversationId: z.string().min(1).describe('Conversation or chat ID'),
      assetId: z.string().optional().describe('Audio asset ID'),
      url: z.string().optional().describe('Public URL to audio file'),
      caption: z.string().optional().describe('Optional caption'),
      replyToMessageId: z.string().optional().describe('Message ID to reply to'),
    }),
    execute: async (input, context): Promise<ToolResult> => {
      if (!input.assetId && !input.url) {
        return { success: false, error: 'Provide assetId or url' };
      }
      const result = await services.sendVoiceMessage({
        agentId: context.agentId,
        platform: context.platform,
        conversationId: input.conversationId,
        assetId: input.assetId,
        url: input.url,
        caption: input.caption,
        replyToMessageId: input.replyToMessageId,
      });
      return { success: true, data: result };
    },
  }),
];

export default createVoiceTools;
