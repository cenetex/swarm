import React from 'react';
import i18n from '../i18n';

interface ErrorBoundaryProps {
  children: React.ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

/**
 * Top-level React Error Boundary that catches unhandled render errors
 * and displays a recovery UI instead of a blank white screen.
 *
 * React Error Boundaries must be class components — there is no
 * hook equivalent for componentDidCatch / getDerivedStateFromError.
 */
export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    console.error('[ErrorBoundary] Uncaught render error:', error.message);
    console.error('[ErrorBoundary] Component stack:', errorInfo.componentStack);
  }

  private handleReset = () => {
    this.setState({ hasError: false, error: null });
  };

  private handleReload = () => {
    window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      return (
        <div
          className="h-[100dvh] flex items-center justify-center bg-[var(--color-bg)] p-4"
          role="alert"
        >
          <div className="max-w-md w-full text-center space-y-6">
            <div className="space-y-2">
              <h1 className="text-2xl font-semibold text-[var(--color-text)]">
                {i18n.t('error.somethingWentWrong')}
              </h1>
              <p className="text-sm text-[var(--color-text-secondary)]">
                {i18n.t('error.unexpectedError')}
              </p>
            </div>

            {this.state.error && (
              <pre className="text-xs text-left bg-[var(--color-bg-secondary)] text-[var(--color-text-secondary)] p-3 rounded-lg overflow-auto max-h-40">
                {this.state.error.message}
              </pre>
            )}

            <div className="flex gap-3 justify-center">
              <button
                onClick={this.handleReset}
                className="px-4 py-2 text-sm font-medium rounded-lg bg-brand-500 text-white hover:bg-brand-600 transition-colors"
              >
                {i18n.t('common.tryAgain')}
              </button>
              <button
                onClick={this.handleReload}
                className="px-4 py-2 text-sm font-medium rounded-lg border border-[var(--color-border)] text-[var(--color-text)] hover:bg-[var(--color-bg-secondary)] transition-colors"
              >
                {i18n.t('common.reloadPage')}
              </button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
