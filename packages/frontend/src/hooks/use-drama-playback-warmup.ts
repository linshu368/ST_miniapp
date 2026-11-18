'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

import { prefetchDramaPlayback } from '@/lib/api/drama';
import { canPrefetchInBackground } from '@/lib/background-prefetch';
import { resumeVideoId } from '@/stores/drama-library-store';
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

/** 会话首播点的封面前 3 部占 49%、前 5 部占 62%；4 张约是首屏，成本见任务 design。 */
const VISIBLE_COVER_PREFETCH_LIMIT = 4;

/**
 * 取视口里按 DOM 顺序的前几张放映封面（含「随便看看」的起始剧），提前取址和子清单。
 * 片库不虚拟化：卡片已挂载，屏外卡片按 content-visibility 占位高度排在视口之外。
 */
function prefetchVisibleDramaCovers(): void {
  const viewportHeight = window.innerHeight;
  const ids: string[] = [];
  for (const node of document.querySelectorAll<HTMLElement>('[data-drama-cover][data-drama-id]')) {
    const rect = node.getBoundingClientRect();
    const id = node.dataset.dramaId;
    if (!id || rect.width === 0 || rect.bottom <= 0 || rect.top >= viewportHeight) continue;
    if (!ids.includes(id)) ids.push(id);
    if (ids.length >= VISIBLE_COVER_PREFETCH_LIMIT) break;
  }
  for (const id of ids) prefetchDramaPlayback(id, resumeVideoId(id), 'visible_cover');
}

/**
 * 提前加载起播要用的代码，让第一次起播不用现场下载 JS。
 *
 * - 播放页（不传参数）：hls.js 本身就在起播关键路径上，等页面切换的静默期结束就加载，
 *   不受弱网/省流量限制。
 * - 片库页（传 `playerRoute`）：这里只是预测用户会起播，所以等关键内容和背景任务都放行后再在空闲时
 *   加载 hls.js、预取放映页路由，并预取可见封面的地址与子清单，弱网/省流量时跳过。
 *   会话首播几乎都从片库点封面进来，用户点击前平均会浏览约 10 秒，时间足够提前加载。
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
          prefetchVisibleDramaCovers();
        });
    }
    return () => {
      cancelled = true;
    };
  }, [playerRoute, router]);
}
