/**
 * LocalSecretsAdapter tests.
 */
import { describe, it, expect, mock } from 'bun:test';
import { LocalSecretsAdapter } from './secrets-adapter.js';
import type { SecretsService } from '@swarm/core';

function makeCmd(name: string, input: Record<string, unknown>) {
  return { constructor: { name }, input };
}

function stubSvc(overrides: Partial<SecretsService> = {}): SecretsService {
  return {
    getSecret: mock(async (_n: string) => { throw new Error('not found'); }),
    getSecretJson: mock(async <T>(_n: string): Promise<T> => { throw new Error('not found'); }),
    ...overrides,
  };
}

describe('LocalSecretsAdapter', () => {
  describe('GetSecretValue', () => {
    it('returns plain string secret', async () => {
      const svc = stubSvc({ getSecret: mock(async (n: string) => n === 's1' ? 'val' : (() => { throw new Error('x'); })()) });
      const a = new LocalSecretsAdapter(svc);
      const r = await a.send(makeCmd('GetSecretValue', { SecretId: 's1' }));
      expect(r.$metadata.httpStatusCode).toBe(200);
      expect(r.SecretString).toBe('val');
    });

    it('falls back to getSecretJson when getSecret throws', async () => {
      const svc = stubSvc({
        getSecretJson: mock(async () => ({ api_key: 'jk' })),
      });
      const a = new LocalSecretsAdapter(svc);
      const r = await a.send(makeCmd('GetSecretValue', { SecretId: 's2' }));
      expect(r.$metadata.httpStatusCode).toBe(200);
      expect(JSON.parse(r.SecretString as string)).toEqual({ api_key: 'jk' });
    });

    it('throws ResourceNotFoundException when both fail', async () => {
      const a = new LocalSecretsAdapter(stubSvc());
      try {
        await a.send(makeCmd('GetSecretValue', { SecretId: 'nope' }));
        expect.unreachable();
      } catch (e: any) {
        expect(e.name).toBe('ResourceNotFoundException');
        expect(e.$metadata.httpStatusCode).toBe(404);
      }
    });
  });

  describe('PutSecretValue', () => {
    it('stores and flushes', async () => {
      const ss = mock(async (_k: string, _v: string) => {});
      const fl = mock(async () => {});
      const svc = { getSecret: mock(async () => { throw new Error('x'); }), getSecretJson: mock(async () => { throw new Error('x'); }), setSecret: ss, flush: fl } as any;
      const a = new LocalSecretsAdapter(svc);
      const r = await a.send(makeCmd('PutSecretValue', { SecretId: 'k', SecretString: 'v' }));
      expect(r.$metadata.httpStatusCode).toBe(200);
      expect(ss).toHaveBeenCalledWith('k', 'v');
      expect(fl).toHaveBeenCalled();
    });

    it('no-ops when SecretId is empty', async () => {
      const svc = { getSecret: mock(async () => { throw new Error('x'); }), getSecretJson: mock(async () => { throw new Error('x'); }), setSecret: mock(async () => {}), flush: mock(async () => {}) } as any;
      const a = new LocalSecretsAdapter(svc);
      await a.send(makeCmd('PutSecretValue', { SecretId: '', SecretString: 'x' }));
      expect(svc.setSecret).not.toHaveBeenCalled();
    });

    it('swallows errors', async () => {
      const svc = { getSecret: mock(async () => { throw new Error('x'); }), getSecretJson: mock(async () => { throw new Error('x'); }), setSecret: mock(async () => { throw new Error('boom'); }), flush: mock(async () => {}) } as any;
      const a = new LocalSecretsAdapter(svc);
      const r = await a.send(makeCmd('PutSecretValue', { SecretId: 'x', SecretString: 'y' }));
      expect(r.$metadata.httpStatusCode).toBe(200);
    });
  });

  describe('DeleteSecretValue', () => {
    it('deletes and flushes', async () => {
      const ds = mock(async (_k: string) => {});
      const fl = mock(async () => {});
      const svc = { getSecret: mock(async () => { throw new Error('x'); }), getSecretJson: mock(async () => { throw new Error('x'); }), deleteSecret: ds, flush: fl } as any;
      const a = new LocalSecretsAdapter(svc);
      const r = await a.send(makeCmd('DeleteSecretValue', { SecretId: 'd' }));
      expect(r.$metadata.httpStatusCode).toBe(200);
      expect(ds).toHaveBeenCalledWith('d');
      expect(fl).toHaveBeenCalled();
    });

    it('no-ops when SecretId empty', async () => {
      const svc = { getSecret: mock(async () => { throw new Error('x'); }), getSecretJson: mock(async () => { throw new Error('x'); }), deleteSecret: mock(async () => {}), flush: mock(async () => {}) } as any;
      const a = new LocalSecretsAdapter(svc);
      await a.send(makeCmd('DeleteSecretValue', { SecretId: '' }));
      expect(svc.deleteSecret).not.toHaveBeenCalled();
    });

    it('swallows errors', async () => {
      const svc = { getSecret: mock(async () => { throw new Error('x'); }), getSecretJson: mock(async () => { throw new Error('x'); }), deleteSecret: mock(async () => { throw new Error('boom'); }), flush: mock(async () => {}) } as any;
      const a = new LocalSecretsAdapter(svc);
      const r = await a.send(makeCmd('DeleteSecretValue', { SecretId: 'x' }));
      expect(r.$metadata.httpStatusCode).toBe(200);
    });
  });

  describe('unsupported command', () => {
    it('throws for unknown commands', async () => {
      const a = new LocalSecretsAdapter(stubSvc());
      try {
        await a.send(makeCmd('ListSecrets', {}));
        expect.unreachable();
      } catch (e: any) {
        expect(e.message).toMatch(/unsupported command/);
      }
    });
  });

  describe('name matching edge cases', () => {
    it('matches Bun-compiled variant', async () => {
      const svc = stubSvc({ getSecret: mock(async () => 'bun') });
      const a = new LocalSecretsAdapter(svc);
      const r = await a.send(makeCmd('GetSecretValue_Bun', { SecretId: 'x' }));
      expect(r.$metadata.httpStatusCode).toBe(200);
      expect(r.SecretString).toBe('bun');
    });

    it('empty constructor name throws unsupported', async () => {
      const a = new LocalSecretsAdapter(stubSvc());
      try {
        await a.send({ input: {} } as any);
        expect.unreachable();
      } catch (e: any) {
        expect(e.message).toMatch(/unsupported/);
      }
    });
  });
});
