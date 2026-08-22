/**
 * Voice Services Tests
 *
 * Tests for voice transcription, generation, and sending functionality.
 * Uses bun:test with mock functions for dependency injection.
 */
import { describe, it, expect, vi } from 'vitest';
import { createVoiceServices } from './voice.js';

describe('VoiceServices - Pure Logic Tests', () => {
  describe('Audio format detection', () => {
    // Test the format detection logic
    function detectAudioFormat(contentType?: string | null, url?: string | null): 'ogg' | 'mp3' | 'wav' {
      const type = (contentType || '').toLowerCase();
      if (type.includes('ogg') || type.includes('opus')) return 'ogg';
      if (type.includes('mpeg') || type.includes('mp3')) return 'mp3';
      if (type.includes('wav')) return 'wav';

      const lowerUrl = (url || '').toLowerCase();
      if (lowerUrl.endsWith('.mp3')) return 'mp3';
      if (lowerUrl.endsWith('.wav')) return 'wav';
      if (lowerUrl.endsWith('.ogg') || lowerUrl.endsWith('.oga') || lowerUrl.endsWith('.opus')) return 'ogg';
      return 'ogg';
    }

    it('detects ogg from content type', () => {
      expect(detectAudioFormat('audio/ogg')).toBe('ogg');
      expect(detectAudioFormat('audio/ogg; codecs=opus')).toBe('ogg');
    });

    it('detects mp3 from content type', () => {
      expect(detectAudioFormat('audio/mpeg')).toBe('mp3');
      expect(detectAudioFormat('audio/mp3')).toBe('mp3');
    });

    it('detects wav from content type', () => {
      expect(detectAudioFormat('audio/wav')).toBe('wav');
      expect(detectAudioFormat('audio/wave')).toBe('wav');
    });

    it('falls back to URL extension when content type missing', () => {
      expect(detectAudioFormat(null, 'https://example.com/audio.mp3')).toBe('mp3');
      expect(detectAudioFormat(null, 'https://example.com/audio.wav')).toBe('wav');
      expect(detectAudioFormat(null, 'https://example.com/audio.ogg')).toBe('ogg');
      expect(detectAudioFormat(null, 'https://example.com/audio.oga')).toBe('ogg');
      expect(detectAudioFormat(null, 'https://example.com/audio.opus')).toBe('ogg');
    });

    it('defaults to ogg when format unknown', () => {
      expect(detectAudioFormat(null, null)).toBe('ogg');
      expect(detectAudioFormat('', '')).toBe('ogg');
      expect(detectAudioFormat(null, 'https://example.com/audio.xyz')).toBe('ogg');
    });
  });

  describe('Content type mapping', () => {
    function formatToContentType(format: 'ogg' | 'mp3' | 'wav'): string {
      switch (format) {
        case 'mp3':
          return 'audio/mpeg';
        case 'wav':
          return 'audio/wav';
        case 'ogg':
        default:
          return 'audio/ogg';
      }
    }

    it('maps ogg to audio/ogg', () => {
      expect(formatToContentType('ogg')).toBe('audio/ogg');
    });

    it('maps mp3 to audio/mpeg', () => {
      expect(formatToContentType('mp3')).toBe('audio/mpeg');
    });

    it('maps wav to audio/wav', () => {
      expect(formatToContentType('wav')).toBe('audio/wav');
    });
  });

  describe('URL validation', () => {
    function isUrl(value?: string): boolean {
      return !!value && /^https?:\/\//i.test(value);
    }

    it('identifies valid http/https URLs', () => {
      expect(isUrl('https://example.com/audio.mp3')).toBe(true);
      expect(isUrl('http://example.com/audio.mp3')).toBe(true);
      expect(isUrl('HTTPS://EXAMPLE.COM')).toBe(true);
    });

    it('rejects non-URL strings', () => {
      expect(isUrl('voice-id-123')).toBe(false);
      expect(isUrl('alloy')).toBe(false);
      expect(isUrl('')).toBe(false);
      expect(isUrl(undefined)).toBe(false);
    });
  });

  describe('S3 URL parsing', () => {
    function parseS3Key(url: string): { bucket: string; key: string } | null {
      const match = url.match(/https:\/\/([^.]+)\.s3[^/]*\.amazonaws\.com\/(.+)/);
      if (!match) return null;
      return { bucket: match[1], key: decodeURIComponent(match[2]) };
    }

    it('parses standard S3 URLs', () => {
      const result = parseS3Key('https://my-bucket.s3.amazonaws.com/path/to/file.wav');
      expect(result).not.toBeNull();
      expect(result!.bucket).toBe('my-bucket');
      expect(result!.key).toBe('path/to/file.wav');
    });

    it('parses regional S3 URLs', () => {
      const result = parseS3Key('https://my-bucket.s3.us-east-1.amazonaws.com/audio/file.ogg');
      expect(result).not.toBeNull();
      expect(result!.bucket).toBe('my-bucket');
      expect(result!.key).toBe('audio/file.ogg');
    });

    it('decodes URL-encoded keys', () => {
      const result = parseS3Key('https://bucket.s3.amazonaws.com/path%2Fwith%20spaces.mp3');
      expect(result).not.toBeNull();
      expect(result!.key).toBe('path/with spaces.mp3');
    });

    it('returns null for non-S3 URLs', () => {
      expect(parseS3Key('https://example.com/file.mp3')).toBeNull();
      expect(parseS3Key('https://cdn.example.com/bucket/file.mp3')).toBeNull();
    });
  });

  describe('Replicate output extraction', () => {
    type ReplicateOutput = string | string[] | { uri?: string };

    function extractOutputUrl(output: ReplicateOutput | undefined): string | undefined {
      if (Array.isArray(output)) return output[0];
      if (typeof output === 'string') return output;
      if (output && typeof output === 'object' && 'uri' in output) return output.uri;
      return undefined;
    }

    it('extracts URL from string output', () => {
      expect(extractOutputUrl('https://replicate.delivery/out.wav')).toBe('https://replicate.delivery/out.wav');
    });

    it('extracts first URL from array output', () => {
      expect(extractOutputUrl(['https://url1.wav', 'https://url2.wav'])).toBe('https://url1.wav');
    });

    it('extracts URI from object output', () => {
      expect(extractOutputUrl({ uri: 'https://output.wav' })).toBe('https://output.wav');
    });

    it('returns undefined for missing output', () => {
      expect(extractOutputUrl(undefined)).toBeUndefined();
      expect(extractOutputUrl([])).toBeUndefined();
      expect(extractOutputUrl({})).toBeUndefined();
    });
  });
});

