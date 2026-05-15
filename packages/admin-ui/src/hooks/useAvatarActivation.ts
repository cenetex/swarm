import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { activateAvatar, deactivateAvatar } from '../api';
import { useAvatarStore } from '../store/avatars';
import type { Avatar } from '../types';

function hasConfiguredPlatforms(avatar: Avatar | null | undefined): boolean {
  if (!avatar || avatar.status === 'active') return false;
  const platforms = avatar.platforms;
  return Boolean(
    platforms?.telegram?.enabled ||
      platforms?.twitter?.enabled ||
      platforms?.discord?.enabled
  );
}

export function useAvatarActivation(avatar: Avatar | null | undefined) {
  const { t } = useTranslation();
  const updateAvatar = useAvatarStore((s) => s.updateAvatar);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showPauseConfirm, setShowPauseConfirm] = useState(false);
  const errorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
    };
  }, []);

  useEffect(() => {
    setShowPauseConfirm(false);
    setError(null);
  }, [avatar?.id]);

  const clearError = useCallback(() => {
    if (errorTimerRef.current) {
      clearTimeout(errorTimerRef.current);
      errorTimerRef.current = null;
    }
    setError(null);
  }, []);

  const setAutoClearingError = useCallback((message: string) => {
    setError(message);
    if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
    errorTimerRef.current = setTimeout(() => {
      setError(null);
      errorTimerRef.current = null;
    }, 5000);
  }, []);

  const toggleActivation = useCallback(async () => {
    if (!avatar || isLoading) return;

    const isCurrentlyActive = avatar.status === 'active';
    if (isCurrentlyActive && !showPauseConfirm) {
      setShowPauseConfirm(true);
      return;
    }

    setIsLoading(true);
    clearError();
    setShowPauseConfirm(false);

    try {
      if (isCurrentlyActive) {
        await deactivateAvatar(avatar.id);
        updateAvatar(avatar.id, { status: 'paused' });
      } else {
        await activateAvatar(avatar.id);
        updateAvatar(avatar.id, { status: 'active' });
      }
    } catch (err) {
      setAutoClearingError(
        err instanceof Error ? err.message : t('chat.errors.failedToUpdateAvatarStatus')
      );
    } finally {
      setIsLoading(false);
    }
  }, [
    avatar,
    clearError,
    isLoading,
    setAutoClearingError,
    showPauseConfirm,
    t,
    updateAvatar,
  ]);

  const cancelPause = useCallback(() => {
    setShowPauseConfirm(false);
  }, []);

  const hasConfiguredPlatformsButInactive = useMemo(
    () => hasConfiguredPlatforms(avatar),
    [avatar]
  );

  return {
    cancelPause,
    clearError,
    error,
    hasConfiguredPlatformsButInactive,
    isLoading,
    showPauseConfirm,
    toggleActivation,
  };
}
