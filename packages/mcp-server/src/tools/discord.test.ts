import { describe, expect, it, vi } from 'vitest';
import { createDiscordTools, type DiscordServices } from './discord.js';

function makeServices(overrides: Partial<DiscordServices> = {}): DiscordServices {
  return {
    getConnectionStatus: vi.fn().mockResolvedValue({
      connected: true,
      mode: 'bot',
      credentialsValid: true,
      runtimeHealthy: true,
    }),
    sendMessage: vi.fn().mockResolvedValue({ messageId: 'message-1' }),
    ...overrides,
  };
}

describe('Discord Tools - discord_send_media_to_channel', () => {
  it('sends generated image media even when the gateway runtime is unhealthy', async () => {
    const sendMediaToChannel = vi.fn().mockResolvedValue({ messageId: 'message-1' });
    const services = makeServices({
      getConnectionStatus: vi.fn().mockResolvedValue({
        connected: false,
        mode: 'bot',
        credentialsValid: true,
        runtimeHealthy: false,
      }),
      sendMediaToChannel,
    });
    const tool = createDiscordTools(services).find(t => t.name === 'discord_send_media_to_channel');

    const result = await tool!.execute({
      channelId: 'channel-1',
      mediaUrl: 'https://cdn.example.com/generated.png',
      mediaType: 'image',
      caption: 'caption',
      replyToMessageId: 'reply-1',
    }, {
      avatarId: 'avatar-1',
      platform: 'discord',
    });

    expect(sendMediaToChannel).toHaveBeenCalledWith('channel-1', 'https://cdn.example.com/generated.png', {
      mediaType: 'image',
      caption: 'caption',
      replyToMessageId: 'reply-1',
    });
    expect(result).toMatchObject({
      success: true,
      data: {
        messageId: 'message-1',
        channelId: 'channel-1',
        mediaUrl: 'https://cdn.example.com/generated.png',
        mediaType: 'image',
      },
      media: {
        type: 'image',
        url: 'https://cdn.example.com/generated.png',
        caption: 'caption',
      },
    });
  });

  it('falls back to discord_send embed semantics when the media service is not wired', async () => {
    const sendMessage = vi.fn().mockResolvedValue({ messageId: 'message-1' });
    const services = makeServices({ sendMessage });
    const tool = createDiscordTools(services).find(t => t.name === 'discord_send_media_to_channel');

    const result = await tool!.execute({
      channelId: 'channel-1',
      mediaUrl: 'https://cdn.example.com/generated.png',
      mediaType: 'image',
      caption: 'caption',
    }, {
      avatarId: 'avatar-1',
      platform: 'discord',
    });

    expect(sendMessage).toHaveBeenCalledWith('channel-1', 'caption', {
      embeds: [{ image: { url: 'https://cdn.example.com/generated.png' } }],
      replyTo: undefined,
    });
    expect(result.success).toBe(true);
  });

  it('falls back to URL content for videos', async () => {
    const sendMessage = vi.fn().mockResolvedValue({ messageId: 'message-2' });
    const services = makeServices({ sendMessage });
    const tool = createDiscordTools(services).find(t => t.name === 'discord_send_media_to_channel');

    const result = await tool!.execute({
      channelId: 'channel-1',
      mediaUrl: 'https://cdn.example.com/video.mp4',
      mediaType: 'video',
      caption: 'watch this',
    }, {
      avatarId: 'avatar-1',
      platform: 'discord',
    });

    expect(sendMessage).toHaveBeenCalledWith('channel-1', 'watch this\nhttps://cdn.example.com/video.mp4', {
      embeds: undefined,
      replyTo: undefined,
    });
    expect(result).toMatchObject({
      success: true,
      data: {
        messageId: 'message-2',
        mediaType: 'video',
      },
      media: {
        type: 'video',
        url: 'https://cdn.example.com/video.mp4',
      },
    });
  });

  it('fails clearly when only webhook mode is available', async () => {
    const services = makeServices({
      getConnectionStatus: vi.fn().mockResolvedValue({
        connected: true,
        mode: 'webhook',
        credentialsValid: true,
        runtimeHealthy: true,
        webhookConfigured: true,
      }),
    });
    const tool = createDiscordTools(services).find(t => t.name === 'discord_send_media_to_channel');

    const result = await tool!.execute({
      channelId: 'channel-1',
      mediaUrl: 'https://cdn.example.com/generated.png',
      mediaType: 'image',
    }, {
      avatarId: 'avatar-1',
      platform: 'discord',
    });

    expect(result).toEqual({
      success: false,
      error: 'Discord bot credentials are not available. Media delivery requires bot, hybrid, or global mode.',
    });
  });
});

describe('Discord Tools - discord_webhook_send', () => {
  it('allows webhook delivery in hybrid mode when only the gateway runtime is unhealthy', async () => {
    const sendWebhookMessage = vi.fn().mockResolvedValue({ messageId: 'webhook-1' });
    const services = makeServices({
      getConnectionStatus: vi.fn().mockResolvedValue({
        connected: false,
        mode: 'hybrid',
        credentialsValid: true,
        runtimeHealthy: false,
        webhookConfigured: true,
      }),
      sendWebhookMessage,
    });
    const tool = createDiscordTools(services).find(t => t.name === 'discord_webhook_send');

    const result = await tool!.execute({
      content: 'hello',
    }, {
      avatarId: 'avatar-1',
      platform: 'discord',
    });

    expect(sendWebhookMessage).toHaveBeenCalledWith('hello', {
      username: undefined,
      avatarUrl: undefined,
      embeds: undefined,
    });
    expect(result).toMatchObject({
      success: true,
      data: {
        messageId: 'webhook-1',
      },
    });
  });
});
