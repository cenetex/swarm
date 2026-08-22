/**
 * LocalLambdaAdapter tests.
 */
import { describe, it, expect } from 'bun:test';
import { LocalLambdaAdapter } from './lambda-adapter.js';

function makeCmd(name: string, input: Record<string, unknown>) {
  return {
    constructor: { name },
    input,
  };
}

describe('LocalLambdaAdapter', () => {
  const lambda = new LocalLambdaAdapter();

  describe('InvokeCommand', () => {
    it('returns a success stub response', async () => {
      const result = await lambda.send(makeCmd('InvokeCommand', {
        FunctionName: 'my-func',
        Payload: JSON.stringify({ key: 'value' }),
      }));
      expect(result.$metadata.httpStatusCode).toBe(200);
      expect(result.StatusCode).toBe(200);
      expect(result.Payload).toBeInstanceOf(Buffer);
      const parsed = JSON.parse((result.Payload as Buffer).toString());
      expect(parsed.status).toBe('local-noop');
    });

    it('matches Bun-compiled variant names', async () => {
      const result = await lambda.send(makeCmd('InvokeCommand_Bun', {
        FunctionName: 'other-func',
      }));
      expect(result.$metadata.httpStatusCode).toBe(200);
      expect(result.StatusCode).toBe(200);
    });
  });

  describe('unsupported command', () => {
    it('throws for unknown commands', async () => {
      try {
        await lambda.send(makeCmd('ListFunctionsCommand', {}));
        expect.unreachable();
      } catch (e: any) {
        expect(e.message).toMatch(/unsupported command/);
      }
    });

    it('throws for empty constructor name', async () => {
      try {
        await lambda.send({ input: {} } as any);
        expect.unreachable();
      } catch (e: any) {
        expect(e.message).toMatch(/unsupported/);
      }
    });
  });
});

