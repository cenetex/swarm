/**
 * Activation Checklist - Inline chat-first component that shows avatar
 * activation progress and next steps after creation.
 *
 * Renders as a compact card within the chat flow, guiding users through
 * the steps needed to get their avatar responding on platforms.
 */
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Avatar } from '../types';

interface ActivationChecklistProps {
  avatar: Avatar;
  onSuggest: (message: string) => void;
}

interface ChecklistItem {
  id: string;
  label: string;
  done: boolean;
  suggestion?: string;
  priority: 'required' | 'recommended' | 'optional';
}

type TranslateFn = (key: string, options?: Record<string, unknown>) => string;

function getChecklistItems(avatar: Avatar, t: TranslateFn): ChecklistItem[] {
  const items: ChecklistItem[] = [];

  // 1. Persona / description set
  const hasPersona = Boolean(avatar.persona && avatar.persona.trim().length > 10);
  items.push({
    id: 'persona',
    label: t('activation.setPersonality'),
    done: hasPersona,
    suggestion: t('activation.personalitySuggestion'),
    priority: 'recommended',
  });

  // 2. Profile image
  const hasProfileImage = Boolean(
    avatar.avatar &&
    !avatar.avatar.includes('dicebear.com') // DiceBear = auto-generated placeholder
  );
  items.push({
    id: 'profile_image',
    label: t('activation.setProfileImage'),
    done: hasProfileImage,
    suggestion: t('activation.profileImageSuggestion'),
    priority: 'recommended',
  });

  // 3. Telegram connected
  const telegramEnabled = avatar.platforms?.telegram?.enabled === true;
  items.push({
    id: 'telegram',
    label: t('activation.connectTelegramItem'),
    done: telegramEnabled,
    suggestion: t('activation.telegramSuggestion'),
    priority: 'optional',
  });

  // 4. Twitter connected
  const twitterEnabled = avatar.platforms?.twitter?.enabled === true;
  items.push({
    id: 'twitter',
    label: t('activation.connectTwitterItem'),
    done: twitterEnabled,
    suggestion: t('activation.twitterSuggestion'),
    priority: 'optional',
  });

  // 5. Discord connected
  const discordEnabled = avatar.platforms?.discord?.enabled === true;
  items.push({
    id: 'discord',
    label: t('activation.connectDiscordItem'),
    done: discordEnabled,
    suggestion: t('activation.discordSuggestion'),
    priority: 'optional',
  });

  return items;
}

export function ActivationChecklist({ avatar, onSuggest }: ActivationChecklistProps) {
  const [dismissed, setDismissed] = useState(false);
  const { t } = useTranslation();
  const items = useMemo(() => getChecklistItems(avatar, t), [avatar, t]);
  const completedCount = items.filter(i => i.done).length;
  const allDone = completedCount === items.length;

  if (dismissed) return null;

  // Once fully complete, show a success message briefly (or let user dismiss)
  if (allDone) {
    return (
      <div className="mb-3 lg:mb-4">
        <div className="bg-green-500/10 border border-green-500/30 rounded-xl px-4 py-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <svg className="w-5 h-5 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <span className="text-sm font-medium text-green-300">
                {t('activation.completedMessage')}
              </span>
            </div>
            <button
              onClick={() => setDismissed(true)}
              className="p-1 rounded hover:bg-green-500/20 text-green-400 hover:text-green-300"
              aria-label={t('common.close')}
            >
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
              </svg>
            </button>
          </div>
        </div>
      </div>
    );
  }

  const progressPct = Math.round((completedCount / items.length) * 100);

  return (
    <div className="mb-3 lg:mb-4">
      <div className="bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-xl px-4 py-3">
        {/* Header */}
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <svg className="w-4 h-4 text-brand-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
            <span className="text-sm font-medium text-[var(--color-text)]">
              {t('activation.progressTitle')}
            </span>
            <span className="text-xs text-[var(--color-text-muted)]">
              {t('activation.progressCount', { completed: completedCount, total: items.length })}
            </span>
          </div>
          <button
            onClick={() => setDismissed(true)}
            className="p-1 rounded hover:bg-[var(--color-bg-tertiary)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
            aria-label={t('common.close')}
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5">
              <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
            </svg>
          </button>
        </div>

        {/* Progress bar */}
        <div className="h-1.5 bg-[var(--color-bg-tertiary)] rounded-full overflow-hidden mb-3">
          <div
            className="h-full bg-brand-500 transition-all duration-500 rounded-full"
            style={{ width: `${progressPct}%` }}
          />
        </div>

        {/* Checklist items */}
        <div className="space-y-1.5">
          {items.map((item) => (
            <div key={item.id} className="flex items-center gap-2 group">
              {/* Checkbox icon */}
              {item.done ? (
                <svg className="w-4 h-4 text-green-400 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
              ) : (
                <div className="w-4 h-4 rounded-full border border-[var(--color-text-muted)] flex-shrink-0" />
              )}

              {/* Label */}
              <span className={`text-xs flex-1 ${
                item.done
                  ? 'text-[var(--color-text-muted)] line-through'
                  : 'text-[var(--color-text-secondary)]'
              }`}>
                {item.label}
                {item.priority === 'optional' && !item.done && (
                  <span className="ml-1 text-[var(--color-text-muted)]">{t('activation.optionalLabel')}</span>
                )}
              </span>

              {/* Quick action button */}
              {!item.done && item.suggestion && (
                <button
                  onClick={() => onSuggest(item.suggestion!)}
                  className="opacity-0 group-hover:opacity-100 transition-opacity text-xs text-brand-400 hover:text-brand-300 whitespace-nowrap"
                >
                  {t('activation.setupAction')}
                </button>
              )}
            </div>
          ))}
        </div>

        {/* Tip */}
        <div className="mt-3 pt-2 border-t border-[var(--color-border)]">
          <p className="text-xs text-[var(--color-text-muted)]">
            {t('activation.tip')}
          </p>
        </div>
      </div>
    </div>
  );
}
