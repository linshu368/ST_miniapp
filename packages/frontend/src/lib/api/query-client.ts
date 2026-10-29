import { QueryClient } from '@tanstack/react-query';

/** 单例工厂：在 Providers 里每次渲染使用同一个 QueryClient。 */
export function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // miniApp 场景：移动端 WebView，减少不必要的抖动
        staleTime: 30_000,
        gcTime: 5 * 60_000,
        refetchOnWindowFocus: false,
        // 传输层 GET 已在 apiClient 内做最多一次有限重试；这里再重试会把一次
        // 页面查询放大成最多四次请求，并让离页后的旧 query 继续占用连接。
        retry: false,
      },
      mutations: {
        retry: 0,
      },
    },
  });
}

let browserQueryClient: QueryClient | undefined;

export function getQueryClient(): QueryClient {
  if (typeof window === 'undefined') {
    // SSR：每次请求新建
    return makeQueryClient();
  }
  if (!browserQueryClient) browserQueryClient = makeQueryClient();
  return browserQueryClient;
}
