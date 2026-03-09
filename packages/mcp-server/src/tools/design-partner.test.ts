/**
 * Design Partner Admin Tools — Tests
 */
import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ============================================================================
// Source verification tests
// ============================================================================

describe('Design Partner Tools — source verification', () => {
  const src = readFileSync(resolve(__dirname, 'design-partner.ts'), 'utf-8');

  it('should define create_invite_code tool', () => {
    expect(src).toContain("name: 'create_invite_code'");
  });

  it('should define list_invite_codes tool', () => {
    expect(src).toContain("name: 'list_invite_codes'");
  });

  it('should define revoke_invite_code tool', () => {
    expect(src).toContain("name: 'revoke_invite_code'");
  });

  it('should restrict all tools to admin toolset', () => {
    const adminMatches = src.match(/toolset: 'admin'/g);
    expect(adminMatches).not.toBeNull();
    expect(adminMatches!.length).toBe(3);
  });

  it('should check isAdmin on all execute functions', () => {
    const adminChecks = src.match(/context\.session\?\.isAdmin/g);
    expect(adminChecks).not.toBeNull();
    expect(adminChecks!.length).toBe(3);
  });

  it('should restrict to admin-ui platform', () => {
    const platformMatches = src.match(/platforms: \['admin-ui'\]/g);
    expect(platformMatches).not.toBeNull();
    expect(platformMatches!.length).toBe(3);
  });

  it('should accept pro or enterprise plan for create', () => {
    expect(src).toContain("z.enum(['pro', 'enterprise'])");
  });

  it('should uppercase invite codes before revoking', () => {
    expect(src).toContain('input.code.toUpperCase()');
  });
});

describe('Design Partner Tools — index integration', () => {
  const indexSrc = readFileSync(resolve(__dirname, 'index.ts'), 'utf-8');

  it('should export createDesignPartnerTools from index', () => {
    expect(indexSrc).toContain('createDesignPartnerTools');
  });

  it('should export DesignPartnerServices type from index', () => {
    expect(indexSrc).toContain('DesignPartnerServices');
  });

  it('should include designPartner in AllServices', () => {
    expect(indexSrc).toContain('designPartner?');
  });

  it('should register design partner tools in registerAllTools', () => {
    expect(indexSrc).toContain('services.designPartner');
    expect(indexSrc).toContain('createDesignPartnerTools(services.designPartner)');
  });
});

describe('Design Partner Services adapter — source verification', () => {
  const adapterSrc = readFileSync(
    resolve(__dirname, '../../../../packages/admin-api/src/services/mcp/design-partner-services.ts'),
    'utf-8',
  );

  it('should import from billing/design-partner service', () => {
    expect(adapterSrc).toContain("from '../billing/design-partner.js'");
  });

  it('should export createDesignPartnerServices function', () => {
    expect(adapterSrc).toContain('export function createDesignPartnerServices');
  });

  it('should set maxPartners from MAX_DESIGN_PARTNERS', () => {
    expect(adapterSrc).toContain('maxPartners: dp.MAX_DESIGN_PARTNERS');
  });

  it('should delegate createInviteCode to billing service', () => {
    expect(adapterSrc).toContain('dp.createInviteCode');
  });

  it('should delegate revokeInviteCode to billing service', () => {
    expect(adapterSrc).toContain('dp.revokeInviteCode');
  });

  it('should delegate listPartners to billing service', () => {
    expect(adapterSrc).toContain('dp.listPartners');
  });

  it('should delegate getDesignPartnerMeta to billing service', () => {
    expect(adapterSrc).toContain('dp.getDesignPartnerMeta');
  });
});

describe('MCP Adapter — design partner wiring', () => {
  const adapterSrc = readFileSync(
    resolve(__dirname, '../../../../packages/admin-api/src/services/platform/mcp-adapter.ts'),
    'utf-8',
  );

  it('should import createDesignPartnerServices', () => {
    expect(adapterSrc).toContain('createDesignPartnerServices');
  });

  it('should only provide designPartner services to admin sessions', () => {
    expect(adapterSrc).toContain('session.isAdmin ? createDesignPartnerServices()');
  });
});
