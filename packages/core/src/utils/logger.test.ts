import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { Logger, isValidLogLevel, parseLogLevel } from './logger.js';


describe('isValidLogLevel', () => {
  it('should accept valid log levels', () => {
    expect(isValidLogLevel('debug')).toBe(true);
    expect(isValidLogLevel('info')).toBe(true);
    expect(isValidLogLevel('warn')).toBe(true);
    expect(isValidLogLevel('error')).toBe(true);
  });

  it('should reject invalid log levels', () => {
    expect(isValidLogLevel('trace')).toBe(false);
    expect(isValidLogLevel('fatal')).toBe(false);
    expect(isValidLogLevel('INFO')).toBe(false);
    expect(isValidLogLevel('DEBUG')).toBe(false);
    expect(isValidLogLevel('')).toBe(false);
    expect(isValidLogLevel('verbose')).toBe(false);
  });
});

describe('parseLogLevel', () => {
  it('should return the level when valid', () => {
    expect(parseLogLevel('debug')).toBe('debug');
    expect(parseLogLevel('info')).toBe('info');
    expect(parseLogLevel('warn')).toBe('warn');
    expect(parseLogLevel('error')).toBe('error');
  });

  it('should return fallback for undefined', () => {
    expect(parseLogLevel(undefined)).toBe('info');
  });

  it('should return fallback for invalid values', () => {
    expect(parseLogLevel('INVALID')).toBe('info');
    expect(parseLogLevel('')).toBe('info');
    expect(parseLogLevel('trace')).toBe('info');
  });

  it('should use custom fallback when provided', () => {
    expect(parseLogLevel(undefined, 'warn')).toBe('warn');
    expect(parseLogLevel('INVALID', 'error')).toBe('error');
  });
});

describe('Logger', () => {
  let logger: Logger;
  let consoleLogs: string[];
  let consoleWarns: string[];
  let consoleErrors: string[];

  beforeEach(() => {
    logger = new Logger();
    consoleLogs = [];
    consoleWarns = [];
    consoleErrors = [];

    spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      consoleLogs.push(String(args[0]));
    });
    spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      consoleWarns.push(String(args[0]));
    });
    spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      consoleErrors.push(String(args[0]));
    });
  });

  afterEach(() => {
    (console.log as ReturnType<typeof spyOn>).mockRestore();
    (console.warn as ReturnType<typeof spyOn>).mockRestore();
    (console.error as ReturnType<typeof spyOn>).mockRestore();
  });

  describe('default level', () => {
    it('should default to info level', () => {
      expect(logger.getMinLevel()).toBe('info');
    });
  });

  describe('setMinLevel', () => {
    it('should change the minimum log level', () => {
      logger.setMinLevel('error');
      expect(logger.getMinLevel()).toBe('error');
    });
  });

  describe('level filtering', () => {
    it('should log messages at or above the min level (info)', () => {
      logger.setMinLevel('info');

      logger.debug('debug msg');
      logger.info('info msg');
      logger.warn('warn msg');
      logger.error('error msg');

      // debug should be suppressed
      expect(consoleLogs.length).toBe(1); // info only
      expect(consoleWarns.length).toBe(1); // warn
      expect(consoleErrors.length).toBe(1); // error

      const infoEntry = JSON.parse(consoleLogs[0]);
      expect(infoEntry.message).toBe('info msg');
      expect(infoEntry.level).toBe('INFO');
    });

    it('should log all messages at debug level', () => {
      logger.setMinLevel('debug');

      logger.debug('debug msg');
      logger.info('info msg');
      logger.warn('warn msg');
      logger.error('error msg');

      expect(consoleLogs.length).toBe(2); // debug + info
      expect(consoleWarns.length).toBe(1); // warn
      expect(consoleErrors.length).toBe(1); // error
    });

    it('should only log warn and error at warn level', () => {
      logger.setMinLevel('warn');

      logger.debug('debug msg');
      logger.info('info msg');
      logger.warn('warn msg');
      logger.error('error msg');

      expect(consoleLogs.length).toBe(0);
      expect(consoleWarns.length).toBe(1);
      expect(consoleErrors.length).toBe(1);
    });

    it('should only log errors at error level', () => {
      logger.setMinLevel('error');

      logger.debug('debug msg');
      logger.info('info msg');
      logger.warn('warn msg');
      logger.error('error msg');

      expect(consoleLogs.length).toBe(0);
      expect(consoleWarns.length).toBe(0);
      expect(consoleErrors.length).toBe(1);
    });
  });

  describe('structured output', () => {
    it('should output valid JSON with required fields', () => {
      logger.info('test message', { key: 'value' });

      const entry = JSON.parse(consoleLogs[0]);
      expect(entry.timestamp).toBeDefined();
      expect(entry.level).toBe('INFO');
      expect(entry.message).toBe('test message');
      expect(entry.key).toBe('value');
    });

    it('should include context in output', () => {
      logger.setContext({ avatarId: 'test-avatar', platform: 'telegram' });
      logger.info('contextualized');

      const entry = JSON.parse(consoleLogs[0]);
      expect(entry.avatarId).toBe('test-avatar');
      expect(entry.platform).toBe('telegram');
    });
  });

  describe('error logging', () => {
    it('should include Error details', () => {
      const err = new Error('something broke');
      logger.error('failure', err);

      const entry = JSON.parse(consoleErrors[0]);
      expect(entry.errorName).toBe('Error');
      expect(entry.errorMessage).toBe('something broke');
      expect(entry.errorStack).toBeDefined();
    });

    it('should handle non-Error objects', () => {
      logger.error('failure', { message: 'sdk error', code: 'ThrottlingException' });

      const entry = JSON.parse(consoleErrors[0]);
      expect(entry.errorMessage).toBe('sdk error');
      expect(entry.errorCode).toBe('ThrottlingException');
    });
  });

  describe('child logger', () => {
    it('should inherit parent context and level', () => {
      logger.setMinLevel('warn');
      logger.setContext({ avatarId: 'parent' });

      const child = logger.child({ platform: 'discord' });
      expect(child.getMinLevel()).toBe('warn');

      child.info('should be suppressed');
      child.warn('child warning');

      expect(consoleLogs.length).toBe(0);
      expect(consoleWarns.length).toBe(1);

      const entry = JSON.parse(consoleWarns[0]);
      expect(entry.avatarId).toBe('parent');
      expect(entry.platform).toBe('discord');
    });
  });
});
