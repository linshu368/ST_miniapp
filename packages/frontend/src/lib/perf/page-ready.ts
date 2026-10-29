'use client';

import { useEffect, useRef } from 'react';
import { usePathname } from 'next/navigation';

import { markPageFailed, markPageReady } from './page-tracker';

/**
 * 页面声明「可用/拿到最新数据」。条件由页面自己判断，首次为 true 时记一次。
 * 用 effect 而不是渲染期副作用：渲染可能被丢弃重来，不能在那里上报。
 */
export function usePageReady(
  route: string,
  ready: boolean,
  fresh = false,
  failed = false,
  cache: 'cache' | 'fetch' | 'unknown' = 'unknown'
): void {
  const pathname = usePathname();
  useEffect(() => {
    let cancelled = false;
    // 子页面 effect 可能早于根路由 tracker；同一 commit 后再登记，避免缓存秒开漏报。
    queueMicrotask(() => {
      if (cancelled) return;
      if (failed && !ready) markPageFailed(route, pathname);
      else if (ready) markPageReady(route, 'content', pathname, cache);
    });
    return () => {
      cancelled = true;
    };
  }, [route, pathname, ready, failed, cache]);
  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled && fresh) markPageReady(route, 'fresh', pathname);
    });
    return () => {
      cancelled = true;
    };
  }, [route, pathname, fresh]);
}

/**
 * 「本次进页是否真的拿到了新数据」：必须观察到一次请求在途再结束。
 * 有本地缓存秒开、或恢复快照而跳过请求时，不会误记成「0 毫秒拿到最新数据」。
 */
export function useFreshAfterFetch(isFetching: boolean, hasData: boolean, failed = false): boolean {
  const pathname = usePathname();
  const owner = useRef(pathname);
  const sawFetching = useRef(false);
  if (owner.current !== pathname) {
    owner.current = pathname;
    sawFetching.current = false;
  }
  if (isFetching) sawFetching.current = true;
  return sawFetching.current && !isFetching && hasData && !failed;
}
