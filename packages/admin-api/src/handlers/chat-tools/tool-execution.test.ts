/**
 * Tool execution tests (pure utilities).
 */
import { describe, expect, it, beforeAll } from 'bun:test';
import { injectTestClients } from '../__test-helpers__/inject-clients.js';


let getToolArgs: typeof import('./tool-execution.js').getToolArgs;

beforeAll(async () => {
  await injectTestClients();

  const mod = await import('./tool-execution.js');
  getToolArgs = mod.getToolArgs;
});

describe('getToolArgs', () => {
  it('extracts object arguments', () => {
    const tc = { id: '1', name: 'test', arguments: { key: 'value' }, type: 'function' as const };
    expect(getToolArgs(tc)).toEqual({ key: 'value' });
  });

  it('returns empty object when arguments is a string', () => {
    const tc = { id: '1', name: 'test', arguments: 'not-an-object', type: 'function' as const };
    expect(getToolArgs(tc as any)).toEqual({});
  });

  it('returns empty object when arguments is null', () => {
    const tc = { id: '1', name: 'test', arguments: null, type: 'function' as const };
    expect(getToolArgs(tc as any)).toEqual({});
  });

  it('returns empty object when arguments is undefined', () => {
    const tc = { id: '1', name: 'test', type: 'function' as const } as any;
    expect(getToolArgs(tc)).toEqual({});
  });

  it('returns empty object when arguments is a number', () => {
    const tc = { id: '1', name: 'test', arguments: 42, type: 'function' as const };
    expect(getToolArgs(tc as any)).toEqual({});
  });
});
