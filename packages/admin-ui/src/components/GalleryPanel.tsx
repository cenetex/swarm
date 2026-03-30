/**
 * Gallery Panel - Right-side panel showing avatar's media gallery
 *
 * Features:
 * - Grid view of gallery items (images, videos, stickers)
 * - Photo upload via drag & drop or file picker
 * - Type filtering
 * - Click to view full-size in ImageModal
 *
 * GalleryContent is the embeddable content component used inside the
 * workspace panel. GalleryPanel is the standalone wrapper (now unused
 * but retained for backward compat until fully migrated).
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import * as galleryApi from '../api/gallery';
import type { GalleryItem } from '../api/gallery';
import { ImageModal } from './ImageModal';

interface GalleryContentProps {
  avatarId: string;
  isOpen: boolean;
  onSelectImage?: (url: string, caption?: string) => void;
}

export function GalleryContent({ avatarId, isOpen, onSelectImage }: GalleryContentProps) {
  const { t } = useTranslation();
  const [items, setItems] = useState<GalleryItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'image' | 'video' | 'sticker'>('all');
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [selectedImage, setSelectedImage] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const fetchGallery = useCallback(async () => {
    if (!avatarId) return;
    setLoading(true);
    setError(null);
    try {
      const result = await galleryApi.getGallery(avatarId, {
        type: filter === 'all' ? undefined : filter,
        limit: 100,
      });
      setItems(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load gallery');
    } finally {
      setLoading(false);
    }
  }, [avatarId, filter]);

  useEffect(() => {
    if (isOpen) fetchGallery();
  }, [isOpen, fetchGallery]);

  const handleUpload = useCallback(async (file: File) => {
    if (!file.type.startsWith('image/')) {
      setError(t('gallery.onlyImages'));
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setError(t('gallery.fileTooLarge'));
      return;
    }

    setUploading(true);
    setError(null);
    try {
      const { uploadUrl, s3Key, publicUrl } = await galleryApi.getUploadUrl(avatarId, file.type);
      await galleryApi.uploadFile(uploadUrl, file);
      await galleryApi.saveGalleryUpload(avatarId, { s3Key, publicUrl });
      await fetchGallery();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
  }, [avatarId, fetchGallery, t]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) handleUpload(file);
  }, [handleUpload]);

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleUpload(file);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, [handleUpload]);

  return (
    <>
      {/* Upload button */}
      <div className="flex items-center gap-2 mb-2">
        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading}
          className="px-3 py-1.5 text-xs bg-brand-600 hover:bg-brand-500 text-white rounded-lg transition-colors disabled:opacity-50"
          title={t('gallery.uploadPhoto')}
        >
          {uploading ? t('common.uploading') : t('common.upload')}
        </button>
      </div>

      {/* Type filter */}
      <div className="flex gap-1 mb-2">
        {(['all', 'image', 'video', 'sticker'] as const).map(type => (
          <button
            key={type}
            onClick={() => setFilter(type)}
            className={`px-2 py-1 text-xs rounded transition-colors ${
              filter === type
                ? 'bg-brand-600 text-white'
                : 'text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)]'
            }`}
          >
            {type === 'all' ? t('gallery.all') : type === 'image' ? t('gallery.images') : type === 'video' ? t('gallery.videos') : t('gallery.stickers')}
          </button>
        ))}
      </div>

      {/* Error */}
      {error && (
        <div className="px-3 py-2 text-xs text-red-400 bg-red-900/20 rounded-lg mb-2">
          {error}
        </div>
      )}

      {/* Gallery grid */}
      <div
        className={`flex-1 overflow-y-auto ${dragOver ? 'ring-2 ring-brand-500 ring-inset bg-brand-900/10 rounded-lg' : ''}`}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
      >
        {loading && items.length === 0 ? (
          <div className="flex items-center justify-center h-32 text-[var(--color-text-tertiary)] text-sm">
            {t('common.loading')}
          </div>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-32 text-[var(--color-text-tertiary)] text-sm gap-2">
            <p>{t('gallery.noMedia')}</p>
            <p className="text-xs">{t('gallery.noMediaHint')}</p>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            {items.map(item => (
              <button
                key={item.id}
                onClick={() => {
                  if (onSelectImage) {
                    onSelectImage(item.url, item.caption || item.prompt);
                  } else {
                    setSelectedImage(item.url);
                  }
                }}
                className="group relative aspect-square rounded-lg overflow-hidden bg-[var(--color-bg-tertiary)] hover:ring-2 hover:ring-brand-500 transition-all"
                title={item.caption || item.prompt || item.type}
              >
                <img
                  src={item.url}
                  alt={item.caption || item.prompt || ''}
                  className="w-full h-full object-cover"
                  loading="lazy"
                />
                {/* Type badge */}
                {item.type !== 'image' && (
                  <span className="absolute top-1 left-1 px-1.5 py-0.5 text-[10px] bg-black/60 text-white rounded">
                    {item.type}
                  </span>
                )}
                {/* Hover overlay */}
                <div className="absolute inset-0 bg-black/0 group-hover:bg-black/30 transition-colors flex items-end">
                  {(item.caption || item.prompt) && (
                    <p className="p-1.5 text-[10px] text-white opacity-0 group-hover:opacity-100 transition-opacity line-clamp-2">
                      {item.caption || item.prompt}
                    </p>
                  )}
                </div>
              </button>
            ))}
          </div>
        )}

        {/* Drop zone hint when empty */}
        {dragOver && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="px-4 py-2 bg-brand-600 text-white rounded-lg text-sm font-medium">
              {t('gallery.dropToUpload')}
            </div>
          </div>
        )}
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        onChange={handleFileSelect}
        className="hidden"
      />

      {/* Full-size image viewer */}
      {selectedImage && (
        <ImageModal
          imageUrl={selectedImage}
          alt=""
          onClose={() => setSelectedImage(null)}
        />
      )}
    </>
  );
}

interface GalleryPanelProps {
  avatarId: string;
  isOpen: boolean;
  onClose: () => void;
  onSelectImage?: (url: string, caption?: string) => void;
}

export function GalleryPanel({ avatarId, isOpen, onClose, onSelectImage }: GalleryPanelProps) {
  if (!isOpen) return null;

  return (
    <div
      className="w-80 border-l border-[var(--color-border)] bg-[var(--color-bg-secondary)] flex flex-col h-full overflow-hidden"
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--color-border)]">
        <h3 className="text-sm font-semibold text-[var(--color-text-primary)]">{t('gallery.title')}</h3>
        <button
          onClick={onClose}
          className="p-1 text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)] rounded transition-colors"
          title={t('gallery.closeGallery')}
        >
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
            <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
          </svg>
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-3 flex flex-col">
        <GalleryContent avatarId={avatarId} isOpen={isOpen} onSelectImage={onSelectImage} />
      </div>
    </div>
  );
}
