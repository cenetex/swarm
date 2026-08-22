import type { HttpRequest } from "@swarm/core";
import { z } from 'zod';

export class RequestValidationError extends Error {
  readonly statusCode = 400;
  readonly details?: unknown;

  constructor(message: string, details?: unknown) {
    super(message);
    this.name = 'RequestValidationError';
    this.details = details;
  }
}

export function isRequestValidationError(error: unknown): error is RequestValidationError {
  return error instanceof RequestValidationError;
}

export function validateRequestBody<TSchema extends z.ZodTypeAny>(schema: TSchema) {
  return async (event: HttpRequest): Promise<z.infer<TSchema>> => {
    if (!event.body) {
      throw new RequestValidationError('Request body required');
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(event.body);
    } catch (error) {
      throw new RequestValidationError('Malformed JSON body', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    const result = schema.safeParse(parsedJson);
    if (!result.success) {
      throw new RequestValidationError('Invalid request body', {
        issues: result.error.flatten(),
      });
    }

    return result.data;
  };
}
