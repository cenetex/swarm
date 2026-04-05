// Re-export from media/ — see services/media/gallery.ts for implementation
//
// NOTE: We use wrapper functions rather than `export * from` so that
// bun's `mock.module` of this barrel does not poison the underlying
// services/media/gallery.js module cache (which would break service-level
// tests that import the implementation directly).
import * as impl from './media/gallery.js';

export const generateGalleryId = (...args: Parameters<typeof impl.generateGalleryId>) =>
  impl.generateGalleryId(...args);

export const addToGallery = (...args: Parameters<typeof impl.addToGallery>) =>
  impl.addToGallery(...args);

export const getGallery = (...args: Parameters<typeof impl.getGallery>) =>
  impl.getGallery(...args);

export const getGalleryItem = (...args: Parameters<typeof impl.getGalleryItem>) =>
  impl.getGalleryItem(...args);

export const getLatestProfileImageFromGallery = (
  ...args: Parameters<typeof impl.getLatestProfileImageFromGallery>
) => impl.getLatestProfileImageFromGallery(...args);

export const markPostedToTwitter = (...args: Parameters<typeof impl.markPostedToTwitter>) =>
  impl.markPostedToTwitter(...args);

export const markConvertedToSticker = (...args: Parameters<typeof impl.markConvertedToSticker>) =>
  impl.markConvertedToSticker(...args);

export const findByDescription = (...args: Parameters<typeof impl.findByDescription>) =>
  impl.findByDescription(...args);

export const getGalleryStats = (...args: Parameters<typeof impl.getGalleryStats>) =>
  impl.getGalleryStats(...args);
