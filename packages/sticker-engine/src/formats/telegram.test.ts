import { describe, expect, it } from 'bun:test';
import sharp from 'sharp';
import {
  generateStickerSetName,
  processForTelegramSticker,
  selectStickerEmoji,
} from './telegram.js';

async function createWidePng(): Promise<Buffer> {
  return sharp({
    create: {
      width: 1024,
      height: 512,
      channels: 4,
      background: { r: 255, g: 0, b: 0, alpha: 1 },
    },
  })
    .png()
    .toBuffer();
}

describe('Telegram Sticker Format Processor', () => {
  it('resizes PNGs to Telegram static sticker constraints', async () => {
    const result = await processForTelegramSticker(await createWidePng(), {
      removeBackground: false,
    });

    expect(result.width).toBe(512);
    expect(result.height).toBe(256);
    expect(result.size).toBeLessThanOrEqual(512 * 1024);
    expect(result.contentType).toBe('image/png');
  });

  it('generates Bot API compatible set names', () => {
    expect(generateStickerSetName('REKT Horse Pack', '@SolanaFireHorseBot'))
      .toBe('rekt_horse_pack_by_solanafirehorsebot');
  });

  it('keeps long set names within Telegram Bot API limits', () => {
    const setName = generateStickerSetName(
      'A Very Long Avatar Name With A Lot Of Extra Words And Symbols!!!',
      '@SolanaFireHorseBot',
    );

    expect(setName).toEndWith('_by_solanafirehorsebot');
    expect(setName.length).toBeLessThanOrEqual(64);
  });

  it('selects REKT-themed emoji from prompts', () => {
    expect(selectStickerEmoji('fire horse candle')).toBe('🔥');
    expect(selectStickerEmoji('rekt loss')).toBe('💀');
  });
});
