import React from 'react';
import ReactDOM from 'react-dom/client';
import { AppRouter } from './App.tsx';
import { WalletProvider } from './components/WalletProvider';
import { PrivyProvider } from './components/PrivyProvider';
import { ErrorBoundary } from './components/ErrorBoundary';
import './i18n';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <PrivyProvider>
        <WalletProvider>
          <AppRouter />
        </WalletProvider>
      </PrivyProvider>
    </ErrorBoundary>
  </React.StrictMode>,
);
