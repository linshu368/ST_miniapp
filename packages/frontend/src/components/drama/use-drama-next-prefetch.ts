'use client';

import { useCallback, useEffect, useRef } from 'react';
import type { DramaPrefetchSource } from '@miniapp/shared';

import { usePreloadDramaPlayback } from '@/lib/api/drama';
import { canPrefetchInBackground } from '@/lib/background-prefetch';
import { resumeVideoId } from '@/stores/drama-library-store';

export interface DramaPrefetchTarget {
  id: string;
  videoId: string | undefined;
  source: Extract<DramaPrefetchSource, 'next_episode' | 'next_drama'>;
}

interface DramaNeighbors {
  id: string;
  embedded: boolean;
  nextPlayableId?: string;
  previousPlayableId?: string;
  nextDramaId?: string;
}

/**
 * 上下滑或自动续播的目标。键必须和目标播放器取址时一致，否则缓存不会命中：
 * 本剧内换集用集 ID；首页换剧时，新 DramaPlayer 的初始集是本设备未看完的进度，
 * 没有进度就不传集（后端取第 1 个可播集）。首页只预取下一部，与原来的片尾预加载一致。
 */
export function resolveDramaPrefetchTarget(
  neighbors: DramaNeighbors,
  direction: 1 | -1
): DramaPrefetchTarget | undefined {
  if (neighbors.embedded) {
    const next = neighbors.nextDramaId;
    if (direction !== 1 || !next) return undefined;
    return { id: next, videoId: resumeVideoId(next), source: 'next_drama' };
  }
  const videoId = direction === 1 ? neighbors.nextPlayableId : neighbors.previousPlayableId;
  return videoId ? { id: neighbors.id, videoId, source: 'next_episode' } : undefined;
}

/** 播放满这么久才推测预取，先让当前集的首片入缓冲，不和它抢带宽。 */
const SPECULATIVE_AFTER_SECONDS = 1;
/** 片尾窗口：此时自动续播几乎确定，不受后台预取门控限制。 */
const END_WINDOW_SECONDS = 3;

function afterIdle(run: () => void): () => void {
  if (typeof window.requestIdleCallback === 'function') {
    const handle = window.requestIdleCallback(run, { timeout: 1500 });
    return () => window.cancelIdleCallback(handle);
  }
  const timer = window.setTimeout(run, 250);
  return () => window.clearTimeout(timer);
}

interface DramaNextPrefetchOptions extends DramaNeighbors {
  currentVideoId: string | null;
  time: number;
  duration: number;
  pageVisible: boolean;
}

/**
 * 提前取下一集/下一部的详情、地址和子清单，让换集、换剧和自动续播起播时不再串行请求。
 * 三个时机，同一目标在缓存里有可用条目时不会重复请求（见 drama-playback.ts）：
 * - 当前集播放满 1 秒后的一次空闲：覆盖随时上下滑；弱网、省流量、页面隐藏时跳过。
 * - 片尾前 3 秒：推测预取超过 5 分钟已过期时，在这里补上。
 * - 上下滑手势意图（返回的函数）：两个方向都取，critical 优先级。
 */
export function useDramaNextPrefetch(
  options: DramaNextPrefetchOptions
): (direction: 1 | -1) => void {
  const { id, embedded, nextPlayableId, previousPlayableId, nextDramaId } = options;
  const { currentVideoId, time, duration, pageVisible } = options;
  const preload = usePreloadDramaPlayback();
  const speculated = useRef<string | null>(null);
  const nearEnd = useRef<string | null>(null);
  const target = resolveDramaPrefetchTarget(
    { id, embedded, nextPlayableId, previousPlayableId, nextDramaId },
    1
  );
  const targetId = target?.id;
  const targetVideoId = target?.videoId;
  const targetSource = target?.source;
  const playedEnough = time >= SPECULATIVE_AFTER_SECONDS;
  const inEndWindow =
    Number.isFinite(duration) && duration > 0 && duration - time <= END_WINDOW_SECONDS;

  useEffect(() => {
    if (!currentVideoId || !targetId || !targetSource || !pageVisible || !playedEnough) return;
    if (speculated.current === currentVideoId) return;
    // 在回调里才记"已触发"：目标在空闲前变化（如详情刚到）时，effect 取消旧回调后会按新目标重排。
    return afterIdle(() => {
      speculated.current = currentVideoId;
      if (canPrefetchInBackground()) preload(targetId, targetVideoId, targetSource, 'background');
    });
  }, [currentVideoId, targetId, targetVideoId, targetSource, pageVisible, playedEnough, preload]);

  useEffect(() => {
    if (!currentVideoId || !targetId || !targetSource || !pageVisible || !inEndWindow) return;
    if (nearEnd.current === currentVideoId) return;
    nearEnd.current = currentVideoId;
    preload(targetId, targetVideoId, targetSource, 'background');
  }, [currentVideoId, targetId, targetVideoId, targetSource, pageVisible, inEndWindow, preload]);

  return useCallback(
    (direction: 1 | -1) => {
      const adjacent = resolveDramaPrefetchTarget(
        { id, embedded, nextPlayableId, previousPlayableId, nextDramaId },
        direction
      );
      if (adjacent) preload(adjacent.id, adjacent.videoId, adjacent.source, 'critical');
    },
    [id, embedded, nextPlayableId, previousPlayableId, nextDramaId, preload]
  );
}
