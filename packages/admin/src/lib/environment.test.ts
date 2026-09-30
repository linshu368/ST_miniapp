import { describe, expect, it } from 'vitest';
import { normalizeEmptyLogoutRequest, resolveAdminTestApiUrl } from './environment';

describe('resolveAdminTestApiUrl', () => {
  it('uses the PR Preview backend when Vite injected one', () => {
    expect(
      resolveAdminTestApiUrl(
        'https://stminiapp-development.up.railway.app',
        'https://stminiapp-pr-364.up.railway.app'
      )
    ).toBe('https://stminiapp-pr-364.up.railway.app');
  });

  it('keeps the configured backend outside a PR Preview', () => {
    expect(resolveAdminTestApiUrl('https://stminiapp-development.up.railway.app', '')).toBe(
      'https://stminiapp-development.up.railway.app'
    );
  });
});

describe('normalizeEmptyLogoutRequest', () => {
  it('adds an empty JSON object to proxied logout requests', () => {
    const init = normalizeEmptyLogoutRequest(
      'https://api.example.com/api/admin/supabase/auth/v1/logout?scope=global',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      }
    );
    expect(init?.body).toBe('{}');
  });

  it('does not alter normal API requests', () => {
    const init = {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"a":1}',
    };
    expect(normalizeEmptyLogoutRequest('https://api.example.com/rest/v1/rpc/test', init)).toBe(
      init
    );
  });
});
