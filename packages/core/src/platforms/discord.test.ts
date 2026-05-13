/**
 * Discord Platform Adapter Tests
 * Tests for DiscordAdapter and buildDiscordEnvelope
 *
 * @see packages/core/src/platforms/discord.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { DiscordAdapter, buildDiscordEnvelope, type DiscordMessage, type DiscordInteraction, type DiscordCredentials } from './discord.js';
import type { AvatarConfig, DiscordConfig } from '../types/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createDiscordMessage(overrides: Partial<DiscordMessage> = {}): DiscordMessage {
  const defaultAuthor: DiscordMessage['author'] = {
    id: '444555666',
    username: 'testuser',
    global_name: 'Test User',
    bot: false,
  };

  // If caller provides author, use it directly (allows testing missing fields like global_name)
  const author = overrides.author ? overrides.author : defaultAuthor;

  const { author: _author, ...restOverrides } = overrides;

  return {
    id: '123456789',
    channel_id: '987654321',
    guild_id: '111222333',
    author,
    content: 'hello world',
    timestamp: '2024-01-01T00:00:00.000Z',
    tts: false,
    mention_everyone: false,
    mentions: [],
    attachments: [],
    embeds: [],
    type: 0,
    ...restOverrides,
  };
}

function createDiscordInteraction(overrides: Partial<DiscordInteraction> = {}): DiscordInteraction {
  return {
    id: 'int-001',
    application_id: 'app-123',
    type: 2, // APPLICATION_COMMAND
    guild_id: '111222333',
    channel_id: '987654321',
    member: {
      user: {
        id: '444555666',
        username: 'testuser',
        global_name: 'Test User',
        bot: false,
      },
      roles: ['role-1'],
      permissions: '2147483647',
    },
    token: 'interaction-token-xyz',
    data: {
      id: 'cmd-001',
      name: 'help',
      type: 1,
    },
    ...overrides,
  };
}

function createAvatarConfig(discordOverrides: Partial<DiscordConfig> = {}): AvatarConfig {
  return {
    id: 'test-avatar',
    name: 'TestBot',
    version: '1.0.0',
    persona: 'A helpful test bot',
    platforms: {
      discord: {
        enabled: true,
        mode: 'bot',
        applicationId: 'app-123',
        publicKey: 'test-public-key',
        respondToMentions: true,
        respondInDMs: true,
        ...discordOverrides,
      },
    },
    llm: {
      provider: 'bedrock',
      model: 'anthropic.claude-3-haiku',
      temperature: 0.7,
      maxTokens: 1024,
    },
    media: {
      image: {
        provider: 'replicate',
        model: 'stability-ai/sdxl',
      },
    },
    scheduling: {},
    behavior: {
      responseDelayMs: [500, 1500],
      typingIndicator: true,
      ignoreBots: true,
      cooldownMinutes: 5,
      maxContextMessages: 20,
    },
    tools: [],
    secrets: [],
  };
}

function createCredentials(overrides: Partial<DiscordCredentials> = {}): DiscordCredentials {
  return {
    botToken: 'Bot-Token-123',
    applicationId: 'app-123',
    publicKey: 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
    ...overrides,
  };
}

function createDiscordAdapter(
  discordConfigOverrides: Partial<DiscordConfig> = {},
  credentialOverrides: Partial<DiscordCredentials> = {},
): DiscordAdapter {
  const avatarConfig = createAvatarConfig(discordConfigOverrides);
  const credentials = createCredentials(credentialOverrides);
  return new DiscordAdapter(avatarConfig, credentials);
}

// ---------------------------------------------------------------------------
// Test suites
// ---------------------------------------------------------------------------

describe('DiscordAdapter', () => {

  // =========================================================================
  // isConfigured
  // =========================================================================
  describe('isConfigured', () => {
    it('should return true for bot mode with bot token', () => {
      const adapter = createDiscordAdapter({ mode: 'bot' }, { botToken: 'tok' });
      expect(adapter.isConfigured()).toBe(true);
    });

    it('should return false for bot mode without bot token', () => {
      const adapter = createDiscordAdapter({ mode: 'bot' }, { botToken: undefined });
      expect(adapter.isConfigured()).toBe(false);
    });

    it('should return true for webhook mode with webhook URL', () => {
      const adapter = createDiscordAdapter(
        { mode: 'webhook' },
        { webhookUrl: 'https://discord.com/api/webhooks/123/abc' },
      );
      expect(adapter.isConfigured()).toBe(true);
    });

    it('should return true for webhook mode with webhookId + webhookToken', () => {
      const adapter = createDiscordAdapter(
        { mode: 'webhook' },
        { webhookId: '123', webhookToken: 'abc', webhookUrl: undefined },
      );
      expect(adapter.isConfigured()).toBe(true);
    });

    it('should return false for webhook mode without webhook credentials', () => {
      const adapter = createDiscordAdapter(
        { mode: 'webhook' },
        { webhookUrl: undefined, webhookId: undefined, webhookToken: undefined },
      );
      expect(adapter.isConfigured()).toBe(false);
    });

    it('should return true for hybrid mode with webhook + bot token', () => {
      const adapter = createDiscordAdapter(
        { mode: 'hybrid' },
        { webhookUrl: 'https://discord.com/api/webhooks/1/x', botToken: 'tok' },
      );
      expect(adapter.isConfigured()).toBe(true);
    });

    it('should return false for hybrid mode without bot token', () => {
      const adapter = createDiscordAdapter(
        { mode: 'hybrid' },
        { webhookUrl: 'https://discord.com/api/webhooks/1/x', botToken: undefined },
      );
      expect(adapter.isConfigured()).toBe(false);
    });

    it('should return false when discord config is disabled', () => {
      const adapter = createDiscordAdapter({ enabled: false });
      expect(adapter.isConfigured()).toBe(false);
    });
  });

  // =========================================================================
  // getDisplayName
  // =========================================================================
  describe('getDisplayName', () => {
    it('should include mode in display name', () => {
      const adapter = createDiscordAdapter({ mode: 'bot' });
      expect(adapter.getDisplayName()).toBe('Discord (bot mode)');
    });

    it('should reflect webhook mode', () => {
      const adapter = createDiscordAdapter({ mode: 'webhook' });
      expect(adapter.getDisplayName()).toBe('Discord (webhook mode)');
    });

    it('should reflect hybrid mode', () => {
      const adapter = createDiscordAdapter({ mode: 'hybrid' });
      expect(adapter.getDisplayName()).toBe('Discord (hybrid mode)');
    });
  });

  // =========================================================================
  // Message Parsing (parseMessage / parseMessageEvent)
  // =========================================================================
  describe('Message Parsing', () => {
    it('should parse basic text message with sender info', async () => {
      const adapter = createDiscordAdapter();
      const msg = createDiscordMessage();
      const envelope = await adapter.parseMessage(msg);

      expect(envelope).not.toBeNull();
      expect(envelope!.platform).toBe('discord');
      expect(envelope!.avatarId).toBe('test-avatar');
      expect(envelope!.content.text).toBe('hello world');
      expect(envelope!.sender.id).toBe('444555666');
      expect(envelope!.sender.username).toBe('testuser');
      expect(envelope!.sender.displayName).toBe('Test User');
      expect(envelope!.sender.isBot).toBe(false);
      expect(envelope!.sender.platform).toBe('discord');
      expect(envelope!.sender.platformUserId).toBe('444555666');
    });

    it('should set conversationId from channel_id', async () => {
      const adapter = createDiscordAdapter();
      const msg = createDiscordMessage({ channel_id: 'chan-999' });
      const envelope = await adapter.parseMessage(msg);

      expect(envelope!.conversationId).toBe('chan-999');
    });

    it('should set correct idempotency key format', async () => {
      const adapter = createDiscordAdapter();
      const msg = createDiscordMessage({ id: 'msg-42' });
      const envelope = await adapter.parseMessage(msg);

      expect(envelope!.metadata.idempotencyKey).toBe('discord:test-avatar:msg-42');
    });

    it('should set timestamp from ISO string', async () => {
      const adapter = createDiscordAdapter();
      const msg = createDiscordMessage({ timestamp: '2024-06-15T12:00:00.000Z' });
      const envelope = await adapter.parseMessage(msg);

      expect(envelope!.timestamp).toBe(new Date('2024-06-15T12:00:00.000Z').getTime());
    });

    it('should fall back to username when global_name is absent', async () => {
      const adapter = createDiscordAdapter();
      const msg = createDiscordMessage({
        author: { id: '111', username: 'fallbackuser', bot: false } as DiscordMessage['author'],
      });
      const envelope = await adapter.parseMessage(msg);

      expect(envelope!.sender.displayName).toBe('fallbackuser');
    });

    it('should skip bot messages when ignoreBots is true', async () => {
      const adapter = createDiscordAdapter();
      const msg = createDiscordMessage({
        author: { id: '999', username: 'bot', global_name: 'Bot', bot: true },
      });
      const envelope = await adapter.parseMessage(msg);

      expect(envelope).toBeNull();
    });

    it('should not skip bot messages when ignoreBots is false', async () => {
      const avatarConfig = createAvatarConfig();
      avatarConfig.behavior.ignoreBots = false;
      const credentials = createCredentials();
      const adapter = new DiscordAdapter(avatarConfig, credentials);

      const msg = createDiscordMessage({
        author: { id: '999', username: 'bot', global_name: 'Bot', bot: true },
      });
      const envelope = await adapter.parseMessage(msg);

      expect(envelope).not.toBeNull();
    });

    it('should detect guild message (group chat type)', async () => {
      const adapter = createDiscordAdapter();
      const msg = createDiscordMessage({ guild_id: 'guild-1' });
      const envelope = await adapter.parseMessage(msg);

      expect(envelope!.metadata.chatType).toBe('group');
      expect(envelope!.metadata.guildId).toBe('guild-1');
    });

    it('should detect DM (private chat type) when guild_id is absent', async () => {
      const adapter = createDiscordAdapter();
      const msg = createDiscordMessage({ guild_id: undefined });
      const envelope = await adapter.parseMessage(msg);

      expect(envelope!.metadata.chatType).toBe('private');
      expect(envelope!.metadata.guildId).toBeUndefined();
    });

    // --- Attachments ---
    describe('Attachments', () => {
      it('should extract image attachments', async () => {
        const adapter = createDiscordAdapter();
        const msg = createDiscordMessage({
          attachments: [
            {
              id: 'att-1',
              filename: 'photo.png',
              content_type: 'image/png',
              size: 12345,
              url: 'https://cdn.discord.com/att/photo.png',
              proxy_url: 'https://proxy/photo.png',
              width: 800,
              height: 600,
            },
          ],
        });
        const envelope = await adapter.parseMessage(msg);

        expect(envelope!.content.media).toHaveLength(1);
        expect(envelope!.content.media![0].type).toBe('photo');
        expect(envelope!.content.media![0].url).toBe('https://cdn.discord.com/att/photo.png');
        expect(envelope!.content.media![0].mimeType).toBe('image/png');
        expect(envelope!.content.media![0].size).toBe(12345);
      });

      it('should extract video attachments', async () => {
        const adapter = createDiscordAdapter();
        const msg = createDiscordMessage({
          attachments: [
            {
              id: 'att-v',
              filename: 'clip.mp4',
              content_type: 'video/mp4',
              size: 500000,
              url: 'https://cdn.discord.com/att/clip.mp4',
              proxy_url: 'https://proxy/clip.mp4',
            },
          ],
        });
        const envelope = await adapter.parseMessage(msg);

        expect(envelope!.content.media).toHaveLength(1);
        expect(envelope!.content.media![0].type).toBe('video');
      });

      it('should extract document attachments', async () => {
        const adapter = createDiscordAdapter();
        const msg = createDiscordMessage({
          attachments: [
            {
              id: 'att-d',
              filename: 'notes.pdf',
              content_type: 'application/pdf',
              size: 8000,
              url: 'https://cdn.discord.com/att/notes.pdf',
              proxy_url: 'https://proxy/notes.pdf',
            },
          ],
        });
        const envelope = await adapter.parseMessage(msg);

        expect(envelope!.content.media).toHaveLength(1);
        expect(envelope!.content.media![0].type).toBe('document');
      });

      it('should handle multiple attachments', async () => {
        const adapter = createDiscordAdapter();
        const msg = createDiscordMessage({
          attachments: [
            { id: 'a1', filename: 'a.png', content_type: 'image/png', size: 100, url: 'u1', proxy_url: 'p1' },
            { id: 'a2', filename: 'b.mp4', content_type: 'video/mp4', size: 200, url: 'u2', proxy_url: 'p2' },
          ],
        });
        const envelope = await adapter.parseMessage(msg);

        expect(envelope!.content.media).toHaveLength(2);
        expect(envelope!.content.media![0].type).toBe('photo');
        expect(envelope!.content.media![1].type).toBe('video');
      });

      it('should not include media when no attachments', async () => {
        const adapter = createDiscordAdapter();
        const msg = createDiscordMessage({ attachments: [] });
        const envelope = await adapter.parseMessage(msg);

        expect(envelope!.content.media).toBeUndefined();
      });
    });

    // --- Mentions ---
    describe('Mentions', () => {
      it('should extract @mentions with correct offsets', async () => {
        const adapter = createDiscordAdapter();
        const msg = createDiscordMessage({
          content: 'Hey <@444555666> check this',
          mentions: [
            { id: '444555666', username: 'testuser', global_name: 'Test User' },
          ],
        });
        const envelope = await adapter.parseMessage(msg);

        expect(envelope!.mentions).toHaveLength(1);
        expect(envelope!.mentions[0].userId).toBe('444555666');
        expect(envelope!.mentions[0].username).toBe('testuser');
        expect(envelope!.mentions[0].offset).toBe(4); // "Hey " = 4 chars
        expect(envelope!.mentions[0].length).toBe('<@444555666>'.length);
      });

      it('should detect bot @mention and set priority high', async () => {
        const adapter = createDiscordAdapter();
        adapter.setBotUserId('777888999');

        const msg = createDiscordMessage({
          content: 'Hello <@777888999>!',
          mentions: [
            { id: '777888999', username: 'testbot', global_name: 'TestBot' },
          ],
        });
        const envelope = await adapter.parseMessage(msg);

        expect(envelope!.metadata.isMention).toBe(true);
        expect(envelope!.metadata.priority).toBe('high');
      });

      it('should not flag isMention when bot user id is not set', async () => {
        const adapter = createDiscordAdapter();
        // Do NOT call setBotUserId

        const msg = createDiscordMessage({
          content: 'Hello <@777888999>!',
          mentions: [
            { id: '777888999', username: 'testbot', global_name: 'TestBot' },
          ],
        });
        const envelope = await adapter.parseMessage(msg);

        expect(envelope!.metadata.isMention).toBe(false);
        expect(envelope!.metadata.priority).toBe('normal');
      });

      it('should not flag isMention when mentioning a different user', async () => {
        const adapter = createDiscordAdapter();
        adapter.setBotUserId('777888999');

        const msg = createDiscordMessage({
          content: 'Hello <@000111222>!',
          mentions: [
            { id: '000111222', username: 'other', global_name: 'Other' },
          ],
        });
        const envelope = await adapter.parseMessage(msg);

        expect(envelope!.metadata.isMention).toBe(false);
        expect(envelope!.metadata.priority).toBe('normal');
      });
    });

    // --- Reply to bot ---
    describe('Reply to bot', () => {
      it('should detect reply-to-bot and set priority high', async () => {
        const adapter = createDiscordAdapter();
        adapter.setBotUserId('777888999');

        const referencedMsg = createDiscordMessage({
          id: 'ref-msg',
          author: { id: '777888999', username: 'testbot', global_name: 'TestBot', bot: true },
        });

        const msg = createDiscordMessage({
          referenced_message: referencedMsg,
        });
        const envelope = await adapter.parseMessage(msg);

        expect(envelope!.metadata.isReplyToBot).toBe(true);
        expect(envelope!.metadata.priority).toBe('high');
        expect(envelope!.replyTo).toBe('ref-msg');
      });

      it('should not flag isReplyToBot when replying to a different user', async () => {
        const adapter = createDiscordAdapter();
        adapter.setBotUserId('777888999');

        const referencedMsg = createDiscordMessage({
          id: 'ref-msg',
          author: { id: '000111222', username: 'other', global_name: 'Other', bot: false },
        });

        const msg = createDiscordMessage({
          referenced_message: referencedMsg,
        });
        const envelope = await adapter.parseMessage(msg);

        expect(envelope!.metadata.isReplyToBot).toBe(false);
        expect(envelope!.metadata.priority).toBe('normal');
      });
    });

    // --- Channel / Guild filtering ---
    describe('Channel and Guild Filtering', () => {
      it('should filter out messages from disallowed guilds', async () => {
        const adapter = createDiscordAdapter({ allowedGuilds: ['guild-allowed'] });
        const msg = createDiscordMessage({ guild_id: 'guild-blocked' });
        const envelope = await adapter.parseMessage(msg);

        expect(envelope).toBeNull();
      });

      it('should allow messages from allowed guilds', async () => {
        const adapter = createDiscordAdapter({ allowedGuilds: ['guild-allowed'] });
        const msg = createDiscordMessage({ guild_id: 'guild-allowed' });
        const envelope = await adapter.parseMessage(msg);

        expect(envelope).not.toBeNull();
      });

      it('should not filter when allowedGuilds is empty', async () => {
        const adapter = createDiscordAdapter({ allowedGuilds: [] });
        const msg = createDiscordMessage({ guild_id: 'any-guild' });
        const envelope = await adapter.parseMessage(msg);

        expect(envelope).not.toBeNull();
      });

      it('should filter out messages from disallowed channels', async () => {
        const adapter = createDiscordAdapter({ allowedChannels: ['chan-allowed'] });
        const msg = createDiscordMessage({ channel_id: 'chan-blocked' });
        const envelope = await adapter.parseMessage(msg);

        expect(envelope).toBeNull();
      });

      it('should allow messages from allowed channels', async () => {
        const adapter = createDiscordAdapter({ allowedChannels: ['chan-allowed'] });
        const msg = createDiscordMessage({ channel_id: 'chan-allowed' });
        const envelope = await adapter.parseMessage(msg);

        expect(envelope).not.toBeNull();
      });

      it('should not filter when allowedChannels is empty', async () => {
        const adapter = createDiscordAdapter({ allowedChannels: [] });
        const msg = createDiscordMessage({ channel_id: 'any-chan' });
        const envelope = await adapter.parseMessage(msg);

        expect(envelope).not.toBeNull();
      });

      it('should skip guild filter for DMs (no guild_id)', async () => {
        const adapter = createDiscordAdapter({ allowedGuilds: ['guild-1'] });
        const msg = createDiscordMessage({ guild_id: undefined });
        const envelope = await adapter.parseMessage(msg);

        // DMs have no guild_id, so the guild filter check is skipped
        // but allowedChannels could still apply
        expect(envelope).not.toBeNull();
      });
    });

    // --- Embeds ---
    describe('Embeds', () => {
      it('should parse message with embeds without error', async () => {
        const adapter = createDiscordAdapter();
        const msg = createDiscordMessage({
          embeds: [
            { title: 'Link Preview', description: 'A preview' },
          ],
        });
        const envelope = await adapter.parseMessage(msg);

        expect(envelope).not.toBeNull();
        // The adapter stores raw embeds but doesn't extract them into content.media
        expect(envelope!.content.text).toBe('hello world');
      });
    });
  });

  // =========================================================================
  // Interaction Parsing
  // =========================================================================
  describe('Interaction Parsing', () => {
    it('should detect interactions by type + token fields', async () => {
      const adapter = createDiscordAdapter();
      const interaction = createDiscordInteraction();
      const envelope = await adapter.parseMessage(interaction);

      expect(envelope).not.toBeNull();
      expect(envelope!.platform).toBe('discord');
    });

    it('should return null for PING interactions (type 1)', async () => {
      const adapter = createDiscordAdapter();
      const interaction = createDiscordInteraction({ type: 1 });
      const envelope = await adapter.parseMessage(interaction);

      expect(envelope).toBeNull();
    });

    it('should parse slash command with options', async () => {
      const adapter = createDiscordAdapter();
      const interaction = createDiscordInteraction({
        data: {
          id: 'cmd-1',
          name: 'greet',
          type: 1,
          options: [
            { name: 'user', type: 6, value: 'someone' },
            { name: 'style', type: 3, value: 'formal' },
          ],
        },
      });
      const envelope = await adapter.parseMessage(interaction);

      expect(envelope).not.toBeNull();
      expect(envelope!.content.text).toBe('/greet user:someone style:formal');
      expect(envelope!.content.command).toBeDefined();
      expect(envelope!.content.command!.command).toBe('greet');
      expect(envelope!.content.command!.args).toEqual(['someone', 'formal']);
    });

    it('should parse slash command without options', async () => {
      const adapter = createDiscordAdapter();
      const interaction = createDiscordInteraction({
        data: {
          id: 'cmd-2',
          name: 'ping',
          type: 1,
        },
      });
      const envelope = await adapter.parseMessage(interaction);

      expect(envelope!.content.text).toBe('/ping');
      expect(envelope!.content.command!.command).toBe('ping');
      expect(envelope!.content.command!.args).toEqual([]);
    });

    it('should extract sender from member.user in guild interactions', async () => {
      const adapter = createDiscordAdapter();
      const interaction = createDiscordInteraction({
        member: {
          user: { id: '111', username: 'guilduser', global_name: 'Guild User', bot: false },
          roles: [],
          permissions: '0',
        },
        user: undefined,
      });
      const envelope = await adapter.parseMessage(interaction);

      expect(envelope!.sender.id).toBe('111');
      expect(envelope!.sender.username).toBe('guilduser');
      expect(envelope!.sender.displayName).toBe('Guild User');
    });

    it('should extract sender from user in DM interactions', async () => {
      const adapter = createDiscordAdapter();
      const interaction = createDiscordInteraction({
        guild_id: undefined,
        member: undefined,
        user: { id: '222', username: 'dmuser', global_name: 'DM User', bot: false },
      });
      const envelope = await adapter.parseMessage(interaction);

      expect(envelope!.sender.id).toBe('222');
      expect(envelope!.sender.username).toBe('dmuser');
    });

    it('should return null when no user is available', async () => {
      const adapter = createDiscordAdapter();
      const interaction = createDiscordInteraction({
        member: undefined,
        user: undefined,
      });
      const envelope = await adapter.parseMessage(interaction);

      expect(envelope).toBeNull();
    });

    it('should set chatType based on guild presence', async () => {
      const adapter = createDiscordAdapter();
      const guildInteraction = createDiscordInteraction({ guild_id: 'g1' });
      const dmInteraction = createDiscordInteraction({ guild_id: undefined });

      const guildEnvelope = await adapter.parseMessage(guildInteraction);
      const dmEnvelope = await adapter.parseMessage(dmInteraction);

      expect(guildEnvelope!.metadata.chatType).toBe('group');
      expect(dmEnvelope!.metadata.chatType).toBe('private');
    });

    it('should parse button/component interaction with message content', async () => {
      const adapter = createDiscordAdapter();
      const interaction = createDiscordInteraction({
        type: 3, // MESSAGE_COMPONENT
        data: undefined,
        message: createDiscordMessage({ content: 'Button context message' }),
      });
      const envelope = await adapter.parseMessage(interaction);

      expect(envelope).not.toBeNull();
      expect(envelope!.content.text).toBe('Button context message');
    });

    it('should handle interaction with no data and no message', async () => {
      const adapter = createDiscordAdapter();
      const interaction = createDiscordInteraction({
        type: 3,
        data: undefined,
        message: undefined,
      });
      const envelope = await adapter.parseMessage(interaction);

      expect(envelope).not.toBeNull();
      expect(envelope!.content.text).toBe('');
    });

    it('should set guildId in metadata', async () => {
      const adapter = createDiscordAdapter();
      const interaction = createDiscordInteraction({ guild_id: 'g-123' });
      const envelope = await adapter.parseMessage(interaction);

      expect(envelope!.metadata.guildId).toBe('g-123');
    });
  });

  // =========================================================================
  // Engagement Detection (via parseMessage)
  // =========================================================================
  describe('Engagement Detection', () => {
    it('should set priority high when bot is @mentioned', async () => {
      const adapter = createDiscordAdapter();
      adapter.setBotUserId('bot-id-1');

      const msg = createDiscordMessage({
        content: '<@bot-id-1> help',
        mentions: [{ id: 'bot-id-1', username: 'bot' }],
      });
      const envelope = await adapter.parseMessage(msg);

      expect(envelope!.metadata.isMention).toBe(true);
      expect(envelope!.metadata.priority).toBe('high');
    });

    it('should set priority high when replying to bot', async () => {
      const adapter = createDiscordAdapter();
      adapter.setBotUserId('bot-id-1');

      const msg = createDiscordMessage({
        referenced_message: createDiscordMessage({
          id: 'bot-reply',
          author: { id: 'bot-id-1', username: 'bot', bot: true },
        }),
      });
      const envelope = await adapter.parseMessage(msg);

      expect(envelope!.metadata.isReplyToBot).toBe(true);
      expect(envelope!.metadata.priority).toBe('high');
    });

    it('should set priority normal for regular messages', async () => {
      const adapter = createDiscordAdapter();
      adapter.setBotUserId('bot-id-1');

      const msg = createDiscordMessage({ content: 'just chatting' });
      const envelope = await adapter.parseMessage(msg);

      expect(envelope!.metadata.isMention).toBe(false);
      expect(envelope!.metadata.isReplyToBot).toBe(false);
      expect(envelope!.metadata.priority).toBe('normal');
    });
  });

  // =========================================================================
  // verifyRequest (Ed25519)
  // =========================================================================
  describe('verifyRequest', () => {
    it('should return false when signature header is missing', async () => {
      const adapter = createDiscordAdapter();
      const result = await adapter.verifyRequest(Buffer.from('{}'), {
        'x-signature-timestamp': '12345',
      });
      expect(result).toBe(false);
    });

    it('should return false when timestamp header is missing', async () => {
      const adapter = createDiscordAdapter();
      const result = await adapter.verifyRequest(Buffer.from('{}'), {
        'x-signature-ed25519': 'abc',
      });
      expect(result).toBe(false);
    });

    it('should return false when both headers are missing', async () => {
      const adapter = createDiscordAdapter();
      const result = await adapter.verifyRequest(Buffer.from('{}'), {});
      expect(result).toBe(false);
    });

    it('should return false when publicKey is not configured', async () => {
      const adapter = createDiscordAdapter({}, { publicKey: undefined });
      const result = await adapter.verifyRequest(Buffer.from('{}'), {
        'x-signature-ed25519': 'abc',
        'x-signature-timestamp': '12345',
      });
      expect(result).toBe(false);
    });

    it('should return false for an invalid signature', async () => {
      const adapter = createDiscordAdapter({}, {
        publicKey: 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
      });
      const result = await adapter.verifyRequest(Buffer.from('{"type":1}'), {
        'x-signature-ed25519': '0000000000000000000000000000000000000000000000000000000000000000' +
          '0000000000000000000000000000000000000000000000000000000000000000',
        'x-signature-timestamp': '12345',
      });
      expect(result).toBe(false);
    });
  });

  // =========================================================================
  // executeAction
  // =========================================================================
  describe('executeAction', () => {
    let originalFetch: typeof globalThis.fetch;

    beforeEach(() => {
      originalFetch = globalThis.fetch;
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it('should send text message via bot API', async () => {
      let capturedUrl = '';
      let capturedInit: RequestInit | undefined;
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        capturedUrl = String(input);
        capturedInit = init;
        return new Response('{}', { status: 200 });
      }) as typeof fetch;

      const adapter = createDiscordAdapter({ mode: 'bot' });
      const result = await adapter.executeAction(
        { type: 'send_message', text: 'Hello!' },
        'chan-1',
      );

      expect(result).toBe(true);
      expect(capturedUrl).toContain('https://discord.com/api/v10/channels/chan-1/messages');
      expect(capturedInit?.method).toBe('POST');

      const body = JSON.parse(capturedInit!.body as string);
      expect(body.content).toBe('Hello!');
    });

    it('should send text message via webhook in webhook mode', async () => {
      let capturedUrl = '';
      let capturedInit: RequestInit | undefined;
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        capturedUrl = String(input);
        capturedInit = init;
        return new Response('{}', { status: 200 });
      }) as typeof fetch;

      const adapter = createDiscordAdapter(
        { mode: 'webhook' },
        { webhookUrl: 'https://discord.com/api/webhooks/123/token' },
      );
      const result = await adapter.executeAction(
        { type: 'send_message', text: 'Webhook hello!' },
        'chan-1',
      );

      expect(result).toBe(true);
      expect(capturedUrl).toContain('https://discord.com/api/webhooks/123/token');
      const body = JSON.parse(capturedInit!.body as string);
      expect(body.content).toBe('Webhook hello!');
      expect(body.username).toBe('TestBot');
    });

    it('should send text message via webhook in hybrid mode', async () => {
      let capturedUrl = '';
      globalThis.fetch = (async (input: string | URL | Request) => {
        capturedUrl = String(input);
        return new Response('{}', { status: 200 });
      }) as typeof fetch;

      const adapter = createDiscordAdapter(
        { mode: 'hybrid' },
        { webhookUrl: 'https://discord.com/api/webhooks/123/token', botToken: 'tok' },
      );
      const result = await adapter.executeAction(
        { type: 'send_message', text: 'Hybrid hello!' },
        'chan-1',
      );

      expect(result).toBe(true);
      expect(capturedUrl).toContain('webhooks');
    });

    it('should include message_reference when replying', async () => {
      let capturedBody: Record<string, unknown> = {};
      globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
        capturedBody = JSON.parse(init!.body as string);
        return new Response('{}', { status: 200 });
      }) as typeof fetch;

      const adapter = createDiscordAdapter({ mode: 'bot' });
      await adapter.executeAction(
        { type: 'send_message', text: 'Reply!' },
        'chan-1',
        'orig-msg-id',
      );

      expect(capturedBody.message_reference).toEqual({ message_id: 'orig-msg-id' });
    });

    it('should handle react action', async () => {
      let capturedUrl = '';
      let capturedMethod = '';
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        capturedUrl = String(input);
        capturedMethod = init?.method || 'GET';
        return new Response('', { status: 204 });
      }) as typeof fetch;

      const adapter = createDiscordAdapter({ mode: 'bot' });
      const result = await adapter.executeAction(
        { type: 'react', emoji: '👍', messageId: 'msg-1' },
        'chan-1',
      );

      expect(result).toBe(true);
      expect(capturedUrl).toContain('/reactions/');
      expect(capturedUrl).toContain(encodeURIComponent('👍'));
      expect(capturedMethod).toBe('PUT');
    });

    it('should handle wait action', async () => {
      const adapter = createDiscordAdapter();
      const start = Date.now();
      const result = await adapter.executeAction(
        { type: 'wait', durationMs: 50 },
        'chan-1',
      );
      const elapsed = Date.now() - start;

      expect(result).toBe(true);
      expect(elapsed).toBeGreaterThanOrEqual(40); // allow slight variance
    });

    it('should handle ignore action', async () => {
      const adapter = createDiscordAdapter();
      const result = await adapter.executeAction(
        { type: 'ignore', reason: 'not relevant' },
        'chan-1',
      );

      expect(result).toBe(true);
    });

    it('should return false on fetch error', async () => {
      globalThis.fetch = (async () => {
        throw new Error('Network error');
      }) as typeof fetch;

      const adapter = createDiscordAdapter({ mode: 'bot' });
      const result = await adapter.executeAction(
        { type: 'send_message', text: 'Fail' },
        'chan-1',
      );

      expect(result).toBe(false);
    });

    it('should handle send_media image via attachment upload (bot mode)', async () => {
      const capturedCalls: Array<{ url: string; contentType?: string; hasFormData: boolean }> = [];
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        const hasFormData = init?.body instanceof FormData;
        const contentType = (init?.headers as Record<string, string>)?.['Content-Type'];
        capturedCalls.push({ url, contentType, hasFormData });

        // First call = image byte fetch
        if (url === 'https://img.com/pic.png') {
          const imgBlob = new Blob([new Uint8Array(8)], { type: 'image/png' });
          return new Response(imgBlob, { status: 200, headers: { 'content-type': 'image/png' } });
        }
        // Second call = Discord attachment upload
        return new Response('{}', { status: 200 });
      }) as typeof fetch;

      const adapter = createDiscordAdapter({ mode: 'bot' });
      const result = await adapter.executeAction(
        { type: 'send_media', mediaType: 'image', url: 'https://img.com/pic.png', caption: 'Check this!' },
        'chan-1',
      );

      expect(result).toBe(true);
      // Should have made two fetch calls: image fetch + attachment upload
      expect(capturedCalls.length).toBe(2);
      expect(capturedCalls[0]!.url).toBe('https://img.com/pic.png');
      expect(capturedCalls[1]!.url).toContain('/channels/chan-1/messages');
      expect(capturedCalls[1]!.hasFormData).toBe(true);
    });

    it('should fall back to embed when image byte-fetch fails (bot mode)', async () => {
      let embedCallBody: Record<string, unknown> | null = null;
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        // First call = image byte fetch — fail it
        if (url === 'https://img.com/pic.png') {
          return new Response('not found', { status: 404 });
        }
        // Subsequent call = embed fallback via sendViaBot
        if (init?.body && typeof init.body === 'string') {
          embedCallBody = JSON.parse(init.body);
        }
        return new Response('{}', { status: 200 });
      }) as typeof fetch;

      const adapter = createDiscordAdapter({ mode: 'bot' });
      const result = await adapter.executeAction(
        { type: 'send_media', mediaType: 'image', url: 'https://img.com/pic.png', caption: 'Fallback test' },
        'chan-1',
      );

      expect(result).toBe(true);
      expect(embedCallBody).not.toBeNull();
      expect(embedCallBody!.content).toBe('Fallback test');
      // Should have image embed
      expect(Array.isArray(embedCallBody!.embeds)).toBe(true);
    });

    it('should handle send_media image via embed in global mode', async () => {
      let capturedPayload: Record<string, unknown> | null = null;
      const mockWm = {
        send: async (_channelId: string, payload: Record<string, unknown>) => {
          capturedPayload = payload;
        },
        getOrCreate: async () => ({ id: 'wh-1', token: 'tok' }),
      };
      const adapter = createDiscordAdapter(
        { mode: 'global' },
        { globalBotToken: 'gbt', webhookManager: mockWm as unknown as import('./discord-webhook-manager.js').DiscordWebhookManager },
      );

      const result = await adapter.executeAction(
        { type: 'send_media', mediaType: 'image', url: 'https://img.com/pic.png', caption: 'Global img' },
        'chan-1',
      );

      expect(result).toBe(true);
      expect(capturedPayload).not.toBeNull();
      expect(capturedPayload!.content).toBe('Global img');
      expect(Array.isArray(capturedPayload!.embeds)).toBe(true);
    });

    it('should handle send_media video by posting URL as message', async () => {
      let capturedBody: Record<string, unknown> = {};
      globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
        capturedBody = JSON.parse(init!.body as string);
        return new Response('{}', { status: 200 });
      }) as typeof fetch;

      const adapter = createDiscordAdapter({ mode: 'bot' });
      const result = await adapter.executeAction(
        { type: 'send_media', mediaType: 'video', url: 'https://vid.com/clip.mp4', caption: 'Watch this' },
        'chan-1',
      );

      expect(result).toBe(true);
      expect(capturedBody.content).toBe('Watch this\nhttps://vid.com/clip.mp4');
    });

    it('should handle send_media video without caption', async () => {
      let capturedBody: Record<string, unknown> = {};
      globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
        capturedBody = JSON.parse(init!.body as string);
        return new Response('{}', { status: 200 });
      }) as typeof fetch;

      const adapter = createDiscordAdapter({ mode: 'bot' });
      const result = await adapter.executeAction(
        { type: 'send_media', mediaType: 'video', url: 'https://vid.com/clip.mp4' },
        'chan-1',
      );

      expect(result).toBe(true);
      expect(capturedBody.content).toBe('https://vid.com/clip.mp4');
    });

    it('should handle send_media animation by downgrading to image embed', async () => {
      let capturedBody: Record<string, unknown> = {};
      globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
        capturedBody = JSON.parse(init!.body as string);
        return new Response('{}', { status: 200 });
      }) as typeof fetch;

      const adapter = createDiscordAdapter({ mode: 'bot' });
      const result = await adapter.executeAction(
        { type: 'send_media', mediaType: 'animation', url: 'https://img.com/anim.gif', caption: 'GIF time' },
        'chan-1',
      );

      expect(result).toBe(true);
      expect(capturedBody.content).toBe('GIF time');
      expect(Array.isArray(capturedBody.embeds)).toBe(true);
    });

    it('should send media embeds without a caption', async () => {
      let capturedBody: Record<string, unknown> = {};
      globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
        capturedBody = JSON.parse(init!.body as string);
        return new Response('{}', { status: 200 });
      }) as typeof fetch;

      const adapter = createDiscordAdapter({ mode: 'bot' });
      const result = await adapter.executeAction(
        { type: 'send_media', mediaType: 'animation', url: 'https://img.com/anim.gif' },
        'chan-1',
      );

      expect(result).toBe(true);
      expect(capturedBody.content).toBe('');
      expect(Array.isArray(capturedBody.embeds)).toBe(true);
    });

    it('should handle send_sticker by downgrading to emoji text', async () => {
      let capturedBody: Record<string, unknown> = {};
      globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
        capturedBody = JSON.parse(init!.body as string);
        return new Response('{}', { status: 200 });
      }) as typeof fetch;

      const adapter = createDiscordAdapter({ mode: 'bot' });
      const result = await adapter.executeAction(
        { type: 'send_sticker', emoji: '🐱' },
        'chan-1',
      );

      expect(result).toBe(true);
      expect(capturedBody.content).toBe('🐱');
    });

    it('should return false when send_media image upload and fallback both fail', async () => {
      globalThis.fetch = (async () => {
        throw new Error('Total network failure');
      }) as typeof fetch;

      const adapter = createDiscordAdapter({ mode: 'bot' });
      const result = await adapter.executeAction(
        { type: 'send_media', mediaType: 'image', url: 'https://img.com/pic.png', caption: 'Fail' },
        'chan-1',
      );

      expect(result).toBe(false);
    });

    it('should handle send_voice action by sending url as message', async () => {
      let capturedBody: Record<string, unknown> = {};
      globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
        capturedBody = JSON.parse(init!.body as string);
        return new Response('{}', { status: 200 });
      }) as typeof fetch;

      const adapter = createDiscordAdapter({ mode: 'bot' });
      const result = await adapter.executeAction(
        { type: 'send_voice', url: 'https://audio.com/voice.ogg', caption: 'Listen' },
        'chan-1',
      );

      expect(result).toBe(true);
      expect(capturedBody.content).toBe('Listen\nhttps://audio.com/voice.ogg');
    });

    it('should split messages over 2000 chars into multiple sends', async () => {
      const capturedBodies: Array<Record<string, unknown>> = [];
      let fetchCount = 0;
      globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
        fetchCount++;
        const body = JSON.parse(init!.body as string);
        capturedBodies.push(body);
        return new Response('{}', { status: 200 });
      }) as typeof fetch;

      const adapter = createDiscordAdapter({ mode: 'bot' });
      const longContent = 'x'.repeat(5000);
      const result = await adapter.executeAction(
        { type: 'send_message', text: longContent },
        'chan-1',
      );

      expect(result).toBe(true);
      expect(fetchCount).toBe(3);
      expect(capturedBodies.length).toBe(3);
      expect(capturedBodies[0].content).toBeDefined();
      expect((capturedBodies[0].content as string).length).toBeLessThanOrEqual(2000);
      expect((capturedBodies[1].content as string).length).toBeLessThanOrEqual(2000);
      expect((capturedBodies[2].content as string).length).toBeLessThanOrEqual(2000);
    });

    it('should only attach message_reference to first chunk when replying', async () => {
      const capturedBodies: Array<Record<string, unknown>> = [];
      globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(init!.body as string);
        capturedBodies.push(body);
        return new Response('{}', { status: 200 });
      }) as typeof fetch;

      const adapter = createDiscordAdapter({ mode: 'bot' });
      const longContent = 'x'.repeat(5000);
      const result = await adapter.executeAction(
        { type: 'send_message', text: longContent },
        'chan-1',
        'reply-to-msg-id',
      );

      expect(result).toBe(true);
      expect(capturedBodies.length).toBe(3);
      expect(capturedBodies[0].message_reference).toEqual({ message_id: 'reply-to-msg-id' });
      expect(capturedBodies[1].message_reference).toBeUndefined();
      expect(capturedBodies[2].message_reference).toBeUndefined();
    });

    it('should only attach embeds to first chunk when replying with media', async () => {
      const capturedBodies: Array<Record<string, unknown>> = [];
      globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(init!.body as string);
        capturedBodies.push(body);
        return new Response('{}', { status: 200 });
      }) as typeof fetch;

      const adapter = createDiscordAdapter({ mode: 'bot' });
      const longContent = 'x'.repeat(5000);
      const media = [{ type: 'image', url: 'https://example.com/img.png' }];
      const result = await adapter.executeAction(
        { type: 'send_message', text: longContent, media },
        'chan-1',
      );

      expect(result).toBe(true);
      expect(capturedBodies.length).toBe(3);
      expect(Array.isArray(capturedBodies[0].embeds)).toBe(true);
      expect(capturedBodies[1].embeds).toBeUndefined();
      expect(capturedBodies[2].embeds).toBeUndefined();
    });

    it('should not chunk messages under 2000 chars', async () => {
      let fetchCount = 0;
      globalThis.fetch = (async (_input: string | URL | Request, _init?: RequestInit) => {
        fetchCount++;
        return new Response('{}', { status: 200 });
      }) as typeof fetch;

      const adapter = createDiscordAdapter({ mode: 'bot' });
      const shortContent = 'x'.repeat(1000);
      const result = await adapter.executeAction(
        { type: 'send_message', text: shortContent },
        'chan-1',
      );

      expect(result).toBe(true);
      expect(fetchCount).toBe(1);
    });

    it('should chunk on sentence boundaries when possible', async () => {
      const capturedBodies: Array<Record<string, unknown>> = [];
      globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(init!.body as string);
        capturedBodies.push(body);
        return new Response('{}', { status: 200 });
      }) as typeof fetch;

      const adapter = createDiscordAdapter({ mode: 'bot' });
      // Create content with sentences that will naturally split on boundaries
      const sentence = 'This is a test sentence. ';
      const longContent = sentence.repeat(100); // ~2500 chars
      const result = await adapter.executeAction(
        { type: 'send_message', text: longContent },
        'chan-1',
      );

      expect(result).toBe(true);
      expect(capturedBodies.length).toBeGreaterThan(1);
      // Each chunk should respect the 2000 char limit
      for (const body of capturedBodies) {
        expect((body.content as string).length).toBeLessThanOrEqual(2000);
      }
    });
  });

  // =========================================================================
  // sendTypingIndicator
  // =========================================================================
  describe('sendTypingIndicator', () => {
    let originalFetch: typeof globalThis.fetch;

    beforeEach(() => {
      originalFetch = globalThis.fetch;
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it('should POST to typing endpoint with bot token', async () => {
      let capturedUrl = '';
      let capturedHeaders: Record<string, string> = {};
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        capturedUrl = String(input);
        capturedHeaders = Object.fromEntries(
          Object.entries(init?.headers || {})
        );
        return new Response('', { status: 204 });
      }) as typeof fetch;

      const adapter = createDiscordAdapter({ mode: 'bot' }, { botToken: 'my-bot-token' });
      await adapter.sendTypingIndicator('chan-1');

      expect(capturedUrl).toBe('https://discord.com/api/v10/channels/chan-1/typing');
      expect(capturedHeaders['Authorization']).toBe('Bot my-bot-token');
    });

    it('should silently skip when no bot token is available', async () => {
      let fetchCalled = false;
      globalThis.fetch = (async () => {
        fetchCalled = true;
        return new Response('', { status: 204 });
      }) as typeof fetch;

      const adapter = createDiscordAdapter({ mode: 'webhook' }, { botToken: undefined });
      await adapter.sendTypingIndicator('chan-1');

      expect(fetchCalled).toBe(false);
    });
  });

  // =========================================================================
  // respondToInteraction / deferInteraction / editInteractionResponse
  // =========================================================================
  describe('Interaction Responses', () => {
    let originalFetch: typeof globalThis.fetch;

    beforeEach(() => {
      originalFetch = globalThis.fetch;
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it('should respond to interaction with correct payload', async () => {
      let capturedUrl = '';
      let capturedBody: Record<string, unknown> = {};
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        capturedUrl = String(input);
        capturedBody = JSON.parse(init!.body as string);
        return new Response('', { status: 200 });
      }) as typeof fetch;

      const adapter = createDiscordAdapter();
      await adapter.respondToInteraction('int-1', 'tok-1', 'Hello!', false);

      expect(capturedUrl).toContain('/interactions/int-1/tok-1/callback');
      expect(capturedBody.type).toBe(4);
      expect((capturedBody.data as Record<string, unknown>).content).toBe('Hello!');
      expect((capturedBody.data as Record<string, unknown>).flags).toBe(0);
    });

    it('should set ephemeral flag when requested', async () => {
      let capturedBody: Record<string, unknown> = {};
      globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
        capturedBody = JSON.parse(init!.body as string);
        return new Response('', { status: 200 });
      }) as typeof fetch;

      const adapter = createDiscordAdapter();
      await adapter.respondToInteraction('int-1', 'tok-1', 'Secret!', true);

      expect((capturedBody.data as Record<string, unknown>).flags).toBe(64);
    });

    it('should defer an interaction', async () => {
      let capturedBody: Record<string, unknown> = {};
      globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
        capturedBody = JSON.parse(init!.body as string);
        return new Response('', { status: 200 });
      }) as typeof fetch;

      const adapter = createDiscordAdapter();
      await adapter.deferInteraction('int-1', 'tok-1');

      expect(capturedBody.type).toBe(5);
    });

    it('should edit an interaction response', async () => {
      let capturedUrl = '';
      let capturedMethod = '';
      let capturedBody: Record<string, unknown> = {};
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        capturedUrl = String(input);
        capturedMethod = init?.method || 'GET';
        capturedBody = JSON.parse(init!.body as string);
        return new Response('', { status: 200 });
      }) as typeof fetch;

      const adapter = createDiscordAdapter();
      await adapter.editInteractionResponse('app-1', 'tok-1', 'Updated!');

      expect(capturedUrl).toContain('/webhooks/app-1/tok-1/messages/@original');
      expect(capturedMethod).toBe('PATCH');
      expect(capturedBody.content).toBe('Updated!');
    });
  });
});

// ===========================================================================
// buildDiscordEnvelope (standalone function)
// ===========================================================================
describe('buildDiscordEnvelope', () => {
  const defaultConfig = {
    avatarId: 'test-avatar',
    botUserId: 'bot-999',
  };

  describe('Basic Message Parsing', () => {
    it('should create envelope from basic text message', () => {
      const msg = createDiscordMessage();
      const envelope = buildDiscordEnvelope(msg, defaultConfig);

      expect(envelope).not.toBeNull();
      expect(envelope!.avatarId).toBe('test-avatar');
      expect(envelope!.platform).toBe('discord');
      expect(envelope!.messageId).toBe('123456789');
      expect(envelope!.conversationId).toBe('987654321');
      expect(envelope!.content.text).toBe('hello world');
    });

    it('should extract sender info correctly', () => {
      const msg = createDiscordMessage();
      const envelope = buildDiscordEnvelope(msg, defaultConfig);

      expect(envelope!.sender.id).toBe('444555666');
      expect(envelope!.sender.username).toBe('testuser');
      expect(envelope!.sender.displayName).toBe('Test User');
      expect(envelope!.sender.isBot).toBe(false);
      expect(envelope!.sender.platform).toBe('discord');
      expect(envelope!.sender.platformUserId).toBe('444555666');
    });

    it('should fall back to username when global_name is absent', () => {
      const msg = createDiscordMessage({
        author: { id: '111', username: 'noname', bot: false } as DiscordMessage['author'],
      });
      const envelope = buildDiscordEnvelope(msg, defaultConfig);

      expect(envelope!.sender.displayName).toBe('noname');
    });
  });

  describe('Bot Filtering', () => {
    it('should filter bot messages when ignoreBots is true', () => {
      const msg = createDiscordMessage({
        author: { id: '999', username: 'bot', global_name: 'Bot', bot: true },
      });
      const envelope = buildDiscordEnvelope(msg, { ...defaultConfig, ignoreBots: true });

      expect(envelope).toBeNull();
    });

    it('should not filter bot messages when ignoreBots is false', () => {
      const msg = createDiscordMessage({
        author: { id: '999', username: 'bot', global_name: 'Bot', bot: true },
      });
      const envelope = buildDiscordEnvelope(msg, { ...defaultConfig, ignoreBots: false });

      expect(envelope).not.toBeNull();
    });

    it('should not filter bot messages when ignoreBots is unset', () => {
      const msg = createDiscordMessage({
        author: { id: '999', username: 'bot', global_name: 'Bot', bot: true },
      });
      const envelope = buildDiscordEnvelope(msg, defaultConfig);

      expect(envelope).not.toBeNull();
    });
  });

  describe('Own-Message Filter (Self-Reply Loop Protection)', () => {
    it('should filter own messages when botUserId matches author.id', () => {
      const msg = createDiscordMessage({
        author: { id: 'bot-999', username: 'bot', global_name: 'Bot', bot: true },
      });
      const envelope = buildDiscordEnvelope(msg, { ...defaultConfig, botUserId: 'bot-999' });

      expect(envelope).toBeNull();
    });

    it('should not filter messages from other users when botUserId is set', () => {
      const msg = createDiscordMessage({
        author: { id: 'user-111', username: 'user', global_name: 'User', bot: false },
      });
      const envelope = buildDiscordEnvelope(msg, { ...defaultConfig, botUserId: 'bot-999' });

      expect(envelope).not.toBeNull();
    });

    it('should proceed normally when botUserId is not set', () => {
      const msg = createDiscordMessage({
        author: { id: 'bot-999', username: 'bot', global_name: 'Bot', bot: true },
      });
      const envelope = buildDiscordEnvelope(msg, { avatarId: 'test-avatar' });

      expect(envelope).not.toBeNull();
    });
  });

  describe('Guild and Channel Filtering', () => {
    it('should filter by allowedGuilds', () => {
      const msg = createDiscordMessage({ guild_id: 'bad-guild' });
      const envelope = buildDiscordEnvelope(msg, {
        ...defaultConfig,
        allowedGuilds: ['good-guild'],
      });

      expect(envelope).toBeNull();
    });

    it('should allow matching guild', () => {
      const msg = createDiscordMessage({ guild_id: 'good-guild' });
      const envelope = buildDiscordEnvelope(msg, {
        ...defaultConfig,
        allowedGuilds: ['good-guild'],
      });

      expect(envelope).not.toBeNull();
    });

    it('should filter by allowedChannels', () => {
      const msg = createDiscordMessage({ channel_id: 'bad-chan' });
      const envelope = buildDiscordEnvelope(msg, {
        ...defaultConfig,
        allowedChannels: ['good-chan'],
      });

      expect(envelope).toBeNull();
    });

    it('should allow matching channel', () => {
      const msg = createDiscordMessage({ channel_id: 'good-chan' });
      const envelope = buildDiscordEnvelope(msg, {
        ...defaultConfig,
        allowedChannels: ['good-chan'],
      });

      expect(envelope).not.toBeNull();
    });
  });

  describe('Mention and Reply Detection', () => {
    it('should detect bot @mention', () => {
      const msg = createDiscordMessage({
        content: 'Hey <@bot-999>!',
        mentions: [{ id: 'bot-999', username: 'bot' }],
      });
      const envelope = buildDiscordEnvelope(msg, defaultConfig);

      expect(envelope!.metadata.isMention).toBe(true);
      expect(envelope!.metadata.priority).toBe('high');
    });

    it('should not detect mention for other users', () => {
      const msg = createDiscordMessage({
        content: 'Hey <@other-user>!',
        mentions: [{ id: 'other-user', username: 'other' }],
      });
      const envelope = buildDiscordEnvelope(msg, defaultConfig);

      expect(envelope!.metadata.isMention).toBe(false);
      expect(envelope!.metadata.priority).toBe('normal');
    });

    it('should detect reply to bot', () => {
      const msg = createDiscordMessage({
        referenced_message: createDiscordMessage({
          id: 'ref',
          author: { id: 'bot-999', username: 'bot', bot: true },
        }),
      });
      const envelope = buildDiscordEnvelope(msg, defaultConfig);

      expect(envelope!.metadata.isReplyToBot).toBe(true);
      expect(envelope!.metadata.priority).toBe('high');
      expect(envelope!.replyTo).toBe('ref');
    });

    it('should not detect reply to different user as reply to bot', () => {
      const msg = createDiscordMessage({
        referenced_message: createDiscordMessage({
          id: 'ref',
          author: { id: 'other-user', username: 'other', bot: false },
        }),
      });
      const envelope = buildDiscordEnvelope(msg, defaultConfig);

      expect(envelope!.metadata.isReplyToBot).toBe(false);
      expect(envelope!.metadata.priority).toBe('normal');
    });

    it('should not detect mention when botUserId is not set', () => {
      const msg = createDiscordMessage({
        content: 'Hey <@bot-999>!',
        mentions: [{ id: 'bot-999', username: 'bot' }],
      });
      const envelope = buildDiscordEnvelope(msg, { avatarId: 'test-avatar' });

      expect(envelope!.metadata.isMention).toBe(false);
    });
  });

  describe('Attachments', () => {
    it('should extract image attachments', () => {
      const msg = createDiscordMessage({
        attachments: [
          {
            id: 'att-1',
            filename: 'img.png',
            content_type: 'image/png',
            size: 5000,
            url: 'https://cdn.discord.com/img.png',
            proxy_url: 'https://proxy/img.png',
          },
        ],
      });
      const envelope = buildDiscordEnvelope(msg, defaultConfig);

      expect(envelope!.content.media).toHaveLength(1);
      expect(envelope!.content.media![0].type).toBe('photo');
      expect(envelope!.content.media![0].url).toBe('https://cdn.discord.com/img.png');
    });

    it('should extract video attachments', () => {
      const msg = createDiscordMessage({
        attachments: [
          {
            id: 'att-v',
            filename: 'vid.mp4',
            content_type: 'video/mp4',
            size: 50000,
            url: 'https://cdn.discord.com/vid.mp4',
            proxy_url: 'https://proxy/vid.mp4',
          },
        ],
      });
      const envelope = buildDiscordEnvelope(msg, defaultConfig);

      expect(envelope!.content.media![0].type).toBe('video');
    });

    it('should extract document attachments', () => {
      const msg = createDiscordMessage({
        attachments: [
          {
            id: 'att-d',
            filename: 'doc.pdf',
            content_type: 'application/pdf',
            size: 100,
            url: 'https://cdn.discord.com/doc.pdf',
            proxy_url: 'https://proxy/doc.pdf',
          },
        ],
      });
      const envelope = buildDiscordEnvelope(msg, defaultConfig);

      expect(envelope!.content.media![0].type).toBe('document');
    });
  });

  describe('Mention Extraction', () => {
    it('should extract mentions with offset and length', () => {
      const msg = createDiscordMessage({
        content: 'Hello <@111> and <@222>!',
        mentions: [
          { id: '111', username: 'alice' },
          { id: '222', username: 'bob' },
        ],
      });
      const envelope = buildDiscordEnvelope(msg, defaultConfig);

      expect(envelope!.mentions).toHaveLength(2);
      expect(envelope!.mentions[0].userId).toBe('111');
      expect(envelope!.mentions[0].username).toBe('alice');
      expect(envelope!.mentions[0].offset).toBe(6); // "Hello " = 6
      expect(envelope!.mentions[0].length).toBe('<@111>'.length);
      expect(envelope!.mentions[1].userId).toBe('222');
      expect(envelope!.mentions[1].offset).toBe(17); // "Hello <@111> and " = 17
    });
  });

  describe('Chat Type', () => {
    it('should set group for guild messages', () => {
      const msg = createDiscordMessage({ guild_id: 'g1' });
      const envelope = buildDiscordEnvelope(msg, defaultConfig);

      expect(envelope!.metadata.chatType).toBe('group');
      expect(envelope!.metadata.guildId).toBe('g1');
    });

    it('should set private for DM messages', () => {
      const msg = createDiscordMessage({ guild_id: undefined });
      const envelope = buildDiscordEnvelope(msg, defaultConfig);

      expect(envelope!.metadata.chatType).toBe('private');
      expect(envelope!.metadata.guildId).toBeUndefined();
    });
  });

  describe('Idempotency', () => {
    it('should generate consistent idempotency key', () => {
      const msg = createDiscordMessage({ id: 'msg-42' });
      const e1 = buildDiscordEnvelope(msg, defaultConfig);
      const e2 = buildDiscordEnvelope(msg, defaultConfig);

      expect(e1!.metadata.idempotencyKey).toBe(e2!.metadata.idempotencyKey);
      expect(e1!.metadata.idempotencyKey).toBe('discord:test-avatar:msg-42');
    });

    it('should generate different keys for different messages', () => {
      const msg1 = createDiscordMessage({ id: 'msg-1' });
      const msg2 = createDiscordMessage({ id: 'msg-2' });

      const e1 = buildDiscordEnvelope(msg1, defaultConfig);
      const e2 = buildDiscordEnvelope(msg2, defaultConfig);

      expect(e1!.metadata.idempotencyKey).not.toBe(e2!.metadata.idempotencyKey);
    });

    it('should generate different keys for different avatars', () => {
      const msg = createDiscordMessage({ id: 'msg-1' });
      const e1 = buildDiscordEnvelope(msg, { avatarId: 'avatar-a' });
      const e2 = buildDiscordEnvelope(msg, { avatarId: 'avatar-b' });

      expect(e1!.metadata.idempotencyKey).not.toBe(e2!.metadata.idempotencyKey);
    });
  });

  describe('Timestamp', () => {
    it('should parse ISO timestamp correctly', () => {
      const msg = createDiscordMessage({ timestamp: '2024-06-15T12:30:00.000Z' });
      const envelope = buildDiscordEnvelope(msg, defaultConfig);

      expect(envelope!.timestamp).toBe(new Date('2024-06-15T12:30:00.000Z').getTime());
    });
  });
});
