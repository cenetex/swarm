/**
 * S3 Storage for Stickers
 *
 * Handles uploading stickers to S3 and managing sticker set manifests
 */

import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { randomUUID } from 'crypto';
import type { S3UploadResult, StickerSetManifest, StickerMetadata } from './types.js';

const s3Client = new S3Client({});

/**
 * Build a media URL from S3 key and bucket
 * Uses CDN if CDN_URL environment variable is set
 *
 * @param s3Key - S3 object key
 * @param bucketName - S3 bucket name
 * @param cdnUrl - Optional CDN base URL
 * @returns Full URL to the media
 */
function buildMediaUrl(s3Key: string, bucketName: string, cdnUrl?: string): string {
  if (cdnUrl) {
    return `${cdnUrl}/${s3Key}`;
  }
  // Fallback to S3 URL
  return `https://${bucketName}.s3.amazonaws.com/${s3Key}`;
}

/**
 * Upload a processed sticker to S3 for storage
 *
 * @param buffer - Processed sticker image buffer
 * @param bucketName - S3 bucket to upload to
 * @param avatarId - Avatar ID for organizing stickers
 * @param metadata - Sticker metadata (emoji, prompt, setName)
 * @returns Object with s3Key, id, and url
 * @throws Error if upload fails
 */
export async function uploadStickerToS3(
  buffer: Buffer,
  bucketName: string,
  avatarId: string,
  metadata: {
    emoji: string;
    prompt?: string;
    setName?: string;
  }
): Promise<S3UploadResult> {
  const datePrefix = new Date().toISOString().split('T')[0];
  const id = randomUUID();
  const s3Key = `stickers/${avatarId}/${datePrefix}/${id}.png`;

  await s3Client.send(new PutObjectCommand({
    Bucket: bucketName,
    Key: s3Key,
    Body: buffer,
    ContentType: 'image/png',
    Metadata: {
      // S3 metadata headers only allow ASCII - encode emoji
      emoji: encodeURIComponent(metadata.emoji),
      prompt: metadata.prompt ? encodeURIComponent(metadata.prompt.slice(0, 500)) : '',
      setName: metadata.setName || '',
    },
  }));

  console.log('Uploaded sticker to S3', { s3Key, id });

  const url = buildMediaUrl(s3Key, bucketName, process.env.CDN_URL);

  return { s3Key, id, url };
}

/**
 * Get a sticker set manifest from S3, or return null if not found
 *
 * @param bucketName - S3 bucket name
 * @param avatarId - Avatar ID
 * @param setName - Sticker set name
 * @returns StickerSetManifest or null if not found
 * @throws Error on S3 errors other than 404
 */
export async function getStickerSetManifest(
  bucketName: string,
  avatarId: string,
  setName: string
): Promise<StickerSetManifest | null> {
  const manifestKey = `stickers/${avatarId}/manifests/${setName}.json`;

  try {
    const response = await s3Client.send(new GetObjectCommand({
      Bucket: bucketName,
      Key: manifestKey,
    }));

    const bodyStr = await response.Body?.transformToString();
    if (bodyStr) {
      return JSON.parse(bodyStr) as StickerSetManifest;
    }
  } catch (error: unknown) {
    const err = error as { name?: string; $metadata?: { httpStatusCode?: number } };
    if (err?.name === 'NoSuchKey' || err?.$metadata?.httpStatusCode === 404) {
      return null;
    }
    throw error;
  }

  return null;
}

/**
 * Save or update a sticker set manifest to S3
 *
 * @param bucketName - S3 bucket name
 * @param avatarId - Avatar ID
 * @param manifest - Manifest to save
 * @throws Error if save fails
 */
export async function saveStickerSetManifest(
  bucketName: string,
  avatarId: string,
  manifest: StickerSetManifest
): Promise<void> {
  const manifestKey = `stickers/${avatarId}/manifests/${manifest.name}.json`;

  manifest.lastUpdated = new Date().toISOString();

  await s3Client.send(new PutObjectCommand({
    Bucket: bucketName,
    Key: manifestKey,
    Body: JSON.stringify(manifest, null, 2),
    ContentType: 'application/json',
  }));

  console.log('Saved sticker set manifest', { setName: manifest.name, stickerCount: manifest.stickers.length });
}
