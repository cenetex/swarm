import React from 'react';
import ReactDOM from 'react-dom/client';
import { I18nextProvider } from 'react-i18next';
import { AppRouter } from './App.tsx';
import { WalletProvider } from './components/WalletProvider';
import { PrivyProvider } from './components/PrivyProvider';
import { ErrorBoundary } from './components/ErrorBoundary';
import i18n from './i18n';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <I18nextProvider i18n={i18n}>
        <PrivyProvider>
          <WalletProvider>
            <AppRouter />
          </WalletProvider>
        </PrivyProvider>
      </I18nextProvider>
    </ErrorBoundary>
  </React.StrictMode>,
);
