/**
 * Privacy Policy Page
 * Comprehensive privacy policy for the RATi Avatar System.
 * Operator: Cenetex Inc. (https://cenetex.com)
 * Software licensed from: RATi™ Open Software Foundation (https://rati.foundation)
 * Contact: privacy@cenetex.com
 *
 * Policy version: 1.3 (2026-03-08)
 * Aligned with DATA-RETENTION-MATRIX.md and implemented backend controls.
 *
 * DRIFT PREVENTION — the following source files must stay in sync with this
 * privacy policy whenever retention periods or deletion mechanics change:
 *   - docs/DATA-RETENTION-MATRIX.md          (canonical retention matrix)
 *   - packages/admin-api/src/services/audit-log.ts  (AUDIT_TTL_DAYS constant)
 *   - packages/admin-ui/src/components/ConsentBanner.tsx  (consent summary)
 */

import { Trans, useTranslation } from 'react-i18next';

interface PrivacyPolicyProps {
  onClose?: () => void;
}

type CopyItem = {
  titleKey: string;
  descKey: string;
};

type TableRow = {
  dataTypeKey: string;
  retentionKey: string;
};

type SharingRow = {
  providerKey: string;
  dataKey: string;
  purposeKey: string;
  noteKey?: string;
};

const authIdentityItems: CopyItem[] = [
  {
    titleKey: 'consent.policy.authIdentityWalletAddressesTitle',
    descKey: 'consent.policy.authIdentityWalletAddressesDesc',
  },
  {
    titleKey: 'consent.policy.authIdentityEmailAddressesTitle',
    descKey: 'consent.policy.authIdentityEmailAddressesDesc',
  },
  {
    titleKey: 'consent.policy.authIdentitySessionMetadataTitle',
    descKey: 'consent.policy.authIdentitySessionMetadataDesc',
  },
];

const conversationItems: CopyItem[] = [
  {
    titleKey: 'consent.policy.conversationsChatMessagesTitle',
    descKey: 'consent.policy.conversationsChatMessagesDesc',
  },
  {
    titleKey: 'consent.policy.avatarMemoriesTitle',
    descKey: 'consent.policy.avatarMemoriesIntro',
  },
  {
    titleKey: 'consent.policy.canonicalMemoriesTitle',
    descKey: 'consent.policy.canonicalMemoriesDesc',
  },
  {
    titleKey: 'consent.policy.extractedFactsTitle',
    descKey: 'consent.policy.extractedFactsDesc',
  },
  {
    titleKey: 'consent.policy.systemPromptsPersonaDataTitle',
    descKey: 'consent.policy.systemPromptsPersonaDataDesc',
  },
];

const avatarMemoryItems: CopyItem[] = [
  {
    titleKey: 'consent.policy.avatarMemoriesEphemeralTitle',
    descKey: 'consent.policy.avatarMemoriesEphemeralDesc',
  },
  {
    titleKey: 'consent.policy.avatarMemoriesDurableTitle',
    descKey: 'consent.policy.avatarMemoriesDurableDesc',
  },
  {
    titleKey: 'consent.policy.avatarMemoriesArchivalTitle',
    descKey: 'consent.policy.avatarMemoriesArchivalDesc',
  },
];

const contentItems: CopyItem[] = [
  {
    titleKey: 'consent.policy.generatedMediaTitle',
    descKey: 'consent.policy.generatedMediaDesc',
  },
  {
    titleKey: 'consent.policy.contentStoreTitle',
    descKey: 'consent.policy.contentStoreDesc',
  },
];

const auditItems: CopyItem[] = [
  {
    titleKey: 'consent.policy.auditLogsTitle',
    descKey: 'consent.policy.auditLogsDesc',
  },
  {
    titleKey: 'consent.policy.applicationLogsTitle',
    descKey: 'consent.policy.applicationLogsDesc',
  },
  {
    titleKey: 'consent.policy.apiAccessLogsTitle',
    descKey: 'consent.policy.apiAccessLogsDesc',
  },
  {
    titleKey: 'consent.policy.activityRecordsTitle',
    descKey: 'consent.policy.activityRecordsDesc',
  },
];

