/**
 * Avatar Reassign Modal - Admin-only modal for reassigning avatar ownership
 */
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Avatar } from '../types';
import { reassignAvatar } from '../api/avatars';

interface AvatarReassignModalProps {
  avatar: Avatar;
  onClose: () => void;
  onSuccess: () => void;
}

export function AvatarReassignModal({ avatar, onClose, onSuccess }: AvatarReassignModalProps) {
  const { t } = useTranslation();
  const [creatorWallet, setCreatorWallet] = useState(avatar.creatorWallet || '');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    setError(null);

    try {
      const updates: { creatorWallet?: string } = {};

      // Only include creatorWallet if it changed
      if (creatorWallet !== avatar.creatorWallet) {
        updates.creatorWallet = creatorWallet;
      }

      // Only call API if there are actual changes
      if (Object.keys(updates).length === 0) {
        onClose();
        return;
      }

      await reassignAvatar(avatar.id, updates);
      onSuccess();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('avatar.reassignFailed'));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-xl shadow-xl max-w-md w-full mx-4">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--color-border)]">
          <h2 className="text-lg font-semibold text-[var(--color-text)]">
            {t('avatar.reassignTitle')}
          </h2>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-[var(--color-bg-tertiary)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
            aria-label={t('avatar.closeModal')}
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5">
              <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
            </svg>
          </button>
        </div>

        {/* Content */}
        <form onSubmit={handleSubmit} className="p-4 space-y-4">
          {/* Avatar info */}
          <div className="p-3 rounded-lg bg-[var(--color-bg-tertiary)] border border-[var(--color-border)]">
            <div className="text-sm font-medium text-[var(--color-text)]">
              {avatar.name}
            </div>
            <div className="text-xs text-[var(--color-text-muted)] mt-1">
              {t('avatar.idLabel')} {avatar.id}
            </div>
          </div>

          {/* Creator Wallet */}
          <div>
            <label className="block text-sm font-medium text-[var(--color-text)] mb-1">
              {t('avatar.creatorWalletLabel')}
            </label>
            <input
              type="text"
              value={creatorWallet}
              onChange={(e) => setCreatorWallet(e.target.value)}
              placeholder={t('avatar.creatorWalletPlaceholder')}
              className="w-full px-3 py-2 rounded-lg bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] text-[var(--color-text)] placeholder-[var(--color-text-muted)] focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
            <p className="text-xs text-[var(--color-text-muted)] mt-1">
              {t('avatar.creatorWalletHelper')}
            </p>
          </div>

          {/* Error message */}
          {error && (
            <div className="p-3 rounded-lg bg-red-900/20 border border-red-500/30 text-red-400 text-sm">
              {error}
            </div>
          )}

          {/* Actions */}
          <div className="flex justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-lg text-[var(--color-text-secondary)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)] transition-colors"
            >
              {t('common.cancel')}
            </button>
            <button
              type="submit"
              disabled={isSubmitting}
              className="px-4 py-2 rounded-lg bg-brand-600 hover:bg-brand-500 text-white font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isSubmitting ? t('avatar.saving') : t('avatar.saveChanges')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
