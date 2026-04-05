/**
 * Web Format Handler
 *
 * Process images for web use with flexible sizing and format options:
 * - Flexible dimensions (responsive, retina-ready)
 * - PNG/WebP/SVG output options
 * - No hard file size limit
 * - Background removal optional (can be transparent or themed)
 * - For use in: blog reactions, guestbook signatures, persona space decoration
 */

import { removeCheckerboardBackground } from '../core/background-removal.js';
import type { ProcessedSticker, WebProcessOptions } from '../types.js';

let sharpModule: any = null;

async function getSharp() {
  if (!sharpModule) {
    try {
      sharpModule = await import('sharp');
    } catch {
      throw new Error('sharp module not available - image processing is not supported in this environment');
    }
  }
  return sharpModule.default;
}

/**
 * Process an image buffer for web use with flexible sizing and format options
 *
 * @param imageBuffer - Image buffer to process
 * @param mimeType - MIME type of the image (default: 'image/png')
 * @param options - Processing options:
 *   - removeBackground: whether to remove background (default: false)
 *   - width: target width in pixels (optional, maintains aspect ratio if height not specified)
 *   - height: target height in pixels (optional, maintains aspect ratio if width not specified)
 *   - format: output format 'png' | 'webp' | 'svg' (default: 'png')
 *   - quality: JPEG/WebP quality 0-100 (default: 90)
 * @returns ProcessedSticker with buffer, width, and height
 * @throws Error if sharp is unavailable or processing fails
 */
export async function processForWeb(
  imageBuffer: Buffer,
  mimeType: string = 'image/png',
  options: WebProcessOptions = {}
): Promise<ProcessedSticker> {
  const sharp = await getSharp();
  const {
    removeBackground = false,
    width,
    height,
    format = 'png',
    quality = 90,
  } = options;

  let workingBuffer = imageBuffer;

  // Step 1: Remove background if requested
  if (removeBackground) {
    console.log('Removing background for web format...');
    workingBuffer = await removeCheckerboardBackground(imageBuffer);
  }

  // Get image metadata
  const metadata = await sharp(workingBuffer).metadata();
  const originalWidth = metadata.width || 512;
  const originalHeight = metadata.height || 512;

  console.log('Processing image for web', {
    originalSize: imageBuffer.length,
    originalWidth,
    originalHeight,
    targetWidth: width,
    targetHeight: height,
    format,
  });

  // Determine output dimensions
  let outputWidth = width || originalWidth;
  let outputHeight = height || originalHeight;

  // If only one dimension specified, maintain aspect ratio
  if (width && !height) {
    outputHeight = Math.round((originalHeight / originalWidth) * width);
  } else if (height && !width) {
    outputWidth = Math.round((originalWidth / originalHeight) * height);
  }

  // Resize image
  let image = sharp(workingBuffer)
    .resize(outputWidth, outputHeight, {
      fit: 'inside',
      withoutEnlargement: true,
    });

  // Apply format-specific transformations
  let processedBuffer: Buffer;

  switch (format) {
    case 'webp':
      image = image.webp({ quality });
      processedBuffer = await image.toBuffer();
      break;

    case 'svg':
      // For SVG, we'll use the PNG output as base64 embedded
      // True vectorization would require additional libraries
      const pngBuffer = await sharp(workingBuffer)
        .resize(outputWidth, outputHeight, {
          fit: 'inside',
          withoutEnlargement: true,
        })
        .png()
        .toBuffer();

      const base64 = pngBuffer.toString('base64');
      const svgContent = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"
     width="${outputWidth}" height="${outputHeight}" viewBox="0 0 ${outputWidth} ${outputHeight}">
  <image width="${outputWidth}" height="${outputHeight}"
         xlink:href="data:image/png;base64,${base64}"/>
</svg>`;
      processedBuffer = Buffer.from(svgContent, 'utf-8');
      break;

    case 'png':
    default:
      image = image.png({ quality });
      processedBuffer = await image.toBuffer();
      break;
  }

  console.log('Web format processing complete', {
    outputSize: processedBuffer.length,
    outputWidth,
    outputHeight,
    format,
  });

  return {
    buffer: processedBuffer,
    width: outputWidth,
    height: outputHeight,
  };
}
