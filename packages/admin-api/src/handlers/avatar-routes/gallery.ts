/**
 * Gallery routes.
 *
 * - GET  /avatars/{id}/gallery
 * - POST /avatars/{id}/gallery/upload-url
 * - POST /avatars/{id}/gallery/save
 */
import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import type { RouteContext } from './types.js';
import { jsonResponse, requireOwnerOrAdmin } from './shared.js';
import { parseJsonBody } from '../../http/request-body.js';
import * as avatarService from '../../services/avatars.js';
import * as galleryService from '../../services/gallery.js';
import * as mediaService from '../../services/media.js';

export async function handleGalleryRoutes(
  ctx: RouteContext,
): Promise<APIGatewayProxyResultV2 | null> {
  const { method, path, corsHeaders } = ctx;

  // ── GET /avatars/{id}/gallery ───────────────────────────────────────────
  const galleryMatch = path.match(/^\/avatars\/([^/]+)\/gallery$/);
  if (method === 'GET' && galleryMatch) {
    const avatarId = galleryMatch[1];
    const denied = await requireOwnerOrAdmin(ctx, avatarId, avatarService.getAvatar);
    if (denied) return denied;

    const params = ctx.event.queryStringParameters || {};
    const type = params.type as 'image' | 'video' | 'sticker' | undefined;
    const limit = params.limit ? parseInt(params.limit, 10) : 50;

    const items = await galleryService.getGallery(avatarId, { type, limit });

    return jsonResponse(corsHeaders, 200, {
      items: items.map(item => ({
        id: item.id,
        type: item.type,
        url: item.url,
        prompt: item.prompt,
        caption: item.caption,
        createdAt: item.createdAt,
      })),
    });
  }

  // ── POST /avatars/{id}/gallery/upload-url ───────────────────────────────
  const uploadUrlMatch = path.match(/^\/avatars\/([^/]+)\/gallery\/upload-url$/);
  if (method === 'POST' && uploadUrlMatch) {
    const avatarId = uploadUrlMatch[1];
    const denied = await requireOwnerOrAdmin(ctx, avatarId, avatarService.getAvatar);
    if (denied) return denied;

    const body = parseJsonBody(ctx.event) as { contentType?: string } | null;
    const contentType = (body?.contentType as string) || 'image/png';

    const result = await mediaService.getGalleryUploadUrl(avatarId, contentType);
    return jsonResponse(corsHeaders, 200, result);
  }

  // ── POST /avatars/{id}/gallery/save ─────────────────────────────────────
  const saveMatch = path.match(/^\/avatars\/([^/]+)\/gallery\/save$/);
  if (method === 'POST' && saveMatch) {
    const avatarId = saveMatch[1];
    const denied = await requireOwnerOrAdmin(ctx, avatarId, avatarService.getAvatar);
    if (denied) return denied;

    const body = parseJsonBody(ctx.event) as { s3Key?: string; publicUrl?: string; caption?: string } | null;
    if (!body?.s3Key || !body?.publicUrl) {
      return jsonResponse(corsHeaders, 400, { error: 's3Key and publicUrl are required' });
    }

    const id = galleryService.generateGalleryId();
    const item = await galleryService.addToGallery(avatarId, {
      id,
      type: 'image',
      url: body.publicUrl as string,
      s3Key: body.s3Key as string,
      prompt: '',
      caption: (body.caption as string) || '',
      model: 'upload',
      platform: 'admin-ui',
    });

    return jsonResponse(corsHeaders, 201, {
      id: item.id,
      url: item.url,
      createdAt: item.createdAt,
    });
  }

  return null;
}
