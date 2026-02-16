/**
 * Telegram Type Guards
 * 
 * Type-safe utilities for extracting data from Telegram Update objects.
 * These helpers replace unsafe `as any` type assertions with proper type guards.
 */
import type { Update, Message } from 'grammy/types';

/**
 * Extract the main message from a Telegram Update.
 * Handles regular messages, edited messages, and channel posts.
 */
export function getMessageFromUpdate(update: Update): Message | undefined {
  if ('message' in update && update.message) {
    return update.message;
  }
  if ('edited_message' in update && update.edited_message) {
    return update.edited_message;
  }
  if ('channel_post' in update && update.channel_post) {
    return update.channel_post;
  }
  return undefined;
}

/**
 * Type guard to check if an error object has a message property
 */
export function isErrorWithMessage(error: unknown): error is { message: string } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof (error as { message: unknown }).message === 'string'
  );
}

/**
 * Type guard to check if an error has a code property
 */
export function isErrorWithCode(error: unknown): error is { code: number | string } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    ((error as { code: unknown }).code !== undefined)
  );
}

/**
 * Type guard to check if an error has a status property
 */
export function isErrorWithStatus(error: unknown): error is { status: number } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    typeof (error as { status: unknown }).status === 'number'
  );
}

/**
 * Type guard to check if an error has a statusCode property
 */
export function isErrorWithStatusCode(error: unknown): error is { statusCode: number } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'statusCode' in error &&
    typeof (error as { statusCode: unknown }).statusCode === 'number'
  );
}

/**
 * Safely extract error message from unknown error
 */
export function getErrorMessage(error: unknown): string {
  if (isErrorWithMessage(error)) {
    return error.message;
  }
  return String(error);
}

/**
 * Check if error is a rate limit error (429)
 */
export function isRateLimitError(error: unknown): boolean {
  if (isErrorWithCode(error) && error.code === 429) {
    return true;
  }
  if (isErrorWithStatus(error) && error.status === 429) {
    return true;
  }
  if (isErrorWithStatusCode(error) && error.statusCode === 429) {
    return true;
  }
  return false;
}

/**
 * Twitter tweet with referenced_tweets field
 * Used for type-safe access to envelope.raw in Twitter handlers
 */
export type TwitterRawTweet = {
  referenced_tweets?: Array<{ type: string; id: string }>;
};

/**
 * Type guard to check if raw data has referenced_tweets structure
 */
export function isTwitterRawTweet(raw: unknown): raw is TwitterRawTweet {
  return (
    typeof raw === 'object' &&
    raw !== null &&
    (!('referenced_tweets' in raw) ||
      (Array.isArray((raw as { referenced_tweets?: unknown }).referenced_tweets)))
  );
}

