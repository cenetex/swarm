import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LandingPage } from './LandingPage';
import { useAuthStore } from '../store/auth';

const privyMocks = vi.hoisted(() => ({
  login: vi.fn(),
  logout: vi.fn(),
  getAccessToken: vi.fn(),
}));

vi.mock('@privy-io/react-auth', () => ({
  usePrivy: () => ({
    login: privyMocks.login,
    logout: privyMocks.logout,
    ready: true,
    authenticated: false,
    user: null,
    getAccessToken: privyMocks.getAccessToken,
  }),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const labels: Record<string, string> = {
        'auth.loginWithPrivy': 'Login with Privy',
        'landing.primaryCta': 'Get Started',
        'landing.pricingTitle': 'Start free. Upgrade for expanded limits.',
        'landing.featureMultiDesc':
          'Connect your own Telegram, Discord, and X credentials. Same voice in every group; per-platform memory by default.',
        'landing.comparison4': 'Choose from the OpenRouter model catalog per avatar',
        'landing.tierFreeButton': 'Get Started',
        'landing.tierCreatorButton': 'Get Started',
      };
      return labels[key] ?? key;
    },
    i18n: {
      language: 'en',
      changeLanguage: vi.fn(),
    },
  }),
}));

describe('LandingPage', () => {
  beforeEach(() => {
    privyMocks.login.mockClear();
    useAuthStore.getState().resetLocal();
  });

  it('starts Privy login from the free tier Get Started button', () => {
    render(<LandingPage />);

    const pricing = screen.getByRole('region', { name: 'Start free. Upgrade for expanded limits.' });
    const pricingButtons = within(pricing).getAllByRole('button', { name: 'Get Started' });

    fireEvent.click(pricingButtons[0]);

    expect(privyMocks.login).toHaveBeenCalledWith({
      walletChainType: 'solana-only',
      loginMethods: ['wallet', 'email', 'google', 'twitter'],
    });
  });

  it('starts Privy login from the creator tier Get Started button', () => {
    render(<LandingPage />);

    const pricing = screen.getByRole('region', { name: 'Start free. Upgrade for expanded limits.' });
    const pricingButtons = within(pricing).getAllByRole('button', { name: 'Get Started' });

    expect(pricingButtons).toHaveLength(2);
    fireEvent.click(pricingButtons[1]);

    expect(privyMocks.login).toHaveBeenCalledWith({
      walletChainType: 'solana-only',
      loginMethods: ['wallet', 'email', 'google', 'twitter'],
    });
  });

  it('uses precise platform and model-selection claims', () => {
    render(<LandingPage />);

    expect(
      screen.getByText(
        'Connect your own Telegram, Discord, and X credentials. Same voice in every group; per-platform memory by default.'
      )
    ).toBeInTheDocument();
    expect(screen.getByText('Choose from the OpenRouter model catalog per avatar')).toBeInTheDocument();
    expect(screen.queryByText('Subscribe')).not.toBeInTheDocument();
  });
});
