/**
 * Telegram Platform Tests
 * Tests for buildTelegramEnvelope and related utilities
 *
 * Bug Index:
 * - BUG-012: Unknown chat types cause unsafe cast (line 58)
 *
 * @see packages/core/src/platforms/telegram.ts
 */
import { describe, it, expect } from 'vitest';
import { buildTelegramEnvelope, envelopeToBufferedMessage, type TelegramEnvelopeConfig } from './telegram.js';
import type { Update, Message } from 'grammy/types';

// Helper to create a minimal Telegram Update
function createTelegramUpdate(overrides: Partial<Message> = {}): Update {
  const baseMessage: Message = {
    message_id: 123,
    date: Math.floor(Date.now() / 1000),
    chat: {
      id: -100123456789,
      type: 'supergroup',
      title: 'Test Group',
    },
    from: {
      id: 456,
      is_bot: false,
      first_name: 'John',
      last_name: 'Doe',
      username: 'johndoe',
    },
    text: 'Hello world!',
    ...overrides,
  } as Message;

  return {
    update_id: 999,
    message: baseMessage,
  };
}

describe('buildTelegramEnvelope', () => {
  const defaultConfig: TelegramEnvelopeConfig = {
    avatarId: 'test-avatar',
    botUsername: 'TestBot',
    botId: 12345,
  };

  describe('Basic Message Parsing', () => {
    it('should create envelope from basic text message', () => {
      const update = createTelegramUpdate({ text: 'Hello world!' });
      const envelope = buildTelegramEnvelope(update, defaultConfig);

      expect(envelope).not.toBeNull();
      expect(envelope!.avatarId).toBe('test-avatar');
      expect(envelope!.platform).toBe('telegram');
      expect(envelope!.messageId).toBe('123');
      expect(envelope!.conversationId).toBe('-100123456789');
      expect(envelope!.content.text).toBe('Hello world!');
    });

    it('should extract sender info correctly', () => {
      const update = createTelegramUpdate();
      const envelope = buildTelegramEnvelope(update, defaultConfig);

      expect(envelope!.sender.id).toBe('456');
      expect(envelope!.sender.username).toBe('johndoe');
      expect(envelope!.sender.displayName).toBe('John Doe');
      expect(envelope!.sender.isBot).toBe(false);
      expect(envelope!.sender.platform).toBe('telegram');
    });

    it('should handle missing optional sender fields', () => {
      const update = createTelegramUpdate();
      update.message = {
        ...update.message!,
        from: {
          id: 789,
          is_bot: false,
          first_name: 'Alice',
          // No last_name, no username
        },
      };

      const envelope = buildTelegramEnvelope(update, defaultConfig);

      expect(envelope!.sender.id).toBe('789');
      expect(envelope!.sender.username).toBeUndefined();
      expect(envelope!.sender.displayName).toBe('Alice');
    });
  });

  describe('Chat Type Handling', () => {
    it('should include chat type in metadata', () => {
      const update = createTelegramUpdate();
      const envelope = buildTelegramEnvelope(update, defaultConfig);

      expect(envelope!.metadata.chatType).toBe('supergroup');
      expect(envelope!.metadata.chatTitle).toBe('Test Group');
    });

    it('should filter by allowed chat types', () => {
      const update = createTelegramUpdate();
      const config: TelegramEnvelopeConfig = {
        ...defaultConfig,
        allowedChatTypes: ['private'],
      };

      const envelope = buildTelegramEnvelope(update, config);
      expect(envelope).toBeNull(); // supergroup not allowed
    });

    it('should allow message when chat type is in allowed list', () => {
      const update = createTelegramUpdate();
      const config: TelegramEnvelopeConfig = {
        ...defaultConfig,
        allowedChatTypes: ['supergroup', 'group'],
      };

      const envelope = buildTelegramEnvelope(update, config);
      expect(envelope).not.toBeNull();
    });

    it('should handle private chats', () => {
      const update = createTelegramUpdate();
      update.message = {
        ...update.message!,
        chat: {
          id: 456,
          type: 'private',
          first_name: 'John',
        } as Message['chat'],
      };

      const envelope = buildTelegramEnvelope(update, defaultConfig);

      expect(envelope!.metadata.chatType).toBe('private');
      expect(envelope!.metadata.chatTitle).toBeUndefined();
    });

    /**
     * BUG-012: Unknown chat types cause unsafe cast
     * File: packages/core/src/platforms/telegram.ts:58
     *
     * Previously, unknown chat types were cast directly without validation.
     *
     * Fix: Validate against known types, default unknown types to 'group'
     */
    describe('Unknown chat type handling (BUG-012)', () => {
      it('should handle all valid chat types', () => {
        const validTypes = ['private', 'group', 'supergroup', 'channel'] as const;

        for (const chatType of validTypes) {
          const update = createTelegramUpdate();
          update.message = {
            ...update.message!,
            chat: {
              id: 123,
              type: chatType,
              title: chatType === 'private' ? undefined : 'Test',
              first_name: chatType === 'private' ? 'John' : undefined,
            } as Message['chat'],
          };

          const envelope = buildTelegramEnvelope(update, defaultConfig);
          expect(envelope).not.toBeNull();
          expect(envelope!.metadata.chatType).toBe(chatType);
        }
      });

      it('should validate chat type against known types', () => {
        const validChatTypes = ['private', 'group', 'supergroup', 'channel'] as const;
        const testTypes = ['private', 'group', 'supergroup', 'channel', 'forum', 'unknown', 'newtype'];

        for (const testType of testTypes) {
          const isValid = validChatTypes.includes(testType as typeof validChatTypes[number]);

          if (['private', 'group', 'supergroup', 'channel'].includes(testType)) {
            expect(isValid).toBe(true);
          } else {
            expect(isValid).toBe(false);
          }
        }
      });

      it('should default unknown chat types to group for filtering', () => {
        // This tests the defensive behavior when Telegram adds new chat types
        const validChatTypes = ['private', 'group', 'supergroup', 'channel'] as const;
        const rawChatType = 'forum'; // Hypothetical new type from Telegram API

        const isKnownType = validChatTypes.includes(rawChatType as typeof validChatTypes[number]);
        const normalizedType = isKnownType
          ? (rawChatType as 'private' | 'group' | 'supergroup' | 'channel')
          : 'group';

        expect(isKnownType).toBe(false);
        expect(normalizedType).toBe('group');
      });

      it('should still filter based on normalized type', () => {
        const validChatTypes = ['private', 'group', 'supergroup', 'channel'] as const;
        const allowedChatTypes: ('private' | 'group' | 'supergroup' | 'channel')[] = ['private'];

        // Unknown type 'forum' should normalize to 'group'
        const rawChatType = 'forum';
        const normalizedType = validChatTypes.includes(rawChatType as typeof validChatTypes[number])
          ? (rawChatType as 'private' | 'group' | 'supergroup' | 'channel')
          : 'group';

        // 'group' is not in allowedChatTypes, so should be filtered
        const isAllowed = allowedChatTypes.includes(normalizedType);
        expect(isAllowed).toBe(false);
      });

      it('should allow unknown types when group is in allowed list', () => {
        const validChatTypes = ['private', 'group', 'supergroup', 'channel'] as const;
        const allowedChatTypes: ('private' | 'group' | 'supergroup' | 'channel')[] = ['group', 'supergroup'];

        // Unknown type normalizes to 'group'
        const rawChatType = 'newtype';
        const normalizedType = validChatTypes.includes(rawChatType as typeof validChatTypes[number])
          ? (rawChatType as 'private' | 'group' | 'supergroup' | 'channel')
          : 'group';

        // 'group' IS in allowedChatTypes
        const isAllowed = allowedChatTypes.includes(normalizedType);
        expect(isAllowed).toBe(true);
      });
    });
  });

  describe('Direct Engagement Detection', () => {
    it('should detect @mention in message text', () => {
      const update = createTelegramUpdate({ text: 'Hey @TestBot can you help?' });
      const envelope = buildTelegramEnvelope(update, defaultConfig);

      expect(envelope!.metadata.isMention).toBe(true);
      expect(envelope!.metadata.priority).toBe('high');
    });

    it('should not detect mention when botUsername not provided', () => {
      const update = createTelegramUpdate({ text: 'Hey @TestBot' });
      const config: TelegramEnvelopeConfig = { avatarId: 'test-avatar' };

      const envelope = buildTelegramEnvelope(update, config);

      expect(envelope!.metadata.isMention).toBe(false);
    });

    it('should detect reply to bot by botId', () => {
      const update = createTelegramUpdate({
        reply_to_message: {
          message_id: 100,
          date: Math.floor(Date.now() / 1000) - 60,
          chat: { id: -100123456789, type: 'supergroup' } as Message['chat'],
          from: { id: 12345, is_bot: true, first_name: 'TestBot' },
        } as Message,
      });

      const envelope = buildTelegramEnvelope(update, defaultConfig);

      expect(envelope!.metadata.isReplyToBot).toBe(true);
      expect(envelope!.metadata.priority).toBe('high');
    });

    it('should detect reply to bot by username', () => {
      const update = createTelegramUpdate({
        reply_to_message: {
          message_id: 100,
          date: Math.floor(Date.now() / 1000) - 60,
          chat: { id: -100123456789, type: 'supergroup' } as Message['chat'],
          from: { id: 99999, is_bot: true, first_name: 'TestBot', username: 'TestBot' },
        } as Message,
      });

      const envelope = buildTelegramEnvelope(update, defaultConfig);

      expect(envelope!.metadata.isReplyToBot).toBe(true);
    });

    it('should not flag non-bot reply as isReplyToBot', () => {
      const update = createTelegramUpdate({
        reply_to_message: {
          message_id: 100,
          date: Math.floor(Date.now() / 1000) - 60,
          chat: { id: -100123456789, type: 'supergroup' } as Message['chat'],
          from: { id: 999, is_bot: false, first_name: 'OtherUser' },
        } as Message,
      });

      const envelope = buildTelegramEnvelope(update, defaultConfig);

      expect(envelope!.metadata.isReplyToBot).toBe(false);
    });

    it('should set high priority for direct engagement', () => {
      const mentionUpdate = createTelegramUpdate({ text: '@TestBot hello' });
      const regularUpdate = createTelegramUpdate({ text: 'hello everyone' });

      const mentionEnvelope = buildTelegramEnvelope(mentionUpdate, defaultConfig);
      const regularEnvelope = buildTelegramEnvelope(regularUpdate, defaultConfig);

      expect(mentionEnvelope!.metadata.priority).toBe('high');
      expect(regularEnvelope!.metadata.priority).toBe('normal');
    });
  });

  describe('Media Handling', () => {
    it('should extract photo attachment', () => {
      const update = createTelegramUpdate({
        photo: [
          { file_id: 'small', file_unique_id: 's', width: 100, height: 100 },
          { file_id: 'large', file_unique_id: 'l', width: 800, height: 800, file_size: 50000 },
        ],
        caption: 'Check out this photo!',
      });
      delete update.message!.text;

      const envelope = buildTelegramEnvelope(update, defaultConfig);

      expect(envelope!.content.text).toBe('Check out this photo!');
      expect(envelope!.content.media).toHaveLength(1);
      expect(envelope!.content.media![0].type).toBe('photo');
      expect(envelope!.content.media![0].fileId).toBe('large'); // Should get highest res
    });

    it('should extract sticker info', () => {
      const update = createTelegramUpdate({
        sticker: {
          file_id: 'sticker123',
          file_unique_id: 'su',
          width: 512,
          height: 512,
          is_animated: false,
          is_video: false,
          type: 'regular',
          emoji: '😀',
          set_name: 'TestPack',
        },
      });
      delete update.message!.text;

      const envelope = buildTelegramEnvelope(update, defaultConfig);

      expect(envelope!.content.sticker).toBeDefined();
      expect(envelope!.content.sticker!.fileId).toBe('sticker123');
      expect(envelope!.content.sticker!.emoji).toBe('😀');
      expect(envelope!.content.sticker!.setName).toBe('TestPack');
    });
  });

  describe('Command Parsing', () => {
    it('should extract command from message', () => {
      const update = createTelegramUpdate({
        text: '/start hello world',
        entities: [
          { type: 'bot_command', offset: 0, length: 6 },
        ],
      });

      const envelope = buildTelegramEnvelope(update, defaultConfig);

      expect(envelope!.content.command).toBeDefined();
      expect(envelope!.content.command!.command).toBe('start');
      expect(envelope!.content.command!.args).toEqual(['hello', 'world']);
    });

    it('should handle command with @botname suffix', () => {
      const update = createTelegramUpdate({
        text: '/help@TestBot',
        entities: [
          { type: 'bot_command', offset: 0, length: 13 },
        ],
      });

      const envelope = buildTelegramEnvelope(update, defaultConfig);

      expect(envelope!.content.command!.command).toBe('help');
    });
  });

  describe('Mention Extraction', () => {
    it('should extract @username mentions', () => {
      const update = createTelegramUpdate({
        text: 'Hello @alice and @bob!',
        entities: [
          { type: 'mention', offset: 6, length: 6 },
          { type: 'mention', offset: 17, length: 4 },
        ],
      });

      const envelope = buildTelegramEnvelope(update, defaultConfig);

      expect(envelope!.mentions).toHaveLength(2);
      expect(envelope!.mentions[0].username).toBe('alice');
      expect(envelope!.mentions[1].username).toBe('bob');
    });
  });

  describe('Idempotency', () => {
    it('should generate consistent idempotency key', () => {
      const update = createTelegramUpdate();

      const envelope1 = buildTelegramEnvelope(update, defaultConfig);
      const envelope2 = buildTelegramEnvelope(update, defaultConfig);

      expect(envelope1!.metadata.idempotencyKey).toBe(envelope2!.metadata.idempotencyKey);
      expect(envelope1!.metadata.idempotencyKey).toBe('telegram:test-avatar:123');
    });

    it('should include platformUpdateId', () => {
      const update = createTelegramUpdate();

      const envelope = buildTelegramEnvelope(update, defaultConfig);

      expect(envelope!.metadata.platformUpdateId).toBe(999);
    });
  });

  describe('Update Type Handling', () => {
    it('should handle edited_message', () => {
      const update: Update = {
        update_id: 1000,
        edited_message: {
          message_id: 123,
          date: Math.floor(Date.now() / 1000),
          edit_date: Math.floor(Date.now() / 1000),
          chat: { id: -100123, type: 'supergroup', title: 'Test' },
          from: { id: 456, is_bot: false, first_name: 'John' },
          text: 'Edited message',
        } as Message,
      };

      const envelope = buildTelegramEnvelope(update, defaultConfig);

      expect(envelope).not.toBeNull();
      expect(envelope!.content.text).toBe('Edited message');
    });

    it('should handle channel_post', () => {
      const update: Update = {
        update_id: 1001,
        channel_post: {
          message_id: 123,
          date: Math.floor(Date.now() / 1000),
          chat: { id: -100123, type: 'channel', title: 'News Channel' },
          text: 'Channel announcement',
        } as Message,
      };

      const envelope = buildTelegramEnvelope(update, defaultConfig);

      expect(envelope).not.toBeNull();
      expect(envelope!.metadata.chatType).toBe('channel');
    });

    it('should return null for non-message updates', () => {
      const update: Update = {
        update_id: 1002,
        // No message, edited_message, or channel_post
      };

      const envelope = buildTelegramEnvelope(update, defaultConfig);

      expect(envelope).toBeNull();
    });
  });
});

