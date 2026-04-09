/**
 * Web Sticker Format Tests
 *
 * Tests for:
 * - PNG output with transparency
 * - WebP output with quality options
 * - SVG output (scalable)
 * - Retina variant generation (@1x, @2x, @3x)
 * - Background color fill options
 * - Metadata generation for <picture> / srcset rendering
 */

import { describe, it, expect, beforeAll } from 'bun:test';
import sharp from 'sharp';
import { processForWeb, generateSrcset, buildPictureElement } from './web.js';

// Create a minimal test image (256x256 solid red PNG)
// Underscore prefix marks this as intentionally unused — kept as a reference
// fixture for tests that may need a literal PNG buffer instead of a sharp-generated one.
function _createTestImage(): Buffer {
  return Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG signature
    0x00, 0x00, 0x00, 0x0d, // IHDR chunk length
    0x49, 0x48, 0x44, 0x52, // IHDR
    0x00, 0x00, 0x01, 0x00, // width: 256
    0x00, 0x00, 0x01, 0x00, // height: 256
    0x08, 0x02, 0x00, 0x00, 0x00, // bit depth: 8, color type: 2 (RGB)
    0x62, 0xea, 0x7d, 0x4f, // CRC
  ]);
}

// Create a simple red image using sharp
async function createSimpleRedImage(): Promise<Buffer> {
  return sharp({
    create: {
      width: 256,
      height: 256,
      channels: 3,
      background: { r: 255, g: 0, b: 0 },
    },
  })
    .png()
    .toBuffer();
}

