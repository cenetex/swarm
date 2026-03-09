/**
 * Landing Page - Shown to unauthenticated users
 * Explains what the platform does and guides users to sign in.
 * Aligned with docs/POSITIONING.md messaging.
 */
import { useState } from 'react';
import { PrivyLoginButton } from './PrivyLoginButton';
import { PrivacyPolicy } from './PrivacyPolicy';

export function LandingPage() {
  const [showPrivacy, setShowPrivacy] = useState(false);

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

      {/* Main content */}
      <div className="flex-1 flex flex-col items-center justify-center px-6 py-12 z-10">
        {/* Logo */}
        <div className="flex items-center gap-3 mb-6">
          <img src="/swarm.svg" alt="Swarm" className="w-14 h-14 drop-shadow-[0_0_12px_rgba(122,99,149,0.5)]" />
          <h1 className="text-4xl font-bold tracking-tight text-[var(--color-text)]">Swarm</h1>
        </div>

        {/* Headline */}
        <h2 className="text-xl sm:text-2xl font-semibold text-[var(--color-text)] text-center mb-3 max-w-md leading-snug">
          AI avatars that live on your platforms
        </h2>
        <p className="text-sm text-[var(--color-text-secondary)] text-center mb-10 max-w-md leading-relaxed">
          Create an AI personality, connect it to Telegram, Discord, or X — it responds 24/7 with persistent memory and zero infrastructure.
        </p>

        {/* How it works — chat demo */}
        <div className="w-full max-w-sm mb-10">
          <div className="rounded-xl bg-[var(--color-bg-secondary)]/60 backdrop-blur-sm border border-[var(--color-border)] overflow-hidden">
            <div className="px-4 py-2.5 border-b border-[var(--color-border)] flex items-center gap-2">
              <div className="w-2 h-2 rounded-full bg-green-400" />
              <span className="text-xs font-medium text-[var(--color-text-muted)]">How it works</span>
            </div>
            <div className="p-4 space-y-3">
              <ChatBubble role="user" text="Create an avatar called Astra" />
              <ChatBubble role="assistant" text="Done! Give her a personality?" />
              <ChatBubble role="user" text="Friendly crypto nerd who explains DeFi simply" />
              <ChatBubble role="assistant" text="Persona set. Connect her to Telegram?" />
              <ChatBubble role="user" text="Yes — here's the bot token" />
              <ChatBubble role="assistant" text="Astra is live on Telegram and responding." check />
            </div>
          </div>
        </div>

        {/* Value props */}
        <div className="grid gap-3 mb-10 max-w-lg w-full">
          <FeatureCard
            icon={<BoltIcon />}
            title="Live in 10 minutes"
            description="Create an avatar, set its personality, paste your bot token. No servers, no code, no config files."
          />
          <FeatureCard
            icon={<BrainIcon />}
            title="Persistent memory"
            description="Your avatar remembers conversations across sessions. Same personality, same context, every time."
          />
          <FeatureCard
            icon={<MultiPlatformIcon />}
            title="Multi-platform, one identity"
            description="Connect Telegram, Discord, and X. One avatar, one personality, shared memory across all platforms."
          />
        </div>

        {/* CTA */}
        <PrivyLoginButton className="w-full max-w-sm justify-center" />

        {/* Social proof hint */}
        <p className="mt-4 text-xs text-[var(--color-text-muted)] text-center">
          Free tier included — 50 messages/day, no credit card required
        </p>
      </div>

      {/* Footer */}
      <footer className="py-6 text-center text-xs text-[var(--color-text-muted)] space-y-1.5 z-10">
        <p className="flex items-center justify-center gap-1.5 flex-wrap">
          <span>Operated by</span>
          <a href="https://cenetex.com" className="font-medium text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)] transition-colors" target="_blank" rel="noopener noreferrer">Cenetex Inc.</a>
          <span className="text-[var(--color-border-secondary)]">&middot;</span>
          <span>Powered by</span>
          <span className="font-medium text-[var(--color-text-tertiary)]">Solana</span>
        </p>
        <button
          onClick={() => setShowPrivacy(true)}
          className="underline hover:text-[var(--color-text-secondary)] transition-colors"
        >
          Privacy Policy
        </button>
      </footer>

      {/* Safe area spacer for iOS home indicator */}
      <div
        className="flex-shrink-0"
        style={{ height: 'env(safe-area-inset-bottom, 0px)' }}
      />
    </div>
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
