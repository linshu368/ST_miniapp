import { describe, expect, it } from 'vitest';
import { buildSupabaseProxyTarget } from './admin-supabase-proxy.js';

describe('buildSupabaseProxyTarget', () => {
  it('keeps the approved Supabase path and query string', () => {
    const target = buildSupabaseProxyTarget(
      'https://project.supabase.co/',
      '/rest/v1/rpc/upsert_config_draft',
      '/api/admin/supabase/rest/v1/rpc/upsert_config_draft?select=*'
    );
    expect(target.toString()).toBe(
      'https://project.supabase.co/rest/v1/rpc/upsert_config_draft?select=*'
    );
  });

  it('rejects paths outside the Supabase APIs used by Admin', () => {
    expect(() =>
      buildSupabaseProxyTarget(
        'https://project.supabase.co',
        'functions/v1/arbitrary',
        '/api/admin/supabase/functions/v1/arbitrary'
      )
    ).toThrow('Unsupported Supabase proxy path');
  });
});
