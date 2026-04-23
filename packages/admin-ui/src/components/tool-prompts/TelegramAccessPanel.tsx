/**
 * Read-only Telegram access dashboard (#1474).
 *
 * Replaces the typed-input form that used to live inside IntegrationConfigPrompt
 * for Telegram. All policy authoring moves to Telegram itself (via the inline
 * keyboards shipped in #1471, #1472, #1473). This panel is observability +
 * revocation only:
 *
 *   1. Bound-owner status (or a Bind-to-Telegram CTA when unbound)
 *   2. "Add @bot to a group" deep link (launches Telegram's group picker)
 *   3. Approved chats — each row has a Revoke button
 *   4. Approved DMers — each row has a Revoke button
 *   5. Pending DM approvals — informational (owner decides inside Telegram)
 *
 * No text inputs. No Save button. Revokes are optimistic with rollback on
 * server error.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  getTelegramState,
  issueTelegramBindCode,
  revokeTelegramChat,
  revokeTelegramDmer,
  type TelegramState,
} from '../../api/telegram.js';

interface Props {
  avatarId: string;
  /** Bot username hinted by the token-validation flow (so we can render the
   * "Add to a group" deep link before the initial state fetch completes). */
  botUsernameHint?: string;
  disabled?: boolean;
}

export function TelegramAccessPanel({ avatarId, botUsernameHint, disabled }: Props) {
  const [state, setState] = useState<TelegramState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isBindPending, setIsBindPending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!avatarId) return;
    setIsLoading(true);
    try {
      const next = await getTelegramState(avatarId);
      setState(next);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Failed to load Telegram state');
    } finally {
      setIsLoading(false);
    }
  }, [avatarId]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleBind = useCallback(async () => {
    if (!avatarId || isBindPending) return;
    setIsBindPending(true);
    setActionError(null);
    try {
      const { deepLink } = await issueTelegramBindCode(avatarId);
      window.open(deepLink, '_blank', 'noopener,noreferrer');
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to issue bind link');
    } finally {
      setIsBindPending(false);
    }
  }, [avatarId, isBindPending]);

  const handleRevokeChat = useCallback(async (chatId: string) => {
    if (!state) return;
    const previous = state;
    // Optimistic: drop the chat immediately, rollback on error.
    setState({ ...state, allowedChats: state.allowedChats.filter(c => c.chatId !== chatId) });
    setActionError(null);
    try {
      await revokeTelegramChat(avatarId, chatId);
    } catch (err) {
      setState(previous);
      setActionError(err instanceof Error ? err.message : 'Failed to revoke chat');
    }
  }, [avatarId, state]);

  const handleRevokeDmer = useCallback(async (userId: string) => {
    if (!state) return;
    const previous = state;
    setState({ ...state, allowedDmUsers: state.allowedDmUsers.filter(u => u.userId !== userId) });
    setActionError(null);
    try {
      await revokeTelegramDmer(avatarId, userId);
    } catch (err) {
      setState(previous);
      setActionError(err instanceof Error ? err.message : 'Failed to revoke DM access');
    }
  }, [avatarId, state]);

  const botUsername = state?.botUsername || botUsernameHint;
  const bound = state?.binding ?? null;

  return (
    <div className="space-y-4">
      <div className="p-3 bg-[var(--color-bg-tertiary)] rounded-lg border border-[var(--color-border)]">
        <p className="text-sm font-medium text-[var(--color-text)]">Telegram access</p>
        <p className="text-xs text-[var(--color-text-muted)] mt-1">
          Approvals happen inside Telegram itself — just add the bot to a group or have someone DM it. Revocations can also happen here.
        </p>
        {loadError && (
          <p className="text-xs text-yellow-400 mt-2">{loadError}</p>
        )}
      </div>

      {/* 1. Owner binding */}
      <div className="space-y-2">
        <label className="block text-sm font-medium text-[var(--color-text-secondary)]">
          Owner link
        </label>
        {bound ? (
          <div className="flex items-center justify-between gap-2 px-3 py-2 bg-green-500/10 border border-green-500/30 rounded-lg">
            <div className="flex items-center gap-2">
              <span className="text-lg">✓</span>
              <span className="text-sm text-green-300">
                Bound as {bound.telegramUsername ? `@${bound.telegramUsername}` : `Telegram user ${bound.telegramUserId}`}
              </span>
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            <p className="text-xs text-[var(--color-text-muted)]">
              Link your Telegram account so only you can enable the bot in groups and approve DMers.
            </p>
            <button
              type="button"
              onClick={() => void handleBind()}
              disabled={disabled || isBindPending || !botUsername}
              className="inline-flex items-center gap-2 px-3 py-1.5 text-sm bg-brand-600 hover:bg-brand-700 disabled:opacity-50 disabled:cursor-not-allowed border border-brand-500/30 rounded-lg text-white transition-colors"
            >
              🔗 {isBindPending ? 'Opening Telegram…' : 'Bind to Telegram'}
            </button>
            {!botUsername && (
              <p className="text-xs text-yellow-400">Enter a bot token above first so we know which bot to open.</p>
            )}
          </div>
        )}
      </div>

      {/* 2. Add-to-group deep link */}
      {botUsername && (
        <div className="space-y-2">
          <label className="block text-sm font-medium text-[var(--color-text-secondary)]">
            Add bot to a group
          </label>
          <a
            href={`https://t.me/${botUsername}?startgroup=true`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 px-3 py-1.5 text-xs bg-brand-600/20 hover:bg-brand-600/40 border border-brand-500/30 rounded-lg text-brand-300 transition-colors"
          >
            <span>+</span>
            <span>Add @{botUsername} to a group on Telegram</span>
          </a>
          <p className="text-xs text-[var(--color-text-muted)]">
            Opens Telegram's group picker. Once added, the group shows up below and I'll post an Enable button for you to tap.
          </p>
        </div>
      )}

      {/* 3. Approved chats */}
      <div className="space-y-2">
        <label className="block text-sm font-medium text-[var(--color-text-secondary)]">
          Approved chats ({state?.allowedChats.length ?? 0})
        </label>
        {isLoading ? (
          <p className="text-xs text-[var(--color-text-muted)]">Loading…</p>
        ) : !state || state.allowedChats.length === 0 ? (
          <p className="text-xs text-[var(--color-text-muted)]">
            None yet. Add the bot to a Telegram group to start.
          </p>
        ) : (
          <div className="space-y-1">
            {state.allowedChats.map((chat) => (
              <div key={chat.chatId} className="flex items-center justify-between gap-2 px-3 py-2 bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] rounded-lg">
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-[var(--color-text)] truncate">
                    {chat.title || (chat.username ? `@${chat.username}` : chat.chatId)}
                  </p>
                  {(chat.title || chat.username) && (
                    <p className="text-xs text-[var(--color-text-muted)] truncate">{chat.chatId}</p>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => void handleRevokeChat(chat.chatId)}
                  disabled={disabled}
                  className="px-2 py-1 text-xs text-red-300 hover:bg-red-500/10 rounded transition-colors"
                  aria-label={`Revoke ${chat.title || chat.chatId}`}
                >
                  Revoke
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 4. Approved DMers */}
      <div className="space-y-2">
        <label className="block text-sm font-medium text-[var(--color-text-secondary)]">
          Approved DM users ({state?.allowedDmUsers.length ?? 0})
        </label>
        {isLoading ? (
          <p className="text-xs text-[var(--color-text-muted)]">Loading…</p>
        ) : !state || state.allowedDmUsers.length === 0 ? (
          <p className="text-xs text-[var(--color-text-muted)]">
            None yet. When someone DMs the bot, I'll ask you to approve them in Telegram.
          </p>
        ) : (
          <div className="space-y-1">
            {state.allowedDmUsers.map((user) => (
              <div key={user.userId} className="flex items-center justify-between gap-2 px-3 py-2 bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] rounded-lg">
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-[var(--color-text)] truncate">
                    {user.username ? `@${user.username}` : user.displayName || `Telegram user ${user.userId}`}
                  </p>
                  {(user.username || user.displayName) && (
                    <p className="text-xs text-[var(--color-text-muted)] truncate">{user.userId}</p>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => void handleRevokeDmer(user.userId)}
                  disabled={disabled}
                  className="px-2 py-1 text-xs text-red-300 hover:bg-red-500/10 rounded transition-colors"
                  aria-label={`Revoke ${user.username || user.userId}`}
                >
                  Revoke
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 5. Pending DM approvals (read-only informational) */}
      {state && state.pendingDms.length > 0 && (
        <div className="space-y-2">
          <label className="block text-sm font-medium text-[var(--color-text-secondary)]">
            Pending DM requests ({state.pendingDms.length})
          </label>
          <p className="text-xs text-[var(--color-text-muted)]">
            I've DM'd you in Telegram about each of these — tap the Allow / Deny / Block buttons there.
          </p>
          <div className="space-y-1">
            {state.pendingDms.map((p) => (
              <div key={p.requesterId} className="px-3 py-2 bg-yellow-500/10 border border-yellow-500/30 rounded-lg">
                <p className="text-sm text-yellow-300">
                  {p.requesterUsername ? `@${p.requesterUsername}` : p.requesterDisplayName || `User ${p.requesterId}`}
                </p>
                <p className="text-xs text-[var(--color-text-muted)] mt-1 truncate">
                  "{p.firstMessage}"
                </p>
              </div>
            ))}
          </div>
        </div>
      )}

      {actionError && (
        <p className="text-xs text-red-400">{actionError}</p>
      )}
    </div>
  );
}
