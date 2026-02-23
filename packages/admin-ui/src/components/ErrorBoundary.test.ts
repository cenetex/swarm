/**
 * Tests for ErrorBoundary component logic.
 *
 * Validates that:
 * - getDerivedStateFromError correctly sets hasError state
 * - componentDidCatch logs the error message (not the full error object)
 * - The component is a class component with the required lifecycle methods
 *
 * Note: These tests verify the ErrorBoundary logic without DOM rendering
 * since the bun test runner does not provide a jsdom environment. Full
 * integration behaviour (fallback UI, button clicks) is covered by the
 * vitest/jsdom configuration when running `npx vitest` directly.
 */
import { describe, it, expect, mock } from 'bun:test';
import { ErrorBoundary } from './ErrorBoundary';

describe('ErrorBoundary', () => {
  it('is a class component with getDerivedStateFromError', () => {
    expect(typeof ErrorBoundary.getDerivedStateFromError).toBe('function');
  });

  it('has componentDidCatch on the prototype', () => {
    expect(typeof ErrorBoundary.prototype.componentDidCatch).toBe('function');
  });

  it('has a render method on the prototype', () => {
    expect(typeof ErrorBoundary.prototype.render).toBe('function');
  });

  it('getDerivedStateFromError returns { hasError: true } with the error', () => {
    const testError = new Error('Something broke');
    const state = ErrorBoundary.getDerivedStateFromError(testError);

    expect(state.hasError).toBe(true);
    expect(state.error).toBe(testError);
    expect(state.error?.message).toBe('Something broke');
  });

  it('getDerivedStateFromError preserves different error messages', () => {
    const error1 = ErrorBoundary.getDerivedStateFromError(new Error('Error A'));
    const error2 = ErrorBoundary.getDerivedStateFromError(new Error('Error B'));

    expect(error1.error?.message).toBe('Error A');
    expect(error2.error?.message).toBe('Error B');
  });

  it('componentDidCatch logs error.message (not the full error object)', () => {
    const consoleErrorMock = mock(() => {});
    const originalError = console.error;
    console.error = consoleErrorMock;

    try {
      const instance = Object.create(ErrorBoundary.prototype);
      const testError = new Error('Render crash');
      const errorInfo = { componentStack: '\n  at BrokenComponent\n  at App' };

      instance.componentDidCatch(testError, errorInfo);

      // Should have been called twice: once for error message, once for component stack
      expect(consoleErrorMock).toHaveBeenCalledTimes(2);

      const firstCall = consoleErrorMock.mock.calls[0];
      expect(firstCall[0]).toBe('[ErrorBoundary] Uncaught render error:');
      // Verify we log error.message (string), not the Error object itself
      expect(firstCall[1]).toBe('Render crash');
      expect(typeof firstCall[1]).toBe('string');

      const secondCall = consoleErrorMock.mock.calls[1];
      expect(secondCall[0]).toBe('[ErrorBoundary] Component stack:');
      expect(secondCall[1]).toContain('BrokenComponent');
    } finally {
      console.error = originalError;
    }
  });

  it('initial state has hasError: false and error: null', () => {
    // Verify the constructor sets the expected initial state
    // We create a minimal instance to check
    const instance = new (ErrorBoundary as unknown as new (props: { children: null }) => {
      state: { hasError: boolean; error: Error | null };
    })({ children: null });

    expect(instance.state.hasError).toBe(false);
    expect(instance.state.error).toBeNull();
  });
});
