/**
 * Media Conversion Handler
 * Converts audio/video using ffmpeg and stores result in S3.
 */
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { randomUUID } from 'crypto';
import { createWriteStream, promises as fs } from 'fs';
import { pipeline } from 'stream/promises';
import { spawn } from 'child_process';
import path from 'path';
import ffmpegPath from 'ffmpeg-static';
import { buildMediaUrl } from '../utils/media-url.js';

const s3Client = new S3Client({});

const MEDIA_BUCKET = process.env.MEDIA_BUCKET!;
const CDN_URL = process.env.CDN_URL || '';

interface ConvertRequest {
  avatarId: string;
  sourceUrl: string;
  mediaType: 'audio' | 'video';
  targetFormat: 'ogg' | 'mp3' | 'wav' | 'mp4';
}

interface ConvertResponse {
  success: boolean;
  url?: string;
  format?: string;
  error?: string;
}

function parseS3Url(url: string): { bucket: string; key: string } | null {
  const match = url.match(/https:\/\/([^.]+)\.s3[^/]*\.amazonaws\.com\/(.+)/);
  if (!match) return null;
  const keyWithQuery = decodeURIComponent(match[2]);
  const key = keyWithQuery.split('?')[0] || keyWithQuery;
  return { bucket: match[1], key };
}

function getOutputKey(avatarId: string, ext: string) {
  return `avatars/${avatarId}/converted/${randomUUID()}.${ext}`;
}

function getContentType(format: ConvertRequest['targetFormat']) {
  switch (format) {
    case 'mp3':
      return 'audio/mpeg';
    case 'wav':
      return 'audio/wav';
    case 'ogg':
      return 'audio/ogg';
    case 'mp4':
      return 'video/mp4';
    default:
      return 'application/octet-stream';
  }
}

async function downloadToFile(sourceUrl: string, outputPath: string): Promise<void> {
  const s3Url = parseS3Url(sourceUrl);
  if (s3Url) {
    const response = await s3Client.send(new GetObjectCommand({
      Bucket: s3Url.bucket,
      Key: s3Url.key,
    }));
    if (!response.Body) {
      throw new Error('S3 object body missing');
    }
    await pipeline(response.Body as NodeJS.ReadableStream, createWriteStream(outputPath));
    return;
  }

  const response = await fetch(sourceUrl);
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to download source: ${response.status} - ${errorText}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  await fs.writeFile(outputPath, buffer);
}

async function runFfmpeg(args: string[]): Promise<void> {
  const ffmpegBinary = typeof ffmpegPath === 'string' ? ffmpegPath : undefined;
  if (!ffmpegBinary) {
    throw new Error('ffmpeg binary not available');
  }

  await new Promise<void>((resolve, reject) => {
    const proc = spawn(ffmpegBinary, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';

    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on('error', (error: Error) => reject(error));
    proc.on('close', (code: number | null) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`ffmpeg exited with ${code}: ${stderr}`));
      }
    });
  });
}

function buildFfmpegArgs(inputPath: string, outputPath: string, request: ConvertRequest): string[] {
  const args: string[] = ['-y', '-i', inputPath];

  if (request.mediaType === 'audio') {
    if (request.targetFormat === 'ogg') {
      args.push('-c:a', 'libopus', '-b:a', '64k');
    } else if (request.targetFormat === 'mp3') {
      args.push('-c:a', 'libmp3lame', '-b:a', '128k');
    } else if (request.targetFormat === 'wav') {
      args.push('-c:a', 'pcm_s16le');
    }
  } else {
    args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', '-c:a', 'aac', '-b:a', '128k');
  }

  args.push(outputPath);
  return args;
}

async function uploadOutput(filePath: string, key: string, contentType: string): Promise<string> {
  const body = await fs.readFile(filePath);
  await s3Client.send(new PutObjectCommand({
    Bucket: MEDIA_BUCKET,
    Key: key,
    Body: body,
    ContentType: contentType,
  }));

  return buildMediaUrl(key, MEDIA_BUCKET, CDN_URL || undefined);
}

export const handler = async (event: { body?: string } | ConvertRequest): Promise<ConvertResponse> => {
  try {
    const payload: ConvertRequest = 'body' in event
      ? JSON.parse(event.body || '{}')
      : event;

    if (!payload.avatarId || !payload.sourceUrl || !payload.mediaType || !payload.targetFormat) {
      return { success: false, error: 'Missing required fields' };
    }

    const inputPath = path.join('/tmp', `input-${randomUUID()}`);
    const outputPath = path.join('/tmp', `output-${randomUUID()}.${payload.targetFormat}`);

    await downloadToFile(payload.sourceUrl, inputPath);
    const args = buildFfmpegArgs(inputPath, outputPath, payload);
    await runFfmpeg(args);

    const key = getOutputKey(payload.avatarId, payload.targetFormat);
    const url = await uploadOutput(outputPath, key, getContentType(payload.targetFormat));

    return { success: true, url, format: payload.targetFormat };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: message };
  }
};
