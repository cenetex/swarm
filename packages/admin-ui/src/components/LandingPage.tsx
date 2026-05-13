/**
 * Landing Page - Shown to unauthenticated users
 * Explains what the platform does and guides users to sign in.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PrivyLoginButton } from './PrivyLoginButton';
import { PrivacyPolicy } from './PrivacyPolicy';
import { LanguageSelector } from './LanguageSelector';

export function LandingPage() {
  const [showPrivacy, setShowPrivacy] = useState(false);
  const { t } = useTranslation();

  if (showPrivacy) {
    return <PrivacyPolicy onClose={() => setShowPrivacy(false)} />;
  }

  return (
    <div className="min-h-[100dvh] bg-[var(--color-bg)] flex flex-col relative overflow-hidden">
      {/* Background gradients */}
      <div className="absolute inset-0 pointer-events-none">
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_80%_50%_at_50%_-20%,rgba(122,99,149,0.3),transparent)]" />
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_60%_40%_at_80%_60%,rgba(167,139,250,0.08),transparent)]" />
      </div>

      {/* Safe area spacer for iOS */}
      <div
        className="flex-shrink-0"
        style={{ height: 'env(safe-area-inset-top, 0px)' }}
      />

      {/* Language selector — top right */}
      <div className="absolute top-4 right-4 z-20">
        <LanguageSelector />
      </div>

      {/* Main content */}
      <div className="flex-1 flex flex-col items-center px-6 py-12 z-10">
        {/* Logo */}
        <div className="flex items-center gap-3 mb-6 mt-8">
          <img src="/swarm.svg" alt="Swarm" className="w-14 h-14 drop-shadow-[0_0_12px_rgba(122,99,149,0.5)]" />
          <h1 className="text-4xl font-bold tracking-tight text-[var(--color-text)]">Swarm</h1>
        </div>

        {/* Headline */}
        <h2 className="text-xl sm:text-2xl font-semibold text-[var(--color-text)] text-center mb-2 max-w-lg leading-snug">
          {t('landing.headline')}
        </h2>
        <p className="text-sm text-[var(--color-text-secondary)] text-center mb-10 max-w-md leading-relaxed">
          {t('landing.subtitle')}
        </p>

        {/* How it works — chat demo */}
        <div className="w-full max-w-sm mb-10">
          <div className="rounded-xl bg-[var(--color-bg-secondary)]/60 backdrop-blur-sm border border-[var(--color-border)] overflow-hidden">
            <div className="px-4 py-2.5 border-b border-[var(--color-border)] flex items-center gap-2">
              <div className="w-2 h-2 rounded-full bg-green-400" />
              <span className="text-xs font-medium text-[var(--color-text-muted)]">{t('landing.howItWorks')}</span>
            </div>
            <div className="p-4 space-y-3">
              <ChatBubble role="user" text={t('landing.chat1User')} />
              <ChatBubble role="assistant" text={t('landing.chat1Assistant')} />
              <ChatBubble role="user" text={t('landing.chat2User')} />
              <ChatBubble role="assistant" text={t('landing.chat2Assistant')} />
              <ChatBubble role="user" text={t('landing.chat3User')} />
              <ChatBubble role="assistant" text={t('landing.chat3Assistant')} check />
            </div>
          </div>
        </div>

        {/* Value props */}
        <div className="grid gap-3 mb-10 max-w-lg w-full">
          <FeatureCard
            icon={<BoltIcon />}
            title={t('landing.featureLiveTitle')}
            description={t('landing.featureLiveDesc')}
          />
          <FeatureCard
            icon={<BrainIcon />}
            title={t('landing.featureMemoryTitle')}
            description={t('landing.featureMemoryDesc')}
          />
          <FeatureCard
            icon={<MultiPlatformIcon />}
            title={t('landing.featureMultiTitle')}
            description={t('landing.featureMultiDesc')}
          />
        </div>

        {/* Why Swarm */}
        <div className="w-full max-w-lg mb-10">
          <h3 className="text-sm font-semibold text-[var(--color-text-muted)] uppercase tracking-wider text-center mb-4">
            {t('landing.whySwarm')}
          </h3>
          <div className="rounded-xl bg-[var(--color-bg-secondary)]/60 backdrop-blur-sm border border-[var(--color-border)] p-4 sm:p-6">
            <p className="text-sm text-[var(--color-text-secondary)] leading-relaxed mb-4">
              {t('landing.whySwarmIntro')}
            </p>
            <ul className="space-y-2.5 text-xs text-[var(--color-text-secondary)] leading-relaxed">
              <ComparisonItem text={t('landing.comparison1')} />
              <ComparisonItem text={t('landing.comparison2')} />
              <ComparisonItem text={t('landing.comparison3')} />
              <ComparisonItem text={t('landing.comparison4')} />
            </ul>
          </div>
        </div>

        {/* Pricing */}
        <div className="w-full max-w-2xl mb-10">
          <h3 className="text-lg sm:text-xl font-bold text-[var(--color-text)] text-center mb-1">
            {t('landing.pricingTitle')}
          </h3>
          <p className="text-sm text-[var(--color-text-secondary)] text-center mb-5">
            {t('landing.pricingSubtitle')}
          </p>
          <PricingTiers />
        </div>

        {/* CTA */}
        <PrivyLoginButton className="w-full max-w-sm justify-center" />

        {/* Social proof hint */}
        <p className="mt-4 text-xs text-[var(--color-text-muted)] text-center">
          {t('landing.socialProof')}
        </p>
      </div>

      {/* Footer with ecosystem links */}
      <footer className="py-8 px-6 z-10 border-t border-[var(--color-border)]">
        <div className="max-w-lg mx-auto">
          {/* Ecosystem links */}
          <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-2 mb-4 text-xs">
            <a href="https://discord.gg/YmPhMtNMxb" className="text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)] transition-colors" target="_blank" rel="noopener noreferrer">
              {t('landing.footerDiscord')}
            </a>
            <span className="text-[var(--color-border-secondary)]">&middot;</span>
            <a href="https://rati.chat" className="text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)] transition-colors" target="_blank" rel="noopener noreferrer">
              {t('landing.footerFoundation')}
            </a>
          </div>
          {/* Operator info */}
          <p className="text-center text-xs text-[var(--color-text-muted)] flex items-center justify-center gap-1.5 flex-wrap mb-1.5">
            <span>{t('landing.footerOperatedBy')}</span>
            <a href="https://cenetex.com" className="font-medium text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)] transition-colors" target="_blank" rel="noopener noreferrer">Cenetex Inc.</a>
            <span className="text-[var(--color-border-secondary)]">&middot;</span>
            <span>{t('landing.footerPoweredBy')}</span>
            <span className="font-medium text-[var(--color-text-tertiary)]">Solana</span>
          </p>
          <div className="text-center">
            <button
              onClick={() => setShowPrivacy(true)}
              className="text-xs text-[var(--color-text-muted)] underline hover:text-[var(--color-text-secondary)] transition-colors"
            >
              {t('landing.footerPrivacy')}
            </button>
          </div>
        </div>
      </footer>

      {/* Safe area spacer for iOS home indicator */}
      <div
        className="flex-shrink-0"
        style={{ height: 'env(safe-area-inset-bottom, 0px)' }}
      />
    </div>
  );
}

