import { describe, expect, it, vi } from 'vitest';
import { createTelegramTools, type TelegramServices } from './telegram.js';

describe('Telegram Tools - telegram_send_media_to_chat', () => {
  it('sends media to a known Telegram chat', async () => {
    const sendMediaToChat = vi.fn().mockResolvedValue({ messageId: 42 });
    const services = {
      sendMediaToChat,
    } as unknown as TelegramServices;
    const tools = createTelegramTools(services);
    const tool = tools.find(t => t.name === 'telegram_send_media_to_chat');

    expect(tool).toBeDefined();

    const result = await tool!.execute({
      chatId: '-1001',
      mediaUrl: 'https://cdn.example.com/generated.png',
      mediaType: 'image',
      caption: 'caption',
      replyToMessageId: 99,
    }, {
      avatarId: 'avatar-1',
      platform: 'admin-ui',
    });

    expect(sendMediaToChat).toHaveBeenCalledWith(
      'avatar-1',
      '-1001',
      'https://cdn.example.com/generated.png',
      {
        mediaType: 'image',
        caption: 'caption',
        replyToMessageId: 99,
        disableNotification: undefined,
      },
    );
    expect(result).toMatchObject({
      success: true,
      data: {
        messageId: 42,
        chatId: '-1001',
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

  it('fails clearly when media sending is not wired', async () => {
    const tools = createTelegramTools({} as unknown as TelegramServices);
    const tool = tools.find(t => t.name === 'telegram_send_media_to_chat');

    const result = await tool!.execute({
      chatId: '-1001',
      mediaUrl: 'https://cdn.example.com/generated.png',
      mediaType: 'image',
    }, {
      avatarId: 'avatar-1',
      platform: 'admin-ui',
    });

    expect(result).toEqual({
      success: false,
      error: 'Send media to chat service is not available',
    });
  });
});
