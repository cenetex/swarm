/**
 * Privacy Policy Page
 * Comprehensive privacy policy for the RATi Avatar System.
 * Operator: Cenetex Inc. (https://cenetex.com)
 * Software licensed from: RATi™ Open Software Foundation (https://rati.foundation)
 * Contact: privacy@cenetex.com
 *
 * Policy version: 1.4 (2026-03-21)
 * Aligned with DATA-RETENTION-MATRIX.md and implemented backend controls.
 *
 * Structure (v1.4): Merged local-storage into §2, absorbed AI-processing into §4,
 * trimmed security to prose, added jurisdiction + breach notification.
 *
 * DRIFT PREVENTION — the following source files must stay in sync with this
 * privacy policy whenever retention periods or deletion mechanics change:
 *   - docs/DATA-RETENTION-MATRIX.md          (canonical retention matrix)
 *   - packages/admin-api/src/services/audit-log.ts  (AUDIT_TTL_DAYS constant)
 *   - packages/admin-ui/src/components/ConsentBanner.tsx  (consent summary)
 */

import { useTranslation, Trans } from 'react-i18next';

interface PrivacyPolicyProps {
  onClose?: () => void;
}

const link = 'text-brand-400 hover:text-brand-300 underline';
const h2 = 'text-xl font-semibold text-[var(--color-text)] mb-3';
const h3 = 'text-lg font-medium text-[var(--color-text)] mt-4 mb-2';
const ul = 'list-disc pl-6 space-y-1';
const th = 'text-left py-2 pr-4 font-medium text-[var(--color-text)]';

