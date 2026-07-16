import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export type AdminEnvironment = 'test' | 'production';

const configs: Record<AdminEnvironment, { url: string; anonKey: string }> = {
  test: {
    url: import.meta.env.VITE_ADMIN_TEST_SUPABASE_URL || '',
    anonKey: import.meta.env.VITE_ADMIN_TEST_SUPABASE_ANON_KEY || '',
  },
  production: {
    url: import.meta.env.VITE_ADMIN_PROD_SUPABASE_URL || '',
    anonKey: import.meta.env.VITE_ADMIN_PROD_SUPABASE_ANON_KEY || '',
  },
};

const clients = new Map<AdminEnvironment, SupabaseClient>();

export function getAdminClient(environment: AdminEnvironment): SupabaseClient {
  const cached = clients.get(environment);
  if (cached) return cached;

  const config = configs[environment];
  if (!config.url || !config.anonKey) {
    throw new Error(
      environment === 'test' ? '测试环境 Supabase 未配置' : '生产环境 Supabase 未配置'
    );
  }

  const client = createClient(config.url, config.anonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      storageKey: `mijing-admin-auth-${environment}`,
    },
  });
  clients.set(environment, client);
  return client;
}

export function isEnvironmentConfigured(environment: AdminEnvironment): boolean {
  return Boolean(configs[environment].url && configs[environment].anonKey);
}
