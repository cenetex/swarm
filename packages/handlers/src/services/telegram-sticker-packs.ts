import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { buildMediaUrl, logger, type AvatarConfig, type MediaService } from '@swarm/core';
import type {
  GalleryItemForSticker,
  StickerInfo,
  StickerPackInfo,
  StickerServices,
} from '@swarm/mcp-server';
import {
  generateStickerSetName,
  processImageSourceForTelegramSticker,
  selectStickerEmoji,
} from '@swarm/sticker-engine';
import { getDynamoClient } from './dynamo-client.js';
import { getAdminTable } from './env-validation.js';

const TELEGRAM_API = 'https://api.telegram.org/bot';
const REFERENCE_URL_CHECK_TIMEOUT_MS = 1500;
const s3Client = new S3Client({});

interface TelegramResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
}

interface TelegramStickerSet {
  name: string;
  title: string;
  stickers: Array<{ file_id: string; emoji?: string }>;
}

interface GalleryRecord {
  pk: string;
  sk: string;
  id: string;
  avatarId: string;
  type: 'image' | 'video' | 'sticker';
  url: string;
  s3Key: string;
  prompt?: string;
  model?: string;
  platform?: string;
  postedToTwitter?: boolean;
  convertedToSticker?: boolean;
  createdAt: number;
  metadata?: Record<string, unknown>;
  stickerInfo?: {
    emoji: string;
    setName: string;
    fileId?: string;
    stickerUrl?: string;
    convertedAt: number;
  };
}

interface StickerSetManifest {
  name: string;
  title: string;
  createdAt: string;
  lastUpdated: string;
  stickers: Array<{
    id: string;
    emoji: string;
    prompt?: string;
    createdAt: string;
    setName?: string;
    fileId?: string;
    url?: string;
  }>;
}

export interface RuntimeStickerServicesConfig {
  avatarId: string;
  avatarConfig: AvatarConfig;
  mediaService?: MediaService;
  mediaBucket?: string;
  cdnUrl?: string;
  secrets: Record<string, string>;
  consumeStickerCredit?: () => Promise<void>;
  resolveStickerOwnerUserId?: (avatarId: string) => Promise<string | undefined>;
}

function getBotToken(secrets: Record<string, string>): string | undefined {
  return secrets.TELEGRAM_BOT_TOKEN || secrets.telegram_bot_token;
}

type ReferenceImageKind = 'character' | 'profile';
type ReferenceFetch = (url: string, init?: RequestInit) => Promise<Response>;

interface StickerReferenceCandidate {
  kind: ReferenceImageKind;
  url: string;
}

interface StickerReferenceUrlOptions {
  fetchImpl?: ReferenceFetch;
  timeoutMs?: number;
  onRejected?: (candidate: StickerReferenceCandidate, reason: string) => void;
}

function stickerReferenceCandidates(avatarConfig: Pick<AvatarConfig, 'characterReference' | 'profileImage'>): StickerReferenceCandidate[] {
  return [
    avatarConfig.characterReference?.url ? { kind: 'character' as const, url: avatarConfig.characterReference.url } : undefined,
    avatarConfig.profileImage?.url ? { kind: 'profile' as const, url: avatarConfig.profileImage.url } : undefined,
  ].filter((candidate): candidate is StickerReferenceCandidate => Boolean(candidate));
}

async function canUseStickerReferenceUrl(
  candidate: StickerReferenceCandidate,
  options: Required<Pick<StickerReferenceUrlOptions, 'fetchImpl' | 'timeoutMs'>>,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  let parsed: URL;
  try {
    parsed = new URL(candidate.url);
  } catch {
    return { ok: false, reason: 'invalid_url' };
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { ok: false, reason: 'unsupported_scheme' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const response = await options.fetchImpl(candidate.url, {
      method: 'HEAD',
      signal: controller.signal,
    });
    if (response.ok) return { ok: true };
    return { ok: false, reason: `http_${response.status}` };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return { ok: false, reason: 'timeout' };
    }
    return { ok: false, reason: 'fetch_failed' };
  } finally {
    clearTimeout(timer);
  }
}