export function PrivacyPolicy({ onClose }: PrivacyPolicyProps) {
  const { t } = useTranslation();
  return (
    <div className="min-h-[100dvh] bg-[var(--color-bg)] text-[var(--color-text)] overflow-y-auto">
      <div className="max-w-3xl mx-auto px-6 py-12">
        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <h1 className="text-3xl font-bold">{t('privacy.title')}</h1>
          {onClose && (
            <button
              onClick={onClose}
              className="text-[var(--color-text-secondary)] hover:text-[var(--color-text)] transition-colors text-2xl"
              aria-label={t('common.close')}
            >
              ✕
            </button>
          )}
        </div>

        <p className="text-sm text-[var(--color-text-secondary)] mb-8">
          {t('privacy.lastUpdated')}
        </p>

        <div className="prose prose-invert max-w-none space-y-8 text-[var(--color-text-secondary)]">

          {/* 1. Overview */}
          <section>
            <h2 className={h2}>{t('privacy.s1Title')}</h2>
            <p>
              <Trans i18nKey="privacy.s1p1" components={{ cenetex: <a href="https://cenetex.com" className={link} target="_blank" rel="noopener noreferrer" /> }} />
            </p>
            <p className="mt-2">
              <Trans i18nKey="privacy.s1p2" components={{ rati: <a href="https://rati.foundation" className={link} target="_blank" rel="noopener noreferrer" /> }} />
            </p>
          </section>

          {/* 2. Data We Collect (inline retention removed — see §5 table) */}
          <section>
            <h2 className={h2}>{t('privacy.s2Title')}</h2>

            <h3 className={h3}>{t('privacy.s2_1Title')}</h3>
            <ul className={ul}>
              <li><Trans i18nKey="privacy.s2_1_wallet" components={{ strong: <strong /> }} /></li>
              <li><Trans i18nKey="privacy.s2_1_email" components={{ strong: <strong /> }} /></li>
              <li><Trans i18nKey="privacy.s2_1_session" components={{ strong: <strong /> }} /></li>
            </ul>

            <h3 className={h3}>{t('privacy.s2_2Title')}</h3>
            <ul className={ul}>
              <li><Trans i18nKey="privacy.s2_2_chat" components={{ strong: <strong /> }} /></li>
              <li>
                <Trans i18nKey="privacy.s2_2_memories" components={{ strong: <strong /> }} />
                <ul className="list-disc pl-6 mt-1 space-y-1">
                  <li><Trans i18nKey="privacy.s2_2_ephemeral" components={{ strong: <strong /> }} /></li>
                  <li><Trans i18nKey="privacy.s2_2_durable" components={{ strong: <strong /> }} /></li>
                  <li><Trans i18nKey="privacy.s2_2_archival" components={{ strong: <strong /> }} /></li>
                </ul>
              </li>
              <li><Trans i18nKey="privacy.s2_2_prompts" components={{ strong: <strong /> }} /></li>
            </ul>

            <h3 className={h3}>{t('privacy.s2_3Title')}</h3>
            <ul className={ul}>
              <li><Trans i18nKey="privacy.s2_3_nft" components={{ strong: <strong /> }} /></li>
              <li><Trans i18nKey="privacy.s2_3_keys" components={{ strong: <strong /> }} /></li>
            </ul>

            <h3 className={h3}>{t('privacy.s2_4Title')}</h3>
            <ul className={ul}>
              <li><Trans i18nKey="privacy.s2_4_media" components={{ strong: <strong /> }} /></li>
              <li><Trans i18nKey="privacy.s2_4_content" components={{ strong: <strong /> }} /></li>
            </ul>

            <h3 className={h3}>{t('privacy.s2_5Title')}</h3>
            <ul className={ul}>
              <li><Trans i18nKey="privacy.s2_5_audit" components={{ strong: <strong /> }} /></li>
              <li><Trans i18nKey="privacy.s2_5_app" components={{ strong: <strong /> }} /></li>
              <li><Trans i18nKey="privacy.s2_5_api" components={{ strong: <strong /> }} /></li>
            </ul>

            {/* Local storage merged here from old §8 */}
            <h3 className={h3}>{t('privacy.s2_6Title')}</h3>
            <p className="mb-2">{t('privacy.s2_6_noCookies')}</p>
            <ul className={ul}>
              <li><Trans i18nKey="privacy.s2_6_consent" components={{ strong: <strong /> }} /></li>
              <li><Trans i18nKey="privacy.s2_6_theme" components={{ strong: <strong /> }} /></li>
              <li><Trans i18nKey="privacy.s2_6_auth" components={{ strong: <strong /> }} /></li>
            </ul>
            <p className="mt-2">{t('privacy.s2_6_clear')}</p>
          </section>

          {/* 3. How We Use Your Data */}
          <section>
            <h2 className={h2}>{t('privacy.s3Title')}</h2>
            <ul className={ul}>
              <li>{t('privacy.s3_auth')}</li>
              <li>{t('privacy.s3_chat')}</li>
              <li>{t('privacy.s3_nft')}</li>
              <li>{t('privacy.s3_memories')}</li>
              <li>{t('privacy.s3_media')}</li>
              <li>{t('privacy.s3_abuse')}</li>
              <li>{t('privacy.s3_audit')}</li>
              <li>{t('privacy.s3_debug')}</li>
            </ul>
          </section>

          {/* 4. Third-Party Data Sharing & AI Processing (merged old §4 + §9) */}
          <section>
            <h2 className={h2}>{t('privacy.s4Title')}</h2>
            <p className="mb-3">{t('privacy.s4Intro')}</p>

            <div className="overflow-x-auto">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="border-b border-[var(--color-border)]">
                    <th className={th}>{t('privacy.thProvider')}</th>
                    <th className={th}>{t('privacy.thData')}</th>
                    <th className="text-left py-2 font-medium text-[var(--color-text)]">{t('privacy.thPurpose')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--color-border)]">
                  <tr>
                    <td className="py-2 pr-4 font-medium">OpenRouter<br/><span className="text-xs font-normal">{t('privacy.openrouterNote')}</span></td>
                    <td className="py-2 pr-4">{t('privacy.openrouterData')}</td>
                    <td className="py-2">{t('privacy.openrouterPurpose')}</td>
                  </tr>
                  <tr>
                    <td className="py-2 pr-4 font-medium">Replicate</td>
                    <td className="py-2 pr-4">{t('privacy.replicateData')}</td>
                    <td className="py-2">{t('privacy.replicatePurpose')}</td>
                  </tr>
                  <tr>
                    <td className="py-2 pr-4 font-medium">Privy</td>
                    <td className="py-2 pr-4">{t('privacy.privyData')}</td>
                    <td className="py-2">{t('privacy.privyPurpose')}</td>
                  </tr>
                  <tr>
                    <td className="py-2 pr-4 font-medium">Helius / Solana RPC</td>
                    <td className="py-2 pr-4">{t('privacy.heliusData')}</td>
                    <td className="py-2">{t('privacy.heliusPurpose')}</td>
                  </tr>
                  <tr>
                    <td className="py-2 pr-4 font-medium">Telegram / X (Twitter) / Discord</td>
                    <td className="py-2 pr-4">{t('privacy.platformsData')}</td>
                    <td className="py-2">{t('privacy.platformsPurpose')}</td>
                  </tr>
                  <tr>
                    <td className="py-2 pr-4 font-medium">AWS</td>
                    <td className="py-2 pr-4">{t('privacy.awsData')}</td>
                    <td className="py-2">{t('privacy.awsPurpose')}</td>
                  </tr>
                </tbody>
              </table>
            </div>

            <p className="mt-3 text-sm">{t('privacy.s4NoSell')}</p>
          </section>

          {/* 5. Data Retention (single source of truth for all periods) */}
          <section>
            <h2 className={h2}>{t('privacy.s5Title')}</h2>
            <p className="mb-3">{t('privacy.s5Intro')}</p>
            <div className="overflow-x-auto">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="border-b border-[var(--color-border)]">
                    <th className={th}>{t('privacy.thDataType')}</th>
                    <th className="text-left py-2 font-medium text-[var(--color-text)]">{t('privacy.thRetention')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--color-border)]">
                  {[
                    ['sessions', '24h'],
                    ['activity', '24h'],
                    ['adminChat', '24hConfigurable'],
                    ['channelState', '90d'],
                    ['memEphemeral', '1d'],
                    ['memDurable', '90d'],
                    ['memArchival', 'untilDeletion'],
                    ['canonical', '30d'],
                    ['facts', '90d'],
                    ['contentPosted', '90d'],
                    ['contentPending', '30d'],
                    ['contentRejected', '7d'],
                    ['auditLogs', '365d'],
                    ['appLogsMsgProc', '30dCW'],
                    ['appLogsOther', '14dCW'],
                    ['mediaTemp', '1dS3'],
                    ['mediaGeneral', '30dTiered'],
                    ['account', 'untilAccountDeletion'],
                    ['consentRecords', 'untilAccountDeletion'],
                    ['secrets', 'untilAvatarDeletion'],
                  ].map(([dataKey, retKey]) => (
                    <tr key={dataKey}>
                      <td className="py-2 pr-4">{t(`privacy.retention.${dataKey}`)}</td>
                      <td className="py-2">{t(`privacy.retention.${retKey}`)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {/* 6. Data Security (trimmed to prose) */}
          <section>
            <h2 className={h2}>{t('privacy.s6Title')}</h2>
            <p>{t('privacy.s6p1')}</p>
            <p className="mt-2">{t('privacy.s6p2')}</p>
          </section>

          {/* 7. Your Rights (added breach notification) */}
          <section>
            <h2 className={h2}>{t('privacy.s7Title')}</h2>
            <p className="mb-3">{t('privacy.s7Intro')}</p>
            <ul className={ul}>
              <li><Trans i18nKey="privacy.s7_access" components={{ strong: <strong /> }} /></li>
              <li><Trans i18nKey="privacy.s7_correction" components={{ strong: <strong /> }} /></li>
              <li><Trans i18nKey="privacy.s7_deletion" components={{ strong: <strong /> }} /></li>
              <li><Trans i18nKey="privacy.s7_portability" components={{ strong: <strong /> }} /></li>
              <li><Trans i18nKey="privacy.s7_withdraw" components={{ strong: <strong /> }} /></li>
            </ul>
            <p className="mt-3">
              <Trans i18nKey="privacy.s7Contact" components={{ email: <a href="mailto:privacy@cenetex.com" className={link} /> }} />
            </p>
            <p className="mt-3">{t('privacy.s7Breach')}</p>
          </section>

          {/* 8. Children's Privacy */}
          <section>
            <h2 className={h2}>{t('privacy.s8Title')}</h2>
            <p>
              <Trans i18nKey="privacy.s8p1" components={{ email: <a href="mailto:privacy@cenetex.com" className={link} /> }} />
            </p>
          </section>

          {/* 9. International Transfers & Jurisdiction (NEW) */}
          <section>
            <h2 className={h2}>{t('privacy.s9Title')}</h2>
            <p>{t('privacy.s9p1')}</p>
            <p className="mt-2">{t('privacy.s9p2')}</p>
          </section>

          {/* 10. Changes to This Policy */}
          <section>
            <h2 className={h2}>{t('privacy.s10Title')}</h2>
            <p>{t('privacy.s10p1')}</p>
          </section>

          {/* 11. Contact */}
          <section>
            <h2 className={h2}>{t('privacy.s11Title')}</h2>
            <p>{t('privacy.s11Intro')}</p>
            <div className="mt-3 space-y-2 text-sm">
              <p className="font-medium text-[var(--color-text)]">{t('privacy.s11Controller')}</p>
              <p>
                {t('privacy.s11Email')}{' '}
                <a href="mailto:privacy@cenetex.com" className={link}>privacy@cenetex.com</a>
              </p>
              <p>
                {t('privacy.s11Web')}{' '}
                <a href="https://cenetex.com" className={link} target="_blank" rel="noopener noreferrer">cenetex.com</a>
              </p>
            </div>
            <div className="mt-4 space-y-2 text-sm">
              <p className="font-medium text-[var(--color-text)]">{t('privacy.s11Licensor')}</p>
              <p>
                {t('privacy.s11Web')}{' '}
                <a href="https://rati.foundation" className={link} target="_blank" rel="noopener noreferrer">rati.foundation</a>
              </p>
            </div>
          </section>
        </div>

        {/* Footer */}
        <div className="mt-12 pt-8 border-t border-[var(--color-border)] text-center text-sm text-[var(--color-text-muted)] space-y-1">
          <p>{t('privacy.footer')}</p>
          <p>
            <Trans
              i18nKey="privacy.footerOperator"
              components={{
                cenetex: <a href="https://cenetex.com" className="underline hover:text-[var(--color-text-secondary)]" target="_blank" rel="noopener noreferrer" />,
                rati: <a href="https://rati.foundation" className="underline hover:text-[var(--color-text-secondary)]" target="_blank" rel="noopener noreferrer" />,
              }}
            />
          </p>
        </div>
      </div>
    </div>
  );
}
