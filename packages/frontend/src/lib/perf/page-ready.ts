'use client';

import { useEffect, useRef } from 'react';

import { markPageReady } from './page-tracker';

/**
 * 页面声明「可用/拿到最新数据」。条件由页面自己判断，首次为 true 时记一次。
 * 用 effect 而不是渲染期副作用：渲染可能被丢弃重来，不能在那里上报。
 */
export function usePageReady(route: string, ready: boolean, fresh = false): void {
  useEffect(() => {
    if (ready) markPageReady(route, 'content');
  }, [route, ready]);
  useEffect(() => {
    if (fresh) markPageReady(route, 'fresh');
  }, [route, fresh]);
}

/**
 * 「本次进页是否真的拿到了新数据」：必须观察到一次请求在途再结束。
 * 有本地缓存秒开、或恢复快照而跳过请求时，不会误记成「0 毫秒拿到最新数据」。
 */
export function useFreshAfterFetch(isFetching: boolean, hasData: boolean): boolean {
  const sawFetching = useRef(false);
  if (isFetching) sawFetching.current = true;
  return sawFetching.current && !isFetching && hasData;
}
