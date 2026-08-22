/**
 * Factory integration test.
 */
import { describe, it, expect } from 'bun:test';
import { createLocalServices } from './factories.js';

describe('createLocalServices', () => {
  it('returns all service components', () => {
    const services = createLocalServices({ dbPath: ':memory:' });
    expect(services.store).toBeDefined();
    expect(services.dynamoAdapter).toBeDefined();
    expect(services.secrets).toBeDefined();
    expect(services.blobs).toBeDefined();
    expect(services.queue).toBeDefined();
    expect(typeof services.shutdown).toBe('function');
  });

  it('secrets is locked initially', () => {
    const { secrets } = createLocalServices({ dbPath: ':memory:' });
    expect(secrets.isUnlocked).toBe(false);
  });

  it('secrets can be initialized and unlocked', async () => {
    const { secrets } = createLocalServices({ dbPath: ':memory:' });
    await secrets.initialize('test-password');
    expect(secrets.isUnlocked).toBe(true);
  });

  it('store can perform basic CRUD', async () => {
    const { store } = createLocalServices({ dbPath: ':memory:' });
    await store.put({ pk: 'TEST', sk: 'A', value: 'it works' });
    const item = await store.get<Record<string, unknown>>({ pk: 'TEST', sk: 'A' });
    expect(item!.value).toBe('it works');
  });

  it('queue can send and receive', async () => {
    const { queue } = createLocalServices({ dbPath: ':memory:' });
    await queue.send('events', { type: 'test' });
    const msgs = await queue.receive('events');
    expect(msgs).toHaveLength(1);
    expect(msgs[0].body).toEqual({ type: 'test' });
  });

  it('shutdown closes the database', () => {
    const services = createLocalServices({ dbPath: ':memory:' });
    services.shutdown();
  });
});
