/**
 * Web Sticker Format Processor
 *
 * Handles flexible sticker format generation for web/publishing platform use:
 * - Flexible dimensions (responsive, retina-ready)
 * - Multiple output formats: PNG, WebP, SVG
 * - No hard file size limit
 * - Background removal optional (can be transparent or themed)
 * - Returns srcset-ready variants at multiple sizes
 *
 * Use cases:
 * - Blog post reactions (inline at ~48-64px)
 * - Guestbook signatures (agents sign each other's spaces)
 * - Persona decoration (stickers as room furniture in agent blog spaces)
 * - Sticker gallery (browsable collection on each persona's sub-site)
 * - Cross-agent sharing (sticker packs as tradeable persona artifacts)
 */

import { removeCheckerboardBackground } from '../core/background-removal.js';
import { type WebStickerResult, type StickerVariant } from '../types.js';

export interface WebStickerOptions {
  maxWidth?: number;          // default: 1024
  maxHeight?: number;         // default: 1024
  formats?: ('png' | 'webp' | 'svg')[];  // default: ['webp', 'png']
  retinaScales?: number[];    // default: [1, 2]
  removeBackground?: boolean; // default: true
  backgroundColor?: string;   // optional theme color instead of transparent
  pngQuality?: number;        // default: 90 (for png, used if format doesn't support native quality)
  webpQuality?: number;       // default: 80
}

async function getSharp() {
  try {
    return (await import('sharp')).default;
  } catch {
    throw new Error('sharp module not available - image processing is not supported in this environment');
  }
}

/**
 * Convert image buffer to SVG (for text-art stickers and scalable formats)
 * Uses base64 embedding for compatibility
 */
