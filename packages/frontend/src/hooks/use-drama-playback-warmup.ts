'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

import { canPrefetchInBackground } from '@/lib/background-prefetch';
import { preloadDramaHls } from '@/lib/drama-media-source';
import { afterEntryBackground } from '@/lib/entry-phase';
import { afterNavigationQuietWindow } from '@/lib/navigation-quiet-window';

/** 会话首播几乎都从片库封面进放映页；续看进剧详情的比例很小，不为它预取。 */
type DramaPlayerRoute = '/watch';

function afterIdle(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof window.requestIdleCallback === 'function') {
      window.requestIdleCallback(() => resolve(), { timeout: 1500 });
    } else {
      window.setTimeout(resolve, 250);
    }
  });
}

/**
 * 提前加载起播要用的代码，让第一次起播不用现场下载 JS。
 *
 * - 播放页（不传参数）：hls.js 本身就在起播关键路径上，等页面切换的静默期结束就加载，
 *   不受弱网/省流量限制。
 * - 片库页（传 `playerRoute`）：这里只是预测用户会起播，所以等关键内容和背景任务都放行后再在空闲时
 *   加载 hls.js 并预取放映页路由，弱网/省流量时跳过。会话首播几乎都从片库点封面进来，
 *   用户点击前平均会浏览约 10 秒，时间足够提前加载。
 */
export function useDramaPlaybackWarmup(playerRoute?: DramaPlayerRoute): void {
  const router = useRouter();
  useEffect(() => {
    let cancelled = false;
    if (!playerRoute) {
      void afterNavigationQuietWindow().then(() => {
        if (!cancelled) preloadDramaHls();
      });
    } else {
      void afterEntryBackground()
        .then(afterNavigationQuietWindow)
        .then(afterIdle)
        .then(() => {
          if (cancelled || !canPrefetchInBackground()) return;
          preloadDramaHls();
          router.prefetch(playerRoute);
        });
    }
    return () => {
      cancelled = true;
    };
  }, [playerRoute, router]);
}
