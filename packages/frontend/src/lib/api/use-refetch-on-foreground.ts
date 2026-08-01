'use client';

import { useEffect } from 'react';

/**
 * Telegram WebView 里 focus 事件不可靠，小程序被切走再切回来只会触发 visibilitychange，
 * 少了这一下，用户回到前台最多要再等一个轮询周期才看得到新的红点。
 */
export function useRefetchOnForeground(refetch: () => void): void {
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') refetch();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [refetch]);
}
