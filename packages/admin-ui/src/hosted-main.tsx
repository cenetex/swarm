import React, { useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
import { I18nextProvider } from 'react-i18next';
import { bootstrapAuthFromBackendSession } from './auth/bootstrap';
import { ErrorBoundary } from './components/ErrorBoundary';
import { WalletProvider } from './components/WalletProvider';
import { HostedApp } from './HostedApp';
import { HostedCatalogApp } from './HostedCatalogApp';
import { MobileWalletSignInPage } from './components/MobileWalletSignInPage';
import { CredentialMigrationNotice } from './components/CredentialMigrationNotice';
import { initializeLocalWebApi } from './local-web-api';
import i18n from './i18n';
import './index.css';

initializeLocalWebApi();

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
          <div className="flex min-h-[100dvh] flex-col">
            <CredentialMigrationNotice />
            <div className="min-h-0 flex-1">
              <HostedRoot />
            </div>
          </div>
        </WalletProvider>
      </I18nextProvider>
    </ErrorBoundary>
  </React.StrictMode>,
);
