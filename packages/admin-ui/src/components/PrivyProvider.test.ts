import { describe, it, expect } from 'bun:test';
import { buildPrivyConfig } from './PrivyProvider.js';

describe('local authentication provider config', () => {
  it('does not configure a third-party authentication SDK', async () => {
    expect(await buildPrivyConfig()).toEqual({});
  });
});
