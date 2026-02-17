/**
 * Logger utility with structured logging for CloudWatch
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const VALID_LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'] as const;

/**
 * Check whether a string is a valid LogLevel value.
 */
export function isValidLogLevel(value: string): value is LogLevel {
  return (VALID_LOG_LEVELS as readonly string[]).includes(value);
}

/**
 * Parse a LOG_LEVEL environment variable, returning the level if valid or
 * the provided fallback (default `'info'`) otherwise.
 */
export function parseLogLevel(envValue: string | undefined, fallback: LogLevel = 'info'): LogLevel {
  if (envValue && isValidLogLevel(envValue)) {
    return envValue;
  }
  return fallback;
}

export interface LogContext {
  avatarId?: string;
  platform?: string;
  conversationId?: string;
  messageId?: string;
  requestId?: string;
  correlationId?: string;
  traceId?: string;
  [key: string]: unknown;
}

export class Logger {
  private context: LogContext = {};
  private minLevel: LogLevel = 'info';

  private readonly levelOrder: Record<LogLevel, number> = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
  };

  getMinLevel(): LogLevel {
    return this.minLevel;
  }

  setMinLevel(level: LogLevel): void {
    this.minLevel = level;
  }

  setContext(context: LogContext): void {
    this.context = { ...this.context, ...context };
  }

  clearContext(): void {
    this.context = {};
  }

  private shouldLog(level: LogLevel): boolean {
    return this.levelOrder[level] >= this.levelOrder[this.minLevel];
  }

  private formatMessage(
    level: LogLevel,
    message: string,
    data?: Record<string, unknown>
  ): string {
    const logEntry = {
      timestamp: new Date().toISOString(),
      level: level.toUpperCase(),
      message,
      ...this.context,
      ...data,
    };

    return JSON.stringify(logEntry);
  }

  debug(message: string, data?: Record<string, unknown>): void {
    if (this.shouldLog('debug')) {
      console.log(this.formatMessage('debug', message, data));
    }
  }

  info(message: string, data?: Record<string, unknown>): void {
    if (this.shouldLog('info')) {
      console.log(this.formatMessage('info', message, data));
    }
  }

  warn(message: string, data?: Record<string, unknown>): void {
    if (this.shouldLog('warn')) {
      console.warn(this.formatMessage('warn', message, data));
    }
  }

  error(message: string, error?: Error | unknown, data?: Record<string, unknown>): void {
    if (this.shouldLog('error')) {
      const errorData: Record<string, unknown> = { ...data };
      
      if (error instanceof Error) {
        errorData.errorName = error.name;
        errorData.errorMessage = error.message;
        errorData.errorStack = error.stack;
      } else if (error !== null && error !== undefined) {
        // Handle AWS SDK errors and other objects with message/name properties
        const errObj = error as Record<string, unknown>;
        if (typeof errObj === 'object') {
          if (errObj.message) errorData.errorMessage = String(errObj.message);
          if (errObj.name) errorData.errorName = String(errObj.name);
          if (errObj.code) errorData.errorCode = String(errObj.code);
          if (errObj.$metadata) errorData.errorMetadata = errObj.$metadata;
          // If no useful properties found, stringify the object
          if (!errObj.message && !errObj.name && !errObj.code) {
            try {
              errorData.error = JSON.stringify(error);
            } catch {
              errorData.error = String(error);
            }
          }
        } else {
          errorData.error = String(error);
        }
      }

      console.error(this.formatMessage('error', message, errorData));
    }
  }

  /**
   * Create a child logger with additional context
   */
  child(context: LogContext): Logger {
    const child = new Logger();
    child.context = { ...this.context, ...context };
    child.minLevel = this.minLevel;
    return child;
  }
}

// Singleton instance
export const logger = new Logger();

// Set log level from environment, with validation
const envLogLevel = parseLogLevel(process.env.LOG_LEVEL);
logger.setMinLevel(envLogLevel);
