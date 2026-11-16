import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
vi.mock('../features/admin-access/session.js', () => ({
  authorizeAdminOperator: async () => true,
}));
import { buildSupabaseProxyTarget } from './admin-supabase-proxy.js';
import adminRoutes from './admin-supabase-proxy.js';
afterEach(() => vi.unstubAllGlobals());

describe('buildSupabaseProxyTarget', () => {
  it('reports model timeouts as 504 without returning provider error text', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new DOMException('private transport detail', 'TimeoutError'))
    );
    const app = Fastify();
    await app.register(adminRoutes);
    try {
      const result = await app.inject({
        method: 'POST',
        url: '/api/admin/image-text-model/test',
        payload: {
          url: 'https://provider.example/chat',
          api_key: 'test-only-placeholder',
          model: 'fixture',
        },
      });
      expect(result.statusCode).toBe(504);
      expect(result.json().error.code).toBe('MODEL_TEST_TIMEOUT');
      expect(result.body).not.toContain('private');
    } finally {
      await app.close();
    }
  });
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
