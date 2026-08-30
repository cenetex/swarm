import React, { useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
import { I18nextProvider } from 'react-i18next';
import { bootstrapAuthFromBackendSession } from './auth/bootstrap';
import { ErrorBoundary } from './components/ErrorBoundary';
import { WalletProvider } from './components/WalletProvider';
import { HostedApp } from './HostedApp';
import { HostedCatalogApp } from './HostedCatalogApp';
import { MobileWalletSignInPage } from './components/MobileWalletSignInPage';
import i18n from './i18n';
import './index.css';

function HostedSessionRoot() {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    bootstrapAuthFromBackendSession().finally(() => setReady(true));
  }, []);

  if (!ready) {
    return (
      <div className="grid min-h-[100dvh] place-items-center bg-[var(--color-bg)]">
        <div className="h-7 w-7 animate-spin rounded-full border-2 border-brand-400 border-t-transparent" />
      </div>
    );
  }
  return <HostedApp />;
}

function HostedRoot() {
  if (window.location.pathname === '/mobile-sign-in') return <MobileWalletSignInPage />;
  if (window.location.pathname === '/studio') return <HostedSessionRoot />;
  return <HostedCatalogApp />;
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <I18nextProvider i18n={i18n}>
        <WalletProvider autoConnect={false}>
          <HostedRoot />
        </WalletProvider>
      </I18nextProvider>
    </ErrorBoundary>
  </React.StrictMode>,
);
