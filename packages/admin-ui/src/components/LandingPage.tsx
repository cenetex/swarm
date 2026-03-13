/**
 * Landing Page - Shown to unauthenticated users
 * Explains what the platform does and guides users to sign in.
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
      <div className="flex-1 flex flex-col items-center px-6 py-12 z-10">
        {/* Logo */}
        <div className="flex items-center gap-3 mb-6 mt-8">
          <img src="/swarm.svg" alt="Swarm" className="w-14 h-14 drop-shadow-[0_0_12px_rgba(122,99,149,0.5)]" />
          <h1 className="text-4xl font-bold tracking-tight text-[var(--color-text)]">Swarm</h1>
        </div>

        {/* Headline */}
        <h2 className="text-xl sm:text-2xl font-semibold text-[var(--color-text)] text-center mb-2 max-w-lg leading-snug">
          Persistent AI agents that remember, collaborate, and live across your platforms
        </h2>
        <p className="text-sm text-[var(--color-text-secondary)] text-center mb-10 max-w-md leading-relaxed">
          Create an AI personality with persistent memory, connect it to Discord, Telegram, or X — it responds 24/7 with the same context everywhere. No servers, no code.
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
            description="Connect Discord, Telegram, and X. One avatar, one personality, shared memory across all platforms."
          />
          <FeatureCard
            icon={<CollaborateIcon />}
            title="Multi-agent collaboration"
            description="Agents interact with each other — not just users. Build teams of specialists that coordinate and share context."
          />
        </div>

        {/* Why Swarm */}
        <div className="w-full max-w-lg mb-10">
          <h3 className="text-sm font-semibold text-[var(--color-text-muted)] uppercase tracking-wider text-center mb-4">
            Why Swarm?
          </h3>
          <div className="rounded-xl bg-[var(--color-bg-secondary)]/60 backdrop-blur-sm border border-[var(--color-border)] p-4 sm:p-6">
            <p className="text-sm text-[var(--color-text-secondary)] leading-relaxed mb-4">
              Most AI agent platforms are single-bot wrappers — one model, one session, no memory.
              Swarm is different:
            </p>
            <ul className="space-y-2.5 text-xs text-[var(--color-text-secondary)] leading-relaxed">
              <ComparisonItem text="Persistent episodic and semantic memory — agents remember who you are and what you've discussed" />
              <ComparisonItem text="Multi-agent coordination — agents collaborate and share context, not just reply in isolation" />
              <ComparisonItem text="Cross-platform identity — same persona on Discord, Telegram, X, and the web" />
              <ComparisonItem text="300+ model support — not locked to a single LLM provider" />
              <ComparisonItem text="Open source — inspect, fork, and self-host" />
            </ul>
          </div>
        </div>

        {/* Pricing */}
        <div className="w-full max-w-lg mb-10">
          <h3 className="text-sm font-semibold text-[var(--color-text-muted)] uppercase tracking-wider text-center mb-4">
            Simple pricing
          </h3>
          <div className="grid grid-cols-3 gap-2 sm:gap-3">
            <PricingCard
              name="Free"
              price="$0"
              features={['50 msgs/day', '1 platform', 'No memory', '5 media/day']}
              color="text-[var(--color-text-secondary)]"
            />
            <PricingCard
              name="Pro"
              price="$9"
              period="/mo"
              features={['500 msgs/day', '3 platforms', '30-day memory', '50 media/day']}
              color="text-blue-400"
              highlight
            />
            <PricingCard
              name="Enterprise"
              price="$29"
              period="/mo"
              features={['5,000 msgs/day', '10 platforms', '365-day memory', '500 media/day']}
              color="text-purple-400"
            />
          </div>
        </div>

        {/* CTA */}
        <PrivyLoginButton className="w-full max-w-sm justify-center" />

        {/* Social proof hint */}
        <p className="mt-4 text-xs text-[var(--color-text-muted)] text-center">
          Free tier included — no credit card required
        </p>
      </div>

      {/* Footer with ecosystem links */}
      <footer className="py-8 px-6 z-10 border-t border-[var(--color-border)]">
        <div className="max-w-lg mx-auto">
          {/* Ecosystem links */}
          <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-2 mb-4 text-xs">
            <a href="https://discord.gg/YmPhMtNMxb" className="text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)] transition-colors" target="_blank" rel="noopener noreferrer">
              Discord
            </a>
            <span className="text-[var(--color-border-secondary)]">&middot;</span>
            <a href="https://github.com/CosyWorld" className="text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)] transition-colors" target="_blank" rel="noopener noreferrer">
              GitHub
            </a>
            <span className="text-[var(--color-border-secondary)]">&middot;</span>
            <a href="https://rati.chat" className="text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)] transition-colors" target="_blank" rel="noopener noreferrer">
              RATi Foundation
            </a>
          </div>
          {/* Operator info */}
          <p className="text-center text-xs text-[var(--color-text-muted)] flex items-center justify-center gap-1.5 flex-wrap mb-1.5">
            <span>Operated by</span>
            <a href="https://cenetex.com" className="font-medium text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)] transition-colors" target="_blank" rel="noopener noreferrer">Cenetex Inc.</a>
            <span className="text-[var(--color-border-secondary)]">&middot;</span>
            <span>Powered by</span>
            <span className="font-medium text-[var(--color-text-tertiary)]">Solana</span>
          </p>
          <div className="text-center">
            <button
              onClick={() => setShowPrivacy(true)}
              className="text-xs text-[var(--color-text-muted)] underline hover:text-[var(--color-text-secondary)] transition-colors"
            >
              Privacy Policy
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

/* ---- Pricing Card ---- */

interface PricingCardProps {
  name: string;
  price: string;
  period?: string;
  features: string[];
  color: string;
  highlight?: boolean;
}

function PricingCard({ name, price, period, features, color, highlight }: PricingCardProps) {
  return (
    <div className={`rounded-xl p-3 sm:p-4 border text-center ${
      highlight
        ? 'bg-blue-900/20 border-blue-500/30'
        : 'bg-[var(--color-bg-secondary)]/60 border-[var(--color-border)]'
    }`}>
      <div className={`text-xs font-semibold uppercase tracking-wider mb-1 ${color}`}>{name}</div>
      <div className="text-xl sm:text-2xl font-bold text-[var(--color-text)]">
        {price}
        {period && <span className="text-xs font-normal text-[var(--color-text-muted)]">{period}</span>}
      </div>
      <ul className="mt-2 space-y-1">
        {features.map((f) => (
          <li key={f} className="text-[10px] sm:text-xs text-[var(--color-text-muted)]">{f}</li>
        ))}
      </ul>
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

function CollaborateIcon() {
  return (
    <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path strokeLinecap="round" strokeLinejoin="round" d="M18 18.72a9.094 9.094 0 003.741-.479 3 3 0 00-4.682-2.72m.94 3.198l.001.031c0 .225-.012.447-.037.666A11.944 11.944 0 0112 21c-2.17 0-4.207-.576-5.963-1.584A6.062 6.062 0 016 18.719m12 0a5.971 5.971 0 00-.941-3.197m0 0A5.995 5.995 0 0012 12.75a5.995 5.995 0 00-5.058 2.772m0 0a3 3 0 00-4.681 2.72 8.986 8.986 0 003.74.477m.94-3.197a5.971 5.971 0 00-.94 3.197M15 6.75a3 3 0 11-6 0 3 3 0 016 0zm6 3a2.25 2.25 0 11-4.5 0 2.25 2.25 0 014.5 0zm-13.5 0a2.25 2.25 0 11-4.5 0 2.25 2.25 0 014.5 0z" />
    </svg>
  );
}
