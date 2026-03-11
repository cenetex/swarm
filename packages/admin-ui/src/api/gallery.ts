/**
 * Gallery API - Backend calls for gallery operations
 */
import { API_BASE } from './apiBase';

export interface GalleryItem {
  id: string;
  type: 'image' | 'video' | 'sticker';
  url: string;
  prompt?: string;
  caption?: string;
  createdAt: number;
}

export async function getGallery(
  avatarId: string,
  options?: { type?: string; limit?: number },
): Promise<GalleryItem[]> {
  const params = new URLSearchParams();
  if (options?.type) params.set('type', options.type);
  if (options?.limit) params.set('limit', String(options.limit));
  const qs = params.toString();

  const res = await fetch(
    `${API_BASE}/avatars/${avatarId}/gallery${qs ? `?${qs}` : ''}`,
    { credentials: 'include' },
  );
  if (!res.ok) throw new Error(`Failed to fetch gallery: ${res.status}`);
  const data = await res.json();
  return data.items || [];
}

export async function getUploadUrl(
  avatarId: string,
  contentType: string = 'image/png',
): Promise<{ uploadUrl: string; s3Key: string; publicUrl: string }> {
  const res = await fetch(`${API_BASE}/avatars/${avatarId}/gallery/upload-url`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contentType }),
  });
  if (!res.ok) throw new Error(`Failed to get upload URL: ${res.status}`);
  return res.json();
}

export async function uploadFile(uploadUrl: string, file: File): Promise<void> {
  const res = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': file.type },
    body: file,
  });
  if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
}

export async function saveGalleryUpload(
  avatarId: string,
  data: { s3Key: string; publicUrl: string; caption?: string },
): Promise<{ id: string; url: string; createdAt: number }> {
  const res = await fetch(`${API_BASE}/avatars/${avatarId}/gallery/save`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(`Failed to save gallery item: ${res.status}`);
  return res.json();
}
