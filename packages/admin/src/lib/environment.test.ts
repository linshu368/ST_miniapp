import { describe, expect, it } from 'vitest';
import { normalizeEmptyLogoutRequest } from './environment';

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
