import { Jimp } from 'jimp';
import { PlatformError } from '../errors/errors.js';
import { SwarmErrorCode } from '../errors/codes.js';

export const TWITTER_MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const TWITTER_TARGET_IMAGE_BYTES = TWITTER_MAX_IMAGE_BYTES - 32 * 1024;

type TwitterImageMimeType = 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';

function normalizeMimeType(mimeType: string): string {
  if (mimeType === 'image/jpg') {
    return 'image/jpeg';
  }
  return mimeType;
}

function isTwitterImageMimeType(mimeType: string): mimeType is TwitterImageMimeType {
  const normalized = normalizeMimeType(mimeType);
  return normalized === 'image/jpeg' || normalized === 'image/png' || normalized === 'image/webp' || normalized === 'image/gif';
}

export async function ensureTwitterImageWithinLimit(
  input: Buffer,
  mimeType: string
): Promise<{ buffer: Buffer; mimeType: TwitterImageMimeType }> {
  const normalizedMimeType = normalizeMimeType(mimeType);

  if (!isTwitterImageMimeType(normalizedMimeType)) {
    throw new PlatformError(`Unsupported Twitter image mimeType: ${mimeType}`, {
      code: SwarmErrorCode.PLATFORM_UNSUPPORTED_MEDIA,
      platform: 'twitter',
      context: { mimeType },
    });
  }

  if (input.length <= TWITTER_MAX_IMAGE_BYTES) {
    return { buffer: input, mimeType: normalizedMimeType as TwitterImageMimeType };
  }

  if (normalizedMimeType === 'image/gif') {
    throw new PlatformError(
      `GIF too large for Twitter upload: ${input.length} bytes (max ${TWITTER_MAX_IMAGE_BYTES})`,
      {
        code: SwarmErrorCode.PLATFORM_MEDIA_UPLOAD_ERROR,
        platform: 'twitter',
        context: { sizeBytes: input.length, maxBytes: TWITTER_MAX_IMAGE_BYTES },
      },
    );
  }

  const image = await Jimp.read(input);

  let quality = 80;
  let maxWidth = 1600;

  for (let attempt = 0; attempt < 6; attempt++) {
    const resized = image.clone();

    if (resized.width > maxWidth) {
      resized.resize({ w: maxWidth });
    }

    const out = await resized.getBuffer('image/jpeg', { quality });

    if (out.length <= TWITTER_TARGET_IMAGE_BYTES) {
      return { buffer: out, mimeType: 'image/jpeg' };
    }

    if (quality > 50) {
      quality -= 10;
    } else {
      maxWidth = Math.max(640, Math.floor(maxWidth * 0.8));
      quality = 75;
    }
  }

  throw new PlatformError(
    `Image too large for Twitter upload after re-encode: ${input.length} bytes (max ${TWITTER_MAX_IMAGE_BYTES})`,
    {
      code: SwarmErrorCode.PLATFORM_MEDIA_UPLOAD_ERROR,
      platform: 'twitter',
      context: { sizeBytes: input.length, maxBytes: TWITTER_MAX_IMAGE_BYTES },
    },
  );
}