const localStorageItems: CopyItem[] = [
  {
    titleKey: 'consent.policy.localStorageConsentTitle',
    descKey: 'consent.policy.localStorageConsentDesc',
  },
  {
    titleKey: 'consent.policy.localStorageThemeTitle',
    descKey: 'consent.policy.localStorageThemeDesc',
  },
  {
    titleKey: 'consent.policy.localStorageAuthTitle',
    descKey: 'consent.policy.localStorageAuthDesc',
  },
  {
    titleKey: 'consent.policy.localStorageOAuthTitle',
    descKey: 'consent.policy.localStorageOAuthDesc',
  },
];

const useDataItems = [
  'consent.policy.useDataAuthenticate',
  'consent.policy.useDataConversations',
  'consent.policy.useDataNft',
  'consent.policy.useDataMemories',
  'consent.policy.useDataMedia',
  'consent.policy.useDataAbuse',
  'consent.policy.useDataAudit',
  'consent.policy.useDataReliability',
];

const sharingRows: SharingRow[] = [
  {
    providerKey: 'consent.policy.sharingOpenRouterTitle',
    noteKey: 'consent.policy.sharingOpenRouterNote',
    dataKey: 'consent.policy.sharingOpenRouterData',
    purposeKey: 'consent.policy.sharingOpenRouterPurpose',
  },
  {
    providerKey: 'consent.policy.sharingReplicateTitle',
    dataKey: 'consent.policy.sharingReplicateData',
    purposeKey: 'consent.policy.sharingReplicatePurpose',
  },
  {
    providerKey: 'consent.policy.sharingPrivyTitle',
    dataKey: 'consent.policy.sharingPrivyData',
    purposeKey: 'consent.policy.sharingPrivyPurpose',
  },
  {
    providerKey: 'consent.policy.sharingHeliusTitle',
    dataKey: 'consent.policy.sharingHeliusData',
    purposeKey: 'consent.policy.sharingHeliusPurpose',
  },
  {
    providerKey: 'consent.policy.sharingSocialApisTitle',
    dataKey: 'consent.policy.sharingSocialApisData',
    purposeKey: 'consent.policy.sharingSocialApisPurpose',
  },
  {
    providerKey: 'consent.policy.sharingAwsTitle',
    dataKey: 'consent.policy.sharingAwsData',
    purposeKey: 'consent.policy.sharingAwsPurpose',
  },
];

const retentionRows: TableRow[] = [
  { dataTypeKey: 'consent.policy.retentionSessionRecords', retentionKey: 'consent.policy.retentionSessionValue' },
  { dataTypeKey: 'consent.policy.retentionActivityRecords', retentionKey: 'consent.policy.retentionActivityValue' },
  { dataTypeKey: 'consent.policy.retentionAdminChatMessages', retentionKey: 'consent.policy.retentionAdminChatMessagesValue' },
  { dataTypeKey: 'consent.policy.retentionChannelState', retentionKey: 'consent.policy.retentionChannelStateValue' },
  { dataTypeKey: 'consent.policy.retentionAIMemoryEphemeral', retentionKey: 'consent.policy.retentionAIMemoryEphemeralValue' },
  { dataTypeKey: 'consent.policy.retentionAIMemoryDurable', retentionKey: 'consent.policy.retentionAIMemoryDurableValue' },
  { dataTypeKey: 'consent.policy.retentionAIMemoryArchival', retentionKey: 'consent.policy.retentionAIMemoryArchivalValue' },
  { dataTypeKey: 'consent.policy.retentionCanonicalMemories', retentionKey: 'consent.policy.retentionCanonicalMemoriesValue' },
  { dataTypeKey: 'consent.policy.retentionExtractedFacts', retentionKey: 'consent.policy.retentionExtractedFactsValue' },
  { dataTypeKey: 'consent.policy.retentionContentPosted', retentionKey: 'consent.policy.retentionContentPostedValue' },
  { dataTypeKey: 'consent.policy.retentionContentPending', retentionKey: 'consent.policy.retentionContentPendingValue' },
  { dataTypeKey: 'consent.policy.retentionContentRejected', retentionKey: 'consent.policy.retentionContentRejectedValue' },
  { dataTypeKey: 'consent.policy.retentionAuditLogs', retentionKey: 'consent.policy.retentionAuditLogsValue' },
  { dataTypeKey: 'consent.policy.retentionAppLogsMessage', retentionKey: 'consent.policy.retentionAppLogsMessageValue' },
  { dataTypeKey: 'consent.policy.retentionAppLogsAdmin', retentionKey: 'consent.policy.retentionAppLogsAdminValue' },
  { dataTypeKey: 'consent.policy.retentionMediaTemp', retentionKey: 'consent.policy.retentionMediaTempValue' },
  { dataTypeKey: 'consent.policy.retentionMediaGeneral', retentionKey: 'consent.policy.retentionMediaGeneralValue' },
  { dataTypeKey: 'consent.policy.retentionAccountIdentity', retentionKey: 'consent.policy.retentionAccountIdentityValue' },
  { dataTypeKey: 'consent.policy.retentionConsentRecords', retentionKey: 'consent.policy.retentionConsentRecordsValue' },
  { dataTypeKey: 'consent.policy.retentionAvatarSecrets', retentionKey: 'consent.policy.retentionAvatarSecretsValue' },
];