export async function resolveStickerReferenceImageUrls(
  avatarConfig: Pick<AvatarConfig, 'characterReference' | 'profileImage'>,
  options: StickerReferenceUrlOptions = {},
): Promise<string[]> {
  const fetchImpl = options.fetchImpl || fetch;
  const timeoutMs = options.timeoutMs ?? REFERENCE_URL_CHECK_TIMEOUT_MS;
  const seen = new Set<string>();
  const candidates = stickerReferenceCandidates(avatarConfig).filter(candidate => {
    if (seen.has(candidate.url)) return false;
    seen.add(candidate.url);
    return true;
  });

  const checked = await Promise.all(candidates.map(async candidate => ({
    candidate,
    result: await canUseStickerReferenceUrl(candidate, { fetchImpl, timeoutMs }),
  })));

  return checked
    .filter(({ candidate, result }) => {
      if (result.ok) return true;
      options.onRejected?.(candidate, result.reason);
      return false;
    })
    .map(({ candidate }) => candidate.url);
}

async function telegramJson<T>(
  botToken: string,
  method: string,
  body: Record<string, unknown>,
): Promise<TelegramResponse<T>> {
  const response = await fetch(`${TELEGRAM_API}${botToken}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return response.json() as Promise<TelegramResponse<T>>;
}

async function getBotInfo(botToken: string): Promise<{ id: number; username: string } | null> {
  const response = await fetch(`${TELEGRAM_API}${botToken}/getMe`);
  const data = await response.json() as TelegramResponse<{ id: number; username: string }>;
  return data.ok ? data.result || null : null;
}

async function uploadStickerFile(
  botToken: string,
  ownerUserId: number,
  stickerBuffer: Buffer,
): Promise<{ file_id: string }> {
  const formData = new FormData();
  formData.append('user_id', String(ownerUserId));
  formData.append('sticker', new Blob([stickerBuffer], { type: 'image/png' }), 'sticker.png');
  formData.append('sticker_format', 'static');

  const response = await fetch(`${TELEGRAM_API}${botToken}/uploadStickerFile`, {
    method: 'POST',
    body: formData,
  });
  const data = await response.json() as TelegramResponse<{ file_id: string }>;
  if (!data.ok || !data.result) {
    throw new Error(data.description || 'uploadStickerFile failed');
  }
  return data.result;
}

interface StickerOwnerAvatarRecord {
  createdBy?: string;
  platforms?: {
    telegram?: {
      stickerOwnerUserId?: unknown;
      ownerUserId?: unknown;
      telegramUserId?: unknown;
    };
  };
}

function normalizeTelegramOwnerUserId(value: unknown): string | undefined {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? String(value) : undefined;
  }
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return /^\d+$/.test(trimmed) ? trimmed : undefined;
}

export function resolveStickerOwnerUserIdFromAvatarRecord(record?: StickerOwnerAvatarRecord | null): string | undefined {
  const telegramConfig = record?.platforms?.telegram;
  const configuredOwner = normalizeTelegramOwnerUserId(
    telegramConfig?.stickerOwnerUserId
    ?? telegramConfig?.ownerUserId
    ?? telegramConfig?.telegramUserId
  );
  if (configuredOwner) return configuredOwner;

  const createdBy = typeof record?.createdBy === 'string' ? record.createdBy.trim() : '';
  const match = /^telegram:(\d+)(?:\s|$|\()/i.exec(createdBy);
  return match?.[1];
}

async function resolveStoredStickerOwnerUserId(avatarId: string): Promise<string | undefined> {
  const [bindingResult, avatarResult] = await Promise.all([
    getDynamoClient().send(new GetCommand({
      TableName: getAdminTable(),
      Key: { pk: `AVATAR#${avatarId}`, sk: 'TELEGRAM_OWNER_BINDING' },
      ProjectionExpression: 'telegramUserId',
    })),
    getDynamoClient().send(new GetCommand({
      TableName: getAdminTable(),
      Key: { pk: `AVATAR#${avatarId}`, sk: 'CONFIG' },
      ProjectionExpression: '#createdBy, #platforms',
      ExpressionAttributeNames: {
        '#createdBy': 'createdBy',
        '#platforms': 'platforms',
      },
    })),
  ]);

  const bindingOwner = normalizeTelegramOwnerUserId(
    (bindingResult.Item as { telegramUserId?: unknown } | undefined)?.telegramUserId
  );
  if (bindingOwner) return bindingOwner;

  return resolveStickerOwnerUserIdFromAvatarRecord(avatarResult.Item as StickerOwnerAvatarRecord | undefined);
}

