'use client';

import { useEffect } from 'react';

/**
 * Telegram WebView 里 focus 事件不可靠，小程序被切走再切回来只会触发 visibilitychange，
 * 少了这一下，用户回到前台最多要再等一个轮询周期才看得到新的红点。
 *
 * `cancelRefetch: false`：同一 key 可能有多个组件同时注册，默认的 cancelRefetch 会取消前一个再重发，
 * 而 queryFn 不接 signal，被取消的 HTTP 照样发出——切回前台就变成每个端点 N 次请求。
 * 不取消则后到的调用复用进行中的请求。
 */
export function useRefetchOnForeground(
  refetch: (options: { cancelRefetch: boolean }) => unknown,
  enabled = true
): void {
  useEffect(() => {
    if (!enabled) return;
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refetch({ cancelRefetch: false });
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [refetch, enabled]);
}
