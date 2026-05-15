import { fireEvent, render, screen } from '@testing-library/react';
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
        'landing.tierFreeButton': 'Get Started',
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

    fireEvent.click(screen.getByRole('button', { name: 'Get Started' }));

    expect(privyMocks.login).toHaveBeenCalledWith({
      walletChainType: 'solana-only',
      loginMethods: ['wallet', 'email', 'google', 'twitter'],
    });
  });
});
