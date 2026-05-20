import { describe, expect, it } from 'bun:test';
import sharp from 'sharp';
import { removeCheckerboardBackground } from './background-removal.js';

async function alphaAt(buffer: Buffer, x: number, y: number): Promise<number> {
  const { data, info } = await sharp(buffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return data[(y * info.width + x) * info.channels + 3]!;
}

async function createStickerWithEnclosedBackgroundIsland(): Promise<Buffer> {
  return sharp({
    create: {
      width: 512,
      height: 512,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 1 },
    },
  })
    .composite([
      {
        input: Buffer.from(
          '<svg width="512" height="512">' +
            '<rect x="64" y="64" width="180" height="180" rx="18" fill="#ffffff"/>' +
            '<rect x="90" y="90" width="128" height="128" rx="10" fill="#000000"/>' +
            '<circle cx="360" cy="280" r="96" fill="#22c55e"/>' +
            '<circle cx="330" cy="245" r="20" fill="#000000"/>' +
            '<circle cx="332" cy="240" r="6" fill="#ffffff"/>' +
          '</svg>',
        ),
      },
    ])
    .png()
    .toBuffer();
}

describe('removeCheckerboardBackground', () => {
  it('removes enclosed dark background islands while preserving dark foreground details', async () => {
    const result = await removeCheckerboardBackground(await createStickerWithEnclosedBackgroundIsland());

    expect(await alphaAt(result, 0, 0)).toBe(0);
    expect(await alphaAt(result, 150, 150)).toBe(0);
    expect(await alphaAt(result, 72, 72)).toBe(255);
    expect(await alphaAt(result, 330, 245)).toBe(255);
  });
});