/* ---- Comparison List Item ---- */

function ComparisonItem({ text }: { text: string }) {
  return (
    <li className="flex items-start gap-2">
      <span className="text-green-400 mt-0.5 flex-shrink-0">&#10003;</span>
      <span>{text}</span>
    </li>
  );
}

/* ---- Chat Demo Bubbles ---- */

function ChatBubble({ role, text, check }: { role: 'user' | 'assistant'; text: string; check?: boolean }) {
  const isUser = role === 'user';
  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div className={`rounded-xl px-3 py-1.5 max-w-[85%] text-xs leading-relaxed ${
        isUser
          ? 'bg-brand-600 text-white rounded-br-sm'
          : 'bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)] rounded-bl-sm'
      }`}>
        {check && <span className="text-green-400 mr-1">&#10003;</span>}
        {text}
      </div>
    </div>
  );
}

/* ---- Feature Cards ---- */

interface FeatureCardProps {
  icon: React.ReactNode;
  title: string;
  description: string;
}

function FeatureCard({ icon, title, description }: FeatureCardProps) {
  return (
    <div className="flex items-start gap-4 p-4 rounded-xl bg-[var(--color-bg-secondary)]/60 backdrop-blur-sm border border-[var(--color-border)] hover:border-brand-500/40 transition-all group">
      <div className="w-10 h-10 flex-shrink-0 flex items-center justify-center rounded-lg bg-brand-500/10 border border-brand-500/20 text-brand-300 group-hover:bg-brand-500/15 group-hover:border-brand-500/30 transition-all">
        {icon}
      </div>
      <div className="flex-1 min-w-0">
        <h3 className="font-semibold text-[var(--color-text)] mb-0.5 text-sm">{title}</h3>
        <p className="text-xs text-[var(--color-text-secondary)] leading-relaxed">{description}</p>
      </div>
    </div>
  );
}

