import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export type AdminEnvironment = 'test' | 'production';

const configs: Record<AdminEnvironment, { url: string; anonKey: string; apiUrl: string }> = {
  test: {
    url: import.meta.env.VITE_ADMIN_TEST_SUPABASE_URL || '',
    anonKey: import.meta.env.VITE_ADMIN_TEST_SUPABASE_ANON_KEY || '',
    apiUrl: import.meta.env.VITE_ADMIN_TEST_API_URL || '',
  },
  production: {
    url: import.meta.env.VITE_ADMIN_PROD_SUPABASE_URL || '',
    anonKey: import.meta.env.VITE_ADMIN_PROD_SUPABASE_ANON_KEY || '',
    apiUrl: import.meta.env.VITE_ADMIN_PROD_API_URL || '',
  },
};

const clients = new Map<AdminEnvironment, SupabaseClient>();
const RETRY_DELAYS_MS = [350, 1_000];

export function normalizeEmptyLogoutRequest(
  input: RequestInfo | URL,
  init?: RequestInit
): RequestInit | undefined {
  const url =
    typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
  if (method !== 'POST' || !url.includes('/auth/v1/logout') || init?.body != null) return init;

  const headers = new Headers(
    init?.headers ?? (input instanceof Request ? input.headers : undefined)
  );
  if (!headers.get('content-type')?.toLowerCase().includes('application/json')) return init;
  return { ...(init ?? {}), headers, body: '{}' };
}

const resilientFetch: typeof fetch = async (input, init) => {
  let lastError: unknown;
  const normalizedInit = normalizeEmptyLogoutRequest(input, init);

  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      const response = await fetch(input, normalizedInit);
      if (response.status < 500 || attempt === RETRY_DELAYS_MS.length) return response;
      lastError = new Error(`Supabase 暂时不可用（HTTP ${response.status}）`);
    } catch (error) {
      lastError = error;
      if (attempt === RETRY_DELAYS_MS.length) throw error;
    }

    await new Promise((resolve) => window.setTimeout(resolve, RETRY_DELAYS_MS[attempt]));
  }

  throw lastError instanceof Error ? lastError : new Error('Supabase 网络请求失败');
};

export function getAdminClient(environment: AdminEnvironment): SupabaseClient {
  const cached = clients.get(environment);
  if (cached) return cached;

  const config = configs[environment];
  if (!config.url || !config.anonKey) {
    throw new Error(
      environment === 'test' ? '测试环境 Supabase 未配置' : '生产环境 Supabase 未配置'
    );
  }

  if (!config.apiUrl) {
    throw new Error(environment === 'test' ? '测试环境后端地址未配置' : '生产环境后端地址未配置');
  }

  // 浏览器只访问同一环境的 MiniApp 后端，由后端转发 Supabase 请求。
  // 这样登录和 RPC 不再依赖浏览器到 Supabase 的跨域预检，避免 WKWebView/
  // Firefox 将网络抖动误报成 CORS 并使草稿自动保存停摆。
  const supabaseProxyUrl = `${config.apiUrl.replace(/\/+$/, '')}/api/admin/supabase`;
  const client = createClient(supabaseProxyUrl, config.anonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      storageKey: `mijing-admin-auth-${environment}`,
    },
    global: {
      fetch: resilientFetch,
    },
  });
  clients.set(environment, client);
  return client;
}

export function isEnvironmentConfigured(environment: AdminEnvironment): boolean {
  return Boolean(
    configs[environment].url && configs[environment].anonKey && configs[environment].apiUrl
  );
}

export function getAdminApiUrl(environment: AdminEnvironment): string {
  const apiUrl = configs[environment].apiUrl.replace(/\/+$/, '');
  if (!apiUrl) {
    throw new Error(environment === 'test' ? '测试环境后端地址未配置' : '生产环境后端地址未配置');
  }
  return apiUrl;
}

export function getAdminSupabaseUrl(environment: AdminEnvironment): string {
  return configs[environment].url.replace(/\/+$/, '');
}
