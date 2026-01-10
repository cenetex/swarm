/**
 * Logger utility with structured logging for CloudWatch
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogContext {
  agentId?: string;
  platform?: string;
  conversationId?: string;
  messageId?: string;
  requestId?: string;
  [key: string]: unknown;
}

class Logger {
  private context: LogContext = {};
  private minLevel: LogLevel = 'info';

  private readonly levelOrder: Record<LogLevel, number> = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
  };

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
      } else if (error) {
        errorData.error = String(error);
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

// Set log level from environment
if (process.env.LOG_LEVEL) {
  logger.setMinLevel(process.env.LOG_LEVEL as LogLevel);
}