const securityItems = [
  'consent.policy.securityEncryptedTransit',
  'consent.policy.securityEncryptedAtRest',
  'consent.policy.securitySecretsManager',
  'consent.policy.securityOperationalLogging',
  'consent.policy.securityTelegramWebhook',
  'consent.policy.securityWalletSignatures',
  'consent.policy.securityPartitionIsolation',
  'consent.policy.securityDependencies',
];

const rightsItems: CopyItem[] = [
  {
    titleKey: 'consent.policy.rightsAccessTitle',
    descKey: 'consent.policy.rightsAccessDesc',
  },
  {
    titleKey: 'consent.policy.rightsCorrectionTitle',
    descKey: 'consent.policy.rightsCorrectionDesc',
  },
  {
    titleKey: 'consent.policy.rightsDeletionTitle',
    descKey: 'consent.policy.rightsDeletionDesc',
  },
  {
    titleKey: 'consent.policy.rightsPortabilityTitle',
    descKey: 'consent.policy.rightsPortabilityDesc',
  },
  {
    titleKey: 'consent.policy.rightsWithdrawTitle',
    descKey: 'consent.policy.rightsWithdrawDesc',
  },
];

export function PrivacyPolicy({ onClose }: PrivacyPolicyProps) {
  const { t } = useTranslation();

  const companyLink = (
    <a
      href="https://cenetex.com"
      className="text-brand-400 hover:text-brand-300 underline"
      target="_blank"
      rel="noopener noreferrer"
    >
      Cenetex Inc.
    </a>
  );
  const foundationLink = (
    <a
      href="https://rati.foundation"
      className="text-brand-400 hover:text-brand-300 underline"
      target="_blank"
      rel="noopener noreferrer"
    >
      RATi&#8482; Open Software Foundation
    </a>
  );
  const privacyEmailLink = (
    <a href="mailto:privacy@cenetex.com" className="text-brand-400 hover:text-brand-300 underline">
      privacy@cenetex.com
    </a>
  );
  const cenetexWebsiteLink = (
    <a
      href="https://cenetex.com"
      className="text-brand-400 hover:text-brand-300 underline"
      target="_blank"
      rel="noopener noreferrer"
    >
      cenetex.com
    </a>
  );
  const ratiWebsiteLink = (
    <a
      href="https://rati.foundation"
      className="text-brand-400 hover:text-brand-300 underline"
      target="_blank"
      rel="noopener noreferrer"
    >
      rati.foundation
    </a>
  );

  return (
    <div className="min-h-[100dvh] bg-[var(--color-bg)] text-[var(--color-text)] overflow-y-auto">
      <div className="max-w-3xl mx-auto px-6 py-12">
        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <h1 className="text-3xl font-bold">{t('consent.policy.title')}</h1>
          {onClose && (
            <button
              onClick={onClose}
              className="text-[var(--color-text-secondary)] hover:text-[var(--color-text)] transition-colors text-2xl"
              aria-label={t('consent.policy.closeAriaLabel')}
            >
              ✕
            </button>
          )}
        </div>

        <p className="text-sm text-[var(--color-text-secondary)] mb-8">
          {t('consent.policy.lastUpdated')}
        </p>

        <div className="prose prose-invert max-w-none space-y-8 text-[var(--color-text-secondary)]">
          {/* 1. Overview */}
          <section>
            <h2 className="text-xl font-semibold text-[var(--color-text)] mb-3">
              {t('consent.policy.overviewTitle')}
            </h2>
            <p>
              <Trans
                i18nKey="consent.policy.overviewP1"
                components={{
                  company: companyLink,
                  domain: <strong>swarm.rati.chat</strong>,
                }}
              />
            </p>
            <p className="mt-2">
              <Trans
                i18nKey="consent.policy.overviewP2"
                components={{
                  foundation: foundationLink,
                }}
              />
            </p>
            <p className="mt-2">{t('consent.policy.overviewP3')}</p>
          </section>

          {/* 2. Data We Collect */}
          <section>
            <h2 className="text-xl font-semibold text-[var(--color-text)] mb-3">
              {t('consent.policy.dataCollectionTitle')}
            </h2>

            <h3 className="text-lg font-medium text-[var(--color-text)] mt-4 mb-2">
              {t('consent.policy.authIdentityTitle')}
            </h3>
            <ul className="list-disc pl-6 space-y-1">
              {authIdentityItems.map((item) => (
                <li key={item.titleKey}>
                  <strong>{t(item.titleKey)}</strong> &mdash; {t(item.descKey)}
                </li>
              ))}
            </ul>

            <h3 className="text-lg font-medium text-[var(--color-text)] mt-4 mb-2">
              {t('consent.policy.conversationsTitle')}
            </h3>
            <ul className="list-disc pl-6 space-y-1">
              <li>
                <strong>{t('consent.policy.conversationsChatMessagesTitle')}</strong>{' '}
                &mdash; {t('consent.policy.conversationsChatMessagesDesc')}
              </li>
              <li>
                <strong>{t('consent.policy.avatarMemoriesTitle')}</strong> &mdash;{' '}
                {t('consent.policy.avatarMemoriesIntro')}
                <ul className="list-disc pl-6 mt-1 space-y-1">
                  {avatarMemoryItems.map((item) => (
                    <li key={item.titleKey}>
                      <strong>{t(item.titleKey)}</strong> &mdash; {t(item.descKey)}
                    </li>
                  ))}
                </ul>
              </li>
              {conversationItems.slice(2).map((item) => (
                <li key={item.titleKey}>
                  <strong>{t(item.titleKey)}</strong> &mdash; {t(item.descKey)}
                </li>
              ))}
            </ul>

            <h3 className="text-lg font-medium text-[var(--color-text)] mt-4 mb-2">
              {t('consent.policy.blockchainNftTitle')}
            </h3>
            <ul className="list-disc pl-6 space-y-1">
              <li>
                <strong>{t('consent.policy.nftOwnershipStatusTitle')}</strong> &mdash; {t('consent.policy.nftOwnershipStatusDesc')}
              </li>
              <li>
                <strong>{t('consent.policy.generatedWalletKeypairsTitle')}</strong> &mdash; {t('consent.policy.generatedWalletKeypairsDesc')}
              </li>
            </ul>

            <h3 className="text-lg font-medium text-[var(--color-text)] mt-4 mb-2">
              {t('consent.policy.contentMediaTitle')}
            </h3>
            <ul className="list-disc pl-6 space-y-1">
              {contentItems.map((item) => (
                <li key={item.titleKey}>
                  <strong>{t(item.titleKey)}</strong> &mdash; {t(item.descKey)}
                </li>
              ))}
            </ul>

            <h3 className="text-lg font-medium text-[var(--color-text)] mt-4 mb-2">
              {t('consent.policy.auditLogsTitle')}
            </h3>
            <ul className="list-disc pl-6 space-y-1">
              {auditItems.map((item) => (
                <li key={item.titleKey}>
                  <strong>{t(item.titleKey)}</strong> &mdash; {t(item.descKey)}
                </li>
              ))}
            </ul>

            <h3 className="text-lg font-medium text-[var(--color-text)] mt-4 mb-2">
              {t('consent.policy.localStorageTitle')}
            </h3>
            <ul className="list-disc pl-6 space-y-1">
              {localStorageItems.map((item) => (
                <li key={item.titleKey}>
                  <strong>{t(item.titleKey)}</strong> &mdash; {t(item.descKey)}
                </li>
              ))}
            </ul>
          </section>

          {/* 3. How We Use Your Data */}
          <section>
            <h2 className="text-xl font-semibold text-[var(--color-text)] mb-3">
              {t('consent.policy.useDataTitle')}
            </h2>
            <ul className="list-disc pl-6 space-y-1">
              {useDataItems.map((key) => (
                <li key={key}>{t(key)}</li>
              ))}
            </ul>
          </section>

          {/* 4. Third-Party Data Sharing */}
          <section>
            <h2 className="text-xl font-semibold text-[var(--color-text)] mb-3">
              {t('consent.policy.sharingTitle')}
            </h2>
            <p className="mb-3">{t('consent.policy.sharingIntro')}</p>

            <div className="overflow-x-auto">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="border-b border-[var(--color-border)]">
                    <th className="text-left py-2 pr-4 font-medium text-[var(--color-text)]">
                      {t('consent.policy.sharingProvider')}
                    </th>
                    <th className="text-left py-2 pr-4 font-medium text-[var(--color-text)]">
                      {t('consent.policy.sharingDataShared')}
                    </th>
                    <th className="text-left py-2 font-medium text-[var(--color-text)]">
                      {t('consent.policy.sharingPurpose')}
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--color-border)]">
                  {sharingRows.map((row) => (
                    <tr key={row.providerKey}>
                      <td className="py-2 pr-4 font-medium">
                        {t(row.providerKey)}
                        {row.noteKey && (
                          <>
                            <br />
                            <span className="text-xs font-normal">{t(row.noteKey)}</span>
                          </>
                        )}
                      </td>
                      <td className="py-2 pr-4">{t(row.dataKey)}</td>
                      <td className="py-2">{t(row.purposeKey)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <p className="mt-3 text-sm">
              {t('consent.policy.sharingNoSell1')} {t('consent.policy.sharingNoSell2')}{' '}
              {t('consent.policy.sharingNoSell3')}
            </p>
          </section>

          {/* 5. Data Retention */}
          <section>
            <h2 className="text-xl font-semibold text-[var(--color-text)] mb-3">
              {t('consent.policy.retentionTitle')}
            </h2>
            <p className="mb-3">{t('consent.policy.retentionIntro')}</p>
            <div className="overflow-x-auto">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="border-b border-[var(--color-border)]">
                    <th className="text-left py-2 pr-4 font-medium text-[var(--color-text)]">
                      {t('consent.policy.retentionDataType')}
                    </th>
                    <th className="text-left py-2 font-medium text-[var(--color-text)]">
                      {t('consent.policy.retentionRetention')}
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--color-border)]">
                  {retentionRows.map((row) => (
                    <tr key={row.dataTypeKey}>
                      <td className="py-2 pr-4">{t(row.dataTypeKey)}</td>
                      <td className="py-2">{t(row.retentionKey)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {/* 6. Data Security */}
          <section>
            <h2 className="text-xl font-semibold text-[var(--color-text)] mb-3">
              {t('consent.policy.securityTitle')}
            </h2>
            <ul className="list-disc pl-6 space-y-1">
              {securityItems.map((key) => (
                <li key={key}>{t(key)}</li>
              ))}
            </ul>
          </section>

          {/* 7. Your Rights */}
          <section>
            <h2 className="text-xl font-semibold text-[var(--color-text)] mb-3">
              {t('consent.policy.rightsTitle')}
            </h2>
            <p className="mb-3">{t('consent.policy.rightsIntro')}</p>
            <ul className="list-disc pl-6 space-y-1">
              {rightsItems.map((item) => (
                <li key={item.titleKey}>
                  <strong>{t(item.titleKey)}</strong> &mdash; {t(item.descKey)}
                </li>
              ))}
            </ul>
            <p className="mt-3">
              <Trans
                i18nKey="consent.policy.rightsContact"
                components={{
                  email: privacyEmailLink,
                }}
              />
            </p>
          </section>

          {/* 8. Cookies & Local Storage */}
          <section>
            <h2 className="text-xl font-semibold text-[var(--color-text)] mb-3">
              {t('consent.policy.cookiesTitle')}
            </h2>
            <p className="mb-3">{t('consent.policy.cookiesIntro')}</p>
            <ul className="list-disc pl-6 space-y-1">
              {[
                'consent.policy.cookiesConsentTitle',
                'consent.policy.cookiesThemeTitle',
                'consent.policy.cookiesAuthTitle',
              ].map((key) => (
                <li key={key}>
                  <strong>{t(key)}</strong> &mdash; {t(key.replace('Title', 'Desc'))}
                </li>
              ))}
            </ul>
            <p className="mt-2">{t('consent.policy.cookiesOutro')}</p>
          </section>

          {/* 9. AI Processing Disclosure */}
          <section>
            <h2 className="text-xl font-semibold text-[var(--color-text)] mb-3">
              {t('consent.policy.aiDisclosureTitle')}
            </h2>
            <p>{t('consent.policy.aiDisclosureP1')}</p>
            <p className="mt-2">{t('consent.policy.aiDisclosureP2')}</p>
          </section>

          {/* 10. Children */}
          <section>
            <h2 className="text-xl font-semibold text-[var(--color-text)] mb-3">
              {t('consent.policy.childrenTitle')}
            </h2>
            <p>
              <Trans
                i18nKey="consent.policy.childrenP1"
                components={{
                  email: privacyEmailLink,
                }}
              />
            </p>
          </section>

          {/* 11. Changes */}
          <section>
            <h2 className="text-xl font-semibold text-[var(--color-text)] mb-3">
              {t('consent.policy.changesTitle')}
            </h2>
            <p>{t('consent.policy.changesP1')}</p>
          </section>

          {/* 12. Contact */}
          <section>
            <h2 className="text-xl font-semibold text-[var(--color-text)] mb-3">
              {t('consent.policy.contactTitle')}
            </h2>
            <p>{t('consent.policy.contactIntro')}</p>
            <div className="mt-3 space-y-2 text-sm">
              <p className="font-medium text-[var(--color-text)]">
                {t('consent.policy.contactDataController')}
              </p>
              <p>
                {t('consent.policy.contactEmailLabel')}{' '}
                <a href="mailto:privacy@cenetex.com" className="text-brand-400 hover:text-brand-300 underline">
                  privacy@cenetex.com
                </a>
              </p>
              <p>
                {t('consent.policy.contactWebLabel')}{' '}
                <a
                  href="https://cenetex.com"
                  className="text-brand-400 hover:text-brand-300 underline"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  cenetex.com
                </a>
              </p>
            </div>
            <div className="mt-4 space-y-2 text-sm">
              <p className="font-medium text-[var(--color-text)]">
                {t('consent.policy.contactLicensor')}
              </p>
              <p>
                {t('consent.policy.contactLicensorWebLabel')}{' '}
                <a
                  href="https://rati.foundation"
                  className="text-brand-400 hover:text-brand-300 underline"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  rati.foundation
                </a>
              </p>
            </div>
          </section>
        </div>

        {/* Footer */}
        <div className="mt-12 pt-8 border-t border-[var(--color-border)] text-center text-sm text-[var(--color-text-muted)] space-y-1">
          <p>{t('consent.policy.footerPolicy')}</p>
          <p>
            <Trans
              i18nKey="consent.policy.footerOperatedBy"
              components={{
                company: cenetexWebsiteLink,
              }}
            />{' '}
            &middot;{' '}
            <Trans
              i18nKey="consent.policy.footerLicensedFrom"
              components={{
                foundation: ratiWebsiteLink,
              }}
            />
          </p>
        </div>
      </div>
    </div>
  );
}
