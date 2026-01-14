import { describe, it, expect } from 'vitest';
import { routeTools } from './tool-router.js';

const tools = [
  { name: 'send_message', description: '', inputSchema: { safeParse: () => ({ success: true, data: {} }) } as any, execute: false, toolset: 'core', tags: [] },
  { name: 'generate_image', description: '', inputSchema: { safeParse: () => ({ success: true, data: {} }) } as any, execute: false, toolset: 'media', tags: ['image'] },
  { name: 'get_wallet_balance', description: '', inputSchema: { safeParse: () => ({ success: true, data: {} }) } as any, execute: false, toolset: 'wallet', tags: ['wallet'] },
];

describe('routeTools', () => {
  it('selects media toolset for image requests', () => {
    const result = routeTools(tools as any, { text: 'please generate an image' });
    expect(result.toolsets).toContain('media');
    expect(result.tools.some(t => t.name === 'generate_image')).toBe(true);
  });

  it('selects wallet toolset for balance requests', () => {
    const result = routeTools(tools as any, { text: 'check my solana wallet balance' });
    expect(result.toolsets).toContain('wallet');
    expect(result.tools.some(t => t.name === 'get_wallet_balance')).toBe(true);
  });

  it('respects max toolsets', () => {
    const result = routeTools(tools as any, { text: 'image and wallet', maxToolsets: 2 });
    expect(result.toolsets.length).toBeLessThanOrEqual(2);
  });
});
