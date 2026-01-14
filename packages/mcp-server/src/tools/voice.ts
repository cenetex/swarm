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
  /**
   * Create a voice for the agent based on a description.
   * This is the consolidated voice creation method that:
   * 1. Generates a voice seed audio based on the description
   * 2. Clones the voice from the seed
   * 3. Sets it as the agent's active voice profile
   * 4. Generates a voice introduction message
   */
  createMyVoice: (params: {
    agentId: string;
    description: string;
  }) => Promise<{ voiceId: string; message: string; previewUrl?: string; introAssetId?: string; introUrl?: string }>;
  /**
   * Check if the agent has a voice configured
   */
  hasVoice: (agentId: string) => Promise<{ hasVoice: boolean; voiceId?: string; voiceStyle?: string }>;
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
    toolset: 'voice',
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
    name: 'create_my_voice',
    description: 'Create your voice for speaking. This is the only tool you need to set up voice messages - it handles everything automatically: generates a voice seed based on your description, clones it into a voice profile, sets it as your active voice, and generates a voice introduction message you can send. Use this when you want to send voice messages but haven\'t configured your voice yet.',
    category: 'config',
    toolset: 'voice',
    inputSchema: z.object({
      description: z.string().min(1)
        .describe('Description of your desired voice - include personality traits, tone, gender, age, accent, speaking style. Example: "A warm female voice with a slight Southern accent, playful and energetic, speaks quickly with enthusiasm"'),
    }),
    execute: async (input, context): Promise<ToolResult> => {
      const result = await services.createMyVoice({
        agentId: context.agentId,
        description: input.description,
      });
      return { success: true, data: result };
    },
  }),

  defineTool({
    name: 'check_my_voice',
    description: 'Check if you have a voice configured for speaking. Use this before trying to send voice messages.',
    category: 'readonly',
    toolset: 'voice',
    inputSchema: z.object({}),
    execute: async (_input, context): Promise<ToolResult> => {
      const result = await services.hasVoice(context.agentId);
      return { success: true, data: result };
    },
  }),

  defineTool({
    name: 'generate_voice_message',
    description: 'Generate a voice message (speech audio) from text.',
    category: 'media',
    toolset: 'voice',
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
    toolset: 'voice',
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