async function bufferToSvg(
  buffer: Buffer,
  width: number,
  height: number,
  _format: string = 'png'
): Promise<Buffer> {
  const base64 = buffer.toString('base64');
  const mimeType = _format === 'webp' ? 'image/webp' : 'image/png';

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"
    width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <image x="0" y="0" width="${width}" height="${height}" xlink:href="data:${mimeType};base64,${base64}"/>
  </svg>`;

  return Buffer.from(svg, 'utf-8');
}

/**
 * Process image for web format with multiple variants
 *
 * @param buffer - Input image buffer
 * @param options - Configuration options
 * @returns WebStickerResult with variants at multiple sizes and formats
 */
export async function processForWeb(
  buffer: Buffer,
  options: WebStickerOptions = {}
): Promise<WebStickerResult> {
  const {
    maxWidth = 1024,
    maxHeight = 1024,
    formats = ['webp', 'png'],
    retinaScales = [1, 2],
    removeBackground = true,
    backgroundColor,
    webpQuality = 80,
  } = options;

  const sharpInstance = await getSharp();

  // Step 1: Remove background if requested
  let workingBuffer = buffer;
  if (removeBackground) {
    console.log('Processing for web: removing background...');
    try {
      workingBuffer = await removeCheckerboardBackground(buffer);
    } catch (error) {
      console.warn(
        'Background removal failed, continuing with original image:',
        error instanceof Error ? error.message : String(error),
      );
      // Continue with original buffer if background removal fails
    }
  }

  // Step 2: Get original dimensions
  const metadata = await sharpInstance(workingBuffer).metadata();
  const originalWidth = metadata.width || 512;
  const originalHeight = metadata.height || 512;

  console.log('Processing image for web format', {
    originalSize: buffer.length,
    afterBgRemoval: workingBuffer.length,
    originalWidth,
    originalHeight,
    format: metadata.format,
    requestedFormats: formats,
    retinaScales,
  });

  // Step 3: Calculate dimensions - respect maxWidth/maxHeight
  let targetWidth = originalWidth;
  let targetHeight = originalHeight;

  if (originalWidth > maxWidth || originalHeight > maxHeight) {
    const aspectRatio = originalWidth / originalHeight;
    if (originalWidth > maxWidth) {
      targetWidth = maxWidth;
      targetHeight = Math.round(maxWidth / aspectRatio);
    }
    if (targetHeight > maxHeight) {
      targetHeight = maxHeight;
      targetWidth = Math.round(maxHeight * aspectRatio);
    }
  }

  console.log('Target dimensions:', { targetWidth, targetHeight });

  // Step 4: Build background Fill object if backgroundColor provided
  const fillBackground = backgroundColor
    ? { r: parseInt(backgroundColor.slice(1, 3), 16), g: parseInt(backgroundColor.slice(3, 5), 16), b: parseInt(backgroundColor.slice(5, 7), 16) }
    : undefined;

  // Step 5: Generate variants for each format and retina scale
  const variants: StickerVariant[] = [];

  for (const format of formats) {
    for (const scale of retinaScales) {
      const scaledWidth = Math.round(targetWidth * scale);
      const scaledHeight = Math.round(targetHeight * scale);

      console.log(`Generating ${format} variant at ${scale}x (${scaledWidth}x${scaledHeight})...`);

      let variantBuffer: Buffer;
      let mimeType: string;

      const resized = sharpInstance(workingBuffer)
        .resize(scaledWidth, scaledHeight, {
          fit: 'inside',
          withoutEnlargement: false,
        });

      if (format === 'png') {
        mimeType = 'image/png';
        // Apply background color if specified
        if (fillBackground) {
          variantBuffer = await resized
            .flatten({ background: fillBackground })
            .png({ compressionLevel: 9 })
            .toBuffer();
        } else {
          // Keep transparency
          variantBuffer = await resized
            .ensureAlpha()
            .png({ compressionLevel: 9 })
            .toBuffer();
        }
      } else if (format === 'webp') {
        mimeType = 'image/webp';
        if (fillBackground) {
          variantBuffer = await resized
            .flatten({ background: fillBackground })
            .webp({ quality: webpQuality })
            .toBuffer();
        } else {
          variantBuffer = await resized
            .ensureAlpha()
            .webp({ quality: webpQuality, alphaQuality: webpQuality })
            .toBuffer();
        }
      } else if (format === 'svg') {
        mimeType = 'image/svg+xml';
        // For SVG, base64-encode the PNG or WebP version for embedding
        const baseFormat = 'png'; // Use PNG as the base for SVG embedding
        const baseResized = sharpInstance(workingBuffer)
          .resize(scaledWidth, scaledHeight, {
            fit: 'inside',
            withoutEnlargement: false,
          });

        const baseBuffer = fillBackground
          ? await baseResized
            .flatten({ background: fillBackground })
            .png({ compressionLevel: 9 })
            .toBuffer()
          : await baseResized
              .ensureAlpha()
              .png({ compressionLevel: 9 })
              .toBuffer();

        variantBuffer = await bufferToSvg(baseBuffer, scaledWidth, scaledHeight, baseFormat);
      } else {
        throw new Error(`Unsupported format: ${format}`);
      }

      variants.push({
        format,
        scale,
        buffer: variantBuffer,
        width: scaledWidth,
        height: scaledHeight,
        size: variantBuffer.length,
        mimeType,
      });

      console.log(`Generated ${format} variant: ${variantBuffer.length} bytes`);
    }
  }

  return { variants };
}

/**
 * Generate srcset string for HTML <picture> element from variants
 *
 * @param variants - Array of StickerVariant objects
 * @param format - Output format (png, webp, svg)
 * @returns srcset string ready for <source srcset="...">
 */
export function generateSrcset(
  variants: StickerVariant[],
  format: string
): string {
  const filtered = variants
    .filter(v => v.format === format)
    .sort((a, b) => a.scale - b.scale);

  if (filtered.length === 0) {
    return '';
  }

  return filtered
    .map(v => `data:${v.mimeType};base64,${v.buffer.toString('base64')} ${v.scale}x`)
    .join(', ');
}

/**
 * Build HTML <picture> element markup from variants
 *
 * @param variants - Array of StickerVariant objects
 * @param alt - Alt text for the image
 * @returns HTML picture element as string
 */
export function buildPictureElement(
  variants: StickerVariant[],
  alt: string = 'Sticker'
): string {
  const formats = [...new Set(variants.map(v => v.format))];
  const baseVariant = variants[0];

  let html = '<picture>\n';

  // Add WebP source if available
  if (formats.includes('webp')) {
    const webpSrcset = generateSrcset(variants, 'webp');
    if (webpSrcset) {
      html += `  <source type="image/webp" srcset="${webpSrcset}">\n`;
    }
  }

  // Add PNG source if available
  if (formats.includes('png')) {
    const pngSrcset = generateSrcset(variants, 'png');
    if (pngSrcset) {
      html += `  <source type="image/png" srcset="${pngSrcset}">\n`;
    }
  }

  // Fallback img element
  html += `  <img src="data:${baseVariant.mimeType};base64,${baseVariant.buffer.toString('base64')}" `;
  html += `alt="${alt}" width="${baseVariant.width}" height="${baseVariant.height}" />\n`;
  html += '</picture>';

  return html;
}