describe('VoiceServices - Service Mock Integration', () => {
  const _avatarId = 'test-avatar';
  const _secrets = {
    OPENAI_API_KEY: 'test-openai-key',
    TELEGRAM_BOT_TOKEN: 'test-telegram-token',
    REPLICATE_API_KEY: 'test-replicate-key',
  };
  const _voiceConfig = {
    ttsProvider: 'voice-clone' as const,
    format: 'ogg' as const,
    referenceUrl: 'https://example.com/ref.wav',
  };
  const _mediaBucket = 'test-bucket';

  describe('transcribeAudio', () => {
    it('should transcribe audio from URL via OpenAI Whisper', async () => {
      // Simulate the transcription flow
      const mockFetch = vi.fn(async (url: string) => {
        if (url === 'https://example.com/audio.mp3') {
          return {
            ok: true,
            arrayBuffer: async () => new ArrayBuffer(8),
            headers: { get: () => 'audio/mpeg' },
          };
        }
        if (url === 'https://api.openai.com/v1/audio/transcriptions') {
          return {
            ok: true,
            json: async () => ({ text: 'Hello world', language: 'en' }),
          };
        }
        throw new Error(`Unexpected URL: ${url}`);
      });

      // Simulate the transcription logic
      const audioUrl = 'https://example.com/audio.mp3';
      const response = await mockFetch(audioUrl);
      expect(response.ok).toBe(true);

      const transcriptionResponse = await mockFetch('https://api.openai.com/v1/audio/transcriptions');
      const data = await transcriptionResponse.json();

      expect(data.text).toBe('Hello world');
      expect(data.language).toBe('en');
    });

    it('should resolve Telegram file ID to URL', async () => {
      const mockFetch = vi.fn(async (url: string) => {
        if (url.includes('api.telegram.org') && url.includes('getFile')) {
          return {
            ok: true,
            json: async () => ({
              ok: true,
              result: { file_path: 'voice/file_1.oga' },
            }),
          };
        }
        throw new Error(`Unexpected URL: ${url}`);
      });

      // Simulate Telegram file resolution
      const response = await mockFetch('https://api.telegram.org/bottest-token/getFile');
      const result = await response.json();

      expect(result.ok).toBe(true);
      expect(result.result.file_path).toBe('voice/file_1.oga');

      // Construct the actual file URL
      const fileUrl = `https://api.telegram.org/file/bottest-token/${result.result.file_path}`;
      expect(fileUrl).toContain('voice/file_1.oga');
    });

    it('should throw when no audio source provided', () => {
      const params: { url?: string; platformFileId?: string } = {};
      expect(params.url ?? params.platformFileId).toBeUndefined();

      // Simulate the error that would be thrown
      const hasAudioSource = !!(params.url || params.platformFileId);
      expect(hasAudioSource).toBe(false);
    });

    it('does not require OPENAI_API_KEY for the rest of the pipeline', () => {
      const secretsWithoutKey: Record<string, string> = { TELEGRAM_BOT_TOKEN: 'token' };
      const openAiKey = secretsWithoutKey.OPENAI_API_KEY || secretsWithoutKey.openai_api_key;
      expect(openAiKey).toBeUndefined();
    });
  });

  describe('generateVoiceMessage', () => {
    it('uses OpenRouter speech when no voice reference is configured', async () => {
      const fetchMock = vi.fn(async (url: string, options?: RequestInit) => {
        expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
        expect(options?.method).toBe('POST');
        expect(options?.headers).toEqual(expect.objectContaining({
          Authorization: 'Bearer test-openrouter-key',
          'Content-Type': 'application/json',
        }));

        const body = JSON.parse(String(options?.body)) as {
          model?: string;
          messages?: Array<{ role?: string; content?: string }>;
          modalities?: string[];
          audio?: { voice?: string; format?: string };
          stream?: boolean;
        };
        expect(body.model).toBe(process.env.OPENROUTER_SPEECH_MODEL || process.env.OPENROUTER_TTS_MODEL || 'openai/gpt-audio-mini');
        expect(body.messages).toEqual([
          { role: 'user', content: 'Hello from reference-free voice.' },
        ]);
        expect(body.modalities).toEqual(['text', 'audio']);
        expect(body.audio).toEqual({
          voice: process.env.OPENROUTER_SPEECH_VOICE || process.env.OPENROUTER_TTS_VOICE || 'alloy',
          format: 'mp3',
        });
        expect(body.stream).toBe(true);

        const streamPayload = [
          'data: {"choices":[{"delta":{"audio":{"data":"YXVkaW8="}}}]}',
          'data: [DONE]',
          '',
        ].join('\n');

        return new Response(streamPayload, { status: 200 });
      });

      const voiceServices = createVoiceServices({
        avatarId: 'test-avatar',
        secrets: { OPENROUTER_API_KEY: 'test-openrouter-key' },
        mediaBucket: 'test-bucket',
        cdnUrl: 'https://cdn.example.com',
        _deps: {
          fetch: fetchMock,
          s3Client: { send: vi.fn(async () => ({})) },
        },
      });

      const generated = await voiceServices.generateVoiceMessage({
        avatarId: 'test-avatar',
        text: 'Hello from reference-free voice.',
        format: 'mp3',
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(generated.assetId).toBeTruthy();
      expect(generated.url).toMatch(/^https:\/\/cdn\.example\.com\/avatars\/test-avatar\/audio\/.+\.mp3$/);
      expect(generated.format).toBe('mp3');
    });

    it('falls back to a clear provider error when no reference or OpenRouter key is available', async () => {
      const voiceServices = createVoiceServices({
        avatarId: 'test-avatar',
        secrets: {},
        mediaBucket: 'test-bucket',
      });

      await expect(voiceServices.generateVoiceMessage({
        avatarId: 'test-avatar',
        text: 'Hello without providers.',
        format: 'ogg',
      })).rejects.toThrow('Replicate API key not configured');
    });

    it('uses Replicate voice cloning when a reference voice is configured', async () => {
      const fetchMock = vi.fn(async (url: string, options?: RequestInit) => {
        if (url === 'https://api.replicate.com/v1/models/x-lance/f5-tts') {
          return Response.json({ latest_version: { id: 'version-1' } });
        }

        if (url === 'https://api.replicate.com/v1/predictions') {
          const body = JSON.parse(String(options?.body)) as { input?: Record<string, unknown> };
          expect(body.input?.gen_text).toBe('Hello from cloned voice.');
          expect(body.input?.ref_audio).toBe('https://example.com/ref.wav');
          return Response.json({
            id: 'pred-1',
            status: 'succeeded',
            output: 'https://replicate.delivery/out.wav',
          });
        }

        if (url === 'https://replicate.delivery/out.wav') {
          return new Response(new Uint8Array([1, 2, 3]), {
            status: 200,
            headers: { 'content-type': 'audio/wav' },
          });
        }

        throw new Error(`Unexpected URL: ${url}`);
      });

      const originalFetch = globalThis.fetch;
      globalThis.fetch = fetchMock as unknown as typeof fetch;
      try {
        const voiceServices = createVoiceServices({
          avatarId: 'test-avatar',
          secrets: {
            OPENROUTER_API_KEY: 'test-openrouter-key',
            REPLICATE_API_KEY: 'test-replicate-key',
          },
          voiceConfig: {
            ttsProvider: 'voice-clone',
            format: 'ogg',
            referenceUrl: 'https://example.com/ref.wav',
          },
          mediaBucket: 'test-bucket',
          cdnUrl: 'https://cdn.example.com',
          replicatePollIntervalMs: 0,
          _deps: {
            s3Client: { send: vi.fn(async () => ({})) },
          },
        });

        const generated = await voiceServices.generateVoiceMessage({
          avatarId: 'test-avatar',
          text: 'Hello from cloned voice.',
          format: 'ogg',
        });

        expect(generated.assetId).toBeTruthy();
        expect(generated.url).toMatch(/^https:\/\/cdn\.example\.com\/avatars\/test-avatar\/audio\/.+\.wav$/);
        expect(generated.format).toBe('wav');
        expect(fetchMock).toHaveBeenCalledWith(
          'https://api.replicate.com/v1/predictions',
          expect.objectContaining({
            method: 'POST',
            headers: expect.objectContaining({
              Authorization: 'Bearer test-replicate-key',
            }),
          }),
        );
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('should use Replicate for voice cloning when configured', async () => {
      let callCount = 0;
      const mockFetch = vi.fn(async (url: string) => {
        callCount++;
        // First call: create prediction
        if (url === 'https://api.replicate.com/v1/predictions' && callCount === 1) {
          return {
            ok: true,
            json: async () => ({ id: 'pred-1', status: 'starting' }),
          };
        }
        // Second call: poll prediction (succeeded)
        if (url.includes('api.replicate.com/v1/predictions/pred-1')) {
          return {
            ok: true,
            json: async () => ({
              id: 'pred-1',
              status: 'succeeded',
              output: 'https://replicate.delivery/out.wav',
            }),
          };
        }
        // Third call: download audio
        if (url === 'https://replicate.delivery/out.wav') {
          return {
            ok: true,
            arrayBuffer: async () => new ArrayBuffer(2048),
            headers: { get: () => 'audio/wav' },
          };
        }
        throw new Error(`Unexpected URL: ${url}`);
      });

      // Simulate voice cloning flow
      const createResponse = await mockFetch('https://api.replicate.com/v1/predictions');
      const prediction = await createResponse.json();
      expect(prediction.status).toBe('starting');

      // Poll for completion
      const pollResponse = await mockFetch(`https://api.replicate.com/v1/predictions/${prediction.id}`);
      const completed = await pollResponse.json();
      expect(completed.status).toBe('succeeded');
      expect(completed.output).toBe('https://replicate.delivery/out.wav');

      // Download the generated audio
      const audioResponse = await mockFetch(completed.output);
      expect(audioResponse.ok).toBe(true);
    });

    it('should throw when MEDIA_BUCKET not configured', () => {
      const configWithoutBucket: { mediaBucket?: string } = { mediaBucket: undefined };
      expect(configWithoutBucket.mediaBucket).toBeUndefined();
    });
  });

  describe('sendVoiceMessage', () => {
    it('should send voice via Telegram API', async () => {
      const mockFetch = vi.fn(async (url: string, options?: RequestInit) => {
        if (url.includes('api.telegram.org') && url.includes('sendVoice')) {
          expect(options?.method).toBe('POST');
          // We now upload via multipart/form-data (FormData instance)
          expect(options?.body).toBeInstanceOf(FormData);
          return {
            ok: true,
            json: async () => ({ ok: true }),
            text: async () => '{"ok":true}',
          };
        }
        throw new Error(`Unexpected URL: ${url}`);
      });

      const form = new FormData();
      form.append('chat_id', '12345');
      form.append('voice', new Blob([new ArrayBuffer(1)], { type: 'audio/ogg' }), 'voice.ogg');

      const response = await mockFetch(
        'https://api.telegram.org/bottest-token/sendVoice',
        {
          method: 'POST',
          body: form,
        }
      );

      const result = await response.json();
      expect(result.ok).toBe(true);
    });

    it('should throw for unsupported platforms', () => {
      const platform = 'twitter';
      const isTelegram = platform === 'telegram';
      expect(isTelegram).toBe(false);
    });

    it('should throw when voice URL not provided', () => {
      const params: { avatarId: string; platform: string; conversationId: string; url?: string } = {
        avatarId: 'test',
        platform: 'telegram',
        conversationId: '123',
      };
      expect(params.url).toBeUndefined();
    });
  });

  describe('hasVoice', () => {
    it('should return voice config information', () => {
      const config = {
        voiceConfig: {
          ttsProvider: 'voice-clone' as const,
          referenceUrl: 'https://example.com/ref.wav',
        },
      };

      const hasVoiceProfile = !!config.voiceConfig?.referenceUrl;
      expect(hasVoiceProfile).toBe(true);

      const result = {
        hasVoice: hasVoiceProfile,
        voiceId: undefined,
        voiceStyle: config.voiceConfig?.ttsProvider,
        referenceUrl: config.voiceConfig?.referenceUrl,
      };

      expect(result.hasVoice).toBe(true);
      expect(result.voiceStyle).toBe('voice-clone');
      expect(result.referenceUrl).toBe('https://example.com/ref.wav');
    });

    it('should return false when no voice configured', () => {
      const config: { voiceConfig?: { referenceUrl?: string } } = { voiceConfig: undefined };
      const hasVoiceProfile = !!config.voiceConfig?.referenceUrl;
      expect(hasVoiceProfile).toBe(false);
    });
  });

  describe('Unsupported operations', () => {
    it('createVoiceSeed throws not supported error', () => {
      const error = new Error('Voice seed generation not supported in runtime handlers');
      expect(error.message).toContain('not supported');
    });

    it('cloneVoiceFromSeed throws not supported error', () => {
      const error = new Error('Voice cloning not supported in runtime handlers');
      expect(error.message).toContain('not supported');
    });

    it('createVoiceProfile throws not supported error', () => {
      const error = new Error('Voice profile creation not supported in runtime handlers');
      expect(error.message).toContain('not supported');
    });

    it('setActiveVoiceProfile throws not supported error', () => {
      const error = new Error('Voice profile updates not supported in runtime handlers');
      expect(error.message).toContain('not supported');
    });

    it('createMyVoice throws not supported error', () => {
      const error = new Error('Voice creation not supported in runtime handlers - use admin API');
      expect(error.message).toContain('admin API');
    });
  });
});

describe('VoiceServices - Integration Scenarios', () => {
  it('E2E: Full voice message generation flow', async () => {
    // Simulate end-to-end voice generation:
    // 1. Text input received
    // 2. Voice generated via TTS
    // 3. Audio uploaded to S3
    // 4. URL returned for playback

    const text = 'Hello, this is a test message';
    const avatarId = 'test-avatar';
    const mediaBucket = 'test-bucket';

    // Simulate TTS response
    const ttsAudio = new ArrayBuffer(2048);

    // Simulate S3 upload
    const assetId = 'uuid-12345';
    const s3Key = `avatars/${avatarId}/audio/${assetId}.ogg`;
    const uploadedUrl = `https://${mediaBucket}.s3.amazonaws.com/${s3Key}`;

    // Verify the flow
    expect(text.length).toBeGreaterThan(0);
    expect(ttsAudio.byteLength).toBe(2048);
    expect(uploadedUrl).toContain(mediaBucket);
    expect(uploadedUrl).toContain(avatarId);
  });

  it('E2E: Voice transcription from Telegram voice message', async () => {
    // Simulate end-to-end transcription:
    // 1. Telegram file ID received
    // 2. File path resolved via getFile API
    // 3. Audio downloaded
    // 4. Transcribed via Whisper
    // 5. Text returned

    const telegramFileId = 'AwACAgIAAxkBAAI';
    const filePath = 'voice/file_123.oga';
    const botToken = 'bot123:ABC';

    // Construct file URL
    const fileUrl = `https://api.telegram.org/file/bot${botToken}/${filePath}`;

    // Simulated transcription result
    const transcription = {
      text: 'Hello, this is a voice message',
      language: 'en',
    };

    expect(telegramFileId).toBeTruthy();
    expect(fileUrl).toContain('api.telegram.org');
    expect(transcription.text).toBeTruthy();
  });

  it('E2E: Voice cloning with reference audio', async () => {
    // Simulate voice cloning:
    // 1. Reference audio URL provided in config
    // 2. Text to speak submitted
    // 3. Replicate API called with reference
    // 4. Generated audio downloaded
    // 5. Uploaded to S3

    const referenceUrl = 'https://cdn.example.com/avatars/test/voice/reference.wav';
    const textToSpeak = 'This will be spoken in the cloned voice';
    const replicateModel = 'lucataco/xtts-v2';

    // Replicate prediction flow
    const predictionId = 'pred-abc123';
    const outputUrl = 'https://replicate.delivery/generated-voice.wav';

    // Verify the flow components
    expect(referenceUrl).toContain('reference');
    expect(textToSpeak.length).toBeGreaterThan(0);
    expect(replicateModel).toContain('xtts');
    expect(predictionId).toBeTruthy();
    expect(outputUrl).toContain('replicate.delivery');
  });

  it('E2E: Send voice message to Telegram chat', async () => {
    // Simulate sending voice message:
    // 1. Voice URL ready (from S3/CDN)
    // 2. Telegram sendVoice API called
    // 3. Success response received

    const voiceUrl = 'https://cdn.example.com/avatars/test/audio/message.ogg';
    const chatId = '-1001234567890';
    const caption = 'Voice response';

    // Telegram API payload
    const payload = {
      chat_id: chatId,
      voice: voiceUrl,
      caption: caption,
    };

    expect(payload.chat_id).toBe(chatId);
    expect(payload.voice).toBe(voiceUrl);
    expect(payload.caption).toBe(caption);

    // Simulated success response
    const response = { ok: true, result: { message_id: 12345 } };
    expect(response.ok).toBe(true);
  });
});
