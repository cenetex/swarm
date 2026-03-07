import { describe, expect, test, vi } from 'vitest';

// Stub heavy AWS / service dependencies so we can import system.ts without them.
// IMPORTANT: bun:test vi.mock (mock.module) is process-global and persistent.
// Mock classes MUST have proper prototypes (e.g., `send()` method, `input` property)
// so that spyOn() and command inspection in other test files still works.
vi.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: class { async send() { return {}; } },
  GetSecretValueCommand: class { constructor(public input: unknown) {} },
}));
vi.mock('@aws-sdk/client-sqs', () => ({
  SQSClient: class { async send() { return {}; } },
  SendMessageCommand: class { constructor(public input: unknown) {} },
}));
vi.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: class { async send() { return {}; } },
}));
vi.mock('@aws-sdk/lib-dynamodb', () => {
  class MockDynamoDBDocumentClient {
    static from() { return new MockDynamoDBDocumentClient(); }
    async send(_command: unknown) { return {}; }
  }
  return {
    DynamoDBDocumentClient: MockDynamoDBDocumentClient,
    GetCommand: class { constructor(public input: unknown) {} },
    PutCommand: class { constructor(public input: unknown) {} },
    QueryCommand: class { constructor(public input: unknown) {} },
    DeleteCommand: class { constructor(public input: unknown) {} },
    UpdateCommand: class { constructor(public input: unknown) {} },
    ScanCommand: class { constructor(public input: unknown) {} },
    BatchWriteCommand: class { constructor(public input: unknown) {} },
  };
});
vi.mock('../../services/observability.js', () => ({
  recordAuditEvent: async () => {},
  emitMetric: async () => {},
}));
vi.mock('../../services/integrations.js', () => ({}));
vi.mock('../../services/media/replicate-schema.js', () => ({
  searchReplicateModels: async () => [],
}));
// NOTE: Do NOT mock models-registry.js here. The test only uses
// inferCapabilities which does not depend on AVAILABLE_MODELS.
// Mocking it with empty data would pollute other test files
// (bun:test mock.module is process-global and persistent).

import { inferCapabilities } from './system';

function makeModel(name: string, description = '', owner = '') {
  return { name, description, owner };
}

describe('inferCapabilities', () => {
  test('image model (flux keyword) returns image_generation', () => {
    expect(inferCapabilities(makeModel('flux-schnell', 'Fast image generation'))).toEqual([
      'image_generation',
    ]);
  });

  test('image model (diffusion keyword) returns image_generation', () => {
    expect(inferCapabilities(makeModel('stable-diffusion', 'Generate images'))).toEqual([
      'image_generation',
    ]);
  });

  test('video model returns video_generation', () => {
    expect(inferCapabilities(makeModel('video-gen', 'Generate video clips'))).toEqual([
      'video_generation',
    ]);
  });

  test('video model (animate keyword) returns video_generation', () => {
    expect(inferCapabilities(makeModel('animate-diff', 'Animate a scene'))).toEqual([
      'video_generation',
    ]);
  });

  test('audio model (music keyword) returns audio_generation', () => {
    expect(inferCapabilities(makeModel('musicgen', 'Generate music'))).toEqual([
      'audio_generation',
    ]);
  });

  test('audio model (sound keyword) returns audio_generation', () => {
    expect(inferCapabilities(makeModel('soundfx', 'Generate sound effects'))).toEqual([
      'audio_generation',
    ]);
  });

  test('audio model that mentions video gets video (higher priority) not both (bug fix)', () => {
    // Before the fix, this returned BOTH video_generation AND audio_generation.
    // Now it returns only video_generation (higher priority in the else-if chain).
    const caps = inferCapabilities(makeModel('audiocraft', 'Generate audio and video soundtracks'));
    expect(caps).toEqual(['video_generation']);
    expect(caps).not.toContain('audio_generation');
  });

  test('pure audio model returns audio_generation only', () => {
    expect(
      inferCapabilities(makeModel('audiocraft', 'Generate audio soundtracks')),
    ).toEqual(['audio_generation']);
  });

  test('video model that mentions audio returns video_generation only', () => {
    expect(
      inferCapabilities(makeModel('video-maker', 'Create video with audio sync')),
    ).toEqual(['video_generation']);
  });

  test('image model with video mention returns image_generation only', () => {
    expect(
      inferCapabilities(makeModel('img2video-diffusion', 'Image to video diffusion model')),
    ).toEqual(['image_generation']);
  });

  test('TTS model returns text_to_speech', () => {
    expect(inferCapabilities(makeModel('tts-model', 'Text to speech synthesis'))).toEqual([
      'text_to_speech',
    ]);
  });

  test('transcription model (whisper) returns transcription', () => {
    expect(inferCapabilities(makeModel('whisper', 'Speech to text transcription'))).toEqual([
      'transcription',
    ]);
  });

  test('unknown model defaults to image_generation', () => {
    expect(inferCapabilities(makeModel('mystery-model', 'Does something cool'))).toEqual([
      'image_generation',
    ]);
  });

  test('voice + TTS model returns text_to_speech', () => {
    expect(
      inferCapabilities(makeModel('voice-clone', 'Clone voice for TTS')),
    ).toEqual(['text_to_speech']);
  });
});
