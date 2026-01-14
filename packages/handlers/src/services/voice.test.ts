import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';

// Mock AWS SDK
vi.mock('@aws-sdk/client-s3', () => {
  return {
    S3Client: vi.fn(() => ({
      send: vi.fn().mockResolvedValue({})
    })),
    PutObjectCommand: vi.fn(x => x),
    GetObjectCommand: vi.fn(x => x),
  };
});

// Mock fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

let createVoiceServices: typeof import('./voice.js').createVoiceServices;

describe('VoiceServices', () => {
  const agentId = 'test-agent';
  const secrets = {
    OPENAI_API_KEY: 'test-openai-key',
    TELEGRAM_BOT_TOKEN: 'test-telegram-token',
    REPLICATE_API_KEY: 'test-replicate-key'
  };
  const voiceConfig = {
    ttsProvider: 'voice-clone' as const,
    format: 'ogg' as const,
    referenceUrl: 'https://example.com/ref.wav'
  };
  const mediaBucket = 'test-bucket';

  let services: ReturnType<typeof createVoiceServices>;

  beforeAll(async () => {
    ({ createVoiceServices } = await import('./voice.js'));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
    services = createVoiceServices({
      agentId,
      secrets,
      voiceConfig,
      mediaBucket,
      replicatePollIntervalMs: 0
    });
  });

  describe('transcribeAudio', () => {
    it('uses platform file lookup when URL is missing', async () => {
      // Mock Telegram getFile
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ok: true,
          result: { file_path: 'voice/file_1.oga' }
        })
      });

      // Mock audio download
      mockFetch.mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => new ArrayBuffer(8),
        headers: { get: () => 'audio/ogg' }
      });

      // Mock OpenAI transcription
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ text: 'Hello world', language: 'en' })
      });

      const result = await services.transcribeAudio({
        platformFileId: 'telegram-file-id'
      });

      expect(result.text).toBe('Hello world');
      expect(mockFetch).toHaveBeenCalledTimes(3);
      
      // First call to Telegram getFile
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('api.telegram.org/bottest-telegram-token/getFile'),
        expect.any(Object)
      );
    });

    it('downloads directly from URL if provided', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => new ArrayBuffer(8),
        headers: { get: () => 'audio/ogg' }
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ text: 'Hello', language: 'en' })
      });

      const result = await services.transcribeAudio({
        url: 'https://example.com/audio.mp3'
      });

      expect(result.text).toBe('Hello');
      expect(mockFetch).toHaveBeenCalledWith('https://example.com/audio.mp3', expect.any(Object));
    });
  });

  describe('generateVoiceMessage', () => {
    it('returns asset metadata for playback', async () => {
      // Mock Replicate prediction start
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 'pred-1', status: 'starting' })
      });

      // Mock Replicate prediction polling (succeeded)
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ 
          id: 'pred-1', 
          status: 'succeeded', 
          output: 'https://replicate.delivery/out.wav' 
        })
      });

      // Mock audio download
      mockFetch.mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => new ArrayBuffer(1024),
        headers: { get: () => 'audio/wav' }
      });

      const result = await services.generateVoiceMessage({
        agentId,
        platform: 'telegram',
        text: 'Hello from cloned voice'
      });

      expect(result.url).toContain('test-bucket.s3.amazonaws.com');
      expect(result.assetId).toBeDefined();
      expect(result.format).toBe('wav');
    });

    it('falls back to OpenAI TTS if clone not configured', async () => {
      const basicServices = createVoiceServices({
        agentId,
        secrets: { OPENAI_API_KEY: 'test-key' },
        mediaBucket: 'test-bucket'
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => new ArrayBuffer(1024),
        headers: { get: () => 'audio/mpeg' }
      });

      const result = await basicServices.generateVoiceMessage({
        agentId,
        platform: 'telegram',
        text: 'Simple TTS'
      });

      expect(result.url).toBeDefined();
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.openai.com/v1/audio/speech',
        expect.any(Object)
      );
    });
  });

  describe('sendVoiceMessage', () => {
    it('dispatches via platform adapter (Telegram)', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: true })
      });

      const result = await services.sendVoiceMessage({
        agentId,
        platform: 'telegram',
        conversationId: '12345',
        url: 'https://example.com/voice.ogg'
      });

      expect(result.success).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('api.telegram.org/bottest-telegram-token/sendVoice'),
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('"voice":"https://example.com/voice.ogg"')
        })
      );
    });

    it('throws for unsupported platform', async () => {
      await expect(services.sendVoiceMessage({
        agentId,
        platform: 'unsupported',
        conversationId: '123',
        url: 'https://x.com'
      })).rejects.toThrow('Voice messaging not supported');
    });
  });
});
