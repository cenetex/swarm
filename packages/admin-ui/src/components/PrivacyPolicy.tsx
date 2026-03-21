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

import { useTranslation } from 'react-i18next';

interface PrivacyPolicyProps {
  onClose?: () => void;
}

export function PrivacyPolicy({ onClose }: PrivacyPolicyProps) {
  const { t } = useTranslation();
  return (
    <div className="min-h-[100dvh] bg-[var(--color-bg)] text-[var(--color-text)] overflow-y-auto">
      <div className="max-w-3xl mx-auto px-6 py-12">
        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <h1 className="text-3xl font-bold">{t('consent.privacyPolicyTitle')}</h1>
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
          Last updated: March 8, 2026 &middot; Policy version 1.3
        </p>

        <div className="prose prose-invert max-w-none space-y-8 text-[var(--color-text-secondary)]">
          {/* 1. Overview */}
          <section>
            <h2 className="text-xl font-semibold text-[var(--color-text)] mb-3">1. Overview</h2>
            <p>
              <a href="https://cenetex.com" className="text-brand-400 hover:text-brand-300 underline" target="_blank" rel="noopener noreferrer">Cenetex Inc.</a>{' '}
              (&quot;we,&quot; &quot;us,&quot; or &quot;our&quot;) operates the RATi Avatar System
              (&quot;RATi OS&quot;) at <strong>swarm.rati.chat</strong>, which lets users
              create and interact with AI avatars on the Solana blockchain.
            </p>
            <p className="mt-2">
              RATi OS is built on open-source software licensed from the{' '}
              <a href="https://rati.foundation" className="text-brand-400 hover:text-brand-300 underline" target="_blank" rel="noopener noreferrer">RATi&#8482; Open Software Foundation</a>,
              a not-for-profit organization. Cenetex Inc. is the data controller
              responsible for your personal data as described in this policy.
            </p>
            <p className="mt-2">
              This Privacy Policy explains what data we collect, how we use it,
              who we share it with, and your rights.
            </p>
          </section>

          {/* 2. Data We Collect */}
          <section>
            <h2 className="text-xl font-semibold text-[var(--color-text)] mb-3">2. Data We Collect</h2>

            <h3 className="text-lg font-medium text-[var(--color-text)] mt-4 mb-2">
              2.1 Authentication &amp; Identity
            </h3>
            <ul className="list-disc pl-6 space-y-1">
              <li><strong>Wallet addresses</strong> &mdash; your Solana public key(s), collected on every login.</li>
              <li><strong>Email addresses</strong> &mdash; if you sign in via Privy (email/social).</li>
              <li><strong>Session metadata</strong> &mdash; IP address, User-Agent, and timestamps stored in session records (24-hour TTL).</li>
            </ul>

            <h3 className="text-lg font-medium text-[var(--color-text)] mt-4 mb-2">
              2.2 Conversations &amp; AI Interactions
            </h3>
            <ul className="list-disc pl-6 space-y-1">
              <li><strong>Chat messages</strong> &mdash; messages you send to avatars. Admin chat sessions are stored in DynamoDB with a default 24-hour TTL.</li>
              <li>
                <strong>Avatar memories</strong> &mdash; AI-generated summaries of interactions, stored across three tiers:
                <ul className="list-disc pl-6 mt-1 space-y-1">
                  <li><strong>Ephemeral</strong> &mdash; session-scoped, auto-deleted after 1 day.</li>
                  <li><strong>Durable</strong> &mdash; long-term storage, auto-deleted after 90 days.</li>
                  <li><strong>Archival</strong> &mdash; permanent, summary-only (no TTL; retained until avatar deletion).</li>
                </ul>
              </li>
              <li><strong>Canonical memories</strong> &mdash; consolidated memory records with a default 30-day TTL.</li>
              <li><strong>Extracted facts</strong> &mdash; structured facts derived from conversations, auto-deleted after 90 days.</li>
              <li><strong>System prompts &amp; persona data</strong> &mdash; avatar configuration you create or edit.</li>
            </ul>

            <h3 className="text-lg font-medium text-[var(--color-text)] mt-4 mb-2">
              2.3 Blockchain &amp; NFT Data
            </h3>
            <ul className="list-disc pl-6 space-y-1">
              <li><strong>NFT ownership status</strong> &mdash; we check whether your wallet holds Orb collection NFTs to determine feature access.</li>
              <li><strong>Generated wallet keypairs</strong> &mdash; if an avatar has an auto-generated wallet, the private key is stored encrypted in AWS Secrets Manager (KMS).</li>
            </ul>

            <h3 className="text-lg font-medium text-[var(--color-text)] mt-4 mb-2">
              2.4 Content &amp; Media
            </h3>
            <ul className="list-disc pl-6 space-y-1">
              <li><strong>Generated media</strong> &mdash; images, video, and audio created by avatars. Temporary media is deleted after 1 day; other media transitions to cost-optimized storage after 30 days.</li>
              <li><strong>Content store</strong> &mdash; drafted/posted/rejected social media content. Posted content is retained for 90 days, rejected content for 7 days, and pending content for 30 days.</li>
            </ul>

            <h3 className="text-lg font-medium text-[var(--color-text)] mt-4 mb-2">
              2.5 Audit &amp; Operational Logs
            </h3>
            <ul className="list-disc pl-6 space-y-1">
              <li><strong>Audit logs</strong> &mdash; records of administrative actions (avatar creation, updates, secret changes, entitlement changes), retained for 365 days (1 year) in DynamoDB.</li>
              <li><strong>Application logs</strong> &mdash; structured logs in AWS CloudWatch. Message processing logs are retained for 30 days; admin and other service logs are retained for 14 days. Operational logs are intended to store metadata rather than message content, but troubleshooting reports or feedback you submit may include text you provide.</li>
              <li><strong>API access logs</strong> &mdash; API Gateway request logs, retained for 30 days.</li>
              <li><strong>Activity records</strong> &mdash; avatar activity tracking events, auto-deleted after 24 hours.</li>
            </ul>

            <h3 className="text-lg font-medium text-[var(--color-text)] mt-4 mb-2">
              2.6 Local Storage (Browser)
            </h3>
            <ul className="list-disc pl-6 space-y-1">
              <li><strong>swarm-consent</strong> &mdash; your privacy policy acceptance status and version.</li>
              <li><strong>swarm-theme</strong> &mdash; UI theme preference.</li>
              <li>Authentication state (wallet/Privy session tokens).</li>
              <li>OAuth flow data (temporary, for cross-tab communication).</li>
            </ul>
          </section>

          {/* 3. How We Use Your Data */}
          <section>
            <h2 className="text-xl font-semibold text-[var(--color-text)] mb-3">3. How We Use Your Data</h2>
            <ul className="list-disc pl-6 space-y-1">
              <li>Authenticate your identity and manage sessions.</li>
              <li>Deliver AI avatar conversations and maintain chat context.</li>
              <li>Check NFT ownership for gating features.</li>
              <li>Generate and store AI memories across retention tiers.</li>
              <li>Generate images, video, and audio content via AI models.</li>
              <li>Detect abuse and enforce rate limits.</li>
              <li>Record audit trails for administrative actions.</li>
              <li>Debug issues and improve platform reliability.</li>
            </ul>
          </section>

          {/* 4. Third-Party Data Sharing */}
          <section>
            <h2 className="text-xl font-semibold text-[var(--color-text)] mb-3">4. Third-Party Data Sharing</h2>
            <p className="mb-3">
              We share data with the following third-party services as necessary to operate the platform:
            </p>

            <div className="overflow-x-auto">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="border-b border-[var(--color-border)]">
                    <th className="text-left py-2 pr-4 font-medium text-[var(--color-text)]">Provider</th>
                    <th className="text-left py-2 pr-4 font-medium text-[var(--color-text)]">Data Shared</th>
                    <th className="text-left py-2 font-medium text-[var(--color-text)]">Purpose</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--color-border)]">
                  <tr>
                    <td className="py-2 pr-4 font-medium">OpenRouter<br/><span className="text-xs font-normal">(routes to Anthropic Claude, OpenAI GPT-4, and other models)</span></td>
                    <td className="py-2 pr-4">Conversation history (context window), system prompts, avatar persona</td>
                    <td className="py-2">AI text response generation</td>
                  </tr>
                  <tr>
                    <td className="py-2 pr-4 font-medium">Replicate</td>
                    <td className="py-2 pr-4">AI model prompts, input media</td>
                    <td className="py-2">Image, video, and audio generation</td>
                  </tr>
                  <tr>
                    <td className="py-2 pr-4 font-medium">Privy</td>
                    <td className="py-2 pr-4">Access tokens, linked account data</td>
                    <td className="py-2">Email/social authentication</td>
                  </tr>
                  <tr>
                    <td className="py-2 pr-4 font-medium">Helius / Solana RPC</td>
                    <td className="py-2 pr-4">Wallet public keys</td>
                    <td className="py-2">NFT ownership verification, on-chain queries</td>
                  </tr>
                  <tr>
                    <td className="py-2 pr-4 font-medium">Telegram / X (Twitter) / Discord APIs</td>
                    <td className="py-2 pr-4">Message content, media</td>
                    <td className="py-2">Platform integrations (only if you connect them)</td>
                  </tr>
                  <tr>
                    <td className="py-2 pr-4 font-medium">AWS</td>
                    <td className="py-2 pr-4">All backend data</td>
                    <td className="py-2">Infrastructure (DynamoDB, Lambda, S3, CloudWatch, Secrets Manager, SQS)</td>
                  </tr>
                </tbody>
              </table>
            </div>

            <p className="mt-3 text-sm">
              We do not sell your data. We do not use your conversations to train our own AI models.
              Third-party AI providers may process your data according to their own privacy policies.
            </p>
          </section>

          {/* 5. Data Retention */}
          <section>
            <h2 className="text-xl font-semibold text-[var(--color-text)] mb-3">5. Data Retention</h2>
            <p className="mb-3">
              Retention periods are enforced through a combination of automatic TTL-based deletion in DynamoDB, lifecycle policies in S3 and CloudWatch, and explicit deletion workflows. Data that expires automatically is marked &quot;auto-deleted&quot; below. Account records, identity links, consent records, and archival memories do not carry a TTL and are retained until you delete your account or avatar, or submit a deletion request.
            </p>
            <div className="overflow-x-auto">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="border-b border-[var(--color-border)]">
                    <th className="text-left py-2 pr-4 font-medium text-[var(--color-text)]">Data Type</th>
                    <th className="text-left py-2 font-medium text-[var(--color-text)]">Retention</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--color-border)]">
                  <tr><td className="py-2 pr-4">Session records</td><td className="py-2">24 hours (auto-deleted)</td></tr>
                  <tr><td className="py-2 pr-4">Activity records</td><td className="py-2">24 hours (auto-deleted)</td></tr>
                  <tr><td className="py-2 pr-4">Admin chat messages</td><td className="py-2">24 hours (auto-deleted, configurable)</td></tr>
                  <tr><td className="py-2 pr-4">Channel state</td><td className="py-2">90 days (auto-deleted)</td></tr>
                  <tr><td className="py-2 pr-4">AI memory &mdash; Ephemeral</td><td className="py-2">1 day (auto-deleted)</td></tr>
                  <tr><td className="py-2 pr-4">AI memory &mdash; Durable</td><td className="py-2">90 days (auto-deleted)</td></tr>
                  <tr><td className="py-2 pr-4">AI memory &mdash; Archival</td><td className="py-2">Unlimited (until avatar deletion)</td></tr>
                  <tr><td className="py-2 pr-4">Canonical memories</td><td className="py-2">30 days (auto-deleted)</td></tr>
                  <tr><td className="py-2 pr-4">Extracted facts</td><td className="py-2">90 days (auto-deleted)</td></tr>
                  <tr><td className="py-2 pr-4">Content store (posted)</td><td className="py-2">90 days (auto-deleted)</td></tr>
                  <tr><td className="py-2 pr-4">Content store (pending)</td><td className="py-2">30 days (auto-deleted)</td></tr>
                  <tr><td className="py-2 pr-4">Content store (rejected)</td><td className="py-2">7 days (auto-deleted)</td></tr>
                  <tr><td className="py-2 pr-4">Audit logs</td><td className="py-2">365 days / 1 year (auto-deleted)</td></tr>
                  <tr><td className="py-2 pr-4">Application logs (message processing)</td><td className="py-2">30 days (CloudWatch retention)</td></tr>
                  <tr><td className="py-2 pr-4">Application logs (admin, Discord, other)</td><td className="py-2">14 days (CloudWatch retention)</td></tr>
                  <tr><td className="py-2 pr-4">Media assets (temporary)</td><td className="py-2">1 day (S3 lifecycle)</td></tr>
                  <tr><td className="py-2 pr-4">Media assets (general)</td><td className="py-2">30 days then tiered storage</td></tr>
                  <tr><td className="py-2 pr-4">Account &amp; identity records</td><td className="py-2">Until account deletion (no TTL)</td></tr>
                  <tr><td className="py-2 pr-4">Consent records</td><td className="py-2">Until account deletion (no TTL)</td></tr>
                  <tr><td className="py-2 pr-4">Avatar secrets (API keys)</td><td className="py-2">Until avatar deletion (no TTL)</td></tr>
                </tbody>
              </table>
            </div>
          </section>

          {/* 6. Data Security */}
          <section>
            <h2 className="text-xl font-semibold text-[var(--color-text)] mb-3">6. Data Security</h2>
            <ul className="list-disc pl-6 space-y-1">
              <li>All data in transit is encrypted via TLS (HTTPS enforced).</li>
              <li>DynamoDB data is encrypted at rest with AES-256 (AWS-managed keys).</li>
              <li>Secrets (API keys, wallet private keys) are stored in AWS Secrets Manager with KMS encryption.</li>
              <li>Operational logging is designed to minimize stored content, though troubleshooting reports or feedback you submit may include text you provide.</li>
              <li>Telegram webhook handlers verify secret tokens and validate sender IP against Telegram&apos;s official IP ranges.</li>
              <li>Wallet signatures are verified using Ed25519 (SIWS &mdash; Sign In With Solana).</li>
              <li>Each avatar&apos;s data is isolated from other avatars through partition-key isolation in DynamoDB.</li>
              <li>Dependencies are audited for known vulnerabilities in CI; high/critical severity findings block deployment.</li>
            </ul>
          </section>

          {/* 7. Your Rights */}
          <section>
            <h2 className="text-xl font-semibold text-[var(--color-text)] mb-3">7. Your Rights</h2>
            <p className="mb-3">You have the right to:</p>
            <ul className="list-disc pl-6 space-y-1">
              <li><strong>Access</strong> &mdash; request a copy of the data we hold about you.</li>
              <li><strong>Correction</strong> &mdash; request correction of inaccurate data.</li>
              <li><strong>Deletion</strong> &mdash; request deletion of your personal data. Most operational data auto-expires via TTL; account records, identity links, and consent records are retained until you request deletion and are removed within 30 days of a request.</li>
              <li><strong>Portability</strong> &mdash; request your data in a machine-readable format.</li>
              <li><strong>Withdraw consent</strong> &mdash; revoke your consent at any time (this does not affect the lawfulness of prior processing).</li>
            </ul>
            <p className="mt-3">
              To exercise any of these rights, contact us at{' '}
              <a href="mailto:privacy@cenetex.com" className="text-brand-400 hover:text-brand-300 underline">
                privacy@cenetex.com
              </a>.
            </p>
          </section>

          {/* 8. Cookies & Local Storage */}
          <section>
            <h2 className="text-xl font-semibold text-[var(--color-text)] mb-3">8. Cookies &amp; Local Storage</h2>
            <p className="mb-3">
              We do not use third-party tracking cookies. The following client-side storage is used:
            </p>
            <ul className="list-disc pl-6 space-y-1">
              <li>
                <strong>localStorage: swarm-consent</strong> &mdash; records your privacy policy acceptance (version accepted and timestamp). Required for consent management.
              </li>
              <li>
                <strong>localStorage: swarm-theme</strong> &mdash; stores your UI theme preference.
              </li>
              <li>
                <strong>localStorage</strong> &mdash; authentication and account metadata (for example login state, linked account details, and gate status) plus temporary OAuth flow data for cross-tab communication. Session cookies remain HttpOnly cookies and are not stored in localStorage.
              </li>
            </ul>
            <p className="mt-2">
              You can clear all localStorage data via your browser settings. Clearing consent storage will require you to re-accept this policy.
            </p>
          </section>

          {/* 9. AI Processing Disclosure */}
          <section>
            <h2 className="text-xl font-semibold text-[var(--color-text)] mb-3">9. AI Processing Disclosure</h2>
            <p>
              When you interact with an avatar, your messages (along with recent conversation
              context) are sent to third-party AI model providers via OpenRouter, which routes to
              models such as Anthropic Claude and OpenAI GPT-4, for response generation. These
              providers may process your data according to their own privacy policies. We do not
              use your conversations to train our own models.
            </p>
            <p className="mt-2">
              Media generation (images, video, audio) is performed via Replicate. Prompts and
              input media are sent to Replicate&apos;s API for processing.
            </p>
          </section>

          {/* 10. Children */}
          <section>
            <h2 className="text-xl font-semibold text-[var(--color-text)] mb-3">10. Children&apos;s Privacy</h2>
            <p>
              RATi OS is not intended for users under 18 (or the age of majority in your
              jurisdiction, whichever is greater). We do not knowingly collect data from minors.
              If you believe a minor has provided us data, please contact us at{' '}
              <a href="mailto:privacy@cenetex.com" className="text-brand-400 hover:text-brand-300 underline">
                privacy@cenetex.com
              </a>.
            </p>
          </section>

          {/* 11. Changes */}
          <section>
            <h2 className="text-xl font-semibold text-[var(--color-text)] mb-3">11. Changes to This Policy</h2>
            <p>
              We may update this policy from time to time. If we make material changes,
              we will increment the policy version number and re-prompt for your consent
              within the application. The current policy version is displayed in the consent
              banner and at the bottom of this page.
            </p>
          </section>

          {/* 12. Contact */}
          <section>
            <h2 className="text-xl font-semibold text-[var(--color-text)] mb-3">12. Contact</h2>
            <p>
              For privacy inquiries, data requests, or concerns:
            </p>
            <div className="mt-3 space-y-2 text-sm">
              <p className="font-medium text-[var(--color-text)]">
                Cenetex Inc. (Data Controller)
              </p>
              <p>
                Email:{' '}
                <a href="mailto:privacy@cenetex.com" className="text-brand-400 hover:text-brand-300 underline">
                  privacy@cenetex.com
                </a>
              </p>
              <p>
                Web:{' '}
                <a href="https://cenetex.com" className="text-brand-400 hover:text-brand-300 underline" target="_blank" rel="noopener noreferrer">
                  cenetex.com
                </a>
              </p>
            </div>
            <div className="mt-4 space-y-2 text-sm">
              <p className="font-medium text-[var(--color-text)]">
                RATi&#8482; Open Software Foundation (Software Licensor)
              </p>
              <p>
                Web:{' '}
                <a href="https://rati.foundation" className="text-brand-400 hover:text-brand-300 underline" target="_blank" rel="noopener noreferrer">
                  rati.foundation
                </a>
              </p>
            </div>
          </section>
        </div>

        {/* Footer */}
        <div className="mt-12 pt-8 border-t border-[var(--color-border)] text-center text-sm text-[var(--color-text-muted)] space-y-1">
          <p>{t('consent.privacyPolicyFooter')}</p>
          <p>Operated by <a href="https://cenetex.com" className="underline hover:text-[var(--color-text-secondary)]" target="_blank" rel="noopener noreferrer">Cenetex Inc.</a> &middot; Licensed from <a href="https://rati.foundation" className="underline hover:text-[var(--color-text-secondary)]" target="_blank" rel="noopener noreferrer">RATi&#8482; Open Software Foundation</a></p>
        </div>
      </div>
    </div>
  );
}