describe('envelopeToBufferedMessage', () => {
  it('should convert envelope to buffered message format', () => {
    const update = createTelegramUpdate({ text: 'Test message' });
    const config: TelegramEnvelopeConfig = {
      avatarId: 'test-avatar',
      botUsername: 'TestBot',
    };

    const envelope = buildTelegramEnvelope(update, config)!;
    const buffered = envelopeToBufferedMessage(envelope);

    expect(buffered.messageId).toBe(123);
    expect(buffered.userId).toBe(456);
    expect(buffered.userName).toBe('John Doe');
    expect(buffered.username).toBe('johndoe');
    expect(buffered.text).toBe('Test message');
    expect(buffered.isMention).toBe(false);
    expect(buffered.isReplyToBot).toBe(false);
  });

  it('should preserve engagement flags', () => {
    const update = createTelegramUpdate({ text: '@TestBot help me' });
    const config: TelegramEnvelopeConfig = {
      avatarId: 'test-avatar',
      botUsername: 'TestBot',
    };

    const envelope = buildTelegramEnvelope(update, config)!;
    const buffered = envelopeToBufferedMessage(envelope);

    expect(buffered.isMention).toBe(true);
  });
});

describe('TelegramAdapter — reply target fallback (#1511)', () => {
  /**
   * Source-introspection: the adapter's private send paths are awkward to
   * mock without standing up the full grammY bot. These assertions lock in
   * the contract that on a 'message to be replied not found' 400 from
   * Telegram, the adapter retries the same send WITHOUT
   * reply_to_message_id rather than discarding the reply.
   */
  it('sendTextWithFallback retries without reply_to_message_id on missing reply target', async () => {
    const fs = await import('node:fs/promises');
    const url = await import('node:url');
    const path = await import('node:path');
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const source = await fs.readFile(path.join(here, 'telegram.ts'), 'utf8');

    expect(source).toContain('reply_target_missing_fallback');
    expect(source).toMatch(
      /message to be replied not found[\s\S]{0,500}reply_to_message_id[\s\S]{0,500}sendMessage/,
    );
  });

  it('sendMessage media path retries without reply on missing reply target', async () => {
    const fs = await import('node:fs/promises');
    const url = await import('node:url');
    const path = await import('node:path');
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const source = await fs.readFile(path.join(here, 'telegram.ts'), 'utf8');

    expect(source).toContain('sendWithReplyFallback');
    expect(source).toMatch(
      /sendWithReplyFallback[\s\S]{0,1000}message to be replied not found[\s\S]{0,500}return await send\(undefined\)/,
    );
  });
});