function requireTelegramOwnerUserId(ownerUserId?: string): number {
  const parsed = Number(ownerUserId);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error("Telegram sticker pack creation requires the avatar's linked Telegram account");
  }
  return parsed;
}

function generateGalleryId(): string {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function manifestKey(avatarId: string, setName: string): string {
  return `stickers/${avatarId}/manifests/${setName}.json`;
}

async function loadManifest(
  bucket: string,
  avatarId: string,
  setName: string,
): Promise<StickerSetManifest | null> {
  try {
    const response = await s3Client.send(new GetObjectCommand({
      Bucket: bucket,
      Key: manifestKey(avatarId, setName),
    }));
    const body = await response.Body?.transformToString();
    return body ? JSON.parse(body) as StickerSetManifest : null;
  } catch {
    return null;
  }
}

async function saveManifest(bucket: string, avatarId: string, manifest: StickerSetManifest): Promise<void> {
  manifest.lastUpdated = new Date().toISOString();
  await s3Client.send(new PutObjectCommand({
    Bucket: bucket,
    Key: manifestKey(avatarId, manifest.name),
    Body: JSON.stringify(manifest, null, 2),
    ContentType: 'application/json',
  }));
}

async function putGalleryRecord(avatarId: string, item: Omit<GalleryRecord, 'pk' | 'sk' | 'avatarId'>): Promise<GalleryRecord> {
  const createdAt = item.createdAt || Date.now();
  const record: GalleryRecord = {
    pk: `AVATAR#${avatarId}`,
    sk: `GALLERY#${createdAt}#${item.id}`,
    avatarId,
    ...item,
    createdAt,
  };

  await getDynamoClient().send(new PutCommand({
    TableName: getAdminTable(),
    Item: record,
  }));
  return record;
}

async function findGalleryItem(avatarId: string, itemId: string): Promise<GalleryRecord | null> {
  let lastEvaluatedKey: Record<string, unknown> | undefined;

  do {
    const result = await getDynamoClient().send(new QueryCommand({
      TableName: getAdminTable(),
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :sk)',
      FilterExpression: '#id = :id',
      ExpressionAttributeNames: { '#id': 'id' },
      ExpressionAttributeValues: {
        ':pk': `AVATAR#${avatarId}`,
        ':sk': 'GALLERY#',
        ':id': itemId,
      },
      ExclusiveStartKey: lastEvaluatedKey,
      Limit: 100,
    }));

    if (result.Items?.[0]) return result.Items[0] as GalleryRecord;
    lastEvaluatedKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (lastEvaluatedKey);

  return null;
}

async function listGalleryItems(
  avatarId: string,
  options: { type?: 'image' | 'video' | 'sticker'; limit?: number; unconvertedOnly?: boolean },
): Promise<GalleryRecord[]> {
  const limit = options.limit || 20;
  const matched: GalleryRecord[] = [];
  let lastEvaluatedKey: Record<string, unknown> | undefined;
  let rowsScanned = 0;

  do {
    const result = await getDynamoClient().send(new QueryCommand({
      TableName: getAdminTable(),
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :sk)',
      ExpressionAttributeValues: {
        ':pk': `AVATAR#${avatarId}`,
        ':sk': 'GALLERY#',
      },
      ScanIndexForward: false,
      Limit: options.type || options.unconvertedOnly ? 100 : limit,
      ExclusiveStartKey: lastEvaluatedKey,
    }));

    const items = (result.Items || []) as GalleryRecord[];
    rowsScanned += items.length;
    for (const item of items) {
      if (options.type && item.type !== options.type) continue;
      if (options.unconvertedOnly && item.convertedToSticker) continue;
      matched.push(item);
      if (matched.length >= limit) break;
    }

    lastEvaluatedKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (matched.length < limit && lastEvaluatedKey && rowsScanned < 2000);

  return matched;
}

async function updateAvatarStickerPack(
  avatarId: string,
  stickerPack: { name: string; title: string; stickerCount: number; createdAt: number },
): Promise<void> {
  const result = await getDynamoClient().send(new GetCommand({
    TableName: getAdminTable(),
    Key: { pk: `AVATAR#${avatarId}`, sk: 'CONFIG' },
  }));
  if (!result.Item) return;

  await getDynamoClient().send(new PutCommand({
    TableName: getAdminTable(),
    Item: {
      ...result.Item,
      stickerPack: {
        ...result.Item.stickerPack,
        ...stickerPack,
        createdAt: result.Item.stickerPack?.createdAt || stickerPack.createdAt,
      },
      updatedAt: Date.now(),
      updatedBy: 'runtime:telegram-sticker-packs',
    },
  }));
}

async function addProcessedStickerToPack(params: {
  avatarId: string;
  avatarName: string;
  mediaBucket: string;
  botToken: string;
  botUsername: string;
  ownerUserId: number;
  buffer: Buffer;
  prompt?: string;
  emoji: string;
  sourceGalleryItem?: GalleryRecord;
  cdnUrl?: string;
}): Promise<{
  stickerId: string;
  stickerUrl: string;
  emoji: string;
  packName: string;
  packUrl: string;
  fileId: string;
}> {
  const packName = generateStickerSetName(`${params.avatarName}_pack`, params.botUsername);
  const packTitle = `${params.avatarName}'s Stickers`;
  const uploadedFile = await uploadStickerFile(params.botToken, params.ownerUserId, params.buffer);

  const existingPack = await telegramJson<TelegramStickerSet>(params.botToken, 'getStickerSet', { name: packName });
  if (existingPack.ok) {
    const added = await telegramJson<boolean>(params.botToken, 'addStickerToSet', {
      user_id: params.ownerUserId,
      name: packName,
      sticker: {
        sticker: uploadedFile.file_id,
        format: 'static',
        emoji_list: [params.emoji],
      },
    });
    if (!added.ok) throw new Error(added.description || 'addStickerToSet failed');
  } else {
    const created = await telegramJson<boolean>(params.botToken, 'createNewStickerSet', {
      user_id: params.ownerUserId,
      name: packName,
      title: packTitle,
      stickers: [{
        sticker: uploadedFile.file_id,
        format: 'static',
        emoji_list: [params.emoji],
      }],
    });
    if (!created.ok) throw new Error(created.description || 'createNewStickerSet failed');
  }

  const stickerId = generateGalleryId();
  const datePrefix = new Date().toISOString().slice(0, 10);
  const s3Key = `stickers/${params.avatarId}/${datePrefix}/${stickerId}.png`;
  await s3Client.send(new PutObjectCommand({
    Bucket: params.mediaBucket,
    Key: s3Key,
    Body: params.buffer,
    ContentType: 'image/png',
    Metadata: {
      emoji: encodeURIComponent(params.emoji),
      prompt: params.prompt ? encodeURIComponent(params.prompt.slice(0, 500)) : '',
      setName: packName,
    },
  }));

  const stickerUrl = buildMediaUrl(s3Key, params.mediaBucket, params.cdnUrl);
  await putGalleryRecord(params.avatarId, {
    id: stickerId,
    type: 'sticker',
    url: stickerUrl,
    s3Key,
    prompt: params.prompt || '',
    model: 'telegram-sticker-pack',
    platform: 'telegram',
    postedToTwitter: false,
    convertedToSticker: true,
    createdAt: Date.now(),
    metadata: params.sourceGalleryItem ? { sourceGalleryId: params.sourceGalleryItem.id } : undefined,
    stickerInfo: {
      emoji: params.emoji,
      setName: packName,
      fileId: uploadedFile.file_id,
      stickerUrl,
      convertedAt: Date.now(),
    },
  });

  if (params.sourceGalleryItem) {
    await getDynamoClient().send(new PutCommand({
      TableName: getAdminTable(),
      Item: {
        ...params.sourceGalleryItem,
        convertedToSticker: true,
        stickerInfo: {
          emoji: params.emoji,
          setName: packName,
          fileId: uploadedFile.file_id,
          stickerUrl,
          convertedAt: Date.now(),
        },
      },
    }));
  }

  const latestPack = await telegramJson<TelegramStickerSet>(params.botToken, 'getStickerSet', { name: packName });
  const stickerCount = latestPack.result?.stickers.length || existingPack.result?.stickers.length || 1;
  await updateAvatarStickerPack(params.avatarId, {
    name: packName,
    title: packTitle,
    stickerCount,
    createdAt: Date.now(),
  });

  let manifest = await loadManifest(params.mediaBucket, params.avatarId, packName);
  if (!manifest) {
    manifest = {
      name: packName,
      title: packTitle,
      createdAt: new Date().toISOString(),
      lastUpdated: new Date().toISOString(),
      stickers: [],
    };
  }
  manifest.stickers.push({
    id: stickerId,
    emoji: params.emoji,
    prompt: params.prompt,
    createdAt: new Date().toISOString(),
    setName: packName,
    fileId: uploadedFile.file_id,
    url: stickerUrl,
  });
  await saveManifest(params.mediaBucket, params.avatarId, manifest);

  return {
    stickerId,
    stickerUrl,
    emoji: params.emoji,
    packName,
    packUrl: `https://t.me/addstickers/${packName}`,
    fileId: uploadedFile.file_id,
  };
}

export function createRuntimeStickerServices(config: RuntimeStickerServicesConfig): StickerServices {
  const botToken = getBotToken(config.secrets);
  const resolveStickerOwnerUserId = config.resolveStickerOwnerUserId ?? resolveStoredStickerOwnerUserId;

  async function getConfiguredBot() {
    if (!botToken) throw new Error('No Telegram bot token configured');
    const botInfo = await getBotInfo(botToken);
    if (!botInfo) throw new Error('Failed to get Telegram bot info');
    return { botToken, botInfo };
  }

  return {
    async generateSticker(avatarId, prompt, emoji, _conversationId) {
      if (!config.mediaService) {
        return { success: false, error: 'Media service not configured' };
      }
      if (!config.mediaBucket) {
        return { success: false, error: 'Media bucket not configured' };
      }

      try {
        const owner = requireTelegramOwnerUserId(await resolveStickerOwnerUserId(avatarId));
        await config.consumeStickerCredit?.();
        const { botToken: token, botInfo } = await getConfiguredBot();
        const stickerPrompt = `${prompt}. STICKER ART: bold clean lines, simplified shapes, flat vibrant colors, cartoon style. BACKGROUND: Must be PURE BLACK (#000000), solid and uniform, no gradients or patterns. OUTLINE: Include a THICK BRIGHT WHITE stroke (3-5px) around the entire subject edge.`;
        const referenceImageUrls = await resolveStickerReferenceImageUrls(config.avatarConfig, {
          onRejected: (candidate, reason) => {
            logger.warn('Skipping unreachable sticker reference image', {
              event: 'sticker_reference_skipped',
              subsystem: 'stickers',
              avatarId,
              referenceKind: candidate.kind,
              reason,
            });
          },
        });

        const generated = await config.mediaService.generateImage(stickerPrompt, config.avatarConfig.media.image, {
          avatarId,
          platform: 'telegram',
          aspectRatio: '1:1',
          saveToGallery: true,
          checkCredits: false,
          referenceImageUrls,
        });
        const processed = await processImageSourceForTelegramSticker(generated.url);
        const result = await addProcessedStickerToPack({
          avatarId,
          avatarName: config.avatarConfig.name,
          mediaBucket: config.mediaBucket,
          botToken: token,
          botUsername: botInfo.username,
          ownerUserId: owner,
          buffer: processed.buffer,
          prompt,
          emoji: emoji || selectStickerEmoji(prompt),
          cdnUrl: config.cdnUrl,
        });
        return { success: true, ...result };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.warn('Telegram sticker generation failed', {
          event: 'telegram_sticker_generation_failed',
          subsystem: 'stickers',
          avatarId,
          errorMessage,
        });
        return { success: false, error: errorMessage };
      }
    },

    async createStickerFromGallery(avatarId, galleryItemId, emoji, _conversationId) {
      if (!config.mediaBucket) {
        return { success: false, error: 'Media bucket not configured' };
      }

      try {
        const item = await findGalleryItem(avatarId, galleryItemId);
        if (!item) return { success: false, error: 'Gallery item not found' };
        if (item.type !== 'image') return { success: false, error: 'Can only convert image gallery items to stickers' };
        if (item.convertedToSticker && item.stickerInfo?.fileId) {
          return {
            success: true,
            stickerId: galleryItemId,
            stickerUrl: item.stickerInfo.stickerUrl,
            emoji: item.stickerInfo.emoji,
            packName: item.stickerInfo.setName,
            packUrl: `https://t.me/addstickers/${item.stickerInfo.setName}`,
            fileId: item.stickerInfo.fileId,
          };
        }

        const owner = requireTelegramOwnerUserId(await resolveStickerOwnerUserId(avatarId));
        await config.consumeStickerCredit?.();
        const { botToken: token, botInfo } = await getConfiguredBot();
        const processed = await processImageSourceForTelegramSticker(item.url);
        const result = await addProcessedStickerToPack({
          avatarId,
          avatarName: config.avatarConfig.name,
          mediaBucket: config.mediaBucket,
          botToken: token,
          botUsername: botInfo.username,
          ownerUserId: owner,
          buffer: processed.buffer,
          prompt: item.prompt,
          emoji: emoji || selectStickerEmoji(item.prompt),
          sourceGalleryItem: item,
          cdnUrl: config.cdnUrl,
        });
        return { success: true, ...result };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.warn('Telegram gallery sticker conversion failed', {
          event: 'telegram_gallery_sticker_conversion_failed',
          subsystem: 'stickers',
          avatarId,
          galleryItemId,
          errorMessage,
        });
        return { success: false, error: errorMessage };
      }
    },

    async getStickerPack(avatarId): Promise<StickerPackInfo | null> {
      const { botToken: token } = await getConfiguredBot();
      const avatar = await getDynamoClient().send(new GetCommand({
        TableName: getAdminTable(),
        Key: { pk: `AVATAR#${avatarId}`, sk: 'CONFIG' },
      }));
      const stickerPack = avatar.Item?.stickerPack as { name: string; title: string; stickerCount: number } | undefined;
      if (!stickerPack) return null;

      const telegramPack = await telegramJson<TelegramStickerSet>(token, 'getStickerSet', { name: stickerPack.name });
      const manifest = config.mediaBucket
        ? await loadManifest(config.mediaBucket, avatarId, stickerPack.name)
        : null;

      const stickers: StickerInfo[] = (telegramPack.result?.stickers || []).map((sticker, index) => {
        const manifestSticker = manifest?.stickers[index];
        return {
          id: manifestSticker?.id || sticker.file_id,
          emoji: sticker.emoji || manifestSticker?.emoji || '🐴',
          fileId: sticker.file_id,
          url: manifestSticker?.url,
          prompt: manifestSticker?.prompt,
          createdAt: manifestSticker?.createdAt || new Date().toISOString(),
        };
      });

      return {
        name: stickerPack.name,
        title: stickerPack.title,
        stickerCount: stickers.length || stickerPack.stickerCount,
        stickers,
        telegramUrl: `https://t.me/addstickers/${stickerPack.name}`,
      };
    },

    async getGalleryForStickers(avatarId, options): Promise<GalleryItemForSticker[]> {
      const items = await listGalleryItems(avatarId, {
        type: 'image',
        limit: options?.limit || 20,
        unconvertedOnly: options?.unconvertedOnly ?? true,
      });
      return items.map(item => ({
        id: item.id,
        url: item.url,
        prompt: item.prompt,
        type: item.type,
        convertedToSticker: Boolean(item.convertedToSticker),
      }));
    },

    async findSticker(avatarId, description): Promise<StickerInfo | null> {
      const pack = await this.getStickerPack(avatarId);
      if (!pack?.stickers.length) return null;

      const lower = description.toLowerCase();
      if (lower.includes('latest') || lower.includes('last') || lower.includes('recent') || lower.includes('newest')) {
        return pack.stickers[pack.stickers.length - 1];
      }
      if (lower.includes('first') || lower.includes('oldest')) return pack.stickers[0];
      if (lower.includes('random')) return pack.stickers[Math.floor(Math.random() * pack.stickers.length)];

      const emojiMatch = pack.stickers.find(sticker => sticker.emoji && lower.includes(sticker.emoji));
      if (emojiMatch) return emojiMatch;

      return pack.stickers.find(sticker => {
        if (!sticker.prompt) return false;
        const prompt = sticker.prompt.toLowerCase();
        return lower.split(/\s+/).some(word => word.length > 1 && prompt.includes(word));
      }) || pack.stickers[pack.stickers.length - 1];
    },
  };
}
