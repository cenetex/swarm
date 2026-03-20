/**
 * Consent Banner
 * Shown to users who haven't yet accepted the privacy policy.
 * Blocks app usage until consent is given.
 */
import { useState } from 'react';
import { useTranslation, Trans } from 'react-i18next';
import { useConsentStore, CURRENT_POLICY_VERSION } from '../store/consent';
import { PrivacyPolicy } from './PrivacyPolicy';

export function ConsentBanner() {
  const { t } = useTranslation();
  const acceptConsent = useConsentStore((s) => s.acceptConsent);
  const [showPolicy, setShowPolicy] = useState(false);

  if (showPolicy) {
    return (
      <div className="fixed inset-0 z-50 bg-[var(--color-bg)] overflow-y-auto">
        <PrivacyPolicy onClose={() => setShowPolicy(false)} />
        {/* Sticky accept bar at the bottom of the full policy view */}
        <div className="sticky bottom-0 bg-[var(--color-bg-secondary)] border-t border-[var(--color-border)] p-4">
          <div className="max-w-3xl mx-auto flex items-center justify-between gap-4">
            <button
              onClick={() => setShowPolicy(false)}
              className="text-sm text-[var(--color-text-secondary)] hover:text-[var(--color-text)] transition-colors"
            >
              {t('consent.banner.back')}
            </button>
            <button
              onClick={acceptConsent}
              className="px-6 py-2 bg-brand-500 hover:bg-brand-600 text-white rounded-lg font-medium transition-colors"
            >
              {t('consent.banner.accept')}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="w-full max-w-lg bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-2xl shadow-2xl p-6 space-y-4">
        {/* Header */}
        <div className="flex items-center gap-3">
          <span className="text-2xl">🔒</span>
          <h2 className="text-lg font-semibold text-[var(--color-text)]">
            {t('consent.banner.title')}
          </h2>
        </div>

        {/* Summary */}
        <div className="text-sm text-[var(--color-text-secondary)] space-y-3">
          <p>
            <Trans
              i18nKey="consent.banner.intro"
              components={{
                company: (
                  <a
                    href="https://cenetex.com"
                    className="text-brand-400 hover:text-brand-300 underline"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Cenetex Inc.
                  </a>
                ),
              }}
            />
          </p>

          <div className="space-y-2">
            <ConsentItem
              emoji="👛"
              title={t('consent.banner.items.walletIdentity.title')}
              desc={t('consent.banner.items.walletIdentity.desc')}
            />
            <ConsentItem
              emoji="💬"
              title={t('consent.banner.items.aiConversations.title')}
              desc={t('consent.banner.items.aiConversations.desc')}
            />
            <ConsentItem
              emoji="🔗"
              title={t('consent.banner.items.blockchainData.title')}
              desc={t('consent.banner.items.blockchainData.desc')}
            />
            <ConsentItem
              emoji="📡"
              title={t('consent.banner.items.connectedServices.title')}
              desc={t('consent.banner.items.connectedServices.desc')}
            />
            <ConsentItem
              emoji="🗄️"
              title={t('consent.banner.items.storageRetention.title')}
              desc={t('consent.banner.items.storageRetention.desc')}
            />
          </div>
        </div>

        {/* Actions */}
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3 pt-2">
          <button
            onClick={() => setShowPolicy(true)}
            className="text-sm text-brand-400 hover:text-brand-300 underline transition-colors order-2 sm:order-1"
          >
            {t('consent.banner.readFullPolicy', { version: CURRENT_POLICY_VERSION })}
          </button>
          <div className="flex-1" />
          <button
            onClick={acceptConsent}
            className="px-6 py-2.5 bg-brand-500 hover:bg-brand-600 text-white rounded-lg font-medium transition-colors order-1 sm:order-2"
          >
            {t('consent.banner.acceptDetailed')}
          </button>
        </div>

        {/* Contact */}
        <p className="text-xs text-[var(--color-text-muted)] text-center">
          {t('consent.banner.questions')}{' '}
          <a href="mailto:privacy@cenetex.com" className="underline hover:text-[var(--color-text-secondary)]">
            {t('consent.banner.contactEmail')}
          </a>
        </p>
      </div>
    </div>
  );
}

function ConsentItem({ emoji, title, desc }: { emoji: string; title: string; desc: string }) {
  return (
    <div className="flex items-start gap-2">
      <span className="text-base flex-shrink-0 mt-0.5">{emoji}</span>
      <p>
        <strong className="text-[var(--color-text)]">{title}:</strong>{' '}
        {desc}
      </p>
    </div>
  );
}