/* ---- Pricing Tiers ---- */

const MONTHLY_PRICES = { free: 0, creator: 9 };
const ANNUAL_PRICES = { free: 0, creator: 90 };

function PricingTiers() {
  const [annual, setAnnual] = useState(false);
  const { t } = useTranslation();
  const prices = annual ? ANNUAL_PRICES : MONTHLY_PRICES;
  const period = annual ? '/yr' : '/mo';

  return (
    <div>
      {/* Annual toggle */}
      <div className="flex items-center justify-center gap-3 mb-5">
        <span className={`text-xs font-medium ${!annual ? 'text-[var(--color-text)]' : 'text-[var(--color-text-muted)]'}`}>{t('landing.monthly')}</span>
        <button
          onClick={() => setAnnual(!annual)}
          className={`relative w-11 h-6 rounded-full transition-colors ${annual ? 'bg-brand-600' : 'bg-[var(--color-bg-tertiary)] border border-[var(--color-border)]'}`}
          aria-label="Toggle annual pricing"
        >
          <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform ${annual ? 'translate-x-5' : ''}`} />
        </button>
        <span className={`text-xs font-medium ${annual ? 'text-[var(--color-text)]' : 'text-[var(--color-text-muted)]'}`}>
          {t('landing.annual')} <span className="text-green-400">{t('landing.savePercent')}</span>
        </span>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 max-w-xl mx-auto">
        {/* Free */}
        <div className="rounded-xl p-4 border bg-[var(--color-bg-secondary)]/40 border-[var(--color-border)] text-center flex flex-col">
          <div className="text-xs font-semibold uppercase tracking-wider mb-1 text-[var(--color-text-muted)]">{t('landing.tierFreeName')}</div>
          <div className="text-sm text-[var(--color-text-secondary)] mb-3">{t('landing.tierFreeDesc')}</div>
          <div className="text-2xl font-bold text-[var(--color-text)] mb-3">$0</div>
          <ul className="space-y-1.5 text-xs text-[var(--color-text-muted)] mb-4 flex-1">
            <li>{t('landing.tierFreeFeature1')}</li>
            <li>{t('landing.tierFreeFeature2')}</li>
            <li>{t('landing.tierFreeFeature3')}</li>
            <li>{t('landing.tierFreeFeature4')}</li>
          </ul>
          <div className="text-xs text-[var(--color-text-muted)] font-medium py-2 rounded-lg bg-[var(--color-bg-tertiary)] border border-[var(--color-border)]">
            {t('landing.tierFreeButton')}
          </div>
        </div>

        {/* Creator ($9) */}
        <div className="rounded-xl p-4 border bg-[var(--color-bg-secondary)]/60 border-blue-500/30 text-center flex flex-col">
          <div className="text-xs font-semibold uppercase tracking-wider mb-1 text-blue-400">{t('landing.tierCreatorName')}</div>
          <div className="text-sm text-[var(--color-text-secondary)] mb-3">{t('landing.tierCreatorDesc')}</div>
          <div className="text-2xl font-bold text-[var(--color-text)] mb-3">
            ${prices.creator}<span className="text-xs font-normal text-[var(--color-text-muted)]">{period}</span>
          </div>
          <ul className="space-y-1.5 text-xs text-[var(--color-text-secondary)] mb-4 flex-1">
            <li>{t('landing.tierCreatorFeature1')}</li>
            <li>{t('landing.tierCreatorFeature2')}</li>
            <li>{t('landing.tierCreatorFeature3')}</li>
            <li>{t('landing.tierCreatorFeature4')}</li>
          </ul>
          <div className="text-xs font-medium py-2 rounded-lg bg-blue-600 text-white">
            {t('landing.tierCreatorButton')}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---- Inline SVG Icons ---- */

function BoltIcon() {
  return (
    <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 13.5l10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75z" />
    </svg>
  );
}

function BrainIcon() {
  return (
    <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.455 2.456L21.75 6l-1.036.259a3.375 3.375 0 00-2.455 2.456zM16.894 20.567L16.5 21.75l-.394-1.183a2.25 2.25 0 00-1.423-1.423L13.5 18.75l1.183-.394a2.25 2.25 0 001.423-1.423l.394-1.183.394 1.183a2.25 2.25 0 001.423 1.423l1.183.394-1.183.394a2.25 2.25 0 00-1.423 1.423z" />
    </svg>
  );
}

function MultiPlatformIcon() {
  return (
    <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 21L3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5" />
    </svg>
  );
}

