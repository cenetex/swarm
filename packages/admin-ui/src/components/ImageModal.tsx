/**
 * Image Modal Component
 * Full-screen image viewer with copy/save options
 */
import { useCallback, useEffect, useState } from 'react';

interface ImageModalProps {
  imageUrl: string;
  alt?: string;
  onClose: () => void;
}

export function ImageModal({ imageUrl, alt = 'Image', onClose }: ImageModalProps) {
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copying' | 'success' | 'error'>('idle');
  const [imageLoaded, setImageLoaded] = useState(false);

  // Close on escape key
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [onClose]);

  // Prevent body scroll when modal is open
  useEffect(() => {
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = '';
    };
  }, []);

  const handleCopyImage = useCallback(async () => {
    try {
      setCopyStatus('copying');
      
      // Fetch the image as a blob
      const response = await fetch(imageUrl);
      const blob = await response.blob();
      
      // Try to copy as image first (works in Chrome/Edge)
      if (navigator.clipboard && 'write' in navigator.clipboard) {
        try {
          await navigator.clipboard.write([
            new ClipboardItem({
              [blob.type]: blob,
            }),
          ]);
          setCopyStatus('success');
          setTimeout(() => setCopyStatus('idle'), 2000);
          return;
        } catch {
          // Fall back to copying URL
        }
      }
      
      // Fallback: copy the URL
      await navigator.clipboard.writeText(imageUrl);
      setCopyStatus('success');
      setTimeout(() => setCopyStatus('idle'), 2000);
    } catch (error) {
      console.error('Failed to copy image:', error);
      setCopyStatus('error');
      setTimeout(() => setCopyStatus('idle'), 2000);
    }
  }, [imageUrl]);

  const handleSaveImage = useCallback(async () => {
    try {
      // Extract filename from URL or generate one
      const urlParts = imageUrl.split('/');
      const filename = urlParts[urlParts.length - 1].split('?')[0] || `image-${Date.now()}.png`;
      
      // Fetch and save
      const response = await fetch(imageUrl);
      const blob = await response.blob();
      
      // Create download link
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } catch (error) {
      console.error('Failed to save image:', error);
    }
  }, [imageUrl]);

  const handleOpenInNewTab = useCallback(() => {
    window.open(imageUrl, '_blank', 'noopener,noreferrer');
  }, [imageUrl]);

  return (
    <div 
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm"
      onClick={onClose}
    >
      {/* Close button */}
      <button
        onClick={onClose}
        className="absolute top-4 right-4 p-2 text-white/70 hover:text-white transition-colors z-10"
        aria-label="Close"
      >
        <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>

      {/* Action buttons - top left */}
      <div 
        className="absolute top-4 left-4 flex gap-2 z-10"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Copy button */}
        <button
          onClick={handleCopyImage}
          disabled={copyStatus === 'copying'}
          className={`flex items-center gap-2 px-3 py-2 rounded-lg transition-colors ${
            copyStatus === 'success' 
              ? 'bg-green-600 text-white' 
              : copyStatus === 'error'
              ? 'bg-red-600 text-white'
              : 'bg-white/10 text-white hover:bg-white/20'
          }`}
          title="Copy image"
        >
          {copyStatus === 'copying' ? (
            <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
          ) : copyStatus === 'success' ? (
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
          ) : (
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
            </svg>
          )}
          <span className="text-sm font-medium">
            {copyStatus === 'success' ? 'Copied!' : copyStatus === 'error' ? 'Failed' : 'Copy'}
          </span>
        </button>

        {/* Save button */}
        <button
          onClick={handleSaveImage}
          className="flex items-center gap-2 px-3 py-2 rounded-lg bg-white/10 text-white hover:bg-white/20 transition-colors"
          title="Save image"
        >
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
          </svg>
          <span className="text-sm font-medium">Save</span>
        </button>

        {/* Open in new tab */}
        <button
          onClick={handleOpenInNewTab}
          className="flex items-center gap-2 px-3 py-2 rounded-lg bg-white/10 text-white hover:bg-white/20 transition-colors"
          title="Open in new tab"
        >
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
          </svg>
          <span className="text-sm font-medium">Open</span>
        </button>
      </div>

      {/* Image container */}
      <div 
        className="relative max-w-[90vw] max-h-[90vh] flex items-center justify-center"
        onClick={(e) => e.stopPropagation()}
      >
        {!imageLoaded && (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="w-8 h-8 border-2 border-white border-t-transparent rounded-full animate-spin" />
          </div>
        )}
        <img
          src={imageUrl}
          alt={alt}
          className={`max-w-full max-h-[90vh] object-contain rounded-lg shadow-2xl transition-opacity ${
            imageLoaded ? 'opacity-100' : 'opacity-0'
          }`}
          onLoad={() => setImageLoaded(true)}
        />
      </div>

      {/* Image info - bottom */}
      <div 
        className="absolute bottom-4 left-1/2 -translate-x-1/2 px-4 py-2 rounded-lg bg-black/50 text-white/70 text-sm"
        onClick={(e) => e.stopPropagation()}
      >
        Click outside or press Escape to close
      </div>
    </div>
  );
}

/**
 * Hook to manage image modal state
 */
export function useImageModal() {
  const [selectedImage, setSelectedImage] = useState<string | null>(null);

  const openImage = useCallback((url: string) => {
    setSelectedImage(url);
  }, []);

  const closeImage = useCallback(() => {
    setSelectedImage(null);
  }, []);

  return {
    selectedImage,
    openImage,
    closeImage,
  };
}