describe('Web Sticker Format Processor', () => {
  let testImageBuffer: Buffer;

  beforeAll(async () => {
    testImageBuffer = await createSimpleRedImage();
  });

  describe('processForWeb()', () => {
    it('should generate PNG variant', async () => {
      const result = await processForWeb(testImageBuffer, {
        formats: ['png'],
        retinaScales: [1],
        removeBackground: false,
      });

      expect(result.variants).toHaveLength(1);
      expect(result.variants[0].format).toBe('png');
      expect(result.variants[0].scale).toBe(1);
      expect(result.variants[0].mimeType).toBe('image/png');
      expect(result.variants[0].buffer).toBeInstanceOf(Buffer);
      expect(result.variants[0].size).toBeGreaterThan(0);
    });

    it('should generate WebP variant', async () => {
      const result = await processForWeb(testImageBuffer, {
        formats: ['webp'],
        retinaScales: [1],
        removeBackground: false,
      });

      expect(result.variants).toHaveLength(1);
      expect(result.variants[0].format).toBe('webp');
      expect(result.variants[0].mimeType).toBe('image/webp');
      expect(result.variants[0].buffer).toBeInstanceOf(Buffer);
    });

    it('should generate SVG variant', async () => {
      const result = await processForWeb(testImageBuffer, {
        formats: ['svg'],
        retinaScales: [1],
        removeBackground: false,
      });

      expect(result.variants).toHaveLength(1);
      expect(result.variants[0].format).toBe('svg');
      expect(result.variants[0].mimeType).toBe('image/svg+xml');
      expect(result.variants[0].buffer).toBeInstanceOf(Buffer);

      // SVG should contain an embedded image
      const svgContent = result.variants[0].buffer.toString('utf-8');
      expect(svgContent).toContain('<svg');
      expect(svgContent).toContain('viewBox');
    });

    it('should generate multiple PNG and WebP variants', async () => {
      const result = await processForWeb(testImageBuffer, {
        formats: ['png', 'webp'],
        retinaScales: [1, 2],
        removeBackground: false,
      });

      expect(result.variants).toHaveLength(4); // 2 formats × 2 scales

      const pngVariants = result.variants.filter(v => v.format === 'png');
      const webpVariants = result.variants.filter(v => v.format === 'webp');

      expect(pngVariants).toHaveLength(2);
      expect(webpVariants).toHaveLength(2);

      // Check scales
      const pngScales = pngVariants.map(v => v.scale).sort();
      expect(pngScales).toEqual([1, 2]);

      const webpScales = webpVariants.map(v => v.scale).sort();
      expect(webpScales).toEqual([1, 2]);
    });

    it('should respect maxWidth and maxHeight', async () => {
      const result = await processForWeb(testImageBuffer, {
        maxWidth: 128,
        maxHeight: 128,
        formats: ['png'],
        retinaScales: [1],
        removeBackground: false,
      });

      expect(result.variants[0].width).toBeLessThanOrEqual(128);
      expect(result.variants[0].height).toBeLessThanOrEqual(128);
    });

    it('should scale retina variants correctly', async () => {
      const result = await processForWeb(testImageBuffer, {
        maxWidth: 128,
        maxHeight: 128,
        formats: ['png'],
        retinaScales: [1, 2, 3],
        removeBackground: false,
      });

      expect(result.variants).toHaveLength(3);

      const variant1x = result.variants.find(v => v.scale === 1);
      const variant2x = result.variants.find(v => v.scale === 2);
      const variant3x = result.variants.find(v => v.scale === 3);

      expect(variant1x).toBeDefined();
      expect(variant2x).toBeDefined();
      expect(variant3x).toBeDefined();

      // 2x should be roughly 2x the size of 1x
      expect(variant2x!.width).toBe(variant1x!.width * 2);
      expect(variant2x!.height).toBe(variant1x!.height * 2);

      // 3x should be roughly 3x the size of 1x
      expect(variant3x!.width).toBe(variant1x!.width * 3);
      expect(variant3x!.height).toBe(variant1x!.height * 3);
    });

    it('should apply background color when specified', async () => {
      const result = await processForWeb(testImageBuffer, {
        maxWidth: 128,
        maxHeight: 128,
        formats: ['png'],
        retinaScales: [1],
        removeBackground: false,
        backgroundColor: '#00FF00', // Green
      });

      expect(result.variants[0].format).toBe('png');
      expect(result.variants[0].buffer).toBeInstanceOf(Buffer);
    });

    it('should handle default options', async () => {
      const result = await processForWeb(testImageBuffer);

      // Default formats: ['webp', 'png']
      // Default retinaScales: [1, 2]
      expect(result.variants).toHaveLength(4);

      const formats = [...new Set(result.variants.map(v => v.format))];
      expect(formats).toContain('webp');
      expect(formats).toContain('png');
    });

    it('should return variants with correct metadata', async () => {
      const result = await processForWeb(testImageBuffer, {
        formats: ['png'],
        retinaScales: [1],
        removeBackground: false,
      });

      const variant = result.variants[0];

      expect(variant.format).toBe('png');
      expect(variant.scale).toBe(1);
      expect(variant.buffer).toBeInstanceOf(Buffer);
      expect(variant.width).toBeGreaterThan(0);
      expect(variant.height).toBeGreaterThan(0);
      expect(variant.size).toBe(variant.buffer.length);
      expect(variant.mimeType).toBe('image/png');
    });
  });

  describe('generateSrcset()', () => {
    const variants = [
      {
        format: 'png',
        scale: 1,
        buffer: Buffer.from('png1x'),
        width: 128,
        height: 128,
        size: 5,
        mimeType: 'image/png',
      },
      {
        format: 'png',
        scale: 2,
        buffer: Buffer.from('png2x'),
        width: 256,
        height: 256,
        size: 5,
        mimeType: 'image/png',
      },
    ];

    it('should generate srcset for PNG', () => {
      const srcset = generateSrcset(variants, 'png');

      expect(srcset).toContain('1x');
      expect(srcset).toContain('2x');
      expect(srcset).toContain('data:image/png;base64,');
    });

    it('should return empty string for non-existent format', () => {
      const srcset = generateSrcset(variants, 'webp');

      expect(srcset).toBe('');
    });
  });

  describe('buildPictureElement()', () => {
    const variants = [
      {
        format: 'webp',
        scale: 1,
        buffer: Buffer.from('webp1x'),
        width: 128,
        height: 128,
        size: 6,
        mimeType: 'image/webp',
      },
      {
        format: 'png',
        scale: 1,
        buffer: Buffer.from('png1x'),
        width: 128,
        height: 128,
        size: 5,
        mimeType: 'image/png',
      },
    ];

    it('should generate valid picture element HTML', () => {
      const html = buildPictureElement(variants, 'Test Sticker');

      expect(html).toContain('<picture>');
      expect(html).toContain('</picture>');
      expect(html).toContain('<source');
      expect(html).toContain('<img');
      expect(html).toContain('alt="Test Sticker"');
    });

    it('should include WebP source when available', () => {
      const html = buildPictureElement(variants, 'Test');

      expect(html).toContain('type="image/webp"');
    });

    it('should include PNG source when available', () => {
      const html = buildPictureElement(variants, 'Test');

      expect(html).toContain('type="image/png"');
    });

    it('should use first variant as fallback', () => {
      const html = buildPictureElement(variants, 'Test');

      expect(html).toContain(`width="${variants[0].width}"`);
      expect(html).toContain(`height="${variants[0].height}"`);
    });
  });
});
